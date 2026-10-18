import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { MarketRadarArchiveState, OptionIvArchiveObservation, OptionStrategySignal, OutputType, PositionCopilotState, PositionMonitorV1, ReadonlyMarketSources, ShadowComponentResult, TsOutput } from "../app/snapshot-import.ts";
import type { MarketIntelligenceState } from "../app/market-intelligence.ts";
import type { OwnerPositionPlan } from "../app/owner-position-plan.ts";
import type { RunEvent } from "../app/agent-ledger.ts";
import { collectRobinhoodReadonly, refreshCoreFreshness, ROBINHOOD_READONLY_TOOLS, withRobinhoodMcp, type RobinhoodTimingObserver } from "./robinhood-mcp.ts";
import { formatPtTime, isPtShadowWindow, ptDateKey } from "../app/market-time.ts";
import { buildOptionStrategySignal } from "./option-strategy.ts";
import { buildPositionCopilotState } from "./position-copilot.ts";
import { buildTsRegimeRiskContext, type TsRegimeRiskContext } from "../app/ts-regime-risk.ts";
import { OPENING_RECOVERY_EFFECTIVE_DATE, openingGraceSeconds, utcForPt, type TsCoreTerminalOutcome } from "../app/timeline-schedule.ts";
import { buildTsSignalCandidate } from "../app/ts-signal-candidate.ts";

export const SHADOW_COMPONENTS = ["A1", "A2", "TS", "COMMITTEE", "D", "A3_REVIEW", "A3", "CODEX_GUARD"] as const;
type ShadowComponent = (typeof SHADOW_COMPONENTS)[number];
type SourceMode = "LIVE" | "REPLAY";
type RunTarget = "FULL" | "TS_CORE";
type StepResult = { payload: Record<string, unknown>; observedAt: string; dataCutoffAt: string; evidenceRef: string; metadata?: Record<string, unknown>; downstreamReason?: "SKIPPED_MARKET_CLOSED" | "DATA_BLOCKED" };
type StepExecutor = (component: ShadowComponent, input: Record<string, unknown>) => Promise<StepResult>;
type StoredStep = { events: string[]; envelope?: string; candidateEnvelope?: string; result?: StepResult; pendingEvidenceRefs?: string[] };
type CycleState = { version: 1 | 2 | 3; runId: string; slotId: string; sourceMode: SourceMode; steps: Partial<Record<ShadowComponent, StoredStep>>; optionStrategy?: { envelope: string; signal: OptionStrategySignal; delivered: boolean }; positionCopilot?: { envelope: string; state: PositionCopilotState; delivered: boolean } };
type TsCoreOwnership = { slot_id: string; run_id: string; lease_owner: string; lease_expires_at: string; status: "LEASED" | "RUNNING" | "TERMINAL"; terminal_outcome: TsCoreTerminalOutcome | null; forecast_id: string | null; delivery_record_id: string | null };

const COMPONENT_CONFIG = {
  A1: { agent: "A1", skill: "A1_LIVE_SHADOW", output: "A1_SHADOW_RESULT" },
  A2: { agent: "A2", skill: "A2_LIVE_SHADOW", output: "A2_SHADOW_RESULT" },
  TS: { agent: "TS", skill: "TS_LIVE_SHADOW", output: "TS_SHADOW_OUTPUT" },
  COMMITTEE: { agent: "COMMITTEE", skill: "COMMITTEE_LIVE_SHADOW", output: "COMMITTEE_SHADOW_OUTPUT" },
  D: { agent: "D", skill: "D_LIVE_SHADOW", output: "D_SHADOW_OUTPUT" },
  A3_REVIEW: { agent: "A3", skill: "A3_REVIEW_LIVE_SHADOW", output: "A3_REVIEW_SHADOW" },
  A3: { agent: "A3", skill: "A3_FINAL_LIVE_SHADOW", output: "A3_FINAL_SHADOW" },
  CODEX_GUARD: { agent: "CODEX_GUARD", skill: "CODEX_GUARD_LIVE_SHADOW", output: "CODEX_GUARD_SHADOW" },
} as const satisfies Record<ShadowComponent, { agent: string; skill: string; output: OutputType }>;

export class ShadowRuntimeError extends Error {
  status: "FAILED" | "TIMED_OUT" | "DATA_BLOCKED";
  constructor(status: ShadowRuntimeError["status"], message: string) { super(message); this.status = status; this.name = "ShadowRuntimeError"; }
}

export class ShadowRuntimeInterrupted extends Error {}
export class OpeningMarketPending extends ShadowRuntimeError {
  evidenceRef: string;
  constructor(evidenceRef: string) { super("DATA_BLOCKED", "OPENING_MARKET_PENDING：等待当前Quote与已完成的当日常规时段5分钟K线"); this.evidenceRef = evidenceRef; }
}

export type LiveShadowRuntimeOptions = {
  origin: string;
  gatewayKey: string;
  dataRoot?: string;
  v2Root?: string;
  intervalMs?: number;
  executeStep?: StepExecutor;
  runtimeContext?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  priorTsForecasts?: (before: string) => Array<Record<string, unknown>>;
  importOutputRaw?: (raw: string, receivedAt: string) => void;
  importRunEventRaw?: (raw: string, receivedAt: string) => void;
  now?: () => Date;
  runStockPlans?: (input: { runId: string; slotId: string; a1: ShadowComponentResult; a2: ShadowComponentResult | null; context: Record<string, unknown> }) => Promise<void>;
  tsCoreOwnership?: {
    ownerId: string;
    get(slotId: string): TsCoreOwnership | null;
    claim(slotId: string, runId: string, ownerId: string, at: string): { claim: "ACQUIRED" | "BUSY" | "TERMINAL"; ownership: TsCoreOwnership };
    renew(slotId: string, ownerId: string, at: string): boolean;
    complete(slotId: string, ownerId: string, outcome: TsCoreTerminalOutcome, forecastId: string | null, deliveryRecordId: string | null, at: string): TsCoreOwnership;
  };
};

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/([?&](?:token|apikey|api_key|account_number)=)[^&\s]+/gi, "$1[REDACTED]").replace(/\b\d{8,}\b/g, "[REDACTED_NUMBER]").slice(0, 2_000);
}

function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

let timingWrites = Promise.resolve(), pendingTimingWrites = 0;
function runtimeTiming(dataRoot: string, runId: unknown): RobinhoodTimingObserver {
  if (process.env.TRADING_OS_RUNTIME_ROLE !== "TIER0") return () => {};
  const id = /^(?:live|replay)-shadow:\d{8}T\d{6}Z$/.test(String(runId)) ? String(runId) : "unidentified";
  const path = resolve(dataRoot, "timing", `${id.replaceAll(":", "-")}.jsonl`);
  return (event) => {
    try {
      // ponytail: one process-wide bounded diagnostic queue; missing events mean incomplete evidence, never business failure.
      if (pendingTimingWrites >= 2_048) return;
      const line = `${JSON.stringify({ contract: "A1_RUNTIME_TIMING_V1", run_id: id, pid: process.pid, ...event })}\n`;
      // Never wait for diagnostic disk I/O inside the slot's freeze budget.
      pendingTimingWrites++;
      timingWrites = timingWrites.then(async () => { await mkdir(dirname(path), { recursive: true }); await appendFile(path, line, { mode: 0o600 }); }).catch(() => {}).finally(() => { pendingTimingWrites--; });
    }
    catch { /* Preserve the original result if diagnostic storage is unavailable. */ }
  };
}

function cycleIdentity(date: Date, sourceMode: SourceMode) {
  const slot = new Date(Math.floor(date.getTime() / 900_000) * 900_000);
  const compact = slot.toISOString().replace(/[-:]/g, "").replace(".000Z", "Z");
  const prefix = sourceMode === "LIVE" ? "live-shadow" : "replay-shadow";
  return { runId: `${prefix}:${compact}`, slotId: `${prefix}:${compact}`, slot };
}

function scheduled(date: Date) {
  return isPtShadowWindow(date);
}

function tsCoreDeadline(slot: Date) {
  return slot.getTime() + (formatPtTime(slot) === "06:30" ? openingGraceSeconds(slot) * 1_000 : 90_000);
}

function outputObservedAt(component: ShadowComponent, result: StepResult) {
  if (component === "TS") return (((result.payload.evidence_snapshot as Record<string, unknown>)?.market_time as Record<string, unknown>)?.observed_at as string) ?? result.observedAt;
  return result.observedAt;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function createLiveShadowRuntime(options: LiveShadowRuntimeOptions) {
  const dataRoot = options.dataRoot ?? resolve(process.env.TRADING_OS_DATA_ROOT ?? resolve(process.cwd(), "data"), "live-shadow");
  const v2Root = options.v2Root ?? resolve(process.cwd(), "..", "v2-reference");
  const now = options.now ?? (() => new Date());
  const executeStep = options.executeStep ?? defaultExecutor({ dataRoot, v2Root });
  const activeSlotIds = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  async function post(path: string, raw: string) {
    const receivedAt = now().toISOString();
    if (path === "/api/output-gateway" && options.importOutputRaw) return void options.importOutputRaw(raw, receivedAt);
    if (path === "/api/run-ledger" && options.importRunEventRaw) return void options.importRunEventRaw(raw, receivedAt);
    const response = await fetch(`${options.origin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.gatewayKey}`, "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(`本地写入接口 ${response.status}${body.error ? `：${body.error}` : ""}`);
    }
  }

  async function runtimeContext() {
    if (options.runtimeContext) return options.runtimeContext();
    const response = await fetch(`${options.origin}/api/runtime-context`, { headers: { authorization: `Bearer ${options.gatewayKey}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`本地运行上下文 ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  }

  function stateFile(runId: string) { return resolve(dataRoot, "cycles", `${runId.replace(/:/g, "-")}.json`); }
  function loadCycle(runId: string, slotId: string, sourceMode: SourceMode) {
    const path = stateFile(runId);
    if (!existsSync(path)) return { path, state: { version: 3, runId, slotId, sourceMode, steps: {} } as CycleState };
    const state = JSON.parse(readFileSync(path, "utf8")) as CycleState;
    if (![1, 2, 3].includes(state.version) || state.runId !== runId || state.slotId !== slotId || state.sourceMode !== sourceMode) throw new Error("Shadow cycle state identity mismatch");
    return { path, state };
  }

  async function closePendingOpening(cycle: ReturnType<typeof loadCycle>) {
    const step = cycle.state.steps.A1, final = step?.events.at(-1) ? JSON.parse(step.events.at(-1)!) as RunEvent : null;
    if (final?.status !== "RUNNING" || !final.error?.startsWith("OPENING_MARKET_PENDING")) return null;
    const outcome = step?.pendingEvidenceRefs?.length ? "GENUINE_DATA_BLOCKED" as const : "SYSTEM_BLOCKED" as const;
    const event: RunEvent = { ...final, event_id: `${cycle.state.runId}:A1:opening-deadline`, event_at: new Date(Math.max(now().getTime(), Date.parse(final.event_at) + 1)).toISOString(), status: outcome === "GENUINE_DATA_BLOCKED" ? "DATA_BLOCKED" : "FAILED", evidence_refs: [...new Set([...final.evidence_refs, ...step!.pendingEvidenceRefs?.slice(-1) ?? []])], error: outcome === "GENUINE_DATA_BLOCKED" ? "OPENING_MARKET_NOT_READY_BY_FREEZE_DEADLINE：Quote与完整常规时段5分钟K线未在开盘截止前满足正式采样合同" : "OPENING_COLLECTION_INTERRUPTED：截止前未完成可核验的采样，不能归咎于行情" };
    const raw = JSON.stringify(event);
    step!.events.push(raw);
    atomicJson(cycle.path, cycle.state);
    await post("/api/run-ledger", raw);
    return outcome;
  }

  async function retryFrozenDeliveries(identity: ReturnType<typeof cycleIdentity>) {
    const cycle = loadCycle(identity.runId, identity.slotId, identity.runId.startsWith("live-shadow:") ? "LIVE" : "REPLAY");
    for (const component of SHADOW_COMPONENTS.slice(0, 3)) {
      const step = cycle.state.steps[component];
      if (!step?.envelope) continue;
      await post("/api/output-gateway", step.envelope);
      if (step.candidateEnvelope) await post("/api/output-gateway", step.candidateEnvelope);
      const final = step.events.at(-1) ? JSON.parse(step.events.at(-1)!) as RunEvent : null;
      if (final?.status === "SUCCEEDED" && final.website_delivery === "FAILED") {
        const recovered = { ...final, event_id: `${identity.runId}:${component}:delivery-recovered`, event_at: new Date(Math.max(Date.now(), Date.parse(final.event_at) + 1)).toISOString(), error: null, website_delivery: "DELIVERED" as const };
        await post("/api/run-ledger", JSON.stringify(recovered));
        step.events.push(JSON.stringify(recovered));
        atomicJson(cycle.path, cycle.state);
      }
    }
  }

  async function runOnce(sourceMode: SourceMode = "LIVE", slotAt = now(), runReason = "4070 Live Shadow", target: RunTarget = "FULL") {
    const identity = cycleIdentity(slotAt, sourceMode);
    const ownership = sourceMode === "LIVE" ? options.tsCoreOwnership : undefined;
    if (target === "FULL" && ownership) {
      const existing = ownership.get(identity.slotId);
      if (!existing || existing.status !== "TERMINAL") return { status: "SYSTEM_BLOCKED" as const, terminalOutcome: "SYSTEM_BLOCKED" as const, runId: identity.runId, slotId: identity.slotId };
      if (existing.terminal_outcome !== "DELIVERED" && existing.terminal_outcome !== "NO_TRADE") return { status: terminalStatus(existing.terminal_outcome!), terminalOutcome: existing.terminal_outcome!, runId: identity.runId, slotId: identity.slotId };
    }
    let leaseClaimed = false;
    if (target === "TS_CORE" && ownership) {
      const claimed = ownership.claim(identity.slotId, identity.runId, ownership.ownerId, now().toISOString());
      if (claimed.claim === "BUSY") return { status: "IN_PROGRESS" as const, runId: identity.runId, slotId: identity.slotId };
      if (claimed.claim === "TERMINAL") {
        try { await retryFrozenDeliveries(identity); } catch { /* Frozen delivery remains pending for the next deterministic retry. */ }
        return { status: terminalStatus(claimed.ownership.terminal_outcome!), terminalOutcome: claimed.ownership.terminal_outcome!, runId: identity.runId, slotId: identity.slotId };
      }
      leaseClaimed = true;
    }
    if (activeSlotIds.has(identity.slotId)) return { status: "IN_PROGRESS" as const, runId: identity.runId, slotId: identity.slotId };
    activeSlotIds.add(identity.slotId);
    const leaseTimer = leaseClaimed && ownership ? setInterval(() => ownership.renew(identity.slotId, ownership.ownerId, now().toISOString()), 30_000) : null;
    leaseTimer?.unref();
    let stockWork: Promise<void> | undefined;
    try {
    const { runId, slotId, slot } = identity;
    const openingSlot = sourceMode === "LIVE" && formatPtTime(slot) === "06:30" && ptDateKey(slot) >= OPENING_RECOVERY_EFFECTIVE_DATE;
    const cycle = loadCycle(runId, slotId, sourceMode);
    const frozenA1 = cycle.state.steps.A1?.result;
    const a1FrozenByDeadline = frozenA1 && [frozenA1.observedAt, frozenA1.dataCutoffAt].every((value) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= tsCoreDeadline(slot));
    if (target === "TS_CORE" && sourceMode === "LIVE" && now().getTime() > tsCoreDeadline(slot) && !a1FrozenByDeadline) {
      const outcome = await closePendingOpening(cycle) ?? "SYSTEM_BLOCKED" as const;
      if (leaseClaimed && ownership) ownership.complete(slotId, ownership.ownerId, outcome, null, null, now().toISOString());
      return { status: outcome, terminalOutcome: outcome, runId, slotId };
    }
    const required = target === "TS_CORE" ? SHADOW_COMPONENTS.slice(0, 3) : SHADOW_COMPONENTS;
    const finalEvents = required.flatMap((component) => cycle.state.steps[component]?.events.at(-1) ?? []).map((raw) => JSON.parse(raw) as RunEvent);
    if (finalEvents.length === required.length && finalEvents.every((event) => ["SUCCEEDED", "FAILED", "TIMED_OUT", "DATA_BLOCKED", "SKIPPED"].includes(event.status)) && (target === "TS_CORE" || (cycle.state.version === 1 || cycle.state.optionStrategy?.delivered) && (cycle.state.version !== 3 || cycle.state.positionCopilot?.delivered))) {
      if (target === "TS_CORE") {
        const terminal = coreTerminal(cycle.state);
        if (leaseClaimed && ownership) ownership.complete(slotId, ownership.ownerId, terminal.outcome, terminal.forecastId, terminal.deliveryRecordId, now().toISOString());
        return { status: terminalStatus(terminal.outcome), terminalOutcome: terminal.outcome, runId, slotId };
      }
      const failed = finalEvents.some((event) => event.status === "FAILED" || event.status === "TIMED_OUT");
      const dataBlocked = finalEvents.some((event) => event.status === "DATA_BLOCKED");
      return { status: failed ? "FAILED" as const : dataBlocked ? "GENUINE_DATA_BLOCKED" as const : finalEvents.every((event) => event.status === "SUCCEEDED" && event.output_status === "PRODUCED" && event.website_delivery === "DELIVERED") ? "COMPLETED" as const : "SYSTEM_BLOCKED" as const, runId, slotId };
    }
    const storedClock = Object.values(cycle.state.steps).flatMap((step) => step?.events ?? []).reduce((latest, raw) => Math.max(latest, Date.parse((JSON.parse(raw) as RunEvent).event_at)), 0);
    let clock = Math.max(slot.getTime(), Date.now(), storedClock);
    const persist = () => atomicJson(cycle.path, cycle.state);
    const eventTime = () => new Date(clock = Math.max(clock + 1, Date.now())).toISOString();

    const sendEvent = async (component: ShadowComponent, event: RunEvent) => {
      const step = cycle.state.steps[component] ??= { events: [] };
      const raw = JSON.stringify(event);
      step.events.push(raw);
      persist();
      await post("/api/run-ledger", raw);
    };
    const baseEvent = (component: ShadowComponent, cutoff: string) => {
      const config = COMPONENT_CONFIG[component];
      return {
        ledger_format: "TRADING_OS_AGENT_RUN_EVENT" as const, ledger_version: 1 as const,
        agent_id: config.agent, skill_id: config.skill, run_id: runId, slot_id: slotId, channel: "SHADOW" as const,
        version: "4070-live-shadow-v1", data_cutoff_at: cutoff, output_status: "NOT_PRODUCED" as const,
        error: null, evidence_refs: [] as string[], website_delivery: "NOT_ATTEMPTED" as const, discord_delivery: "NOT_APPLICABLE" as const,
      };
    };

    const replayStored = async (component: ShadowComponent) => {
      const step = cycle.state.steps[component];
      if (!step) return false;
      for (const raw of step.events) await post("/api/run-ledger", raw);
      if (step.envelope) await post("/api/output-gateway", step.envelope);
      return step.events.some((raw) => ["SUCCEEDED", "FAILED", "TIMED_OUT", "DATA_BLOCKED", "SKIPPED"].includes((JSON.parse(raw) as RunEvent).status));
    };

    const timing = runtimeTiming(dataRoot, runId);
    timing({ event: "runtime_context_begin", at: new Date().toISOString(), monotonic_ms: performance.now() });
    const priorForecasts = sourceMode === "LIVE" ? options.priorTsForecasts?.(slot.toISOString()) ?? [] : [];
    const context = await runtimeContext();
    // Separate companion: never runs within A1/TS core or rewrites index approvals.
    if (target === "FULL" && sourceMode === "LIVE" && frozenA1 && options.runStockPlans) {
      stockWork = Promise.resolve().then(() => options.runStockPlans!({ runId, slotId, a1: frozenA1.payload as ShadowComponentResult, a2: (cycle.state.steps.A2?.result?.payload as ShadowComponentResult | undefined) ?? null, context }))
        .catch((error) => { console.error("Stock manual-plan companion failed:", safeError(error)); });
    }
    timing({ event: "runtime_context_end", at: new Date().toISOString(), monotonic_ms: performance.now() });
    const inputs: Record<string, unknown> = { source_mode: sourceMode, run_id: runId, slot_id: slotId, RUN_REASON: openingSlot ? "早盘固定分析" : runReason, RUNTIME_CONTEXT: context, SLOT_FREEZE_DEADLINE_AT: new Date(tsCoreDeadline(slot)).toISOString(), PRIOR_TS_FORECASTS: priorForecasts.map((prior) => {
      const match = /^live-shadow:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(prior.slot_id));
      if (!match) throw new ShadowRuntimeError("FAILED", "权威前序Forecast的自然槽身份无效");
      return { ...prior, freeze_deadline_at: new Date(tsCoreDeadline(new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`))).toISOString() };
    }) };
    if (sourceMode !== "LIVE") delete inputs.PRIOR_TS_FORECASTS;
    const ensureRiskContext = () => {
      if (inputs.TS_REGIME_RISK_CONTEXT) return;
      const a1 = inputs.A1 as ShadowComponentResult | undefined, a2 = inputs.A2 as ShadowComponentResult | undefined;
      if (!a1 || !a2) return;
      inputs.TS_REGIME_RISK_CONTEXT = buildTsRegimeRiskContext({ market: a1.market_sources ?? null, a2, officialMacro: a1.official_macro ?? null, observedAt: a1.observed_at });
    };
    let blocked = false;
    let downstreamReason: StepResult["downstreamReason"];
      for (const component of required) {
        const complete = await replayStored(component);
        const stored = cycle.state.steps[component];
        if (stored?.result) {
          inputs[component] = stored.result.payload;
          if (stored.result.metadata) inputs[`${component}_META`] = stored.result.metadata;
          ensureRiskContext();
        }
        if (complete) {
          const final = JSON.parse(stored!.events.at(-1)!) as RunEvent;
          if (component === "A1" && final.status !== "SUCCEEDED") blocked = true;
          if (component === "A1" && stored?.result?.downstreamReason) {
            downstreamReason = stored.result.downstreamReason;
            inputs.downstream_reason = downstreamReason;
            blocked = downstreamReason === "DATA_BLOCKED";
          }
          continue;
        }
        const cutoff = component === "A1" ? slot.toISOString() : ((inputs.A1 as Record<string, unknown> | undefined)?.data_cutoff_at as string) ?? slot.toISOString();
        if (blocked && component !== "CODEX_GUARD") {
          const event = { ...baseEvent(component, cutoff), event_id: `${runId}:${component}:skipped`, event_at: eventTime(), status: "SKIPPED" as const, error: downstreamReason ?? "DATA_BLOCKED", website_delivery: "NOT_ATTEMPTED" as const };
          await sendEvent(component, event);
          continue;
        }
        if (downstreamReason === "SKIPPED_MARKET_CLOSED" && component !== "CODEX_GUARD") {
          const event = { ...baseEvent(component, cutoff), event_id: `${runId}:${component}:market-closed`, event_at: eventTime(), status: "SKIPPED" as const, error: downstreamReason, website_delivery: "NOT_ATTEMPTED" as const };
          await sendEvent(component, event);
          continue;
        }
        const step = cycle.state.steps[component] ??= { events: [] };
        if (!step.events.length) await sendEvent(component, { ...baseEvent(component, cutoff), event_id: `${runId}:${component}:started`, event_at: eventTime(), status: "STARTED" });
        const openingA1 = component === "A1" && openingSlot;
        if (!step.events.some((raw) => (JSON.parse(raw) as RunEvent).status === "RUNNING")) await sendEvent(component, { ...baseEvent(component, cutoff), event_id: `${runId}:${component}:running`, event_at: eventTime(), status: "RUNNING", error: openingA1 ? "OPENING_MARKET_PENDING：正式开盘Quote与完整常规时段5分钟K线尚未冻结" : null });
        try {
          const result = step.result ?? await executeStep(component, { ...inputs, data_root: dataRoot });
          step.result = result;
          inputs[component] = result.payload;
          if (result.metadata) inputs[`${component}_META`] = result.metadata;
          ensureRiskContext();
          if (component === "A1" && result.downstreamReason) {
            downstreamReason = result.downstreamReason;
            inputs.downstream_reason = downstreamReason;
          }
          const envelope = step.envelope ?? JSON.stringify({
            gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1,
            record_id: `${runId}:${component}`, output_type: COMPONENT_CONFIG[component].output, channel: "SHADOW",
            observed_at: outputObservedAt(component, result), payload: result.payload,
          });
          step.envelope = envelope;
          persist();
          try {
            await post("/api/output-gateway", envelope);
            if (component === "TS") {
              const market = (inputs.A1 as { market_sources?: ReadonlyMarketSources } | undefined)?.market_sources;
              const ts = result.payload as TsOutput;
              const candidate = market ? buildTsSignalCandidate({ sourceMode, sourceRunId: runId, slotId, officialForecastRunId: ts.evidence_snapshot.run_id, observedAt: outputObservedAt(component, result), dataCutoffAt: result.dataCutoffAt, market }) : null;
              if (candidate) {
                step.candidateEnvelope ??= JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `${runId}:TS_SIGNAL_CANDIDATE`, output_type: "TS_SIGNAL_CANDIDATE", channel: "SHADOW", observed_at: candidate.observed_at, payload: candidate });
                persist();
                try { await post("/api/output-gateway", step.candidateEnvelope); } catch { /* Frozen candidate retries from this cycle; official Forecast remains immutable. */ }
              }
            }
            await sendEvent(component, { ...baseEvent(component, cutoff), event_id: `${runId}:${component}:succeeded`, event_at: eventTime(), status: "SUCCEEDED", output_status: "PRODUCED", evidence_refs: [result.evidenceRef], website_delivery: "DELIVERED" });
            if (component === "A1" && downstreamReason === "DATA_BLOCKED") blocked = true;
          } catch (error) {
            await sendEvent(component, { ...baseEvent(component, cutoff), event_id: `${runId}:${component}:website-failed`, event_at: eventTime(), status: "SUCCEEDED", output_status: "PRODUCED", error: safeError(error), evidence_refs: [result.evidenceRef], website_delivery: "FAILED" });
            // The frozen result stays authoritative and later components continue; replayStored retries this immutable envelope.
          }
        } catch (error) {
          if (error instanceof ShadowRuntimeInterrupted) throw error;
          if (openingA1 && error instanceof OpeningMarketPending && now().getTime() < tsCoreDeadline(slot)) {
            (step.pendingEvidenceRefs ??= []).push(error.evidenceRef);
            persist();
            return { status: "IN_PROGRESS" as const, runId, slotId };
          }
          const status = error instanceof ShadowRuntimeError ? error.status : "FAILED";
          await sendEvent(component, { ...baseEvent(component, cutoff), event_id: `${runId}:${component}:${status.toLowerCase()}`, event_at: eventTime(), status, error: safeError(error), website_delivery: "NOT_ATTEMPTED" });
          if (component !== "CODEX_GUARD") blocked = true;
        }
      }
      if (target === "FULL" && cycle.state.version !== 1) {
        if (!cycle.state.optionStrategy) {
          const runtimeContext = inputs.RUNTIME_CONTEXT as { tsOutputs?: TsOutput[]; optionStrategySignals?: OptionStrategySignal[]; optionIvHistory?: OptionIvArchiveObservation[] };
          const a1 = inputs.A1 as { market_sources?: ReadonlyMarketSources; observed_at?: string } | undefined;
          const signal = buildOptionStrategySignal({
            runId, slotId, sourceMode, market: a1?.market_sources ?? null, ts: (inputs.TS as TsOutput | undefined) ?? null,
            d: (inputs.D as Record<string, unknown> | undefined) ?? null, a3: (inputs.A3 as Record<string, unknown> | undefined) ?? null,
            riskContext: (inputs.TS_REGIME_RISK_CONTEXT as TsRegimeRiskContext | undefined) ?? null,
            tsHistory: runtimeContext.tsOutputs, ivHistory: runtimeContext.optionIvHistory,
            previous: runtimeContext.optionStrategySignals?.find((item) => item.source_mode === sourceMode) ?? null, observedAt: a1?.observed_at ?? slot.toISOString(),
          });
          cycle.state.optionStrategy = {
            signal, delivered: false,
            envelope: JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `${runId}:OPTION_STRATEGY_SIGNAL`, output_type: "OPTION_STRATEGY_SIGNAL", channel: "SHADOW", observed_at: signal.observed_at, payload: signal }),
          };
          persist();
        }
        if (!cycle.state.optionStrategy.delivered) {
          await post("/api/output-gateway", cycle.state.optionStrategy.envelope);
          cycle.state.optionStrategy.delivered = true;
          persist();
        }
      }
      if (target === "FULL" && cycle.state.version === 3) {
        if (!cycle.state.positionCopilot) {
          const runtimeContext = inputs.RUNTIME_CONTEXT as { positionCopilotStates?: PositionCopilotState[]; ownerPositionPlans?: OwnerPositionPlan[] };
          const a1 = inputs.A1 as { market_sources?: ReadonlyMarketSources; observed_at?: string } | undefined;
          const a2 = inputs.A2 as { v2_result?: { position_monitor?: PositionMonitorV1 | null } } | undefined;
          const state = buildPositionCopilotState({
            runId, slotId, sourceMode, market: a1?.market_sources ?? null, monitor: a2?.v2_result?.position_monitor ?? null,
            ts: (inputs.TS as TsOutput | undefined) ?? null, d: (inputs.D as Record<string, unknown> | undefined) ?? null,
            a3: (inputs.A3 as Record<string, unknown> | undefined) ?? null, previous: runtimeContext.positionCopilotStates?.find((item) => item.source_mode === sourceMode) ?? null,
            observedAt: a1?.observed_at ?? slot.toISOString(),
            ownerPositionPlans: runtimeContext.ownerPositionPlans,
          });
          cycle.state.positionCopilot = {
            state, delivered: false,
            envelope: JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `${runId}:POSITION_COPILOT_STATE`, output_type: "POSITION_COPILOT_STATE", channel: "SHADOW", observed_at: state.observed_at, payload: state }),
          };
          persist();
        }
        if (!cycle.state.positionCopilot.delivered) {
          await post("/api/output-gateway", cycle.state.positionCopilot.envelope);
          cycle.state.positionCopilot.delivered = true;
          persist();
        }
      }
      if (target === "TS_CORE") {
        const terminal = coreTerminal(cycle.state);
        if (leaseClaimed && ownership) ownership.complete(slotId, ownership.ownerId, terminal.outcome, terminal.forecastId, terminal.deliveryRecordId, now().toISOString());
        const a1 = cycle.state.steps.A1?.result?.payload as ShadowComponentResult | undefined;
        // Stock evidence is independent of the index outcome; release Tier 0 without waiting for stock reviews.
        if (sourceMode === "LIVE" && a1 && options.runStockPlans) void Promise.resolve().then(() => options.runStockPlans!({ runId, slotId, a1, a2: (cycle.state.steps.A2?.result?.payload as ShadowComponentResult | undefined) ?? null, context }))
          .catch((error) => { console.error("Stock manual-plan companion failed:", safeError(error)); });
        return { status: terminalStatus(terminal.outcome), terminalOutcome: terminal.outcome, runId, slotId };
      }
      if (!blocked) return { status: "COMPLETED" as const, runId, slotId };
      const completed = required.flatMap((component) => cycle.state.steps[component]?.events.at(-1) ?? []).map((raw) => JSON.parse(raw) as RunEvent);
      return { status: completed.some((event) => event.status === "FAILED" || event.status === "TIMED_OUT") ? "FAILED" as const : completed.some((event) => event.status === "DATA_BLOCKED") ? "GENUINE_DATA_BLOCKED" as const : "SYSTEM_BLOCKED" as const, runId, slotId };
    } catch (error) {
      if (leaseClaimed && ownership && !(error instanceof ShadowRuntimeInterrupted)) ownership.complete(identity.slotId, ownership.ownerId, "FAILED", null, null, now().toISOString());
      throw error;
    } finally {
      await stockWork;
      if (leaseTimer) clearInterval(leaseTimer);
      activeSlotIds.delete(identity.slotId);
    }
  }

  async function tick() {
    const date = now();
    if (scheduled(date)) await runOnce("LIVE", date);
  }

  return {
    runOnce,
    reserveTsCore(slotAt = now()) {
      const identity = cycleIdentity(slotAt, "LIVE"), ownership = options.tsCoreOwnership;
      if (!ownership) return { status: "ACQUIRED" as const, runId: identity.runId, slotId: identity.slotId };
      const result = ownership.claim(identity.slotId, identity.runId, ownership.ownerId, now().toISOString());
      return { status: result.claim, runId: identity.runId, slotId: identity.slotId };
    },
    async completeReservedTsCore(slotAt: Date, outcome: TsCoreTerminalOutcome) {
      const identity = cycleIdentity(slotAt, "LIVE"), ownership = options.tsCoreOwnership;
      if (activeSlotIds.has(identity.slotId)) return { status: "IN_PROGRESS" as const, runId: identity.runId, slotId: identity.slotId };
      if (!ownership) return { status: terminalStatus(outcome), terminalOutcome: outcome, runId: identity.runId, slotId: identity.slotId };
      const claimed = ownership.claim(identity.slotId, identity.runId, ownership.ownerId, now().toISOString());
      if (claimed.claim === "BUSY") return { status: "IN_PROGRESS" as const, runId: identity.runId, slotId: identity.slotId };
      if (claimed.claim === "TERMINAL") return { status: terminalStatus(claimed.ownership.terminal_outcome!), terminalOutcome: claimed.ownership.terminal_outcome!, runId: identity.runId, slotId: identity.slotId };
      if (outcome === "GENUINE_DATA_BLOCKED" && ptDateKey(identity.slot) >= OPENING_RECOVERY_EFFECTIVE_DATE) outcome = await closePendingOpening(loadCycle(identity.runId, identity.slotId, "LIVE")) ?? "SYSTEM_BLOCKED";
      ownership.complete(identity.slotId, ownership.ownerId, outcome, null, null, now().toISOString());
      return { status: terminalStatus(outcome), terminalOutcome: outcome, runId: identity.runId, slotId: identity.slotId };
    },
    runTsCore(sourceMode: SourceMode = "LIVE", slotAt = now(), runReason = "TS Core Tier 0") { return runOnce(sourceMode, slotAt, runReason, "TS_CORE"); },
    start() {
      if (timer) return;
      void tick().catch(() => undefined);
      timer = setInterval(() => void tick().catch(() => undefined), options.intervalMs ?? 60_000);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    get running() { return activeSlotIds.size > 0; },
    get activeSlotId() { return activeSlotIds.values().next().value ?? null; },
    isRunning(slotId: string) { return activeSlotIds.has(slotId); },
  };
}

function terminalStatus(outcome: TsCoreTerminalOutcome) {
  if (outcome === "DELIVERED" || outcome === "NO_TRADE") return "COMPLETED" as const;
  if (outcome === "GENUINE_DATA_BLOCKED") return "GENUINE_DATA_BLOCKED" as const;
  return outcome;
}

function coreTerminal(cycle: CycleState): { outcome: TsCoreTerminalOutcome; forecastId: string | null; deliveryRecordId: string | null } {
  const events = SHADOW_COMPONENTS.slice(0, 3).flatMap((component) => cycle.steps[component]?.events.at(-1) ?? []).map((raw) => JSON.parse(raw) as RunEvent);
  const ts = cycle.steps.TS?.result?.payload as TsOutput | undefined;
  const forecastId = ts?.evidence_snapshot?.run_id ?? null;
  const deliveryRecordId = forecastId ? `${cycle.runId}:TS` : null;
  if (events.some((event) => event.status === "FAILED" || event.status === "TIMED_OUT")) return { outcome: "FAILED", forecastId, deliveryRecordId };
  if (events.some((event) => event.status === "DATA_BLOCKED") || cycle.steps.A1?.result?.downstreamReason === "DATA_BLOCKED") return { outcome: "GENUINE_DATA_BLOCKED", forecastId, deliveryRecordId };
  if (events.some((event) => event.status === "SKIPPED") || events.length !== 3 || events.at(-1)?.website_delivery === "FAILED") return { outcome: "SYSTEM_BLOCKED", forecastId, deliveryRecordId };
  return { outcome: ts?.tradeability?.status === "READY_FOR_D_REVIEW" ? "DELIVERED" : "NO_TRADE", forecastId, deliveryRecordId };
}

export function defaultExecutor(paths: { dataRoot: string; v2Root: string }, dependencies: {
  readMarket?: (observedAt: string, input: Record<string, unknown>) => Promise<ReadonlyMarketSources>;
  spawnProcess?: typeof spawn;
} = {}): StepExecutor {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const runPython = async (component: ShadowComponent | "OFFICIAL_MACRO", input: Record<string, unknown>, deadlineAt?: number, timing?: RobinhoodTimingObserver) => {
    const requestPath = resolve(paths.dataRoot, "requests", `${input.run_id}-${component}.json`.replace(/:/g, "-"));
    const responsePath = resolve(paths.dataRoot, "responses", `${input.run_id}-${component}.json`.replace(/:/g, "-"));
    timing?.({ event: "macro_request_write_begin", at: new Date().toISOString(), monotonic_ms: performance.now() });
    atomicJson(requestPath, { component, input });
    timing?.({ event: "macro_request_write_end", at: new Date().toISOString(), monotonic_ms: performance.now() });
    const script = resolve(process.cwd(), "scripts", "invoke-live-shadow-step.ps1");
    const child = spawnProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-RequestPath", requestPath, "-ResponsePath", responsePath, "-V2Root", paths.v2Root, "-DataRoot", paths.dataRoot, ...(component === "OFFICIAL_MACRO" ? ["-MacroProcessJob"] : [])], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    timing?.({ event: "macro_spawn", at: new Date().toISOString(), monotonic_ms: performance.now(), spawn_pid: child.pid });
    if (timing) child.once("close", () => timing({ event: "macro_close", at: new Date().toISOString(), monotonic_ms: performance.now(), spawn_pid: child.pid }));
    let error = "", timedOut = false;
    let timeout: NodeJS.Timeout | undefined, cleanupTimeout: NodeJS.Timeout | undefined;
    child.stderr.setEncoding("utf8").on("data", (chunk) => { if (error.length < 4_000) error += chunk; });
    const closed = new Promise<number | null>((resolveClose, rejectClose) => { child.once("error", rejectClose); child.once(component === "OFFICIAL_MACRO" ? "close" : "exit", resolveClose); });
    const interrupted = new Promise<never>((_resolve, rejectRun) => {
      timeout = setTimeout(() => {
        if (component !== "OFFICIAL_MACRO") { child.kill(); return; }
        timedOut = true;
        const notClosed = () => Object.assign(new ShadowRuntimeError("FAILED", "OFFICIAL_MACRO PROCESS_TREE_NOT_CLOSED"), { cause: "PROCESS_TREE_NOT_CLOSED" });
        cleanupTimeout = setTimeout(() => rejectRun(notClosed()), 5_000);
        try {
          if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) throw notClosed();
          const killer = spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          const killed = new Promise<number | null>((resolveKill, rejectKill) => {
            killer.once("error", rejectKill);
            killer.once("close", resolveKill);
          });
          // The macro wrapper's private kill-on-close Job covers descendants, including detached/ignored-pipe children.
          // Its natural success plus closed pipes can race taskkill's not-found (128).
          // Any other cleanup failure or missing close remains fail-closed; timed-out output is never reused.
          Promise.all([closed, killed]).then(([exitCode, killCode]) => rejectRun(killCode === 0 || killCode === 128 && exitCode === 0
            ? new ShadowRuntimeError("TIMED_OUT", "OFFICIAL_MACRO 运行超时") : notClosed()), () => rejectRun(notClosed()));
        } catch { rejectRun(notClosed()); }
      }, deadlineAt === undefined ? 360_000 : Math.max(0, deadlineAt - Date.now()));
    });
    try {
      const code = await Promise.race([closed.then((code) => timedOut ? interrupted : code), interrupted]);
      if (component === "OFFICIAL_MACRO" && code === 79) throw Object.assign(new ShadowRuntimeError("FAILED", safeError(error) || "OFFICIAL_MACRO PROCESS_JOB_UNAVAILABLE"), { cause: "PROCESS_TREE_NOT_CLOSED" });
      if (code === 124) throw new ShadowRuntimeError("TIMED_OUT", `${component} 运行超时`);
      if (code === 78) throw new ShadowRuntimeError("DATA_BLOCKED", safeError(error) || `${component} 数据阻断`);
      if (code !== 0) throw new ShadowRuntimeError("FAILED", safeError(error) || `${component} 进程异常退出`);
    } finally { clearTimeout(timeout); clearTimeout(cleanupTimeout); }
    timing?.({ event: "macro_response_read_begin", at: new Date().toISOString(), monotonic_ms: performance.now() });
    const result = JSON.parse(readFileSync(responsePath, "utf8")) as StepResult;
    timing?.({ event: "macro_response_read_end", at: new Date().toISOString(), monotonic_ms: performance.now() });
    if (!result.evidenceRef || !result.observedAt || !result.dataCutoffAt || component === "A2" && !/^[0-9a-f]{64}$/.test(String(result.payload.result_hash ?? ""))) throw new ShadowRuntimeError("FAILED", `${component} 本地结果证明无效`);
    return result;
  };
  return async (component, input) => {
    if (component === "A1") {
      const observedAt = new Date().toISOString();
      const timing = runtimeTiming(paths.dataRoot, input.run_id), lag = monitorEventLoopDelay({ resolution: 20 });
      const mark = (event: string) => timing({ event, at: new Date().toISOString(), monotonic_ms: performance.now() });
      lag.enable();
      mark("a1_begin");
      try {
        const runtimeContext = input.RUNTIME_CONTEXT as { dataSources?: Array<{ source?: string; status?: string }>; marketIntelligence?: MarketIntelligenceState; marketRadar?: MarketRadarArchiveState };
        const freezeDeadline = input.SLOT_FREEZE_DEADLINE_AT === undefined ? Infinity : Date.parse(String(input.SLOT_FREEZE_DEADLINE_AT));
        const opening = input.source_mode === "LIVE" && input.RUN_REASON === "早盘固定分析" && ptDateKey(observedAt) >= OPENING_RECOVERY_EFFECTIVE_DATE && Number.isFinite(freezeDeadline);
        if (Number.isNaN(freezeDeadline) || Date.now() > freezeDeadline) throw new ShadowRuntimeError("TIMED_OUT", "A1_SLOT_FREEZE_DEADLINE_EXCEEDED");
        const market = dependencies.readMarket ? dependencies.readMarket(observedAt, input) : withRobinhoodMcp({ allowlist: ROBINHOOD_READONLY_TOOLS, onTiming: timing }, (session) => collectRobinhoodReadonly(session, observedAt, runtimeContext.marketIntelligence, runtimeContext.marketRadar?.snapshot, input.SLOT_FREEZE_DEADLINE_AT as string | undefined, timing));
        // Reserve the existing 5s process cleanup grace plus 5s for immutable A1 commit.
        // Insufficient optional budget must not start a worker that can only finish after the slot.
        const macroDeadline = Math.min(Date.parse(observedAt) + 30_000, freezeDeadline - 10_000);
        const macro = (macroDeadline <= Date.now() ? Promise.reject(new ShadowRuntimeError("TIMED_OUT", "OFFICIAL_MACRO_OPTIONAL_BUDGET_EXHAUSTED")) : runPython("OFFICIAL_MACRO", { ...input, ...(opening ? { run_id: `${input.run_id}:opening-${observedAt.replace(/\D/g, "")}` } : {}), MARKET_SNAPSHOT: { generated_at: observedAt } }, macroDeadline, timing)).then((result) => result.payload).catch((error) => {
          if (error instanceof Error && error.cause === "PROCESS_TREE_NOT_CLOSED") throw error;
          const windowStart = ptDateKey(observedAt);
          const windowEnd = new Date(Date.parse(`${windowStart}T12:00:00.000Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
          const withoutHash = {
            contract_version: "v1", component: "OFFICIAL_MACRO_CONTEXT", mode: "SHADOW", status: "DATA_BLOCKED",
            collected_at: observedAt, as_of: observedAt,
            providers: {
              BLS: { schedule_status: "DATA_BLOCKED", results_status: "DATA_BLOCKED", as_of: null, error: safeError(error) },
              BEA: { schedule_status: "DATA_BLOCKED", results_status: "NOT_OBSERVED", as_of: null, error: safeError(error) },
            },
            events: [], results: [],
            bls_macro_watch: { contract_version: "v1", component: "A1_MACRO_WATCH", actionable: false, status: "DEGRADED", generated_at: observedAt, timezone: "America/Los_Angeles", window_start: windowStart, window_end: windowEnd, selection_rule: "BLS_MARKET_MOVING_RELEASES_NEXT_7_CALENDAR_DAYS", events: [] },
            bls_official_news: { status: "FAILED", healthy_feed_count: 0, feeds: [] }, official_items: [], errors: [safeError(error)],
          };
          return { ...withoutHash, context_hash: createHash("sha256").update(canonicalJson(withoutHash)).digest("hex") };
        });
        // Wait for macro cleanup even when market collection rejects; no orphan writer crosses slots.
        const [marketResult, macroResult] = await Promise.allSettled([market, macro]);
        mark("a1_sources_settled");
        if (macroResult.status === "rejected") throw macroResult.reason;
        if (marketResult.status === "rejected") throw marketResult.reason;
        mark("a1_freshness_begin");
        const marketSources = refreshCoreFreshness(marketResult.value, new Date().toISOString());
        mark("a1_freshness_end");
        const officialMacro: Record<string, unknown> = macroResult.value;
        const robinhood = marketSources.providers.find((provider) => provider.source === "ROBINHOOD")!;
        const dataCutoffAt = robinhood.as_of ?? observedAt;
        const macroCoverage = officialMacro.coverage as Record<string, string> | undefined;
        const macroMarket = officialMacro.market_context as { status?: string } | undefined;
        const macroReady = Boolean(macroCoverage && Object.values(macroCoverage).every((status) => status === "LIVE") && macroMarket?.status === "LIVE");
        const v2Result = {
          adapter: "TRADING_OS_GENERIC_MARKET_TO_V2_A1",
          source: "ROBINHOOD_OFFICIAL_TRADING_MCP",
          snapshot_id: marketSources.snapshot_id,
          snapshot_hash: marketSources.snapshot_hash,
          tradier_status: "DISABLED_BACKUP",
          finnhub_status: runtimeContext.dataSources?.find((source) => source.source === "FINNHUB")?.status ?? "NOT_OBSERVED",
          event_count: runtimeContext.marketIntelligence?.events?.length ?? 0,
          verified_causal_chain_count: runtimeContext.marketIntelligence?.causalChains?.filter((chain) => (chain as { event_evidence_state?: string }).event_evidence_state === "VERIFIED").length ?? 0,
          official_macro_status: officialMacro.status,
          official_macro_coverage_status: macroReady ? "LIVE" : "DEGRADED",
          official_macro_hash: officialMacro.context_hash,
          market_environment_status: marketSources.market_environment?.status ?? "NOT_OBSERVED",
        };
        const evidenceRef = `data/live-shadow/evidence/${String(input.run_id).replace(/:/g, "-")}-a1.json`;
        const payload = {
          contract_version: "v1", component: "A1", mode: "SHADOW", actionable: false, source_mode: input.source_mode,
          status: marketSources.status === "LIVE" ? "HEALTHY" : marketSources.status === "MARKET_CLOSED" ? "DEGRADED_NO_TRADE" : "BLOCKED", observed_at: observedAt, data_cutoff_at: dataCutoffAt,
          freshness_seconds: robinhood.freshness_seconds,
          result_hash: createHash("sha256").update(canonicalJson(v2Result)).digest("hex"), evidence_ref: evidenceRef,
          market_snapshot_id: marketSources.snapshot_id, market_snapshot_hash: marketSources.snapshot_hash,
          data_gaps: [...marketSources.errors.map((error) => `${error.scope}: ${error.code}`), ...(marketSources.market_environment?.data_gaps ?? []), ...(macroReady ? [] : ["OFFICIAL_MACRO_DEGRADED"])],
          market_sources: marketSources, official_macro: officialMacro, v2_result: v2Result,
        };
        if (opening) {
          const regularOpen = utcForPt(ptDateKey(observedAt), "06:30").getTime();
          const ready = marketSources.status === "LIVE" && ["SPY", "QQQ"].every((symbol) => {
            const quote = marketSources.quotes.find((item) => item.symbol === symbol), bars = marketSources.bars.find((item) => item.symbol === symbol);
            const last = bars?.values?.at(-1), start = Date.parse(last?.begins_at ?? "");
            return quote && Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && quote.bid! > 0 && quote.ask! >= quote.bid! && Date.parse(quote.as_of ?? "") >= regularOpen
              && start >= regularOpen && start + 300_000 <= Date.now() && Date.parse(bars?.as_of ?? "") === start + 300_000;
          });
          if (!ready && Date.now() < freezeDeadline) {
            const pendingRef = `data/live-shadow/evidence/${String(input.run_id).replace(/:/g, "-")}-a1-pending-${observedAt.replace(/\D/g, "")}.json`;
            atomicJson(resolve(paths.dataRoot, "evidence", pendingRef.split("/").at(-1)!), { status: "NOT_PUBLISHED", reason: "OPENING_MARKET_PENDING", attempt: payload });
            throw new OpeningMarketPending(pendingRef);
          }
          if (!ready) throw new ShadowRuntimeError("DATA_BLOCKED", "OPENING_MARKET_NOT_READY_BY_FREEZE_DEADLINE");
        }
        mark("a1_commit_deadline_check");
        if (Date.now() > freezeDeadline) throw new ShadowRuntimeError("TIMED_OUT", "A1_SLOT_FREEZE_DEADLINE_EXCEEDED");
        atomicJson(resolve(paths.dataRoot, "evidence", `${String(input.run_id).replace(/:/g, "-")}-a1.json`), payload);
        mark("a1_evidence_written");
        const eodAnalysis = marketSources.status === "MARKET_CLOSED" && ["次日提前分析", "周末分析"].includes(String(input.RUN_REASON));
        return {
          payload, observedAt, dataCutoffAt, evidenceRef,
          downstreamReason: marketSources.status === "MARKET_CLOSED" && !eodAnalysis ? "SKIPPED_MARKET_CLOSED" : marketSources.status === "LIVE" || eodAnalysis ? undefined : "DATA_BLOCKED",
        };
      } catch (error) {
        mark("a1_failed");
        if (error instanceof ShadowRuntimeError) throw error;
        throw new ShadowRuntimeError("DATA_BLOCKED", `Robinhood 官方 Trading MCP 只读采集失败：${safeError(error)}`);
      } finally {
        lag.disable();
        timing({ event: "a1_event_loop_max_delay", at: new Date().toISOString(), monotonic_ms: performance.now(), ...(lag.count ? { duration_ms: lag.max / 1_000_000 } : {}) });
        mark("a1_end");
      }
    }
    return runPython(component, input);
  };
}
