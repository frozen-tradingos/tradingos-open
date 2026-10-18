import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile, execFileSync } from "node:child_process";
import { publicModelEnvironment } from "./public-runtime.ts";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { openSnapshotDatabase } from "../build/local-data-core.ts";
import { projectScheduleLedgerSupervision } from "../build/local-data-core.ts";
import { CODEX_MANAGER_ACTIONS, CODEX_MANAGER_TRIGGERS, CODEX_PRODUCTION_MANAGER_CONTRACT, type CodexManagerActionKind, type CodexManagerDecision, type CodexManagerOperation, type CodexManagerRunSummary, type CodexManagerSnapshotLevel, type CodexManagerTrigger, type CodexManagerUsage, type CodexRecoveryAttribution } from "../app/codex-production-manager.ts";
import { ROBINHOOD_READONLY_TOOLS, resolveCodexExecutable } from "./robinhood-mcp.ts";
import { runSqliteMaintenance } from "./sqlite-maintenance.ts";

type Store = ReturnType<typeof openSnapshotDatabase>;
type Usage = Omit<CodexManagerUsage, "estimated_cost_usd" | "cost_basis">;
type InvocationResult = { decision: CodexManagerDecision; threadId: string; usage: Usage; agentVersion: string; stderr: string };
type IncidentEscalation = { request_id: string; incident_id: string; fingerprint: string; run_id: string | null; previous_resolution_at: string; requested_at: string; title: string };
export type CodexManagerInvoker = (input: { managerRunId: string; prompt: string; model: string; resumeThreadId: string | null }) => Promise<InvocationResult>;

type ManagerOptions = {
  store: Store;
  dataRoot: string;
  projectRoot: string;
  siteVersion: string;
  runtimeIdentity: { deployedCommit: string; runtimeSha256: string };
  invoke?: CodexManagerInvoker;
  now?: () => Date;
  runReadonlyProbe?: (target: "FINNHUB" | "ROBINHOOD") => Promise<Record<string, unknown>>;
  requestDepartmentRecheck?: (target: "A1" | "A2" | "D" | "TS" | "COMMITTEE" | "A3" | "PLATFORM", reason: string) => Promise<Record<string, unknown>>;
};

const FULL_TOOLS = [
  "read_current_truth", "read_manager_snapshot", "read_health_and_schedule", "read_recent_predictions_and_settlements",
  "read_intraday_regime_and_trigger", "read_incidents_and_complaints", "read_database_and_backup_status",
  "verify_database_integrity", "verify_single_instance", "read_readonly_data_status", "read_ts_evidence_readiness", "read_external_expert_observer", "record_manager_decision", "request_department_recheck",
] as const;
const DAILY_TOOLS = ["read_current_truth", "read_change_since_last_manager_slot", "read_current_incidents_and_open_complaints", "read_recent_natural_evidence", "read_runtime_anomalies", "read_ts_evidence_readiness", "read_external_expert_observer", "read_recent_manager_actions", "read_evidence_on_demand"] as const;
function finiteEnv(name: string, fallback: number, minimum: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function safe(value: unknown) {
  return String(value ?? "").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/([?&](?:token|apikey|api_key|code)=)[^&\s]+/gi, "$1[REDACTED]").slice(0, 4_000);
}
function actionRejected(error: unknown) { return error instanceof Error && "code" in error && error.code === "MANAGER_ACTION_REJECTED"; }
function clipped<T>(values: T[], maximum: number) { return values.slice(0, maximum); }
let timingWrites = Promise.resolve(), pendingTimingWrites = 0;
function managerTiming<T>(options: ManagerOptions, runId: string, phase: string, work: () => T): T {
  const started = performance.now();
  const emit = (boundary: "BEGIN" | "END") => {
    if (process.env.TRADING_OS_RUNTIME_ROLE !== "TIER0") return;
    try {
      // ponytail: bound stalled diagnostic IO to 256 scalar records; a dedicated sink is unnecessary unless traces are dropped.
      if (pendingTimingWrites >= 256) return;
      const wallAt = new Date().toISOString(), directory = resolve(options.dataRoot, "logs");
      const line = `${JSON.stringify({ event: "stage_timing", phase, run_id: runId, pid: process.pid, boundary, wall_at: wallAt, elapsed_ms: performance.now() - started })}\n`;
      pendingTimingWrites++;
      timingWrites = timingWrites.then(async () => { await mkdir(directory, { recursive: true }); await appendFile(resolve(directory, `codex-manager-timing-${wallAt.slice(0, 10)}.jsonl`), line, { encoding: "utf8", mode: 0o600 }); }).catch(() => {}).finally(() => { pendingTimingWrites--; });
    } catch { /* Timing evidence is best effort and must not change Manager outcomes. */ }
  };
  emit("BEGIN");
  try {
    const result = work();
    if (result instanceof Promise) return result.finally(() => emit("END")) as T;
    emit("END"); return result;
  } catch (error) { emit("END"); throw error; }
}
function dateStart(date: Date, days = 0) { const value = new Date(date); value.setUTCDate(value.getUTCDate() - days); value.setUTCHours(0, 0, 0, 0); return value.toISOString(); }
function complaintEvidence(value: unknown) {
  const item = value as Record<string, unknown>;
  return { complaint_id: item.complaint_id, status: item.status, severity: item.severity, problem: item.problem, incident_id: item.incident_id ?? null, incident_status: item.incident_status ?? null, run_id: item.incident_run_id ?? null, created_at: item.created_at };
}

export function candidateSupervision(state: ReturnType<Store["getActive"]>, checkedAt = new Date().toISOString()) {
  const forecasts = state.outputs.TS_SIGNAL_CANDIDATE, settlements = state.outputs.TS_SIGNAL_CANDIDATE_SETTLEMENT;
  const ids = forecasts.map((item) => item.candidate_forecast_id), duplicateForecastIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  const latestOfficialId = state.tsSettlement.recent.find((item) => item.market_date === state.scheduler.today.date && item.eligibility === "OFFICIAL_LIVE" && item.report_type === "INTRADAY_30_60M")?.forecast_run_id ?? null;
  const latestOfficial = state.outputs.TS_SHADOW_OUTPUT.find((item) => item.evidence_snapshot.run_id === latestOfficialId) ?? null;
  const matchingCandidate = forecasts.find((item) => item.official_forecast_run_id === latestOfficial?.evidence_snapshot.run_id) ?? null, latestCandidate = matchingCandidate ?? forecasts[0] ?? null;
  const overdue = forecasts.flatMap((item) => (["30M", "60M"] as const).filter((horizon) => item.contracts.filter((contract) => contract.horizon === horizon).every((contract) => Date.parse(contract.expires_at) <= Date.parse(checkedAt)) && !settlements.some((settlement) => settlement.candidate_forecast_id === item.candidate_forecast_id && (settlement.contract_version === "TS_SIGNAL_CANDIDATE_SETTLEMENT_V1" || settlement.horizon === horizon))).map((horizon) => `${item.candidate_forecast_id}:${horizon}`));
  const stale = forecasts.flatMap((item) => item.contracts.filter((contract) => contract.data_freshness.status !== "LIVE").map((contract) => contract.contract_id));
  const differences = matchingCandidate && latestOfficial ? matchingCandidate.contracts.map((contract) => ({ symbol: contract.symbol, horizon: contract.horizon, candidate: contract.forecast_layer.direction, official: latestOfficial.symbol_outlooks[contract.symbol].direction, differs: contract.forecast_layer.direction !== latestOfficial.symbol_outlooks[contract.symbol].direction })) : [];
  const findings = [...(!latestOfficial || matchingCandidate ? [] : ["LATEST_INTRADAY_CANDIDATE_MISSING"]), ...(duplicateForecastIds.length ? ["DUPLICATE_CANDIDATE_FORECAST_ID"] : []), ...(overdue.length ? ["CANDIDATE_SETTLEMENT_OVERDUE"] : []), ...(stale.length ? ["CANDIDATE_BAR_STALE"] : [])];
  return { checked_at: checkedAt, status: findings.length ? "DEGRADED" as const : "PASS" as const, validation_status: "TS_SIGNAL_CANDIDATE_UNVALIDATED", forecast_count: forecasts.length, settlement_count: settlements.length, latest_candidate_forecast_id: latestCandidate?.candidate_forecast_id ?? null, frozen: Boolean(latestCandidate), delivered_to_research_inventory: Boolean(latestCandidate), duplicate_forecast_ids: duplicateForecastIds, overdue_settlements: overdue, stale_contracts: stale, differences, findings };
}

export function scheduleLedgerSupervision(store: Store, checkedAt = new Date().toISOString()) {
  return projectScheduleLedgerSupervision(store, store.getActive(), checkedAt);
}

async function singleInstanceEvidence() {
  try {
    const { stdout } = await promisify(execFile)("netstat.exe", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    const rows = stdout.split(/\r?\n/)
      .filter((line) => /\sLISTENING\s/i.test(line) && /[:.]4070\s/.test(line.trim().replace(/\s+/g, " ")))
      .map((line) => line.trim().split(/\s+/).at(-1)).filter(Boolean);
    return { listener_count: new Set(rows).size, pids: [...new Set(rows)], status: new Set(rows).size === 1 ? "PASS" : "BLOCKED" };
  } catch (error) { return { listener_count: null, pids: [], status: "NOT_OBSERVED", error: safe(error) }; }
}

async function fullManagerTools(options: ManagerOptions, managerRunId: string, ownerContext: string | null, escalations: IncidentEscalation[] = []) {
  const db = await managerTiming(options, managerRunId, "databaseEvidence", () => runSqliteMaintenance({ kind: "evidence", file: options.store.file, dataRoot: options.dataRoot }));
  const single = await managerTiming(options, managerRunId, "netstat", singleInstanceEvidence);
  const state = await managerTiming(options, managerRunId, "getActive", () => options.store.getActiveAsync());
  const trigger = (item: (typeof state.ownerTrigger.recent)[number] | null) => item ? {
    event_id: item.event_id, idea_id: item.idea_id, forecast_run_id: item.forecast_run_id, symbol: item.symbol, forecast_slot: item.forecast_slot,
    original_probability_pct: item.original_probability_pct, old_state: item.old_state, new_state: item.new_state, changed_at: item.changed_at,
    data_timestamp: item.data_timestamp, source_mode: item.source_mode, replay: item.replay, structure: item.structure, key_zone: item.key_zone,
    current_price: item.current_price, target_range: item.target_range, remaining_space: item.remaining_space, state_reason: item.state_reason,
    invalidation_reason: item.invalidation_reason, owner_action: item.owner_action, is_tradeable: item.is_tradeable, risk_blockers: item.risk_blockers,
  } : null;
  const incident = (item: (typeof state.selfCheck.recent)[number]) => ({ incident_id: item.incident_id, fingerprint: item.fingerprint, layer: item.layer, code: item.code, severity: item.severity, status: item.status, title: item.title, first_detected_at: item.first_detected_at, last_seen_at: item.last_seen_at, resolved_at: item.resolved_at, run_id: item.run_id, occurrences: item.occurrences, suggestion: item.suggestion, details: item.details });
  const guard = {
    timeline_codex_guard: "DETERMINISTIC_SQLITE_HEALTH_CHECK",
    live_shadow_codex_guard: "REAL_CODEX_CLI_MODEL_CALL_INSIDE_CODEX_AGENT_RUNTIME",
    pre_a3_1a_owner_manager: "DETERMINISTIC_TYPESCRIPT_RULE_ENGINE",
    a3_1a_production_manager: "REAL_CODEX_EXEC_READONLY_SHADOW",
  };
  return {
    read_current_truth: state.currentTruth ?? null,
    read_manager_snapshot: {
      manager_run_id: managerRunId, captured_at: new Date().toISOString(), runtime: options.runtimeIdentity, site_version: options.siteVersion,
      guard_capability_audit: guard, owner_queue: state.ownerQueue,
      startup_recovery: state.codexManager?.startup_recovery ?? options.store.getCodexManagerState().startup_recovery,
      investment_kernel: {
        profile: { id: state.investmentKernel.profile_id, mode: state.investmentKernel.profile_mode, status: state.investmentKernel.status },
        constitution: state.investmentKernel.constitution,
        strategy_packs: state.investmentKernel.active_strategy_packs,
      },
      spx: { active_watches: state.spxwProxy.watches.filter((item) => item.status === "OBSERVING").length, ended_watches: state.spxwProxy.watches.filter((item) => item.status === "ENDED").length, spot_status: state.spxwProxy.spx_spot_status, data_mode: state.spxConvexity.data_mode, active_opportunity: state.spxConvexity.current?.opportunity_id ?? null, broker_profit_or_loss_events: state.spxConvexity.statistics.broker_profit_or_loss_events },
      research_context: ownerContext ? { source: "OWNER_TRIGGER_CONTEXT", text: ownerContext.slice(0, 8_000) } : null,
    },
    read_health_and_schedule: {
      self_check: { status: state.selfCheck.status, checked_at: state.selfCheck.checked_at, last_backup_at: state.selfCheck.last_backup_at, active: state.selfCheck.active.map(incident), recent: clipped(state.selfCheck.recent, 8).map(incident) },
      data_sources: state.dataSources,
      scheduler: { timezone: state.scheduler.timezone, checked_at: state.scheduler.checked_at, next_run: state.scheduler.next_run, today: state.scheduler.today, health_window: state.scheduler.health_window, groups: state.scheduler.groups, recent: clipped(state.scheduler.recent, 15).map((item) => ({ slot_id: item.slot_id, kind: item.kind, label: item.label, scheduled_at: item.scheduled_at, completed_at: item.completed_at, status: item.status, reason: item.reason })) },
    },
    read_recent_predictions_and_settlements: {
      trusted: state.tsSettlement.trusted, operational_delivery: state.tsSettlement.delivery, settlement_coverage: state.tsSettlement.coverage,
      recent: clipped(state.tsSettlement.recent, 12).map((item) => ({
        forecast_run_id: item.forecast_run_id, published_at: item.published_at, market_date: item.market_date, slot: item.slot, phase: item.phase, report_type: item.report_type, source_mode: item.source_mode, eligibility: item.eligibility, path_bias: item.path_bias, scoring_contract: item.scoring_contract, forecast_identity: item.forecast_identity,
        settlement: item.settlement ? { contract_version: item.settlement.contract_version, settled_at: item.settlement.settled_at, status: item.settlement.status, source: item.settlement.source, observation_window: item.settlement.observation_window, actual_scenario: item.settlement.actual_scenario, brier_score: item.settlement.brier_score, path_result: item.settlement.path_result, timing_result: item.settlement.timing_result, pattern_result: item.settlement.pattern_result, amplitude_result: item.settlement.amplitude_result, tradeability_result: item.settlement.tradeability_result, symbols: Object.fromEntries(Object.entries(item.settlement.symbols).map(([symbol, value]) => [symbol, { forecast_direction: value.forecast_direction, actual_direction: value.actual_direction, direction_correct: value.direction_correct, start_price: value.start_price, end_price: value.end_price, return_pct: value.return_pct, actual_low: value.actual_low, actual_high: value.actual_high, range_status: value.range_result.status }])) } : null,
      })),
      ts_outputs: clipped(state.outputs.TS_SHADOW_OUTPUT, 6).map((item) => ({ run_id: item.evidence_snapshot.run_id, observed_at: item.evidence_snapshot.market_time.observed_at, market_date: item.evidence_snapshot.market_time.market_date, report_type: item.report_type, path_bias: item.path_bias, tradeability: item.tradeability.status, one_line_forecast: item.one_line_forecast })),
      candidate_supervision: candidateSupervision(state),
      schedule_ledger_supervision: await managerTiming(options, managerRunId, "scheduleLedgerSupervision", () => options.store.getScheduleLedgerSupervisionAsync()),
    },
    read_intraday_regime_and_trigger: {
      intraday_regime: state.intradayRegime ?? null,
      owner_trigger: { current: { SPY: trigger(state.ownerTrigger.current.SPY), QQQ: trigger(state.ownerTrigger.current.QQQ) }, recent: clipped(state.ownerTrigger.recent, 8).map(trigger) },
      option_signals: clipped(state.outputs.OPTION_STRATEGY_SIGNAL, 5).map((item) => ({ signal_id: item.signal_id, source_mode: item.source_mode, source_run_id: item.source_run_id, slot_id: item.slot_id, observed_at: item.observed_at, data_cutoff_at: item.data_cutoff_at, d_action: item.d_action, a3_decision: item.a3_decision, owner_action: item.owner_action, selected_candidate_id: item.selected_candidate_id, best_candidate_id: item.best_candidate_id, candidate_count: item.candidates.length, change_summary: item.change_summary, risk_summary: item.risk_summary, data_gaps: item.data_gaps })),
      position_states: clipped(state.outputs.POSITION_COPILOT_STATE, 5).map((item) => ({ state_id: item.state_id, source_mode: item.source_mode, source_run_id: item.source_run_id, slot_id: item.slot_id, observed_at: item.observed_at, ts_run_id: item.ts_run_id, holding_count: item.holdings.length, actions: item.holdings.map((holding) => ({ holding_id: holding.holding_id, owner_action: holding.owner_action, symbol: holding.symbol })), change_summary: item.change_summary, data_gaps: item.data_gaps })),
    },
    read_incidents_and_complaints: { incident_scope: "RAW_INCIDENT_RECORDS_INCLUDING_HISTORICAL", current_issue_authority: "read_current_truth.issues.lifecycle", complaint_scope: "ALL_RECORDED_COMPLAINTS_RECENT_20", active: clipped(state.selfCheck.active, 20).map(incident), recent: clipped(state.selfCheck.recent, 10).map(incident), complaints: clipped(managerTiming(options, managerRunId, "listComplaints", () => options.store.listComplaints()).filter(Boolean), 20).map(complaintEvidence), owner_queue: state.ownerQueue, escalations },
    read_database_and_backup_status: { database_path: db.database_path, size_bytes: db.size_bytes, counts: db.counts, latest_backup: db.latest_backup },
    verify_database_integrity: { quick_check: db.quick_check, integrity_check: db.integrity_check },
    verify_single_instance: single,
    read_readonly_data_status: { mode: "PERSISTED_LAST_PROBE", sources: state.dataSources, robinhood_allowlist: ROBINHOOD_READONLY_TOOLS, automated_execution: false, broker_write_tools: 0, broker_write_calls: 0 },
    read_ts_evidence_readiness: state.codexManager?.ts_readiness ?? options.store.getCodexManagerState().ts_readiness,
    read_external_expert_observer: { ...state.externalExpert, cases: clipped(state.externalExpert.cases, 12).map((item) => ({ case_id: item.case_id, status: item.status, realtime_class: item.realtime_class, source: item.source, symbol: item.symbol, direction: item.direction, instrument: item.instrument, wait_classification: item.wait_classification, conclusion: item.conclusion, signal_outcome: item.signal_outcome, ts_comparable: item.ts_comparable, updated_at: item.updated_at, event_count: item.events.length })) },
  };
}

async function dailyManagerTools(options: ManagerOptions, managerRunId: string, ownerContext: string | null) {
  const db = await managerTiming(options, managerRunId, "databaseEvidence", () => runSqliteMaintenance({ kind: "evidence", file: options.store.file, dataRoot: options.dataRoot }));
  const single = await managerTiming(options, managerRunId, "netstat", singleInstanceEvidence);
  const state = await managerTiming(options, managerRunId, "getActive", () => options.store.getActiveAsync()), manager = managerTiming(options, managerRunId, "getManagerState", () => options.store.getCodexManagerState());
  const bootAt = manager.startup_recovery?.start_reason === "WINDOWS_STARTUP" ? manager.startup_recovery.windows_boot_at : null;
  const suspiciousCatchup = bootAt ? state.scheduler.recent.filter((item) => item.completed_at && Date.parse(item.completed_at) >= Date.parse(bootAt) && Date.parse(item.scheduled_at) < Date.parse(bootAt) && item.status === "SUCCEEDED") : [];
  const complaints = managerTiming(options, managerRunId, "listComplaints", () => options.store.listComplaints()).filter((item) => item && ["NEW", "INVESTIGATING", "PENDING_OWNER_APPROVAL"].includes(String((item as unknown as Record<string, unknown>).status))).map(complaintEvidence);
  const current = state.currentTruth ?? null;
  const prior = options.store.getLatestCodexManagerEvent("MANAGER_CHECKPOINT")?.checkpoint as Record<string, unknown> | undefined;
  const currentDigest = {
    natural_slot: current?.natural_slot ?? null,
    departments: current?.departments ?? [],
    data_sources: current?.data_sources ?? [],
    intraday_regime: current?.intraday_regime ?? null,
    spx_option: current?.spx_option ?? null,
    issues: current?.issues ?? null,
    owner_queue: current?.owner_queue ?? null,
    external_expert: { case_count: state.externalExpert.case_count, open_count: state.externalExpert.open_count, latest_case: state.externalExpert.cases[0]?.case_id ?? null, latest_updated_at: state.externalExpert.cases[0]?.updated_at ?? null },
  };
  const previousDigest = prior?.truth as Record<string, unknown> | undefined;
  const changedFields = Object.keys(currentDigest).filter((field) => hash(previousDigest?.[field] ?? null) !== hash(currentDigest[field as keyof typeof currentDigest]));
  const incident = (item: (typeof state.selfCheck.recent)[number]) => ({ incident_id: item.incident_id, fingerprint: item.fingerprint, code: item.code, severity: item.severity, status: item.status, title: item.title, last_seen_at: item.last_seen_at, run_id: item.run_id, complaint_id: item.complaint_id });
  const dailyTsCore = managerTiming(options, managerRunId, "getTsCoreDailySummary", () => options.store.getTsCoreDailySummary(state.scheduler.today.date || current?.trading_date || new Date().toISOString().slice(0, 10)));
  return {
    schedule_ledger_supervision: await managerTiming(options, managerRunId, "scheduleLedgerSupervision", () => options.store.getScheduleLedgerSupervisionAsync()),
    read_current_truth: currentDigest,
    read_change_since_last_manager_slot: { checkpoint_id: prior?.checkpoint_id ?? null, changed: changedFields.length > 0, changed_fields: changedFields.map((field) => ({ field, previous_sha256: hash(previousDigest?.[field] ?? null), current: currentDigest[field as keyof typeof currentDigest] })), previous_sha256: previousDigest ? hash(previousDigest) : null, current_sha256: hash(currentDigest) },
    read_current_incidents_and_open_complaints: { incident_scope: "RAW_INCIDENT_RECORDS_INCLUDING_HISTORICAL", current_issue_authority: "read_current_truth.issues.lifecycle", complaint_scope: "ALL_RECORDED_OPEN_COMPLAINTS", incidents: state.selfCheck.active.map(incident), complaints, owner_queue: state.ownerQueue },
    read_recent_natural_evidence: {
      ts_core_daily_authority: dailyTsCore,
      candidate_supervision: candidateSupervision(state),
      regime: state.intradayRegime?.current ?? null,
      trigger: { SPY: state.ownerTrigger.current.SPY ?? null, QQQ: state.ownerTrigger.current.QQQ ?? null },
    },
    read_runtime_anomalies: {
      database: { quick_check: db.quick_check, integrity_check: db.integrity_check, latest_backup: db.latest_backup }, single_instance: single,
      data_sources: state.dataSources.filter((item) => item.status !== "LIVE"), next_run: state.scheduler.next_run,
      runtime: options.runtimeIdentity, owner_context: ownerContext ? ownerContext.slice(0, 1_500) : null,
      startup_recovery: manager.startup_recovery,
      startup_backfill_audit: { windows_boot_at: bootAt, suspicious_succeeded_slots: suspiciousCatchup.map((item) => ({ slot_id: item.slot_id, scheduled_at: item.scheduled_at, completed_at: item.completed_at, status: item.status })) },
      broker_boundary: { robinhood_allowlist: ROBINHOOD_READONLY_TOOLS, automated_execution: false, broker_write_tools: 0, broker_write_calls: 0 },
    },
    read_ts_evidence_readiness: manager.ts_readiness,
    read_external_expert_observer: { contract_version: state.externalExpert.contract_version, source_mode: state.externalExpert.source_mode, statistical_eligibility: state.externalExpert.statistical_eligibility, case_count: state.externalExpert.case_count, open_count: state.externalExpert.open_count, realtime: state.externalExpert.realtime, wait_classifications: state.externalExpert.wait_classifications, conclusions: state.externalExpert.conclusions, outcomes: state.externalExpert.outcomes, ts_comparable_count: state.externalExpert.ts_comparable_count, recent: clipped(state.externalExpert.cases, 5).map((item) => ({ case_id: item.case_id, status: item.status, realtime_class: item.realtime_class, wait_classification: item.wait_classification, conclusion: item.conclusion, updated_at: item.updated_at })) },
    read_recent_manager_actions: { current_task: manager.current_task, operations: clipped(manager.recent_operations, 5), recovery_attributions: clipped(manager.recovery_attributions, 3) },
    read_evidence_on_demand: { action: "REQUEST_FULL_AUDIT", result: "另起一次受预算和去重限制的FULL_AUDIT，不在当前日常输入中塞入旧日志" },
  };
}

function validateDecision(value: unknown, managerRunId: string): CodexManagerDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex manager returned no decision object");
  const decision = value as CodexManagerDecision;
  if (decision.contract_version !== CODEX_PRODUCTION_MANAGER_CONTRACT || decision.manager_run_id !== managerRunId || !["HEALTHY", "DEGRADED", "BLOCKED"].includes(decision.status) || !Array.isArray(decision.findings) || !Array.isArray(decision.recheck_requests) || !Array.isArray(decision.requested_actions)) throw new Error("Codex manager decision identity is invalid");
  if (!/[\u3400-\u9fff]/u.test(decision.manager_conclusion) || decision.executive_summary.some((item) => !/[\u3400-\u9fff]/u.test(item))) throw new Error("Codex经理必须使用中文业务表达");
  return decision;
}

function defaultInvoker(options: ManagerOptions, timeoutMs: number): CodexManagerInvoker {
  const executable = resolveCodexExecutable(options.projectRoot), workspace = resolve(options.dataRoot, "codex-manager", "workspace"), schema = resolve(options.projectRoot, "contracts", "v1", "codex-production-manager.schema.json"), instructions = resolve(options.projectRoot, "app", "codex-production-manager-instructions.md");
  mkdirSync(workspace, { recursive: true });
  const agentVersion = execFileSync(executable, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim();
  return ({ managerRunId, prompt, model, resumeThreadId }) => new Promise((accept, reject) => {
    const output = resolve(options.dataRoot, "codex-manager", `${managerRunId.replaceAll(":", "-")}.json`);
    const common = ["--ignore-user-config", "--ignore-rules", "-c", 'cli_auth_credentials_store="file"', "-c", 'mcp_oauth_credentials_store="file"', "--disable", "plugins", "--disable", "apps", "--skip-git-repo-check", "--output-schema", schema, "-o", output, "--json", "-m", model, "-"];
    const args = resumeThreadId ? ["exec", "resume", resumeThreadId, ...common] : ["exec", "--sandbox", "read-only", "-C", workspace, ...common];
    const env = publicModelEnvironment(options.projectRoot);
    const child = spawn(executable, args, { cwd: workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < 4_000_000) stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 100_000) stderr += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (expired) throw new Error("Codex manager timed out");
        if (code !== 0) throw new Error(`Codex manager exited ${code}: ${safe(`${stderr}\n${stdout.slice(-8_000)}`)}`);
        const events = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
        const threadId = String(events.find((item) => item.type === "thread.started")?.thread_id ?? resumeThreadId ?? "");
        const usageEvent = events.findLast((item) => item.type === "turn.completed")?.usage as Record<string, unknown> | undefined;
        if (!threadId || !usageEvent || !existsSync(output)) throw new Error("Codex manager JSONL evidence is incomplete");
        const usage: Usage = { input_tokens: Number(usageEvent.input_tokens ?? 0), cached_input_tokens: Number(usageEvent.cached_input_tokens ?? 0), output_tokens: Number(usageEvent.output_tokens ?? 0), reasoning_output_tokens: Number(usageEvent.reasoning_output_tokens ?? 0) };
        const decision = validateDecision(JSON.parse(readFileSync(output, "utf8")), managerRunId);
        unlinkSync(output);
        accept({ decision, threadId, usage, agentVersion, stderr: safe(stderr) });
      } catch (error) { if (existsSync(output)) unlinkSync(output); reject(error); }
    });
    child.stdin.end(`${readFileSync(instructions, "utf8")}\n\nIMMUTABLE_PRODUCTION_SNAPSHOT:\n${prompt}\n`);
  });
}

export function createCodexProductionManager(options: ManagerOptions) {
  const now = options.now ?? (() => new Date()), model = process.env.CODEX_MANAGER_MODEL ?? "gpt-5.6-terra";
  const dailyCalls = finiteEnv("CODEX_MANAGER_DAILY_CALL_LIMIT", 8, 1), weeklyCalls = finiteEnv("CODEX_MANAGER_WEEKLY_CALL_LIMIT", 40, 1);
  const dailyCost = finiteEnv("CODEX_MANAGER_DAILY_ESTIMATED_COST_USD", 2, 0.01), weeklyCost = finiteEnv("CODEX_MANAGER_WEEKLY_ESTIMATED_COST_USD", 10, 0.01);
  const price = { input: finiteEnv("CODEX_MANAGER_INPUT_USD_PER_MTOK", 2, 0), cached: finiteEnv("CODEX_MANAGER_CACHED_INPUT_USD_PER_MTOK", 0.2, 0), output: finiteEnv("CODEX_MANAGER_OUTPUT_USD_PER_MTOK", 12, 0) };
  const invoke = options.invoke;
  let active: Promise<CodexManagerRunSummary> | null = null;
  let activeCommandId: string | null = null;
  let queuedCommand: CodexManagerRunSummary | null = null;
  let commandTimer: NodeJS.Timeout | null = null;
  let activeLevel: CodexManagerSnapshotLevel | null = null;
  let pendingFullAudit: string | null = null;
  let pendingTimer: NodeJS.Timeout | null = null;
  let stopping = false;
  const pendingIncidents = new Map((options.store.getPendingCodexIncidentEscalations() as IncidentEscalation[]).map((request) => [request.request_id, request]));

  function incidentReceipt(request: IncidentEscalation, status: string, managerRunId: string | null, snapshotId: string | null = null) {
    const terminal = status === "ANALYZED" || status === "NO_LONGER_CURRENT";
    const receipt = { ...request, status, manager_run_id: managerRunId, snapshot_id: snapshotId, recorded_at: now().toISOString(), maintenance_completed: false };
    options.store.recordCodexManagerEvent({ event_id: `${request.request_id}:${terminal ? "final" : hash(managerRunId).slice(0, 16)}`, manager_run_id: "incident-escalation-ledger", event_type: "INCIDENT_ESCALATION_RECEIPT", recorded_at: receipt.recorded_at, snapshot_id: snapshotId, payload: { receipt } });
    if (terminal) pendingIncidents.delete(request.request_id);
  }

  function currentIncidentEvidence() {
    // Reuse the existing resolution history so dedup never masks a genuinely reopened fault.
    const resolutions = new Map(options.store.listComplaints().filter((item) => item !== null).map((item) => [String((item as Record<string, unknown>).complaint_id), String(item.history.findLast((row) => row.status === "SHADOW_FIXED" || row.status === "CLOSED")?.recorded_at ?? "")]));
    return options.store.getSelfCheck().active.map((incident) => ({ ...incident, previous_resolution_at: resolutions.get(incident.complaint_id) ?? "" }));
  }

  function currentIncidentRequests() {
    if (!pendingIncidents.size) return [];
    const current = currentIncidentEvidence();
    for (const request of pendingIncidents.values()) if (!current.some((incident) => incident.incident_id === request.incident_id && incident.fingerprint === request.fingerprint && incident.previous_resolution_at === request.previous_resolution_at && incident.severity === "CRITICAL" && incident.details.evidence_scope !== "HISTORICAL")) incidentReceipt(request, "NO_LONGER_CURRENT", null);
    return [...pendingIncidents.values()];
  }

  function rememberIncidentEscalation(context: string | null) {
    let input: { source?: string; findings?: Array<{ fingerprint?: string; incident_id?: string }> };
    try { input = JSON.parse(context ?? "null"); } catch { return false; }
    if (input?.source !== "INCIDENT_GUARD" || !Array.isArray(input.findings)) return false;
    const current = currentIncidentEvidence();
    for (const finding of input.findings) {
      const incident = current.find((item) => item.fingerprint === finding?.fingerprint || item.incident_id === finding?.incident_id);
      if (!incident || incident.severity !== "CRITICAL" || incident.details.evidence_scope === "HISTORICAL") continue;
      const requestId = `incident-escalation:${hash([incident.incident_id, incident.fingerprint, incident.previous_resolution_at]).slice(0, 32)}`;
      if (pendingIncidents.has(requestId) || options.store.getCodexManagerEvent(`${requestId}:final`)) continue;
      const request: IncidentEscalation = { request_id: requestId, incident_id: incident.incident_id, fingerprint: incident.fingerprint, run_id: incident.run_id, previous_resolution_at: incident.previous_resolution_at, requested_at: now().toISOString(), title: incident.title };
      options.store.recordCodexManagerEvent({ event_id: `${requestId}:requested`, manager_run_id: "incident-escalation-ledger", event_type: "INCIDENT_ESCALATION_REQUESTED", recorded_at: request.requested_at, payload: { request } });
      pendingIncidents.set(requestId, request);
    }
    return true;
  }

  function recordOperation(operation: CodexManagerOperation) {
    options.store.recordCodexManagerEvent({ event_id: `${operation.operation_id}:${operation.status.toLowerCase()}`, manager_run_id: operation.operation_id, event_type: "OPERATION_RECORDED", recorded_at: operation.completed_at ?? operation.started_at, payload: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, operation } });
    return operation;
  }

  async function executeAction(input: { manager_run_id: string; action: CodexManagerActionKind; target: string; reason: string; evidence_refs: string[]; idempotency_key?: string }) {
    if (!input || !CODEX_MANAGER_ACTIONS.includes(input.action) || typeof input.target !== "string" || !input.target.trim() || input.target.length > 200 || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 600 || !Array.isArray(input.evidence_refs) || !input.evidence_refs.length || input.evidence_refs.length > 8 || input.evidence_refs.some((ref) => typeof ref !== "string" || !ref.trim() || ref.length > 400)) throw Object.assign(new Error("Codex经理动作输入无效"), { code: "MANAGER_ACTION_REJECTED" });
    const managerState = options.store.getCodexManagerState(), idempotency = hash(input.idempotency_key ?? { manager_run_id: input.manager_run_id, action: input.action, target: input.target, reason: input.reason, evidence_refs: input.evidence_refs }), sameEvidence = (operation: CodexManagerOperation) => input.evidence_refs.every((reference, index) => operation.evidence_refs[index] === reference), incidentAction = ["OPEN_INCIDENT", "UPDATE_INCIDENT", "CLOSE_INCIDENT"].includes(input.action);
    const semantic = managerState.recent_operations.find((operation) => operation.action === input.action && operation.target === input.target && operation.summary === input.reason && operation.status === "SUCCEEDED" && sameEvidence(operation) && (incidentAction || operation.idempotency_key === idempotency));
    const incident = incidentAction ? options.store.getSelfCheck().recent.find((item) => item.fingerprint === input.target || item.incident_id === input.target) : null;
    if (semantic && (input.action === "OPEN_INCIDENT" ? incident?.status === "ACTIVE" : input.action === "CLOSE_INCIDENT" ? incident?.status === "RESOLVED" : input.action === "UPDATE_INCIDENT" ? incident?.status === "ACTIVE" : true)) return semantic;
    const attempt = managerState.recent_operations.filter((operation) => operation.idempotency_key === idempotency).length, operationId = `manager-operation:${idempotency.slice(0, 32)}${attempt ? `:retry${attempt}` : ""}`;
    const startedAt = now().toISOString(), risk = ["OPEN_INCIDENT", "UPDATE_INCIDENT", "CLOSE_INCIDENT"].includes(input.action) ? "LOW_RISK" as const : "READONLY" as const;
    recordOperation({ operation_id: operationId, idempotency_key: idempotency, action: input.action, risk, status: "STARTED", actor: "CODEX", target: input.target, summary: input.reason, incident_id: null, started_at: startedAt, completed_at: null, commit: null, pr: null, rollback_ref: null, evidence_refs: input.evidence_refs });
    try {
      let incidentId: string | null = null, actionEvidence: unknown = null;
      if (["OPEN_INCIDENT", "UPDATE_INCIDENT", "CLOSE_INCIDENT"].includes(input.action)) {
        const incident = options.store.manageManagerIncident({ action: input.action as "OPEN_INCIDENT" | "UPDATE_INCIDENT" | "CLOSE_INCIDENT", fingerprint: input.target, title: input.reason, reason: input.reason, evidence_refs: input.evidence_refs, run_id: input.manager_run_id, recorded_at: now().toISOString() });
        incidentId = incident?.incident_id ?? null;
      } else if (input.action === "RUN_READONLY_DATA_PROBE") {
        if (input.target !== "FINNHUB" && input.target !== "ROBINHOOD") throw Object.assign(new Error("只读探针仅支持FINNHUB或ROBINHOOD"), { code: "MANAGER_ACTION_REJECTED" });
        if (!options.runReadonlyProbe) throw new Error("生产只读探针未配置");
        actionEvidence = await options.runReadonlyProbe(input.target);
      } else if (input.action === "REQUEST_FULL_AUDIT") {
        if (input.target !== "FULL_AUDIT" || activeLevel === "FULL_AUDIT") throw Object.assign(new Error("完整审计目标必须为FULL_AUDIT，且FULL_AUDIT不得递归请求FULL_AUDIT"), { code: "MANAGER_ACTION_REJECTED" });
        if (active) pendingFullAudit = input.reason;
        else {
          pendingTimer = setTimeout(() => { pendingTimer = null; void run("INCIDENT_ESCALATION", input.reason, false).catch(() => undefined); }, 0);
          pendingTimer.unref();
        }
        actionEvidence = { status: "QUEUED", trigger: "INCIDENT_ESCALATION" };
      } else {
        if (!new Set(["A1", "A2", "D", "TS", "COMMITTEE", "A3", "PLATFORM"]).has(input.target)) throw Object.assign(new Error("部门复核目标无效"), { code: "MANAGER_ACTION_REJECTED" });
        if (!options.requestDepartmentRecheck) throw new Error("生产部门复核执行器未配置");
        actionEvidence = await options.requestDepartmentRecheck(input.target as "A1" | "A2" | "D" | "TS" | "COMMITTEE" | "A3" | "PLATFORM", input.reason);
      }
      return recordOperation({ operation_id: operationId, idempotency_key: idempotency, action: input.action, risk, status: "SUCCEEDED", actor: "CODEX", target: input.target, summary: input.reason, incident_id: incidentId, started_at: startedAt, completed_at: now().toISOString(), commit: null, pr: null, rollback_ref: null, evidence_refs: [...input.evidence_refs, ...(actionEvidence ? [`probe:${hash(actionEvidence)}`] : [])] });
    } catch (error) {
      recordOperation({ operation_id: operationId, idempotency_key: idempotency, action: input.action, risk, status: actionRejected(error) ? "GATE_BLOCKED" : "FAILED", actor: "CODEX", target: input.target, summary: safe(error), incident_id: null, started_at: startedAt, completed_at: now().toISOString(), commit: null, pr: null, rollback_ref: null, evidence_refs: input.evidence_refs });
      throw error;
    }
  }

  function recordPrivilegedOperation(operation: CodexManagerOperation) {
    const allowed = ["RESTART_READONLY_ADAPTER", "RESTART_OWNER_SERVICE", "CREATE_WORKTREE", "EDIT_CODE", "RUN_TESTS", "CREATE_PR", "CREATE_SQLITE_BACKUP", "LOW_RISK_REPAIR", "INDEPENDENT_REVIEW", "CANARY_4071", "DEPLOY_4070", "ROLLBACK_4070"];
    if (!operation || !/^[a-zA-Z0-9:._-]{8,160}$/.test(operation.operation_id) || !allowed.includes(operation.action) || !["STARTED", "SUCCEEDED", "FAILED", "SKIPPED_DUPLICATE", "GATE_BLOCKED"].includes(operation.status) || !operation.target?.trim() || !operation.summary?.trim() || !Array.isArray(operation.evidence_refs) || !operation.evidence_refs.length) throw new Error("受控生产动作审计无效");
    if (["EDIT_CODE", "RUN_TESTS", "CREATE_PR", "INDEPENDENT_REVIEW", "CANARY_4071", "DEPLOY_4070"].includes(operation.action) && !/^[0-9a-f]{40}$/i.test(operation.commit ?? "")) throw new Error("受控代码动作缺少可解析commit");
    if (["RUN_TESTS", "CREATE_PR", "INDEPENDENT_REVIEW", "CANARY_4071", "DEPLOY_4070"].includes(operation.action) && (!Number.isInteger(operation.pr) || (operation.pr ?? 0) < 1)) throw new Error("受控发布动作缺少PR身份");
    if (operation.action === "CREATE_SQLITE_BACKUP" && operation.status === "SUCCEEDED") {
      const backup = resolve(operation.rollback_ref ?? ""), backupRoot = resolve(options.dataRoot, "backups"), outside = relative(backupRoot, backup);
      if (!operation.rollback_ref || outside.startsWith("..") || isAbsolute(outside) || !existsSync(backup)) throw new Error("SQLite备份不在正式backups目录或不存在");
      const sha = createHash("sha256").update(readFileSync(backup)).digest("hex");
      if (!operation.evidence_refs.includes(`sha256:${sha}`)) throw new Error("SQLite备份SHA-256不匹配");
    }
    if (operation.action === "DEPLOY_4070" && operation.status === "SUCCEEDED") {
      const candidate = operation.evidence_refs.find((item) => /^candidate:[0-9a-f]{40}$/i.test(item))?.slice(10), operations = options.store.getCodexManagerState().recent_operations;
      const passed = (action: CodexManagerOperation["action"], predicate: (item: CodexManagerOperation) => boolean = () => true) => operations.some((item) => item.action === action && item.status === "SUCCEEDED" && item.pr === operation.pr && item.commit === candidate && predicate(item));
      const backupPassed = operations.some((item) => item.action === "CREATE_SQLITE_BACKUP" && item.status === "SUCCEEDED" && item.rollback_ref === operation.rollback_ref);
      if (operation.risk !== "RELEASE" || !candidate || !operation.rollback_ref || !passed("CREATE_PR") || !passed("RUN_TESTS", (item) => item.evidence_refs.includes("gate:tests-pass")) || !passed("INDEPENDENT_REVIEW", (item) => item.evidence_refs.some((ref) => ref.startsWith("review:APPROVED"))) || !passed("CANARY_4071", (item) => item.evidence_refs.includes("canary:pass")) || !backupPassed) throw new Error("4070部署未通过同PR候选的测试、独立Reviewer、SQLite备份和4071 Canary确定性闸门");
    }
    if (operation.actor === "CODEX" && operation.action === "ROLLBACK_4070" && !operation.rollback_ref) throw new Error("回滚动作缺少回滚点");
    const prior = options.store.getCodexManagerEvent(`${operation.operation_id}:${operation.status.toLowerCase()}`)?.payload.operation as CodexManagerOperation | undefined;
    if (prior) return prior;
    return recordOperation(operation);
  }

  function recordRecoveryAttribution(attribution: CodexRecoveryAttribution) {
    if (!/^[a-zA-Z0-9:._-]{8,160}$/.test(attribution.attribution_id) || !attribution.operation_id || !attribution.root_cause || !attribution.action || !attribution.evidence_refs.length) throw new Error("恢复归因证据不完整");
    const state = options.store.getCodexManagerState(), operation = state.recent_operations.find((item) => item.operation_id === attribution.operation_id && item.status === "SUCCEEDED");
    if (!operation || operation.actor !== attribution.actor || operation.commit !== attribution.commit || operation.pr !== attribution.pr) throw new Error("恢复归因没有匹配的成功动作或版本身份不一致");
    if (attribution.incident_id) {
      const incident = options.store.getSelfCheck().recent.find((item) => item.incident_id === attribution.incident_id);
      if (!incident || attribution.closed && incident.status !== "RESOLVED") throw new Error("恢复归因引用的Incident不存在或尚未关闭");
    } else if (attribution.classification === "INCIDENT") throw new Error("Incident恢复归因必须引用Incident");
    const eventId = `${attribution.attribution_id}:recorded`, prior = options.store.getCodexManagerEvent(eventId)?.payload.attribution as CodexRecoveryAttribution | undefined;
    if (prior) return prior;
    options.store.recordCodexManagerEvent({ event_id: eventId, manager_run_id: attribution.attribution_id, event_type: "RECOVERY_ATTRIBUTION_RECORDED", recorded_at: attribution.verified_at, payload: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, attribution } });
    return attribution;
  }

  function record(summary: CodexManagerRunSummary, eventType: string, body: Record<string, unknown> = {}) {
    return options.store.recordCodexManagerEvent({ event_id: `${summary.manager_run_id}:${eventType.toLowerCase()}:${hash(body).slice(0, 12)}`, manager_run_id: summary.manager_run_id, event_type: eventType, recorded_at: now().toISOString(), snapshot_id: summary.snapshot_id, payload: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, run_summary: summary, ...body } });
  }

  async function run(trigger: CodexManagerTrigger, ownerContext: string | null = null, resume = true, timeoutMs?: number, identity?: { managerRunId: string; requestedAt: Date }) {
    if (stopping) throw new Error("Codex manager is stopping");
    if (!CODEX_MANAGER_TRIGGERS.includes(trigger)) throw new Error("Codex manager trigger is invalid");
    const incidentOnly = trigger === "INCIDENT_ESCALATION" && (rememberIncidentEscalation(ownerContext) || ownerContext === "PENDING_INCIDENT_ESCALATIONS");
    if (active) return active;
    const incidentRequests = currentIncidentRequests();
    const requestedAt = identity?.requestedAt ?? now(), managerRunId = identity?.managerRunId ?? `codex-manager:${requestedAt.toISOString()}:${randomUUID().slice(0, 8)}`;
    const managerState = options.store.getCodexManagerState(), prior = managerState.recent_runs.find((item) => item.manager_run_id !== managerRunId && Date.parse(item.requested_at) <= requestedAt.getTime()) ?? null, level: CodexManagerSnapshotLevel = incidentRequests.length || ["SCHEDULE_WEEKLY_REVIEW", "INCIDENT_ESCALATION"].includes(trigger) ? "FULL_AUDIT" : "DAILY_DELTA";
    activeLevel = level; activeCommandId = managerRunId; queuedCommand = null;
    const threadRuns = prior?.thread_id ? managerState.recent_runs.filter((item) => item.thread_id === prior.thread_id && item.status === "SUCCEEDED").length : 0;
    const priorCompatible = prior?.decision?.contract_version === CODEX_PRODUCTION_MANAGER_CONTRACT && (prior.usage?.input_tokens ?? 0) <= finiteEnv("CODEX_MANAGER_THREAD_MAX_INPUT_TOKENS", 24_000, 5_000);
    const resumeThread = resume && priorCompatible && threadRuns < finiteEnv("CODEX_MANAGER_THREAD_MAX_RUNS", 6, 2) ? prior?.thread_id ?? null : null;
    const priorCheckpoint = options.store.getLatestCodexManagerEvent("MANAGER_CHECKPOINT")?.checkpoint as { checkpoint_id?: string } | undefined;
    let summary: CodexManagerRunSummary = { manager_run_id: managerRunId, trigger, requested_at: requestedAt.toISOString(), completed_at: null, status: "RUNNING", snapshot_id: null, snapshot_sha256: null, model, agent_version: "codex-cli pending", thread_id: null, duration_ms: null, usage: null, decision: null, error: null, tools: [], snapshot_level: level, input_bytes: 0, checkpoint_id: priorCheckpoint?.checkpoint_id ?? null };
    active = (async () => {
      if (incidentOnly && !incidentRequests.length) {
        summary = { ...summary, completed_at: now().toISOString(), status: "SKIPPED_DUPLICATE", error: "无待分析的当前严重故障；不重复升级或宣称维修完成" };
        record(summary, "RUN_SKIPPED_DUPLICATE"); return summary;
      }
      const daily = options.store.codexManagerUsageSince(dateStart(requestedAt)), weekly = options.store.codexManagerUsageSince(dateStart(requestedAt, 7));
      if (!incidentRequests.length && prior && prior.trigger === trigger && Date.parse(requestedAt.toISOString()) - Date.parse(prior.requested_at) < 5 * 60_000 && prior.status === "SUCCEEDED") {
        summary = { ...summary, completed_at: now().toISOString(), status: "SKIPPED_DUPLICATE", error: `Duplicate of ${prior.manager_run_id}` };
        record(summary, "RUN_SKIPPED_DUPLICATE", { prior_run_id: prior.manager_run_id });
        return summary;
      }
      managerTiming(options, managerRunId, "runRequested.record", () => record(summary, "RUN_REQUESTED", { limits: { dailyCalls, weeklyCalls, dailyCost, weeklyCost }, usage: { daily, weekly } }));
      try {
        const toolResults = await managerTiming(options, managerRunId, level === "FULL_AUDIT" ? "tools.full" : "tools.daily", () => level === "FULL_AUDIT" ? fullManagerTools(options, managerRunId, ownerContext, incidentRequests) : dailyManagerTools(options, managerRunId, ownerContext)), snapshotId = `manager-snapshot:${managerRunId}`;
        const snapshot = { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, snapshot_level: level, snapshot_id: snapshotId, manager_run_id: managerRunId, trigger, frozen_at: now().toISOString(), model, allowed_tools: level === "FULL_AUDIT" ? FULL_TOOLS : DAILY_TOOLS, tool_results: toolResults };
        const prompt = managerTiming(options, managerRunId, "snapshot.stringify", () => JSON.stringify(snapshot));
        summary = { ...summary, snapshot_id: snapshotId, snapshot_sha256: managerTiming(options, managerRunId, "snapshot.hash", () => hash(snapshot)), tools: Object.keys(toolResults), input_bytes: Buffer.byteLength(prompt) };
        managerTiming(options, managerRunId, "tools.record", () => { for (const [tool, value] of Object.entries(toolResults)) record(summary, "TOOL_COMPLETED", { tool, result_sha256: hash(value) }); });
        managerTiming(options, managerRunId, "snapshot.record", () => record(summary, "SNAPSHOT_FROZEN", { snapshot, snapshot_sha256: summary.snapshot_sha256 }));
        if (daily.calls >= dailyCalls || weekly.calls >= weeklyCalls || daily.estimated_cost_usd >= dailyCost || weekly.estimated_cost_usd >= weeklyCost) {
          summary = { ...summary, completed_at: now().toISOString(), status: "SKIPPED_BUDGET", error: "解释层不可用；确定性经理检查、自动恢复与Incident继续运行" };
          record(summary, "RUN_SKIPPED_BUDGET", { limits: { dailyCalls, weeklyCalls, dailyCost, weeklyCost }, usage: { daily, weekly }, deterministic_checks_completed: true });
          return summary;
        }
        record(summary, "MODEL_STARTED", { model, resume_thread_id: resumeThread, snapshot_level: level, input_bytes: summary.input_bytes });
        const runner = invoke ?? defaultInvoker(options, timeoutMs ?? (trigger === "STARTUP_RECOVERY" ? finiteEnv("CODEX_MANAGER_STARTUP_TIMEOUT_MS", 60_000, 10_000) : finiteEnv("CODEX_MANAGER_TIMEOUT_MS", 240_000, 10_000)));
        const result = await runner({ managerRunId, prompt, model, resumeThreadId: resumeThread });
        const uncached = Math.max(0, result.usage.input_tokens - result.usage.cached_input_tokens), estimated = (uncached * price.input + result.usage.cached_input_tokens * price.cached + result.usage.output_tokens * price.output) / 1_000_000;
        const usage: CodexManagerUsage = { ...result.usage, estimated_cost_usd: Number(estimated.toFixed(6)), cost_basis: "API_LIST_EQUIVALENT_ESTIMATE" };
        summary = { ...summary, completed_at: now().toISOString(), status: "SUCCEEDED", agent_version: result.agentVersion, thread_id: result.threadId, duration_ms: now().getTime() - requestedAt.getTime(), usage, decision: result.decision };
        record(summary, "MODEL_COMPLETED", { model, thread_id: result.threadId, usage, stderr_summary: result.stderr });
        record(summary, "MANAGER_DECISION_RECORDED", { decision: result.decision });
        for (const request of result.decision.recheck_requests) record(summary, "RECHECK_REQUESTED", { request });
        const actions = [...result.decision.requested_actions];
        for (const request of result.decision.recheck_requests) if (!actions.some((action) => action?.action === "REQUEST_DEPARTMENT_RECHECK" && action.target === request.department)) actions.push({ action: "REQUEST_DEPARTMENT_RECHECK", target: request.department, reason: request.reason, evidence_refs: ["recheck_requests"] });
        let rejectedActions = 0;
        for (const action of actions) {
          try { await executeAction({ ...action, manager_run_id: managerRunId }); }
          catch (error) {
            if (!actionRejected(error)) throw error;
            rejectedActions++;
            record(summary, "ACTION_REJECTED", { action, error: safe(error) });
          }
        }
        if (rejectedActions) summary = { ...summary, error: `模型分析已完成；${rejectedActions}项动作被输入或权限护栏拒绝，详见动作记录。` };
        const checkpoint = { checkpoint_id: `manager-checkpoint:${managerRunId}`, manager_run_id: managerRunId, recorded_at: now().toISOString(), truth: level === "FULL_AUDIT" ? (toolResults as Awaited<ReturnType<typeof fullManagerTools>>).read_current_truth : (toolResults as Awaited<ReturnType<typeof dailyManagerTools>>).read_current_truth, decision: { status: result.decision.status, manager_conclusion: result.decision.manager_conclusion, finding_codes: result.decision.findings.map((item) => item.code) } };
        options.store.recordCodexManagerEvent({ event_id: `${managerRunId}:checkpoint`, manager_run_id: managerRunId, event_type: "MANAGER_CHECKPOINT", recorded_at: checkpoint.recorded_at, snapshot_id: summary.snapshot_id, payload: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, checkpoint } });
        summary = { ...summary, checkpoint_id: checkpoint.checkpoint_id };
        record(summary, "RUN_COMPLETED", { decision_sha256: hash(result.decision) });
        return summary;
      } catch (error) {
        summary = { ...summary, completed_at: now().toISOString(), status: /timed out/i.test(safe(error)) ? "TIMED_OUT" : "FAILED", duration_ms: now().getTime() - requestedAt.getTime(), error: safe(error) };
        record(summary, "RUN_FAILED", { error: summary.error });
        return summary;
      }
    })().finally(() => {
      try {
        for (const request of incidentRequests) incidentReceipt(request, summary.status === "SUCCEEDED" ? "ANALYZED" : summary.status, managerRunId, summary.snapshot_id);
      } finally {
        active = null; activeLevel = null; activeCommandId = null;
        const context = pendingFullAudit; pendingFullAudit = null;
        // Retry failed/budget-deferred roots only on a later existing run/startup, never in an immediate loop.
        const newRoots = [...pendingIncidents.keys()].some((id) => !incidentRequests.some((request) => request.request_id === id));
        if ((context || newRoots) && !stopping) {
          pendingTimer = setTimeout(() => { pendingTimer = null; void run("INCIDENT_ESCALATION", context ?? "PENDING_INCIDENT_ESCALATIONS", false).catch(() => undefined); }, 0);
          pendingTimer.unref();
        }
      }
    });
    return active;
  }

  function queue(trigger: CodexManagerTrigger, ownerContext: string | null = null, resume = true) {
    if (stopping) throw new Error("Codex manager is stopping");
    if (!CODEX_MANAGER_TRIGGERS.includes(trigger)) throw new Error("Codex manager trigger is invalid");
    if (trigger === "INCIDENT_ESCALATION") rememberIncidentEscalation(ownerContext);
    if (queuedCommand) return queuedCommand;
    if (active && activeCommandId) return options.store.getCodexManagerState().recent_runs.find((item) => item.manager_run_id === activeCommandId) ?? { ...options.store.getCodexManagerState().latest_run!, manager_run_id: activeCommandId, status: "RUNNING" as const };
    const requestedAt = now(), managerRunId = `codex-manager:${requestedAt.toISOString()}:${randomUUID().slice(0, 8)}`;
    queuedCommand = { manager_run_id: managerRunId, trigger, requested_at: requestedAt.toISOString(), completed_at: null, status: "QUEUED", snapshot_id: null, snapshot_sha256: null, model, agent_version: "codex-cli pending", thread_id: null, duration_ms: null, usage: null, decision: null, error: null, tools: [], snapshot_level: ["SCHEDULE_WEEKLY_REVIEW", "INCIDENT_ESCALATION"].includes(trigger) ? "FULL_AUDIT" : "DAILY_DELTA", input_bytes: 0, checkpoint_id: null };
    record(queuedCommand, "RUN_QUEUED", { command_id: managerRunId, owner_context: ownerContext?.slice(0, 8_000) ?? null, resume });
    commandTimer = setTimeout(() => {
      commandTimer = null;
      void run(trigger, ownerContext, resume, undefined, { managerRunId, requestedAt }).catch(() => undefined);
    }, 0);
    commandTimer.unref();
    return queuedCommand;
  }

  let strandedCommand = options.store.getCodexManagerState().recent_runs.find((item) => item.status === "QUEUED" || item.status === "RUNNING") ?? null;
  if (strandedCommand?.status === "RUNNING" && pendingIncidents.size) {
    const interrupted = { ...strandedCommand, status: "FAILED" as const, completed_at: now().toISOString(), error: "上次经理运行中断；原冻结记录保留，待处理严重故障由新尝试继续，不代表已维修" };
    record(interrupted, "RUN_INTERRUPTED", { pending_incident_request_ids: [...pendingIncidents.keys()] });
    strandedCommand = null;
  }
  if (strandedCommand) {
    const request = options.store.getLatestCodexManagerRunEvent(strandedCommand.manager_run_id, "RUN_QUEUED") as { command_id?: string; owner_context?: string | null; resume?: boolean } | undefined;
    const original = request?.command_id === strandedCommand.manager_run_id ? request : null;
    queuedCommand = strandedCommand;
    void run(strandedCommand.trigger, original?.owner_context ?? null, original?.resume ?? true, undefined, { managerRunId: strandedCommand.manager_run_id, requestedAt: new Date(strandedCommand.requested_at) }).catch(() => undefined);
  } else if (pendingIncidents.size) {
    pendingTimer = setTimeout(() => { pendingTimer = null; void run("INCIDENT_ESCALATION", "PENDING_INCIDENT_ESCALATIONS", false).catch(() => undefined); }, 0);
    pendingTimer.unref();
  }

  return {
    run,
    queue,
    executeAction,
    recordPrivilegedOperation,
    recordRecoveryAttribution,
    async stop() {
      stopping = true;
      pendingFullAudit = null;
      if (commandTimer) clearTimeout(commandTimer);
      commandTimer = null; queuedCommand = null;
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      await active?.catch(() => undefined);
    },
    get running() { return Boolean(active); },
    get state() { return options.store.getCodexManagerState(); },
  };
}
