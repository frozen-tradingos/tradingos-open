import { createHash } from "node:crypto";
import { formatPtTime, isNyseRegularSession, MARKET_5M_MAX_AGE_SECONDS, nyseClosePtMinutes, ptDateKey } from "./market-time.ts";
import { evaluateIntradayRegime, type IntradayRegimeEvent } from "./intraday-regime.ts";
import type { OfficialMacroContext, ReadonlyMarketSources, ShadowComponentResult } from "./snapshot-import.ts";

export type TsMarketRegime = "TREND_UP" | "TREND_DOWN" | "NARROW_RANGE" | "WIDE_CHOP" | "FALSE_BREAKOUT" | "TRANSITION" | "MAJOR_EVENT" | "UNKNOWN";
export type RiskLayer = "CORE_HARD_BLOCK" | "NEW_ENTRY_BLOCK" | "POSITION_MANAGEMENT_BLOCK" | "SOFT_DEGRADE";
export type RiskIssue = { code: string; layer: RiskLayer; scope: "GLOBAL" | "SPY" | "QQQ" | `HOLDING:${string}`; reason: string; source: string };
export type TsRegimeRiskContext = {
  contract_version: "v1";
  component: "TS_REGIME_RISK_CONTEXT";
  mode: "SHADOW";
  observed_at: string;
  market_snapshot_id: string | null;
  market_snapshot_hash: string | null;
  base_regime: Exclude<TsMarketRegime, "MAJOR_EVENT">;
  market_type: TsMarketRegime;
  event_overlay: { status: "ACTIVE" | "NOT_OBSERVED"; events: Array<{ name: string; scheduled_at: string; category: string }> };
  overnight_context: { status: "OBSERVED" | "NOT_OBSERVED" | "DATA_BLOCKED"; trading_date: string | null; confidence: "LOW"; can_override_regular_regime: false; can_generate_option_order: false; symbols: Array<{ symbol: string; direction: "UP" | "DOWN" | "FLAT" | "NOT_OBSERVED"; high: number | null; low: number | null; gap_pct: number | null; broke_previous_high: boolean | null; broke_previous_low: boolean | null }> };
  completed_structure: {
    version: "COMPLETED_RTH_STRUCTURE_V1";
    frozen_at: string;
    interpretation: string;
    paired_observation: Pick<IntradayRegimeEvent, "state" | "direction" | "path_stage" | "data_timestamp" | "evidence">;
  };
  symbols: Record<"SPY" | "QQQ", {
    current_pattern: string;
    current_price: number | null;
    session_high: number | null;
    session_low: number | null;
    session_mid: number | null;
    range_width_pct: number | null;
    range_zone: "UPPER" | "MIDDLE" | "LOWER" | "NOT_OBSERVED";
    vwap: number | null;
    vwap_relation: "ABOVE" | "BELOW" | "AT" | "NOT_OBSERVED";
    vwap_behavior: "RECLAIMED" | "REJECTED" | "HOLDING_ABOVE" | "HOLDING_BELOW" | "NOT_OBSERVED";
    breakout_state: "FALSE_BREAKOUT" | "FALSE_BREAKDOWN" | "CONFIRMED_TREND" | "NOT_OBSERVED";
    remaining_upper_space_pct: number | null;
    remaining_lower_space_pct: number | null;
    remaining_regular_minutes: number | null;
    option_cost: { status: "OBSERVED" | "DATA_BLOCKED" | "NOT_OBSERVED"; atm_relative_spread_pct: number | null; iv: number | null; theta: number | null };
    entry_gate: "WAIT" | "NO_TRADE" | "CONDITIONAL";
    completed_bars: {
      status: "LIVE" | "STALE" | "INCOMPLETE" | "NOT_OBSERVED";
      closed_at: string | null;
      bar_count: number;
      contiguous_from_open: boolean;
      volume_complete: boolean;
      last_close: number | null;
      recent_closes: number[];
      opening_range_relation: "ABOVE" | "BELOW" | "INSIDE" | "NOT_OBSERVED";
      a2_pattern: { current_state: string; candidate_state: string | null; candidate_bars: number | null; data_time: string | null; state_since: string | null };
    };
  }>;
  risk_layers: Record<"core_hard" | "new_entry" | "position_management" | "soft", RiskIssue[]>;
  context_hash: string;
};

const symbols = ["SPY", "QQQ"] as const;
const majorCategories = new Set(["inflation", "employment", "central_bank", "growth"]);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number, digits = 4) => Number(value.toFixed(digits));
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

function pattern(a2: ShadowComponentResult | null, symbol: "SPY" | "QQQ") {
  const top = a2?.pattern_evidence as { symbols?: Record<string, Record<string, unknown>> } | undefined;
  const nested = a2?.v2_result?.pattern_evidence as typeof top;
  const value = top?.symbols?.[symbol] ?? nested?.symbols?.[symbol];
  return { current_state: typeof value?.current_state === "string" ? value.current_state : "UNKNOWN", candidate_state: typeof value?.candidate_state === "string" ? value.candidate_state : null,
    candidate_bars: finite(value?.candidate_bars) ? value.candidate_bars : null, data_time: typeof value?.data_time === "string" && value.data_time ? value.data_time : null, state_since: typeof value?.state_since === "string" && value.state_since ? value.state_since : null };
}

function completedBars(market: ReadonlyMarketSources | null, symbol: "SPY" | "QQQ", observedAt: string) {
  const at = Date.parse(observedAt), day = ptDateKey(observedAt), chart = market?.bars.find((item) => item.source === "ROBINHOOD" && item.symbol === symbol && item.interval === "5min");
  // Use the frozen input clock, never wall time or the unfinished current candle.
  const rows = (chart?.values ?? []).filter((bar) => {
    const begin = Date.parse(bar.begins_at);
    if (!Number.isFinite(begin) || ptDateKey(begin) !== day || !isNyseRegularSession(day) || begin + 300_000 > at) return false;
    const [hour, minute] = formatPtTime(begin).split(":").map(Number);
    return hour * 60 + minute >= 390 && hour * 60 + minute < nyseClosePtMinutes(day);
  }).toSorted((a, b) => Date.parse(a.begins_at) - Date.parse(b.begins_at));
  const valid = rows.every((bar) => Date.parse(bar.begins_at) % 300_000 === 0 && [bar.open, bar.high, bar.low, bar.close].every((n) => finite(n) && n > 0) && bar.high! >= Math.max(bar.open!, bar.close!, bar.low!) && bar.low! <= Math.min(bar.open!, bar.close!));
  const bars = valid ? rows as Array<typeof rows[number] & { open: number; high: number; low: number; close: number }> : [];
  const contiguous = bars.length > 0 && formatPtTime(bars[0].begins_at) === "06:30" && bars.every((bar, index) => index === 0 || Date.parse(bar.begins_at) - Date.parse(bars[index - 1].begins_at) === 300_000);
  const volumeComplete = bars.length > 0 && bars.every((bar) => finite(bar.volume) && bar.volume >= 0) && bars.some((bar) => bar.volume! > 0);
  const closedAt = bars.length ? new Date(Date.parse(bars.at(-1)!.begins_at) + 300_000).toISOString() : null;
  const sourceTimeKnown = [chart?.as_of, market?.generated_at].every((value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= at);
  const status = !chart || !rows.length ? "NOT_OBSERVED" as const : !sourceTimeKnown || !valid || !contiguous || !volumeComplete || chart.status === "DATA_BLOCKED" || market?.market_session.market_date !== day ? "INCOMPLETE" as const
    : chart.status === "STALE" || at - Date.parse(closedAt!) > MARKET_5M_MAX_AGE_SECONDS * 1_000 ? "STALE" as const : "LIVE" as const;
  return { bars, status, closedAt, contiguous, volumeComplete };
}

function normalizedPattern(value: string): Exclude<TsMarketRegime, "MAJOR_EVENT"> {
  if (value === "TREND_UP" || value === "TREND_DOWN" || value === "NARROW_RANGE" || value === "WIDE_CHOP") return value;
  if (value === "FALSE_BREAKOUT" || value === "FALSE_BREAKDOWN") return "FALSE_BREAKOUT";
  if (["TRANSITION", "MIXED", "V_REVERSAL_UP", "V_REVERSAL_DOWN"].includes(value)) return "TRANSITION";
  return "UNKNOWN";
}

function eventOverlay(macro: OfficialMacroContext | null | undefined, observedAt: string) {
  const start = Date.parse(observedAt), end = start + 90 * 60_000;
  const events = (macro?.events ?? []).flatMap((event) => {
    if (event.time_precision !== undefined && event.time_precision !== "EXACT" || event.confidence?.endsWith("_date_only")) return [];
    const scheduled = Date.parse(event.scheduled_at), category = typeof event.category === "string" ? event.category.toLowerCase() : "";
    return Number.isFinite(scheduled) && scheduled >= start && scheduled <= end && majorCategories.has(category)
      ? [{ name: event.release_name, scheduled_at: event.scheduled_at, category }]
      : [];
  });
  return { status: events.length ? "ACTIVE" as const : "NOT_OBSERVED" as const, events };
}

function symbolEvidence(market: ReadonlyMarketSources | null, a2: ShadowComponentResult | null, symbol: "SPY" | "QQQ", observedAt: string, completed: ReturnType<typeof completedBars>) {
  const a2Pattern = pattern(a2, symbol), currentPattern = a2Pattern.current_state, regime = normalizedPattern(currentPattern);
  const quote = market?.quotes.find((item) => item.symbol === symbol);
  const dateKey = ptDateKey(observedAt), bars = completed.bars;
  const last = finite(quote?.last) ? quote.last : bars.at(-1)?.close ?? null;
  const high = bars.length ? Math.max(...bars.map((bar) => bar.high)) : null;
  const low = bars.length ? Math.min(...bars.map((bar) => bar.low)) : null;
  const mid = high !== null && low !== null ? (high + low) / 2 : null;
  const volume = completed.contiguous && completed.volumeComplete ? bars.reduce((sum, bar) => sum + bar.volume!, 0) : null;
  const vwap = volume ? bars.reduce((sum, bar) => sum + bar.close * bar.volume!, 0) / volume : null;
  const relation = last === null || vwap === null ? "NOT_OBSERVED" as const : Math.abs(last - vwap) <= last * 0.0001 ? "AT" as const : last > vwap ? "ABOVE" as const : "BELOW" as const;
  const previous = bars.at(-2)?.close;
  const behavior = previous === undefined || vwap === null || last === null ? "NOT_OBSERVED" as const
    : previous < vwap && last >= vwap ? "RECLAIMED" as const
      : previous > vwap && last <= vwap ? "REJECTED" as const
        : last > vwap ? "HOLDING_ABOVE" as const : "HOLDING_BELOW" as const;
  const option = market?.options.find((item) => item.symbol === symbol);
  const atm = option && last !== null ? option.contracts.filter((item) => finite(item.strike)).toSorted((left, right) => Math.abs(left.strike - last) - Math.abs(right.strike - last))[0] : undefined;
  const spread = atm && finite(atm.bid) && finite(atm.ask) && atm.ask >= atm.bid && atm.ask + atm.bid > 0 ? (atm.ask - atm.bid) / ((atm.ask + atm.bid) / 2) * 100 : null;
  const minutes = (() => { const [hour, minute] = formatPtTime(observedAt).split(":").map(Number); return market?.market_session.state === "REGULAR" ? Math.max(0, nyseClosePtMinutes(dateKey) - hour * 60 - minute) : null; })();
  const zone = last === null || high === null || low === null || high === low ? "NOT_OBSERVED" as const : last >= low + (high - low) * 2 / 3 ? "UPPER" as const : last <= low + (high - low) / 3 ? "LOWER" as const : "MIDDLE" as const;
  const entryGate = ["WIDE_CHOP", "FALSE_BREAKOUT"].includes(regime) ? "NO_TRADE" as const : ["NARROW_RANGE", "TRANSITION", "UNKNOWN"].includes(regime) ? "WAIT" as const : "CONDITIONAL" as const;
  return {
    current_pattern: currentPattern, current_price: last, session_high: high, session_low: low, session_mid: mid === null ? null : round(mid),
    range_width_pct: last && high !== null && low !== null ? round((high - low) / last * 100) : null, range_zone: zone,
    vwap: vwap === null ? null : round(vwap), vwap_relation: relation, vwap_behavior: behavior,
    breakout_state: currentPattern === "FALSE_BREAKOUT" ? "FALSE_BREAKOUT" as const : currentPattern === "FALSE_BREAKDOWN" ? "FALSE_BREAKDOWN" as const : ["TREND_UP", "TREND_DOWN"].includes(currentPattern) ? "CONFIRMED_TREND" as const : "NOT_OBSERVED" as const,
    remaining_upper_space_pct: last && high !== null ? round(Math.max(0, (high - last) / last * 100)) : null,
    remaining_lower_space_pct: last && low !== null ? round(Math.max(0, (last - low) / last * 100)) : null,
    remaining_regular_minutes: minutes,
    option_cost: { status: !option ? "NOT_OBSERVED" as const : !["LIVE", "MARKET_CLOSED"].includes(option.status) || spread === null || !finite(atm?.iv) || !finite(atm?.theta) ? "DATA_BLOCKED" as const : "OBSERVED" as const, atm_relative_spread_pct: spread === null ? null : round(spread), iv: finite(atm?.iv) ? atm.iv : null, theta: finite(atm?.theta) ? atm.theta : null },
    entry_gate: entryGate,
    completed_bars: { status: completed.status, closed_at: completed.closedAt, bar_count: bars.length, contiguous_from_open: completed.contiguous, volume_complete: completed.volumeComplete,
      last_close: bars.at(-1)?.close ?? null, recent_closes: bars.slice(-6).map((bar) => bar.close),
      opening_range_relation: !completed.contiguous || bars.length < 3 ? "NOT_OBSERVED" as const : bars.at(-1)!.close > Math.max(...bars.slice(0, 3).map((bar) => bar.high)) ? "ABOVE" as const : bars.at(-1)!.close < Math.min(...bars.slice(0, 3).map((bar) => bar.low)) ? "BELOW" as const : "INSIDE" as const,
      a2_pattern: a2Pattern },
  };
}

export function buildTsRegimeRiskContext(input: { market: ReadonlyMarketSources | null; a2: ShadowComponentResult | null; officialMacro?: OfficialMacroContext | null; observedAt?: string }): TsRegimeRiskContext {
  const observedAt = input.observedAt ?? input.market?.generated_at ?? input.a2?.observed_at ?? new Date().toISOString();
  const completed = Object.fromEntries(symbols.map((symbol) => [symbol, completedBars(input.market, symbol, observedAt)])) as Record<"SPY" | "QQQ", ReturnType<typeof completedBars>>;
  const symbolRows = Object.fromEntries(symbols.map((symbol) => [symbol, symbolEvidence(input.market, input.a2, symbol, observedAt, completed[symbol])])) as TsRegimeRiskContext["symbols"];
  const paired = evaluateIntradayRegime({ observedAt, previous: null, charts: symbols.map((symbol) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: completed[symbol].status === "LIVE" ? "LIVE" : "DATA_BLOCKED", bars: completed[symbol].bars })) });
  const regimes = symbols.map((symbol) => normalizedPattern(symbolRows[symbol].current_pattern));
  const baseRegime = regimes[0] === regimes[1] ? regimes[0] : regimes.includes("UNKNOWN") ? regimes.find((item) => item !== "UNKNOWN") ?? "UNKNOWN" : "TRANSITION";
  const event = eventOverlay(input.officialMacro, observedAt);
  const extended = input.market?.market_environment?.extended_hours;
  const overnightSymbols = (extended?.instruments ?? []).filter((item) => (item.symbol === "SPY" || item.symbol === "QQQ") && item.overnight).map((item) => ({ symbol: item.symbol, direction: item.overnight!.direction, high: item.overnight!.high, low: item.overnight!.low, gap_pct: item.overnight!.gap_pct, broke_previous_high: item.overnight!.broke_previous_high, broke_previous_low: item.overnight!.broke_previous_low }));
  const overnight = { status: extended?.status === "DATA_BLOCKED" ? "DATA_BLOCKED" as const : overnightSymbols.some((item) => item.direction !== "NOT_OBSERVED") ? "OBSERVED" as const : "NOT_OBSERVED" as const, trading_date: extended?.trading_date ?? null, confidence: "LOW" as const, can_override_regular_regime: false as const, can_generate_option_order: false as const, symbols: overnightSymbols };
  const core: RiskIssue[] = [], entry: RiskIssue[] = [], positions: RiskIssue[] = [], soft: RiskIssue[] = [];
  if (!input.market || ["DATA_BLOCKED", "STALE"].includes(input.market.status)) core.push({ code: "CORE_MARKET_UNAVAILABLE", layer: "CORE_HARD_BLOCK", scope: "GLOBAL", reason: "核心标的行情缺失或过期，禁止生成可执行结论。", source: "ROBINHOOD_OFFICIAL_READONLY" });
  if (!input.a2) core.push({ code: "A2_FROZEN_EVIDENCE_MISSING", layer: "CORE_HARD_BLOCK", scope: "GLOBAL", reason: "A2 同槽冻结证据缺失。", source: "A2" });
  for (const symbol of symbols) {
    const row = symbolRows[symbol];
    if (row.entry_gate !== "CONDITIONAL") entry.push({ code: `REGIME_${row.current_pattern}`, layer: "NEW_ENTRY_BLOCK", scope: symbol, reason: row.entry_gate === "NO_TRADE" ? "当前盘型不接受新开仓。" : "当前盘型需等待 VWAP、区间边界或真实突破确认。", source: "A2_PATTERN_TRACKER" });
    if (row.option_cost.status !== "OBSERVED") entry.push({ code: "OPTION_COST_NOT_OBSERVED", layer: "NEW_ENTRY_BLOCK", scope: symbol, reason: "Bid/Ask、IV 或 Theta 不完整；不影响标的行情分析，但禁止该标的新开仓。", source: "ROBINHOOD_OPTION_CHAIN" });
  }
  if (event.status === "ACTIVE") entry.push({ code: "MAJOR_EVENT_WINDOW", layer: "NEW_ENTRY_BLOCK", scope: "GLOBAL", reason: "未来 90 分钟存在官方重大宏观事件；等待公布与价格确认。", source: "OFFICIAL_MACRO_CONTEXT" });
  for (const position of input.market?.account.positions ?? []) {
    if (finite(position.bid) && finite(position.ask) && position.ask >= position.bid && finite(position.mark)) continue;
    positions.push({ code: "HOLDING_QUOTE_UNAVAILABLE", layer: "POSITION_MANAGEMENT_BLOCK", scope: `HOLDING:${position.contract_id ?? position.symbol ?? "UNKNOWN"}`, reason: "该持仓合约报价不完整；只阻断这一项持仓管理。", source: "ROBINHOOD_ACCOUNT_READONLY" });
  }
  soft.push(
    { code: "UW_NOT_SUPPORTED", layer: "SOFT_DEGRADE", scope: "GLOBAL", reason: "未接入可靠 UW；不推断异常大单。", source: "CAPABILITY_REGISTRY" },
    { code: "GEX_NOT_SUPPORTED", layer: "SOFT_DEGRADE", scope: "GLOBAL", reason: "没有完整全链 GEX；不以局部 Gamma×OI 冒充。", source: "ROBINHOOD_OPTION_CHAIN" },
    { code: "ACTIVE_BUY_SELL_DIRECTION_NOT_SUPPORTED", layer: "SOFT_DEGRADE", scope: "GLOBAL", reason: "没有可靠主动买卖方向；相关证据保持缺失。", source: "CAPABILITY_REGISTRY" },
  );
  if (overnight.status === "OBSERVED") soft.push({ code: "OVERNIGHT_CONTEXT_LOW_CONFIDENCE", layer: "SOFT_DEGRADE", scope: "GLOBAL", reason: "隔夜方向、高低点和缺口仅作次日背景；稀疏成交不能推翻常规盘型，开盘后仍需价格、VWAP、成交量与期权 Bid/Ask 确认。", source: "ROBINHOOD_OFFICIAL_24_5" });
  const base = {
    contract_version: "v1" as const, component: "TS_REGIME_RISK_CONTEXT" as const, mode: "SHADOW" as const, observed_at: observedAt,
    market_snapshot_id: input.market?.snapshot_id ?? null, market_snapshot_hash: input.market?.snapshot_hash ?? null,
    base_regime: baseRegime, market_type: event.status === "ACTIVE" ? "MAJOR_EVENT" as const : baseRegime, event_overlay: event, overnight_context: overnight, symbols: symbolRows,
    completed_structure: { version: "COMPLETED_RTH_STRUCTURE_V1" as const, frozen_at: observedAt,
      interpretation: "这些是冻结时点已收盘常规5分钟柱的结构观察，不是未来30–60分钟预测或交易许可。遇到最新突破/破位/VWAP证据时重新检查原震荡判断，说明支持与反证；不得沿用旧盘型代替本槽分析，也不得强制改成单边。A2候选态只保留诊断，不是已确认盘型。paired_observation复用现有HLC3成交量加权VWAP结构规则、无跨槽状态；symbols.vwap沿用收盘价成交量加权口径。不覆盖A2确认、入场门禁或结算。缺量/缺柱/过期保持缺失，不推断确认。",
      paired_observation: { state: paired.state, direction: paired.direction, path_stage: paired.path_stage, data_timestamp: paired.data_timestamp, evidence: paired.evidence } },
    risk_layers: { core_hard: core, new_entry: entry, position_management: positions, soft },
  };
  return { ...base, context_hash: hash(base) };
}
