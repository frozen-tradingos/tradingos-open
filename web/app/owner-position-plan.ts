import type { PositionRiskCheck } from "../server/position-copilot.ts";
import type { ScheduleCheckpoint } from "./timeline-schedule.ts";
import { positionCheckSummary } from "./today-action.ts";
import { isNyseRegularSession, ptDateKey } from "./market-time.ts";

export type OwnerRiskRange = { basis: "OPTION_COST_RETURN"; review_loss_pct: number; upper_loss_pct: number; effect: "REVIEW_ONLY" };
export type OwnerHoldingIntent = { period: "ONE_TO_THREE_TRADING_DAYS"; review_on: string; effect: "REVIEW_ONLY" };

export type OwnerPositionPlanInput = {
  request_id: string; source_record_id: string; holding_id: string;
  original_logic: string; holding_period: string; invalidation_text: string; target_text: string;
  owner_risk_range?: OwnerRiskRange;
  stock_plan_source_id?: string;
  holding_intent?: OwnerHoldingIntent;
};
export type OwnerPositionIdentity = Pick<PositionRiskCheck["observations"][number], "holding_id" | "position_id" | "contract_id" | "symbol" | "option_type" | "expiration" | "strike" | "direction" | "quantity" | "average_cost">;
export type OwnerPositionHolding = OwnerPositionIdentity & { source_record_id: string; source_checked_at: string; source_account_as_of: string; evidence_status: "ARCHIVED_ONLY_NOT_CURRENT" };
export type OwnerPositionPlan = OwnerPositionPlanInput & {
  plan_version_id: string; supersedes_plan_version_id: string | null; recorded_at: string;
  source_mode: "OWNER_STATED"; historical_knowledge_status: "RECORDED_AFTER_OBSERVATION";
  source_checked_at: string; source_account_as_of: string; position_fingerprint: string; position: OwnerPositionIdentity; payload_sha256: string;
  binding_status: "MATCHED_LATEST_ARCHIVED" | "POSITION_CHANGED" | "POSITION_NOT_IN_LATEST" | "NO_POSITION_EVIDENCE";
  evidence_status: "ARCHIVED_ONLY_NOT_CURRENT";
  stock_plan_source?: { record_id: string; plan_id: string; raw_sha256: string; published_at: string; received_at: string; status: "APPROVED" | "CONDITIONAL"; relation: "OWNER_STATED_SOURCE_ONLY"; execution: "NOT_VERIFIED" };
};
export type OwnerRiskRangeReview = OwnerRiskRange & {
  holding_id: string; plan_version_id: string; symbol: string | null; source_record_id: string | null;
  status: "NOT_CURRENT" | "POSITION_CHANGED" | "BELOW_REVIEW_RANGE" | "REVIEW_RANGE_REACHED" | "LOSS_RANGE_EXCEEDED";
  exit_return_pct: number | null; checked_at: string | null; valid_until: string | null; automated_execution: false;
};
export type OwnerPositionPlanOverview = { holdings: OwnerPositionHolding[]; plans: OwnerPositionPlan[]; history: OwnerPositionPlan[]; latest_source_record_id: string | null; risk_reviews: OwnerRiskRangeReview[];
  stock_plan_sources?: Array<{ holding_id: string; record_id: string; symbol: string; status: "APPROVED" | "CONDITIONAL"; published_at: string; contract_id: string; option_type: "call" | "put"; expiration: string; strike: number }>;
};
export class OwnerPositionPlanError extends Error {
  status: 400 | 409;
  constructor(status: 400 | 409, message: string) { super(message); this.status = status; }
}

export function normalizeOwnerHoldingIntent(value: unknown): OwnerHoldingIntent {
  const intent = value as Record<string, unknown> | null;
  const review = typeof intent?.review_on === "string" ? intent.review_on : "", timestamp = Date.parse(`${review}T12:00:00Z`);
  if (!intent || typeof intent !== "object" || Array.isArray(intent) || Object.keys(intent).length !== 3 || Object.keys(intent).some((key) => !["period", "review_on", "effect"].includes(key))
    || intent.period !== "ONE_TO_THREE_TRADING_DAYS" || intent.effect !== "REVIEW_ONLY" || !/^\d{4}-\d{2}-\d{2}$/.test(review) || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString().slice(0, 10) !== review || !isNyseRegularSession(review)) throw new OwnerPositionPlanError(400, "holding_intent须明确选择1–3交易日意图和有效交易日复查日期；只能提醒复查");
  return { period: "ONE_TO_THREE_TRADING_DAYS", review_on: review, effect: "REVIEW_ONLY" };
}

export function normalizeOwnerPositionPlanInput(value: unknown): OwnerPositionPlanInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OwnerPositionPlanError(400, "Owner持仓计划字段无效");
  const input = value as Record<string, unknown>;
  const fields = ["request_id", "source_record_id", "holding_id", "original_logic", "holding_period", "invalidation_text", "target_text"];
  if (Object.keys(input).some((key) => !fields.includes(key) && !["owner_risk_range", "stock_plan_source_id", "holding_intent"].includes(key))) throw new OwnerPositionPlanError(400, "Owner持仓计划包含未知或缺少字段");
  for (const field of fields) if (typeof input[field] !== "string" || !input[field].trim() || input[field].length > 2_000) throw new OwnerPositionPlanError(400, `${field}必须为1至2000字符`);
  const result: OwnerPositionPlanInput = Object.fromEntries(fields.map((field) => [field, (input[field] as string).trim()])) as Omit<OwnerPositionPlanInput, "owner_risk_range" | "holding_intent">;
  result.request_id = result.request_id.toLowerCase();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.request_id)) throw new OwnerPositionPlanError(400, "request_id无效");
  if (!/^(?:checkpoint:timeline:position_monitor:\d{8}:\d{4}|live-shadow:\d{8}T\d{6}Z:A1)$/.test(result.source_record_id)) throw new OwnerPositionPlanError(400, "source_record_id必须绑定真实账户归档或分钟持仓检查");
  if (!/^holding-[a-f0-9]{24}$/.test(result.holding_id)) throw new OwnerPositionPlanError(400, "holding_id持仓身份无效");
  if (Object.hasOwn(input, "holding_intent")) result.holding_intent = normalizeOwnerHoldingIntent(input.holding_intent);
  if (Object.hasOwn(input, "stock_plan_source_id")) {
    if (typeof input.stock_plan_source_id !== "string" || input.stock_plan_source_id.length > 120 || input.stock_plan_source_id.trim() && !/^live-shadow:\d{8}T\d{6}Z:STOCK:[A-Z][A-Z0-9.]{0,9}$/.test(input.stock_plan_source_id.trim())) throw new OwnerPositionPlanError(400, "stock_plan_source_id必须是精确的本地个股计划记录ID");
    if (input.stock_plan_source_id.trim()) result.stock_plan_source_id = input.stock_plan_source_id.trim();
  }
  if (Object.hasOwn(input, "owner_risk_range")) {
    const range = input.owner_risk_range as Record<string, unknown> | null;
    if (!range || typeof range !== "object" || Array.isArray(range) || Object.keys(range).length !== 4 || Object.keys(range).some((key) => !["basis", "review_loss_pct", "upper_loss_pct", "effect"].includes(key))
      || range.basis !== "OPTION_COST_RETURN" || range.effect !== "REVIEW_ONLY" || typeof range.review_loss_pct !== "number" || !Number.isFinite(range.review_loss_pct)
      || typeof range.upper_loss_pct !== "number" || !Number.isFinite(range.upper_loss_pct) || range.review_loss_pct <= 0 || range.upper_loss_pct > 100 || range.review_loss_pct >= range.upper_loss_pct) throw new OwnerPositionPlanError(400, "owner_risk_range必须是0至100内递增的亏损复核区间；不是止损审批");
    result.owner_risk_range = { basis: "OPTION_COST_RETURN", review_loss_pct: range.review_loss_pct, upper_loss_pct: range.upper_loss_pct, effect: "REVIEW_ONLY" };
  }
  return result;
}

export function ownerPositionIdentity(row: OwnerPositionIdentity): OwnerPositionIdentity {
  return { holding_id: row.holding_id, position_id: row.position_id, contract_id: row.contract_id, symbol: row.symbol, option_type: row.option_type, expiration: row.expiration, strike: row.strike, direction: row.direction, quantity: row.quantity, average_cost: row.average_cost };
}

export function ownerPositionCards(overview: OwnerPositionPlanOverview, checkpoint: ScheduleCheckpoint | null, now: number) {
  const summary = positionCheckSummary(checkpoint, now);
  const observations = summary.check?.observations ?? [];
  const holdings = [...observations.map((row) => overview.holdings.find((archived) => archived.holding_id === row.holding_id && Date.parse(archived.source_checked_at) > Date.parse(summary.check!.checked_at)) ?? row), ...overview.holdings.filter((row) => !observations.some((observed) => observed.holding_id === row.holding_id))];
  let conflict = false;
  const rows = holdings.map((holding, index) => {
    const identity = ownerPositionIdentity(holding);
    const same = (row: OwnerPositionIdentity) => (Object.keys(identity) as Array<keyof OwnerPositionIdentity>).every((key) => row[key] === identity[key]);
    const observed = observations.filter((row) => row.holding_id === holding.holding_id);
    if (observed.length > 1 || observed.length === 1 && !same(observed[0])) conflict = true;
    const archived = overview.holdings.filter((row) => same(row));
    const archive = archived.length === 1 && observed.length <= 1 ? archived[0] : undefined;
    const plan = overview.plans.find((row) => row.holding_id === holding.holding_id);
    const matches = Boolean(archive && plan?.binding_status === "MATCHED_LATEST_ARCHIVED" && same(plan.position));
    return { holding, archive, observation: index < observations.length ? observations[index] : undefined, plan, matches,
      review: matches ? overview.risk_reviews.find((row) => row.holding_id === holding.holding_id && row.plan_version_id === plan?.plan_version_id) : undefined };
  });
  return { ...summary, current: summary.current && !conflict, title: conflict ? "持仓记录有变化，当前风险待重新核验" : summary.title, rows };
}

export function projectOwnerHoldingIntent(plan: OwnerPositionPlan | undefined, holding: OwnerPositionIdentity, now: number) {
  const unknown = { intent: null, status: "UNKNOWN", reason: "实际持有意图未知；不会从到期天数或文字说明推断。" } as const;
  if (!plan?.holding_intent || !Number.isFinite(now)) return unknown;
  if (plan.binding_status !== "MATCHED_LATEST_ARCHIVED" || plan.source_mode !== "OWNER_STATED" || !(Date.parse(plan.source_account_as_of) <= Date.parse(plan.source_checked_at) && Date.parse(plan.source_checked_at) <= Date.parse(plan.recorded_at) && Date.parse(plan.recorded_at) <= now)
    || !holding.contract_id || !holding.position_id || !holding.symbol || !holding.expiration || !["call", "put"].includes(holding.option_type ?? "") || !["long", "short"].includes(holding.direction ?? "")
    || !Number.isFinite(holding.strike) || holding.strike! <= 0 || !Number.isSafeInteger(holding.quantity) || holding.quantity! <= 0 || !Number.isFinite(holding.average_cost) || holding.average_cost! <= 0
    || (Object.keys(ownerPositionIdentity(holding)) as Array<keyof OwnerPositionIdentity>).some((key) => holding[key] !== plan.position[key])) return { ...unknown, reason: "计划时间或精确持仓身份未匹配，实际持有意图待重新确认。" };
  let intent: OwnerHoldingIntent;
  try { intent = normalizeOwnerHoldingIntent(plan.holding_intent); } catch { return unknown; }
  return { intent, status: ptDateKey(now) >= intent.review_on ? "REVIEW_DUE" as const : "PLANNED_REVIEW" as const,
    reason: "已记录1–3交易日意图；当前只作计划复查，尚无该计划的持有/退出判断。" };
}

// Owner preferences are review reminders, never D/A3 approval or a substitute stop-loss plan.
export function projectOwnerRiskRanges(plans: OwnerPositionPlan[], checkpoint: ScheduleCheckpoint | null, now: number): OwnerRiskRangeReview[] {
  const { check, current } = positionCheckSummary(checkpoint, now);
  return plans.flatMap((plan): OwnerRiskRangeReview[] => {
    if (!plan.owner_risk_range) return [];
    const base: OwnerRiskRangeReview = { ...plan.owner_risk_range, holding_id: plan.holding_id, plan_version_id: plan.plan_version_id, symbol: plan.position.symbol, source_record_id: checkpoint ? `checkpoint:${checkpoint.slot_id}` : null,
      status: "NOT_CURRENT", exit_return_pct: null, checked_at: check?.checked_at ?? null, valid_until: null, automated_execution: false };
    if (plan.binding_status !== "MATCHED_LATEST_ARCHIVED") return [{ ...base, status: "POSITION_CHANGED" }];
    if (!Number.isFinite(now) || !(Date.parse(plan.recorded_at) <= now) || !current || checkpoint?.status !== "SUCCEEDED" || !checkpoint.slot_id.startsWith("timeline:position_monitor:") || check?.account_status !== "LIVE") return [base];
    const matches = check.observations.filter((row) => row.holding_id === plan.holding_id), row = matches[0];
    const identity = row ? ownerPositionIdentity(row) : null;
    if (matches.length !== 1 || (Object.keys(plan.position) as Array<keyof OwnerPositionIdentity>).some((key) => plan.position[key] !== identity?.[key])) return [{ ...base, status: "POSITION_CHANGED" }];
    if (row.direction !== "long" || row.quote_status !== "LIVE" || !Number.isSafeInteger(row.quantity) || row.quantity! <= 0 || !Number.isFinite(row.average_cost) || row.average_cost! <= 0
      || !Number.isFinite(row.bid) || row.bid! <= 0 || !Number.isFinite(row.ask) || row.ask! < row.bid!) return [base];
    const exitReturn = Number(((row.bid! / row.average_cost! - 1) * 100).toFixed(6));
    if (!Number.isFinite(exitReturn)) return [base];
    const loss = Math.max(0, -exitReturn), range = plan.owner_risk_range;
    return [{ ...base, exit_return_pct: exitReturn, status: loss >= range.upper_loss_pct ? "LOSS_RANGE_EXCEEDED" : loss >= range.review_loss_pct ? "REVIEW_RANGE_REACHED" : "BELOW_REVIEW_RANGE",
      valid_until: new Date(Math.min(...[check.checked_at, check.account_as_of!, row.quote_as_of!].map((at) => Date.parse(at) + 120_000))).toISOString() }];
  });
}
