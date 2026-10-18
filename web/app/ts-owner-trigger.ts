import type { OptionStrategySignal, TsOutput } from "./snapshot-import.ts";

export type OwnerTriggerState = "DIRECTION_WATCH" | "PRESSURE_TEST" | "TRIGGER_CONFIRMING" | "PATH_ACTIVATED" | "CHASE_RISK_HIGH" | "PATH_INVALIDATED";
export type TriggerSymbol = "SPY" | "QQQ";
type TriggerBar = { begins_at: string; open: number; high: number; low: number; close: number; volume?: number | null; session?: string; trading_date?: string };
export type TriggerChart = { source: string; symbol: string; interval: string; status: string; as_of?: string | null; current_price?: number | null; session_dates?: string[]; bars: TriggerBar[] };
type Condition = { symbol: TriggerSymbol; metric: string; operator: string; value: number; upper_value: number | null; confirmation: string };
type Group = { logic: "ALL" | "ANY"; conditions: Condition[] };

export type OwnerTriggerEvent = {
  contract_version: "v1";
  component: "TS_OWNER_TRIGGER_EVENT";
  event_id: string;
  idea_id: string;
  forecast_run_id: string;
  symbol: TriggerSymbol;
  forecast_slot: string;
  original_probability_pct: number;
  old_state: OwnerTriggerState | null;
  new_state: OwnerTriggerState;
  changed_at: string;
  data_timestamp: string | null;
  source_mode: "LIVE";
  replay: false;
  structure: { direction: TsOutput["symbol_outlooks"][TriggerSymbol]["direction"]; pattern: string; summary: string };
  key_zone: { kind: "SUPPORT" | "RESISTANCE" | "RANGE"; low: number | null; high: number | null };
  activation: { logic: "ALL" | "ANY"; conditions: Condition[]; display: string };
  invalidation: { logic: "ALL" | "ANY"; conditions: Condition[]; display: string };
  current_price: number | null;
  target_range: { low: number; high: number } | null;
  remaining_space: number | null;
  state_reason: string;
  invalidation_reason: string | null;
  owner_action: "OBSERVE" | "WAIT" | "CONSIDER_BY_RULE" | "DO_NOT_CHASE" | "CANCEL_SCENARIO";
  is_tradeable: boolean;
  risk_blockers: string[];
  option_evidence: { status: "OBSERVED" | "NOT_OBSERVED"; owner_action: string | null; candidate_status: string | null; liquidity: string | null; spread_pct: number | null; volatility_gate: string | null; price_state: string | null; as_of: string | null };
  proxy_evidence: Array<{ source: string; role: string; as_of: string | null }>;
  market_snapshot: { observed_at: string; bars: Array<Pick<TriggerBar, "begins_at" | "open" | "high" | "low" | "close" | "volume">> };
  previous_slot_change: string;
};

export type OwnerTriggerOverview = { current: Record<TriggerSymbol, OwnerTriggerEvent | null>; recent: OwnerTriggerEvent[] };

const confirmations: Record<string, number> = { LIVE_QUOTE: 2, ONE_5M_CLOSE: 1, ONE_15M_CLOSE: 3, ONE_30M_CLOSE: 6 };
const operators: Record<string, string> = { ABOVE: ">", BELOW: "<", AT_OR_ABOVE: "≥", AT_OR_BELOW: "≤", BETWEEN: "区间" };
const metrics: Record<string, string> = { LAST_PRICE: "当前价", VWAP: "VWAP", SESSION_HIGH: "当日高点", SESSION_LOW: "当日低点", OPENING_RANGE_HIGH: "开盘区间高点", OPENING_RANGE_LOW: "开盘区间低点" };
const confirmationText: Record<string, string> = { LIVE_QUOTE: "连续报价", ONE_5M_CLOSE: "5分钟收盘", ONE_15M_CLOSE: "15分钟收盘", ONE_30M_CLOSE: "30分钟收盘" };

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function parseGroup(value: unknown): Group {
  if (!value || typeof value !== "object") return { logic: "ALL", conditions: [] };
  const raw = value as { logic?: unknown; conditions?: unknown };
  const conditions = Array.isArray(raw.conditions) ? raw.conditions.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    return (row.symbol === "SPY" || row.symbol === "QQQ") && typeof row.metric === "string" && typeof row.operator === "string" && finite(row.value) && (row.upper_value === null || finite(row.upper_value)) && typeof row.confirmation === "string"
      ? [{ symbol: row.symbol as TriggerSymbol, metric: row.metric, operator: row.operator, value: row.value, upper_value: row.upper_value as number | null, confirmation: row.confirmation }]
      : [];
  }) : [];
  return { logic: raw.logic === "ANY" ? "ANY" : "ALL", conditions };
}

function conditionText(condition: Condition) {
  const value = condition.operator === "BETWEEN" && condition.upper_value !== null ? `${condition.value.toFixed(2)}–${condition.upper_value.toFixed(2)}` : condition.value.toFixed(2);
  return `${condition.symbol} ${metrics[condition.metric] ?? condition.metric} ${operators[condition.operator] ?? condition.operator} ${value}（${confirmationText[condition.confirmation] ?? condition.confirmation}确认）`;
}

function groupText(group: Group) { return group.conditions.length ? group.conditions.map(conditionText).join(group.logic === "ALL" ? " 且 " : " 或 ") : "原预测未上报可复算条件"; }

function passes(value: number | null, condition: Condition) {
  if (value === null) return false;
  if (condition.operator === "ABOVE") return value > condition.value;
  if (condition.operator === "BELOW") return value < condition.value;
  if (condition.operator === "AT_OR_ABOVE") return value >= condition.value;
  if (condition.operator === "AT_OR_BELOW") return value <= condition.value;
  return condition.operator === "BETWEEN" && condition.upper_value !== null && value >= condition.value && value <= condition.upper_value;
}

function regularBars(chart: TriggerChart, observedAt: string) {
  const observed = Date.parse(observedAt);
  return chart.bars.filter((bar) => bar.session === undefined || bar.session === "REGULAR").filter((bar) => Number.isFinite(Date.parse(bar.begins_at)) && Date.parse(bar.begins_at) + 300_000 <= observed).toSorted((left, right) => Date.parse(left.begins_at) - Date.parse(right.begins_at));
}

function metricAt(bars: TriggerBar[], index: number, metric: string) {
  if (index < 0) return null;
  const visible = bars.slice(0, index + 1), bar = bars[index];
  if (metric === "LAST_PRICE") return bar.close;
  if (metric === "SESSION_HIGH") return Math.max(...visible.map((item) => item.high));
  if (metric === "SESSION_LOW") return Math.min(...visible.map((item) => item.low));
  if (metric === "OPENING_RANGE_HIGH") return Math.max(...visible.slice(0, 3).map((item) => item.high));
  if (metric === "OPENING_RANGE_LOW") return Math.min(...visible.slice(0, 3).map((item) => item.low));
  if (metric === "VWAP") {
    const weighted = visible.filter((item) => finite(item.volume) && item.volume > 0);
    const volume = weighted.reduce((sum, item) => sum + item.volume!, 0);
    return volume ? weighted.reduce((sum, item) => sum + (item.high + item.low + item.close) / 3 * item.volume!, 0) / volume : null;
  }
  return null;
}

function conditionAssessment(condition: Condition, chart: TriggerChart | undefined, forecastAt: string, observedAt: string) {
  if (!chart) return { confirmed: false, progressing: false, near: false, current: null as number | null };
  const bars = regularBars(chart, observedAt), eligible = bars.map((bar, index) => ({ bar, index })).filter(({ bar }) => Date.parse(bar.begins_at) >= Date.parse(forecastAt));
  const observations = eligible.map(({ index }) => metricAt(bars, index, condition.metric));
  const required = confirmations[condition.confirmation] ?? 2;
  let consecutive = 0;
  for (const value of observations.toReversed()) { if (!passes(value, condition)) break; consecutive += 1; }
  const current = condition.metric === "LAST_PRICE" && finite(chart.current_price) ? chart.current_price : metricAt(bars, bars.length - 1, condition.metric);
  const raw = chart.bars.filter((bar) => bar.session === undefined || bar.session === "REGULAR").toSorted((left, right) => Date.parse(left.begins_at) - Date.parse(right.begins_at)).at(-1);
  const touched = Boolean(raw && (condition.operator === "ABOVE" || condition.operator === "AT_OR_ABOVE" ? raw.high >= condition.value : condition.operator === "BELOW" || condition.operator === "AT_OR_BELOW" ? raw.low <= condition.value : condition.upper_value !== null && raw.high >= condition.value && raw.low <= condition.upper_value));
  const averageRange = bars.slice(-12).reduce((sum, bar) => sum + bar.high - bar.low, 0) / Math.max(1, Math.min(12, bars.length));
  const distance = current === null ? Number.POSITIVE_INFINITY : condition.operator === "BETWEEN" && condition.upper_value !== null ? current < condition.value ? condition.value - current : current > condition.upper_value ? current - condition.upper_value : 0 : Math.abs(current - condition.value);
  return { confirmed: consecutive >= required, progressing: consecutive > 0 || passes(current, condition) || touched, near: distance <= averageRange, current };
}

function groupResult(group: Group, charts: Map<string, TriggerChart>, forecastAt: string, observedAt: string) {
  const rows = group.conditions.map((condition) => conditionAssessment(condition, charts.get(condition.symbol), forecastAt, observedAt));
  const combine = (field: "confirmed" | "progressing" | "near") => rows.length > 0 && (group.logic === "ALL" ? rows.every((row) => row[field]) : rows.some((row) => row[field]));
  return { confirmed: combine("confirmed"), progressing: combine("progressing"), near: combine("near") };
}

function keyZone(forecast: TsOutput, symbol: TriggerSymbol, direction: "BULLISH" | "BEARISH" | "RANGE", activation: Group) {
  const pattern = direction === "BEARISH" ? /support|支撑|低点|下沿|下破/i : direction === "BULLISH" ? /resistance|阻力|高点|上沿|突破/i : /support|resistance|支撑|阻力|低点|高点|下沿|上沿|区间/i;
  const values = forecast.key_levels.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    return row.symbol === symbol && typeof row.label === "string" && pattern.test(row.label) && finite(row.value) ? [row.value] : [];
  });
  const condition = activation.conditions.find((item) => item.symbol === symbol);
  if (!values.length && condition) values.push(condition.value, ...(condition.upper_value === null ? [] : [condition.upper_value]));
  return { kind: direction === "BEARISH" ? "SUPPORT" as const : direction === "BULLISH" ? "RESISTANCE" as const : "RANGE" as const, low: values.length ? Math.min(...values) : null, high: values.length ? Math.max(...values) : null };
}

function targets(forecast: TsOutput, symbol: TriggerSymbol) {
  const values = forecast.scenarios.main.sequence.flatMap((stage) => parseGroup(stage).conditions.filter((condition) => condition.symbol === symbol).map((condition) => condition.value));
  return values.length ? { low: Math.min(...values), high: Math.max(...values) } : null;
}

function optionEvidence(signal: OptionStrategySignal | null, symbol: TriggerSymbol, forecast: TsOutput) {
  const candidate = signal ? signal.candidates.find((item) => item.candidate_id === signal.selected_candidate_id && item.symbol === symbol) ?? signal.candidates.find((item) => item.candidate_id === signal.best_candidate_id && item.symbol === symbol) ?? null : null;
  const spread = candidate?.liquidity.max_relative_spread_pct ?? null;
  const blockers = [
    ...(forecast.tradeability.status === "READY_FOR_D_REVIEW" ? [] : [forecast.tradeability.reason]),
    ...(!signal ? ["本槽没有匹配的自然LIVE期权策略复核"] : []),
    ...(signal && signal.owner_action !== "EXECUTABLE" ? [`期权策略状态 ${signal.owner_action}：${signal.decision_basis}`] : []),
    ...(signal?.risk_summary.issues.filter((item) => item.layer === "CORE_HARD_BLOCK" || item.layer === "NEW_ENTRY_BLOCK").map((item) => item.reason) ?? []),
    ...(candidate?.liquidity.status === "BLOCKED" ? ["Bid / Ask或流动性门禁未通过"] : []),
    ...(candidate?.volatility_gate && candidate.volatility_gate.status !== "PASS" ? candidate.volatility_gate.reasons : []),
    ...(candidate?.data_gaps ?? []),
  ];
  const strictPass = forecast.tradeability.status === "READY_FOR_D_REVIEW" && signal?.source_mode === "LIVE" && signal.owner_action === "EXECUTABLE" && candidate?.status === "PASS" && candidate.liquidity.status === "PASS" && candidate.volatility_gate?.status === "PASS" && signal.risk_summary.core_hard_block_count === 0 && signal.risk_summary.new_entry_block_count === 0;
  return {
    isTradeable: Boolean(strictPass),
    blockers: [...new Set(blockers)].slice(0, 12),
    evidence: { status: signal && candidate ? "OBSERVED" as const : "NOT_OBSERVED" as const, owner_action: signal?.owner_action ?? null, candidate_status: candidate?.status ?? null, liquidity: candidate?.liquidity.status ?? null, spread_pct: spread, volatility_gate: candidate?.volatility_gate?.status ?? null, price_state: candidate?.volatility_gate?.price_state ?? null, as_of: signal?.observed_at ?? null },
  };
}

export function evaluateOwnerTrigger(input: { forecast: TsOutput; forecastSlot: string; symbol: TriggerSymbol; charts: TriggerChart[]; previous: OwnerTriggerEvent | null; optionSignal: OptionStrategySignal | null; observedAt: string }): Omit<OwnerTriggerEvent, "event_id"> {
  const { forecast, forecastSlot, symbol, previous, optionSignal, observedAt } = input, charts = new Map(input.charts.map((chart) => [chart.symbol, chart]));
  const activation = parseGroup(forecast.scenarios.main.activation), invalidation = parseGroup(forecast.scenarios.main.invalidation), direction = forecast.symbol_outlooks[symbol].direction;
  const activationResult = groupResult(activation, charts, forecast.forecast_window.start_at || forecast.evidence_snapshot.market_time.observed_at, observedAt), invalidationResult = groupResult(invalidation, charts, forecast.forecast_window.start_at || forecast.evidence_snapshot.market_time.observed_at, observedAt);
  const chart = charts.get(symbol), currentPrice = finite(chart?.current_price) ? chart.current_price : chart?.bars.at(-1)?.close ?? null, targetRange = targets(forecast, symbol), symbolActivation = activation.conditions.find((condition) => condition.symbol === symbol);
  const directionalTarget = targetRange && currentPrice !== null ? direction === "BEARISH" ? targetRange.low : direction === "BULLISH" ? targetRange.high : null : null;
  const activationValue = symbolActivation?.value ?? null, totalSpace = directionalTarget !== null && activationValue !== null ? Math.abs(directionalTarget - activationValue) : null;
  const remainingSpace = directionalTarget !== null && currentPrice !== null ? Math.max(0, direction === "BEARISH" ? currentPrice - directionalTarget : directionalTarget - currentPrice) : null;
  const priceChase = totalSpace !== null && totalSpace > 0 && remainingSpace !== null && remainingSpace / totalSpace <= .35;
  const risk = optionEvidence(optionSignal, symbol, forecast);
  const wasActive = previous?.new_state === "PATH_ACTIVATED" || previous?.new_state === "CHASE_RISK_HIGH";
  let newState: OwnerTriggerState, stateReason: string, invalidationReason: string | null = null;
  if (previous?.new_state === "PATH_INVALIDATED") {
    newState = "PATH_INVALIDATED"; invalidationReason = previous.invalidation_reason ?? "当前预测路径已失效"; stateReason = invalidationReason;
  } else if (invalidationResult.confirmed || wasActive && forecast.scenarios.main.bias !== "RANGE" && !activationResult.confirmed) {
    newState = "PATH_INVALIDATED"; invalidationReason = invalidationResult.confirmed ? `原预测失效条件已确认：${groupText(invalidation)}` : "激活条件被快速收复，按假突破处理"; stateReason = invalidationReason;
  } else if (activationResult.confirmed || wasActive && forecast.scenarios.main.bias === "RANGE") {
    const chase = wasActive && (priceChase || Boolean(optionSignal && !risk.isTradeable));
    newState = chase ? "CHASE_RISK_HIGH" : "PATH_ACTIVATED";
    stateReason = chase ? "路径此前已经确认；当前剩余空间或期权/风控条件不再支持追单" : "原预测激活条件已由完整官方K线确认，先追加路径激活证据";
  } else if (activationResult.progressing) {
    newState = "TRIGGER_CONFIRMING"; stateReason = "价格已触碰或短暂越过关键位，等待合同要求的完整K线确认";
  } else if (activationResult.near) {
    newState = "PRESSURE_TEST"; stateReason = "价格进入由当前自然K线波动范围定义的关键位压测区，继续WAIT";
  } else {
    newState = "DIRECTION_WATCH"; stateReason = "方向倾向已形成，但价格尚未接近主路径激活条件";
  }
  const isTradeable = newState === "PATH_ACTIVATED" && risk.isTradeable;
  const ownerAction = newState === "PATH_INVALIDATED" ? "CANCEL_SCENARIO" as const : newState === "CHASE_RISK_HIGH" ? "DO_NOT_CHASE" as const : newState === "PATH_ACTIVATED" ? isTradeable ? "CONSIDER_BY_RULE" as const : "DO_NOT_CHASE" as const : newState === "DIRECTION_WATCH" ? "OBSERVE" as const : "WAIT" as const;
  const dataTimestamp = input.charts.map((item) => item.as_of).filter((item): item is string => Boolean(item)).sort().at(0) ?? null;
  const bars = chart ? regularBars(chart, observedAt).slice(-6).map(({ begins_at, open, high, low, close, volume = null }) => ({ begins_at, open, high, low, close, volume })) : [];
  return {
    contract_version: "v1", component: "TS_OWNER_TRIGGER_EVENT", idea_id: `${forecast.evidence_snapshot.run_id}:${symbol}`, forecast_run_id: forecast.evidence_snapshot.run_id, symbol, forecast_slot: forecastSlot,
    original_probability_pct: forecast.scenarios.main.probability_pct, old_state: previous?.new_state ?? null, new_state: newState, changed_at: observedAt, data_timestamp: dataTimestamp, source_mode: "LIVE", replay: false,
    structure: { direction, pattern: forecast.current_pattern.regime, summary: forecast.current_pattern.summary }, key_zone: keyZone(forecast, symbol, direction, activation),
    activation: { ...activation, display: groupText(activation) }, invalidation: { ...invalidation, display: groupText(invalidation) }, current_price: currentPrice, target_range: targetRange, remaining_space: remainingSpace === null ? null : Math.round(remainingSpace * 10_000) / 10_000,
    state_reason: stateReason, invalidation_reason: invalidationReason, owner_action: ownerAction, is_tradeable: isTradeable, risk_blockers: [...new Set([...(isTradeable ? [] : risk.blockers), ...(newState === "PATH_ACTIVATED" && !risk.isTradeable ? ["路径已确认，但当前交易条件不足"] : [])])], option_evidence: risk.evidence,
    proxy_evidence: [], market_snapshot: { observed_at: observedAt, bars }, previous_slot_change: forecast.forecast_update.change_summary,
  };
}
