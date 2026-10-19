import type { ScheduleCheckpoint } from "./timeline-schedule.ts";
import type { DecisionReviewEvidence } from "./decision-review.ts";
import { formatPtTime, nyseClosePtMinutes, ptDateKey } from "./market-time.ts";
import type { TsOutput } from "./snapshot-import.ts";

export type ForecastPhase = "INITIAL" | "EARLY_REVISION" | "INTRADAY_REVISION" | "FINAL";
export type ForecastEligibility = "OFFICIAL_LIVE" | "EXCLUDED_REPLAY" | "EXCLUDED_NON_LIVE";
export type SettlementStatus = "RESOLVED" | "PARTIAL";
export const TS_FORECAST_IDENTITY_CONTRACT = "TS_FORECAST_IDENTITY@1.0.0" as const;
export const TS_BUNDLED_FORECAST_IDENTITY_CONTRACT = "TS_FORECAST_IDENTITY@2.0.0" as const;
export const TS_SETTLEMENT_CAUSAL_CONTRACT = "TS_FORECAST_SETTLEMENT@2.0.0" as const;
export const TS_FORECAST_PRODUCT_CONTRACT = "TS_FORECAST_PRODUCT@1.0.0" as const;
export const TS_SCENARIO_WEIGHT_STATUS = "UNCALIBRATED_SCENARIO_WEIGHTS" as const;
export type TsForecastIdentity = {
  contract_id: typeof TS_FORECAST_IDENTITY_CONTRACT | typeof TS_BUNDLED_FORECAST_IDENTITY_CONTRACT;
  status: "VERIFIED_RUNTIME" | "LEGACY_PROJECTION";
  forecast_contract_version: string;
  model_release_commit: string | null;
  generator_commit: string | null;
  runtime_release_sha256: string | null;
  source_identity?: {
    kind: "BUNDLED_SOURCE_SHA256";
    core_sha256: string;
    source_sha256: string;
    runtime_sha256: string;
    source_origin: { kind: "SOURCE_ARCHIVE" | "GIT_CHECKOUT" | "GIT_METADATA_UNAVAILABLE"; head_commit: string | null; dirty: boolean | null };
    manifest_status: "ABSENT_LOCAL_CONTENT_ONLY" | "VALIDATED_LOCAL_CONTENT_ONLY";
  };
  observed_at: string;
  received_at: string;
  gateway_delay_ms: number;
};
export type TsSettlementBar = { symbol: "SPY" | "QQQ"; begins_at: string; session_date: string; open: number; high: number; low: number; close: number; volume: number | null; snapshot_hash: string };
export type TsSwingObservation = {
  entry_price: number;
  entry_at: string;
  max_price: number;
  max_bar_closed_at: string;
  min_price: number;
  min_bar_closed_at: string;
  close_price: number;
  close_at: string;
  upside_excursion_pct: number;
  downside_excursion_pct: number;
  favorable_excursion_pct: number | null;
  adverse_excursion_pct: number | null;
  first_extreme: "HIGH_FIRST" | "LOW_FIRST" | "SAME_BAR_UNRESOLVED";
};
export type TsSettlementResult = {
  contract_version: "v1" | "v2";
  component: "TS_FORECAST_SETTLEMENT";
  settlement_contract_id?: typeof TS_SETTLEMENT_CAUSAL_CONTRACT;
  forecast_identity?: TsForecastIdentity;
  forecast_run_id: string;
  settled_at: string;
  status: SettlementStatus;
  source: "ROBINHOOD" | "TRADIER";
  source_snapshot_hashes: string[];
  observation_window: { start_at: string; end_at: string; target_market_dates: string[]; observed_at?: string; received_at?: string; gateway_delay_ms?: number; first_scorable_bar_at?: string; bar_count?: number };
  actual_scenario: "MAIN" | "REVERSE" | "EXTREME" | "UNRESOLVED";
  scenario_probabilities: Record<"main" | "reverse" | "extreme", number>;
  scenario_results: Record<"main" | "reverse" | "extreme", { status: "CONFIRMED" | "PARTIAL" | "INVALIDATED" | "NOT_ACTIVATED" | "UNRESOLVED"; activated_at: string | null; invalidated_at: string | null; completed_stage_count: number; completed_at: string | null }>;
  scenario_resolution: { status: "UNIQUE" | "AMBIGUOUS" | "NO_COMPLETE_PATH" | "DIRECTION_CONFLICT"; selected: "MAIN" | "REVERSE" | "EXTREME" | null; competing: Array<"MAIN" | "REVERSE" | "EXTREME">; reason: string };
  brier_score: number | null;
  path_result: "MAIN_CORRECT" | "ALTERNATE_PATH" | "UNRESOLVED";
  timing_result: { status: "ON_TIME" | "NOT_SCORABLE"; completed_at: string | null };
  pattern_result: { status: "PERSISTED" | "TRANSITIONED" | "NOT_SCORABLE"; published_regime?: string; realized_regime?: string; reason: string };
  amplitude_result?: { status: "OBSERVED"; symbols: Record<"SPY" | "QQQ", { net_move_pct: number; range_pct: number }> };
  tradeability_result?: { published_status: TsOutput["tradeability"]["status"]; outcome: "WAIT_DISCIPLINE_PRESERVED" | "WAIT_REVIEW_REQUIRED" | "CONDITION_TRIGGERED" | "CONDITION_NOT_TRIGGERED" | "READY_CONFIRMED" | "READY_NOT_CONFIRMED"; reason: string };
  swing_observation?: { basis: "ROBINHOOD_REGULAR_SESSION" | "TRADIER_REGULAR_SESSION"; holding_style: "MANUAL_SINGLE_LEG_0_TO_15_DTE"; execution_scope: "READ_ONLY_NO_ORDER_ACTION"; symbols: Record<"SPY" | "QQQ", TsSwingObservation> };
  symbols: Record<"SPY" | "QQQ", {
    forecast_direction: "BULLISH" | "BEARISH" | "RANGE";
    actual_direction: "BULLISH" | "BEARISH" | "RANGE";
    direction_correct: boolean;
    start_price: number;
    end_price: number;
    return_pct: number;
    actual_low: number;
    actual_high: number;
    range_result: { status: "CORRECT" | "BREACHED" | "NOT_SCORABLE"; support: number | null; resistance: number | null };
    key_levels: Array<{ label: string; value: number; observed: boolean }>;
  }>;
  notes: string[];
};

export type AccuracyMetric = {
  sample_count: number;
  correct_count: number;
  accuracy: number | null;
  confidence_interval_95: [number, number] | null;
  post_hoc_majority_rate: number | null;
  evidence: "SUFFICIENT" | "INSUFFICIENT";
};

export type TsBaselineId = "PRIOR_MAJORITY" | "VWAP_POSITION" | "LAST_BAR" | "THREE_BAR_TREND" | "VWAP_MEAN_REVERSION" | "UNIFORM_PROBABILITY" | "ALL_WAIT";
export type TsBaselineOutcome = { baseline: TsBaselineId; prediction: "BULLISH" | "BEARISH" | "RANGE" | "WAIT" | null; correct: boolean | null };
export type TsBaselineMetric = {
  baseline: TsBaselineId;
  label: string;
  sample_count: number;
  correct_count: number;
  accuracy: number | null;
  coverage: number;
  mcc: number | null;
  mean_brier: number | null;
};
export type TsRiskCoveragePoint = { qualification: "READY_FOR_D_REVIEW" | "CONDITIONAL_OR_READY" | "ALL_FORECASTS"; forecast_count: number; coverage: number; direction_sample_count: number; accuracy: number | null; risk: number | null; mcc: number | null };
export type TsProductEvaluation = {
  direction_mcc: number | null;
  baselines: TsBaselineMetric[];
  risk_coverage: TsRiskCoveragePoint[];
  by_forecast: Record<string, Record<"SPY" | "QQQ", TsBaselineOutcome[]>>;
};

export type TrustedSettlementCohort = {
  status: "READY" | "INSUFFICIENT_EVIDENCE";
  message: string;
  forecast_contract: typeof TS_FORECAST_IDENTITY_CONTRACT | typeof TS_BUNDLED_FORECAST_IDENTITY_CONTRACT;
  settlement_contract: typeof TS_SETTLEMENT_CAUSAL_CONTRACT;
  eligibility: "OFFICIAL_LIVE_ONLY";
  time_range: { start_at: string | null; end_at: string | null };
  forecast_versions: string[];
  forecast_count: number;
  settled_count: number;
  direction: Record<"SPY" | "QQQ", AccuracyMetric>;
  actions: { sample_count: number; includes_wait: boolean; outcomes: Array<{ outcome: string; count: number }>; evidence: "SUFFICIENT" | "INSUFFICIENT" };
  paths: AccuracyMetric & { attribution: Record<"MAIN" | "REVERSE" | "EXTREME" | "AMBIGUOUS" | "NO_COMPLETE_PATH", number> };
  brier: { sample_count: number; mean: number | null; formula: "THREE_CLASS_SUM_SQUARED_ERROR"; range: [0, 2]; uniform_baseline: number; evidence: "SUFFICIENT" | "INSUFFICIENT" };
  range: { sample_count: number; correct_count: number };
  key_levels: { sample_count: number; observed_count: number };
  product_contract: typeof TS_FORECAST_PRODUCT_CONTRACT;
  validation: { status: "UNVALIDATED"; reason: string; independent_trading_days: number; checkpoint_30: "PENDING" | "REACHED"; checkpoint_60: "PENDING" | "REACHED"; gap_to_30: number; gap_to_60: number };
  scenario_weights: { status: typeof TS_SCENARIO_WEIGHT_STATUS; source: "TS_AGENT_CONSTRAINED_JUDGMENT"; constraints: "FIVE_PERCENT_STEPS_SUM_100_MAIN_NOT_LOWER"; forward_calibrated: false };
  direction_mcc: number | null;
  risk_coverage: TsRiskCoveragePoint[];
  baselines: TsBaselineMetric[];
};

export type TsSettlementOverview = {
  review_evidence?: DecisionReviewEvidence | null;
  activated_at: string;
  archived_count: number;
  official_live_count: number;
  excluded_replay_count: number;
  excluded_non_live_count: number;
  pending_count: number;
  settled_count: number;
  resolved_count: number;
  partial_count: number;
  delivery: { expected: number; delivered: number; rate: number | null };
  coverage: { due: number; settled: number; rate: number | null };
  direction_accuracy: Record<"SPY" | "QQQ", { sample_count: number; correct_count: number; accuracy: number | null }>;
  path_accuracy: { sample_count: number; correct_count: number; accuracy: number | null };
  mean_brier_score: number | null;
  probability_buckets: Array<{ probability_pct: number; forecast_count: number; hit_count: number; realized_rate: number }>;
  tradeability_outcomes: Array<{ outcome: NonNullable<TsSettlementResult["tradeability_result"]>["outcome"]; count: number }>;
  by_slot: Array<{ slot: string; sample_count: number; settled_count: number; direction_correct: number; direction_total: number; direction_accuracy: number | null }>;
  exclusions: Array<{ slot: string; status: string; reason: string }>;
  trusted: TrustedSettlementCohort;
  legacy: {
    label: "LEGACY_NON_CAUSAL_WINDOW";
    forecast_count: number;
    settled_count: number;
    strict_projection_count: number;
    strict_projection: { direction: Record<"SPY" | "QQQ", AccuracyMetric> };
    groups: Array<{ label: "PRE_REGIME" | "REGIME" | "ENHANCED"; forecast_count: number; settled_count: number; direction: Record<"SPY" | "QQQ", AccuracyMetric> }>;
  };
  recent: Array<{
    forecast_run_id: string;
    published_at: string;
    market_date: string;
    slot: string;
    phase: ForecastPhase;
    report_type: TsOutput["report_type"];
    source_mode: "LIVE" | "REPLAY" | "UNKNOWN";
    eligibility: ForecastEligibility;
    one_line_forecast: string;
    path_bias: TsOutput["path_bias"];
    scoring_contract: typeof TS_SETTLEMENT_CAUSAL_CONTRACT | "LEGACY_NON_CAUSAL_WINDOW" | "NOT_SETTLED";
    forecast_identity: TsForecastIdentity | null;
    forecast_window: TsOutput["forecast_window"];
    scenario_probabilities: Record<"main" | "reverse" | "extreme", number>;
    scenario_weight_status: typeof TS_SCENARIO_WEIGHT_STATUS;
    qualification: TsOutput["tradeability"];
    confirmation_delay_minutes: number | null;
    baselines: Record<"SPY" | "QQQ", TsBaselineOutcome[]>;
    settlement: TsSettlementResult | null;
  }>;
};

export function emptyTsSettlementOverview(activatedAt: string): TsSettlementOverview {
  const metric = (): AccuracyMetric => ({ sample_count: 0, correct_count: 0, accuracy: null, confidence_interval_95: null, post_hoc_majority_rate: null, evidence: "INSUFFICIENT" });
  return {
    activated_at: activatedAt, archived_count: 0, official_live_count: 0, excluded_replay_count: 0, excluded_non_live_count: 0, pending_count: 0, settled_count: 0, resolved_count: 0, partial_count: 0,
    delivery: { expected: 0, delivered: 0, rate: null }, coverage: { due: 0, settled: 0, rate: null }, direction_accuracy: { SPY: { sample_count: 0, correct_count: 0, accuracy: null }, QQQ: { sample_count: 0, correct_count: 0, accuracy: null } }, path_accuracy: { sample_count: 0, correct_count: 0, accuracy: null }, mean_brier_score: null, probability_buckets: [], tradeability_outcomes: [], by_slot: [], exclusions: [],
    trusted: { status: "INSUFFICIENT_EVIDENCE", message: "UNVALIDATED：当前版本样本不足，尚未证明预测优势", forecast_contract: TS_FORECAST_IDENTITY_CONTRACT, settlement_contract: TS_SETTLEMENT_CAUSAL_CONTRACT, eligibility: "OFFICIAL_LIVE_ONLY", time_range: { start_at: null, end_at: null }, forecast_versions: [], forecast_count: 0, settled_count: 0, direction: { SPY: metric(), QQQ: metric() }, actions: { sample_count: 0, includes_wait: true, outcomes: [], evidence: "INSUFFICIENT" }, paths: { ...metric(), attribution: { MAIN: 0, REVERSE: 0, EXTREME: 0, AMBIGUOUS: 0, NO_COMPLETE_PATH: 0 } }, brier: { sample_count: 0, mean: null, formula: "THREE_CLASS_SUM_SQUARED_ERROR", range: [0, 2], uniform_baseline: 2 / 3, evidence: "INSUFFICIENT" }, range: { sample_count: 0, correct_count: 0 }, key_levels: { sample_count: 0, observed_count: 0 }, product_contract: TS_FORECAST_PRODUCT_CONTRACT, validation: { status: "UNVALIDATED", reason: "需要30/60个独立自然Forward交易日、简单基线、MCC、Brier和Risk-Coverage共同验收", independent_trading_days: 0, checkpoint_30: "PENDING", checkpoint_60: "PENDING", gap_to_30: 30, gap_to_60: 60 }, scenario_weights: { status: TS_SCENARIO_WEIGHT_STATUS, source: "TS_AGENT_CONSTRAINED_JUDGMENT", constraints: "FIVE_PERCENT_STEPS_SUM_100_MAIN_NOT_LOWER", forward_calibrated: false }, direction_mcc: null, risk_coverage: [], baselines: [] },
    legacy: { label: "LEGACY_NON_CAUSAL_WINDOW", forecast_count: 0, settled_count: 0, strict_projection_count: 0, strict_projection: { direction: { SPY: metric(), QQQ: metric() } }, groups: [] }, recent: [],
  };
}

type Condition = { symbol: "SPY" | "QQQ"; metric: "LAST_PRICE" | "VWAP" | "SESSION_HIGH" | "SESSION_LOW" | "OPENING_RANGE_HIGH" | "OPENING_RANGE_LOW"; operator: "ABOVE" | "BELOW" | "AT_OR_ABOVE" | "AT_OR_BELOW" | "BETWEEN"; value: number; upper_value: number | null; confirmation: "LIVE_QUOTE" | "ONE_5M_CLOSE" | "ONE_15M_CLOSE" | "ONE_30M_CLOSE" };
type Group = { logic: "ALL" | "ANY"; conditions: Condition[] };
type Stage = { order: number; conditions: Condition[] };
type Scenario = { bias: "BULLISH" | "BEARISH" | "RANGE"; probability_pct: number; activation: Group; sequence: Stage[]; invalidation: Group };
type MetricBar = TsSettlementBar & { closed_at: string; vwap: number | null; session_high: number; session_low: number; opening_range_high: number | null; opening_range_low: number | null };

const symbols = ["SPY", "QQQ"] as const;
const scenarios = ["main", "reverse", "extreme"] as const;
const confirmationMinutes = { LIVE_QUOTE: 0, ONE_5M_CLOSE: 5, ONE_15M_CLOSE: 15, ONE_30M_CLOSE: 30 } as const;
export const OFFICIAL_TS_SLOTS = ["06:30", "06:45", "07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30"] as const;
const officialTsSlots = new Set<string>(OFFICIAL_TS_SLOTS);

export function forecastPhase(output: TsOutput): ForecastPhase {
  if (output.report_type === "OPENING_FORECAST") return "INITIAL";
  if (output.report_type === "OPEN_15M_CHECK" || output.report_type === "OPEN_30M_CHECK") return "EARLY_REVISION";
  if (output.report_type === "NEXT_SESSION" || output.report_type === "WEEKEND_OUTLOOK") return "FINAL";
  return "INTRADAY_REVISION";
}

export function officialSlot(output: TsOutput, sourceRecordId?: string) {
  const compact = sourceRecordId?.match(/(?:live|replay)-shadow:(\d{8}T\d{6}Z)/)?.[1];
  if (!compact) return formatPtTime(output.evidence_snapshot.market_time.observed_at);
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`;
  return formatPtTime(iso);
}

export function forecastArchiveClassification(recordId: string, outputType: string, channel: string, output: TsOutput): { sourceMode: "LIVE" | "REPLAY" | "UNKNOWN"; eligibility: ForecastEligibility; exclusion: string | null; slot: string } {
  const sourceMode = recordId.startsWith("live-shadow:") ? "LIVE" : recordId.startsWith("replay-shadow:") ? "REPLAY" : "UNKNOWN";
  const slot = officialSlot(output, recordId);
  if (sourceMode === "REPLAY") return { sourceMode, eligibility: "EXCLUDED_REPLAY", exclusion: "REPLAY 只验证结算能力，不进入 LIVE 准确率", slot };
  const formalSlot = output.report_type === "NEXT_SESSION" || output.report_type === "WEEKEND_OUTLOOK" ? slot === "18:00" : officialTsSlots.has(slot);
  if (sourceMode === "LIVE" && outputType === "TS_SHADOW_OUTPUT" && channel === "SHADOW" && formalSlot) return { sourceMode, eligibility: "OFFICIAL_LIVE", exclusion: null, slot };
  const exclusion = sourceMode === "LIVE" && outputType === "TS_SHADOW_OUTPUT" && channel === "SHADOW"
    ? `自然 LIVE 增强观察槽 ${slot} 不属于 V2 正式 TS 槽；原始结果保留但不进入准确率`
    : "功能启用前、导入样本或非自然 LIVE 输出不进入准确率";
  return { sourceMode, eligibility: "EXCLUDED_NON_LIVE", exclusion, slot };
}

export function closedAt(bar: TsSettlementBar) { return new Date(Date.parse(bar.begins_at) + 5 * 60_000).toISOString(); }
export function regularSessionBar(bar: TsSettlementBar) {
  const [hour, minute] = formatPtTime(bar.begins_at).split(":").map(Number), value = hour * 60 + minute;
  return ptDateKey(bar.begins_at) === bar.session_date && value >= 390 && value < nyseClosePtMinutes(bar.session_date);
}

type EvaluationRecord = { output: TsOutput; settlement: TsSettlementResult; received_at: string };
type Direction = "BULLISH" | "BEARISH" | "RANGE";
const directionClasses: Direction[] = ["BULLISH", "BEARISH", "RANGE"];
const baselineLabels: Record<TsBaselineId, string> = {
  PRIOR_MAJORITY: "发布时已收到的结算多数类别（更正计算）",
  VWAP_POSITION: "发布时价格相对VWAP",
  LAST_BAR: "最近一根完整K线",
  THREE_BAR_TREND: "最近三根趋势延续",
  VWAP_MEAN_REVERSION: "最小Shadow候选 · VWAP均值回归（不进Owner信号）",
  UNIFORM_PROBABILITY: "三分类均匀概率",
  ALL_WAIT: "全部WAIT",
};

function directionFromMove(start: number, end: number): Direction {
  const change = (end / start - 1) * 100;
  return Math.abs(change) <= .05 ? "RANGE" : change > 0 ? "BULLISH" : "BEARISH";
}

function majority(values: Direction[]) {
  const counts = directionClasses.map((direction) => ({ direction, count: values.filter((value) => value === direction).length })).sort((left, right) => right.count - left.count);
  return counts[0]?.count && counts[0].count > (counts[1]?.count ?? 0) ? counts[0].direction : null;
}

function multiclassMcc(pairs: Array<{ actual: Direction; predicted: Direction }>) {
  if (!pairs.length) return null;
  const matrix = directionClasses.map((actual) => directionClasses.map((predicted) => pairs.filter((pair) => pair.actual === actual && pair.predicted === predicted).length));
  const total = pairs.length, correct = matrix.reduce((sum, row, index) => sum + row[index], 0);
  const actualTotals = matrix.map((row) => row.reduce((sum, value) => sum + value, 0));
  const predictedTotals = directionClasses.map((_, column) => matrix.reduce((sum, row) => sum + row[column], 0));
  const numerator = correct * total - predictedTotals.reduce((sum, value, index) => sum + value * actualTotals[index], 0);
  const denominator = Math.sqrt((total ** 2 - predictedTotals.reduce((sum, value) => sum + value ** 2, 0)) * (total ** 2 - actualTotals.reduce((sum, value) => sum + value ** 2, 0)));
  return denominator ? numerator / denominator : null;
}

export function evaluateTsProduct(records: EvaluationRecord[], history: Record<"SPY" | "QQQ", TsSettlementBar[]>): TsProductEvaluation {
  const ordered = records.toSorted((left, right) => Date.parse(left.received_at) - Date.parse(right.received_at));
  const pairs = Object.fromEntries((Object.keys(baselineLabels) as TsBaselineId[]).map((id) => [id, [] as Array<{ actual: Direction; predicted: Direction }>])) as Record<TsBaselineId, Array<{ actual: Direction; predicted: Direction }>>;
  const byForecast: TsProductEvaluation["by_forecast"] = {}, tsPairs: Array<{ actual: Direction; predicted: Direction }> = [];
  for (const record of ordered) {
    const cutoff = Date.parse(record.received_at), marketDate = record.output.evidence_snapshot.market_time.market_date;
    byForecast[record.output.evidence_snapshot.run_id] = { SPY: [], QQQ: [] };
    for (const symbol of symbols) {
      const actual = record.settlement.symbols[symbol].actual_direction;
      const priorActual = ordered.filter((item) => {
        const received = Date.parse(item.received_at), start = Date.parse(item.settlement.observation_window.start_at), end = Date.parse(item.settlement.observation_window.end_at), settled = Date.parse(item.settlement.settled_at);
        // A closed price window is not a result available before its actual settlement.
        return item !== record && received < cutoff && received <= start && start <= end && end <= cutoff && end <= settled && settled <= cutoff;
      }).map((item) => item.settlement.symbols[symbol].actual_direction);
      const bars = history[symbol].filter((bar) => bar.session_date === marketDate && regularSessionBar(bar) && Date.parse(closedAt(bar)) <= cutoff).toSorted((left, right) => Date.parse(left.begins_at) - Date.parse(right.begins_at));
      const last = bars.at(-1), three = bars.slice(-3), volumeBars = bars.filter((bar) => bar.volume !== null && bar.volume > 0);
      const volume = volumeBars.reduce((sum, bar) => sum + bar.volume!, 0), vwap = volume ? volumeBars.reduce((sum, bar) => sum + bar.close * bar.volume!, 0) / volume : null;
      const vwapDirection = last && vwap !== null ? directionFromMove(vwap, last.close) : null;
      const predictions: Record<TsBaselineId, Direction | "WAIT" | null> = {
        PRIOR_MAJORITY: majority(priorActual),
        VWAP_POSITION: vwapDirection,
        LAST_BAR: last ? directionFromMove(last.open, last.close) : null,
        THREE_BAR_TREND: three.length === 3 ? directionFromMove(three[0].open, three.at(-1)!.close) : null,
        VWAP_MEAN_REVERSION: vwapDirection === "BULLISH" ? "BEARISH" : vwapDirection === "BEARISH" ? "BULLISH" : vwapDirection,
        UNIFORM_PROBABILITY: null,
        ALL_WAIT: "WAIT",
      };
      tsPairs.push({ actual, predicted: record.output.symbol_outlooks[symbol].direction });
      for (const baseline of Object.keys(predictions) as TsBaselineId[]) {
        const prediction = predictions[baseline], correct = prediction && prediction !== "WAIT" ? prediction === actual : null;
        byForecast[record.output.evidence_snapshot.run_id][symbol].push({ baseline, prediction, correct });
        if (prediction && prediction !== "WAIT") pairs[baseline].push({ actual, predicted: prediction });
      }
    }
  }
  const totalDirectionDecisions = ordered.length * symbols.length, resolvedPaths = ordered.filter((record) => record.settlement.actual_scenario !== "UNRESOLVED").length;
  const baselines = (Object.keys(baselineLabels) as TsBaselineId[]).map((baseline): TsBaselineMetric => {
    const values = pairs[baseline], correct = values.filter((pair) => pair.actual === pair.predicted).length;
    return { baseline, label: baselineLabels[baseline], sample_count: baseline === "UNIFORM_PROBABILITY" ? resolvedPaths : values.length, correct_count: correct, accuracy: values.length ? correct / values.length : null, coverage: baseline === "UNIFORM_PROBABILITY" ? ordered.length ? resolvedPaths / ordered.length : 0 : values.length / Math.max(1, totalDirectionDecisions), mcc: multiclassMcc(values), mean_brier: baseline === "UNIFORM_PROBABILITY" && resolvedPaths ? 2 / 3 : null };
  });
  const riskPoint = (qualification: TsRiskCoveragePoint["qualification"], eligible: (record: EvaluationRecord) => boolean): TsRiskCoveragePoint => {
    const selected = ordered.filter(eligible), values = selected.flatMap((record) => symbols.map((symbol) => ({ actual: record.settlement.symbols[symbol].actual_direction, predicted: record.output.symbol_outlooks[symbol].direction })));
    const correct = values.filter((pair) => pair.actual === pair.predicted).length, accuracy = values.length ? correct / values.length : null;
    return { qualification, forecast_count: selected.length, coverage: ordered.length ? selected.length / ordered.length : 0, direction_sample_count: values.length, accuracy, risk: accuracy === null ? null : 1 - accuracy, mcc: multiclassMcc(values) };
  };
  return {
    direction_mcc: multiclassMcc(tsPairs),
    baselines,
    risk_coverage: [riskPoint("READY_FOR_D_REVIEW", (record) => record.output.tradeability.status === "READY_FOR_D_REVIEW"), riskPoint("CONDITIONAL_OR_READY", (record) => record.output.tradeability.status !== "WAIT"), riskPoint("ALL_FORECASTS", () => true)],
    by_forecast: byForecast,
  };
}

export function completeSession(date: string, bars: TsSettlementBar[]) {
  const times = new Set(bars.filter((bar) => bar.session_date === date && regularSessionBar(bar)).map((bar) => formatPtTime(bar.begins_at)));
  for (let minute = 390; minute < nyseClosePtMinutes(date); minute += 5) if (!times.has(`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`)) return false;
  return true;
}

function selectedDates(output: TsOutput, history: Record<"SPY" | "QQQ", TsSettlementBar[]>) {
  const common = [...new Set(history.SPY.map((bar) => bar.session_date))]
    .filter((date) => history.QQQ.some((bar) => bar.session_date === date))
    .sort();
  if (output.report_type === "NEXT_SESSION") return common.filter((date) => date > output.evidence_snapshot.market_time.market_date && symbols.every((symbol) => completeSession(date, history[symbol]))).slice(0, 1);
  if (output.report_type === "WEEKEND_OUTLOOK") return common.filter((date) => date > output.evidence_snapshot.market_time.market_date && symbols.every((symbol) => completeSession(date, history[symbol]))).slice(0, 5);
  return common.includes(output.evidence_snapshot.market_time.market_date) ? [output.evidence_snapshot.market_time.market_date] : [];
}

function observationBars(output: TsOutput, history: Record<"SPY" | "QQQ", TsSettlementBar[]>, issuedAt: number, causal: boolean) {
  const dates = selectedDates(output, history);
  const required = output.report_type === "WEEKEND_OUTLOOK" ? 5 : 1;
  if (dates.length !== required) return null;
  const end = output.forecast_window.end_at ? Date.parse(output.forecast_window.end_at) : null;
  const selected = Object.fromEntries(symbols.map((symbol) => {
    const values = history[symbol]
      .filter((bar) => dates.includes(bar.session_date) && regularSessionBar(bar)
        && (!causal || Date.parse(bar.begins_at) >= issuedAt)
        && (end === null || (causal ? Date.parse(closedAt(bar)) <= end : Date.parse(bar.begins_at) < end)))
      .toSorted((a, b) => Date.parse(a.begins_at) - Date.parse(b.begins_at));
    return [symbol, values];
  })) as Record<"SPY" | "QQQ", TsSettlementBar[]>;
  if (symbols.some((symbol) => !selected[symbol].length)) return null;
  const aligned = selected.SPY.map((bar) => bar.begins_at);
  if (JSON.stringify(aligned) !== JSON.stringify(selected.QQQ.map((bar) => bar.begins_at))) return null;
  if (end !== null && symbols.some((symbol) => causal
    ? Date.parse(closedAt(selected[symbol].at(-1)!)) + 5 * 60_000 <= end
    : Date.parse(closedAt(selected[symbol].at(-1)!)) < end)) return null;
  return { dates, selected };
}

function metricBars(values: TsSettlementBar[]) {
  let date = "", high = -Infinity, low = Infinity, volume = 0, value = 0, opening: TsSettlementBar[] = [];
  return values.map((bar): MetricBar => {
    if (date !== bar.session_date) { date = bar.session_date; high = -Infinity; low = Infinity; volume = 0; value = 0; opening = []; }
    high = Math.max(high, bar.high); low = Math.min(low, bar.low);
    if (opening.length < 6) opening.push(bar);
    if (bar.volume !== null) { volume += bar.volume; value += bar.close * bar.volume; }
    return { ...bar, closed_at: closedAt(bar), vwap: volume ? value / volume : null, session_high: high, session_low: low, opening_range_high: opening.length === 6 ? Math.max(...opening.map((item) => item.high)) : null, opening_range_low: opening.length === 6 ? Math.min(...opening.map((item) => item.low)) : null };
  });
}

function metricValue(condition: Condition, bar: MetricBar) {
  return condition.metric === "LAST_PRICE" ? bar.close : condition.metric === "VWAP" ? bar.vwap : condition.metric === "SESSION_HIGH" ? bar.session_high : condition.metric === "SESSION_LOW" ? bar.session_low : condition.metric === "OPENING_RANGE_HIGH" ? bar.opening_range_high : bar.opening_range_low;
}

function matches(value: number | null, condition: Condition) {
  if (value === null) return false;
  if (condition.operator === "ABOVE") return value > condition.value;
  if (condition.operator === "BELOW") return value < condition.value;
  if (condition.operator === "AT_OR_ABOVE") return value >= condition.value;
  if (condition.operator === "AT_OR_BELOW") return value <= condition.value;
  return condition.upper_value !== null && value >= condition.value && value <= condition.upper_value;
}

function confirmedTimes(condition: Condition, bars: MetricBar[], issuedAt: number) {
  const minutes = confirmationMinutes[condition.confirmation];
  if (!minutes) return new Set<string>();
  const count = minutes / 5, result = new Set<string>();
  for (let index = count - 1; index < bars.length; index += 1) {
    const window = bars.slice(index - count + 1, index + 1), times = window.map((bar) => Date.parse(bar.closed_at));
    if (Date.parse(window[0].begins_at) < issuedAt || !matches(metricValue(condition, bars[index]), condition)) continue;
    if (times.some((time, offset) => offset > 0 && time - times[offset - 1] !== 5 * 60_000)) continue;
    const closed = new Date(times.at(-1)!);
    if (closed.getUTCSeconds() === 0 && closed.getUTCMinutes() % minutes === 0) result.add(closed.toISOString());
  }
  return result;
}

function firstGroupTime(group: Group, bars: Record<"SPY" | "QQQ", MetricBar[]>, issuedAt: number, notBefore: number) {
  const sets = group.conditions.map((condition) => confirmedTimes(condition, bars[condition.symbol], issuedAt));
  if (!sets.length) return null;
  const candidates = group.logic === "ALL" ? [...sets[0]].filter((time) => sets.slice(1).every((set) => set.has(time))) : [...new Set(sets.flatMap((set) => [...set]))];
  return candidates.filter((time) => Date.parse(time) >= notBefore).sort()[0] ?? null;
}

function scenarioResult(scenario: Scenario, bars: Record<"SPY" | "QQQ", MetricBar[]>, issuedAt: number, startAt: number) {
  const groups = [scenario.activation, scenario.invalidation, ...scenario.sequence.map((stage) => ({ logic: "ALL" as const, conditions: stage.conditions }))];
  if (groups.some((group) => group.conditions.some((condition) => condition.confirmation === "LIVE_QUOTE"))) return { status: "UNRESOLVED" as const, activated_at: null, invalidated_at: null, completed_stage_count: 0, completed_at: null };
  const activation = firstGroupTime(scenario.activation, bars, issuedAt, startAt);
  if (!activation) return { status: "NOT_ACTIVATED" as const, activated_at: null, invalidated_at: null, completed_stage_count: 0, completed_at: null };
  const invalidated = firstGroupTime(scenario.invalidation, bars, issuedAt, Date.parse(activation));
  let completed = 0, cursor = activation;
  for (const [index, stage] of scenario.sequence.entries()) {
    if (stage.order !== index + 1) return { status: "UNRESOLVED" as const, activated_at: activation, invalidated_at: invalidated, completed_stage_count: completed, completed_at: cursor };
    const completedAt = firstGroupTime({ logic: "ALL", conditions: stage.conditions }, bars, issuedAt, Date.parse(cursor) + 1);
    if (invalidated && (!completedAt || Date.parse(invalidated) <= Date.parse(completedAt))) return { status: "INVALIDATED" as const, activated_at: activation, invalidated_at: invalidated, completed_stage_count: completed, completed_at: invalidated };
    if (!completedAt) return { status: "PARTIAL" as const, activated_at: activation, invalidated_at: invalidated, completed_stage_count: completed, completed_at: cursor };
    completed += 1; cursor = completedAt;
  }
  return { status: "CONFIRMED" as const, activated_at: activation, invalidated_at: invalidated, completed_stage_count: completed, completed_at: cursor };
}

function actualDirection(returnPct: number): "BULLISH" | "BEARISH" | "RANGE" { return Math.abs(returnPct) <= 0.05 ? "RANGE" : returnPct > 0 ? "BULLISH" : "BEARISH"; }
function normalizedRegime(value: string) {
  if (["TREND_UP", "TREND_DOWN", "NARROW_RANGE", "WIDE_CHOP"].includes(value)) return value;
  if (["FALSE_BREAKOUT", "FALSE_BREAKDOWN"].includes(value)) return "FALSE_BREAKOUT";
  if (["TRANSITION", "MIXED", "V_REVERSAL_UP", "V_REVERSAL_DOWN"].includes(value)) return "TRANSITION";
  return "UNKNOWN";
}

function realizedRegime(bars: Record<"SPY" | "QQQ", MetricBar[]>, issuedAt: number) {
  const values = symbols.map((symbol) => {
    const eligible = bars[symbol].filter((bar) => Date.parse(bar.begins_at) >= issuedAt), first = eligible[0], last = eligible.at(-1)!;
    const range = (Math.max(...eligible.map((bar) => bar.high)) - Math.min(...eligible.map((bar) => bar.low))) / first.open * 100;
    const net = (last.close / first.open - 1) * 100;
    const crossings = eligible.slice(1).filter((bar, index) => bar.vwap !== null && eligible[index].vwap !== null && (bar.close - bar.vwap) * (eligible[index].close - eligible[index].vwap!) < 0).length;
    return { range, net, crossings };
  });
  const range = values.reduce((sum, item) => sum + item.range, 0) / values.length;
  const net = values.reduce((sum, item) => sum + item.net, 0) / values.length;
  const crossings = Math.min(...values.map((item) => item.crossings));
  // ponytail: fixed intraday thresholds; replace only after natural LIVE calibration has enough samples.
  if (range <= 0.35 && Math.abs(net) <= 0.15) return "NARROW_RANGE";
  if (crossings >= 3 && Math.abs(net) <= Math.max(0.15, range * 0.25)) return "FALSE_BREAKOUT";
  if (range >= 0.8 && Math.abs(net) <= range * 0.4) return "WIDE_CHOP";
  if (net >= Math.max(0.15, range * 0.5)) return "TREND_UP";
  if (net <= -Math.max(0.15, range * 0.5)) return "TREND_DOWN";
  return "TRANSITION";
}
function levelKind(label: string) { return /support|支撑/i.test(label) ? "support" : /resistance|阻力/i.test(label) ? "resistance" : null; }

export function settleTsForecast(output: TsOutput, history: Record<"SPY" | "QQQ", TsSettlementBar[]>, settledAt: string, identity?: TsForecastIdentity, marketSource: "ROBINHOOD" | "TRADIER" = "ROBINHOOD"): TsSettlementResult | null {
  const causal = Boolean(identity), issuedAt = Date.parse(identity?.received_at ?? output.evidence_snapshot.market_time.observed_at), startAt = Math.max(Date.parse(output.forecast_window.start_at), issuedAt);
  const end = output.forecast_window.end_at ? Date.parse(output.forecast_window.end_at) : null;
  if (causal && end !== null && Date.parse(settledAt) < end) return null;
  const observed = observationBars(output, history, issuedAt, causal);
  if (!observed) return null;
  const bars = Object.fromEntries(symbols.map((symbol) => [symbol, metricBars(observed.selected[symbol])])) as Record<"SPY" | "QQQ", MetricBar[]>;
  if (symbols.some((symbol) => !bars[symbol].some((bar) => Date.parse(bar.begins_at) >= issuedAt))) return null;
  const scenarioResults = Object.fromEntries(scenarios.map((name) => [name, scenarioResult(output.scenarios[name] as unknown as Scenario, bars, issuedAt, startAt)])) as TsSettlementResult["scenario_results"];
  const completed = scenarios.flatMap((name) => scenarioResults[name].status === "CONFIRMED" && scenarioResults[name].completed_at ? [{ name, at: scenarioResults[name].completed_at! }] : []).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let actualScenario: TsSettlementResult["actual_scenario"] = completed.length && (completed.length === 1 || completed[0].at < completed[1].at) ? completed[0].name.toUpperCase() as TsSettlementResult["actual_scenario"] : "UNRESOLVED";
  const symbolResults = Object.fromEntries(symbols.map((symbol) => {
    const eligible = bars[symbol].filter((bar) => Date.parse(bar.begins_at) >= issuedAt), first = eligible[0], last = eligible.at(-1)!;
    const returnPct = (last.close / first.open - 1) * 100, direction = actualDirection(returnPct), forecast = output.symbol_outlooks[symbol].direction;
    const rawLevels = output.key_levels.flatMap((item) => item && typeof item === "object" ? [item as { symbol?: unknown; label?: unknown; value?: unknown }] : []).filter((item) => item.symbol === symbol && typeof item.label === "string" && typeof item.value === "number") as Array<{ symbol: string; label: string; value: number }>;
    const support = rawLevels.filter((item) => levelKind(item.label) === "support" && item.value <= first.open).sort((a, b) => b.value - a.value)[0]?.value ?? null;
    const resistance = rawLevels.filter((item) => levelKind(item.label) === "resistance" && item.value >= first.open).sort((a, b) => a.value - b.value)[0]?.value ?? null;
    const actualLow = Math.min(...eligible.map((bar) => bar.low)), actualHigh = Math.max(...eligible.map((bar) => bar.high));
    return [symbol, {
      forecast_direction: forecast, actual_direction: direction, direction_correct: forecast === direction,
      start_price: first.open, end_price: last.close, return_pct: Number(returnPct.toFixed(6)), actual_low: actualLow, actual_high: actualHigh,
      range_result: support === null || resistance === null ? { status: "NOT_SCORABLE" as const, support, resistance } : { status: actualLow >= support && actualHigh <= resistance ? "CORRECT" as const : "BREACHED" as const, support, resistance },
      key_levels: rawLevels.map((item) => ({ label: item.label, value: item.value, observed: actualLow <= item.value && actualHigh >= item.value })),
    }];
  })) as TsSettlementResult["symbols"];
  const swingSymbols = Object.fromEntries(symbols.map((symbol) => {
    const eligible = bars[symbol].filter((bar) => Date.parse(bar.begins_at) >= issuedAt), first = eligible[0], last = eligible.at(-1)!;
    const maximum = eligible.reduce((best, bar) => bar.high > best.high ? bar : best), minimum = eligible.reduce((best, bar) => bar.low < best.low ? bar : best);
    const upside = (maximum.high / first.open - 1) * 100, downside = (minimum.low / first.open - 1) * 100, forecast = output.symbol_outlooks[symbol].direction;
    return [symbol, {
      entry_price: first.open, entry_at: first.begins_at, max_price: maximum.high, max_bar_closed_at: closedAt(maximum), min_price: minimum.low, min_bar_closed_at: closedAt(minimum), close_price: last.close, close_at: closedAt(last),
      upside_excursion_pct: Number(upside.toFixed(6)), downside_excursion_pct: Number(downside.toFixed(6)),
      favorable_excursion_pct: forecast === "BULLISH" ? Number(upside.toFixed(6)) : forecast === "BEARISH" ? Number((-downside).toFixed(6)) : null,
      adverse_excursion_pct: forecast === "BULLISH" ? Number(downside.toFixed(6)) : forecast === "BEARISH" ? Number((-upside).toFixed(6)) : null,
      first_extreme: Date.parse(closedAt(maximum)) < Date.parse(closedAt(minimum)) ? "HIGH_FIRST" as const : Date.parse(closedAt(minimum)) < Date.parse(closedAt(maximum)) ? "LOW_FIRST" as const : "SAME_BAR_UNRESOLVED" as const,
    }];
  })) as Record<"SPY" | "QQQ", TsSwingObservation>;
  const selectedBeforeDirectionCheck = actualScenario;
  if (actualScenario !== "UNRESOLVED") {
    const expected = actualScenario === "MAIN" ? symbols.map((symbol) => output.symbol_outlooks[symbol].direction) : symbols.map(() => output.scenarios[actualScenario.toLowerCase() as "reverse" | "extreme"].bias);
    if (symbols.some((symbol, index) => symbolResults[symbol].actual_direction !== expected[index])) actualScenario = "UNRESOLVED";
  }
  const completedBeforeDirectionCheck = completed.map((item) => item.name.toUpperCase() as "MAIN" | "REVERSE" | "EXTREME");
  const resolution: TsSettlementResult["scenario_resolution"] = actualScenario !== "UNRESOLVED"
    ? { status: "UNIQUE", selected: actualScenario, competing: completedBeforeDirectionCheck.filter((name) => name !== actualScenario), reason: "唯一最早完成且方向与发布合同一致的情景被归属为最终路径。" }
    : selectedBeforeDirectionCheck !== "UNRESOLVED"
      ? { status: "DIRECTION_CONFLICT", selected: null, competing: completedBeforeDirectionCheck, reason: "情景条件完成，但发布方向与实际方向不一致；不强行归属。" }
      : completedBeforeDirectionCheck.length > 1
        ? { status: "AMBIGUOUS", selected: null, competing: completedBeforeDirectionCheck, reason: "多条情景在同一最早时点完成，保留歧义，不混写为单一路径。" }
        : { status: "NO_COMPLETE_PATH", selected: null, competing: completedBeforeDirectionCheck, reason: "没有情景形成完整、唯一的激活—序列—失效归属。" };
  const probabilities = Object.fromEntries(scenarios.map((name) => [name, output.scenarios[name].probability_pct])) as TsSettlementResult["scenario_probabilities"];
  const brier = actualScenario === "UNRESOLVED" ? null : Number(scenarios.reduce((sum, name) => sum + (probabilities[name] / 100 - (name.toUpperCase() === actualScenario ? 1 : 0)) ** 2, 0).toFixed(6));
  const publishedRegime = normalizedRegime(output.current_pattern.regime), observedRegime = realizedRegime(bars, issuedAt);
  const patternResult: TsSettlementResult["pattern_result"] = publishedRegime === "UNKNOWN"
    ? { status: "NOT_SCORABLE", published_regime: output.current_pattern.regime, realized_regime: observedRegime, reason: "发布时盘型未观察到，不能评价盘型持续或转换。" }
    : { status: publishedRegime === observedRegime ? "PERSISTED" : "TRANSITIONED", published_regime: publishedRegime, realized_regime: observedRegime, reason: publishedRegime === observedRegime ? "发布时盘型在观察窗口内保持。" : `观察窗口从 ${publishedRegime} 转为 ${observedRegime}；这是转换记录，不回写原预测。` };
  const tradeabilityOutcome: NonNullable<TsSettlementResult["tradeability_result"]>["outcome"] = output.tradeability.status === "WAIT"
    ? actualScenario === "UNRESOLVED" ? "WAIT_DISCIPLINE_PRESERVED" : "WAIT_REVIEW_REQUIRED"
    : output.tradeability.status === "CONDITIONAL" ? actualScenario === "UNRESOLVED" ? "CONDITION_NOT_TRIGGERED" : "CONDITION_TRIGGERED"
      : actualScenario === "UNRESOLVED" ? "READY_NOT_CONFIRMED" : "READY_CONFIRMED";
  const tradeabilityResult: NonNullable<TsSettlementResult["tradeability_result"]> = { published_status: output.tradeability.status, outcome: tradeabilityOutcome, reason: tradeabilityOutcome === "WAIT_DISCIPLINE_PRESERVED" ? "正式 WAIT 避开了未形成唯一确认路径的窗口。" : tradeabilityOutcome === "WAIT_REVIEW_REQUIRED" ? "WAIT 期间出现完整场景确认；保留为复核样本，不自动判定错失交易。" : "按原合同激活条件与真实 5 分钟 K 线结算。" };
  const sourceHashes = [...new Set(symbols.flatMap((symbol) => observed.selected[symbol].map((bar) => bar.snapshot_hash)))].sort();
  const ends = symbols.flatMap((symbol) => observed.selected[symbol].map((bar) => Date.parse(closedAt(bar))));
  const firstScorable = observed.selected.SPY[0].begins_at;
  return {
    contract_version: causal ? "v2" : "v1", component: "TS_FORECAST_SETTLEMENT", ...(causal ? { settlement_contract_id: TS_SETTLEMENT_CAUSAL_CONTRACT, forecast_identity: identity } : {}), forecast_run_id: output.evidence_snapshot.run_id, settled_at: new Date(settledAt).toISOString(),
    status: actualScenario === "UNRESOLVED" ? "PARTIAL" : "RESOLVED", source: marketSource, source_snapshot_hashes: sourceHashes,
    observation_window: { start_at: new Date(issuedAt).toISOString(), end_at: new Date(Math.max(...ends)).toISOString(), target_market_dates: observed.dates, ...(causal ? { observed_at: identity!.observed_at, received_at: identity!.received_at, gateway_delay_ms: identity!.gateway_delay_ms, first_scorable_bar_at: firstScorable, bar_count: observed.selected.SPY.length } : {}) },
    actual_scenario: actualScenario, scenario_probabilities: probabilities, scenario_results: scenarioResults, scenario_resolution: resolution, brier_score: brier,
    path_result: actualScenario === "MAIN" ? "MAIN_CORRECT" : actualScenario === "UNRESOLVED" ? "UNRESOLVED" : "ALTERNATE_PATH",
    timing_result: actualScenario === "UNRESOLVED" ? { status: "NOT_SCORABLE", completed_at: null } : { status: "ON_TIME", completed_at: scenarioResults[actualScenario.toLowerCase() as "main" | "reverse" | "extreme"].completed_at },
    pattern_result: patternResult,
    amplitude_result: { status: "OBSERVED", symbols: Object.fromEntries(symbols.map((symbol) => [symbol, { net_move_pct: symbolResults[symbol].return_pct, range_pct: Number(((symbolResults[symbol].actual_high - symbolResults[symbol].actual_low) / symbolResults[symbol].start_price * 100).toFixed(6)) }])) as Record<"SPY" | "QQQ", { net_move_pct: number; range_pct: number }> },
    tradeability_result: tradeabilityResult,
    swing_observation: { basis: marketSource === "TRADIER" ? "TRADIER_REGULAR_SESSION" : "ROBINHOOD_REGULAR_SESSION", holding_style: "MANUAL_SINGLE_LEG_0_TO_15_DTE", execution_scope: "READ_ONLY_NO_ORDER_ACTION", symbols: swingSymbols },
    symbols: symbolResults,
    notes: actualScenario === "UNRESOLVED" ? ["方向可以独立结算；三条路径没有形成唯一且完整的可校准结果"] : [],
  };
}

export function forecastDue(output: TsOutput, now: Date, settlement: TsSettlementResult | null) {
  if (settlement) return true;
  if (output.forecast_window.end_at) return Date.parse(output.forecast_window.end_at) <= now.getTime();
  return output.evidence_snapshot.market_time.market_date < ptDateKey(now);
}

export function checkpointExclusions(checkpoints: ScheduleCheckpoint[], activatedAt: string) {
  const relevant = checkpoints.filter((item) => Date.parse(item.completed_at) >= Date.parse(activatedAt) && ["TS_FORECAST", "FULL_ANALYSIS", "EVENING_ANALYSIS"].includes(item.kind));
  const byTime = new Map<string, ScheduleCheckpoint>();
  for (const item of relevant) {
    const current = byTime.get(item.scheduled_at);
    if (!current || (current.status !== "SUCCEEDED" && item.status === "SUCCEEDED")) byTime.set(item.scheduled_at, item);
  }
  return [...byTime.values()].filter((item) => item.status !== "SUCCEEDED").map((item) => ({ slot: item.business_slot, status: item.status, reason: item.reason ?? "该槽没有产生可交付预测" }));
}
