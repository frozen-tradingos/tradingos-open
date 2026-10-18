import { createHash } from "node:crypto";
import { tsChartOverlay } from "../app/market-chart.ts";
import { exchangeDateKey, MARKET_5M_MAX_AGE_SECONDS } from "../app/market-time.ts";
import type { OptionIvArchiveObservation, OptionStrategyCandidate, OptionStrategySignal, ReadonlyMarketSources, TsOutput } from "../app/snapshot-import.ts";
import type { TsRegimeRiskContext } from "../app/ts-regime-risk.ts";
import { optionDte, optionHorizon, type OptionHoldingHorizon } from "./option-horizon.ts";
import { applyVolatilityGate, MIN_IV_HISTORY_SESSIONS } from "./option-volatility.ts";

const MAX_RELATIVE_SPREAD_PCT = 5;
const MAX_ABSOLUTE_SPREAD = 0.15;
const MAX_RISK_USD = 1_000;
const PATHS = ["main", "reverse", "extreme"] as const;

type OptionRow = ReadonlyMarketSources["options"][number];
type Contract = OptionRow["contracts"][number];
type CompleteContract = Omit<Contract, "bid" | "ask" | "iv" | "delta" | "gamma" | "theta" | "vega" | "open_interest" | "volume" | "as_of"> & {
  bid: number; ask: number; iv: number; delta: number; gamma: number; theta: number; vega: number; open_interest: number; volume: number; as_of: string;
};
type Inputs = {
  runId: string;
  slotId: string;
  sourceMode: "LIVE" | "REPLAY";
  market: ReadonlyMarketSources | null;
  ts: TsOutput | null;
  d: Record<string, unknown> | null;
  a3: Record<string, unknown> | null;
  riskContext?: TsRegimeRiskContext | null;
  tsHistory?: TsOutput[];
  ivHistory?: OptionIvArchiveObservation[];
  previous?: OptionStrategySignal | null;
  observedAt?: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function hash(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function rounded(value: number, digits = 4) { return Number(value.toFixed(digits)); }
function optionalRounded(value: number, digits = 4) { return Number.isFinite(value) ? rounded(value, digits) : null; }
function text(value: unknown) { return typeof value === "string" && value ? value : null; }

function complete(contract: Contract): contract is CompleteContract {
  return [contract.bid, contract.ask, contract.iv, contract.delta, contract.gamma, contract.theta, contract.vega, contract.open_interest, contract.volume].every(finite) && typeof contract.as_of === "string";
}

function spread(contract: Contract) {
  if (!finite(contract.bid) || !finite(contract.ask) || contract.bid <= 0 || contract.ask < contract.bid) return null;
  const absolute = contract.ask - contract.bid, mid = (contract.ask + contract.bid) / 2;
  return { absolute, relative: mid > 0 ? absolute / mid * 100 : Number.POSITIVE_INFINITY };
}

function leg(contract: CompleteContract, side: "BUY" | "SELL") {
  return {
    side, option_type: contract.option_type, contract_id: contract.contract_id, strike: contract.strike,
    bid: contract.bid, ask: contract.ask, iv: contract.iv, delta: contract.delta, gamma: contract.gamma,
    theta: contract.theta, vega: contract.vega, open_interest: contract.open_interest, volume: contract.volume, as_of: contract.as_of,
  } as const;
}

function pnl(legs: OptionStrategyCandidate["legs"], spot: number, target: number, days: number) {
  const move = target - spot;
  return rounded(legs.reduce((total, item) => total + (item.side === "BUY" ? 1 : -1) * (item.delta * move + 0.5 * item.gamma * move * move + item.theta * days) * 100, 0), 2);
}

function nextSessionTs(history: TsOutput[] | undefined, current: TsOutput) {
  return (history ?? []).filter((item) => ["NEXT_SESSION", "WEEKEND_OUTLOOK"].includes(item.report_type) && item.evidence_snapshot.market_time.market_date >= current.evidence_snapshot.market_time.market_date).toSorted((a, b) => Date.parse(b.evidence_snapshot.market_time.observed_at) - Date.parse(a.evidence_snapshot.market_time.observed_at))[0] ?? null;
}

function scenarioNodes(ts: TsOutput, symbol: "SPY" | "QQQ", spot: number, legs: OptionStrategyCandidate["legs"], sourceWindow: "CURRENT_SLOT" | "NEXT_SESSION") {
  const forecastAt = Date.parse(ts.forecast_window.start_at) / 1_000;
  if (!Number.isFinite(forecastAt)) return [];
  const marketDate = sourceWindow === "NEXT_SESSION" ? exchangeDateKey(ts.forecast_window.start_at) : ts.evidence_snapshot.market_time.market_date;
  const safeTs = { ...ts, key_levels: ts.key_levels ?? [], evidence_snapshot: { ...ts.evidence_snapshot, market_time: { ...ts.evidence_snapshot.market_time, market_date: marketDate } } };
  return tsChartOverlay(safeTs, symbol, { time: forecastAt, value: spot }).paths.flatMap((path) => path.nodes.flatMap((node, index) => {
    const target = path.points[index + 1]?.value;
    if (!finite(target)) return [];
    const elapsedDays = Math.max(0, (node.time - forecastAt) / 86_400);
    return [{ window: sourceWindow, path: path.name, node: node.label, target_price: rounded(target), elapsed_days: rounded(elapsedDays), estimated_pnl_usd: legs.length ? pnl(legs, spot, target, elapsedDays) : null, model: "DELTA_GAMMA_THETA_STATIC_IV" as const }];
  }));
}

function swingEvidence(market: ReadonlyMarketSources, symbol: "SPY" | "QQQ") {
  return market.approved_capabilities?.fixed_pool.rows.find((item) => item.symbol === symbol)?.swing ?? null;
}

function horizonGaps(horizon: OptionHoldingHorizon, symbol: "SPY" | "QQQ", optionType: "call" | "put", market: ReadonlyMarketSources, ts: TsOutput, nextTs: TsOutput | null, riskContext: TsRegimeRiskContext | null | undefined) {
  const gaps: string[] = [], expected = optionType === "call" ? "BULLISH" : "BEARISH";
  if (horizon === "UNCLASSIFIED") gaps.push("到期日位于尚未批准的 8–13 或 61–89 DTE 空档，保持等待");
  if (horizon === "INTRADAY_0_1") {
    if (!["OPEN_TO_60_MINUTES", "NEXT_30_TO_60_MINUTES"].includes(ts.forecast_window.horizon)) gaps.push("0–1 DTE 缺少匹配的日内 TS 观察窗口");
    const remainingMinutes = riskContext?.symbols?.[symbol]?.remaining_regular_minutes;
    if (remainingMinutes !== null && remainingMinutes !== undefined && remainingMinutes < 60) gaps.push("距收盘不足60分钟，剩余时间不足以承担单腿价差与 Theta");
  }
  if (horizon === "SHORT_2_7" && (!nextTs || nextTs.symbol_outlooks[symbol].direction !== expected)) gaps.push("2–7 DTE 缺少同方向的次日正式 TS 证据");
  if (horizon === "SWING_14_60" || horizon === "LONG_90_PLUS") {
    const swing = swingEvidence(market, symbol);
    if (!swing) gaps.push(`${horizon === "LONG_90_PLUS" ? "90+ DTE" : "14–60 DTE"} 缺少固定70多周期结构证据`);
    else {
      if (swing.stage !== "CONFIRMED") gaps.push(`多周期波段状态为 ${swing.stage}，尚未确认`);
      if (swing.direction !== expected) gaps.push(`多周期方向 ${swing.direction} 与单腿方向 ${expected} 不一致`);
    }
  }
  return gaps;
}

function candidate(symbol: "SPY" | "QQQ", type: OptionStrategyCandidate["strategy_type"], contracts: Contract[], spot: number, market: ReadonlyMarketSources, ts: TsOutput, nextTs: TsOutput | null, riskContext: TsRegimeRiskContext | null | undefined, longOverride?: Contract): OptionStrategyCandidate | null {
  const optionType = type.includes("CALL") ? "call" : "put";
  const sameSide = contracts.filter((item) => item.option_type === optionType).sort((a, b) => a.strike - b.strike);
  const long = longOverride ?? sameSide.reduce<Contract | null>((best, item) => !best || Math.abs(item.strike - spot) < Math.abs(best.strike - spot) ? item : best, null);
  if (!long) return null;
  const sameExpiry = sameSide.filter((item) => item.expiration === long.expiration);
  const isSpread = type.endsWith("SPREAD");
  const short = !isSpread ? null : type === "CALL_DEBIT_SPREAD" ? sameExpiry.find((item) => item.strike > long.strike) ?? null : [...sameExpiry].reverse().find((item) => item.strike < long.strike) ?? null;
  const selected = short ? [long, short] : [long];
  const gaps: string[] = [];
  if (isSpread && !short) gaps.push("冻结样本没有同到期日的相邻价差腿");
  if (selected.some((item) => !complete(item))) gaps.push("Bid/Ask、IV、Greeks、OI、成交量或报价时间不完整");
  const marketAsOf = market.as_of;
  if (marketAsOf === null || selected.some((item) => typeof item.as_of !== "string" || Math.abs(Date.parse(marketAsOf) - Date.parse(item.as_of)) > MARKET_5M_MAX_AGE_SECONDS * 1_000)) gaps.push("至少一条期权腿报价超过420秒或时间无效");
  const expiryDte = optionDte(long.expiration, market.market_session.market_date), holdingHorizon = optionHorizon(expiryDte);
  gaps.push(...horizonGaps(holdingHorizon, symbol, optionType, market, ts, nextTs, riskContext));
  const spreads = selected.map(spread);
  if (spreads.some((item) => !item || item.absolute > MAX_ABSOLUTE_SPREAD || item.relative > MAX_RELATIVE_SPREAD_PCT)) gaps.push("至少一条腿超过 V2 现有 Bid/Ask 价差硬阈值");
  if (selected.some((item) => !finite(item.open_interest) || item.open_interest <= 0)) gaps.push("至少一条腿没有正数 OI");
  const longAsk = finite(long.ask) ? long.ask : Number.NaN, shortBid = short && finite(short.bid) ? short.bid : 0;
  const debit = longAsk - shortBid;
  const width = short ? Math.abs(short.strike - long.strike) : null;
  if (!finite(debit) || debit <= 0 || width !== null && debit >= width) gaps.push("净权利金无效或不低于价差宽度");
  const maxRisk = finite(debit) ? debit * 100 : Number.NaN;
  if (!finite(maxRisk) || maxRisk <= 0 || maxRisk > MAX_RISK_USD) gaps.push("单组最大风险无效或超过 $1,000");
  const legs: OptionStrategyCandidate["legs"] = complete(long) && (!short || complete(short)) ? [leg(long, "BUY"), ...(short ? [leg(short, "SELL")] : [])] : [];
  const breakeven = optionType === "call" ? long.strike + debit : long.strike - debit;
  const maxProfit = width === null ? null : (width - debit) * 100;
  const nodePnl = [...scenarioNodes(ts, symbol, spot, legs, "CURRENT_SLOT"), ...(nextTs ? scenarioNodes(nextTs, symbol, spot, legs, "NEXT_SESSION") : [])];
  if (holdingHorizon === "SHORT_2_7" && !nodePnl.some((item) => item.window === "NEXT_SESSION")) gaps.push("2–7 DTE没有可计算的次日价格节点，不能估算次日盈亏");
  const scenarioPnl = PATHS.map((path) => {
    const finalNode = nodePnl.filter((item) => item.window === "CURRENT_SLOT" && item.path === path).at(-1), target = finalNode?.target_price ?? null, probability = ts.scenarios[path].probability_pct;
    let estimate = finalNode?.estimated_pnl_usd ?? null;
    if (estimate !== null && finite(maxRisk)) estimate = Math.max(-maxRisk, maxProfit === null ? estimate : Math.min(maxProfit, estimate));
    return { path, probability_pct: probability, target_price: target, estimated_pnl_usd: estimate, model: "DELTA_GAMMA_THETA_STATIC_IV" as const };
  });
  if (scenarioPnl.some((item) => item.target_price === null || item.estimated_pnl_usd === null)) gaps.push("至少一条 TS 路径缺少可计算的目标或 Greeks");
  const expected = scenarioPnl.every((item) => item.estimated_pnl_usd !== null) && scenarioPnl.reduce((sum, item) => sum + item.probability_pct, 0) === 100
    ? scenarioPnl.reduce((sum, item) => sum + item.estimated_pnl_usd! * item.probability_pct / 100, 0) : null;
  const spreadCost = spreads.every(Boolean) ? spreads.reduce((sum, item) => sum + item!.absolute * 100, 0) : null;
  const expectedAfterSpread = expected === null || spreadCost === null ? null : expected - spreadCost;
  const mainTarget = scenarioPnl.find((item) => item.path === "main")?.target_price ?? null;
  const mainMovePct = mainTarget === null ? null : Math.abs(mainTarget - spot) / spot * 100;
  const breakevenMovePct = Math.abs(breakeven - spot) / spot * 100;
  if (expectedAfterSpread !== null && expectedAfterSpread <= 0) gaps.push("TS 概率路径在静态 IV、Theta 与双向 Bid/Ask 成本后没有正预期空间");
  const maxAbsolute = spreads.every(Boolean) ? Math.max(...spreads.map((item) => item!.absolute)) : Number.NaN;
  const maxRelative = spreads.every(Boolean) ? Math.max(...spreads.map((item) => item!.relative)) : Number.NaN;
  const minimumOi = selected.every((item) => finite(item.open_interest)) ? Math.min(...selected.map((item) => item.open_interest!)) : 0;
  const minimumVolume = selected.every((item) => finite(item.volume)) ? Math.min(...selected.map((item) => item.volume!)) : 0;
  const identity = { symbol, type, expiration: long.expiration, strikes: selected.map((item) => item.strike), contracts: selected.map((item) => item.contract_id), snapshot: ts.evidence_snapshot.packet_hash };
  return {
    candidate_id: `option-candidate-${hash(identity).slice(0, 24)}`, symbol, strategy_type: type, expiration: long.expiration, dte: expiryDte,
    holding_horizon: holdingHorizon, rank_in_horizon: 0, selection_note: "等待同期限真实合约比较",
    legs, entry_debit: optionalRounded(debit), max_risk_usd: optionalRounded(maxRisk, 2), max_profit_usd: maxProfit === null || !finite(maxProfit) ? null : rounded(maxProfit, 2), breakeven: optionalRounded(breakeven),
    liquidity: { status: gaps.some((item) => /Bid\/Ask|OI/.test(item)) ? "BLOCKED" : "PASS", max_absolute_spread: optionalRounded(maxAbsolute), max_relative_spread_pct: optionalRounded(maxRelative), minimum_open_interest: selected.every((item) => finite(item.open_interest)) ? minimumOi : null, minimum_volume: selected.every((item) => finite(item.volume)) ? minimumVolume : null },
    gex: { status: "NOT_SUPPORTED", reason: "Robinhood 官方只读样本不是完整全链，不能把局部 Gamma×OI 冒充总 GEX" },
    scenario_pnl: scenarioPnl, scenario_node_pnl: nodePnl, expected_pnl_usd: expected === null ? null : rounded(expected, 2), risk_adjusted_expected_return_pct: expected === null || !finite(maxRisk) || maxRisk <= 0 ? null : rounded(expected / maxRisk * 100, 2),
    execution_cost: { entry_at_ask_usd: finite(debit) ? rounded(debit * 100, 2) : null, one_way_slippage_from_mid_usd: spreads.every(Boolean) ? rounded(spreads.reduce((sum, item) => sum + item!.absolute * 50, 0), 2) : null, estimated_round_trip_spread_cost_usd: spreadCost === null ? null : rounded(spreadCost, 2) },
    market_edge: { estimated_round_trip_spread_cost_usd: spreadCost === null ? null : rounded(spreadCost, 2), expected_after_spread_usd: expectedAfterSpread === null ? null : rounded(expectedAfterSpread, 2), main_path_move_pct: mainMovePct === null ? null : rounded(mainMovePct), breakeven_move_pct: finite(breakevenMovePct) ? rounded(breakevenMovePct) : null, covers_spread_and_decay: expectedAfterSpread === null ? null : expectedAfterSpread > 0, model: "TS_PROBABILITY_DELTA_GAMMA_THETA_STATIC_IV_MINUS_BBO" },
    status: gaps.length ? "BLOCKED" : "PASS", data_gaps: [...new Set(gaps)],
  };
}

function candidateOrder(left: OptionStrategyCandidate, right: OptionStrategyCandidate) {
  return Number(right.status === "PASS") - Number(left.status === "PASS")
    || (right.market_edge.expected_after_spread_usd ?? -Infinity) - (left.market_edge.expected_after_spread_usd ?? -Infinity)
    || (right.risk_adjusted_expected_return_pct ?? -Infinity) - (left.risk_adjusted_expected_return_pct ?? -Infinity)
    || (left.liquidity.max_relative_spread_pct ?? Infinity) - (right.liquidity.max_relative_spread_pct ?? Infinity);
}

function candidates(market: ReadonlyMarketSources, ts: TsOutput, history: TsOutput[] | undefined, riskContext: TsRegimeRiskContext | null | undefined) {
  const result: OptionStrategyCandidate[] = [];
  const nextTs = nextSessionTs(history, ts);
  for (const symbol of ["SPY", "QQQ"] as const) {
    const quote = market.quotes.find((item) => item.symbol === symbol), chain = market.options.find((item) => item.symbol === symbol);
    if (!quote || !finite(quote.last) || !chain) continue;
    const direction = ts.symbol_outlooks[symbol].direction;
    const longType: OptionStrategyCandidate["strategy_type"] | null = direction === "BULLISH" ? "LONG_CALL" : direction === "BEARISH" ? "LONG_PUT" : null;
    if (!longType) continue;
    const optionType = longType === "LONG_CALL" ? "call" : "put";
    const longRows = chain.contracts.filter((item) => item.option_type === optionType).flatMap((contract) => candidate(symbol, longType, chain.contracts, quote.last!, market, ts, nextTs, riskContext, contract) ?? []);
    for (const horizon of ["INTRADAY_0_1", "SHORT_2_7", "SWING_14_60", "LONG_90_PLUS"] as const) {
      const ranked = longRows.filter((item) => item.holding_horizon === horizon).toSorted(candidateOrder).map((item, index) => ({ ...item, rank_in_horizon: index + 1, selection_note: index === 0 ? "同标的同期限综合最优" : item.status === "PASS" ? "同期限备选；净期望、价差或最大风险排序较后" : item.data_gaps[0] ?? "未通过门禁" }));
      result.push(...ranked.slice(0, 2));
    }
    const spreadType = direction === "BULLISH" ? "CALL_DEBIT_SPREAD" : "PUT_DEBIT_SPREAD";
    const nearestContracts = chain.contracts.filter((item) => item.expiration === chain.nearest_expiration);
    const spreadCandidate = candidate(symbol, spreadType, nearestContracts, quote.last, market, ts, nextTs, riskContext);
    if (spreadCandidate) result.push({ ...spreadCandidate, rank_in_horizon: 1, selection_note: "保留现有借记价差比较；本轮未扩展多腿规则" });
  }
  return result.toSorted((left, right) => left.rank_in_horizon - right.rank_in_horizon || candidateOrder(left, right) || left.symbol.localeCompare(right.symbol));
}

function changeSummary(previous: OptionStrategySignal | null | undefined, action: OptionStrategySignal["owner_action"], selected: string | null) {
  if (!previous) return "首次记录：没有更早的策略信号可比较。";
  if (previous.owner_action === action && previous.selected_candidate_id === selected) return "与上一槽一致：老板动作和入选结构没有变化。";
  return `状态从 ${previous.owner_action} 变为 ${action}；结构从 ${previous.selected_candidate_id ?? "无"} 变为 ${selected ?? "无"}。`;
}

export function buildOptionStrategySignal(input: Inputs): OptionStrategySignal {
  const gaps: string[] = [];
  const market = input.market, ts = input.ts;
  if (!input.riskContext) gaps.push("同槽盘型与分层风控上下文缺失");
  else if (input.riskContext.risk_layers.core_hard.length) gaps.push("核心硬阻断仍然存在");
  if (!market) gaps.push("A1 没有生成冻结行情快照");
  if (!ts) gaps.push("TS 没有生成同槽预测");
  if (!input.d) gaps.push("D 没有生成同槽方案");
  if (!input.a3) gaps.push("A3 没有生成同槽最终决定");
  if (input.sourceMode !== "LIVE") gaps.push("REPLAY 只验证计算能力，不进入自然 LIVE 决策");
  if (market && (market.status !== "LIVE" || market.market_session.state !== "REGULAR" || (market.freshness_seconds ?? Number.POSITIVE_INFINITY) > MARKET_5M_MAX_AGE_SECONDS)) gaps.push("行情不是可执行的新鲜 LIVE 正常时段快照");
  const blockedScopes = new Set((input.riskContext?.risk_layers.new_entry ?? []).map((item) => item.scope));
  const list = (market && ts ? candidates(market, ts, input.tsHistory, input.riskContext).map((item) => applyVolatilityGate(item, market, input.ivHistory ?? [], input.riskContext)) : []).map((item) => blockedScopes.has("GLOBAL") || blockedScopes.has(item.symbol)
    ? { ...item, status: "BLOCKED" as const, data_gaps: [...new Set([...item.data_gaps, ...input.riskContext!.risk_layers.new_entry.filter((issue) => issue.scope === "GLOBAL" || issue.scope === item.symbol).map((issue) => issue.reason)])] }
    : item);
  const best = list.filter((item) => item.status === "PASS").toSorted(candidateOrder)[0] ?? null;
  const bestSingle = list.filter((item) => item.status === "PASS" && item.strategy_type.startsWith("LONG_")).toSorted(candidateOrder)[0] ?? null;
  const bestSpread = list.filter((item) => item.status === "PASS" && item.strategy_type.endsWith("SPREAD")).toSorted(candidateOrder)[0] ?? null;
  const dAction = text(input.d?.action), a3Decision = text(input.a3?.decision);
  let action: OptionStrategySignal["owner_action"] = gaps.length ? "WAIT" : a3Decision === "NO_TRADE" || dAction === "NO_TRADE" ? "NO_TRADE" : a3Decision === "OBSERVE" || dAction === "OBSERVE" ? "OBSERVE" : "WAIT";
  let selected: OptionStrategyCandidate | null = null;
  if (!gaps.length && dAction === "MANUAL_BUY" && a3Decision === "MANUAL_BUY") {
    const underlying = text(input.a3?.underlying), side = text(input.a3?.option_side), expiration = text(input.a3?.expiration);
    const strike = finite(input.a3?.strike) ? input.a3.strike : null, quantity = finite(input.a3?.quantity) ? input.a3.quantity : null;
    const dAligned = input.d?.underlying === underlying && input.d?.option_side === side && input.d?.expiration === expiration && input.d?.strike === strike && input.d?.quantity === quantity;
    if (!dAligned || !Array.isArray(input.d?.data_gaps) || input.d.data_gaps.length > 0 || input.d.data_status !== undefined && input.d.data_status !== "HEALTHY" || input.a3?.data_status !== "HEALTHY" || quantity !== 1) gaps.push("D/A3 的健康状态、标的、方向、到期日、行权价或单组数量不一致");
    const aligned = gaps.length ? [] : list.filter((item) => item.status === "PASS" && item.symbol === underlying && item.expiration === expiration && item.legs[0]?.strike === strike && (side === "call" ? item.strategy_type.includes("CALL") : side === "put" ? item.strategy_type.includes("PUT") : false));
    const withinBudget = aligned.filter((item) => item.max_risk_usd !== null && item.max_risk_usd <= Number(input.d?.max_entry_debit) && item.max_risk_usd <= Number(input.a3?.max_entry_debit));
    selected = withinBudget.sort((a, b) => (b.risk_adjusted_expected_return_pct ?? -Infinity) - (a.risk_adjusted_expected_return_pct ?? -Infinity) || (a.max_risk_usd ?? Infinity) - (b.max_risk_usd ?? Infinity))[0] ?? null;
    action = selected ? "EXECUTABLE" : "WAIT";
    if (!selected) gaps.push("D/A3 已允许方向，但没有通过完整行情、流动性和风险门禁的结构");
  }
  if (list.length === 0 && market && ts && ts.path_bias !== "RANGE") gaps.push("冻结期权样本没有形成可比较候选");
  const volatilityReasons = list.flatMap((item) => item.volatility_gate?.reasons ?? []);
  const decisionBasis: OptionStrategySignal["decision_basis"] = selected ? "EXECUTABLE"
    : ts?.path_bias === "RANGE" || (ts && (["SPY", "QQQ"] as const).every((symbol) => ts.symbol_outlooks[symbol].direction === "RANGE")) ? "DIRECTION_UNCLEAR"
      : a3Decision === "NO_TRADE" || dAction === "NO_TRADE" ? "DEPARTMENT_NO_TRADE"
        : !bestSingle && bestSpread ? "SINGLE_LEG_BLOCKED_SPREAD_ACCEPTABLE"
          : volatilityReasons.some((reason) => reason.includes("IV Crush")) ? "EVENT_IV_CRUSH_RISK"
            : volatilityReasons.some((reason) => reason.includes("Skew")) ? "SKEW_UNFAVORABLE"
              : volatilityReasons.some((reason) => /权利金偏贵|IV 回落/.test(reason)) ? "PREMIUM_TOO_EXPENSIVE"
                : list.length && !best ? "ALL_CONTRACTS_REJECTED"
                  : !best ? "NO_QUALIFIED_CONTRACT" : "QUALIFIED_CONTRACT_WAITING_APPROVAL";
  const observedAt = input.observedAt ?? market?.generated_at ?? ts?.evidence_snapshot.market_time.observed_at ?? new Date().toISOString();
  const riskIssues = input.riskContext ? Object.values(input.riskContext.risk_layers).flat() : [];
  const riskSummary = {
    context_hash: input.riskContext?.context_hash ?? null, market_type: input.riskContext?.market_type ?? "NOT_OBSERVED",
    core_hard_block_count: input.riskContext?.risk_layers.core_hard.length ?? 1,
    new_entry_block_count: input.riskContext?.risk_layers.new_entry.length ?? 0,
    position_management_block_count: input.riskContext?.risk_layers.position_management.length ?? 0,
    soft_degrade_count: input.riskContext?.risk_layers.soft.length ?? 0, issues: riskIssues,
  };
  const historySessions = new Set((input.ivHistory ?? []).map((item) => item.market_date)).size;
  const volatilitySummary = {
    source: "IMMUTABLE_A1_LIVE_OUTPUTS" as const,
    archive_status: historySessions >= MIN_IV_HISTORY_SESSIONS ? "READY" as const : "ACCUMULATING" as const,
    history_snapshot_count: new Set((input.ivHistory ?? []).map((item) => item.snapshot_id)).size,
    history_session_count: historySessions,
    minimum_sessions: MIN_IV_HISTORY_SESSIONS,
    limitations: [
      ...(historySessions < MIN_IV_HISTORY_SESSIONS ? [`真实 IV 历史不足 ${MIN_IV_HISTORY_SESSIONS} 个交易日，不计算 IV Rank/Percentile`] : []),
      "Robinhood 当前为代表性 Strike/到期日只读样本；未把局部链冒充完整全链",
      "UW、完整 GEX 与主动买卖方向未接入，保持降级",
    ],
  };
  const base = {
    contract_version: "v1" as const, component: "OPTION_STRATEGY_SIGNAL" as const, mode: "SHADOW" as const, source_mode: input.sourceMode, automated_execution: false as const,
    source_run_id: input.runId, slot_id: input.slotId, previous_signal_id: input.previous?.signal_id ?? null, observed_at: observedAt,
    data_cutoff_at: market?.as_of ?? observedAt, market_snapshot_id: market?.snapshot_id ?? null, market_snapshot_hash: market?.snapshot_hash ?? null,
    ts_run_id: ts?.evidence_snapshot.run_id ?? null, d_action: dAction, a3_decision: a3Decision, owner_action: action,
    selected_candidate_id: selected?.candidate_id ?? null, best_candidate_id: best?.candidate_id ?? null, decision_basis: decisionBasis,
    change_summary: changeSummary(input.previous, action, selected?.candidate_id ?? null), candidates: list, volatility_summary: volatilitySummary, risk_summary: riskSummary, data_gaps: [...new Set(gaps)],
  };
  return { ...base, signal_id: `option-signal-${hash(base).slice(0, 24)}` };
}
