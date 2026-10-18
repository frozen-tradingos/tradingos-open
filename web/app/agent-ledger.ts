export const RUN_EVENT_FORMAT = "TRADING_OS_AGENT_RUN_EVENT";
export const RUN_EVENT_VERSION = 1;

export const AGENT_REGISTRY = [
  { agent_id: "A1", name: "A1", kind: "PRIMARY_AGENT", responsibility: "API、行情与新闻采集、调度、共享状态和稳定性", source_files: ["trading_os_v2/a1/__init__.py", "trading_os_v2/a1/service.py", "docs/SYSTEM_OUTLINE.md"] },
  { agent_id: "A2", name: "A2", kind: "PRIMARY_AGENT", responsibility: "确定性多周期结构、期权链、资金动量、盘型与历史样本", source_files: ["trading_os_v2/a2/__init__.py", "trading_os_v2/a2/service.py", "docs/SYSTEM_OUTLINE.md"] },
  { agent_id: "TS", name: "TS", kind: "PRIMARY_AGENT", responsibility: "正式市场路径、关键位、目标、失效条件和假设", source_files: ["trading_os_v2/agent_runtime/service.py", "trading_os_v2/ts/instructions.md", "contracts/v2/ts-output.schema.json"] },
  { agent_id: "COMMITTEE", name: "Committee", kind: "PRIMARY_AGENT", responsibility: "独立判断资金进入、撤退、增强或反转", source_files: ["trading_os_v2/agent_runtime/service.py", "trading_os_v2/committee/instructions.md", "contracts/v1/committee-output.schema.json"] },
  { agent_id: "D", name: "D", kind: "PRIMARY_AGENT", responsibility: "把 TS 与 Committee 证据转为人工持仓方案", source_files: ["trading_os_v2/agent_runtime/service.py", "trading_os_v2/d/instructions.md", "contracts/v1/d-output.schema.json"] },
  { agent_id: "A3", name: "A3", kind: "PRIMARY_AGENT", responsibility: "处理冲突、最多一次定向复核并作唯一最终决定", source_files: ["trading_os_v2/agent_runtime/service.py", "trading_os_v2/a3/review.md", "trading_os_v2/a3/final.md"] },
  { agent_id: "OWNER_POSITION_CONFIRMATION", name: "老板持仓确认", kind: "OWNER_WORKFLOW", responsibility: "只接受老板确认的持仓事实并持久化、回执", source_files: ["trading_os_v2/a1/state.py", "trading_os_v2/cli.py", "docs/SYSTEM_OUTLINE.md"] },
  { agent_id: "CODEX_GUARD", name: "Codex Guard", kind: "SYSTEM_WORKFLOW", responsibility: "独立复核确定性健康快照，不代替 Agent 看盘", source_files: ["trading_os_v2/supervisor/service.py", "trading_os_v2/codex_guard/instructions.md", "contracts/v1/codex-guard.schema.json"] },
  { agent_id: "CODEX_MANAGER", name: "确定性日常经理", kind: "SYSTEM_WORKFLOW", responsibility: "按固定规则检查整家公司、执行安全恢复并形成 Owner 待办和收盘复盘；真实模型经理另记入Codex经理账本", source_files: ["app/codex-manager.ts", "server/timeline-scheduler.ts"] },
  { agent_id: "DAILY_REVIEW", name: "每日复盘", kind: "CLOSING_WORKFLOW", responsibility: "汇总 A3/Agent 证明、健康与交付证据并归档收工结果", source_files: ["trading_os_v2/daily_review/service.py", "config/system.json", "docs/SYSTEM_OUTLINE.md"] },
  { agent_id: "TIMELINE_SCHEDULER", name: "时间线调度器", kind: "SYSTEM_WORKFLOW", responsibility: "按 V2 固定 PT 槽记录触发、遗漏和交付证明，不生成部门结论", source_files: ["trading_os_v2/supervisor/service.py", "trading_os_v2/acceptance/service.py", "config/system.json", "docs/SYSTEM_OUTLINE.md"] },
] as const;

export const SKILL_REGISTRY = [
  { skill_id: "A1_COLLECT_EVIDENCE", agent_id: "A1", kind: "DETERMINISTIC_SKILL", channel: "SYSTEM", name: "证据采集与冻结", source_files: ["trading_os_v2/a1/service.py", "trading_os_v2/orchestrator/service.py"] },
  { skill_id: "A1_EARNINGS_CALENDAR", agent_id: "A1", kind: "EVENT_SOURCE", channel: "SYSTEM", name: "财报日历候选与提醒", source_files: ["trading_os_v2/a1/service.py", "trading_os_v2/orchestrator/service.py", "contracts/v1/a1-earnings-watch.schema.json"] },
  { skill_id: "A1_MAJOR_NEWS", agent_id: "A1", kind: "EVENT_SOURCE", channel: "SYSTEM", name: "重大新闻验证与公告", source_files: ["trading_os_v2/a1/service.py", "trading_os_v2/orchestrator/service.py", "config/system.json"] },
  { skill_id: "A2_ANALYZE_EVIDENCE", agent_id: "A2", kind: "DETERMINISTIC_SKILL", channel: "SYSTEM", name: "结构、期权与资金证据分析", source_files: ["trading_os_v2/a2/service.py"] },
  { skill_id: "A2_PATTERN_TRACKER", agent_id: "A2", kind: "DETERMINISTIC_SKILL", channel: "SYSTEM", name: "常驻盘型追踪", source_files: ["trading_os_v2/a2/pattern_tracker.py", "contracts/v1/a2-pattern-tracker.schema.json"] },
  { skill_id: "A2_TREND_PULLBACK", agent_id: "A2", kind: "DETERMINISTIC_SKILL", channel: "SYSTEM", name: "中短期趋势回撤门禁", source_files: ["trading_os_v2/a2/trend_pullback.py", "trading_os_v2/a2/service.py"] },
  { skill_id: "A2_LEGACY_HALF_HOUR_SHADOW", agent_id: "A2", kind: "LEGACY_DISABLED", channel: "SHADOW", name: "旧半小时 Shadow（固定停用）", source_files: ["trading_os_v2/a2/half_hour_forecast.py", "config/system.json", "contracts/v1/a2-half-hour-forecast.schema.json"] },
  { skill_id: "TS_FORECAST", agent_id: "TS", kind: "CODEX_SKILL", channel: "PRODUCTION", name: "TS 正式预测", source_files: ["trading_os_v2/ts/instructions.md", "contracts/v2/ts-output.schema.json"] },
  { skill_id: "TS_SWING_SCORECARD", agent_id: "TS", kind: "DETERMINISTIC_SKILL", channel: "SYSTEM", name: "TS 中短期波段只读结算", source_files: ["trading_os_v2/ts/settlement.py", "contracts/v1/ts-swing-scorecard.schema.json"] },
  { skill_id: "COMMITTEE_FLOW_REVIEW", agent_id: "COMMITTEE", kind: "CODEX_SKILL", channel: "PRODUCTION", name: "资金方向独立复核", source_files: ["trading_os_v2/committee/instructions.md", "contracts/v1/committee-output.schema.json"] },
  { skill_id: "D_MANUAL_PLAN", agent_id: "D", kind: "CODEX_SKILL", channel: "PRODUCTION", name: "人工方案生成", source_files: ["trading_os_v2/d/instructions.md", "contracts/v1/d-output.schema.json"] },
  { skill_id: "A3_CONFLICT_REVIEW", agent_id: "A3", kind: "CODEX_SKILL", channel: "PRODUCTION", name: "冲突复核", source_files: ["trading_os_v2/a3/review.md", "contracts/v1/a3-review.schema.json"] },
  { skill_id: "A3_FINAL_DECISION", agent_id: "A3", kind: "CODEX_SKILL", channel: "PRODUCTION", name: "唯一最终决定", source_files: ["trading_os_v2/a3/final.md", "contracts/v1/a3-final.schema.json"] },
  { skill_id: "OWNER_POSITION_SYNC", agent_id: "OWNER_POSITION_CONFIRMATION", kind: "OWNER_SKILL", channel: "SYSTEM", name: "老板持仓确认同步", source_files: ["trading_os_v2/a1/state.py", "trading_os_v2/cli.py"] },
  { skill_id: "CODEX_HEALTH_GUARD", agent_id: "CODEX_GUARD", kind: "CODEX_SKILL", channel: "SYSTEM", name: "独立系统健康复核", source_files: ["trading_os_v2/supervisor/service.py", "trading_os_v2/codex_guard/instructions.md"] },
  { skill_id: "CODEX_MANAGER_AUDIT", agent_id: "CODEX_MANAGER", kind: "DETERMINISTIC_SKILL", channel: "SYSTEM", name: "确定性全公司证据巡检与安全恢复", source_files: ["app/codex-manager.ts", "server/timeline-scheduler.ts"] },
  { skill_id: "DAILY_REVIEW_CLOSE", agent_id: "DAILY_REVIEW", kind: "CLOSING_SKILL", channel: "SYSTEM", name: "A3 与 Codex 收工证据归档", source_files: ["trading_os_v2/daily_review/service.py", "docs/SYSTEM_OUTLINE.md"] },
  { skill_id: "A1_LIVE_SHADOW", agent_id: "A1", kind: "SHADOW_ADAPTER", channel: "SHADOW", name: "A1 本地实时 Shadow 采集", source_files: ["trading_os_v2/a1/service.py", "scripts/live-shadow-v2.py"] },
  { skill_id: "A2_LIVE_SHADOW", agent_id: "A2", kind: "SHADOW_ADAPTER", channel: "SHADOW", name: "A2 本地实时 Shadow 分析", source_files: ["trading_os_v2/a2/service.py", "scripts/live-shadow-v2.py"] },
  { skill_id: "TS_LIVE_SHADOW", agent_id: "TS", kind: "SHADOW_ADAPTER", channel: "SHADOW", name: "TS 本地实时 Shadow 预测", source_files: ["trading_os_v2/agent_runtime/service.py", "trading_os_v2/ts/instructions.md", "scripts/live-shadow-v2.py"] },
  { skill_id: "COMMITTEE_LIVE_SHADOW", agent_id: "COMMITTEE", kind: "SHADOW_ADAPTER", channel: "SHADOW", name: "Committee 本地独立 Shadow 复核", source_files: ["trading_os_v2/agent_runtime/service.py", "trading_os_v2/committee/instructions.md", "scripts/live-shadow-v2.py"] },
  { skill_id: "D_LIVE_SHADOW", agent_id: "D", kind: "SHADOW_ADAPTER", channel: "SHADOW", name: "D 本地手工方案 Shadow 汇总", source_files: ["trading_os_v2/agent_runtime/service.py", "trading_os_v2/d/instructions.md", "scripts/live-shadow-v2.py"] },
  { skill_id: "A3_REVIEW_LIVE_SHADOW", agent_id: "A3", kind: "SHADOW_ADAPTER", channel: "SHADOW", name: "A3 本地冲突 Shadow 复核", source_files: ["trading_os_v2/agent_runtime/service.py", "trading_os_v2/a3/review.md", "scripts/live-shadow-v2.py"] },
  { skill_id: "A3_FINAL_LIVE_SHADOW", agent_id: "A3", kind: "SHADOW_ADAPTER", channel: "SHADOW", name: "A3 本地最终 Shadow 决定", source_files: ["trading_os_v2/agent_runtime/service.py", "trading_os_v2/a3/final.md", "scripts/live-shadow-v2.py"] },
  { skill_id: "CODEX_GUARD_LIVE_SHADOW", agent_id: "CODEX_GUARD", kind: "SHADOW_ADAPTER", channel: "SHADOW", name: "Codex Guard 本地 Shadow 复核", source_files: ["trading_os_v2/agent_runtime/service.py", "trading_os_v2/codex_guard/instructions.md", "scripts/live-shadow-v2.py"] },
  { skill_id: "TIMELINE_CHECKPOINT", agent_id: "TIMELINE_SCHEDULER", kind: "SYSTEM_SCHEDULER", channel: "SYSTEM", name: "V2 时间槽触发与遗漏证明", source_files: ["trading_os_v2/supervisor/service.py", "trading_os_v2/acceptance/service.py", "config/system.json", "docs/SYSTEM_OUTLINE.md"] },
] as const;

export const OUTPUT_ROUTE_REGISTRY = [
  { route_id: "A1_EVIDENCE_ROUTE", skill_id: "A1_COLLECT_EVIDENCE", website_output_type: null, discord_channels: ["a1"], discord_policy: "ALWAYS", source_files: ["trading_os_v2/orchestrator/service.py"] },
  { route_id: "EARNINGS_CALENDAR_ROUTE", skill_id: "A1_EARNINGS_CALENDAR", website_output_type: null, discord_channels: ["earnings_calendar"], discord_policy: "ALWAYS", source_files: ["trading_os_v2/orchestrator/service.py", "config/system.json"] },
  { route_id: "MAJOR_NEWS_ROUTE", skill_id: "A1_MAJOR_NEWS", website_output_type: null, discord_channels: ["major_news"], discord_policy: "ALWAYS", source_files: ["trading_os_v2/orchestrator/service.py", "config/system.json"] },
  { route_id: "A2_EVIDENCE_ROUTE", skill_id: "A2_ANALYZE_EVIDENCE", website_output_type: null, discord_channels: ["a2"], discord_policy: "ALWAYS", source_files: ["trading_os_v2/orchestrator/service.py"] },
  { route_id: "A2_PATTERN_ROUTE", skill_id: "A2_PATTERN_TRACKER", website_output_type: null, discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/a2/pattern_tracker.py"] },
  { route_id: "A2_TREND_PULLBACK_ROUTE", skill_id: "A2_TREND_PULLBACK", website_output_type: null, discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/a2/trend_pullback.py", "trading_os_v2/a2/service.py"] },
  { route_id: "A2_LEGACY_SHADOW_ROUTE", skill_id: "A2_LEGACY_HALF_HOUR_SHADOW", website_output_type: "A2_HALF_HOUR_FORECAST", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/orchestrator/service.py", "config/system.json"] },
  { route_id: "TS_ROUTE", skill_id: "TS_FORECAST", website_output_type: "TS_OUTPUT", discord_channels: ["ts"], discord_policy: "ALWAYS", source_files: ["trading_os_v2/orchestrator/service.py"] },
  { route_id: "TS_SWING_SCORECARD_ROUTE", skill_id: "TS_SWING_SCORECARD", website_output_type: null, discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/ts/settlement.py", "contracts/v1/ts-swing-scorecard.schema.json"] },
  { route_id: "COMMITTEE_ROUTE", skill_id: "COMMITTEE_FLOW_REVIEW", website_output_type: "COMMITTEE_OUTPUT", discord_channels: ["committee"], discord_policy: "ALWAYS", source_files: ["trading_os_v2/orchestrator/service.py"] },
  { route_id: "D_ROUTE", skill_id: "D_MANUAL_PLAN", website_output_type: "D_OUTPUT", discord_channels: ["d"], discord_policy: "ALWAYS", source_files: ["trading_os_v2/orchestrator/service.py"] },
  { route_id: "A3_REVIEW_ROUTE", skill_id: "A3_CONFLICT_REVIEW", website_output_type: "A3_REVIEW", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/orchestrator/service.py"] },
  { route_id: "A3_FINAL_ROUTE", skill_id: "A3_FINAL_DECISION", website_output_type: "A3_FINAL", discord_channels: ["a3", "owner"], discord_policy: "ALWAYS", source_files: ["trading_os_v2/orchestrator/service.py"] },
  { route_id: "OWNER_POSITION_ROUTE", skill_id: "OWNER_POSITION_SYNC", website_output_type: null, discord_channels: ["owner"], discord_policy: "ALWAYS", source_files: ["trading_os_v2/orchestrator/service.py", "trading_os_v2/a1/state.py"] },
  { route_id: "CODEX_GUARD_ROUTE", skill_id: "CODEX_HEALTH_GUARD", website_output_type: "CODEX_GUARD", discord_channels: ["a1", "owner"], discord_policy: "ON_FAULT", source_files: ["trading_os_v2/supervisor/service.py"] },
  { route_id: "CODEX_MANAGER_ROUTE", skill_id: "CODEX_MANAGER_AUDIT", website_output_type: "SCHEDULE_CHECKPOINT", discord_channels: [], discord_policy: "NONE", source_files: ["app/codex-manager.ts", "server/timeline-scheduler.ts"] },
  { route_id: "DAILY_REVIEW_ROUTE", skill_id: "DAILY_REVIEW_CLOSE", website_output_type: "SCHEDULE_CHECKPOINT", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/daily_review/service.py", "server/timeline-scheduler.ts"] },
  { route_id: "A1_LIVE_SHADOW_ROUTE", skill_id: "A1_LIVE_SHADOW", website_output_type: "A1_SHADOW_RESULT", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/a1/service.py", "server/live-shadow-runtime.ts"] },
  { route_id: "A2_LIVE_SHADOW_ROUTE", skill_id: "A2_LIVE_SHADOW", website_output_type: "A2_SHADOW_RESULT", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/a2/service.py", "server/live-shadow-runtime.ts"] },
  { route_id: "TS_LIVE_SHADOW_ROUTE", skill_id: "TS_LIVE_SHADOW", website_output_type: "TS_SHADOW_OUTPUT", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/agent_runtime/service.py", "server/live-shadow-runtime.ts"] },
  { route_id: "COMMITTEE_LIVE_SHADOW_ROUTE", skill_id: "COMMITTEE_LIVE_SHADOW", website_output_type: "COMMITTEE_SHADOW_OUTPUT", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/agent_runtime/service.py", "server/live-shadow-runtime.ts"] },
  { route_id: "D_LIVE_SHADOW_ROUTE", skill_id: "D_LIVE_SHADOW", website_output_type: "D_SHADOW_OUTPUT", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/agent_runtime/service.py", "server/live-shadow-runtime.ts"] },
  { route_id: "A3_REVIEW_LIVE_SHADOW_ROUTE", skill_id: "A3_REVIEW_LIVE_SHADOW", website_output_type: "A3_REVIEW_SHADOW", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/agent_runtime/service.py", "server/live-shadow-runtime.ts"] },
  { route_id: "A3_FINAL_LIVE_SHADOW_ROUTE", skill_id: "A3_FINAL_LIVE_SHADOW", website_output_type: "A3_FINAL_SHADOW", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/agent_runtime/service.py", "server/live-shadow-runtime.ts"] },
  { route_id: "CODEX_GUARD_LIVE_SHADOW_ROUTE", skill_id: "CODEX_GUARD_LIVE_SHADOW", website_output_type: "CODEX_GUARD_SHADOW", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/agent_runtime/service.py", "server/live-shadow-runtime.ts"] },
  { route_id: "TIMELINE_CHECKPOINT_ROUTE", skill_id: "TIMELINE_CHECKPOINT", website_output_type: "SCHEDULE_CHECKPOINT", discord_channels: [], discord_policy: "NONE", source_files: ["trading_os_v2/supervisor/service.py", "trading_os_v2/acceptance/service.py", "server/timeline-scheduler.ts"] },
] as const;

const RUN_STATUSES = ["STARTED", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "TIMED_OUT", "DATA_BLOCKED"] as const;
const OUTPUT_STATUSES = ["NOT_PRODUCED", "PRODUCED"] as const;
const DELIVERY_STATUSES = ["NOT_APPLICABLE", "NOT_ATTEMPTED", "PENDING", "DELIVERED", "FAILED"] as const;
type RunStatus = (typeof RUN_STATUSES)[number];
type OutputStatus = (typeof OUTPUT_STATUSES)[number];
type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type RunEvent = {
  ledger_format: typeof RUN_EVENT_FORMAT;
  ledger_version: typeof RUN_EVENT_VERSION;
  event_id: string;
  agent_id: string;
  skill_id: string;
  run_id: string;
  slot_id: string;
  channel: "PRODUCTION" | "SHADOW" | "SYSTEM";
  version: string;
  data_cutoff_at: string;
  event_at: string;
  status: RunStatus;
  output_status: OutputStatus;
  error: string | null;
  evidence_refs: string[];
  website_delivery: DeliveryStatus;
  discord_delivery: DeliveryStatus;
};
export type RunState = RunEvent & { received_at: string };
export type RunLedgerState = {
  agents: typeof AGENT_REGISTRY;
  skills: typeof SKILL_REGISTRY;
  routes: typeof OUTPUT_ROUTE_REGISTRY;
  eventCount: number;
  runs: RunState[];
};

export class RunLedgerError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = "RunLedgerError"; }
}

function invalid(code: string, message: string): never { throw new RunLedgerError(code, message); }
function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] { return typeof value === "string" && values.includes(value); }
function timestamp(value: unknown, field: string) {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) invalid("INVALID_FORMAT", `${field} 必须是 ISO 8601 时间`);
  return new Date(value).toISOString();
}
function identifier(value: unknown, field: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(value)) invalid("INVALID_FORMAT", `${field} 格式无效`);
  return value;
}

export function parseRunEvent(raw: string): RunEvent {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { invalid("INVALID_JSON", "运行事件不是有效 JSON，现有状态未改变"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("INVALID_FORMAT", "运行事件必须是对象");
  const event = value as Record<string, unknown>;
  const fields = ["ledger_format", "ledger_version", "event_id", "agent_id", "skill_id", "run_id", "slot_id", "channel", "version", "data_cutoff_at", "event_at", "status", "output_status", "error", "evidence_refs", "website_delivery", "discord_delivery"];
  if (Object.keys(event).length !== fields.length || fields.some((field) => !(field in event)) || Object.keys(event).some((field) => !fields.includes(field))) invalid("INVALID_FORMAT", "运行事件字段必须与 v1 完全一致");
  if (event.ledger_format !== RUN_EVENT_FORMAT || event.ledger_version !== RUN_EVENT_VERSION) invalid("UNSUPPORTED_VERSION", "只支持 TRADING_OS_AGENT_RUN_EVENT v1");
  const skill = SKILL_REGISTRY.find((item) => item.skill_id === event.skill_id);
  if (!skill || skill.agent_id !== event.agent_id) invalid("UNKNOWN_ROUTE", "agent_id 与 skill_id 不属于真实 V2 Registry");
  if (event.channel !== skill.channel) invalid("CHANNEL_MISMATCH", `${skill.skill_id} 必须上报 ${skill.channel}`);
  if (!isOneOf(event.status, RUN_STATUSES) || !isOneOf(event.output_status, OUTPUT_STATUSES) || !isOneOf(event.website_delivery, DELIVERY_STATUSES) || !isOneOf(event.discord_delivery, DELIVERY_STATUSES)) invalid("INVALID_FORMAT", "状态值不受支持");
  if (typeof event.version !== "string" || !event.version.trim() || event.version.length > 80) invalid("INVALID_FORMAT", "version 格式无效");
  if (event.error !== null && (typeof event.error !== "string" || !event.error.trim() || event.error.length > 2_000)) invalid("INVALID_FORMAT", "error 必须是 null 或 1–2000 字符");
  if (!Array.isArray(event.evidence_refs) || event.evidence_refs.length > 32 || event.evidence_refs.some((item) => typeof item !== "string" || !item.trim() || item.length > 500) || new Set(event.evidence_refs).size !== event.evidence_refs.length) invalid("INVALID_FORMAT", "evidence_refs 必须是最多 32 个唯一非空字符串");
  const route = OUTPUT_ROUTE_REGISTRY.find((item) => item.skill_id === skill.skill_id)!;
  if ((route.website_output_type === null) !== (event.website_delivery === "NOT_APPLICABLE")) invalid("INVALID_DELIVERY", "网站交付状态与 Output Route Registry 不一致");
  if (route.discord_policy === "NONE" && event.discord_delivery !== "NOT_APPLICABLE") invalid("INVALID_DELIVERY", "该 Skill 没有 Discord 输出路由");
  if (route.discord_policy === "ALWAYS" && event.discord_delivery === "NOT_APPLICABLE") invalid("INVALID_DELIVERY", "该 Skill 必须记录 Discord 交付状态");
  if (event.status === "SUCCEEDED") {
    if (event.output_status !== "PRODUCED" || event.evidence_refs.length === 0) invalid("RESULT_REQUIRED", "没有正式结果和证据引用不能标记 SUCCEEDED");
    if (event.website_delivery === "NOT_ATTEMPTED" || event.discord_delivery === "NOT_ATTEMPTED") invalid("INVALID_DELIVERY", "成功结果必须记录适用路由的交付结果");
  } else if (event.output_status !== "NOT_PRODUCED") invalid("INVALID_STATE", "非成功状态不能声称已产生正式结果");
  if ((event.status === "FAILED" || event.status === "TIMED_OUT" || event.status === "DATA_BLOCKED" || event.website_delivery === "FAILED" || event.discord_delivery === "FAILED") && event.error === null) invalid("ERROR_REQUIRED", "失败、超时或数据阻断必须记录 error");
  if ((event.website_delivery === "DELIVERED" || event.discord_delivery === "DELIVERED") && event.output_status !== "PRODUCED") invalid("INVALID_DELIVERY", "没有正式结果不能标记已送达");
  return {
    ledger_format: RUN_EVENT_FORMAT, ledger_version: RUN_EVENT_VERSION,
    event_id: identifier(event.event_id, "event_id"), agent_id: skill.agent_id, skill_id: skill.skill_id,
    run_id: identifier(event.run_id, "run_id"), slot_id: identifier(event.slot_id, "slot_id"), channel: skill.channel,
    version: (event.version as string).trim(), data_cutoff_at: timestamp(event.data_cutoff_at, "data_cutoff_at"), event_at: timestamp(event.event_at, "event_at"),
    status: event.status, output_status: event.output_status, error: event.error as string | null, evidence_refs: event.evidence_refs as string[],
    website_delivery: event.website_delivery, discord_delivery: event.discord_delivery,
  };
}

const STATUS_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  STARTED: ["RUNNING", "FAILED", "SKIPPED", "TIMED_OUT", "DATA_BLOCKED"], RUNNING: ["SUCCEEDED", "FAILED", "SKIPPED", "TIMED_OUT", "DATA_BLOCKED"],
  SUCCEEDED: ["SUCCEEDED"], FAILED: ["FAILED"], SKIPPED: ["SKIPPED"], TIMED_OUT: ["TIMED_OUT"], DATA_BLOCKED: ["DATA_BLOCKED"],
};
const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  NOT_APPLICABLE: ["NOT_APPLICABLE"], NOT_ATTEMPTED: ["NOT_ATTEMPTED", "PENDING", "DELIVERED", "FAILED"],
  PENDING: ["PENDING", "DELIVERED", "FAILED"], FAILED: ["FAILED", "PENDING", "DELIVERED"], DELIVERED: ["DELIVERED"],
};

export function validateRunTransition(previous: RunState | null, current: RunEvent) {
  if (!previous) {
    if (current.status !== "STARTED" && current.status !== "SKIPPED") invalid("ILLEGAL_TRANSITION", "新运行必须从 STARTED 或 SKIPPED 开始");
    return;
  }
  for (const field of ["agent_id", "skill_id", "run_id", "slot_id", "channel", "version", "data_cutoff_at"] as const) if (previous[field] !== current[field]) invalid("RUN_IDENTITY_CONFLICT", `运行过程中不能修改 ${field}`);
  if (Date.parse(current.event_at) <= Date.parse(previous.event_at)) invalid("OUT_OF_ORDER", "event_at 必须严格晚于上一事件");
  if (!STATUS_TRANSITIONS[previous.status].includes(current.status)) invalid("ILLEGAL_TRANSITION", `${previous.status} 不能变为 ${current.status}`);
  for (const field of ["website_delivery", "discord_delivery"] as const) if (!DELIVERY_TRANSITIONS[previous[field]].includes(current[field])) invalid("ILLEGAL_TRANSITION", `${field} 不能从 ${previous[field]} 变为 ${current[field]}`);
  if (previous.evidence_refs.some((reference) => !current.evidence_refs.includes(reference))) invalid("EVIDENCE_REGRESSION", "不能移除已经记录的证据引用");
}
