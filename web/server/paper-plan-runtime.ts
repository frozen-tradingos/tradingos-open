import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exchangeDateKey, formatPtTime, isNyseRegularSession, latestCompletedNyseSession, nextNyseRegularDateAfter, nyseClosePtMinutes, robinhoodSessionAt } from "../app/market-time.ts";
import { assessPaperContracts, assessPaperPlanEntryConditions, buildPaperPlan, PAPER_DAILY_TARGET, PAPER_ENTRY_QUALITY_START_AT, paperMarkExitReason, paperPlanId, paperReturnPct, paperTrackingWindow, projectPaperTracking, type PaperEntryMarketEvidence, type PaperPlan, type PaperPlanEvent, type PaperQuoteProof, type PaperRiskExit } from "../app/paper-plan.ts";
import type { ApprovedCapabilitySnapshot, SnapshotState } from "../app/snapshot-import.ts";
import type { StockPlanEvidence } from "../app/stock-manual-plan.ts";
import { buildTsRegimeRiskContext } from "../app/ts-regime-risk.ts";
import { collectStockPlanEvidence } from "./stock-plan-evidence.ts";
import { canonicalJson, collectExternalOptionQuote, withRobinhoodMcp } from "./robinhood-mcp.ts";
import { makePaperEvent } from "./paper-plan-store.ts";
import { capturePaperQuoteEvidence, collectPaperCharts } from "./paper-quote-evidence.ts";
import { isPaperIndexSymbol, paperIndexResearchActive, paperCodexActive, paperCodexQualifiedActive, validatePaperOwnerReselection, type PaperOwnerReselection, type PaperSelectionSource } from "../app/paper-selection.ts";
import { buildPaperFormalForecastReview, createPaperCodexSelector, paperSelectionFallback, projectPaperForecastContext } from "./paper-codex-selection.ts";

type Store = {
  appendPaperPlanEvent: (event: PaperPlanEvent) => unknown;
  getPaperPlanEvents: (planId: string) => PaperPlanEvent[];
  getActivePaperPlans: () => PaperPlan[];
  getPaperForecastContext?: (at: string, scope?: "INTRADAY" | "NEXT_SESSION_BACKGROUND") => Array<Record<string, unknown>>;
  getPaperEntryMarketEvidence?: (symbol: string, at: string) => PaperEntryMarketEvidence | null;
};
type Result = { status: "COMPLETED" | "OVERLAP_REJECTED" | "NOT_CURRENT" | "NOT_OWNER" | "SNAPSHOT_UNAVAILABLE"; created: number; recorded: number; checked: number; ended: number };
const DAILY_ATTEMPT_REASON = "每日系统模拟观察；不是买入批准或真实成交";
const CODEX_CANDIDATE_ATTEMPT_REASON = "CODEX_PAPER_CANDIDATE_BATCH：读取当日Codex已选择股票的真实合约；不是模型重复调用";
const CODEX_PREFLIGHT_REASON = "CODEX_PAPER_PREFLIGHT：先核验真实合约池，未调用模型";

function paperRiskExit(snapshot: SnapshotState, plan: PaperPlan, at: Date): PaperRiskExit | null {
  if (robinhoodSessionAt(at).phase !== "REGULAR") return null;
  const now = at.getTime(), decision_at = at.toISOString(), day = exchangeDateKey(at);
  // The existing news collector runs within the natural half-hour cycle; this is not a new fetch budget.
  const fresh = (value: string | null | undefined) => Number.isFinite(Date.parse(value ?? "")) && Date.parse(value!) <= now && now - Date.parse(value!) <= 30 * 60_000;
  const known = (value: string | null | undefined) => Number.isFinite(Date.parse(value ?? "")) && Date.parse(value!) <= now;
  const https = (value: string | null | undefined) => { try { const url = new URL(value ?? ""); return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password; } catch { return false; } };
  const source = snapshot.dataSources.find((item) => item.source === "FINNHUB");
  const finnhubCurrent = source?.authorization === "VALID" && ["LIVE", "DEGRADED"].includes(source.status) && fresh(source.checked_at) && fresh(source.as_of);
  const calendar = snapshot.marketIntelligence.earningsCalendar;
  if (finnhubCurrent && source.capabilities.earnings_calendar && calendar && calendar.checked_at === source.checked_at && fresh(calendar.checked_at)
    && fresh(calendar.response_received_at) && Date.parse(calendar.response_received_at) >= Date.parse(calendar.checked_at)) {
    const [hour, minute] = formatPtTime(at).split(":").map(Number), lastHour = hour * 60 + minute >= nyseClosePtMinutes(day) - 60;
    const nextDay = nextNyseRegularDateAfter(day);
    for (const event of snapshot.marketIntelligence.currentEarnings ?? []) {
      const session = event.earnings_result?.session, date = event.scheduled_for;
      if (event.kind !== "EARNINGS" || event.source !== "Finnhub Earnings Calendar" || event.event_type !== "earnings" || event.earnings_result?.reported !== false
        || !event.affected_symbols.includes(plan.symbol) || !calendar.event_ids.includes(event.event_id) || !known(event.fetched_at) || Date.parse(event.fetched_at) > Date.parse(calendar.checked_at)
        || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date || !isNyseRegularSession(date) || date > plan.contract.expiration) continue;
      const due = date === day && (session === "AMC" && lastHour || session === "DMH" || session === "UNKNOWN")
        || date === nextDay && lastHour && (session === "BMO" || session === "UNKNOWN");
      if (due) return { rule_version: "PAPER_RISK_EXIT_V1", reason: "EARNINGS_WINDOW", decision_at, event_id: event.event_id,
        title: `${plan.symbol} 财报日程预告风险回避；不是确定公布结果`, source: event.source, source_url: event.source_url,
        published_at: null, scheduled_for: date, session: session!, source_observed_at: calendar.response_received_at, source_checked_at: calendar.response_received_at, scope: plan.symbol };
    }
  }
  const a1 = snapshot.outputs.A1_SHADOW_RESULT, macro = a1?.official_macro;
  if (a1?.source_mode === "LIVE" && fresh(a1.observed_at) && macro?.status === "LIVE" && fresh(macro.collected_at) && fresh(macro.as_of)
    && Date.parse(macro.as_of) <= Date.parse(macro.collected_at) && /^[a-f0-9]{64}$/.test(macro.context_hash)) {
    const overlay = buildTsRegimeRiskContext({ market: null, a2: null, officialMacro: macro, observedAt: decision_at }).event_overlay;
    const event = macro.events.find((item) => overlay.events.some((entry) => entry.scheduled_at === item.scheduled_at && entry.name === item.release_name)
      && Date.parse(item.scheduled_at) <= Date.parse(plan.expires_at) && https(item.source_url) && /(^|\.)(bls\.gov|bea\.gov|federalreserve\.gov)$/.test(new URL(item.source_url).hostname));
    if (event) return { rule_version: "PAPER_RISK_EXIT_V1", reason: "OFFICIAL_MACRO_WINDOW", decision_at,
      event_id: `macro:${macro.context_hash}:${event.scheduled_at}`, title: `${event.release_name} 前90分钟的PAPER事件风险回避`, source: "OFFICIAL_MACRO_CONTEXT", source_url: event.source_url,
      published_at: null, scheduled_for: event.scheduled_at, session: null, source_observed_at: macro.collected_at, source_checked_at: macro.collected_at, scope: "GLOBAL" };
  }
  if (finnhubCurrent && source.capabilities.news) {
    for (const event of snapshot.marketIntelligence.events) {
      const received = snapshot.marketIntelligence.eventResponseReceivedAt?.[event.event_id];
      if (event.kind !== "NEWS" || event.importance !== "MARKET_MOVING" || event.event_evidence_state !== "VERIFIED" || !event.event_fingerprint
        || !known(event.published_at) || !known(event.fetched_at) || !known(received) || Date.parse(received!) < Date.parse(event.fetched_at) || !https(event.source_url)) continue;
      const chain = snapshot.marketIntelligence.causalChains.find((item) => item.event_fingerprint === event.event_fingerprint && item.event_evidence_state === "VERIFIED"
        && known(item.updated_at) && Date.parse(item.expires_at) > now);
      if (!chain) continue;
      const own = event.affected_symbols.includes(plan.symbol) && chain.affected.includes(plan.symbol);
      const global = ["inflation", "employment", "central_bank", "growth"].includes(chain.event_category);
      if (!own && !global) continue;
      const observed = Math.max(Date.parse(event.published_at!), Date.parse(event.fetched_at), Date.parse(chain.updated_at), Date.parse(received!));
      const checked = Math.max(Date.parse(source.checked_at), Date.parse(received!));
      if (observed > checked) continue;
      return { rule_version: "PAPER_RISK_EXIT_V1", reason: "VERIFIED_MAJOR_EVENT", decision_at, event_id: event.event_id,
        title: `${event.title}；已核验事件身份的风险回避，不推断利空方向`, source: event.source, source_url: event.source_url,
        published_at: event.published_at, scheduled_for: null, session: null, source_observed_at: new Date(observed).toISOString(), source_checked_at: new Date(checked).toISOString(), scope: own ? plan.symbol : "GLOBAL" };
    }
  }
  return null;
}

function currentSource(snapshot: SnapshotState, at: Date) {
  const a1 = snapshot.outputs.A1_SHADOW_RESULT, radar = snapshot.marketRadar;
  const candidates: Array<{ capabilities: ApprovedCapabilitySnapshot; id: string; hash: string }> = [];
  if (a1?.source_mode === "LIVE" && a1.market_sources?.approved_capabilities && a1.market_snapshot_id === a1.market_sources.snapshot_id && a1.market_snapshot_hash === a1.market_sources.snapshot_hash) candidates.push({ capabilities: a1.market_sources.approved_capabilities, id: a1.market_sources.snapshot_id, hash: a1.market_sources.snapshot_hash });
  if (radar?.snapshot && radar.market_snapshot_id && radar.market_snapshot_hash && (radar.source_record_id?.match(/^live-shadow:\d{8}T\d{6}Z:A1$/) || radar.source_record_id === `bootstrap:${radar.market_snapshot_id}`)) candidates.push({ capabilities: radar.snapshot, id: radar.market_snapshot_id, hash: radar.market_snapshot_hash });
  return candidates.filter((source) => source.capabilities.source === "ROBINHOOD_OFFICIAL_TRADING_MCP" && source.capabilities.mode === "SHADOW" && source.capabilities.actionable === false && /^[a-f0-9]{64}$/.test(source.hash) && source.id
    && Number.isFinite(Date.parse(source.capabilities.generated_at)) && Date.parse(source.capabilities.generated_at) <= at.getTime()
    && exchangeDateKey(source.capabilities.generated_at) >= latestCompletedNyseSession(at))
    .sort((left, right) => Date.parse(right.capabilities.generated_at) - Date.parse(left.capabilities.generated_at))[0] ?? null;
}

/** Runs only from the existing natural heartbeat; PAPER never becomes an approval or a fill. */
export function createPaperPlanRuntime(options: {
  projectRoot: string; dataRoot?: string; v2Root?: string; store: Store;
  readCurrent: () => Promise<SnapshotState>; now?: () => Date;
  session?: typeof withRobinhoodMcp; collect?: typeof collectStockPlanEvidence; quote?: typeof collectExternalOptionQuote;
  select?: ReturnType<typeof createPaperCodexSelector>;
  ownerReselection?: PaperOwnerReselection;
  researchContext?: Parameters<typeof createPaperCodexSelector>[0]["researchContext"];
}) {
  const now = options.now ?? (() => new Date());
  const reselection = options.ownerReselection ? structuredClone(validatePaperOwnerReselection(options.ownerReselection, exchangeDateKey(now()), now().toISOString())) : undefined;
  const planId = (day: string, ordinal: number) => `${paperPlanId(day, ordinal)}${reselection ? `:reselect:${reselection.request_id}` : ""}`;
  const select = options.select ?? createPaperCodexSelector({ projectRoot: options.projectRoot, dataRoot: options.dataRoot ?? resolve(options.projectRoot, "data"), now, ownerReselection: reselection, researchContext: options.researchContext, readForecastContext: options.store.getPaperForecastContext });
  const entryConfirmation = (plan: PaperPlan, at: string) => {
    if (!plan.entry_policy) return undefined;
    let market: PaperEntryMarketEvidence | null = null;
    try { market = options.store.getPaperEntryMarketEvidence?.(plan.symbol, at) ?? null; } catch { /* Missing local evidence does not block the daily research sample. */ }
    return assessPaperPlanEntryConditions(plan, at, market);
  };
  // ponytail: eight checks per existing heartbeat; the last hour's four slots rotate one daily research attempt per plan, not real-time risk monitoring.
  const trackingBatch = (active: PaperPlan[]) => {
    if (reselection) return [];
    const at = now(), eligible = active.map((plan) => ({ plan, tracking: projectPaperTracking(plan, options.store.getPaperPlanEvents(plan.plan_id), at.toISOString()) }))
      .filter(({ tracking }) => tracking.stage === "FOCUS" || tracking.research_due);
    const today = eligible.filter(({ plan, tracking }) => plan.market_date === exchangeDateKey(at) && tracking.stage === "FOCUS").slice(0, PAPER_DAILY_TARGET).map(({ plan }) => plan);
    const priority = new Set(today.map((plan) => plan.plan_id));
    return [...today, ...eligible.filter(({ plan }) => !priority.has(plan.plan_id)).map(({ plan }) => plan)].slice(0, 8);
  };
  let running = false;
  const run = async (at: Date): Promise<Result> => {
    const result: Result = { status: "COMPLETED", created: 0, recorded: 0, checked: 0, ended: 0 };
    const endObservation = (plan: PaperPlan) => {
      const window = paperTrackingWindow(plan), stamp = now().toISOString();
      if (reselection || Date.parse(stamp) < Date.parse(window.ends_at)) return false;
      const payload = window.ends_at === plan.expires_at ? { reason: "EXPIRATION" as const, ended_at: plan.expires_at, terminal_value: "UNKNOWN" as const }
        : { reason: "OBSERVATION_WINDOW" as const, policy: window.policy, ended_at: window.ends_at, terminal_value: "UNKNOWN" as const };
      options.store.appendPaperPlanEvent(makePaperEvent(plan.plan_id, stamp, "ENDED", payload));
      result.recorded++; result.ended++; return true;
    };
    if (reselection) {
      validatePaperOwnerReselection(reselection, exchangeDateKey(at), at.toISOString());
      for (const id of reselection.replaces_plan_ids) {
        const original = options.store.getPaperPlanEvents(id);
        if (!original.some((event) => event.event_type === "CREATED") || !original.some((event) => event.event_type === "ENDED" && event.payload.reason === "OWNER_VOID" && event.payload.owner_request_ref === reselection.request_id)) throw new Error("PAPER_RESELECTION_REQUIRES_OWNER_VOID");
      }
    }
    const snapshot = await options.readCurrent().catch(() => null);
    if (!snapshot) {
      // The production store independently enforces OWNER; missing snapshots never grant provider access.
      try { for (const plan of options.store.getActivePaperPlans()) endObservation(plan); } catch { /* Unavailable or read-only stores never bypass their own write boundary. */ }
      if (robinhoodSessionAt(at).phase !== "REGULAR") return { ...result, status: "SNAPSHOT_UNAVAILABLE" };
      try {
        for (const plan of trackingBatch(options.store.getActivePaperPlans())) {
          try {
            options.store.appendPaperPlanEvent(makePaperEvent(plan.plan_id, now().toISOString(), "GAP", { reasons: ["NO_SNAPSHOT：本次系统快照读取失败；未查询合约或编造单子"] }));
            result.recorded++;
          } catch { /* The Owner/read-only store guard still applies to every old sample. */ }
        }
      } catch { /* An unavailable active-plan store cannot be replaced with guessed plans. */ }
      for (let ordinal = 1; ordinal <= PAPER_DAILY_TARGET; ordinal++) {
        try {
          const id = planId(exchangeDateKey(at), ordinal), events = options.store.getPaperPlanEvents(id);
          if (events.some((event) => event.event_type === "CREATED" || event.event_type === "ENDED")) continue;
          options.store.appendPaperPlanEvent(makePaperEvent(id, now().toISOString(), "ATTEMPT", { reasons: ["NO_SNAPSHOT：本次系统快照读取失败；未查询合约或编造单子"] }));
          result.recorded++;
        } catch { /* A non-Owner or unavailable store must not be bypassed. */ }
      }
      return { ...result, status: "SNAPSHOT_UNAVAILABLE" };
    }
    const profile = snapshot.investmentKernel;
    if (profile?.profile_mode !== "OWNER" || profile.execution_mode !== "SHADOW" || profile.broker_access !== "READ_ONLY" || profile.automated_execution !== false) return { ...result, status: "NOT_OWNER" };
    const append = (event: PaperPlanEvent) => { options.store.appendPaperPlanEvent(event); result.recorded++; };
    const forecastRows: Partial<Record<"INTRADAY" | "NEXT_SESSION_BACKGROUND", Array<Record<string, unknown>>>> = {};
    const forecastReadFailures = new Set<string>();
    const forecastReview = (plan: PaperPlan, stamp: string, scope: "INTRADAY" | "NEXT_SESSION_BACKGROUND" = "INTRADAY") => {
      if (!options.store.getPaperForecastContext && scope === "INTRADAY") return undefined;
      if (!forecastRows[scope]) try { forecastRows[scope] = options.store.getPaperForecastContext?.(stamp, scope) ?? []; } catch { forecastRows[scope] = []; forecastReadFailures.add(scope); }
      const context = projectPaperForecastContext(forecastRows[scope]!, stamp, scope);
      return buildPaperFormalForecastReview(scope === "NEXT_SESSION_BACKGROUND" && forecastReadFailures.has(scope) ? { ...context, status: "INVALID" } : context, plan.symbol, plan.direction);
    };
    const day = exchangeDateKey(at);
    const qualityActive = now().getTime() >= Date.parse(PAPER_ENTRY_QUALITY_START_AT);
    const gap = (id: string, reason: string) => append(makePaperEvent(id, now().toISOString(), "GAP", { reasons: [reason] }));
    const active = options.store.getActivePaperPlans();
    for (const plan of active) endObservation(plan);
    if (robinhoodSessionAt(at).phase !== "REGULAR") return result;

    const ordinals = Array.from({ length: PAPER_DAILY_TARGET }, (_, index) => index + 1);
    const dailyEvents = ordinals.flatMap((ordinal) => options.store.getPaperPlanEvents(planId(day, ordinal)));
    const created = dailyEvents.filter((event) => event.event_type === "CREATED");
    const missing = new Set(ordinals.filter((ordinal) => !created.some((event) => event.plan_id === planId(day, ordinal))));
    const replaced = reselection?.replaces_plan_ids.flatMap((id) => options.store.getPaperPlanEvents(id)).filter((event) => event.event_type === "CREATED") ?? [];
    const usedSymbols = new Set([...active.filter((plan) => Date.parse(plan.expires_at) > now().getTime() && (!qualityActive || plan.market_date === day)).map((plan) => plan.symbol), ...created.map((event) => event.payload.plan.symbol), ...replaced.map((event) => event.payload.plan.symbol)]);
    const attempt = (reasons: string[], ordinalsToRecord: Iterable<number> = missing) => {
      const attemptedAt = now().toISOString();
      for (const ordinal of ordinalsToRecord) append(makePaperEvent(planId(day, ordinal), attemptedAt, "ATTEMPT", { reasons }));
    };
    const entryDays = snapshot.macroEventLearning?.entry_special_days;
    if (missing.size && !Array.isArray(entryDays)) attempt(["SPECIAL_DAY_CALENDAR_UNAVAILABLE：当前官方事件日历未确认，不能将未知日当普通日；暂停新建模拟单，原单继续跟踪"]);
    if (missing.size && Array.isArray(entryDays)) {
      const paperCandidateOffset = 3 * new Set(dailyEvents.filter((event) => event.event_type === "ATTEMPT" && event.payload.reasons.length === 1 && event.payload.reasons[0] === DAILY_ATTEMPT_REASON).map((event) => event.recorded_at)).size;
      const codexCandidateOffset = 3 * new Set(dailyEvents.filter((event) => event.event_type === "ATTEMPT" && event.payload.reasons.length === 1 && event.payload.reasons[0] === CODEX_CANDIDATE_ATTEMPT_REASON).map((event) => event.recorded_at)).size;
      attempt([DAILY_ATTEMPT_REASON]);
      try {
        const source = currentSource(snapshot, now());
        if (!source) attempt(["NO_CURRENT_SOURCE：未观察到最近完整交易日以来、有原始哈希的分析依据"]);
        else {
          const a1 = snapshot.outputs.A1_SHADOW_RESULT;
          const checkedAt = now(), newsSource = snapshot.dataSources.find((item) => item.source === "FINNHUB");
          // Reuse the natural half-hour source ceiling used by PAPER event exits; checking an old snapshot now cannot refresh it.
          const freshRisk = (stamp: string | null | undefined) => Number.isFinite(Date.parse(stamp ?? "")) && Date.parse(stamp!) <= checkedAt.getTime() && checkedAt.getTime() - Date.parse(stamp!) <= 30 * 60_000;
          const market = a1?.source_mode === "LIVE" && freshRisk(a1.observed_at) && freshRisk(a1.market_sources?.generated_at) && freshRisk(a1.market_sources?.as_of) ? a1.market_sources ?? null : null;
          const macro = a1?.source_mode === "LIVE" && freshRisk(a1.observed_at) && freshRisk(a1.official_macro?.collected_at) && freshRisk(a1.official_macro?.as_of) && Date.parse(a1.official_macro!.as_of) <= Date.parse(a1.official_macro!.collected_at) ? a1.official_macro : null;
          const risk = buildTsRegimeRiskContext({ market, a2: null, officialMacro: macro, observedAt: checkedAt.toISOString() });
          const chains = new Map(snapshot.marketIntelligence.causalChains.filter((chain) => chain.event_evidence_state === "VERIFIED" && Date.parse(chain.expires_at) > checkedAt.getTime()).map((chain) => [chain.event_fingerprint, chain]));
          const news: StockPlanEvidence["news"] = {
            checked_at: newsSource?.checked_at ?? source.capabilities.generated_at,
            status: newsSource?.status === "LIVE" && newsSource.authorization === "VALID" ? "LIVE" : "DATA_BLOCKED",
            items: snapshot.marketIntelligence.events.filter((item) => item.kind === "NEWS" && item.source_url?.startsWith("https://") && item.published_at && Date.parse(item.published_at) <= checkedAt.getTime()).slice(0, 30).map((item) => ({
              id: item.event_id, headline: item.title, url: item.source_url!, source: item.source, published_at: item.published_at!,
              verified: item.event_evidence_state === "VERIFIED" && chains.has(item.event_fingerprint ?? ""), market_moving: item.importance === "MARKET_MOVING" && chains.has(item.event_fingerprint ?? ""), symbols: item.affected_symbols,
              expires_at: chains.get(item.event_fingerprint ?? "")?.expires_at ?? null,
            })),
          };
          const bucket = new Date(Math.floor(checkedAt.getTime() / 900_000) * 900_000).toISOString().replaceAll(/[-:]/g, "").replace(".000", "");
          // Research records risk warnings while collecting its own real stock and contract evidence.
          const criticalIncidents = snapshot.selfCheck.active.filter((item) => item.severity === "CRITICAL");
          const globalRisk = { checked_at: risk.observed_at, critical_blockers: [...risk.risk_layers.core_hard.filter((item) => item.code !== "A2_FROZEN_EVIDENCE_MISSING").map((item) => item.reason), ...criticalIncidents.map((item) => item.title)], new_entry_blockers: risk.risk_layers.new_entry.filter((item) => item.scope === "GLOBAL").map((item) => item.reason) };
          if (a1?.official_macro && !macro) globalRisk.critical_blockers.push("PAPER_MACRO_RISK_STALE：原始官方宏观风险证据缺失、过期或来自未来；作为研究风险保留");
          const qualified = paperCodexQualifiedActive(now());
          const preflightSeen = new Set<string>();
          const collect = async (phase: "preflight" | "entry", offset: number, choices?: PaperSelectionSource["candidates"]) => {
            let captured: ReturnType<typeof capturePaperQuoteEvidence> | undefined, evidence: StockPlanEvidence[] = [], failed = false;
            try {
              evidence = await (options.session ?? withRobinhoodMcp)({ projectRoot: options.projectRoot, timeoutMs: 30_000,
                allowlist: ["get_equity_quotes", "get_option_chains", "get_option_instruments", "get_option_quotes"] },
              (session) => { captured = capturePaperQuoteEvidence(session, now); return (options.collect ?? collectStockPlanEvidence)(captured.session, {
                run_id: `paper-check:${bucket}`, slot_id: `paper-check:${bucket}`, source_snapshot_id: source.id, source_snapshot_hash: source.hash,
                approvedCapabilities: source.capabilities, news, deadlineMs: 30_000, paperResearch: true, paperCandidateOffset: offset,
                ...(paperIndexResearchActive(at) && missing.size === 1 && missing.has(1) ? { paperIndexOnly: true } : {}),
                ...(paperIndexResearchActive(at) && !missing.has(1) ? { paperEquityOnly: true } : {}),
                paperExcludedSymbols: [...usedSymbols, ...(qualityActive && phase === "preflight" ? preflightSeen : [])], v2Root: options.v2Root ?? resolve(options.projectRoot, "..", "v2-reference"),
                ...(phase === "preflight" ? { paperPreflight: true } : {}), ...(choices ? { paperSelectedCandidates: choices } : {}), global_risk: globalRisk,
              }); });
            } catch { failed = true; }
            const authentic = evidence.filter((item) => {
              const { evidence_id, ...original } = item;
              return evidence_id === createHash("sha256").update(canonicalJson(original)).digest("hex") && item.source_snapshot_id === source.id && item.source_snapshot_hash === source.hash;
            });
            if (phase === "preflight") authentic.forEach((item) => preflightSeen.add(item.symbol));
            const proof = (e: StockPlanEvidence, c: StockPlanEvidence["contracts"][number], recordedAt: string) => captured?.proof(
              { symbol: e.symbol, contract: { contract_id: c.contract_id, chain_id: c.instrument.chain_id, expiration: c.expiration, strike: c.strike, option_type: c.option_type, multiplier: c.instrument.trade_value_multiplier! } },
              { bid: c.bid!, ask: c.ask!, quoted_at: c.as_of!, ...(c.mark !== null ? { mark: c.mark } : {}) }, recordedAt);
            if (qualified) {
              const recordedAt = now().toISOString(), directory = resolve(options.dataRoot ?? resolve(options.projectRoot, "data"), "paper-selections", day, ...(reselection ? ["owner-reselect", reselection.request_id] : []));
              await mkdir(directory, { recursive: true });
              const audit = { phase, offset, recorded_at: recordedAt, collection_failed: failed, evidence, raw: captured?.raw() ?? null,
                decisions: evidence.map((e) => {
                  const assessment = authentic.includes(e) ? assessPaperContracts(e, recordedAt, entryDays, phase === "preflight" || !!choices) : { contracts: [], reasons: ["EVIDENCE_HASH_OR_SOURCE_MISMATCH"] };
                  const proven = assessment.contracts.filter((c) => {
                    if (proof(e, c, recordedAt)) return true;
                    assessment.reasons.push(`${e.symbol}/${c.contract_id}：QUOTE_PROOF_MISSING`); return false;
                  });
                  return { evidence_id: e.evidence_id, symbol: e.symbol, direction: e.direction, qualified_contract_ids: proven.map((c) => c.contract_id), reasons: assessment.reasons };
                }) };
              await writeFile(resolve(directory, `${phase}-${recordedAt.replaceAll(/[:.]/g, "-")}-${randomUUID()}.json`), canonicalJson(audit) + "\n", { flag: "wx" });
            }
            if (failed) throw Error("PAPER_COLLECTION_FAILED");
            return { authentic, captured, proof };
          };
          let selection: PaperSelectionSource | undefined;
          if (paperCodexActive(now())) {
            selection = await select({ ...source, snapshot, excludedSymbols: [...usedSymbols], ...(qualified ? { loadQualifiedContracts: async () => {
              const pool: Array<{ evidence: StockPlanEvidence; contract_id: string; proof: PaperQuoteProof }> = [];
              const offset = 9 * new Set(dailyEvents.filter((event) => event.event_type === "ATTEMPT" && event.payload.reasons[0] === CODEX_PREFLIGHT_REASON).map((event) => event.recorded_at)).size;
              attempt([CODEX_PREFLIGHT_REASON]);
              // ponytail: at most three 30-second/32-RPC batches (nine stocks); rotate next natural heartbeat if fewer than three qualify.
              for (let batch = 0; batch < 3 && new Set(pool.map((row) => row.evidence.symbol)).size < 6; batch++) {
                const collected = await collect("preflight", qualityActive && batch > 0 ? 0 : offset + 3 * batch).catch((error: unknown) => {
                  if (!(error instanceof Error && error.message === "PAPER_COLLECTION_FAILED") || new Set(pool.map((row) => row.evidence.symbol)).size < 3) throw error;
                  return null; // The failed batch is audited; the selector still rechecks the retained pool at its current freeze time.
                });
                if (!collected) break;
                const { authentic, proof: capturedProof } = collected;
                for (const e of authentic) for (const c of assessPaperContracts(e, now().toISOString(), entryDays, true).contracts) {
                  const proof = capturedProof(e, c, now().toISOString());
                  if (proof) pool.push({ evidence: e, contract_id: c.contract_id, proof });
                }
              }
              return pool;
            } } : {}) });
            // ponytail: one primary batch and one bounded alternative batch; then the original rule rotation, clearly attributed.
            if (selection.kind === "CODEX" && codexCandidateOffset >= (selection.version === "CODEX_PAPER_SELECTION_V2" ? selection.candidates.length : 6)) selection = paperSelectionFallback(selection, "CODEX_CANDIDATES_EXHAUSTED：主选与有限替补未补齐，沿原规则继续研究补位");
            if (paperIndexResearchActive(at) && !reselection && selection.reason.startsWith("CODEX_QUALIFIED_POOL_WAIT")) selection = paperSelectionFallback(selection, `INDEX_RESEARCH_PARTIAL_POOL：${selection.reason}；本轮沿原entry预算分别核验研究位，不额外调用模型`);
            attempt([`${selection.kind}：${selection.reason}`]);
          }
          // An incomplete input pool has not consumed the daily model call; keep the slots available and continue old-plan tracking.
          const waiting = selection?.reason.startsWith("CODEX_QUALIFIED_POOL_WAIT") || reselection && selection?.kind !== "CODEX";
          const batches = selection?.kind === "CODEX" && selection.version === "CODEX_PAPER_SELECTION_V2" ? [codexCandidateOffset, 3].filter((offset, index, values) => offset < selection!.candidates.length && values.indexOf(offset) === index) : [codexCandidateOffset ? 3 : 0];
          for (const offset of waiting ? [] : batches) {
            if (!missing.size) break;
            if (selection?.kind === "CODEX") attempt([CODEX_CANDIDATE_ATTEMPT_REASON]);
            const choices = selection?.kind === "CODEX" ? selection.candidates.slice(offset, offset + 3).filter((row) => !paperIndexResearchActive(at) || (isPaperIndexSymbol(row.symbol) ? missing.has(1) : missing.has(2) || missing.has(3))) : undefined;
            const { authentic, captured, proof: capturedProof } = await collect("entry", selection?.kind === "CODEX" ? 0 : paperCandidateOffset, choices);
            const candidates = selection?.kind === "CODEX" && selection.version === "CODEX_PAPER_SELECTION_V2" ? authentic.filter((e) => {
              const id = selection.candidates.find((row) => row.symbol === e.symbol && row.direction === e.direction)?.contract_id;
              const contract = e.contracts.find((c) => c.contract_id === id);
              return contract && capturedProof(e, contract, now().toISOString());
            }) : authentic;
            for (const ordinal of missing) {
              const { plan, reasons } = buildPaperPlan(candidates.filter((item) => !usedSymbols.has(item.symbol)), now().toISOString(), ordinal, entryDays, selection, reselection);
              if (plan && exchangeDateKey(now()) === day && robinhoodSessionAt(now()).phase === "REGULAR") {
                const eventRisk = paperRiskExit(snapshot, plan, now());
                if (eventRisk) plan.warnings.push(`PAPER_EVENT_RISK：${eventRisk.title}；仅作每日模拟研究`);
                const prior = qualityActive ? active.filter((old) => old.symbol === plan.symbol && old.market_date !== day && Date.parse(old.expires_at) > now().getTime()) : [];
                if (prior.length) plan.warnings.push(`已有未结束观察；本单是独立研究，不是加仓指令；共 ${prior.length} 笔：${prior.slice(0, 3).map((old) => old.plan_id).join("、")}${prior.length > 3 ? "等" : ""}`);
                const proof = captured?.proof(plan, plan.reference, plan.created_at);
                if (!proof) {
                  attempt(["QUOTE_PROOF_MISSING：精确合约与原始报价、请求及接收时间凭据缺失或不匹配；未建立模拟单"], paperIndexResearchActive(at) ? [ordinal] : missing);
                  if (paperIndexResearchActive(at) && ordinal === 1) continue;
                  break;
                }
                plan.reference.proof = proof;
                plan.entry_confirmation = entryConfirmation(plan, plan.created_at);
                plan.formal_forecast_review = forecastReview(plan, plan.created_at);
                plan.next_session_forecast_review = forecastReview(plan, plan.created_at, "NEXT_SESSION_BACKGROUND");
                append(makePaperEvent(plan.plan_id, plan.created_at, "CREATED", { plan })); result.created++;
                usedSymbols.add(plan.symbol); missing.delete(ordinal);
              } else {
                attempt(reasons.length ? reasons : ["NO_REAL_CONTRACT：当日三笔模拟单仍有缺口；继续轮换读取真实合约、当前双边报价和原始方向，不补造样本"], paperIndexResearchActive(at) ? [ordinal] : missing);
                if (paperIndexResearchActive(at) && ordinal === 1) continue;
                break;
              }
            }
          }
        }
      } catch { attempt(["PAPER_COLLECTION_FAILED：本次分析或真实合约读取失败；下次自然检查再试，不补造旧时间"]); }
    }

    const tracked = trackingBatch(active);
    if (!tracked.length) return result;
    result.checked = tracked.length;
    const observed = new Set<string>();
    let accepting = true;
    let sessionStage = "MCP_STARTUP";
    const rpcFailures: string[] = [];
    const diagnostic = (stage: string) => `阶段=${stage}；本会话RPC失败摘要=${rpcFailures.join("|") || "UNCLASSIFIED"}`;
    try {
      await (options.session ?? withRobinhoodMcp)({ projectRoot: options.projectRoot, timeoutMs: 20_000, allowlist: ["get_option_instruments", "get_option_quotes", "get_option_historicals"], onTiming: (event) => {
        // RPCs overlap: this bounded session summary is not attributed to any single contract. Never retain raw errors or arguments.
        if (!accepting || event.event !== "rpc_end" || !["initialize", "thread/start", "mcpServer/tool/call"].includes(event.method ?? "")
          || !["REMOTE_ERROR", "PROVIDER_ERROR", "TIMEOUT", "PROCESS_ERROR", "PROCESS_EXIT", "SESSION_CLOSED"].includes(event.outcome ?? "")
          || (event.method === "mcpServer/tool/call" ? !["get_option_instruments", "get_option_quotes", "get_option_historicals"].includes(event.tool ?? "") : event.tool !== undefined)) return;
        rpcFailures.push(`${event.method}${event.tool ? `/${event.tool}` : ""}:${event.outcome}`);
        if (rpcFailures.length > 4) rpcFailures.shift();
      } }, async (session) => {
        sessionStage = "READ_HISTORY";
        const histories = tracked.map((plan) => options.store.getPaperPlanEvents(plan.plan_id));
        const entries = new Map(histories.flatMap((events) => {
          const prior = events.findLast((event) => event.event_type === "MARK" && event.payload.chart?.entry);
          return prior?.event_type === "MARK" && prior.payload.chart?.entry ? [[prior.plan_id, prior.payload.chart.entry] as const] : [];
        }));
        const rotation = Math.max(0, ...histories.map((events) => events.filter((event) => event.event_type === "MARK" && event.payload.chart).length));
        sessionStage = "READ_CHARTS";
        const charts = await collectPaperCharts(session, tracked, entries, rotation, now);
        if (!accepting) return;
        sessionStage = "READ_QUOTES";
        const captured = capturePaperQuoteEvidence(session, now);
        await Promise.all(tracked.map(async (plan) => {
          let quoteStage = "READ_QUOTE";
          try {
            if (endObservation(plan)) { observed.add(plan.plan_id); return; }
            const quote = await (options.quote ?? collectExternalOptionQuote)(captured.session, { symbol: plan.symbol, expiration: plan.contract.expiration, strike: plan.contract.strike, option_type: plan.contract.option_type });
            if (!accepting) return;
            if (endObservation(plan)) { observed.add(plan.plan_id); return; }
            quoteStage = "VALIDATE_QUOTE";
            const receivedAt = now(), quoteTime = Date.parse(quote?.quoted_at ?? ""), age = receivedAt.getTime() - quoteTime;
            if (!quote || quote.contract_id !== plan.contract.contract_id || !Number.isFinite(age) || age < 0 || age > 120_000
              || quoteTime < Date.parse(plan.created_at) || quote.bid === null || !Number.isFinite(quote.bid) || quote.bid < 0 || quote.ask === null || !Number.isFinite(quote.ask) || quote.ask <= 0 || quote.ask < quote.bid
              || quote.received_at && (!Number.isFinite(Date.parse(quote.received_at)) || Date.parse(quote.received_at) > receivedAt.getTime() || Date.parse(quote.received_at) < at.getTime())) gap(plan.plan_id, "QUOTE_NOT_CURRENT：精确合约报价缺失、过期或身份不一致；盈亏未知，不能视为归零");
            else {
              quoteStage = "ASSESS_MARK";
              const value = paperReturnPct(plan, quote.bid);
              const settled = options.store.getPaperPlanEvents(plan.plan_id).some((event) => event.event_type === "MARK" && paperMarkExitReason(plan, event) !== null);
              const risk = !settled && value < plan.take_profit_pct && value > plan.stop_loss_pct ? paperRiskExit(snapshot, plan, receivedAt) : null;
              const mark = Number.isFinite(quote.mark) && quote.mark >= 0 ? { mark: quote.mark } : {}, proof = captured.proof(plan, { ...quote, bid: quote.bid, ask: quote.ask, ...mark }, receivedAt.toISOString());
              if (!proof) { gap(plan.plan_id, "QUOTE_PROOF_MISSING：精确合约与原始报价、请求及接收时间凭据缺失或不匹配；保留原单，盈亏未知"); observed.add(plan.plan_id); return; }
              const event = makePaperEvent(plan.plan_id, receivedAt.toISOString(), "MARK", { quote: { contract_id: quote.contract_id, symbol: plan.symbol, expiration: plan.contract.expiration, strike: plan.contract.strike, option_type: plan.contract.option_type, bid: quote.bid, ask: quote.ask, quoted_at: quote.quoted_at, source: "ROBINHOOD", ...mark, proof }, estimated_return_pct: value, chart: charts.get(plan.plan_id),
                entry_confirmation: entryConfirmation(plan, receivedAt.toISOString()),
                formal_forecast_review: forecastReview(plan, receivedAt.toISOString()),
                next_session_forecast_review: forecastReview(plan, receivedAt.toISOString(), "NEXT_SESSION_BACKGROUND"),
                ...(risk && quoteTime >= Date.parse(risk.source_observed_at) && (!risk.published_at || quoteTime >= Date.parse(risk.published_at)) ? { risk_exit: risk } : {}),
              });
              quoteStage = "APPEND_MARK";
              append(event);
            }
          } catch { if (accepting) gap(plan.plan_id, `QUOTE_READ_FAILED：精确合约后续报价读取或记录失败；继续保留原单和历史；${diagnostic(quoteStage)}`); }
          observed.add(plan.plan_id);
        }));
      });
    } catch { accepting = false; for (const plan of tracked) if (!observed.has(plan.plan_id)) gap(plan.plan_id, `QUOTE_SESSION_FAILED：只读报价会话失败；未将缺失报价当作归零；${diagnostic(sessionStage)}`); }
    finally { accepting = false; }
    return result;
  };
  return { async runOnce(at = now()): Promise<Result> {
    if (running) return { status: "OVERLAP_REJECTED", created: 0, recorded: 0, checked: 0, ended: 0 };
    if (!Number.isFinite(at.getTime()) || now().getTime() < at.getTime() || now().getTime() - at.getTime() > 120_000) return { status: "NOT_CURRENT", created: 0, recorded: 0, checked: 0, ended: 0 };
    running = true;
    try { return await run(at); } finally { running = false; }
  } };
}
