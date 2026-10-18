import type { OptionAdviceSettlement, OptionIvArchiveObservation, OptionStrategyCandidate, OptionVolatilityGate } from "./snapshot-import.ts";
import { isNyseRegularSession, nyseClosePtMinutes, ptDateKey } from "./market-time.ts";
import { utcForPt } from "./timeline-schedule.ts";
import { closedAt, completeSession, regularSessionBar, type TsSettlementBar } from "./ts-settlement.ts";

export type OptionAdviceSettlementInput = {
  source_type: OptionAdviceSettlement["source_type"];
  source_id: string;
  holding_id: string | null;
  observed_at: string;
  received_at: string;
  action: string;
  symbol: "SPY" | "QQQ" | null;
  direction: "BULLISH" | "BEARISH" | null;
  target_1: number | null;
  target_2: number | null;
  price_invalidation: number | null;
  time_invalidation: string | null;
  passing_candidate_count?: number | null;
  blocked_candidate_count?: number | null;
  new_entry_block_count?: number | null;
  candidate?: OptionStrategyCandidate | null;
  single_leg_candidate?: OptionStrategyCandidate | null;
  debit_spread_candidate?: OptionStrategyCandidate | null;
  volatility_gate?: OptionVolatilityGate | null;
};

function hitAt(bars: TsSettlementBar[], level: number | null, side: "ABOVE" | "BELOW") {
  if (level === null) return null;
  return bars.find((bar) => side === "ABOVE" ? bar.high >= level : bar.low <= level)?.begins_at ?? null;
}

function timestamp(value: unknown) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : Number.NaN; }

function optionResult(candidate: OptionStrategyCandidate | null | undefined, archive: OptionIvArchiveObservation[], marketDate: string, start: number, end: number, settled: number) {
  if (!candidate || candidate.entry_debit === null || !candidate.legs.length) return null;
  const rows = archive.filter((item) => item.source === "ROBINHOOD" && item.source_mode === "LIVE" && item.symbol === candidate.symbol && item.expiration === candidate.expiration && item.market_date === marketDate && Number.isFinite(timestamp(item.observed_at)) && timestamp(item.received_at) >= timestamp(item.observed_at) && timestamp(item.received_at) <= settled)
    .map((row) => ({ row, contracts: candidate.legs.map((leg) => row.contracts.find((item) => item.contract_id === leg.contract_id)) }))
    .filter(({ row, contracts }) => contracts.every((item) => item && Number.isFinite(item.bid) && Number.isFinite(item.ask) && item.bid! >= 0 && item.ask! >= item.bid! && timestamp(item.as_of) >= start && timestamp(item.as_of) <= end && timestamp(item.as_of) <= timestamp(row.received_at)))
    .toSorted((a, b) => Math.min(...b.contracts.map((item) => timestamp(item!.as_of))) - Math.min(...a.contracts.map((item) => timestamp(item!.as_of))) || timestamp(b.row.received_at) - timestamp(a.row.received_at));
  for (const { contracts } of rows) {
    const exitValue = candidate.legs.reduce((sum, leg, index) => sum + (leg.side === "BUY" ? contracts[index]!.bid! : -contracts[index]!.ask!) * 100, 0);
    const entry = candidate.entry_debit * 100, pnl = exitValue - entry;
    const terminalIvs = contracts.map((item) => item!.iv).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const entryIvs = candidate.legs.map((leg) => leg.iv), terminalIv = terminalIvs.length === contracts.length ? terminalIvs.reduce((sum, value) => sum + value, 0) / terminalIvs.length : null;
    const entryIv = entryIvs.reduce((sum, value) => sum + value, 0) / entryIvs.length;
    const ivPoints = terminalIv === null ? null : (terminalIv - entryIv) * 100;
    const days = Math.max(0, (Math.max(...contracts.map((item) => timestamp(item!.as_of))) - start) / 86_400_000);
    return {
      exitValue: Number(exitValue.toFixed(2)), pnl: Number(pnl.toFixed(2)), returnPct: entry > 0 ? Number((pnl / entry * 100).toFixed(2)) : null,
      terminalIv: terminalIv === null ? null : Number(terminalIv.toFixed(4)), ivPoints: ivPoints === null ? null : Number(ivPoints.toFixed(2)),
      theta: Number((candidate.legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? 1 : -1) * leg.theta * 100, 0) * days).toFixed(2)),
      vega: ivPoints === null ? null : Number((candidate.legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? 1 : -1) * leg.vega * 100, 0) * ivPoints).toFixed(2)),
    };
  }
  return null;
}

export function settleOptionAdvice(input: OptionAdviceSettlementInput, history: Record<"SPY" | "QQQ", TsSettlementBar[]>, settledAt: string, optionArchive: OptionIvArchiveObservation[] = []): OptionAdviceSettlement | null {
  const observed = timestamp(input.observed_at), received = timestamp(input.received_at), settled = timestamp(settledAt);
  if (!Number.isFinite(observed) || !Number.isFinite(settled) || observed > settled || received > settled) return null;
  const marketDate = ptDateKey(input.observed_at);
  if (!isNyseRegularSession(marketDate)) return null;
  const closeMinutes = nyseClosePtMinutes(marketDate), sessionClose = utcForPt(marketDate, `${Math.floor(closeMinutes / 60)}:${closeMinutes % 60}`).getTime();
  if (settled < sessionClose) return null;
  const required = input.symbol ? [input.symbol] : ["SPY", "QQQ"] as const;
  if (required.some((symbol) => !completeSession(marketDate, history[symbol]))) return null;
  const gaps: string[] = [], start = Math.max(observed, received, utcForPt(marketDate, "06:30").getTime());
  if (!Number.isFinite(received)) gaps.push("ADVICE_RECEIPT_NOT_VERIFIED");
  let end = Math.min(sessionClose, settled), timeReached: boolean | null = null;
  if (input.time_invalidation !== null) {
    const value = input.time_invalidation, dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value), deadline = dateOnly ? Date.parse(value) : timestamp(value);
    if (!Number.isFinite(deadline) || dateOnly && new Date(deadline).toISOString().slice(0, 10) !== value) gaps.push("TIME_INVALIDATION_NOT_VERIFIED");
    else if (dateOnly) {
      timeReached = ptDateKey(settledAt) >= value;
      if (value < marketDate) gaps.push("TIME_INVALIDATION_DATE_PASSED");
    } else { end = Math.min(end, deadline); timeReached = settled >= deadline; }
  }
  if (start >= end) gaps.push("EMPTY_ADVICE_WINDOW");
  const usableWindow = gaps.length === 0;
  const windowBars = (symbol: "SPY" | "QQQ") => usableWindow ? history[symbol].filter((bar) => bar.session_date === marketDate && regularSessionBar(bar) && timestamp(bar.begins_at) >= start && Date.parse(closedAt(bar)) <= end).toSorted((a, b) => Date.parse(a.begins_at) - Date.parse(b.begins_at)) : [];
  const actual = required.flatMap((symbol) => {
    const observed = windowBars(symbol);
    if (!observed.length) { gaps.push(`${symbol}:NO_COMPLETE_BAR_IN_WINDOW`); return []; }
    return [{
      symbol,
      start_price: observed[0].open,
      end_price: observed.at(-1)!.close,
      low: Math.min(...observed.map((bar) => bar.low)),
      high: Math.max(...observed.map((bar) => bar.high)),
      return_pct: Number(((observed.at(-1)!.close / observed[0].open - 1) * 100).toFixed(6)),
    }];
  });
  const bars = input.symbol ? windowBars(input.symbol) : [];
  const targetSide = input.direction === "BEARISH" ? "BELOW" : "ABOVE";
  const invalidationSide = input.direction === "BEARISH" ? "ABOVE" : "BELOW";
  const target1At = input.direction ? hitAt(bars, input.target_1, targetSide) : null;
  const target2At = input.direction ? hitAt(bars, input.target_2, targetSide) : null;
  const invalidationAt = input.direction ? hitAt(bars, input.price_invalidation, invalidationSide) : null;
  const scoreable = ["EXECUTABLE", "HOLD", "REDUCE", "EXIT"].includes(input.action) && Boolean(input.symbol && input.direction && input.target_1 !== null && input.price_invalidation !== null && bars.length);
  const terminalTargetAt = input.target_2 === null ? target1At : target2At;
  const sameBarConflict = invalidationAt !== null && terminalTargetAt === invalidationAt;
  let outcome: OptionAdviceSettlement["outcome"] = input.action === "NO_TRADE" ? "NO_TRADE" : input.action === "OBSERVE" ? "OBSERVED" : ["WAIT", "NOT_SUPPORTED"].includes(input.action) ? "WAIT_DATA" : "NOT_SCORABLE";
  if (scoreable) {
    if (sameBarConflict) outcome = "AMBIGUOUS";
    else if (invalidationAt && (!terminalTargetAt || Date.parse(invalidationAt) < Date.parse(terminalTargetAt))) outcome = "INVALIDATED";
    else if (target2At) outcome = "TARGET_2";
    else if (target1At) outcome = "TARGET_1";
    else outcome = "HELD_RANGE";
  }
  const notes: string[] = [];
  if (!bars.length && input.symbol) notes.push("建议有效时窗内没有完整常规交易 K 线；不借用建议前走势，不作路径评分");
  if (!scoreable && !["NO_TRADE", "OBSERVE", "WAIT", "NOT_SUPPORTED"].includes(input.action)) notes.push("目标、价格失效位或建议后观察数据不完整，不能评分");
  if (input.action === "NO_TRADE") notes.push("NO TRADE 是合法结果，不进入交易建议准确率");
  if (sameBarConflict) notes.push("目标与失效位在同一根 5 分钟 K 线触及，无法判断先后顺序");
  if (scoreable) notes.push("路径按先发生的最终目标或价格失效判定；target_hit 仅记录物理触及，不等于失效前有效完成，也不表示真实成交");
  if (outcome === "INVALIDATED" && target1At && invalidationAt && Date.parse(target1At) < Date.parse(invalidationAt)) notes.push("第一目标已先触及，随后价格失效；之后触及第二目标不计为完成");
  const source_snapshot_hashes = [...new Set(required.flatMap((symbol) => windowBars(symbol).map((bar) => bar.snapshot_hash)))].sort();
  const avoidance = input.action === "NO_TRADE" || input.action === "WAIT"
    ? input.passing_candidate_count === 0 || (input.new_entry_block_count ?? 0) > 0
      ? { status: "AVOIDED_UNQUALIFIED_SETUP" as const, passing_candidate_count: input.passing_candidate_count ?? null, blocked_candidate_count: input.blocked_candidate_count ?? null, reason: "没有候选通过同槽盘型、行情、流动性与分层风控；等待/不交易成功避开未达标结构。" }
      : { status: "DISCIPLINE_PRESERVED" as const, passing_candidate_count: input.passing_candidate_count ?? null, blocked_candidate_count: input.blocked_candidate_count ?? null, reason: "存在结构候选但 D/A3 没有批准执行；保留纪律记录，不冒充方向准确率。" }
    : { status: "NOT_APPLICABLE" as const, passing_candidate_count: input.passing_candidate_count ?? null, blocked_candidate_count: input.blocked_candidate_count ?? null, reason: "本条不是 WAIT / NO TRADE。" };
  const candidateResult = usableWindow ? optionResult(input.candidate, optionArchive, marketDate, start, end, settled) : null;
  const singleResult = usableWindow ? optionResult(input.single_leg_candidate, optionArchive, marketDate, start, end, settled) : null;
  const spreadResult = usableWindow ? optionResult(input.debit_spread_candidate, optionArchive, marketDate, start, end, settled) : null;
  if ([input.candidate && !candidateResult, input.single_leg_candidate && !singleResult, input.debit_spread_candidate && !spreadResult].some(Boolean)) gaps.push("OPTION_QUOTE_WINDOW_NOT_VERIFIED");
  const actualUnderlying = actual.find((item) => item.symbol === (input.symbol ?? input.candidate?.symbol)) ?? null;
  const directionCorrect = !actualUnderlying || !input.direction ? null : input.direction === "BULLISH" ? actualUnderlying.return_pct > 0 : actualUnderlying.return_pct < 0;
  const gate = input.volatility_gate;
  const gateAssessment = !["WAIT", "NO_TRADE"].includes(input.action) ? "NOT_APPLICABLE" as const
    : !gate ? "NOT_OBSERVED" as const
      : actualUnderlying && gate.implied_move.implied_move_pct !== null && Math.abs(actualUnderlying.return_pct) < gate.implied_move.implied_move_pct && gate.status === "BLOCKED" ? "AVOIDED_LOW_VALUE_TRADE" as const : "DID_NOT_AVOID" as const;
  const pathFit = singleResult && spreadResult ? singleResult.pnl <= 0 && spreadResult.pnl <= 0 ? "NEITHER" as const : singleResult.pnl >= spreadResult.pnl ? "SINGLE_LEG" as const : "DEBIT_SPREAD" as const : "NOT_OBSERVED" as const;
  const volatilityResult: OptionAdviceSettlement["volatility_result"] = {
    direction_correct: directionCorrect, actual_option_exit_value_usd: candidateResult?.exitValue ?? null, actual_option_return_pct: candidateResult?.returnPct ?? null,
    terminal_iv: candidateResult?.terminalIv ?? null, iv_change_pct_points: candidateResult?.ivPoints ?? null, theta_estimate_usd: candidateResult?.theta ?? null, vega_iv_estimate_usd: candidateResult?.vega ?? null,
    direction_correct_but_option_lost: directionCorrect === null || !candidateResult ? null : directionCorrect && candidateResult.pnl < 0,
    option_price_assessment: gate?.price_state === "EXPENSIVE" ? "TOO_EXPENSIVE" : gate && gate.price_state !== "NOT_OBSERVED" ? "REASONABLE" : "NOT_OBSERVED",
    gate_assessment: gateAssessment, path_fit: pathFit, single_leg_actual_pnl_usd: singleResult?.pnl ?? null, debit_spread_actual_pnl_usd: spreadResult?.pnl ?? null,
    notes: [
      ...(candidateResult ? ["期权报价估算使用有效时窗内、结算前已收到的 Robinhood 官方只读 Bid/Ask；Long 按 Bid、Short 按 Ask，不表示真实成交"] : ["没有通过有效时窗与真实接收时间核验的同合约 Bid/Ask，期权价格结果保持未观察到"]),
      "Theta/Vega 只作一阶归因估算，不冒充完整期权定价分解",
    ],
  };
  return {
    contract_version: "v1", path_scoring_version: "FIRST_TERMINAL_V2", component: "OPTION_ADVICE_SETTLEMENT", source_type: input.source_type, source_id: input.source_id, holding_id: input.holding_id,
    observation_window: { contract_version: "RECEIVED_RTH_WINDOW_V1", start_at: Number.isFinite(start) ? new Date(start).toISOString() : null, end_at: new Date(end).toISOString(), data_gaps: gaps },
    source_mode: "LIVE", observed_at: input.observed_at, settled_at: new Date(settledAt).toISOString(), market_date: marketDate, action: input.action,
    symbol: input.symbol, status: scoreable && outcome !== "AMBIGUOUS" ? "RESOLVED" : ["NO_TRADE", "OBSERVED", "WAIT_DATA"].includes(outcome) ? "RESOLVED" : "PARTIAL",
    outcome, scoreable, actual, target_1_hit: input.target_1 === null ? null : Boolean(target1At), target_2_hit: input.target_2 === null ? null : Boolean(target2At),
    price_invalidation_hit: input.price_invalidation === null ? null : Boolean(invalidationAt),
    time_invalidation_reached: timeReached,
    avoidance_assessment: avoidance,
    volatility_result: volatilityResult, source_snapshot_hashes, notes,
  };
}
