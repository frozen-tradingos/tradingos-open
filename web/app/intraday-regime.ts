import { formatPtTime, MARKET_5M_MAX_AGE_SECONDS, ptDateKey } from "./market-time.ts";
import type { TriggerChart } from "./ts-owner-trigger.ts";

export type IntradayRegimeState = "DATA_BLOCKED" | "OPENING_UNCERTAINTY" | "RANGE" | "TREND_CANDIDATE" | "TREND_CONFIRMED" | "PULLBACK_VALIDATING" | "TREND_CONTINUATION" | "TREND_EXHAUSTED" | "RANGE_REENTRY";
export type IntradayDirection = "UP" | "DOWN" | "NONE";
export type IntradayPathStage = "NOT_FORMED" | "FORMING" | "CONFIRMED" | "INVALIDATED";
export type ParticipationStatus = "DATA_BLOCKED" | "NOT_ELIGIBLE" | "WAIT_FOR_CONFIRMATION" | "WINDOW_OPEN" | "WAIT_FOR_PULLBACK" | "CHASE_RISK_HIGH" | "WINDOW_CLOSED";

type Bar = { begins_at: string; open: number; high: number; low: number; close: number; volume: number | null; vwap: number };
type Pair = { begins_at: string; SPY: Bar; QQQ: Bar };

export type IntradayRegimeEvent = {
  contract_version: "v1";
  component: "OWNER_INTRADAY_REGIME_CONTEXT";
  event_id: string;
  previous_event_id: string | null;
  trading_date: string;
  source_mode: "LIVE" | "RESEARCH";
  replay: false;
  evidence_eligibility: "NATURAL_STRUCTURE_ONLY" | "EXCLUDED_RESEARCH";
  changed_at: string;
  data_timestamp: string | null;
  state: IntradayRegimeState;
  direction: IntradayDirection;
  path_stage: IntradayPathStage;
  participation_window: {
    status: ParticipationStatus;
    opened_at: string | null;
    closed_at: string | null;
    close_reason: "STRUCTURAL_EXTENSION" | "TREND_EXHAUSTED" | "RANGE_REENTRY" | "DATA_BLOCKED" | null;
  };
  requalification: { status: "NOT_APPLICABLE" | "REQUALIFIED"; from: IntradayRegimeState | null; at: string | null };
  measurement: {
    breakout_observed_at: string | null;
    earliest_confirmable_at: string | null;
    system_confirmed_at: string | null;
    confirmation_delay_minutes: number | null;
    qualification_started_at: string | null;
    pullback_started_at: string | null;
    extension_score: number | null;
  };
  evidence: {
    source: "ROBINHOOD_OFFICIAL_READONLY";
    analysis_basis: "SPY_QQQ_5M_PROXY";
    spx_spot_used: false;
    spx_kline_used: false;
    latest_bar_at: string | null;
    opening_range: Record<"SPY" | "QQQ", { high: number | null; low: number | null }>;
    vwap: Record<"SPY" | "QQQ", number | null>;
    confirmation_rule: string;
  };
  owner_summary: string;
  execution_scope: "OBSERVATION_ONLY_NO_ORDER";
};

export type IntradayRegimeOverview = { current: IntradayRegimeEvent | null; recent: IntradayRegimeEvent[] };

const symbols = ["SPY", "QQQ"] as const;
const confirmationRule = "连续6根窗口中至少5根由SPY与QQQ共同站在VWAP同侧，且出现真实15分钟开盘区间突破并形成至少0.08%共同位移";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number, digits = 4) => Number(value.toFixed(digits));

function regular(chart: TriggerChart, observedAt: string) {
  const observed = Date.parse(observedAt);
  const rows = chart.bars
    .filter((bar) => bar.session === "REGULAR" || bar.session === undefined && (() => { const [h, m] = formatPtTime(bar.begins_at).split(":").map(Number); return h * 60 + m >= 390 && h * 60 + m < 780; })())
    .filter((bar) => Date.parse(bar.begins_at) + 300_000 <= observed && [bar.open, bar.high, bar.low, bar.close].every(finite))
    .toSorted((left, right) => Date.parse(left.begins_at) - Date.parse(right.begins_at));
  let volume = 0, value = 0;
  return rows.map((bar): Bar => {
    const barVolume = finite(bar.volume) && bar.volume > 0 ? bar.volume : 0;
    volume += barVolume; value += (bar.high + bar.low + bar.close) / 3 * barVolume;
    return { begins_at: bar.begins_at, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: barVolume || null, vwap: volume ? value / volume : bar.close };
  });
}

function pairs(charts: TriggerChart[], observedAt: string) {
  const bySymbol = new Map(charts.map((chart) => [chart.symbol, regular(chart, observedAt)]));
  const spy = bySymbol.get("SPY") ?? [], qqq = new Map((bySymbol.get("QQQ") ?? []).map((bar) => [bar.begins_at, bar]));
  return spy.flatMap((bar) => qqq.has(bar.begins_at) ? [{ begins_at: bar.begins_at, SPY: bar, QQQ: qqq.get(bar.begins_at)! }] : []);
}

function openingRange(rows: Pair[]) {
  return Object.fromEntries(symbols.map((symbol) => [symbol, rows.length >= 3 ? { high: Math.max(...rows.slice(0, 3).map((row) => row[symbol].high)), low: Math.min(...rows.slice(0, 3).map((row) => row[symbol].low)) } : { high: null, low: null }])) as IntradayRegimeEvent["evidence"]["opening_range"];
}

function directionAt(rows: Pair[], index: number, opening: IntradayRegimeEvent["evidence"]["opening_range"]) {
  const window = rows.slice(Math.max(0, index - 5), index + 1), recent = rows.slice(Math.max(0, index - 3), index + 1);
  const onSide = (row: Pair, direction: Exclude<IntradayDirection, "NONE">) => symbols.every((symbol) => direction === "UP" ? row[symbol].close > row[symbol].vwap : row[symbol].close < row[symbol].vwap);
  const breakSeen = (values: Pair[], direction: Exclude<IntradayDirection, "NONE">) => values.some((row) => symbols.some((symbol) => direction === "UP" ? opening[symbol].high !== null && row[symbol].close > opening[symbol].high! : opening[symbol].low !== null && row[symbol].close < opening[symbol].low!));
  const displacement = (values: Pair[]) => {
    if (values.length < 2) return 0;
    return symbols.reduce((sum, symbol) => sum + (values.at(-1)![symbol].close / values[0][symbol].close - 1) * 100, 0) / symbols.length;
  };
  for (const direction of ["UP", "DOWN"] as const) {
    const aligned = window.filter((row) => onSide(row, direction)).length, move = displacement(window);
    if (window.length >= 6 && aligned >= 5 && breakSeen(window, direction) && (direction === "UP" ? move >= .08 : move <= -.08)) return { confirmed: direction, candidate: direction, breakout: window.find((row) => breakSeen([row], direction))?.begins_at ?? null };
  }
  for (const direction of ["UP", "DOWN"] as const) {
    const aligned = recent.filter((row) => onSide(row, direction)).length, move = displacement(recent);
    if (recent.length >= 4 && aligned >= 3 && breakSeen(recent, direction) && (direction === "UP" ? move >= .02 : move <= -.02)) return { confirmed: null, candidate: direction, breakout: recent.find((row) => breakSeen([row], direction))?.begins_at ?? null };
  }
  return { confirmed: null, candidate: null, breakout: null };
}

function earliestConfirmation(rows: Pair[], opening: IntradayRegimeEvent["evidence"]["opening_range"], direction: Exclude<IntradayDirection, "NONE">, notBefore: string | null) {
  for (let index = 5; index < rows.length; index += 1) {
    const closedAt = new Date(Date.parse(rows[index].begins_at) + 300_000).toISOString();
    if ((!notBefore || Date.parse(closedAt) >= Date.parse(notBefore)) && directionAt(rows, index, opening).confirmed === direction) return closedAt;
  }
  return null;
}

function extensionScore(rows: Pair[]) {
  const last = rows.at(-1); if (!last) return null;
  return round(symbols.reduce((sum, symbol) => {
    const recent = rows.slice(-12).map((row) => row[symbol]), average = recent.reduce((total, bar) => total + bar.high - bar.low, 0) / Math.max(1, recent.length);
    return sum + (average ? Math.abs(last[symbol].close - last[symbol].vwap) / average : 0);
  }, 0) / symbols.length, 2);
}

function blocked(observedAt: string, previous: IntradayRegimeEvent | null, reason: string, sourceMode: IntradayRegimeEvent["source_mode"]): Omit<IntradayRegimeEvent, "event_id"> {
  const date = ptDateKey(observedAt);
  return {
    contract_version: "v1", component: "OWNER_INTRADAY_REGIME_CONTEXT", previous_event_id: previous?.event_id ?? null, trading_date: date, source_mode: sourceMode, replay: false, evidence_eligibility: sourceMode === "LIVE" ? "NATURAL_STRUCTURE_ONLY" : "EXCLUDED_RESEARCH", changed_at: observedAt, data_timestamp: null,
    state: "DATA_BLOCKED", direction: "NONE", path_stage: "NOT_FORMED", participation_window: { status: "DATA_BLOCKED", opened_at: null, closed_at: observedAt, close_reason: "DATA_BLOCKED" },
    requalification: { status: "NOT_APPLICABLE", from: null, at: null }, measurement: { breakout_observed_at: null, earliest_confirmable_at: null, system_confirmed_at: null, confirmation_delay_minutes: null, qualification_started_at: null, pullback_started_at: null, extension_score: null },
    evidence: { source: "ROBINHOOD_OFFICIAL_READONLY", analysis_basis: "SPY_QQQ_5M_PROXY", spx_spot_used: false, spx_kline_used: false, latest_bar_at: null, opening_range: { SPY: { high: null, low: null }, QQQ: { high: null, low: null } }, vwap: { SPY: null, QQQ: null }, confirmation_rule: confirmationRule },
    owner_summary: reason, execution_scope: "OBSERVATION_ONLY_NO_ORDER",
  };
}

export function evaluateIntradayRegime(input: { charts: TriggerChart[]; observedAt: string; previous: IntradayRegimeEvent | null; sourceMode?: IntradayRegimeEvent["source_mode"] }): Omit<IntradayRegimeEvent, "event_id"> {
  const observedAt = new Date(input.observedAt).toISOString(), usable = input.charts.filter((chart) => chart.source === "ROBINHOOD" && chart.interval === "5m" && (chart.symbol === "SPY" || chart.symbol === "QQQ"));
  const sourceMode = input.sourceMode ?? "LIVE";
  if (usable.length < 2 || usable.some((chart) => chart.status === "DATA_BLOCKED" || chart.status === "STALE")) return blocked(observedAt, input.previous, "SPY/QQQ真实5分钟数据缺失或过期；等待自动恢复", sourceMode);
  const rows = pairs(usable, observedAt), last = rows.at(-1), tradingDate = last ? ptDateKey(last.begins_at) : ptDateKey(observedAt), dataTimestamp = last ? new Date(Date.parse(last.begins_at) + 300_000).toISOString() : null;
  if (!last || rows.length < 3 || tradingDate !== ptDateKey(observedAt) || dataTimestamp === null || Date.parse(observedAt) - Date.parse(dataTimestamp) > MARKET_5M_MAX_AGE_SECONDS * 1_000) return blocked(observedAt, input.previous, "当天SPY/QQQ完整5分钟证据尚未形成；历史K线不会被补记为自然趋势", sourceMode);
  const previous = input.previous?.trading_date === tradingDate ? input.previous : null, opening = openingRange(rows), signal = directionAt(rows, rows.length - 1, opening), activeDirection = previous?.path_stage === "CONFIRMED" ? previous.direction : "NONE";
  const extension = extensionScore(rows), opposite = activeDirection !== "NONE" && signal.candidate !== null && signal.candidate !== activeDirection;
  const lastTwoAgainst = activeDirection !== "NONE" && rows.slice(-2).length === 2 && rows.slice(-2).every((row) => symbols.every((symbol) => activeDirection === "UP" ? row[symbol].close < row[symbol].vwap : row[symbol].close > row[symbol].vwap));
  const pullbackStartedAt = activeDirection !== "NONE" && !signal.confirmed ? previous?.state === "PULLBACK_VALIDATING" ? previous.measurement.pullback_started_at ?? previous.data_timestamp : dataTimestamp : null;
  const pullbackExpired = pullbackStartedAt !== null && Date.parse(dataTimestamp) - Date.parse(pullbackStartedAt) >= 900_000;
  let state: IntradayRegimeState, direction: IntradayDirection, pathStage: IntradayPathStage;
  if (rows.length < 4) { state = "OPENING_UNCERTAINTY"; direction = "NONE"; pathStage = "NOT_FORMED"; }
  else if (signal.confirmed) { state = activeDirection === signal.confirmed ? "TREND_CONTINUATION" : "TREND_CONFIRMED"; direction = signal.confirmed; pathStage = "CONFIRMED"; }
  else if (activeDirection !== "NONE" && (opposite || lastTwoAgainst || pullbackExpired)) { state = "TREND_EXHAUSTED"; direction = activeDirection; pathStage = "INVALIDATED"; }
  else if (activeDirection !== "NONE") { state = "PULLBACK_VALIDATING"; direction = activeDirection; pathStage = "CONFIRMED"; }
  else if (signal.candidate) { state = "TREND_CANDIDATE"; direction = signal.candidate; pathStage = "FORMING"; }
  else { state = previous?.path_stage === "INVALIDATED" ? "RANGE_REENTRY" : "RANGE"; direction = "NONE"; pathStage = previous?.path_stage === "INVALIDATED" ? "INVALIDATED" : "NOT_FORMED"; }

  const samePath = previous !== null && previous.direction === direction && (previous.path_stage === "FORMING" || previous.path_stage === "CONFIRMED");
  const qualificationStartedAt = pathStage === "FORMING" || pathStage === "CONFIRMED" ? samePath ? previous.measurement.qualification_started_at ?? previous.data_timestamp ?? dataTimestamp : dataTimestamp : null;
  const earliest = direction === "NONE" ? null : earliestConfirmation(rows, opening, direction, qualificationStartedAt), firstConfirmation = pathStage === "CONFIRMED" && activeDirection !== direction;
  const confirmedAt = pathStage === "CONFIRMED" ? firstConfirmation ? dataTimestamp : previous?.measurement.system_confirmed_at ?? dataTimestamp : pathStage === "INVALIDATED" && samePath ? previous.measurement.system_confirmed_at : null;
  let participation: ParticipationStatus = pathStage === "FORMING" ? "WAIT_FOR_CONFIRMATION" : pathStage === "NOT_FORMED" ? "NOT_ELIGIBLE" : pathStage === "INVALIDATED" ? "WINDOW_CLOSED" : "WINDOW_OPEN";
  const openedAt = pathStage === "CONFIRMED" ? firstConfirmation ? dataTimestamp : previous?.participation_window.opened_at ?? dataTimestamp : pathStage === "INVALIDATED" && samePath ? previous.participation_window.opened_at : null;
  let closedAt: string | null = pathStage === "INVALIDATED" ? dataTimestamp : null, closeReason: IntradayRegimeEvent["participation_window"]["close_reason"] = pathStage === "INVALIDATED" ? state === "RANGE_REENTRY" ? "RANGE_REENTRY" : "TREND_EXHAUSTED" : null;
  if (pathStage === "CONFIRMED" && !firstConfirmation && previous?.participation_window.status === "CHASE_RISK_HIGH") { participation = "CHASE_RISK_HIGH"; closedAt = previous.participation_window.closed_at; closeReason = previous.participation_window.close_reason; }
  else if (pathStage === "CONFIRMED" && !firstConfirmation && extension !== null && extension >= 3) { participation = "CHASE_RISK_HIGH"; closedAt = dataTimestamp; closeReason = "STRUCTURAL_EXTENSION"; }
  else if (pathStage === "CONFIRMED" && extension !== null && extension >= 2) participation = "WAIT_FOR_PULLBACK";
  else if (state === "PULLBACK_VALIDATING") participation = "WAIT_FOR_PULLBACK";
  const requalified = previous !== null && ["DATA_BLOCKED", "RANGE", "RANGE_REENTRY", "TREND_EXHAUSTED"].includes(previous.state) && (pathStage === "FORMING" || pathStage === "CONFIRMED");
  const latest = rows.at(-1)!;
  const summary = state === "TREND_CONFIRMED" ? `${direction === "UP" ? "上涨" : "下跌"}趋势已由连续5分钟证据确认；${participation === "WAIT_FOR_PULLBACK" ? "等待回踩，不追单" : "结构观察窗口已打开"}`
    : state === "TREND_CONTINUATION" ? participation === "CHASE_RISK_HIGH" ? "趋势仍在延续，但结构已经过度伸展，不能追单" : "趋势延续；继续按回踩和现有风控观察"
      : state === "PULLBACK_VALIDATING" ? "已确认趋势正在回踩验证；等待重新保持，不提前赌博"
        : state === "TREND_CANDIDATE" ? "路径正在形成，等待连续停留和完整确认"
          : state === "TREND_EXHAUSTED" ? "原趋势证据已衰竭或反向，参与窗口关闭"
            : state === "RANGE_REENTRY" ? "原趋势已经失效，市场重新进入震荡"
              : state === "OPENING_UNCERTAINTY" ? "开盘证据仍在积累，暂不判定趋势" : "当前为震荡或证据不足，等待新的自然突破";
  return {
    contract_version: "v1", component: "OWNER_INTRADAY_REGIME_CONTEXT", previous_event_id: previous?.event_id ?? null, trading_date: tradingDate, source_mode: sourceMode, replay: false, evidence_eligibility: sourceMode === "LIVE" ? "NATURAL_STRUCTURE_ONLY" : "EXCLUDED_RESEARCH", changed_at: observedAt, data_timestamp: dataTimestamp,
    state, direction, path_stage: pathStage, participation_window: { status: participation, opened_at: openedAt, closed_at: closedAt, close_reason: closeReason },
    requalification: { status: requalified ? "REQUALIFIED" : "NOT_APPLICABLE", from: requalified ? previous!.state : null, at: requalified ? dataTimestamp : null },
    measurement: { breakout_observed_at: signal.breakout ? new Date(Date.parse(signal.breakout) + 300_000).toISOString() : samePath ? previous.measurement.breakout_observed_at : null, earliest_confirmable_at: earliest, system_confirmed_at: confirmedAt, confirmation_delay_minutes: earliest && confirmedAt ? Math.max(0, Math.round((Date.parse(confirmedAt) - Date.parse(earliest)) / 60_000)) : null, qualification_started_at: qualificationStartedAt, pullback_started_at: state === "PULLBACK_VALIDATING" ? pullbackStartedAt : null, extension_score: extension },
    evidence: { source: "ROBINHOOD_OFFICIAL_READONLY", analysis_basis: "SPY_QQQ_5M_PROXY", spx_spot_used: false, spx_kline_used: false, latest_bar_at: dataTimestamp, opening_range: opening, vwap: { SPY: round(latest.SPY.vwap), QQQ: round(latest.QQQ.vwap) }, confirmation_rule: confirmationRule },
    owner_summary: summary, execution_scope: "OBSERVATION_ONLY_NO_ORDER",
  };
}
