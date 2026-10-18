import { MARKET_5M_MAX_AGE_SECONDS } from "./market-time.ts";
import type { ApprovedCapabilitySnapshot, TsOutput } from "./snapshot-import.ts";
import { conditionText, contractConditions } from "./ts-forecast-state.ts";

type FixedRow = ApprovedCapabilitySnapshot["fixed_pool"]["rows"][number];

const observationTerms: Record<string, string> = {
  BULLISH: "偏涨", BEARISH: "偏跌", RANGE: "震荡", NOT_OBSERVED: "尚无判断", range: "震荡", unavailable: "数据不足",
  ascending_triangle: "低点逐步抬高、靠近前期高位", descending_triangle: "高点逐步降低、靠近前期低位", symmetrical_triangle: "高低点不断靠近，方向待确认",
  higher_high_higher_low: "高点和低点都在抬高", lower_high_lower_low: "高点和低点都在下移",
  volume_breakout: "成交量增加，价格突破原有区间", breakout: "价格突破原有区间，仍需确认", false_breakout: "突破后又回到原区间",
  trend_continuation: "原有趋势继续", breakout_pending_confirmation: "突破后能否站稳仍需确认", breakout_watch: "观察能否突破上方价格", breakdown_watch: "观察是否跌破下方价格", compression: "价格波动正在收窄", failed: "原判断已经失效", unclear: "方向尚不清楚",
};
function observationReason(value: string) { return value.replace(/[A-Za-z][A-Za-z_0-9]*/g, (term) => Object.hasOwn(observationTerms, term) ? observationTerms[term] : term); }

export function ownerObservationRows(snapshot?: ApprovedCapabilitySnapshot) {
  if (!snapshot) return [];
  const rows = new Map(snapshot.fixed_pool.rows.map((row) => [row.symbol, row]));
  const holdings = new Set(snapshot.real_positions?.status === "OBSERVED" ? snapshot.real_positions.symbols : []);
  return [...new Set(snapshot.fixed_pool.candidates)].flatMap((symbol) => {
    const row = rows.get(symbol), management = row?.swing?.management;
    return row && !holdings.has(symbol) && row.swing?.stage !== "INVALIDATED" && !["HOLDING", "INVALIDATED", "SETTLED"].includes(management?.state ?? "") && management?.archive_status !== "ARCHIVED" ? [row] : [];
  }).slice(0, 3);
}

export function ownerObservationDetail(row: FixedRow, at: string | number, currentReadFailed = false) {
  const management = row.swing?.management;
  const age = ((typeof at === "number" ? at : Date.parse(at)) - Date.parse(row.as_of ?? "")) / 1_000;
  const quoteFresh = !currentReadFailed && row.status === "LIVE" && age >= 0 && age <= MARKET_5M_MAX_AGE_SECONDS;
  const quoteWait = currentReadFailed ? "最近采集失败" : row.status === "MARKET_CLOSED" ? "收盘参考"
    : row.status === "DATA_BLOCKED" ? "报价证据不全" : row.status === "STALE" ? "报价已过期"
      : !Number.isFinite(age) ? "报价时间缺失或无效" : age < 0 ? "报价时间异常" : `报价超过${MARKET_5M_MAX_AGE_SECONDS / 60}分钟`;
  const trigger = management?.entry_trigger ?? null, invalidation = management?.price_invalidation ?? null, target = management?.target_1 ?? null;
  const missing = [...new Set([
    ...(!quoteFresh ? ["需要重新取得当前报价"] : []),
    ...(trigger === null ? ["触发价未形成"] : []), ...(invalidation === null ? ["价格失效位未形成"] : []), ...(target === null ? ["第一目标未形成"] : []),
    ...(row.no_chase ? ["原判断要求不追价"] : []), ...(management?.missing_confirmation ?? row.swing?.missing_confirmation ?? []),
  ])];
  return {
    quoteFresh, trigger, invalidation, target, missing,
    status: !quoteFresh ? quoteWait : trigger === null || invalidation === null || target === null ? "观察条件未齐，不是交易机会" : "条件观察，未获交易批准",
    reason: observationReason(row.swing?.why_watch?.join("；") || management?.state_reason || "原冻结快照没有完整观察理由"),
    summary: row.no_chase ? "原观察要求不追价" : observationReason(row.swing?.why_watch?.[0] || management?.state_reason || "原快照缺少观察理由"),
    direction: row.swing?.direction ?? row.direction,
    nextCheck: management?.next_check ?? row.swing?.next_check ?? null,
  };
}

export function ownerMarketDecision(ts: TsOutput | null) {
  if (!ts) return null;
  const invalidation = ts.scenarios.main.invalidation as { logic?: string } | null;
  const conditions = contractConditions(invalidation).map((condition) => `${condition.symbol} ${conditionText(condition)}`);
  return {
    summary: ts.one_line_forecast, pattern: ts.current_pattern.summary,
    symbols: (["SPY", "QQQ"] as const).map((symbol) => ({ symbol, ...ts.symbol_outlooks[symbol] })),
    falsifiers: conditions.length ? `${invalidation?.logic === "ALL" ? "以下条件同时出现" : invalidation?.logic === "ANY" ? "以下任一条件出现" : "原始条件"}：${conditions.join("；")}` : "原判断未给出可用的价格反证，不能自行补设",
    mistake: ts.most_likely_mistake, frozenAt: ts.evidence_snapshot.market_time.observed_at,
    forecastId: ts.evidence_snapshot.run_id, nextValidation: ts.next_validation.at,
  };
}
