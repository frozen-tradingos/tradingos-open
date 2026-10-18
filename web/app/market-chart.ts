import type { TsOutput } from "./snapshot-import";
import { contractConditions, sequenceConditions } from "./ts-forecast-state.ts";

export type ChartBar = { begins_at: string; open: number; high: number; low: number; close: number; volume: number | null; session?: "PREMARKET" | "REGULAR" | "AFTER_HOURS" | "OVERNIGHT"; trading_date?: string; data_grade?: "OFFICIAL_OHLCV" };
export type ChartPoint = { time: number; value: number };
export type TsChartLevel = { kind: "support" | "resistance" | "invalidation" | "target"; label: string; value: number };
export type TsChartPath = { name: "main" | "reverse" | "extreme"; points: ChartPoint[]; upper: ChartPoint[]; lower: ChartPoint[]; nodes: Array<{ time: number; label: string }> };
export type ForecastFanGeometry = {
  anchor: ChartPoint | null;
  trunk: ChartPoint[];
  sharedUpper: ChartPoint[];
  sharedLower: ChartPoint[];
  displayPaths: Record<TsChartPath["name"], ChartPoint[]>;
  priceExtent: { low: number; high: number } | null;
};

const marketDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function conditionFor(value: unknown, symbol: "SPY" | "QQQ") {
  return contractConditions(value).find((item) => item.symbol === symbol) ?? null;
}

function conditionCenter(value: unknown, symbol: "SPY" | "QQQ") {
  const conditions = contractConditions(value).filter((item) => item.symbol === symbol);
  const condition = conditions.find((item) => item.metric === "LAST_PRICE") ?? conditions[0];
  if (!condition) return null;
  return condition.upper_value === null ? condition.value : (condition.value + condition.upper_value) / 2;
}

function conditionRange(value: unknown, symbol: "SPY" | "QQQ") {
  const condition = contractConditions(value).find((item) => item.symbol === symbol && item.upper_value !== null);
  return condition ? { low: Math.min(condition.value, condition.upper_value!), high: Math.max(condition.value, condition.upper_value!) } : null;
}

export function sessionVwapSeries(bars: ChartBar[]) {
  const latest = bars.at(-1);
  if (!latest) return [];
  const sessionDate = latest.trading_date ?? marketDate.format(new Date(latest.begins_at));
  let weighted = 0, volume = 0;
  const points: ChartPoint[] = [];
  for (const bar of bars) {
    if ((bar.trading_date ?? marketDate.format(new Date(bar.begins_at))) !== sessionDate || bar.session && bar.session !== "REGULAR" || bar.volume === null || bar.volume <= 0) continue;
    weighted += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
    volume += bar.volume;
    points.push({ time: Date.parse(bar.begins_at) / 1_000, value: weighted / volume });
  }
  return points;
}

export function tsChartOverlay(ts: TsOutput | null, symbol: "SPY" | "QQQ", anchor?: ChartPoint) {
  if (!ts) return { levels: [] as TsChartLevel[], paths: [] as TsChartPath[], forecastAt: null as number | null };
  const keyLevels = ts.key_levels.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const level = item as { symbol?: unknown; label?: unknown; value?: unknown };
    return level.symbol === symbol && typeof level.label === "string" && typeof level.value === "number" && Number.isFinite(level.value) ? [{ label: level.label, value: level.value }] : [];
  });
  const explicitSupport = keyLevels.filter((item) => /support|支撑|下沿|低点/i.test(item.label)).sort((a, b) => b.value - a.value)[0];
  const explicitResistance = keyLevels.filter((item) => /resistance|阻力|上沿|高点/i.test(item.label)).sort((a, b) => a.value - b.value)[0];
  const invalidationCondition = conditionFor(ts.scenarios.main.invalidation, symbol);
  const targetCondition = sequenceConditions(ts, "main", symbol).at(-1) ?? null;
  const levels: TsChartLevel[] = [
    ...(explicitSupport ? [{ kind: "support" as const, label: explicitSupport.label, value: explicitSupport.value }] : []),
    ...(explicitResistance ? [{ kind: "resistance" as const, label: explicitResistance.label, value: explicitResistance.value }] : []),
    ...(invalidationCondition ? [{ kind: "invalidation" as const, label: "主路径失效位", value: invalidationCondition.value as number }] : []),
    ...(targetCondition ? [{ kind: "target" as const, label: "主路径条件目标", value: targetCondition.value }] : []),
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.kind === item.kind && candidate.value === item.value) === index);

  const forecastAt = Date.parse(ts.forecast_window.start_at || ts.evidence_snapshot.market_time.observed_at) / 1_000;
  const paths = (["main", "reverse", "extreme"] as const).flatMap((name) => {
    const scenario = ts.scenarios[name];
    const activationCenter = conditionCenter(scenario.activation, symbol);
    const allConditions = [scenario.activation, ...scenario.sequence].flatMap((value) => contractConditions(value)).filter((condition) => condition.symbol === symbol);
    const start = anchor && Number.isFinite(anchor.time) && Number.isFinite(anchor.value) ? anchor : activationCenter === null ? null : { time: forecastAt, value: activationCenter };
    if (!start || !allConditions.length) return [];
    const horizonEnd = ts.forecast_window.end_at ? Date.parse(ts.forecast_window.end_at) / 1_000 : NaN;
    if (!Number.isFinite(horizonEnd) || horizonEnd <= forecastAt) return [];
    const stages = scenario.sequence.length ? scenario.sequence : [scenario.activation];
    const nodes = stages.map((source, index) => ({
      time: Math.round(forecastAt + (horizonEnd - forecastAt) * (index + 1) / stages.length),
      label: scenario.sequence.length ? `条件节点${index + 1}` : "观察期限",
      source,
    }));
    if (!nodes.length) return [];
    const points: ChartPoint[] = [start], upper: ChartPoint[] = [], lower: ChartPoint[] = [];
    let lastCenter = activationCenter ?? start.value;
    for (const node of nodes) {
      lastCenter = conditionCenter(node.source, symbol) ?? lastCenter;
      points.push({ time: node.time, value: lastCenter });
      const range = conditionRange(node.source, symbol);
      if (range) {
        upper.push({ time: node.time, value: range.high });
        lower.push({ time: node.time, value: range.low });
      }
    }
    return [{ name, points, upper, lower, nodes: nodes.map(({ time, label }) => ({ time, label })) }];
  });
  return { levels, paths, forecastAt: Number.isFinite(forecastAt) ? forecastAt : null };
}

function interpolate(points: ChartPoint[], time: number) {
  const exact = points.find((point) => point.time === time);
  if (exact) return exact.value;
  const right = points.findIndex((point) => point.time > time);
  if (right <= 0) return null;
  const from = points[right - 1], to = points[right];
  const ratio = (time - from.time) / (to.time - from.time);
  return from.value + (to.value - from.value) * ratio;
}

export function forecastFanGeometry(paths: TsChartPath[]): ForecastFanGeometry {
  const valid = paths.filter((path) => path.points.length > 1);
  const emptyPaths = { main: [], reverse: [], extreme: [] } as ForecastFanGeometry["displayPaths"];
  const anchor = valid[0]?.points[0] ?? null;
  if (!anchor) return { anchor: null, trunk: [], sharedUpper: [], sharedLower: [], displayPaths: emptyPaths, priceExtent: null };
  const firstNodeTime = Math.min(...valid.map((path) => path.points[1].time));
  const splitTime = Math.round(anchor.time + (firstNodeTime - anchor.time) * .18);
  const splitValues = valid.map((path) => interpolate(path.points, splitTime)).filter((value): value is number => value !== null);
  const splitValue = splitValues.reduce((sum, value) => sum + value, 0) / splitValues.length;
  const split = { time: splitTime, value: splitValue };
  const displayPaths = Object.fromEntries((["main", "reverse", "extreme"] as const).map((name) => {
    const path = valid.find((candidate) => candidate.name === name);
    return [name, path ? [split, ...path.points.slice(1)] : []];
  })) as ForecastFanGeometry["displayPaths"];
  const times = [...new Set([anchor.time, splitTime, ...valid.flatMap((path) => path.points.slice(1).map((point) => point.time))])].sort((a, b) => a - b);
  const envelope = times.flatMap((time) => {
    if (time === anchor.time) return [{ time, low: anchor.value, high: anchor.value }];
    const values = valid.flatMap((path) => [interpolate(path.points, time), interpolate(path.lower, time), interpolate(path.upper, time)]).filter((value): value is number => value !== null);
    return values.length ? [{ time, low: Math.min(...values), high: Math.max(...values) }] : [];
  });
  const prices = valid.flatMap((path) => [...path.points, ...path.lower, ...path.upper].map((point) => point.value));
  return {
    anchor,
    trunk: [anchor, split],
    sharedUpper: envelope.map(({ time, high }) => ({ time, value: high })),
    sharedLower: envelope.map(({ time, low }) => ({ time, value: low })),
    displayPaths,
    priceExtent: prices.length ? { low: Math.min(...prices), high: Math.max(...prices) } : null,
  };
}
