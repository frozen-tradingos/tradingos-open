import { exchangeDateKey, formatPtTime, isNyseRegularSession, latestCompletedNyseSession, MARKET_5M_MAX_AGE_SECONDS, mostRecentNyseRegularDate, nextNyseRegularDateAfter, nyseClosePtMinutes, ptDateKey, robinhoodSessionAt } from "./market-time.ts";
import { utcForPt } from "./timeline-schedule.ts";
import { STOCK_PATTERN_REGIMES, stockOptionGaps, stockPlanStructure, type StockPlanEvidence } from "./stock-manual-plan.ts";
import { isPaperOptionExpiration } from "../server/option-horizon.ts";
import { isKnownSpecialDay, type SpecialDay } from "./macro-event-learning.ts";
import { paperFallbackDirectionConflict, paperIndexResearchActive, paperSlotAccepts, validatePaperSelection, validatePaperOwnerReselection, type PaperSelectionCandidate, type PaperSelectionSource, type PaperOwnerReselection } from "./paper-selection.ts";
export { PAPER_CODEX_START_DATE } from "./paper-selection.ts";

export type PaperContract = { contract_id: string; chain_id: string; expiration: string; strike: number; option_type: "call" | "put"; multiplier: number };
type RawNumber = string | number | null;
export type PaperQuoteProof = { requested_at: string; received_at: string;
  instrument: { id: string; chain_id: string; chain_symbol: string; underlying_type: string; expiration_date: string; strike_price: RawNumber; type: string; state: string; tradability: string; trade_value_multiplier: RawNumber };
  quote: { instrument_id: string; bid_price: RawNumber; ask_price: RawNumber; mark_price: RawNumber; updated_at: string };
};
export type PaperChartPoint = { contract_id: string; begins_at: string; ends_at: string; close: number; retrieved_at: string; source: "ROBINHOOD"; interval: "5minute" };
export type PaperChartIssue = "TIMEOUT" | "READ_FAILED" | "NOT_FOUND" | "INVALID_BAR" | "WAIT_ROTATION" | "NO_COMPLETED_BAR";
export type PaperChartSnapshot = { entry: PaperChartPoint | null; latest: PaperChartPoint | null; checked_at: string; status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE"; entry_issue?: PaperChartIssue; latest_issue?: PaperChartIssue };
export type PaperQuote = { source: "ROBINHOOD"; contract_id: string; symbol: string; expiration: string; strike: number; option_type: "call" | "put"; bid: number; ask: number; quoted_at: string; mark?: number; proof?: PaperQuoteProof };
export type PaperRiskExit = {
  rule_version: "PAPER_RISK_EXIT_V1"; reason: "EARNINGS_WINDOW" | "OFFICIAL_MACRO_WINDOW" | "VERIFIED_MAJOR_EVENT"; decision_at: string;
  event_id: string; title: string; source: string; source_url: string | null; published_at: string | null; scheduled_for: string | null;
  session: "BMO" | "AMC" | "DMH" | "UNKNOWN" | null; source_observed_at: string; source_checked_at: string; scope: string;
};
type PaperEntryEvidence = Pick<StockPlanEvidence, "contract_version" | "entry_rule" | "received_at" | "symbol" | "direction" | "quote" | "bars" | "pattern" | "planning_context" | "global_risk">;
export type PaperEntryMarketEvidence = Pick<StockPlanEvidence, "bars" | "received_at"> & { source_ref: string; quote?: StockPlanEvidence["quote"]; pattern: (Pick<NonNullable<StockPlanEvidence["pattern"]>, "regime" | "direction"> & { source: "A2_CLASSIFY_PATTERN_V1" | "A2_PATTERN_TRACKER_V1" }) | null };
export type PaperEntryConfirmation = {
  version: "PAPER_ENTRY_CONDITIONS_V1"; scope: "SYSTEM_FROZEN_CONDITIONS_RESEARCH" | "CODEX_FROZEN_CONDITIONS_RESEARCH"; assessed_at: string;
  status: "CONFIRMED" | "NOT_CONFIRMED" | "INVALIDATED" | "CONFLICT" | "DATA_GAP";
  checks: Array<{ condition: "QUOTE" | "LEVELS" | "INVALIDATION" | "TRIGGER" | "BARS" | "STRUCTURE"; status: "PASS" | "FAIL" | "UNKNOWN" | "CONFLICT" | "STALE"; detail: string; evidence_at: string | null }>;
  levels: { entry: number | null; invalidation: number | null; target: number | null };
  market_evidence: PaperEntryMarketEvidence | null;
};
export type PaperFormalForecastReview = {
  scope?: "NEXT_SESSION_BACKGROUND"; summary?: string;
  assessed_at: string; status: "ALIGNED" | "CONFLICT" | "RANGE" | "UNAVAILABLE";
  context_status: "AVAILABLE" | "MISSING" | "INVALID" | "EXPIRED" | "REVIEW_DUE" | "NOT_STARTED" | "SYMBOL_NOT_COVERED";
  forecast_direction: "BULLISH" | "BEARISH" | "RANGE" | null; evidence_ref: string | null;
  source: null | { forecast_id: string; source_record_id: string; forecast_hash: string; observed_at: string; received_at: string; delivered_at: string;
    forecast_window: { horizon: string; start_at: string; end_at: string | null; end_condition: string }; next_validation_at: string };
};
export type PaperPlan = {
  plan_id: string; market_date: string; created_at: string; expires_at: string; symbol: string; direction: "BULLISH" | "BEARISH";
  contract: PaperContract;
  reference: { kind: "SIMULATED_REFERENCE"; ask: number; bid: number; quoted_at: string; recorded_at: string; quantity: 1; mark?: number; proof?: PaperQuoteProof };
  source: { evidence_id: string; snapshot_id: string; snapshot_hash: string; observed_at: string };
  why_watch: string[]; warnings: string[]; levels: { entry: number | null; invalidation: number | null; target: number | null };
  stop_loss_pct: -40 | -10; take_profit_pct: 30 | 10;
  threshold_policy?: { version: "SPECIAL_DAY_10_10_V1"; events: SpecialDay[] };
  entry_policy?: { version: "QUALIFIED_PAPER_ENTRY_V1" | "DAILY_PAPER_RESEARCH_V1" | "BASELINE_PAPER_RESEARCH_V1" | "CODEX_PAPER_RESEARCH_V1"; quality_version?: "PAPER_LIQUIDITY_V1"; evidence: PaperEntryEvidence; contract: StockPlanEvidence["contracts"][number] };
  entry_confirmation?: PaperEntryConfirmation;
  formal_forecast_review?: PaperFormalForecastReview;
  next_session_forecast_review?: PaperFormalForecastReview;
  selection_source?: PaperSelectionSource;
  owner_reselection?: PaperOwnerReselection;
  research_cohort?: "INDEX_CONDITIONS_V1";
  holding_intent?: { min_trading_days: 1; max_trading_days: 3; time_exit: "REVIEW_ONLY" };
  mode: "SHADOW"; automated_execution: false; executable: false; performance: "EXCLUDED";
};
export type PaperOwnerVoid = { ended_at: string; detail: string; owner_request_ref: string };
export type PaperEventPayloads = {
  ATTEMPT: { reasons: string[] };
  CREATED: { plan: PaperPlan };
  MARK: { quote: PaperQuote; estimated_return_pct: number; risk_exit?: PaperRiskExit; chart?: PaperChartSnapshot; entry_confirmation?: PaperEntryConfirmation; formal_forecast_review?: PaperFormalForecastReview; next_session_forecast_review?: PaperFormalForecastReview };
  GAP: { reasons: string[] };
  ENDED: { reason: "EXPIRATION"; ended_at: string; terminal_value: "UNKNOWN" } | { reason: "OBSERVATION_WINDOW"; policy: "PAPER_TRACKING_WINDOW_V1"; ended_at: string; terminal_value: "UNKNOWN" } | ({ reason: "OWNER_VOID"; terminal_value: "UNKNOWN" } & PaperOwnerVoid);
};
export type PaperPlanEvent = { [K in keyof PaperEventPayloads]: { event_id: string; plan_id: string; market_date: string; recorded_at: string; event_type: K; payload: PaperEventPayloads[K] } }[keyof PaperEventPayloads];
export type PaperPlanView = { plan: PaperPlan; status: "OBSERVING" | "DATA_GAP" | "EXPIRED" | "VOIDED" | "ARCHIVED"; owner_void?: PaperOwnerVoid; last_checked_at: string; latest_quote: PaperQuote | null; estimated_return_pct: number | null; highest_observed_return_pct: number | null; lowest_observed_return_pct: number | null; stop_observed: boolean; take_profit_observed: boolean; reasons: string[]; chart?: PaperChartSnapshot; latest_entry_confirmation?: PaperEntryConfirmation; latest_formal_forecast_review?: PaperFormalForecastReview; latest_next_session_forecast_review?: PaperFormalForecastReview; tracking?: ReturnType<typeof projectPaperTracking>; window_research?: PaperWindowResearch };
type PaperWindowObservation = { quoted_at: string; recorded_at: string; bid: number; return_pct: number };
export type PaperWindowResearch = { ends_at: string; recovery_after_loss: PaperWindowObservation | null; target_after_loss: PaperWindowObservation | null; best_return_pct: number | null; worst_return_pct: number | null; gap_observed: boolean };
export type PaperExitReason = "TAKE_PROFIT" | "STOP_LOSS" | PaperRiskExit["reason"];
export type PaperRuleResult = { plan_id: string; status: "WIN" | "LOSS" | "FLAT" | "PENDING" | "UNKNOWN"; owner_void?: PaperOwnerVoid; event_id: string | null; recorded_at: string | null; quoted_at: string | null; bid: number | null; return_pct: number | null; pnl: number | null; gap_before_result: boolean; exit_reason: PaperExitReason | null; risk_exit: PaperRiskExit | null };
export type PaperLearningStats = { total: number; wins: number; losses: number; flats: number; risk_exits: number; pending: number; unknown: number; voided?: number; resolved_days: number; win_rate_pct: number | null; average_return_pct: number | null; profit_factor: number | null; gap_count: number; average_entry_spread_pct: number | null };
export type PaperLearning = { rule: "FIRST_OBSERVED_30_OR_MINUS_40_OR_RISK_EXIT_V2" | "FIRST_OBSERVED_PLAN_THRESHOLDS_OR_RISK_EXIT_V3"; summary: PaperLearningStats; groups: Array<{ dimension: "DIRECTION" | "ENTRY_SPREAD" | "DTE" | "EXIT_REASON" | "RISK_POLICY" | "ENTRY_POLICY" | "RESEARCH_COHORT"; label: string; stats: PaperLearningStats }>; recent_results: PaperRuleResult[];
  eligible_summary?: PaperLearningStats; current_round?: { start_date: string; summary: PaperLearningStats; eligible_summary?: PaperLearningStats; groups: PaperLearning["groups"] }; archived_summary?: PaperLearningStats };
export type PaperPlanOverview = { mode: "SHADOW"; executable: false; performance: "EXCLUDED"; checked_at: string; plans: PaperPlanView[]; latest_attempt: PaperPlanEvent | null; learning?: PaperLearning };

export const PAPER_DAILY_TARGET = 3;
export const PAPER_RESEARCH_START_DATE = "2026-09-14";
export const PAPER_ENTRY_QUALITY_START_AT = "2026-09-25T15:58:00.000Z";
export const paperEntryQualityActive = (at: string) => Date.parse(at) >= Date.parse(PAPER_ENTRY_QUALITY_START_AT);
export function paperReportingDay(currentTime: number) {
  if (!(currentTime > 0) || !Number.isFinite(new Date(currentTime).getTime())) return null;
  const today = ptDateKey(currentTime), date = mostRecentNyseRegularDate(today);
  return { date, label: date === today ? "今日" : `最近交易日 ${date}` };
}
export function paperPlanId(marketDate: string, ordinal = 1) {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > PAPER_DAILY_TARGET) throw new Error("模拟票编号超出每日目标");
  return `paper-plan:${marketDate}${ordinal === 1 ? "" : `:${ordinal}`}`;
}
const validPlanId = (id: string, day: string) => Array.from({ length: PAPER_DAILY_TARGET }, (_, index) => paperPlanId(day, index + 1)).some((base) => id === base || id.startsWith(`${base}:reselect:`) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id.slice(base.length + 10)));
export const paperReturnPct = (plan: { reference: { ask: number } }, bid: number) => Number(((bid / plan.reference.ask - 1) * 100).toFixed(6));
export function paperExpiryClose(expiration: string) {
  const close = nyseClosePtMinutes(expiration);
  return utcForPt(expiration, `${Math.floor(close / 60)}:${String(close % 60).padStart(2, "0")}`).toISOString();
}

/** Sampling policy only: never changes the original holding intent, exit or expiry. */
export function paperTrackingWindow(plan: PaperPlan) {
  const created = new Date(plan.created_at), day = new Date(`${ptDateKey(created)}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 7);
  const clock = `${formatPtTime(created)}:${String(created.getUTCSeconds()).padStart(2, "0")}`;
  const week = utcForPt(day.toISOString().slice(0, 10), clock).getTime() + created.getUTCMilliseconds();
  const ends_at = new Date(Math.min(week, Date.parse(plan.expires_at))).toISOString();
  const thirdDay = nextNyseRegularDateAfter(nextNyseRegularDateAfter(plan.market_date));
  return { policy: "PAPER_TRACKING_WINDOW_V1" as const, focus_ends_at: new Date(Math.min(Date.parse(paperExpiryClose(thirdDay)), Date.parse(ends_at))).toISOString(), ends_at };
}

export function projectPaperTracking(plan: PaperPlan, events: PaperPlanEvent[], at: string) {
  const window = paperTrackingWindow(plan), time = Date.parse(at), day = ptDateKey(at);
  const close = Date.parse(paperExpiryClose(day)), researchWindow = isNyseRegularSession(day) && time >= close - 60 * 60_000 && time < close;
  const history = events.filter((event) => event.plan_id === plan.plan_id && Date.parse(event.recorded_at) <= time);
  const ending = history.find((event) => event.event_type === "ENDED");
  const settled = history.some((event) => event.event_type === "MARK" && paperMarkExitReason(plan, event) !== null);
  const reason = ending?.event_type === "ENDED" ? ending.payload.reason : time >= Date.parse(plan.expires_at) ? "EXPIRATION" : time >= Date.parse(window.ends_at) ? "OBSERVATION_WINDOW" : settled && day !== plan.market_date ? "FIRST_RULE_RESULT" : time >= Date.parse(window.focus_ends_at) ? "FOCUS_WINDOW_ENDED" : "ACTIVE";
  const stage = ["EXPIRATION", "OBSERVATION_WINDOW", "OWNER_VOID"].includes(reason) ? "ENDED" : reason === "ACTIVE" ? "FOCUS" : "RESEARCH";
  const daily_attempted = history.some((event) => (event.event_type === "MARK" || event.event_type === "GAP") && ptDateKey(event.recorded_at) === day && Date.parse(event.recorded_at) >= close - 60 * 60_000);
  return { ...window, stage: stage as "FOCUS" | "RESEARCH" | "ENDED", reason, daily_attempted, research_due: stage === "RESEARCH" && researchWindow && !daily_attempted };
}

const time = (value: unknown): value is string => typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const messages = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(text);
const fresh = (value: unknown, at: string) => time(value) && Date.parse(at) >= Date.parse(value) && Date.parse(at) - Date.parse(value) <= 120_000;
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(`模拟观察记录无效：${message}`); }
const calendarDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const httpsSource = (value: unknown) => { try { const url = new URL(String(value)); return url.protocol === "https:" && !!url.hostname && !url.username && !url.password; } catch { return false; } };

/** Research evidence only: a daily sample is still created when entry conditions are not confirmed. */
export function assessPaperEntryConditions(e: PaperEntryEvidence, at: string, market: PaperEntryMarketEvidence | null = null, conditions?: PaperSelectionCandidate["entry_conditions"]): PaperEntryConfirmation {
  const checks: PaperEntryConfirmation["checks"] = [], context = e.planning_context, bullish = e.direction === "BULLISH";
  const add = (condition: PaperEntryConfirmation["checks"][number]["condition"], status: PaperEntryConfirmation["checks"][number]["status"], detail: string, evidence_at: string | null) => checks.push({ condition, status, detail, evidence_at });
  const useMarketQuote = market?.quote && Date.parse(market.quote.as_of ?? "") >= Date.parse(e.quote.as_of ?? "");
  const now = Date.parse(at), day = exchangeDateKey(at), q = useMarketQuote ? market.quote! : e.quote, quoteReceipt = useMarketQuote ? market.received_at : e.received_at;
  const quoteCurrent = q.source === "ROBINHOOD" && q.symbol === e.symbol && q.status === "LIVE" && positive(q.last) && positive(q.bid) && positive(q.ask) && q.ask >= q.bid
    && fresh(q.as_of, at) && exchangeDateKey(q.as_of!) === day && robinhoodSessionAt(q.as_of!).phase === "REGULAR" && Date.parse(q.as_of!) <= Date.parse(quoteReceipt) && Date.parse(quoteReceipt) <= now;
  add("QUOTE", quoteCurrent ? "PASS" : "STALE", quoteCurrent ? "同标的新鲜真实报价" : "标的报价缺失、陈旧或身份/时间不符", q.as_of);
  const frame = context?.timeframes.four_hour;
  const directionalContext = frame?.available && ["BULLISH", "BEARISH"].includes(frame.direction);
  const conflict = Boolean(directionalContext && frame!.direction !== e.direction || conditions && (conditions.entry !== context?.entry_trigger || conditions.invalidation !== context?.invalidation_price || conditions.target !== context?.target_price));
  const contextKnown = Boolean(context && time(context.observed_at) && Date.parse(context.observed_at) <= Date.parse(e.received_at) && Date.parse(context.observed_at) <= now
    && exchangeDateKey(context.observed_at) >= latestCompletedNyseSession(e.received_at) && frame?.data_cutoff && time(frame.data_cutoff) && Date.parse(frame.data_cutoff) + 14_400_000 <= Date.parse(context.observed_at));
  const validLevels = Boolean(conditions !== null && contextKnown && directionalContext && !conflict && positive(context!.entry_trigger) && positive(context!.invalidation_price) && positive(context!.target_price)
    && (bullish ? context!.invalidation_price! < context!.entry_trigger! && context!.entry_trigger! < context!.target_price! : context!.target_price! < context!.entry_trigger! && context!.entry_trigger! < context!.invalidation_price!));
  const levels = validLevels ? { entry: context!.entry_trigger, invalidation: context!.invalidation_price, target: context!.target_price } : { entry: null, invalidation: null, target: null };
  add("LEVELS", conflict ? "CONFLICT" : validLevels ? "PASS" : "UNKNOWN", conflict ? "拟研究方向或Codex选定价位与原冻结结构冲突，未替换原条件" : validLevels ? conditions ? "Codex已选择输入中同向冻结条件，逐数字绑定原证据" : "复用当时已完成且同向的系统冻结价位；不是Codex自定或作者原话" : "缺少当时已知、同向且有序的冻结触发/失效/目标", context?.observed_at ?? null);
  const invalidated = quoteCurrent && validLevels && (bullish ? q.last! <= levels.invalidation! : q.last! >= levels.invalidation!);
  add("INVALIDATION", quoteCurrent && validLevels ? invalidated ? "FAIL" : "PASS" : "UNKNOWN", invalidated ? "真实现价已达到原冻结失效价" : quoteCurrent && validLevels ? "现价尚未达到原冻结失效价" : "报价或原失效价不可核验", q.as_of);
  const trigger = quoteCurrent && validLevels && (bullish ? q.last! >= levels.entry! : q.last! <= levels.entry!);
  add("TRIGGER", quoteCurrent && validLevels ? trigger ? "PASS" : "FAIL" : "UNKNOWN", trigger ? "现价位于触发位确认侧；仍须完整K线确认" : quoteCurrent && validLevels ? "现价尚未位于原触发位确认侧" : "报价或原触发位不可核验", q.as_of);
  const m = market ?? { bars: e.bars, pattern: e.pattern, received_at: e.received_at, source_ref: "FROZEN_ENTRY_EVIDENCE" };
  const b = m.bars, early = e.entry_rule === "MULTI_TIMEFRAME_BREAK_HOLD_V1", received = Date.parse(m.received_at);
  const barsKnown = text(m.source_ref) && time(m.received_at) && received <= now && b.source === "ROBINHOOD" && b.symbol === e.symbol && b.interval === "5min"
    && time(b.as_of) && Date.parse(b.as_of) <= received && Array.isArray(b.values) && b.values.length >= (early ? 5 : 18) && b.values.length <= 78
    && (!early || Date.parse(b.values[0].begins_at) === utcForPt(day, "06:30").getTime()) && b.values.every((bar, index) => {
      const start = Date.parse(bar.begins_at);
      return [bar.open, bar.high, bar.low, bar.close].every(positive) && nonnegative(bar.volume) && bar.low! <= Math.min(bar.open!, bar.close!) && bar.high! >= Math.max(bar.open!, bar.close!)
        && start % 300_000 === 0 && start + 330_000 <= received && exchangeDateKey(start) === day && robinhoodSessionAt(start).phase === "REGULAR"
        && (!index || start - Date.parse(b.values[index - 1].begins_at) === 300_000);
    }) && Date.parse(b.as_of) === Date.parse(b.values.at(-1)!.begins_at) + 300_000;
  const barsCurrent = barsKnown && now - Date.parse(b.as_of!) <= MARKET_5M_MAX_AGE_SECONDS * 1_000;
  add("BARS", barsCurrent ? "PASS" : barsKnown ? "STALE" : "UNKNOWN", barsCurrent ? "同标的、同日连续已完成5分钟K线，收盘后至少30秒且当时已收到" : barsKnown ? "完整K线已陈旧" : "同标的连续完整K线缺失，或来源/接收时间不可核验", b.as_of);
  const patternKnown = m.pattern && ["A2_CLASSIFY_PATTERN_V1", "A2_PATTERN_TRACKER_V1"].includes(m.pattern.source) && STOCK_PATTERN_REGIMES.includes(m.pattern.regime) && m.pattern.regime !== "UNKNOWN" && ["bullish", "bearish", "neutral", "unknown"].includes(m.pattern.direction);
  const structure = barsCurrent && validLevels && patternKnown ? stockPlanStructure({ ...e, bars: b, pattern: m.pattern, received_at: m.received_at }) : null;
  add("STRUCTURE", structure ? structure.eligible ? "PASS" : "FAIL" : "UNKNOWN", structure ? structure.eligible ? "原stockPlanStructure突破与下一根保持条件已通过" : structure.gaps.join("；") : "完整K线、原A2盘型或同向冻结条件不全，无法确认突破保持", b.as_of);
  const status: PaperEntryConfirmation["status"] = invalidated ? "INVALIDATED" : conflict ? "CONFLICT" : checks.some((item) => item.status === "STALE" || item.status === "UNKNOWN") ? "DATA_GAP" : checks.every((item) => item.status === "PASS") ? "CONFIRMED" : "NOT_CONFIRMED";
  return { version: "PAPER_ENTRY_CONDITIONS_V1", scope: conditions === undefined ? "SYSTEM_FROZEN_CONDITIONS_RESEARCH" : "CODEX_FROZEN_CONDITIONS_RESEARCH", assessed_at: at, status, checks, levels, market_evidence: market ? structuredClone(market) : null };
}

export function assessPaperPlanEntryConditions(plan: PaperPlan, at: string, market: PaperEntryMarketEvidence | null = null) {
  const conditions = plan.selection_source?.kind === "CODEX" ? plan.selection_source.candidates.find((row) => row.symbol === plan.symbol && row.direction === plan.direction)?.entry_conditions : undefined;
  return plan.entry_policy ? assessPaperEntryConditions(plan.entry_policy.evidence, at, market, conditions) : undefined;
}

function validatePaperFormalForecastReview(review: PaperFormalForecastReview, plan: PaperPlan, at: string, background = false) {
  check(review && review.assessed_at === at && ["AVAILABLE", "MISSING", "INVALID", "EXPIRED", "REVIEW_DUE", "NOT_STARTED", "SYMBOL_NOT_COVERED"].includes(review.context_status), "正式短线对照的核验时刻和状态");
  check(background ? review.scope === "NEXT_SESSION_BACKGROUND" : review.scope === undefined, "隔夜背景与盘中短线对照必须分开");
  if (review.summary !== undefined) check(background && review.context_status === "AVAILABLE" && text(review.summary) && review.summary.length <= 4000, "背景原文摘要须有界且当前可用");
  const s = review.source;
  if (s) {
    check(["SPY", "QQQ"].includes(plan.symbol) && text(s.forecast_id) && /^live-shadow:\d{8}T\d{6}Z:TS$/.test(s.source_record_id) && /^[a-f0-9]{64}$/.test(s.forecast_hash), "正式短线对照须为同指数自然预测原文");
    const times = [s.observed_at, s.received_at, s.delivered_at, at];
    check(times.every(time) && times.every((stamp, i) => !i || Date.parse(stamp) >= Date.parse(times[i - 1])) && (background || exchangeDateKey(s.observed_at) === exchangeDateKey(at)), "正式短线对照必须已交付且当时已知");
    check(s.forecast_window && (background ? ["NEXT_REGULAR_SESSION", "NEXT_REGULAR_SESSION_AND_WEEK"] : ["OPEN_TO_60_MINUTES", "NEXT_30_TO_60_MINUTES"]).includes(s.forecast_window.horizon) && time(s.forecast_window.start_at) && (s.forecast_window.end_at === null || time(s.forecast_window.end_at)) && time(s.next_validation_at), "正式短线原窗口与复核时间");
    if (background) check(["AT_TIMESTAMP", "NEXT_REGULAR_SESSION_CLOSE", "NEXT_FIVE_REGULAR_SESSIONS_CLOSE"].includes(s.forecast_window.end_condition), "背景须保留原次日窗口结束合同");
  }
  if (review.context_status === "AVAILABLE") {
    check(s && review.evidence_ref === `${background ? "next-session-ts" : "formal-ts"}:${s.forecast_id}:${plan.symbol}` && ["BULLISH", "BEARISH", "RANGE"].includes(review.forecast_direction!)
      && (background ? nextNyseRegularDateAfter(ptDateKey(s.observed_at)) === ptDateKey(at) && Date.parse(at) >= Date.parse(s.forecast_window.start_at)
          && (s.forecast_window.end_at === null || Date.parse(at) < Date.parse(s.forecast_window.end_at)) && Date.parse(at) < Date.parse(paperExpiryClose(ptDateKey(at)))
        : Date.parse(at) >= Date.parse(s.forecast_window.start_at) && (s.forecast_window.end_at === null || Date.parse(at) < Date.parse(s.forecast_window.end_at)) && Date.parse(at) < Date.parse(s.next_validation_at)), "只在原期限内对照同标的方向");
    check(review.status === (review.forecast_direction === "RANGE" ? "RANGE" : review.forecast_direction === plan.direction ? "ALIGNED" : "CONFLICT"), "短线/持有方向关系不得冒充入场确认");
  } else check(review.status === "UNAVAILABLE" && review.forecast_direction === null && review.evidence_ref === null, "缺失或过期预测不作方向确认");
}

export function validatePaperQuoteProof(quote: { bid: number; ask: number; quoted_at: string; mark?: number; proof?: PaperQuoteProof }, plan: Pick<PaperPlan, "symbol" | "contract">, recordedAt: string) {
  if (quote.mark !== undefined) check(nonnegative(quote.mark), "真实Mark价格");
  if (quote.proof === undefined) return;
  const p = quote.proof, i = p?.instrument, q = p?.quote, c = plan.contract;
  const raw = (value: unknown) => typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN;
  check(p && time(p.requested_at) && time(p.received_at) && Date.parse(p.requested_at) <= Date.parse(p.received_at) && Date.parse(p.received_at) <= Date.parse(recordedAt) && fresh(quote.quoted_at, p.received_at), "原始报价请求与接收时间");
  check(i && i.id === c.contract_id && i.chain_id === c.chain_id && i.chain_symbol === plan.symbol && i.underlying_type === "equity" && i.expiration_date === c.expiration && raw(i.strike_price) === c.strike && i.type === c.option_type && i.state === "active" && i.tradability === "tradable" && raw(i.trade_value_multiplier) === c.multiplier, "原始合约身份");
  check(q && q.instrument_id === c.contract_id && raw(q.bid_price) === quote.bid && raw(q.ask_price) === quote.ask && time(q.updated_at) && Date.parse(q.updated_at) === Date.parse(quote.quoted_at) && (quote.mark === undefined || raw(q.mark_price) === quote.mark), "原始报价与采样一致");
}

function validateChart(chart: PaperChartSnapshot, plan: PaperPlan, recordedAt: string) {
  check(chart && time(chart.checked_at) && Date.parse(chart.checked_at) >= Date.parse(plan.created_at) && Date.parse(chart.checked_at) <= Date.parse(recordedAt), "图表核对时间");
  for (const [key, point] of [["entry", chart.entry], ["latest", chart.latest]] as const) {
    const issue = chart[`${key}_issue`];
    if (issue !== undefined) check(point === null && ["TIMEOUT", "READ_FAILED", "NOT_FOUND", "INVALID_BAR", "WAIT_ROTATION", "NO_COMPLETED_BAR"].includes(issue), "图表缺口原因");
    if (point === null) continue;
    check(point && point.source === "ROBINHOOD" && point.interval === "5minute" && point.contract_id === plan.contract.contract_id && nonnegative(point.close) && time(point.begins_at) && time(point.ends_at) && time(point.retrieved_at), "精确合约五分钟图点");
    const start = Date.parse(point.begins_at), end = Date.parse(point.ends_at), receipt = Date.parse(point.retrieved_at);
    check(start % 300_000 === 0 && end === start + 300_000 && end <= receipt && receipt <= Date.parse(chart.checked_at) && robinhoodSessionAt(point.begins_at).phase === "REGULAR" && end <= Date.parse(paperExpiryClose(exchangeDateKey(point.begins_at))) && end <= Date.parse(plan.expires_at), "已完成正常时段图点");
    check(key === "entry" ? start === Math.floor(Date.parse(plan.reference.quoted_at) / 300_000) * 300_000 : end <= Math.floor(Date.parse(chart.checked_at) / 300_000) * 300_000 && Date.parse(chart.checked_at) - end < 600_000, "图点与原始报价或当前完整柱对应");
  }
  check(chart.status === (chart.entry && chart.latest ? "AVAILABLE" : chart.entry || chart.latest ? "PARTIAL" : "UNAVAILABLE"), "图表核对状态");
}

export function paperChartComparison(plan: PaperPlan, chart: PaperChartSnapshot | undefined, at: number) {
  if (!chart || !Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) return null;
  try { validateChart(chart, plan, new Date(at).toISOString()); } catch { return null; }
  const { entry, latest } = chart;
  if (!entry || !latest || entry.close <= 0 || Date.parse(latest.begins_at) < Date.parse(entry.begins_at)) return null;
  const units = positive(plan.contract.multiplier) && positive(plan.reference.quantity) ? plan.contract.multiplier * plan.reference.quantity : null;
  return { entry, latest, return_pct: (latest.close / entry.close - 1) * 100, pnl: units === null ? null : (latest.close - entry.close) * units };
}

function validateBaselineResearch(e: PaperEntryEvidence, at: string, codex = false) {
  check(e && e.contract_version === "stock-plan-v2" && fresh(e.received_at, at), "原方向研究证据版本与接收时间");
  const q = e.quote, context = e.planning_context;
  check(q && q.source === "ROBINHOOD" && q.symbol === e.symbol && q.status === "LIVE" && positive(q.last) && fresh(q.as_of, at) && Date.parse(q.as_of!) <= Date.parse(e.received_at), "当前真实标的报价");
  check(context && time(context.observed_at) && Date.parse(context.observed_at) <= Date.parse(e.received_at) && exchangeDateKey(context.observed_at) >= latestCompletedNyseSession(at) && messages(context.why_watch) && context.why_watch.length && Object.values(context.timeframes).some((frame) => frame.available && (codex || frame.direction === e.direction) && time(frame.data_cutoff)) && Object.values(context.timeframes).every((frame) => !frame.data_cutoff || time(frame.data_cutoff) && Date.parse(frame.data_cutoff) <= Date.parse(context.observed_at)), "近期真实冻结分析依据");
  check(e.global_risk && messages(e.global_risk.critical_blockers) && messages(e.global_risk.new_entry_blockers), "研究风险提示格式");
}

function baselineContractIssues(e: Pick<PaperEntryEvidence, "symbol" | "direction" | "received_at">, c: StockPlanEvidence["contracts"][number], at: string) {
  const date = exchangeDateKey(at);
  const reasons: string[] = [];
  if (!(text(c.contract_id) && text(c.instrument.chain_id) && positive(c.strike) && c.option_type === (e.direction === "BULLISH" ? "call" : "put") && c.instrument.chain_symbol === e.symbol && c.instrument.type === c.option_type && c.instrument.expiration_date === c.expiration && c.instrument.strike_price === c.strike && c.instrument.state === "active" && c.instrument.tradability === "tradable" && positive(c.instrument.trade_value_multiplier))) reasons.push("CONTRACT_IDENTITY_INVALID");
  if (!(isNyseRegularSession(c.expiration) && c.expiration >= date)) reasons.push("CONTRACT_EXPIRATION_INVALID");
  if (!(fresh(c.as_of, at) && robinhoodSessionAt(c.as_of!).phase === "REGULAR" && exchangeDateKey(c.as_of!) === date && Date.parse(c.as_of!) <= Date.parse(e.received_at))) reasons.push("CONTRACT_QUOTE_NOT_CURRENT");
  if (!(nonnegative(c.bid) && positive(c.ask) && c.ask >= c.bid)) reasons.push("CONTRACT_BID_ASK_INVALID");
  return reasons;
}
const baselineContract = (e: Pick<PaperEntryEvidence, "symbol" | "direction" | "received_at">, c: StockPlanEvidence["contracts"][number], at: string) => !baselineContractIssues(e, c, at).length;

function validateDailyResearch(e: PaperEntryEvidence, at: string) {
  check(e && e.contract_version === "stock-plan-v2" && fresh(e.received_at, at) && exchangeDateKey(e.received_at) === exchangeDateKey(at), "每日研究证据版本与接收时间");
  const q = e.quote, context = e.planning_context;
  check(q && q.source === "ROBINHOOD" && q.symbol === e.symbol && q.status === "LIVE" && positive(q.last) && positive(q.bid) && positive(q.ask) && q.ask >= q.bid && fresh(q.as_of, at) && Date.parse(q.as_of!) <= Date.parse(e.received_at) && exchangeDateKey(q.as_of!) === exchangeDateKey(at) && robinhoodSessionAt(q.as_of!).phase === "REGULAR", "同日新鲜标的报价");
  check(context && time(context.observed_at) && Date.parse(context.observed_at) <= Date.parse(e.received_at) && exchangeDateKey(context.observed_at) >= latestCompletedNyseSession(at) && messages(context.why_watch) && context.why_watch.length && Object.values(context.timeframes).some((frame) => frame.available && frame.direction === e.direction && time(frame.data_cutoff)) && Object.values(context.timeframes).every((frame) => !frame.data_cutoff || time(frame.data_cutoff) && Date.parse(frame.data_cutoff) <= Date.parse(context.observed_at)), "每日研究须有近期真实同向分析依据");
  check(e.global_risk && messages(e.global_risk.critical_blockers) && messages(e.global_risk.new_entry_blockers), "研究风险提示格式");
}

function validateQualifiedEntry(e: PaperEntryEvidence, at: string) {
  check(e && e.contract_version === "stock-plan-v2" && e.entry_rule === "MULTI_TIMEFRAME_BREAK_HOLD_V1" && fresh(e.received_at, at) && exchangeDateKey(e.received_at) === exchangeDateKey(at), "当前入场证据版本与接收时间");
  const q = e.quote, b = e.bars, context = e.planning_context;
  check(q && q.source === "ROBINHOOD" && q.symbol === e.symbol && q.status === "LIVE" && positive(q.last) && positive(q.bid) && positive(q.ask) && q.ask >= q.bid && fresh(q.as_of, at) && Date.parse(q.as_of!) <= Date.parse(e.received_at) && exchangeDateKey(q.as_of!) === exchangeDateKey(at) && robinhoodSessionAt(q.as_of!).phase === "REGULAR", "同日新鲜标的报价");
  check(b && b.source === "ROBINHOOD" && b.symbol === e.symbol && b.interval === "5min" && time(b.as_of) && Date.parse(b.as_of) <= Date.parse(e.received_at) && Date.parse(at) - Date.parse(b.as_of) <= MARKET_5M_MAX_AGE_SECONDS * 1_000 && Array.isArray(b.values) && b.values.length <= 78, "当前完整K线缺失、过期或身份不符");
  check(context && time(context.observed_at) && exchangeDateKey(context.observed_at) >= latestCompletedNyseSession(at) && ["daily", "four_hour", "one_hour", "thirty_minute"].every((key, index) => context.timeframes?.[key as keyof typeof context.timeframes]?.timeframe === ["1d", "4h", "1h", "30m"][index]) && Object.keys(context.timeframes).length === 4, "冻结四周期结构不完整");
  check(e.pattern?.source === "A2_CLASSIFY_PATTERN_V1" && ["TREND_UP", "TREND_DOWN", "NARROW_RANGE", "WIDE_CHOP", "V_REVERSAL_UP", "V_REVERSAL_DOWN", "FALSE_BREAKOUT", "FALSE_BREAKDOWN", "TRANSITION", "UNKNOWN"].includes(e.pattern.regime), "当前个股盘型来源");
  const structure = stockPlanStructure(e);
  check(structure.eligible, structure.gaps.join("；"));
  check(positive(structure.invalidation_price) && (e.direction === "BULLISH" ? q.last > structure.invalidation_price : q.last < structure.invalidation_price), "真实现价已达到原观察失效价");
  check(positive(structure.break_level) && (e.direction === "BULLISH" ? q.last >= structure.break_level : q.last <= structure.break_level), "当前个股报价已失去刚确认的突破保持位置");
  check(e.global_risk && fresh(e.global_risk.checked_at, at) && Date.parse(e.global_risk.checked_at) <= Date.parse(e.received_at) && messages(e.global_risk.critical_blockers) && messages(e.global_risk.new_entry_blockers), "当前全局风险检查缺失或过期");
  check(!e.global_risk.critical_blockers.length && !e.global_risk.new_entry_blockers.length, `当前全局阻断：${[...e.global_risk.critical_blockers, ...e.global_risk.new_entry_blockers].join("；")}`);
}

/** The same entry gates qualify the model's input and its freshly quoted exact choice. */
export function assessPaperContracts(e: StockPlanEvidence, at: string, specialDays: SpecialDay[], independentDirection = false): { contracts: StockPlanEvidence["contracts"]; reasons: string[] } {
  const contracts: StockPlanEvidence["contracts"] = [], reasons: string[] = [];
  try {
    check(time(at) && robinhoodSessionAt(at).phase === "REGULAR", "当前正常交易时段");
    check(Array.isArray(specialDays) && specialDays.every((day) => isKnownSpecialDay(day, at)), "特殊日日历证据");
    check(e && e.contract_version === "stock-plan-v2" && e.source_mode === "LIVE" && e.mode === "SHADOW" && e.automated_execution === false && e.instrument_type === "EQUITY" && ["BULLISH", "BEARISH"].includes(e.direction), "原始研究证据边界");
    check(/^[a-f0-9]{64}$/.test(e.evidence_id) && /^[a-f0-9]{64}$/.test(e.source_snapshot_hash) && text(e.source_snapshot_id) && text(e.run_id) && e.slot_id === e.run_id && time(e.observed_at) && time(e.received_at), "原始研究证据身份");
    check(Date.parse(e.observed_at) <= Date.parse(e.received_at) && fresh(e.received_at, at), "本次真实证据未及时收到");
    validateBaselineResearch(e, at, independentDirection);
    check(independentDirection || !paperFallbackDirectionConflict(e.direction, e.planning_context?.timeframes), "FALLBACK_DIRECTION_CONFLICT：1小时与30分钟均反向，跳过该规则候选");
    check(Date.parse(e.planning_context!.observed_at) <= Date.parse(e.observed_at), "分析包含未来数据");
    const date = exchangeDateKey(at), special = specialDays.some((day) => day.market_date === date);
    for (const c of e.contracts) {
      const issues = baselineContractIssues(e, c, at);
      if (paperEntryQualityActive(at)) issues.push(...stockOptionGaps(e, c, Date.parse(at)));
      if (!isPaperOptionExpiration(c.expiration, date)) issues.push("CONTRACT_DTE_OUTSIDE_7_30");
      if (special && positive(c.ask) && nonnegative(c.bid) && paperReturnPct({ reference: { ask: c.ask } }, c.bid) <= -10) issues.push("SPECIAL_DAY_SPREAD_AT_STOP：Ask→Bid损耗达到10%止损线");
      if (issues.length) reasons.push(`${e.symbol}/${c.contract_id}：${issues.join("；")}`);
      else contracts.push(c);
    }
    if (!e.contracts.length) reasons.push(`${e.symbol}：NO_REAL_CONTRACT；${e.data_gaps.join("；")}`);
  } catch (error) { reasons.push(`${e?.symbol ?? "未知标的"}：${error instanceof Error ? error.message : "证据无效"}`); }
  return { contracts, reasons };
}

export function buildPaperPlan(evidences: StockPlanEvidence[], at: string, ordinal = 1, specialDays: SpecialDay[] = [], selection?: PaperSelectionSource, ownerReselection?: PaperOwnerReselection): { plan: PaperPlan | null; reasons: string[] } {
  if (!time(at) || robinhoodSessionAt(at).phase !== "REGULAR") return { plan: null, reasons: ["只在当前正常交易时段建立模拟观察，不补造历史首单"] };
  if (!Array.isArray(specialDays) || specialDays.some((day) => !isKnownSpecialDay(day, at))) return { plan: null, reasons: ["特殊日日历证据缺失、无效或尚未收到，不能确定新单规则"] };
  const events = specialDays.filter((day) => day.market_date === exchangeDateKey(at)), special = events.length > 0;
  const stop_loss_pct = special ? -10 : -40, take_profit_pct = special ? 10 : 30;
  const reasons: string[] = [];
  if (selection) { try { validatePaperSelection(selection, at); } catch { return { plan: null, reasons: ["Codex选择来源未通过核验，不能冒称亲选"] }; } }
  const codex = selection?.kind === "CODEX";
  for (const original of evidences) {
    if (!paperSlotAccepts(original.symbol, at, ordinal)) continue;
    try {
      const e = original, date = exchangeDateKey(at);
      const choice = codex ? selection.candidates.find((row) => row.symbol === e.symbol && row.direction === e.direction) : null;
      if (codex && !choice) throw new Error("当前标的或方向不在Codex原始选择中");
      const { contracts, reasons: rejected } = assessPaperContracts(e, at, specialDays, codex), context = e.planning_context!;
      contracts.sort((a, b) => (a.ask! - a.bid!) / a.ask! - (b.ask! - b.bid!) / b.ask! || (b.volume ?? 0) - (a.volume ?? 0) || (b.open_interest ?? 0) - (a.open_interest ?? 0) || a.contract_id.localeCompare(b.contract_id));
      const c = contracts.find((contract) => !choice?.contract_id || contract.contract_id === choice.contract_id);
      if (!c) throw new Error(rejected.join("；") || (choice?.contract_id ? "CODEX_EXACT_CONTRACT_UNAVAILABLE：Codex原始精确合约未通过当前核验" : "没有剩余7–30天到期且有当前可核验报价的精确期权合约；继续轮换其他股票"));
      const warnings = [...new Set([...e.data_gaps, ...(e.setup_gaps ?? []), ...e.global_risk.critical_blockers, ...e.global_risk.new_entry_blockers,
        ...(e.account.status !== "LIVE" ? ["账户风险数据未完整核验，不允许据此交易"] : []), ...(e.news.status !== "LIVE" || !e.news.items.some((item) => item.verified) ? ["新闻未完整核验，不把新闻推测当事实"] : []),
        ...(exchangeDateKey(context.observed_at) < date ? ["沿用上一完整交易日的冻结分析，非今日实时分析"] : []),
        "固定模拟一张，仅按原始 Ask 建立参考；不代表成交，未获正式交易批准", `亏损${-stop_loss_pct}%与盈利${take_profit_pct}%只作观察里程碑；基准持续观察到真实合约到期，不自动止损/止盈`, "只比较已采集的真实合约，不保证全市场最优，也不保证能按参考价成交"] )];
      const plan: PaperPlan = { plan_id: `${paperPlanId(date, ordinal)}${ownerReselection ? `:reselect:${ownerReselection.request_id}` : ""}`, ...(ownerReselection ? { owner_reselection: structuredClone(ownerReselection) } : {}), market_date: date, created_at: at, expires_at: paperExpiryClose(c.expiration), symbol: e.symbol, direction: e.direction,
        contract: { contract_id: c.contract_id, chain_id: c.instrument.chain_id, expiration: c.expiration, strike: c.strike, option_type: c.option_type, multiplier: c.instrument.trade_value_multiplier! },
        reference: { kind: "SIMULATED_REFERENCE", ask: c.ask!, bid: c.bid!, quoted_at: c.as_of!, recorded_at: at, quantity: 1, ...(nonnegative(c.mark) ? { mark: c.mark } : {}) },
        source: { evidence_id: e.evidence_id, snapshot_id: e.source_snapshot_id, snapshot_hash: e.source_snapshot_hash, observed_at: context.observed_at },
        why_watch: choice ? [choice.reason] : [...context.why_watch], warnings: selection ? [...warnings, selection.reason] : warnings,
        levels: codex ? choice?.entry_conditions ? { entry: choice.entry_conditions.entry, invalidation: choice.entry_conditions.invalidation, target: choice.entry_conditions.target } : { entry: null, invalidation: null, target: null } : { entry: context.entry_trigger, invalidation: context.invalidation_price, target: context.target_price }, stop_loss_pct, take_profit_pct,
        ...(selection ? { selection_source: structuredClone(selection) } : {}),
        ...(paperIndexResearchActive(at) && ordinal === 1 ? { research_cohort: "INDEX_CONDITIONS_V1" as const } : {}),
        entry_policy: { version: codex ? "CODEX_PAPER_RESEARCH_V1" : "BASELINE_PAPER_RESEARCH_V1", ...(paperEntryQualityActive(at) ? { quality_version: "PAPER_LIQUIDITY_V1" as const } : {}), evidence: structuredClone({ contract_version: e.contract_version, entry_rule: e.entry_rule, received_at: e.received_at, symbol: e.symbol, direction: e.direction, quote: e.quote, bars: e.bars, pattern: e.pattern, planning_context: e.planning_context, global_risk: e.global_risk }), contract: structuredClone(c) },
        holding_intent: { min_trading_days: 1, max_trading_days: 3, time_exit: "REVIEW_ONLY" },
        ...(special ? { threshold_policy: { version: "SPECIAL_DAY_10_10_V1" as const, events: events.map((event) => ({ ...event })) } } : {}), mode: "SHADOW", automated_execution: false, executable: false, performance: "EXCLUDED" };
      plan.entry_confirmation = assessPaperPlanEntryConditions(plan, at);
      validatePaperPlan(plan);
      return { plan, reasons: [] };
    } catch (error) { reasons.push(`${original.symbol ?? "未知标的"}：${error instanceof Error ? error.message : "证据无效"}`); }
  }
  return { plan: null, reasons: reasons.length ? reasons : [paperIndexResearchActive(at) && ordinal === 1 ? "INDEX_SLOT_WAIT：指数研究位尚无合格SPY/QQQ合约；保留该位，另外两张继续独立选股" : "本次未获得有方向、有依据、有真实合约的候选，不编造买入单"] };
}

export function validatePaperPlan(plan: PaperPlan) {
  check(plan && plan.mode === "SHADOW" && plan.automated_execution === false && plan.executable === false && plan.performance === "EXCLUDED", "只读研究边界");
  check(time(plan.created_at) && plan.market_date === exchangeDateKey(plan.created_at) && validPlanId(plan.plan_id, plan.market_date) && robinhoodSessionAt(plan.created_at).phase === "REGULAR", "首单日期与编号");
  if (plan.owner_reselection !== undefined) {
    const request = validatePaperOwnerReselection(plan.owner_reselection, plan.market_date, plan.created_at);
    check(plan.plan_id.endsWith(`:reselect:${request.request_id}`) && request.replaces_plan_ids.includes(plan.plan_id.split(":reselect:")[0]), "重选单须关联原日原编号和当时Owner请求");
    check(plan.selection_source?.owner_reselection?.request_id === request.request_id && plan.selection_source.owner_reselection.requested_at === request.requested_at && plan.selection_source.owner_reselection.reason === request.reason && JSON.stringify(plan.selection_source.owner_reselection.replaces_plan_ids) === JSON.stringify(request.replaces_plan_ids), "重选请求与选择来源一致");
  } else check(!plan.plan_id.includes(":reselect:") && !plan.selection_source?.owner_reselection, "重选编号必须附Owner授权来源");
  check(/^[A-Z][A-Z0-9.-]{0,9}$/.test(plan.symbol) && ["BULLISH", "BEARISH"].includes(plan.direction), "方向和标的");
  const indexSlot = plan.plan_id.split(":reselect:")[0] === paperPlanId(plan.market_date);
  check(paperSlotAccepts(plan.symbol, plan.created_at, indexSlot ? 1 : 2), "每日一张SPY/QQQ研究单及两张个股，不能互占研究位");
  check(paperIndexResearchActive(plan.created_at) && indexSlot ? plan.research_cohort === "INDEX_CONDITIONS_V1" : plan.research_cohort === undefined, "指数研究版本按建单时冻结，旧单不追写");
  const c = plan.contract, r = plan.reference;
  check(c && text(c.contract_id) && text(c.chain_id) && /^\d{4}-\d{2}-\d{2}$/.test(c.expiration) && new Date(c.expiration).toISOString().slice(0, 10) === c.expiration && isNyseRegularSession(c.expiration) && c.expiration >= plan.market_date && positive(c.strike) && positive(c.multiplier) && c.option_type === (plan.direction === "BULLISH" ? "call" : "put"), "精确合约");
  check(plan.expires_at === paperExpiryClose(c.expiration) && Date.parse(plan.expires_at) > Date.parse(plan.created_at), "真实到期日收盘");
  check(r && r.kind === "SIMULATED_REFERENCE" && r.quantity === 1 && r.recorded_at === plan.created_at && positive(r.ask) && nonnegative(r.bid) && r.ask >= r.bid && fresh(r.quoted_at, plan.created_at), "原始参考报价");
  validatePaperQuoteProof(r, plan, plan.created_at);
  check(plan.source && /^[a-f0-9]{64}$/.test(plan.source.evidence_id) && /^[a-f0-9]{64}$/.test(plan.source.snapshot_hash) && text(plan.source.snapshot_id) && time(plan.source.observed_at) && Date.parse(plan.source.observed_at) <= Date.parse(plan.created_at), "冻结来源");
  const policy = plan.threshold_policy;
  if (policy === undefined) check(plan.stop_loss_pct === -40 && plan.take_profit_pct === 30, "原始普通日止盈止损规则");
  else check(policy && policy.version === "SPECIAL_DAY_10_10_V1" && plan.stop_loss_pct === -10 && plan.take_profit_pct === 10
    && Array.isArray(policy.events) && policy.events.length > 0 && policy.events.length <= 100 && policy.events.every((day) => isKnownSpecialDay(day, plan.created_at) && day.market_date === plan.market_date)
    && paperReturnPct(plan, r.bid) > plan.stop_loss_pct, "特殊日规则、事前日历与建单价差");
  check(messages(plan.why_watch) && plan.why_watch.length && messages(plan.warnings) && plan.levels && Object.values(plan.levels).every((v) => v === null || positive(v)), "观察理由和里程碑");
  if (plan.entry_policy !== undefined) {
    check(paperEntryQualityActive(plan.created_at) ? plan.entry_policy.quality_version === "PAPER_LIQUIDITY_V1" : plan.entry_policy.quality_version === undefined, "建单时冻结流动性质量版本，不追改旧单");
    check(["QUALIFIED_PAPER_ENTRY_V1", "DAILY_PAPER_RESEARCH_V1", "BASELINE_PAPER_RESEARCH_V1", "CODEX_PAPER_RESEARCH_V1"].includes(plan.entry_policy?.version), "入场规则版本");
    const e = plan.entry_policy.evidence;
    const codex = plan.entry_policy.version === "CODEX_PAPER_RESEARCH_V1";
    if (plan.selection_source) validatePaperSelection(plan.selection_source, plan.created_at);
    check(codex === (plan.selection_source?.kind === "CODEX"), "Codex选择策略与实际来源一致");
    if (codex) {
      const choice = plan.selection_source!.candidates.find((row) => row.symbol === plan.symbol && row.direction === plan.direction);
      check(choice && plan.why_watch.length === 1 && plan.why_watch[0] === choice.reason && (choice.entry_conditions ? plan.levels.entry === choice.entry_conditions.entry && plan.levels.invalidation === choice.entry_conditions.invalidation && plan.levels.target === choice.entry_conditions.target : Object.values(plan.levels).every((value) => value === null)), "Codex原始股票方向、理由及明确选择的冻结条件；不挪用原方向价位");
      check(!choice.contract_id || choice.contract_id === c.contract_id, "Codex原始精确合约不能替换");
      check(Date.parse(e.received_at) >= Date.parse(plan.selection_source!.completed_at) && (!r.proof || Date.parse(r.proof.requested_at) >= Date.parse(plan.selection_source!.completed_at)), "模型完成后重新请求并核实当前报价");
    }
    const qualified = plan.entry_policy.version === "QUALIFIED_PAPER_ENTRY_V1";
    const baseline = plan.entry_policy.version === "BASELINE_PAPER_RESEARCH_V1" || codex;
    if (baseline) validateBaselineResearch(e, plan.created_at, codex);
    else if (qualified) validateQualifiedEntry(e, plan.created_at);
    else validateDailyResearch(e, plan.created_at);
    check(e.symbol === plan.symbol && e.direction === plan.direction && e.planning_context?.observed_at === plan.source.observed_at && (codex || e.planning_context.entry_trigger === plan.levels.entry && e.planning_context.invalidation_price === plan.levels.invalidation && e.planning_context.target_price === plan.levels.target), "入场确认与原始方向、价位及来源一致");
    check(isPaperOptionExpiration(c.expiration, plan.market_date) && exchangeDateKey(r.quoted_at) === plan.market_date && robinhoodSessionAt(r.quoted_at).phase === "REGULAR" && (!qualified || Date.parse(r.quoted_at) >= Date.parse(e.bars.as_of!)), "入场合约期限与当前报价");
    const original = plan.entry_policy.contract;
    if (paperEntryQualityActive(plan.created_at)) check(original && !stockOptionGaps(e, original, Date.parse(plan.created_at)).length, "新单须通过5%中间价及0.15美元价差、真实流动性检查");
    check(original && (baseline ? baselineContract(e, original, plan.created_at) : !stockOptionGaps(e, original, Date.parse(plan.created_at)).length) && original.contract_id === c.contract_id && original.instrument.chain_id === c.chain_id && original.expiration === c.expiration && original.strike === c.strike && original.option_type === c.option_type && original.instrument.trade_value_multiplier === c.multiplier && original.bid === r.bid && original.ask === r.ask && original.as_of === r.quoted_at, "冻结合约身份及参考价");
    check(plan.holding_intent?.min_trading_days === 1 && plan.holding_intent.max_trading_days === 3 && plan.holding_intent.time_exit === "REVIEW_ONLY", "1–3交易日持有意图仅提醒复核");
  } else check(!paperEntryQualityActive(plan.created_at) && plan.holding_intent === undefined && plan.selection_source === undefined, "旧观察记录不追写持有意图或选择来源；新单必须冻结质量依据");
  if (plan.entry_confirmation !== undefined) {
    check(plan.entry_policy && JSON.stringify(plan.entry_confirmation) === JSON.stringify(assessPaperPlanEntryConditions(plan, plan.created_at, plan.entry_confirmation.market_evidence)), "冻结入场逐项核验必须可由当时原证据重算");
  }
  if (plan.formal_forecast_review !== undefined) validatePaperFormalForecastReview(plan.formal_forecast_review, plan, plan.created_at);
  if (plan.next_session_forecast_review !== undefined) validatePaperFormalForecastReview(plan.next_session_forecast_review, plan, plan.created_at, true);
  return plan;
}

export function validatePaperEvent(event: PaperPlanEvent, plan: PaperPlan | null = null) {
  check(event && text(event.event_id) && time(event.recorded_at) && /^\d{4}-\d{2}-\d{2}$/.test(event.market_date) && validPlanId(event.plan_id, event.market_date), "事件身份");
  if (event.event_type === "CREATED") {
    validatePaperPlan(event.payload.plan);
    check(event.payload.plan.plan_id === event.plan_id && event.payload.plan.created_at === event.recorded_at, "首单关联");
  } else if (event.event_type === "ATTEMPT" || event.event_type === "GAP") {
    check(messages(event.payload.reasons) && event.payload.reasons.length, "缺口原因");
    if (event.event_type === "ATTEMPT") check(event.market_date === exchangeDateKey(event.recorded_at) && !plan, "当前日尝试");
    else check(plan, "缺口必须关联原单");
  } else {
    check(plan && plan.plan_id === event.plan_id, "原始首单不存在");
    if (event.event_type === "MARK") {
      const q = event.payload.quote, c = plan.contract;
      check(q && q.source === "ROBINHOOD" && q.contract_id === c.contract_id && q.symbol === plan.symbol && q.expiration === c.expiration && q.strike === c.strike && q.option_type === c.option_type, "追踪同一精确合约");
      check(nonnegative(q.bid) && positive(q.ask) && q.ask >= q.bid && fresh(q.quoted_at, event.recorded_at) && Date.parse(q.quoted_at) >= Date.parse(plan.created_at) && Date.parse(q.quoted_at) <= Date.parse(plan.expires_at) && robinhoodSessionAt(q.quoted_at).phase === "REGULAR", "有效观察报价");
      check(event.payload.estimated_return_pct === paperReturnPct(plan, q.bid), "Bid与原始Ask参考收益");
      validatePaperQuoteProof(q, plan, event.recorded_at);
      if (event.payload.chart !== undefined) validateChart(event.payload.chart, plan, event.recorded_at);
      if (event.payload.entry_confirmation !== undefined) check(plan.entry_policy && JSON.stringify(event.payload.entry_confirmation) === JSON.stringify(assessPaperPlanEntryConditions(plan, event.recorded_at, event.payload.entry_confirmation.market_evidence)), "后续入场核验必须沿用原计划条件并绑定本次已收到证据");
      if (event.payload.formal_forecast_review !== undefined) validatePaperFormalForecastReview(event.payload.formal_forecast_review, plan, event.recorded_at);
      if (event.payload.next_session_forecast_review !== undefined) validatePaperFormalForecastReview(event.payload.next_session_forecast_review, plan, event.recorded_at, true);
      if (event.payload.risk_exit !== undefined) {
        const r = event.payload.risk_exit;
        check(r && r.rule_version === "PAPER_RISK_EXIT_V1" && ["EARNINGS_WINDOW", "OFFICIAL_MACRO_WINDOW", "VERIFIED_MAJOR_EVENT"].includes(r.reason) && text(r.event_id) && text(r.title) && text(r.source) && (r.scope === plan.symbol || r.scope === "GLOBAL"), "风控退出来源身份");
        check(r.decision_at === event.recorded_at && Date.parse(r.decision_at) <= Date.parse(plan.expires_at) && time(r.source_observed_at) && time(r.source_checked_at) && Date.parse(r.source_observed_at) <= Date.parse(r.source_checked_at) && Date.parse(r.source_checked_at) <= Date.parse(r.decision_at) && Date.parse(q.quoted_at) >= Date.parse(r.source_observed_at), "风控决策与已知证据时序");
        check(r.published_at === null || (time(r.published_at) && Date.parse(r.published_at) <= Date.parse(r.source_observed_at) && Date.parse(r.published_at) <= Date.parse(q.quoted_at)), "风控证据尚未发布");
        check(r.scheduled_for === null || calendarDate(r.scheduled_for) || time(r.scheduled_for), "风控日程日期");
        check(r.session === null || ["BMO", "AMC", "DMH", "UNKNOWN"].includes(r.session), "财报时段");
        if (r.reason === "EARNINGS_WINDOW") check(r.scope === plan.symbol && r.source === "Finnhub Earnings Calendar" && r.scheduled_for !== null && r.session !== null && (r.source_url === null || httpsSource(r.source_url)), "结构化财报日历来源");
        else {
          check(httpsSource(r.source_url), "风控事件需要HTTPS来源");
          if (r.reason === "OFFICIAL_MACRO_WINDOW") check(r.scope === "GLOBAL" && time(r.scheduled_for), "官方宏观日程");
          else check(time(r.published_at), "重大事件发布时间");
        }
      }
    } else if (event.event_type === "ENDED") {
      if (event.payload.reason === "OWNER_VOID") check(event.payload.terminal_value === "UNKNOWN" && event.payload.ended_at === event.recorded_at && text(event.payload.detail) && event.payload.detail.length <= 1000 && text(event.payload.owner_request_ref) && event.payload.owner_request_ref.length <= 300, "作废须记录当时时间、原因与Owner授权来源，不冒充成交结算");
      else if (event.payload.reason === "OBSERVATION_WINDOW") check(event.payload.policy === "PAPER_TRACKING_WINDOW_V1" && event.payload.ended_at === paperTrackingWindow(plan).ends_at && Date.parse(event.payload.ended_at) < Date.parse(plan.expires_at) && Date.parse(event.recorded_at) >= Date.parse(event.payload.ended_at) && event.payload.terminal_value === "UNKNOWN", "观察期结束仅归档，截止与实际归档时间分开，不冒充成交或到期");
      else check(event.payload.reason === "EXPIRATION" && event.payload.ended_at === plan.expires_at && Date.parse(event.recorded_at) >= Date.parse(plan.expires_at) && event.payload.terminal_value === "UNKNOWN", "到期不冒充归零结算");
    }
    else check(false, "未知事件类型");
  }
  if (plan) check(Date.parse(event.recorded_at) >= Date.parse(plan.created_at), "事件早于首单");
  return event;
}

/** Same-sample thresholds take precedence; later marks never establish an earlier touch. */
export function paperMarkExitReason(plan: PaperPlan, event: Extract<PaperPlanEvent, { event_type: "MARK" }>): PaperExitReason | null {
  try { validatePaperEvent(event, plan); } catch { return null; }
  const value = paperReturnPct(plan, event.payload.quote.bid);
  return value >= plan.take_profit_pct ? "TAKE_PROFIT" : value <= plan.stop_loss_pct ? "STOP_LOSS" : event.payload.risk_exit?.reason ?? null;
}

export function projectPaperPlans(events: PaperPlanEvent[], now = new Date().toISOString()): PaperPlanOverview {
  const ordered = [...events].sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at) || a.event_id.localeCompare(b.event_id));
  const plans = ordered.filter((event) => event.event_type === "CREATED").map((event): PaperPlanView => {
    const plan = event.payload.plan, history = ordered.filter((row) => row.plan_id === plan.plan_id), last = history.at(-1)!;
    const marks = history.filter((row) => row.event_type === "MARK"), quote = marks.at(-1)?.payload.quote ?? null, returns = marks.map((row) => row.payload.estimated_return_pct);
    const ending = history.find((row) => row.event_type === "ENDED");
    const ownerVoid = ending?.event_type === "ENDED" && ending.payload.reason === "OWNER_VOID" ? { ended_at: ending.payload.ended_at, detail: ending.payload.detail, owner_request_ref: ending.payload.owner_request_ref } : undefined;
    const confirmation = marks.findLast((row) => row.payload.entry_confirmation)?.payload.entry_confirmation, forecastReview = marks.findLast((row) => row.payload.formal_forecast_review)?.payload.formal_forecast_review;
    const nextSessionReview = marks.findLast((row) => row.payload.next_session_forecast_review && Date.parse(row.recorded_at) <= Date.parse(now))?.payload.next_session_forecast_review;
    const tracking = projectPaperTracking(plan, history, now), cutoff = Math.min(Date.parse(tracking.ends_at), Date.parse(now));
    const windowMarks = events.filter((row): row is Extract<PaperPlanEvent, { event_type: "MARK" }> => {
      if (row.plan_id !== plan.plan_id || row.event_type !== "MARK") return false;
      if (Date.parse(row.recorded_at) > cutoff || Date.parse(row.payload.quote.quoted_at) > cutoff) return false;
      try { validatePaperEvent(row, plan); return true; } catch { return false; }
    });
    const firstExitIndex = events.findIndex((row) => row.plan_id === plan.plan_id && row.event_type === "MARK" && paperMarkExitReason(plan, row) !== null), firstExit = events[firstExitIndex];
    const afterLoss = firstExit?.event_type === "MARK" && firstExit.payload.quote.bid < plan.reference.ask ? windowMarks.filter((row) => events.indexOf(row) > firstExitIndex && Date.parse(row.recorded_at) >= Date.parse(firstExit.recorded_at) && Date.parse(row.payload.quote.quoted_at) > Date.parse(firstExit.payload.quote.quoted_at)) : [];
    const observed = (row: typeof afterLoss[number] | undefined): PaperWindowObservation | null => row ? { quoted_at: row.payload.quote.quoted_at, recorded_at: row.recorded_at, bid: row.payload.quote.bid, return_pct: paperReturnPct(plan, row.payload.quote.bid) } : null;
    const windowReturns = windowMarks.map((row) => paperReturnPct(plan, row.payload.quote.bid));
    const window_research: PaperWindowResearch = { ends_at: tracking.ends_at, recovery_after_loss: observed(afterLoss.find((row) => row.payload.quote.bid >= plan.reference.ask)), target_after_loss: observed(afterLoss.find((row) => paperReturnPct(plan, row.payload.quote.bid) >= plan.take_profit_pct)), best_return_pct: windowReturns.length ? Math.max(...windowReturns) : null, worst_return_pct: windowReturns.length ? Math.min(...windowReturns) : null, gap_observed: history.some((row) => row.event_type === "GAP" && Date.parse(row.recorded_at) <= cutoff) };
    return { plan, status: ownerVoid ? "VOIDED" : ending?.event_type === "ENDED" ? ending.payload.reason === "OBSERVATION_WINDOW" ? "ARCHIVED" : "EXPIRED" : last.event_type === "GAP" ? "DATA_GAP" : "OBSERVING", tracking, window_research, ...(ownerVoid ? { owner_void: ownerVoid } : {}), last_checked_at: last.recorded_at, latest_quote: quote, ...(marks.at(-1)?.payload.chart ? { chart: marks.at(-1)!.payload.chart } : {}), ...(confirmation ? { latest_entry_confirmation: confirmation } : {}), estimated_return_pct: marks.at(-1)?.payload.estimated_return_pct ?? null,
      ...(forecastReview ? { latest_formal_forecast_review: forecastReview } : {}), ...(nextSessionReview ? { latest_next_session_forecast_review: nextSessionReview } : {}), highest_observed_return_pct: returns.length ? Math.max(...returns) : null, lowest_observed_return_pct: returns.length ? Math.min(...returns) : null, stop_observed: returns.some((v) => v <= plan.stop_loss_pct), take_profit_observed: returns.some((v) => v >= plan.take_profit_pct), reasons: last.event_type === "GAP" ? last.payload.reasons : [] };
  }).reverse();
  return { mode: "SHADOW", executable: false, performance: "EXCLUDED", checked_at: now, plans, latest_attempt: ordered.findLast((row) => row.event_type === "ATTEMPT") ?? null };
}

/** Persisted append order, including every origin and its first effective exit; never use recent-card extrema. */
export function projectPaperLearning(events: PaperPlanEvent[]): PaperLearning {
  const rows = new Map<string, { plan: PaperPlan; result: PaperRuleResult }>();
  for (const event of events) {
    if (event.event_type === "CREATED") {
      rows.set(event.plan_id, { plan: event.payload.plan, result: { plan_id: event.plan_id, status: "PENDING", event_id: null, recorded_at: null, quoted_at: null, bid: null, return_pct: null, pnl: null, gap_before_result: false, exit_reason: null, risk_exit: null } });
      continue;
    }
    const row = rows.get(event.plan_id);
    if (row && event.event_type === "ENDED" && event.payload.reason === "OWNER_VOID") {
      row.result.owner_void = { ended_at: event.payload.ended_at, detail: event.payload.detail, owner_request_ref: event.payload.owner_request_ref };
      continue;
    }
    if (!row || row.result.status !== "PENDING" || row.result.owner_void) continue;
    if (event.event_type === "GAP") row.result.gap_before_result = true;
    if (event.event_type === "ENDED") row.result.status = "UNKNOWN";
    if (event.event_type !== "MARK") continue;
    const value = paperReturnPct(row.plan, event.payload.quote.bid);
    const exitReason = paperMarkExitReason(row.plan, event);
    if (!exitReason) continue;
    row.result = { ...row.result, status: event.payload.quote.bid > row.plan.reference.ask ? "WIN" : event.payload.quote.bid < row.plan.reference.ask ? "LOSS" : "FLAT", event_id: event.event_id, recorded_at: event.recorded_at, quoted_at: event.payload.quote.quoted_at, bid: event.payload.quote.bid, return_pct: value, exit_reason: exitReason, risk_exit: exitReason === "TAKE_PROFIT" || exitReason === "STOP_LOSS" ? null : event.payload.risk_exit ?? null,
      pnl: Number(((event.payload.quote.bid - row.plan.reference.ask) * row.plan.contract.multiplier * row.plan.reference.quantity).toFixed(2)) };
  }
  const all = [...rows.values()], ended = new Set(events.filter((event) => event.event_type === "ENDED").map((event) => event.plan_id));
  const spread = (plan: PaperPlan) => Number(((plan.reference.ask - plan.reference.bid) / plan.reference.ask * 100).toFixed(6));
  const stats = (items: typeof all): PaperLearningStats => {
    const settled = items.filter(({ result }) => result.status === "WIN" || result.status === "LOSS" || result.status === "FLAT");
    const wins = settled.filter(({ result }) => result.status === "WIN").length;
    const gain = settled.reduce((sum, { result }) => sum + Math.max(0, result.pnl!), 0), loss = settled.reduce((sum, { result }) => sum + Math.max(0, -result.pnl!), 0);
    return { total: items.length, wins, losses: settled.filter(({ result }) => result.status === "LOSS").length, flats: settled.filter(({ result }) => result.status === "FLAT").length, risk_exits: settled.filter(({ result }) => result.risk_exit !== null).length, pending: items.filter(({ result }) => result.status === "PENDING").length, unknown: items.filter(({ result }) => result.status === "UNKNOWN").length, voided: items.filter(({ result }) => result.owner_void).length,
      resolved_days: new Set(settled.map(({ plan }) => plan.market_date)).size, win_rate_pct: settled.length ? wins / settled.length * 100 : null,
      average_return_pct: settled.length ? settled.reduce((sum, { result }) => sum + result.return_pct!, 0) / settled.length : null, profit_factor: loss > 0 ? gain / loss : null,
      gap_count: items.filter(({ result }) => result.gap_before_result).length, average_entry_spread_pct: items.length ? items.reduce((sum, { plan }) => sum + spread(plan), 0) / items.length : null };
  };
  const groups = (items: typeof all): PaperLearning["groups"] => {
    const grouped = new Map<string, { dimension: PaperLearning["groups"][number]["dimension"]; label: string; rows: typeof all }>();
    for (const row of items) {
      const dte = (Date.parse(row.plan.contract.expiration) - Date.parse(row.plan.market_date)) / 86_400_000;
      const labels = [
        ["DIRECTION", row.plan.direction === "BULLISH" ? "看涨 Call" : "看跌 Put"],
        ["ENTRY_SPREAD", spread(row.plan) <= 5 ? "入场价差 ≤5%" : spread(row.plan) <= 10 ? "入场价差 >5%–10%" : "入场价差 >10%"],
        ["DTE", dte <= 30 ? "建单距到期 ≤30天" : dte <= 90 ? "建单距到期 31–90天" : "建单距到期 >90天"],
        ["EXIT_REASON", row.result.exit_reason ? { TAKE_PROFIT: "止盈阈值", STOP_LOSS: "止损阈值", EARNINGS_WINDOW: "财报窗口", OFFICIAL_MACRO_WINDOW: "官方宏观窗口", VERIFIED_MAJOR_EVENT: "已核验重大事件" }[row.result.exit_reason] : "未结算"],
        ["RISK_POLICY", row.plan.threshold_policy ? "特殊日规则 +10% / -10%" : "常规规则 +30% / -40%"],
        ["RESEARCH_COHORT", row.plan.research_cohort === "INDEX_CONDITIONS_V1" ? "指数方法研究" : "原选股研究"],
        ["ENTRY_POLICY", row.plan.selection_source?.kind === "CODEX" ? "Codex 亲选规则" : row.plan.selection_source?.kind === "RULE_FALLBACK" ? "规则补位" : row.plan.entry_policy?.version === "BASELINE_PAPER_RESEARCH_V1" ? "原方向研究规则" : row.plan.entry_policy?.version === "DAILY_PAPER_RESEARCH_V1" ? "每日研究规则" : row.plan.entry_policy ? "突破入场规则" : "旧观察基线"],
      ] as const;
      for (const [dimension, label] of labels) {
        const key = `${dimension}:${label}`, group = grouped.get(key) ?? { dimension, label, rows: [] };
        group.rows.push(row); grouped.set(key, group);
      }
    }
    return [...grouped.values()].map(({ dimension, label, rows }) => ({ dimension, label, stats: stats(rows) }));
  };
  const current = all.filter(({ plan }) => plan.market_date >= PAPER_RESEARCH_START_DATE), archived = all.filter(({ plan }) => plan.market_date < PAPER_RESEARCH_START_DATE);
  return { rule: all.some(({ plan }) => plan.threshold_policy) ? "FIRST_OBSERVED_PLAN_THRESHOLDS_OR_RISK_EXIT_V3" : "FIRST_OBSERVED_30_OR_MINUS_40_OR_RISK_EXIT_V2", summary: stats(all), eligible_summary: stats(all.filter(({ result }) => !result.owner_void)), groups: groups(all), recent_results: all.filter(({ plan }, index) => index >= all.length - 10 || !ended.has(plan.plan_id)).reverse().map(({ result }) => result),
    current_round: { start_date: PAPER_RESEARCH_START_DATE, summary: stats(current), eligible_summary: stats(current.filter(({ result }) => !result.owner_void)), groups: groups(current) }, archived_summary: stats(archived) };
}
