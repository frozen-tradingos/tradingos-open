import type { RunEvent } from "../app/agent-ledger.ts";
import { buildCodexManagerReview, type ManagerReview, type ManagerReviewType } from "../app/codex-manager.ts";
import { exchangeDateKey, formatPtTime, latestCompletedNyseSession, MARKET_5M_MAX_AGE_SECONDS, ptDateKey as marketPtDateKey, robinhoodSessionAt } from "../app/market-time.ts";
import { OPENING_RECOVERY_EFFECTIVE_DATE, timelineGraceSeconds, timelineOccurrencesForPtDate, ptDateKey, utcForPt, type ScheduleCheckpoint, type ScheduleCheckpointStatus, type TimelineOccurrence, type TsCoreTerminalOutcome } from "../app/timeline-schedule.ts";
import type { openSnapshotDatabase } from "../build/local-data-core.ts";
import type { CodexManagerTrigger } from "../app/codex-production-manager.ts";
import type { PositionRiskCheck } from "./position-copilot.ts";

type Store = ReturnType<typeof openSnapshotDatabase>;
type ShadowResult = { status: "COMPLETED" | "GENUINE_DATA_BLOCKED" | "SYSTEM_BLOCKED" | "FAILED" | "IN_PROGRESS"; terminalOutcome?: TsCoreTerminalOutcome; runId?: string; slotId?: string };
export type TimelineSchedulerOptions = { store: Store; runShadow: (at: Date, reason: string) => Promise<ShadowResult>; runTsCore?: (at: Date, reason: string) => Promise<ShadowResult>; reserveTsCore?: (at: Date) => { status: "ACQUIRED" | "BUSY" | "TERMINAL"; runId: string; slotId: string }; completeReservedTsCore?: (at: Date, outcome: TsCoreTerminalOutcome) => ShadowResult | Promise<ShadowResult>; runCodexManager?: (trigger: CodexManagerTrigger, context: string) => void; monitorPositions?: (at: Date) => Promise<PositionRiskCheck>; monitorExternalExperts?: (at: Date) => Promise<unknown>; now?: () => Date; intervalMs?: number; runtimeStartedAt?: Date };

const FINAL = new Set(["SUCCEEDED", "FAILED", "SKIPPED", "TIMED_OUT", "DATA_BLOCKED"]);
const SHADOW_KINDS = new Set(["TS_FORECAST", "FULL_ANALYSIS", "EVENING_ANALYSIS"]);
const MAINTENANCE_KINDS = new Set(["LOCAL_GUARD", "CODEX_GUARD", "HISTORY_ARCHIVE"]);
const SHADOW_DEPENDENTS = new Set(["CODEX_MANAGER", "EVENING_LOCAL_GUARD", "EVENING_CODEX_GUARD", "DAILY_REVIEW", "HISTORY_ARCHIVE", "TS_SETTLEMENT"]);
const recordId = (item: TimelineOccurrence) => `checkpoint:${item.slot_id}`;
const managerType = (item: TimelineOccurrence): ManagerReviewType => item.kind === "DAILY_REVIEW" ? "DAILY_CLOSE" : item.business_slot === "06:20" ? "PREMARKET" : item.business_slot === "07:05" ? "EARLY" : item.label.includes("收盘后") ? "POST_CLOSE" : item.label.includes("部署后") ? "POST_DEPLOY" : "INTRADAY";
const managerTrigger = (item: TimelineOccurrence, at: Date): CodexManagerTrigger => item.kind === "DAILY_REVIEW"
  ? new Date(`${marketPtDateKey(at)}T00:00:00Z`).getUTCDay() === 0 ? "SCHEDULE_WEEKLY_REVIEW" : "SCHEDULE_DAILY_REVIEW"
  : item.business_slot === "06:20" ? "SCHEDULE_PREMARKET" : item.business_slot === "07:05" ? "SCHEDULE_EARLY" : item.label.includes("收盘后") ? "SCHEDULE_POST_CLOSE" : item.label.includes("部署后") ? "POST_DEPLOY" : "SCHEDULE_INTRADAY";

function existingShadow(store: Store, item: TimelineOccurrence) {
  if (!["TS_FORECAST", "FULL_ANALYSIS", "EVENING_ANALYSIS"].includes(item.kind)) return null;
  const slot = new Date(Math.floor(Date.parse(item.scheduled_at) / 900_000) * 900_000);
  const compact = slot.toISOString().replace(/[-:]/g, "").replace(".000Z", "Z");
  const ownership = store.getTsCoreSlotOwnership(`live-shadow:${compact}`);
  if (item.kind === "TS_FORECAST" && ownership?.status === "TERMINAL") return ownership.terminal_outcome === "DELIVERED" || ownership.terminal_outcome === "NO_TRADE"
    ? { status: "SUCCEEDED" as const, reason: null, ref: `sqlite://ts_core_slot_ownership/${ownership.slot_id}`, terminalOutcome: ownership.terminal_outcome }
    : ownership.terminal_outcome === "GENUINE_DATA_BLOCKED"
      ? { status: "DATA_BLOCKED" as const, reason: "正式 TS 槽被真实行情合同阻断", ref: `sqlite://ts_core_slot_ownership/${ownership.slot_id}`, terminalOutcome: ownership.terminal_outcome }
      : { status: "FAILED" as const, reason: ownership.terminal_outcome === "SYSTEM_BLOCKED" ? "正式 TS 槽被系统所有权或交付链阻断" : "正式 TS 槽运行失败", ref: `sqlite://ts_core_slot_ownership/${ownership.slot_id}`, terminalOutcome: ownership.terminal_outcome! };
  const required = item.kind === "TS_FORECAST" ? new Set(["A1", "A2", "TS"]) : new Set(["A1", "A2", "TS", "COMMITTEE", "D", "A3", "CODEX_GUARD"]);
  const runs = store.getRunsForSlot(`live-shadow:${compact}`).filter((run) => required.has(run.agent_id));
  if (!runs.length) return null;
  if (runs.some((run) => run.status === "FAILED" || run.status === "TIMED_OUT")) return { status: "FAILED" as const, reason: "既有 Shadow 槽存在系统运行失败", ref: `sqlite://agent_run_events/live-shadow:${compact}`, terminalOutcome: "FAILED" as const };
  if (runs.some((run) => run.status === "DATA_BLOCKED")) return { status: "DATA_BLOCKED" as const, reason: "既有 Shadow 槽被真实数据合同阻断", ref: `sqlite://agent_run_events/live-shadow:${compact}`, terminalOutcome: "GENUINE_DATA_BLOCKED" as const };
  if ([...required].every((agent) => runs.some((run) => run.agent_id === agent && run.status === "SUCCEEDED" && run.output_status === "PRODUCED" && run.website_delivery === "DELIVERED"))) return { status: "SUCCEEDED" as const, reason: null, ref: `sqlite://agent_run_events/live-shadow:${compact}` };
  if ([...required].every((agent) => runs.some((run) => run.agent_id === agent && FINAL.has(run.status)))) return { status: "FAILED" as const, reason: "既有 Shadow 槽没有形成完整网站交付", ref: `sqlite://agent_run_events/live-shadow:${compact}`, terminalOutcome: "SYSTEM_BLOCKED" as const };
  return null;
}

function sourceHealth(store: Store, at: Date) {
  const source = store.getDataSources().find((item) => item.source === "ROBINHOOD");
  const age = source?.as_of ? Math.max(0, (at.getTime() - Date.parse(source.as_of)) / 1_000) : Number.POSITIVE_INFINITY;
  if (source?.authorization !== "VALID") return "BLOCKED";
  if (source.as_of && exchangeDateKey(source.as_of) === latestCompletedNyseSession(at) && ["LIVE", "MARKET_CLOSED"].includes(source.status)) return "MARKET_CLOSED";
  return source.status === "LIVE" && age <= MARKET_5M_MAX_AGE_SECONDS ? "LIVE" : "BLOCKED";
}

function sourceCanRecoverInsideGrace(store: Store, at: Date) {
  // The first complete regular-session bar cannot exist before 06:35. After
  // that, A1 checks its actual quote/bar contract; a Guard summary cannot gate it.
  if (ptDateKey(at) >= OPENING_RECOVERY_EFFECTIVE_DATE) return at.getTime() < utcForPt(ptDateKey(at), "06:35").getTime();
  const source = store.getDataSources().find((item) => item.source === "ROBINHOOD");
  return source?.configured === true && source.authorization === "VALID" && sourceHealth(store, at) !== "LIVE";
}

function sourceRecoveredBy(store: Store, at: Date, deadline: number) {
  const source = store.getDataSources().find((item) => item.source === "ROBINHOOD");
  return source?.configured === true && source.authorization === "VALID" && sourceHealth(store, at) === "LIVE" && Date.parse(source.checked_at) <= deadline;
}

function runReason(item: TimelineOccurrence) {
  if (item.kind === "EVENING_ANALYSIS") return item.trading_day ? "次日提前分析" : "周末分析";
  if (item.business_slot === "06:30") return "早盘固定分析";
  if (item.business_slot === "06:45") return "开盘15分钟验证";
  if (item.business_slot === "07:00") return "开盘30分钟验证";
  return "4070 Live Shadow";
}

export function createTimelineScheduler(options: TimelineSchedulerOptions) {
  const now = options.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let activeRun: Promise<{ status: "COMPLETED"; processed: number; state?: ReturnType<Store["getActive"]>["scheduler"] } | { status: "OVERLAP_REJECTED"; processed: 0 }> | null = null;
  let tier0Running: Promise<ScheduleCheckpoint | null> | null = null;
  let tier1Running: Promise<ScheduleCheckpoint | null> | null = null;
  let positionRunning: Promise<ScheduleCheckpoint | null> | null = null;
  let maintenanceRunning: Promise<ScheduleCheckpoint | null> | null = null;
  let observerRunning: Promise<unknown> | null = null;
  let checkedAt: string | null = null;
  let runtimeStartedAt = options.runtimeStartedAt?.getTime() ?? null;

  function ledger(item: TimelineOccurrence, checkpoint: ScheduleCheckpoint, delivered: boolean) {
    const runId = item.slot_id;
    const identity = item.kind === "DAILY_REVIEW" ? { agent: "DAILY_REVIEW", skill: "DAILY_REVIEW_CLOSE", version: "codex-daily-manager-v1" }
      : item.kind === "CODEX_MANAGER" ? { agent: "CODEX_MANAGER", skill: "CODEX_MANAGER_AUDIT", version: "codex-daily-manager-v1" }
        : { agent: "TIMELINE_SCHEDULER", skill: "TIMELINE_CHECKPOINT", version: "full-timeline-scheduler-v1" };
    let current = options.store.getRunsForSlot(item.slot_id).find((run) => run.agent_id === identity.agent);
    if (!current && ["MISSED", "SKIPPED_MARKET_CLOSED"].includes(checkpoint.status)) {
      const event: RunEvent = { ledger_format: "TRADING_OS_AGENT_RUN_EVENT", ledger_version: 1, event_id: `${runId}:skipped`, agent_id: identity.agent, skill_id: identity.skill, run_id: runId, slot_id: item.slot_id, channel: "SYSTEM", version: identity.version, data_cutoff_at: item.scheduled_at, event_at: checkpoint.completed_at, status: "SKIPPED", output_status: "NOT_PRODUCED", error: null, evidence_refs: [], website_delivery: "NOT_ATTEMPTED", discord_delivery: "NOT_APPLICABLE" };
      options.store.importRunEventRaw(JSON.stringify(event), checkpoint.completed_at, true);
      return;
    }
    if (!current) {
      const event: RunEvent = { ledger_format: "TRADING_OS_AGENT_RUN_EVENT", ledger_version: 1, event_id: `${runId}:started`, agent_id: identity.agent, skill_id: identity.skill, run_id: runId, slot_id: item.slot_id, channel: "SYSTEM", version: identity.version, data_cutoff_at: item.scheduled_at, event_at: checkpoint.started_at ?? checkpoint.completed_at, status: "STARTED", output_status: "NOT_PRODUCED", error: null, evidence_refs: [], website_delivery: "NOT_ATTEMPTED", discord_delivery: "NOT_APPLICABLE" };
      options.store.importRunEventRaw(JSON.stringify(event), checkpoint.completed_at, true);
      current = options.store.getRunsForSlot(item.slot_id).find((run) => run.agent_id === identity.agent);
    }
    if (current?.status === "STARTED") {
      const event: RunEvent = { ledger_format: "TRADING_OS_AGENT_RUN_EVENT", ledger_version: 1, event_id: `${runId}:running`, agent_id: identity.agent, skill_id: identity.skill, run_id: runId, slot_id: item.slot_id, channel: "SYSTEM", version: identity.version, data_cutoff_at: item.scheduled_at, event_at: new Date(Date.parse(current.event_at) + 1).toISOString(), status: "RUNNING", output_status: "NOT_PRODUCED", error: null, evidence_refs: [], website_delivery: "NOT_ATTEMPTED", discord_delivery: "NOT_APPLICABLE" };
      options.store.importRunEventRaw(JSON.stringify(event), checkpoint.completed_at, true);
      current = options.store.getRunsForSlot(item.slot_id).find((run) => run.agent_id === identity.agent);
    }
    if (delivered && current && !FINAL.has(current.status)) {
      const succeeded = checkpoint.status === "SUCCEEDED", status = checkpoint.status === "FAILED" ? "FAILED" : checkpoint.status === "DATA_BLOCKED" ? "DATA_BLOCKED" : "SUCCEEDED";
      const event: RunEvent = { ledger_format: "TRADING_OS_AGENT_RUN_EVENT", ledger_version: 1, event_id: `${runId}:${succeeded ? "recorded" : status.toLowerCase().replace("_", "-")}`, agent_id: identity.agent, skill_id: identity.skill, run_id: runId, slot_id: item.slot_id, channel: "SYSTEM", version: identity.version, data_cutoff_at: item.scheduled_at, event_at: new Date(Math.max(Date.parse(checkpoint.completed_at), Date.parse(current.event_at) + 1)).toISOString(), status, output_status: succeeded ? "PRODUCED" : "NOT_PRODUCED", error: succeeded ? null : checkpoint.reason ?? status, evidence_refs: succeeded ? [`sqlite://output_records/${recordId(item)}`] : [], website_delivery: succeeded ? "DELIVERED" : "NOT_ATTEMPTED", discord_delivery: "NOT_APPLICABLE" };
      options.store.importRunEventRaw(JSON.stringify(event), checkpoint.completed_at, true);
    }
  }

  function completeDepartmentRechecks(item: TimelineOccurrence, runId: string | null) {
    type Request = { request_id: string; target: string; reason: string; requested_at: string; eligibility: "NEXT_NATURAL_SLOT_ONLY" };
    type Completion = { request_id: string };
    const completed = new Set(options.store.getCodexManagerEventPayloads<Completion>("DEPARTMENT_RECHECK_COMPLETED", "completion").map((entry) => entry.request_id));
    const runs = runId ? options.store.getRunsForSlot(runId) : [];
    for (const request of options.store.getCodexManagerEventPayloads<Request>("DEPARTMENT_RECHECK_REQUESTED", "request")) {
      if (completed.has(request.request_id) || request.eligibility !== "NEXT_NATURAL_SLOT_ONLY" || Date.parse(request.requested_at) >= Date.parse(item.scheduled_at)) continue;
      if (!runs.some((run) => run.run_id === runId && run.agent_id === request.target && run.skill_id === (request.target === "A3" ? "A3_FINAL_LIVE_SHADOW" : `${request.target}_LIVE_SHADOW`) && run.channel === "SHADOW" && run.status === "SUCCEEDED" && run.output_status === "PRODUCED" && run.website_delivery === "DELIVERED")) continue;
      const recordedAt = new Date().toISOString(), completion = { request_id: request.request_id, target: request.target, requested_at: request.requested_at, completed_at: recordedAt, natural_slot_id: item.slot_id, status: "COMPLETED", run_id: runId, evidence_ref: runId ? `sqlite://agent_run_events/${runId}` : null };
      options.store.recordCodexManagerEvent({ event_id: `${request.request_id}:completed`, manager_run_id: request.request_id, event_type: "DEPARTMENT_RECHECK_COMPLETED", recorded_at: recordedAt, payload: { contract_version: "CODEX_PRODUCTION_MANAGER_ACTIVE_V1", completion } });
    }
  }

  async function evaluate(item: TimelineOccurrence, at: Date, allowPollJitter = false): Promise<{ status: ScheduleCheckpointStatus | "IN_PROGRESS"; reason: string | null; ref: string | null; terminalOutcome?: TsCoreTerminalOutcome; managerReview?: ManagerReview; positionCheck?: PositionRiskCheck }> {
    const existing = existingShadow(options.store, item);
    if (existing) {
      completeDepartmentRechecks(item, existing.ref.split("/").at(-1) ?? null);
      return existing;
    }
    const late = Math.max(0, Math.floor((at.getTime() - Date.parse(item.scheduled_at)) / 1_000));
    if (!allowPollJitter && late > timelineGraceSeconds(item)) return { status: "MISSED", reason: "MISSED：服务未在允许窗口内留下自然运行证据；未补造结果", ref: null };
    if (item.kind === "POSITION_MONITOR") {
      if (robinhoodSessionAt(at).phase !== "REGULAR") return { status: "SKIPPED_MARKET_CLOSED", reason: "常规交易时段已结束；未将收盘旧报价视为当前可成交价", ref: null };
      if (!options.monitorPositions) return { status: "FAILED", reason: "真实持仓检查器未接入；连接正常不等于风险检查完成", ref: null };
      try {
        const check = await options.monitorPositions(at);
        const gaps = check.observations.filter((entry) => entry.risks.length).length;
        return { status: check.checks_completed ? "SUCCEEDED" : "DATA_BLOCKED", reason: `已检查${check.observations.length}项真实持仓，${gaps}项存在风险或证据缺口；只记录网站，未发送手机通知`, ref: `sqlite://output_records/${recordId(item)}`, positionCheck: check };
      } catch {
        return { status: "DATA_BLOCKED", reason: "真实持仓读取失败，本次风险未能核验；不得以行情连接成功替代", ref: null };
      }
    }
    if (item.kind === "A1_HEARTBEAT") {
      if (!observerRunning && options.monitorExternalExperts) {
        const task = Promise.resolve().then(() => options.monitorExternalExperts!(at));
        observerRunning = task;
        void task.finally(() => { if (observerRunning === task) observerRunning = null; }).catch(() => undefined);
      }
      const health = sourceHealth(options.store, at);
      return health === "LIVE" ? { status: "SUCCEEDED", reason: null, ref: "sqlite://data_source_status/ROBINHOOD" } : health === "MARKET_CLOSED" ? { status: "SKIPPED_MARKET_CLOSED", reason: "NYSE 已收盘或休市；保留当前 EOD，不冒充实时", ref: "sqlite://data_source_status/ROBINHOOD" } : { status: "DATA_BLOCKED", reason: "Robinhood 行情未通过实时与新鲜度检查", ref: null };
    }
    if (item.kind === "LOCAL_GUARD" || item.kind === "CODEX_GUARD") {
      try { await options.store.checkDatabase(at.toISOString()); return { status: "SUCCEEDED", reason: null, ref: "sqlite://self_check_heartbeats/latest" }; }
      catch (error) { return { status: "FAILED", reason: error instanceof Error ? error.message : "SQLite 检查失败", ref: null }; }
    }
    if (item.kind === "TS_FORECAST" || item.kind === "FULL_ANALYSIS" || item.kind === "EVENING_ANALYSIS") {
      const priorTsRaw = item.kind === "FULL_ANALYSIS" ? options.store.getOutputRaw(recordId({ ...item, slot_id: item.slot_id.replace(":full_analysis:", ":ts_forecast:"), kind: "TS_FORECAST" })) : null;
      const priorTs = priorTsRaw ? JSON.parse(priorTsRaw).payload as ScheduleCheckpoint : null;
      if (item.kind === "FULL_ANALYSIS" && priorTs && priorTs.status !== "SUCCEEDED") return { status: "FAILED", reason: `FULL不重跑或改写未成功的TS Core槽：${priorTs.terminal_outcome ?? priorTs.status}`, ref: priorTs.result_ref, terminalOutcome: priorTs.terminal_outcome ?? "SYSTEM_BLOCKED" };
      const core = priorTs?.status === "SUCCEEDED"
        ? { status: "COMPLETED" as const, terminalOutcome: priorTs.terminal_outcome, slotId: priorTs.slot_id }
        : item.kind !== "TS_FORECAST" && !options.runTsCore
          ? { status: "COMPLETED" as const }
          : await (options.runTsCore ?? options.runShadow)(new Date(item.scheduled_at), runReason(item));
      if (core.status === "IN_PROGRESS") return { status: "IN_PROGRESS", reason: "TS Core 槽已被持久化 lease 所有者执行", ref: core.runId ? `sqlite://ts_core_slot_ownership/${core.runId}` : null };
      if (core.status !== "COMPLETED") return core.status === "GENUINE_DATA_BLOCKED"
        ? { status: "DATA_BLOCKED", reason: core.status, ref: core.runId ? `sqlite://agent_run_events/${core.runId}` : null, terminalOutcome: core.terminalOutcome ?? "GENUINE_DATA_BLOCKED" }
        : { status: "FAILED", reason: core.status, ref: core.runId ? `sqlite://agent_run_events/${core.runId}` : null, terminalOutcome: core.terminalOutcome ?? (core.status === "SYSTEM_BLOCKED" ? "SYSTEM_BLOCKED" : "FAILED") };
      const result = item.kind === "TS_FORECAST" ? core : await options.runShadow(new Date(item.scheduled_at), runReason(item));
      completeDepartmentRechecks(item, result.runId ?? null);
      return result.status === "COMPLETED" ? { status: "SUCCEEDED", reason: null, ref: `sqlite://agent_run_events/${result.runId}`, terminalOutcome: core.terminalOutcome } : result.status === "GENUINE_DATA_BLOCKED" ? { status: "DATA_BLOCKED", reason: result.status, ref: result.runId ? `sqlite://agent_run_events/${result.runId}` : null, terminalOutcome: "GENUINE_DATA_BLOCKED" } : { status: "FAILED", reason: result.status, ref: result.runId ? `sqlite://agent_run_events/${result.runId}` : null, terminalOutcome: result.status === "SYSTEM_BLOCKED" ? "SYSTEM_BLOCKED" : "FAILED" };
    }
    if (item.kind === "HISTORY_ARCHIVE") {
      try { await options.store.checkDatabase(at.toISOString()); return { status: "SUCCEEDED", reason: "TS 预测已按发布时原文和哈希永久归档", ref: "sqlite://ts_forecast_archive" }; }
      catch (error) { return { status: "FAILED", reason: error instanceof Error ? error.message : "TS 预测归档检查失败", ref: null }; }
    }
    if (item.kind === "TS_SETTLEMENT") {
      const result = options.store.settleTsForecasts(at.toISOString());
      return result.status === "COMPLETED"
        ? { status: "SUCCEEDED", reason: `自动结算完成；TS 新增 ${result.newlySettled} 份，策略 / 持仓建议新增 ${result.optionNewlySettled} 份`, ref: "sqlite://ts_forecast_settlements" }
        : { status: "DATA_BLOCKED", reason: `仍有 ${result.duePending} 份 TS 与 ${result.optionDuePending} 份策略 / 持仓建议缺少完整 Robinhood 观察数据`, ref: "sqlite://ts_forecast_settlements" };
    }
    if (item.kind === "EVENING_LOCAL_GUARD" || item.kind === "EVENING_CODEX_GUARD") {
      const report = (await options.store.getActiveAsync()).outputs.SCHEDULE_CHECKPOINT.find((checkpoint) => checkpoint.kind === "EVENING_ANALYSIS" && checkpoint.scheduled_pt.slice(0, 10) === item.scheduled_pt.slice(0, 10));
      return report?.status === "SUCCEEDED" ? { status: "SUCCEEDED", reason: null, ref: `sqlite://output_records/${recordId(report)}` } : { status: "DATA_BLOCKED", reason: "18:00 报告没有成功证据", ref: null };
    }
    if (item.kind === "CODEX_MANAGER" || item.kind === "DAILY_REVIEW") {
      const type = managerType(item), actions: string[] = [];
      let review = buildCodexManagerReview(await options.store.getActiveAsync(), at, type, actions);
      if (["EARLY", "INTRADAY"].includes(type) && review.issues.some((issue) => issue.code === "MANAGER_AGENT_CHAIN_INCOMPLETE")) {
        const recovery = await (options.runTsCore ?? options.runShadow)(new Date(item.scheduled_at), "Codex 经理安全恢复");
        actions.push(`已调用同槽 Shadow 防重恢复：${recovery.status}`);
        review = buildCodexManagerReview(await options.store.getActiveAsync(), at, type, actions);
      }
      if (item.kind === "DAILY_REVIEW") {
        const daily = options.store.getTsCoreDailySummary(item.scheduled_pt.slice(0, 10), at);
        actions.push(`TS Core权威全集：应跑${daily.official_slots_expected}，成功${daily.official_slots_succeeded}，DATA_BLOCKED ${daily.data_blocked}，MISSED ${daily.missed}，恢复${daily.automatic_recoveries}，新预测${daily.new_forecasts}，应结算${daily.settlements_due}，已结算${daily.settlements_completed}`);
        review = buildCodexManagerReview(await options.store.getActiveAsync(), at, type, actions);
      }
      options.runCodexManager?.(managerTrigger(item, at), JSON.stringify({ source: "DETERMINISTIC_MANAGER_REVIEW", review }));
      return { status: "SUCCEEDED", reason: review.headline, ref: null, managerReview: review };
    }
    return { status: "DATA_BLOCKED", reason: `${item.kind} 本地执行器尚未接入；只记录自然槽，不补造结果`, ref: null };
  }

  async function record(item: TimelineOccurrence, at: Date, forced?: Awaited<ReturnType<typeof evaluate>>, allowPollJitter = false) {
    const id = recordId(item), raw = options.store.getOutputRaw(id);
    if (raw) { const checkpoint = JSON.parse(raw).payload as ScheduleCheckpoint; ledger(item, checkpoint, true); return checkpoint; }
    const startedAt = at.toISOString(), result = forced ?? await evaluate(item, at, allowPollJitter);
    if (result.status === "IN_PROGRESS") return null;
    const completedAt = new Date(Math.max(Date.now(), at.getTime(), Date.parse(startedAt) + 1)).toISOString();
    const checkpoint: ScheduleCheckpoint = { contract_version: "v1", role: "TIMELINE_SCHEDULER", ...item, status: result.status, started_at: result.status === "MISSED" ? null : startedAt, completed_at: completedAt, late_seconds: Math.max(0, Math.floor((at.getTime() - Date.parse(item.scheduled_at)) / 1_000)), result_ref: result.ref, reason: result.reason, ...(item.kind === "TS_FORECAST" ? { terminal_outcome: result.terminalOutcome ?? (result.status === "SUCCEEDED" ? "DELIVERED" : result.status === "DATA_BLOCKED" ? "GENUINE_DATA_BLOCKED" : "FAILED") } : {}), ...(result.managerReview ? { manager_review: result.managerReview } : {}) };
    if (result.positionCheck) checkpoint.position_check = result.positionCheck;
    ledger(item, checkpoint, false);
    options.store.importOutputRaw(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: id, output_type: "SCHEDULE_CHECKPOINT", channel: "SYSTEM", observed_at: completedAt, payload: checkpoint }), completedAt, true);
    ledger(item, checkpoint, true);
    return checkpoint;
  }

  function runOnce(at = now(), detachShadow = false) {
    checkedAt = now().toISOString();
    if (activeRun) return Promise.resolve({ status: "OVERLAP_REJECTED" as const, processed: 0 as const });
    const task = (async () => {
      runtimeStartedAt ??= at.getTime();
      const persistedActivation = Date.parse(options.store.ensureTimelineSchedulerActivatedAt(at.toISOString())), activatedAt = Math.max(persistedActivation, runtimeStartedAt);
      const pollJitterSeconds = Math.ceil((options.intervalMs ?? 30_000) / 1_000) + 5;
      const due = timelineOccurrencesForPtDate(ptDateKey(at)).filter((item) => {
        const scheduled = Date.parse(item.scheduled_at), deadline = scheduled + timelineGraceSeconds(item) * 1_000;
        const openingRecovery = ["TS_FORECAST", "FULL_ANALYSIS"].includes(item.kind) && item.business_slot === "06:30" && at.getTime() <= deadline + pollJitterSeconds * 1_000 && options.store.hasTimelineOpeningDeferred(recordId(item));
        return scheduled <= at.getTime() && (deadline >= activatedAt || openingRecovery) && !options.store.hasOutput(recordId(item));
      });
      const recoveredByDeadline = new Map<number, boolean>();
      const recoveredBy = (deadline: number) => {
        if (!recoveredByDeadline.has(deadline)) recoveredByDeadline.set(deadline, sourceRecoveredBy(options.store, at, deadline));
        return recoveredByDeadline.get(deadline)!;
      };
      let processed = 0;
      for (let index = 0; index < due.length; index += 1) {
        const item = due[index], late = Math.max(0, (at.getTime() - Date.parse(item.scheduled_at)) / 1_000);
        const opening = ["TS_FORECAST", "FULL_ANALYSIS"].includes(item.kind) && item.business_slot === "06:30", grace = timelineGraceSeconds(item), deadline = Date.parse(item.scheduled_at) + grace * 1_000;
        if (opening && (tier0Running || tier1Running)) continue;
        if (opening && sourceCanRecoverInsideGrace(options.store, at) && late < grace) {
          if (item.kind === "TS_FORECAST") options.reserveTsCore?.(new Date(item.scheduled_at));
          options.store.markTimelineOpeningDeferred(recordId(item), at.toISOString());
          continue;
        }
        if (opening && ptDateKey(item.scheduled_at) >= OPENING_RECOVERY_EFFECTIVE_DATE && late > grace && late <= grace + pollJitterSeconds) {
          const frozen = existingShadow(options.store, item);
          if (frozen) { await record(item, at, frozen, true); processed += 1; continue; }
          const slotId = `live-shadow:${new Date(item.scheduled_at).toISOString().replace(/[-:]/g, "").replace(".000Z", "Z")}`;
          const pending = options.store.getRunsForSlot(slotId).some((run) => run.agent_id === "A1" && run.status === "RUNNING" && run.error?.startsWith("OPENING_MARKET_PENDING"));
          let outcome: TsCoreTerminalOutcome = pending ? "GENUINE_DATA_BLOCKED" : "SYSTEM_BLOCKED";
          const completed = item.kind === "TS_FORECAST" ? await options.completeReservedTsCore?.(new Date(item.scheduled_at), outcome) : null;
          if (completed?.status === "IN_PROGRESS") continue;
          if (completed?.status === "COMPLETED") { await record(item, at, undefined, true); processed += 1; continue; }
          outcome = completed?.terminalOutcome ?? outcome;
          const dataBlocked = outcome === "GENUINE_DATA_BLOCKED";
          await record(item, at, { status: dataBlocked ? "DATA_BLOCKED" : "FAILED", reason: dataBlocked ? "开盘 Quote 与完整常规时段5分钟K线在06:40前仍未满足正式采样合同；未补跑" : "开盘槽未在06:40前冻结正式证据；禁止截止后补跑", ref: null, terminalOutcome: outcome }, true);
          processed += 1;
          continue;
        }
        if (opening && late > grace && recoveredBy(deadline) && late <= grace + pollJitterSeconds) {
          const completed = item.kind === "TS_FORECAST" && options.completeReservedTsCore
            ? await options.completeReservedTsCore(new Date(item.scheduled_at), "SYSTEM_BLOCKED")
            : null;
          if (completed?.status === "IN_PROGRESS") continue;
          await record(item, at, { status: "FAILED", reason: "行情虽在截止前恢复，但系统未在截止前冻结Forecast；禁止使用截止后证据补跑", ref: null, terminalOutcome: "SYSTEM_BLOCKED" }, true);
          processed += 1;
          continue;
        }
        if (opening && late > grace && late <= grace + pollJitterSeconds && !recoveredBy(deadline) && options.store.getDataSources().some((source) => source.source === "ROBINHOOD" && source.configured && source.authorization === "VALID")) {
          const completed = item.kind === "TS_FORECAST" && options.completeReservedTsCore
            ? await options.completeReservedTsCore(new Date(item.scheduled_at), "GENUINE_DATA_BLOCKED")
            : null;
          if (completed?.status === "IN_PROGRESS") continue;
          await record(item, at, { status: "DATA_BLOCKED", reason: "Robinhood 开盘行情在5分钟自然恢复窗口内始终未通过实时与新鲜度检查", ref: null, terminalOutcome: "GENUINE_DATA_BLOCKED" }, true);
          processed += 1;
          continue;
        }
        if ((tier0Running || tier1Running) && SHADOW_DEPENDENTS.has(item.kind) && late <= grace) continue;
        if (detachShadow && MAINTENANCE_KINDS.has(item.kind)) {
          // A full database scan may take minutes; keep one running without holding later market slots.
          if (maintenanceRunning) continue;
          const task = record(item, at);
          maintenanceRunning = task;
          void task.finally(() => { if (maintenanceRunning === task) maintenanceRunning = null; }).catch(() => undefined);
        } else if (detachShadow && item.kind === "POSITION_MONITOR") {
          if (positionRunning) continue;
          const task = record(item, at);
          positionRunning = task;
          void task.finally(() => { if (positionRunning === task) positionRunning = null; }).catch(() => undefined);
        } else if (detachShadow && SHADOW_KINDS.has(item.kind)) {
          const current = item.kind === "TS_FORECAST" ? tier0Running : tier1Running;
          if (current || item.kind !== "TS_FORECAST" && tier0Running) continue;
          const task = record(item, at);
          if (item.kind === "TS_FORECAST") tier0Running = task; else tier1Running = task;
          void task.then(() => { if (tier0Running === task) tier0Running = null; if (tier1Running === task) tier1Running = null; }, () => { if (tier0Running === task) tier0Running = null; if (tier1Running === task) tier1Running = null; });
        } else await record(item, at);
        processed += 1;
        if (index % 25 === 24) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // Background callers discard state; building the full owner snapshot would hold the next tick.
      return { status: "COMPLETED" as const, processed, ...(detachShadow ? {} : { state: (await options.store.getActiveAsync()).scheduler }) };
    })();
    activeRun = task;
    void task.then(() => { if (activeRun === task) activeRun = null; }, () => { if (activeRun === task) activeRun = null; });
    return task;
  }

  async function runDeploymentReview(at = now()) {
    const date = marketPtDateKey(at), businessSlot = formatPtTime(at);
    const item: TimelineOccurrence = { slot_id: `codex-manager:deploy:${at.toISOString().replace(/[-:.]/g, "")}`, kind: "CODEX_MANAGER", label: "Codex 部署后公司巡检", business_slot: businessSlot, scheduled_at: at.toISOString(), scheduled_pt: `${date} ${businessSlot}:00 PT`, trading_day: false, source_files: ["server/local-owner-server.ts", "server/timeline-scheduler.ts", "app/codex-manager.ts"] };
    return record(item, at);
  }

  return { runOnce, runDeploymentReview, start() { if (timer) return; void runOnce(now(), true).catch(() => undefined); timer = setInterval(() => void runOnce(now(), true).catch(() => undefined), options.intervalMs ?? 30_000); timer.unref(); }, async stop() { if (timer) clearInterval(timer); timer = null; await activeRun?.catch(() => undefined); await tier0Running?.catch(() => undefined); await tier1Running?.catch(() => undefined); await positionRunning?.catch(() => undefined); await maintenanceRunning?.catch(() => undefined); await observerRunning?.catch(() => undefined); }, get running() { return activeRun !== null || tier0Running !== null || tier1Running !== null || positionRunning !== null || maintenanceRunning !== null || observerRunning !== null; }, get checkedAt() { return checkedAt; } };
}
