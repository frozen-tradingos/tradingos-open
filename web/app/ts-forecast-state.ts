import type { TsOutput } from "./snapshot-import.ts";
import { formatPtDateTime, isNyseRegularSession, nextNyseRegularDate, nextNyseRegularDateAfter, spxOptionSessionAt } from "./market-time.ts";

export type ForecastSymbol = "SPY" | "QQQ";
export type ScenarioName = "main" | "reverse" | "extreme";
export type ContractCondition = { symbol: ForecastSymbol; metric: string; operator: string; value: number; upper_value: number | null; confirmation: string };
export type EvidenceRole = "REQUIRED" | "CONDITIONAL" | "ENHANCEMENT";
export type EvidenceState = "LIVE" | "STALE" | "MISSING" | "NOT_STARTED" | "DATA_BLOCKED";
export type EvidenceContractItem = { key: string; label: string; scope: "FORECAST_ISSUE" | "NEXT_RTH"; role: EvidenceRole; state: EvidenceState; observed_at: string | null };

const scenarioNames = ["main", "reverse", "extreme"] as const;
const nextSessionTypes = new Set(["NEXT_SESSION", "WEEKEND_OUTLOOK"]);
const directionText = { BULLISH: "偏涨", BEARISH: "偏跌", RANGE: "震荡" } as const;
const tradeabilityText = { WAIT: "暂不适合进入交易复核", CONDITIONAL: "条件满足后再复核", READY_FOR_D_REVIEW: "可交 D 复核，非交易批准" } as const;
const evidenceLabels: Record<string, string> = {
  SPY_QUOTE: "SPY报价", QQQ_QUOTE: "QQQ报价", MARKET_CLOCK: "市场时钟", A2_STRUCTURE: "A2结构",
  MARKET_MOVING_NEWS: "市场影响新闻", MACRO_SCHEDULE: "宏观日程", OIL_CONTEXT: "油价上下文", RATES_CONTEXT: "利率上下文",
  SECTOR_BREADTH: "板块广度", OPTIONS_POSITIONING: "期权定位", A2_HISTORICAL_SIMILARITY: "历史相似案例", OVERNIGHT_FUTURES: "隔夜期货",
  NEXT_RTH_STRUCTURE: "目标交易日RTH结构",
};

export function contractConditions(value: unknown): ContractCondition[] {
  if (!value || typeof value !== "object" || !("conditions" in value) || !Array.isArray(value.conditions)) return [];
  return value.conditions.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const condition = item as Record<string, unknown>;
    return (condition.symbol === "SPY" || condition.symbol === "QQQ") && typeof condition.metric === "string" && typeof condition.operator === "string" && typeof condition.value === "number" && Number.isFinite(condition.value) && (condition.upper_value === null || typeof condition.upper_value === "number") && typeof condition.confirmation === "string"
      ? [{ symbol: condition.symbol, metric: condition.metric, operator: condition.operator, value: condition.value, upper_value: condition.upper_value, confirmation: condition.confirmation }]
      : [];
  });
}

export function sequenceConditions(ts: TsOutput, scenario: ScenarioName, symbol: ForecastSymbol) {
  return ts.scenarios[scenario].sequence.flatMap((stage) => contractConditions(stage)).filter((condition) => condition.symbol === symbol);
}

export function conditionText(condition: ContractCondition) {
  const operators: Record<string, string> = { ABOVE: ">", BELOW: "<", AT_OR_ABOVE: "≥", AT_OR_BELOW: "≤", BETWEEN: "区间" };
  const confirmations: Record<string, string> = { LIVE_QUOTE: "实时报价", ONE_5M_CLOSE: "5分钟收盘", ONE_15M_CLOSE: "15分钟收盘", ONE_30M_CLOSE: "30分钟收盘" };
  const metrics: Record<string, string> = { LAST_PRICE: "当前价", VWAP: "VWAP", SESSION_HIGH: "当日高点", SESSION_LOW: "当日低点", OPENING_RANGE_HIGH: "开盘区间高点", OPENING_RANGE_LOW: "开盘区间低点" };
  const value = condition.operator === "BETWEEN" && condition.upper_value !== null ? `${condition.value.toFixed(2)}–${condition.upper_value.toFixed(2)}` : condition.value.toFixed(2);
  return `${metrics[condition.metric] ?? condition.metric} ${operators[condition.operator] ?? condition.operator} ${value}（${confirmations[condition.confirmation] ?? condition.confirmation}确认）`;
}

function latest(outputs: TsOutput[]) {
  return outputs.toSorted((a, b) => Date.parse(a.evidence_snapshot.market_time.observed_at) - Date.parse(b.evidence_snapshot.market_time.observed_at)).at(-1) ?? null;
}

export type ForecastContextMode = "CURRENT_LIVE" | "NEXT_SESSION" | "HISTORICAL" | "NONE" | "MISSING";

// Record selection preserves original identity; display validity is checked against the current clock separately.
export function buildTsForecastDisplay(ts: TsOutput | null, mode: ForecastContextMode, at: string | number | Date) {
  const now = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  const start = Date.parse(ts?.forecast_window?.start_at ?? ""), end = Date.parse(ts?.forecast_window?.end_at ?? ""), review = Date.parse(ts?.next_validation?.at ?? "");
  const symbolicEnd = ts?.forecast_window?.end_at === null && nextSessionTypes.has(ts.report_type) && ["NEXT_REGULAR_SESSION_CLOSE", "NEXT_FIVE_REGULAR_SESSIONS_CLOSE"].includes(ts.forecast_window.end_condition);
  const state = !ts ? "NONE" : mode === "HISTORICAL" ? "HISTORICAL"
    : !Number.isFinite(now) || now <= 0 || !Number.isFinite(start) || !symbolicEnd && (!Number.isFinite(end) || end <= start) || !Number.isFinite(review) ? "UNKNOWN"
      : now < start ? "NOT_STARTED" : now >= end ? "EXPIRED" : now >= review ? "REVIEW_DUE" : "ACTIVE";
  const status = {
    NONE: "尚无盘中分析", HISTORICAL: "指定历史预测，仅供复盘", UNKNOWN: "原预测时段或复查时间未明确，不能作当前判断",
    NOT_STARTED: "尚未到原预测时段", EXPIRED: "原预测已过期，仅供复盘", REVIEW_DUE: "已到复查时间，等待新分析", ACTIVE: "尚在原预测时段，不是交易批准",
  }[state];
  const endCondition = ts?.forecast_window?.end_condition === "NEXT_REGULAR_SESSION_CLOSE" ? "目标交易日收盘（原合同未给出精确时间）"
    : ts?.forecast_window?.end_condition === "NEXT_FIVE_REGULAR_SESSIONS_CLOSE" ? "第五个目标交易日收盘（原合同未给出精确时间）" : "结束时间未明确";
  return {
    state, status, isCurrent: state === "ACTIVE" && mode === "CURRENT_LIVE",
    windowText: `原预测时段：${Number.isFinite(start) ? formatPtDateTime(start) : "开始时间未明确"} 至 ${Number.isFinite(end) ? formatPtDateTime(end) : ts?.forecast_window?.end_at === null ? endCondition : "结束时间未明确"}`,
    reviewText: `原定复查：${Number.isFinite(review) ? formatPtDateTime(review) : "时间未明确"}${Number.isFinite(review) && now >= review ? "（已到复查时间）" : ""}`,
  };
}

export function forecastTradingDate(output: TsOutput) {
  const marketDate = output.evidence_snapshot.market_time.market_date;
  return nextSessionTypes.has(output.report_type) ? nextNyseRegularDateAfter(marketDate) : marketDate;
}

export function resolveTsForecastContext(outputs: TsOutput[], requestedForecastId: string | null, at: string | number | Date = Date.now()) {
  const clock = spxOptionSessionAt(at);
  const atMs = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  const observedOutputs = outputs.filter((output) => Date.parse(output.evidence_snapshot.market_time.observed_at) <= atMs);
  if (requestedForecastId) {
    const selected = outputs.find((output) => output.evidence_snapshot.run_id === requestedForecastId) ?? null;
    if (!selected) return { selected: null, mode: "MISSING" as const, clock, tradingDate: null, consistencyError: `预测记录 ${requestedForecastId} 不存在或已损坏；未改开其他预测。` };
    if (!observedOutputs.includes(selected)) return { selected: null, mode: "MISSING" as const, clock, tradingDate: null, consistencyError: `预测记录 ${requestedForecastId} 在所查看时间尚未形成或形成时间无效；未改开其他预测。` };
    const next = nextSessionTypes.has(selected.report_type);
    const live = !next && forecastTradingDate(selected) === clock.trading_date && (clock.session === "RTH" || clock.session === "CURB");
    return { selected, mode: next ? "NEXT_SESSION" as const : live ? "CURRENT_LIVE" as const : "HISTORICAL" as const, clock, tradingDate: forecastTradingDate(selected), consistencyError: null };
  }
  const intraday = latest(observedOutputs.filter((output) => !nextSessionTypes.has(output.report_type) && forecastTradingDate(output) === clock.trading_date));
  const nextTradingDate = clock.session === "CLOSED" ? isNyseRegularSession(clock.trading_date) ? nextNyseRegularDateAfter(clock.trading_date) : nextNyseRegularDate(clock.trading_date) : clock.trading_date;
  const next = latest(observedOutputs.filter((output) => nextSessionTypes.has(output.report_type) && forecastTradingDate(output) === nextTradingDate));
  const selected = clock.session === "RTH" || clock.session === "CURB" ? intraday ?? next : next;
  return { selected, mode: selected ? nextSessionTypes.has(selected.report_type) ? "NEXT_SESSION" as const : "CURRENT_LIVE" as const : "NONE" as const, clock, tradingDate: selected ? forecastTradingDate(selected) : clock.trading_date, consistencyError: null };
}

function evidenceList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function conditionalEnhancedSources(ts: TsOutput) {
  const chains = ts.causal_chains.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  const channels = new Set(chains.flatMap((item) => evidenceList(item.channels)));
  const categories = new Set(chains.flatMap((item) => typeof item.event_category === "string" ? [item.event_category] : []));
  return new Set([
    ...(channels.has("OIL") || categories.has("energy") ? ["OIL_CONTEXT"] : []),
    ...(channels.has("RATES") || [...categories].some((item) => ["central_bank", "inflation", "employment", "growth"].includes(item)) ? ["RATES_CONTEXT", "MACRO_SCHEDULE"] : []),
    ...(channels.has("SECTOR") ? ["SECTOR_BREADTH"] : []),
    ...(channels.has("VOLATILITY") ? ["OPTIONS_POSITIONING"] : []),
    ...(chains.length ? ["MARKET_MOVING_NEWS"] : []),
  ]);
}

export function buildTsEvidenceContract(ts: TsOutput | null, mode: ForecastContextMode, at: string | number | Date = Date.now(), intraday?: { trading_date: string; state: string; data_timestamp?: string | null } | null) {
  if (!ts) return { items: [] as EvidenceContractItem[], required_available: 0, required_total: 0, conditional_available: 0, conditional_total: 0, enhancement_available: 0, enhancement_total: 0, missing: [] as EvidenceContractItem[], next_rth: null as EvidenceContractItem | null };
  const assessment = ts.evidence_assessment, observedAt = ts.evidence_snapshot.market_time.observed_at;
  const core = evidenceList(assessment.core_sources), coreGaps = new Set(evidenceList(assessment.core_gaps)), enhancedAvailable = new Set(evidenceList(assessment.enhanced_available)), enhancedMissing = evidenceList(assessment.enhanced_missing), conditional = conditionalEnhancedSources(ts);
  const items: EvidenceContractItem[] = core.map((key) => ({ key, label: evidenceLabels[key] ?? key, scope: "FORECAST_ISSUE", role: "REQUIRED", state: coreGaps.has(key) ? "DATA_BLOCKED" : "LIVE", observed_at: observedAt }));
  for (const key of new Set([...enhancedAvailable, ...enhancedMissing])) items.push({ key, label: evidenceLabels[key] ?? key, scope: "FORECAST_ISSUE", role: conditional.has(key) ? "CONDITIONAL" : "ENHANCEMENT", state: enhancedAvailable.has(key) ? "LIVE" : "MISSING", observed_at: enhancedAvailable.has(key) ? observedAt : null });
  const nextTradingDate = forecastTradingDate(ts), atMs = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at), beforeValidation = mode === "NEXT_SESSION" && atMs < Date.parse(ts.next_validation.at);
  const nextRth: EvidenceContractItem = { key: "NEXT_RTH_STRUCTURE", label: evidenceLabels.NEXT_RTH_STRUCTURE, scope: "NEXT_RTH", role: "CONDITIONAL", state: beforeValidation ? "NOT_STARTED" : intraday?.trading_date === nextTradingDate ? intraday.state === "DATA_BLOCKED" ? "DATA_BLOCKED" : "LIVE" : "MISSING", observed_at: beforeValidation ? null : intraday?.data_timestamp ?? null };
  items.push(nextRth);
  const count = (role: EvidenceRole, states: EvidenceState[]) => items.filter((item) => item.role === role && states.includes(item.state)).length;
  return {
    items,
    required_available: count("REQUIRED", ["LIVE", "STALE"]), required_total: count("REQUIRED", ["LIVE", "STALE", "MISSING", "DATA_BLOCKED", "NOT_STARTED"]),
    conditional_available: count("CONDITIONAL", ["LIVE", "STALE"]), conditional_total: count("CONDITIONAL", ["LIVE", "STALE", "MISSING", "DATA_BLOCKED", "NOT_STARTED"]),
    enhancement_available: count("ENHANCEMENT", ["LIVE", "STALE"]), enhancement_total: count("ENHANCEMENT", ["LIVE", "STALE", "MISSING", "DATA_BLOCKED", "NOT_STARTED"]),
    missing: items.filter((item) => item.state === "MISSING" || item.state === "DATA_BLOCKED"), next_rth: nextRth,
  };
}

function level(ts: TsOutput | null, symbol: ForecastSymbol, pattern: RegExp, side: "support" | "resistance") {
  if (!ts) return null;
  const matches = ts.key_levels.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as { symbol?: unknown; label?: unknown; value?: unknown };
    return value.symbol === symbol && typeof value.label === "string" && pattern.test(value.label) && typeof value.value === "number" && Number.isFinite(value.value) ? [value.value] : [];
  });
  return matches.length ? (side === "support" ? Math.max(...matches) : Math.min(...matches)) : null;
}

function scenarioForBias(ts: TsOutput | null, bias: "BULLISH" | "BEARISH") {
  if (!ts) return null;
  const name = scenarioNames.find((candidate) => ts.scenarios[candidate].bias === bias);
  return name ? { name, ...ts.scenarios[name] } : null;
}

export function buildTsForecastState(outputs: TsOutput[], symbol: ForecastSymbol) {
  const marketDate = outputs.reduce((current, output) => output.evidence_snapshot.market_time.market_date > current ? output.evidence_snapshot.market_time.market_date : current, "");
  const session = outputs.filter((output) => output.evidence_snapshot.market_time.market_date === marketDate);
  const intraday = session.filter((output) => !nextSessionTypes.has(output.report_type)).toSorted((a, b) => Date.parse(a.evidence_snapshot.market_time.observed_at) - Date.parse(b.evidence_snapshot.market_time.observed_at));
  const today = intraday.at(-1) ?? null, previous = intraday.at(-2) ?? null;
  const tomorrow = latest(session.filter((output) => nextSessionTypes.has(output.report_type)));
  const mainTargets = today ? sequenceConditions(today, "main", symbol).map((condition) => condition.value) : [];
  const invalidation = today ? contractConditions(today.scenarios.main.invalidation).find((condition) => condition.symbol === symbol)?.value ?? null : null;
  const changes = today && previous ? scenarioNames.flatMap((name) => {
    const delta = today.scenarios[name].probability_pct - previous.scenarios[name].probability_pct;
    return delta ? [`${name} ${delta > 0 ? "+" : ""}${delta} 个百分点`] : [];
  }) : [];
  if (today && previous && today.symbol_outlooks[symbol].direction !== previous.symbol_outlooks[symbol].direction) changes.unshift(`${symbol} ${directionText[previous.symbol_outlooks[symbol].direction]} → ${directionText[today.symbol_outlooks[symbol].direction]}`);
  const tomorrowActivation = tomorrow ? contractConditions(tomorrow.scenarios.main.activation).filter((condition) => condition.symbol === symbol).map(conditionText) : [];
  return {
    symbol,
    marketDate: marketDate || null,
    today,
    previous,
    tomorrow,
    direction: today ? directionText[today.symbol_outlooks[symbol].direction] : "NOT_OBSERVED",
    tradeability: today ? tradeabilityText[today.tradeability.status] : "NOT_OBSERVED",
    main: today ? { name: "main" as const, ...today.scenarios.main } : null,
    bullish: scenarioForBias(today, "BULLISH"),
    bearish: scenarioForBias(today, "BEARISH"),
    support: level(today, symbol, /support|支撑/i, "support"),
    resistance: level(today, symbol, /resistance|阻力/i, "resistance"),
    invalidation,
    targetRange: mainTargets.length ? { low: Math.min(...mainTargets), high: Math.max(...mainTargets) } : null,
    changeSummary: today?.forecast_update.change_summary ?? "NOT_OBSERVED",
    changes,
    tomorrowDirection: tomorrow ? directionText[tomorrow.symbol_outlooks[symbol].direction] : "NOT_OBSERVED",
    tomorrowActivation,
  };
}
