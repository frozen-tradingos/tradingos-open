import { APPROVED_STOCKS, type ApprovedCapabilitySnapshot, type MarketDataBar, type ReadonlyMarketSources, type SnapshotState } from "./snapshot-import.ts";
import { exchangeDateKey, formatPtTime, MARKET_5M_MAX_AGE_SECONDS, nyseClosePtMinutes, robinhoodSessionAt } from "./market-time.ts";
import { utcForPt } from "./timeline-schedule.ts";
import type { OwnerManualPlan } from "./owner-manual-plan.ts";

export const STOCK_PATTERN_REGIMES = ["TREND_UP", "TREND_DOWN", "NARROW_RANGE", "WIDE_CHOP", "V_REVERSAL_UP", "V_REVERSAL_DOWN", "FALSE_BREAKOUT", "FALSE_BREAKDOWN", "TRANSITION", "UNKNOWN"] as const;
const STOCK_PATTERN_DIRECTIONS: Partial<Record<(typeof STOCK_PATTERN_REGIMES)[number], "BULLISH" | "BEARISH">> = {
  TREND_UP: "BULLISH", V_REVERSAL_UP: "BULLISH", FALSE_BREAKDOWN: "BULLISH", TREND_DOWN: "BEARISH", V_REVERSAL_DOWN: "BEARISH", FALSE_BREAKOUT: "BEARISH",
};

type StockPlanVersion = "stock-plan-v1" | "stock-plan-v2";
export type StockPlanningContext = {
  observed_at: string; entry_trigger: number | null; invalidation_price: number | null; target_price: number | null;
  why_watch: string[]; timeframes: ApprovedCapabilitySnapshot["fixed_pool"]["rows"][number]["timeframes"];
};
export type StockPlanEvidence = {
  contract_version: StockPlanVersion; evidence_id: string; run_id: string; slot_id: string;
  source_mode: "LIVE"; mode: "SHADOW"; automated_execution: false;
  observed_at: string; received_at: string; source_snapshot_id: string; source_snapshot_hash: string;
  symbol: string; instrument_type: "EQUITY"; direction: "BULLISH" | "BEARISH";
  quote: { source: "ROBINHOOD"; symbol: string; status: "LIVE" | "DATA_BLOCKED"; last: number | null; bid: number | null; ask: number | null; as_of: string | null };
  bars: { source: "ROBINHOOD"; symbol: string; interval: "5min"; as_of: string | null; values: MarketDataBar[] };
  pattern: null | { source: "A2_CLASSIFY_PATTERN_V1"; regime: (typeof STOCK_PATTERN_REGIMES)[number]; direction: "bullish" | "bearish" | "neutral" | "unknown" };
  contracts: Array<ReadonlyMarketSources["options"][number]["contracts"][number] & { instrument: { chain_id: string; chain_symbol: string; expiration_date: string; strike_price: number; type: "call" | "put"; state: string; tradability: string; trade_value_multiplier: number | null } }>;
  account: ReadonlyMarketSources["account"];
  news: { checked_at: string; status: "LIVE" | "DATA_BLOCKED"; items: Array<{ id: string; headline: string; url: string; source: string; published_at: string; expires_at: string | null; verified: boolean; market_moving: boolean; symbols: string[] }> };
  global_risk: { checked_at: string; critical_blockers: string[]; new_entry_blockers: string[] };
  data_gaps: string[];
  planning_context?: StockPlanningContext | null;
  setup_gaps?: string[];
  entry_rule?: "MULTI_TIMEFRAME_BREAK_HOLD_V1";
};

export type StockPlanDecision = {
  contract_version: StockPlanVersion; role: "D" | "A3"; decision_id: string; invocation_id: string;
  evidence_id: string; observed_at: string; action: "MANUAL_BUY" | "CONDITIONAL_PLAN" | "NO_TRADE";
  symbol: string; contract_id: string; option_type: "call" | "put"; expiration: string; strike: number;
  quantity: number; max_entry_debit: number; stop_loss_pct: number; take_profit_pct: number; score: number;
  entry_conditions: string[]; invalidation: string[]; target_price: number; reasons: string[];
  entry_trigger_price?: number; invalidation_price?: number; holding_period?: string; contract_selection_reason?: string;
};

export type StockManualPlanOutput = {
  contract_version: StockPlanVersion; component: "STOCK_MANUAL_PLAN"; mode: "SHADOW"; source_mode: "LIVE"; automated_execution: false;
  run_id: string; slot_id: string; observed_at: string; evidence: StockPlanEvidence; decisions: StockPlanDecision[];
  status: "APPROVED" | "CONDITIONAL" | "NO_TRADE" | "DATA_BLOCKED"; blocked_reasons: string[];
};

const isStockSymbol = (value: string) => APPROVED_STOCKS.includes(value);
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const time = (v: unknown): v is string => text(v) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const fresh = (v: unknown, now: number, seconds: number) => time(v) && now >= Date.parse(v) && now - Date.parse(v) <= seconds * 1_000;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every(text);
const version = (v: unknown) => v === "stock-plan-v1" || v === "stock-plan-v2";
function check(condition: unknown, field: string): asserts condition { if (!condition) throw new Error(`个股计划合同无效：${field}`); }
function record(v: unknown, fields: string[], field: string, optional: string[] = []): Record<string, unknown> {
  check(v && typeof v === "object" && !Array.isArray(v), field);
  const row = v as Record<string, unknown>;
  check(fields.every((key) => Object.hasOwn(row, key)) && Object.keys(row).every((key) => fields.includes(key) || optional.includes(key)), field);
  return row;
}
const expiryDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

export function validateStockPlanDecision(value: unknown): StockPlanDecision {
  const extra = ["entry_trigger_price", "invalidation_price", "holding_period", "contract_selection_reason"];
  const v = record(value, ["contract_version", "role", "decision_id", "invocation_id", "evidence_id", "observed_at", "action", "symbol", "contract_id", "option_type", "expiration", "strike", "quantity", "max_entry_debit", "stop_loss_pct", "take_profit_pct", "score", "entry_conditions", "invalidation", "target_price", "reasons"], "decision", extra);
  check(version(v.contract_version) && ["D", "A3"].includes(String(v.role)) && (v.contract_version === "stock-plan-v2" ? ["MANUAL_BUY", "CONDITIONAL_PLAN", "NO_TRADE"] : ["MANUAL_BUY", "NO_TRADE"]).includes(String(v.action)), "decision.version/role/action");
  if (v.contract_version === "stock-plan-v2") check(extra.every((key) => Object.hasOwn(v, key)) && finite(v.entry_trigger_price) && finite(v.invalidation_price) && typeof v.holding_period === "string" && typeof v.contract_selection_reason === "string", "decision.planning");
  else check(extra.every((key) => !Object.hasOwn(v, key)), "decision.legacy-fields");
  check(hash(v.evidence_id) && text(v.decision_id) && text(v.invocation_id) && time(v.observed_at), "decision.identity");
  check(["symbol", "contract_id", "expiration"].every((key) => typeof v[key] === "string") && ["call", "put"].includes(String(v.option_type)), "decision.contract");
  check(["strike", "quantity", "max_entry_debit", "stop_loss_pct", "take_profit_pct", "score", "target_price"].every((key) => finite(v[key])), "decision.numbers");
  check(strings(v.entry_conditions) && strings(v.invalidation) && strings(v.reasons) && v.reasons.length > 0, "decision.explanations");
  return v as unknown as StockPlanDecision;
}

export function validateStockPlanEvidence(value: unknown): StockPlanEvidence {
  const v = record(value, ["contract_version", "evidence_id", "run_id", "slot_id", "source_mode", "mode", "automated_execution", "observed_at", "received_at", "source_snapshot_id", "source_snapshot_hash", "symbol", "instrument_type", "direction", "quote", "bars", "pattern", "contracts", "account", "news", "global_risk", "data_gaps"], "evidence", ["planning_context", "setup_gaps", "entry_rule"]);
  check(version(v.contract_version) && v.source_mode === "LIVE" && v.mode === "SHADOW" && v.automated_execution === false, "evidence.boundary");
  check(hash(v.evidence_id) && hash(v.source_snapshot_hash) && text(v.source_snapshot_id) && typeof v.run_id === "string" && /^live-shadow:\d{8}T\d{6}Z$/.test(v.run_id) && v.slot_id === v.run_id, "evidence.identity");
  check(time(v.observed_at) && time(v.received_at) && Date.parse(v.received_at) >= Date.parse(v.observed_at), "evidence.time");
  if (v.contract_version === "stock-plan-v2") {
    check(!Object.hasOwn(v, "entry_rule") || v.entry_rule === "MULTI_TIMEFRAME_BREAK_HOLD_V1", "evidence.entry-rule");
    check(Object.hasOwn(v, "planning_context") && strings(v.setup_gaps), "evidence.planning-fields");
    if (v.planning_context !== null) {
      const context = record(v.planning_context, ["observed_at", "entry_trigger", "invalidation_price", "target_price", "why_watch", "timeframes"], "planning_context");
      check(time(context.observed_at) && Date.parse(context.observed_at) <= Date.parse(v.received_at) && strings(context.why_watch) && [context.entry_trigger, context.invalidation_price, context.target_price].every((price) => price === null || positive(price)), "planning_context.fields");
      const frames = record(context.timeframes, ["daily", "four_hour", "one_hour", "thirty_minute"], "planning_context.timeframes");
      for (const [key, frameName] of [["daily", "1d"], ["four_hour", "4h"], ["one_hour", "1h"], ["thirty_minute", "30m"]]) {
        const frame = record(frames[key], ["timeframe", "available", "pattern", "state", "direction", "confidence", "support", "resistance", "volume_context", "data_cutoff", "limitation"], "planning_context.timeframe", ["return_pct"]);
        check(frame.timeframe === frameName && typeof frame.available === "boolean" && text(frame.pattern) && text(frame.state) && ["BULLISH", "BEARISH", "RANGE", "NOT_OBSERVED"].includes(String(frame.direction)) && ["放量", "缩量", "正常", "未观察到"].includes(String(frame.volume_context)), "planning_context.timeframe.identity");
        check([frame.support, frame.resistance].every((price) => price === null || positive(price)) && (frame.confidence === null || finite(frame.confidence) && frame.confidence >= 0 && frame.confidence <= 1) && (frame.limitation === null || typeof frame.limitation === "string") && (frame.return_pct === undefined || frame.return_pct === null || finite(frame.return_pct)), "planning_context.timeframe.values");
        check(frame.data_cutoff === null ? !frame.available : time(frame.data_cutoff) && Date.parse(frame.data_cutoff) <= Date.parse(context.observed_at), "planning_context.timeframe.time");
      }
    }
  } else check(!Object.hasOwn(v, "planning_context") && !Object.hasOwn(v, "setup_gaps") && !Object.hasOwn(v, "entry_rule"), "evidence.legacy-fields");
  check(typeof v.symbol === "string" && isStockSymbol(v.symbol) && v.instrument_type === "EQUITY" && ["BULLISH", "BEARISH"].includes(String(v.direction)) && strings(v.data_gaps), "evidence.stock");
  const quote = record(v.quote, ["source", "symbol", "status", "last", "bid", "ask", "as_of"], "quote");
  check(quote.source === "ROBINHOOD" && quote.symbol === v.symbol && ["LIVE", "DATA_BLOCKED"].includes(String(quote.status)) && ["last", "bid", "ask"].every((key) => quote[key] === null || finite(quote[key])) && (quote.as_of === null || time(quote.as_of)), "quote.fields");
  const bars = record(v.bars, ["source", "symbol", "interval", "as_of", "values"], "bars");
  check(bars.source === "ROBINHOOD" && bars.symbol === v.symbol && bars.interval === "5min" && (bars.as_of === null || time(bars.as_of)) && Array.isArray(bars.values) && bars.values.length <= 2_000, "bars.fields");
  for (const value of bars.values) {
    const row = record(value, ["begins_at", "open", "high", "low", "close", "volume"], "bar");
    check(time(row.begins_at) && ["open", "high", "low", "close", "volume"].every((key) => row[key] === null || finite(row[key])), "bar.fields");
  }
  if (v.pattern !== null) {
    const pattern = record(v.pattern, ["source", "regime", "direction"], "pattern");
    check(pattern.source === "A2_CLASSIFY_PATTERN_V1" && (STOCK_PATTERN_REGIMES as readonly string[]).includes(String(pattern.regime)) && ["bullish", "bearish", "neutral", "unknown"].includes(String(pattern.direction)), "pattern.fields");
  }
  check(Array.isArray(v.contracts) && v.contracts.length <= 100, "contracts");
  for (const value of v.contracts) {
    const row = record(value, ["contract_id", "option_type", "expiration", "strike", "bid", "ask", "mark", "volume", "open_interest", "iv", "delta", "gamma", "theta", "vega", "as_of", "history_bars", "history_as_of", "instrument"], "option");
    check(text(row.contract_id) && ["call", "put"].includes(String(row.option_type)) && expiryDate(row.expiration) && positive(row.strike), "option.identity");
    check(["bid", "ask", "mark", "volume", "open_interest", "iv", "delta", "gamma", "theta", "vega", "history_bars"].every((key) => row[key] === null || finite(row[key])) && ["as_of", "history_as_of"].every((key) => row[key] === null || time(row[key])), "option.fields");
    const instrument = record(row.instrument, ["chain_id", "chain_symbol", "expiration_date", "strike_price", "type", "state", "tradability", "trade_value_multiplier"], "option.instrument");
    check(["chain_id", "chain_symbol", "expiration_date", "state", "tradability"].every((key) => typeof instrument[key] === "string") && finite(instrument.strike_price) && ["call", "put"].includes(String(instrument.type)) && (instrument.trade_value_multiplier === null || finite(instrument.trade_value_multiplier)), "option.instrument.fields");
  }
  check(new Set(v.contracts.map((row) => (row as { contract_id: string }).contract_id)).size === v.contracts.length, "option.duplicate");
  const account = record(v.account, ["source", "status", "as_of", "freshness_seconds", "account_count", "positions", "orders", "portfolio_value", "option_value", "realized_pnl"], "account");
  check(account.source === "ROBINHOOD" && ["LIVE", "DATA_BLOCKED", "NOT_AUTHORIZED"].includes(String(account.status)) && (account.as_of === null || time(account.as_of)) && (account.positions === null || Array.isArray(account.positions) && account.positions.length <= 500), "account.fields");
  check(["freshness_seconds", "account_count", "portfolio_value", "option_value", "realized_pnl"].every((key) => account[key] === null || finite(account[key])), "account.numbers");
  // Order history is irrelevant to a proposed entry; omit it at the collector boundary.
  check(account.orders === null || Array.isArray(account.orders) && account.orders.length === 0, "account.orders");
  for (const value of (account.positions as unknown[] | null) ?? []) {
    const row = record(value, ["account_label", "contract_id", "symbol", "option_type", "expiration", "strike", "direction", "quantity", "average_price", "bid", "ask", "mark", "iv", "delta", "gamma", "theta", "vega", "open_interest", "volume", "as_of"], "position");
    check(typeof row.account_label === "string" && /^账户-[a-f0-9]{16}$/.test(row.account_label), "position.masked-account");
    check(["contract_id", "symbol", "expiration"].every((key) => row[key] === null || text(row[key])) && (row.option_type === null || ["call", "put"].includes(String(row.option_type))) && (row.direction === null || ["long", "short"].includes(String(row.direction))), "position.identity");
    check(["strike", "quantity", "average_price", "bid", "ask", "mark", "iv", "delta", "gamma", "theta", "vega", "open_interest", "volume"].every((key) => row[key] === null || finite(row[key])) && (row.as_of === null || time(row.as_of)), "position.fields");
  }
  const news = record(v.news, ["checked_at", "status", "items"], "news");
  check(time(news.checked_at) && ["LIVE", "DATA_BLOCKED"].includes(String(news.status)) && Array.isArray(news.items) && news.items.length <= 100, "news.fields");
  for (const value of news.items) {
    const row = record(value, ["id", "headline", "url", "source", "published_at", "expires_at", "verified", "market_moving", "symbols"], "news.item");
    check(["id", "headline", "url", "source"].every((key) => text(row[key])) && time(row.published_at) && (row.expires_at === null || time(row.expires_at)) && typeof row.verified === "boolean" && typeof row.market_moving === "boolean" && strings(row.symbols), "news.item.fields");
    check(new URL(row.url as string).protocol === "https:", "news.source-url");
  }
  const risk = record(v.global_risk, ["checked_at", "critical_blockers", "new_entry_blockers"], "risk");
  check(time(risk.checked_at) && strings(risk.critical_blockers) && strings(risk.new_entry_blockers), "risk.fields");
  return v as unknown as StockPlanEvidence;
}

export function validateStockManualPlanOutput(value: unknown): StockManualPlanOutput {
  const v = record(value, ["contract_version", "component", "mode", "source_mode", "automated_execution", "run_id", "slot_id", "observed_at", "evidence", "decisions", "status", "blocked_reasons"], "output");
  check(version(v.contract_version) && v.component === "STOCK_MANUAL_PLAN" && v.mode === "SHADOW" && v.source_mode === "LIVE" && v.automated_execution === false, "output.boundary");
  const evidence = validateStockPlanEvidence(v.evidence);
  check(v.contract_version === evidence.contract_version && v.run_id === evidence.run_id && v.slot_id === evidence.slot_id && time(v.observed_at) && Date.parse(v.observed_at) >= Date.parse(evidence.received_at), "output.identity");
  check(Array.isArray(v.decisions) && v.decisions.length <= 2 && (v.contract_version === "stock-plan-v2" ? ["APPROVED", "CONDITIONAL", "NO_TRADE", "DATA_BLOCKED"] : ["APPROVED", "NO_TRADE", "DATA_BLOCKED"]).includes(String(v.status)) && strings(v.blocked_reasons), "output.fields");
  v.decisions.forEach((decision) => check(validateStockPlanDecision(decision).contract_version === v.contract_version, "output.decision-version"));
  return v as unknown as StockManualPlanOutput;
}

type ClosedBar = { begins_at: string; open: number; high: number; low: number; close: number; volume: number };
export function stockPlanStructure(evidence: Pick<StockPlanEvidence, "contract_version" | "entry_rule" | "received_at" | "direction" | "bars" | "planning_context"> & { pattern: Pick<NonNullable<StockPlanEvidence["pattern"]>, "regime" | "direction"> | null }) {
  const gaps: string[] = [], received = Date.parse(evidence.received_at), day = exchangeDateKey(received);
  const early = evidence.contract_version === "stock-plan-v2" && evidence.entry_rule === "MULTI_TIMEFRAME_BREAK_HOLD_V1";
  const pattern = evidence.pattern;
  if (!pattern || pattern.regime === "UNKNOWN") return { eligible: false, gaps: ["个股原A2盘型未确认，禁止新开仓"], break_level: null, invalidation_price: null };
  if (pattern.regime === "WIDE_CHOP") return { eligible: false, gaps: ["个股原A2判定为大幅纯震荡，禁止新开仓"], break_level: null, invalidation_price: null };
  // Match the existing risk regime map; TRANSITION/NARROW_RANGE traits are not a hard direction.
  const regimeDirection = STOCK_PATTERN_DIRECTIONS[pattern.regime];
  if (regimeDirection && regimeDirection !== evidence.direction) return { eligible: false, gaps: ["个股原A2已确认盘型与拟开仓方向冲突"], break_level: null, invalidation_price: null };
  const bars = evidence.bars.values;
  const valid = bars.length >= (early ? 5 : 18) && (!early || Date.parse(bars[0].begins_at) === utcForPt(day, "06:30").getTime()) && bars.every((bar, index) => {
    const start = Date.parse(bar.begins_at);
    return [bar.open, bar.high, bar.low, bar.close].every(positive) && finite(bar.volume) && bar.volume >= 0
      && bar.low! <= Math.min(bar.open!, bar.close!) && bar.high! >= Math.max(bar.open!, bar.close!)
      && start % 300_000 === 0 && start + 330_000 <= received
      && exchangeDateKey(start) === day && robinhoodSessionAt(start).phase === "REGULAR"
      && (!index || start - Date.parse(bars[index - 1].begins_at) === 300_000);
  });
  if (!valid) return { eligible: false, gaps: [early ? "个股开盘确认缺少至少5根从正常开盘起连续、完整且收盘30秒后的5分钟K线" : "个股缺少完整、同日连续且收盘30秒后的5分钟K线"], break_level: null, invalidation_price: null };
  const closed = bars as ClosedBar[];
  if (early) {
    const context = evidence.planning_context, bullish = evidence.direction === "BULLISH";
    const [setup, breakout, hold] = closed.slice(-3), level = context?.entry_trigger, pivot = context?.invalidation_price;
    if (!context || !positive(level) || !positive(pivot) || !positive(context.target_price)
      || !(bullish ? pivot < level && level < context.target_price : context.target_price < level && level < pivot)) return { eligible: false, gaps: ["个股开盘确认缺少方向一致的冻结触发、失效和目标"], break_level: null, invalidation_price: null };
    const frames = Object.values(context.timeframes), observed = Date.parse(context.observed_at);
    if (!Number.isFinite(observed) || observed > received || frames.some((frame) => {
      const cutoff = Date.parse(frame.data_cutoff ?? ""), duration = frame.timeframe === "4h" ? 14_400_000 : frame.timeframe === "1h" ? 3_600_000 : 1_800_000;
      return !frame.available || frame.direction !== evidence.direction || !positive(frame.support) || !positive(frame.resistance) || frame.support >= frame.resistance
        || !Number.isFinite(cutoff) || (frame.timeframe === "1d" ? frame.data_cutoff!.slice(0, 10) >= exchangeDateKey(observed) : cutoff + duration > observed);
    })) gaps.push("个股开盘确认要求日线、4小时、1小时和30分钟完整结构全部同向且已收盘");
    const fourHour = context.timeframes.four_hour;
    if (level !== (bullish ? fourHour.resistance : fourHour.support) || Date.parse(fourHour.data_cutoff ?? "") + 14_400_000 > Date.parse(breakout.begins_at)) gaps.push("开盘触发位未绑定突破前已完成的冻结4小时支撑/阻力");
    if (pattern.direction !== (bullish ? "bullish" : "bearish")) gaps.push("个股原A2方向未与开盘确认方向一致");
    if (!(bullish ? setup.high <= level && breakout.open <= level && breakout.close > level && hold.low >= level && hold.close >= level
      : setup.low >= level && breakout.open >= level && breakout.close < level && hold.high <= level && hold.close <= level)) gaps.push("尚无固定冻结位的当日5分钟突破及下一根保持，跳空不算开盘确认");
    if (Date.parse(evidence.bars.as_of ?? "") !== Date.parse(hold.begins_at) + 300_000) gaps.push("个股Bar源时间未绑定最后完整K线收盘");
    return { eligible: gaps.length === 0, gaps, break_level: level, invalidation_price: pivot };
  }
  // Same 15m/30m structure and break-next-bar-hold arithmetic as the existing A2 policy.
  // This stock-only proof cannot modify, impersonate or qualify the index TS contract.
  const aggregate = (minutes: number) => {
    const groups = new Map<number, ClosedBar[]>();
    for (const bar of closed) { const bucket = Math.floor(Date.parse(bar.begins_at) / (minutes * 60_000)); const rows = groups.get(bucket) ?? []; rows.push(bar); groups.set(bucket, rows); }
    return [...groups.values()].filter((rows) => rows.length === minutes / 5).map((rows) => ({
      open: rows[0].open, close: rows.at(-1)!.close, high: Math.max(...rows.map((row) => row.high)), low: Math.min(...rows.map((row) => row.low)),
    }));
  };
  const bullish = evidence.direction === "BULLISH", fifteen = aggregate(15), thirty = aggregate(30);
  for (const [name, rows] of [["15分钟", fifteen], ["30分钟", thirty]] as const) {
    const recent = rows.slice(-3), first = recent[0], last = recent.at(-1);
    if (recent.length !== 3 || !last || !(bullish ? last.close > first.close && last.high > first.high && last.low > first.low : last.close < first.close && last.high < first.high && last.low < first.low)) gaps.push(`${name}完整结构未与个股方向一致`);
  }
  let pivot: number | null = null;
  for (let i = fifteen.length - 2; i > 0; i--) {
    if (bullish ? fifteen[i].low <= fifteen[i - 1].low && fifteen[i].low < fifteen[i + 1].low : fifteen[i].high >= fifteen[i - 1].high && fifteen[i].high > fifteen[i + 1].high) {
      pivot = bullish ? fifteen[i].low : fifteen[i].high; break;
    }
  }
  if (pivot === null || (bullish ? fifteen.at(-1)!.close < pivot : fifteen.at(-1)!.close > pivot)) gaps.push("15分钟已确认摆动支撑/阻力缺失或失效");
  const [setup, breakout, hold] = closed.slice(-3), level = bullish ? setup.high : setup.low;
  if (!(bullish ? breakout.open <= level && breakout.close > level && hold.low >= level && hold.close >= level : breakout.open >= level && breakout.close < level && hold.high <= level && hold.close <= level)) gaps.push("尚无个股5分钟突破后下一根保持的真实确认");
  if (Date.parse(evidence.bars.as_of ?? "") !== Date.parse(hold.begins_at) + 300_000) gaps.push("个股Bar源时间未绑定最后完整K线收盘");
  return { eligible: gaps.length === 0, gaps, break_level: level, invalidation_price: pivot };
}

function verifiedNewsAt(evidence: StockPlanEvidence, now: number) {
  return evidence.news.items.filter((item) => item.verified && time(item.expires_at) && Date.parse(item.expires_at) > now && Date.parse(item.published_at) <= Date.parse(evidence.received_at) && (item.symbols.includes(evidence.symbol) || item.market_moving));
}

export function stockOptionGaps(e: Pick<StockPlanEvidence, "symbol" | "contract_version" | "received_at">, contract: StockPlanEvidence["contracts"][number], now: number) {
  const gaps: string[] = [], instrument = contract.instrument;
  if (!text(instrument.chain_id) || instrument.chain_symbol !== e.symbol || instrument.expiration_date !== contract.expiration || instrument.strike_price !== contract.strike || instrument.type !== contract.option_type || instrument.state !== "active" || instrument.tradability !== "tradable" || instrument.trade_value_multiplier !== 100) gaps.push("官方期权身份、可交易状态或标准100倍合约乘数未证实");
  const dte = expiryDate(contract.expiration) ? (Date.parse(contract.expiration) - Date.parse(exchangeDateKey(now))) / 86_400_000 : NaN;
  if (!Number.isInteger(dte) || dte < 0 || e.contract_version === "stock-plan-v1" && dte > 15) gaps.push(e.contract_version === "stock-plan-v1" ? "个股期权到期不在原规则0至15天内" : "真实合约到期日期无效或已过期");
  const complete = positive(contract.bid) && positive(contract.ask) && contract.ask >= contract.bid && positive(contract.open_interest) && finite(contract.volume) && contract.volume >= 0 && positive(contract.iv) && [contract.delta, contract.gamma, contract.theta, contract.vega].every(finite);
  if (!complete || !fresh(contract.as_of, now, 420) || Date.parse(contract.as_of ?? "") > Date.parse(e.received_at)) gaps.push("精确期权报价、成交量、持仓量或Greeks未核验/过期");
  if (positive(contract.bid) && positive(contract.ask)) {
    const spread = contract.ask - contract.bid;
    if (spread > 0.15 + 1e-12 || spread / ((contract.ask + contract.bid) / 2) * 100 > 5 + 1e-12) gaps.push("期权买卖价差超过原5%或0.15美元上限");
  }
  return gaps;
}

function stockPlanGaps(value: StockPlanEvidence, now: number, entry: boolean): string[] {
  let evidence: StockPlanEvidence;
  try { evidence = validateStockPlanEvidence(value); } catch (error) { return [error instanceof Error ? error.message : "个股证据合同无效"]; }
  const gaps = [...evidence.data_gaps];
  if (!Number.isFinite(now) || robinhoodSessionAt(now).phase !== "REGULAR") return [...gaps, "当前不是个股期权正常交易时段"];
  const received = Date.parse(evidence.received_at), day = exchangeDateKey(now), quote = evidence.quote;
  if (exchangeDateKey(evidence.observed_at) !== day || !fresh(evidence.observed_at, now, 420) || !fresh(evidence.received_at, now, 420)) gaps.push("个股冻结证据不属于当前交易日或已过期");
  const sourceTimes = [quote.as_of, evidence.account.as_of, evidence.news.checked_at, evidence.global_risk.checked_at, ...(entry ? [evidence.bars.as_of] : [])];
  if (sourceTimes.some((at) => !time(at) || Date.parse(at) > received)) gaps.push("来源时间缺失或晚于真实接收时间");
  if (quote.status !== "LIVE" || !positive(quote.last) || !positive(quote.bid) || !positive(quote.ask) || quote.ask < quote.bid || !fresh(quote.as_of, now, MARKET_5M_MAX_AGE_SECONDS)) gaps.push("该个股当前官方报价无效或超过420秒");
  if (entry) {
    if (!fresh(evidence.bars.as_of, now, MARKET_5M_MAX_AGE_SECONDS)) gaps.push("该个股完整Bar超过420秒");
    const structure = stockPlanStructure(evidence);
    gaps.push(...structure.gaps, ...evidence.setup_gaps ?? []);
    if (positive(quote.last) && structure.break_level !== null && (evidence.direction === "BULLISH" ? quote.last < structure.break_level : quote.last > structure.break_level)) gaps.push("当前个股报价已失去刚确认的突破保持位置");
  }
  if (evidence.contract_version === "stock-plan-v2") {
    const context = evidence.planning_context;
    if (!context || !fresh(context.observed_at, now, 420) || !context.why_watch.length || !Object.values(context.timeframes).some((frame) => frame.available)) gaps.push("缺少当前已冻结的个股多周期观察依据");
    if (!context || !positive(context.entry_trigger) || !positive(context.invalidation_price) || !positive(context.target_price) || !(evidence.direction === "BULLISH" ? context.invalidation_price < context.entry_trigger && context.entry_trigger < context.target_price : context.target_price < context.entry_trigger && context.entry_trigger < context.invalidation_price)) gaps.push("冻结观察未给出方向一致的触发、失效和目标价格");
    if (context && positive(context.invalidation_price) && positive(quote.last) && (evidence.direction === "BULLISH" ? quote.last <= context.invalidation_price : quote.last >= context.invalidation_price)) gaps.push("真实现价已达到原观察失效价，不能沿用该预案");
    if (!evidence.contracts.some((contract) => contract.option_type === (evidence.direction === "BULLISH" ? "call" : "put") && !stockOptionGaps(evidence, contract, now).length)) gaps.push("没有当前可核验的真实同方向期权合约，不能生成完整预案");
    if (evidence.bars.values.some((bar, index, bars) => ![bar.open, bar.high, bar.low, bar.close].every(positive) || !finite(bar.volume) || bar.volume < 0 || bar.low! > Math.min(bar.open!, bar.close!) || bar.high! < Math.max(bar.open!, bar.close!) || Date.parse(bar.begins_at) % 300_000 !== 0 || Date.parse(bar.begins_at) + 330_000 > received || index > 0 && Date.parse(bar.begins_at) <= Date.parse(bars[index - 1].begins_at))) gaps.push("已提供的个股K线数值、顺序或收盘时间无效，不能视为只是等待触发");
  } else if (!entry) gaps.push("旧版证据不能转换成新版条件预案");
  const account = evidence.account;
  if (account.status !== "LIVE" || !fresh(account.as_of, now, 120) || !Array.isArray(account.positions) || !positive(account.account_count) || !Number.isInteger(account.account_count)) gaps.push("当前完整只读账户未在120秒内核验");
  if (account.positions?.some((position) => !text(position.contract_id) || !text(position.symbol) || !positive(position.quantity) || !Number.isInteger(position.quantity) || !positive(position.average_price) || !positive(position.strike) || !expiryDate(position.expiration) || !position.option_type || !position.direction)) gaps.push("真实持仓身份、数量或累计成本存在未知，不能跳过账户风险");
  const positionKeys = account.positions?.map((position) => `${position.account_label}:${position.contract_id}`) ?? [];
  if (new Set(positionKeys).size !== positionKeys.length) gaps.push("账户持仓身份重复，不能安全核算仓位与累计成本");
  if (!fresh(evidence.global_risk.checked_at, now, 420) || evidence.global_risk.critical_blockers.length || evidence.global_risk.new_entry_blockers.length) gaps.push(...evidence.global_risk.critical_blockers, ...evidence.global_risk.new_entry_blockers, "当前全局安全/新开仓阻断未通过");
  const verifiedNews = verifiedNewsAt(evidence, now);
  if (evidence.news.status !== "LIVE" || !fresh(evidence.news.checked_at, now, 420)) gaps.push("当前新闻读取或来源时间未通过");
  if (entry && !verifiedNews.length) gaps.push("没有仍在有效期内的已核验公司或大盘新闻依据");
  if (entry && formatPtTime(now) >= "10:30" && !verifiedNews.some((item) => item.market_moving && exchangeDateKey(item.published_at) === day)) gaps.push("10:30后没有同日已核验重大市场新闻，不开新仓");
  return [...new Set(gaps)];
}

export const stockPlanEvidenceGaps = (value: StockPlanEvidence, now: number): string[] => stockPlanGaps(value, now, true);
export const stockPlanAnalysisGaps = (value: StockPlanEvidence, now: number): string[] => stockPlanGaps(value, now, false);

export function stockPlanCurrentGaps(evidence: StockPlanEvidence, snapshot: Pick<SnapshotState, "dataSources" | "selfCheck" | "outputs">, now: number) {
  const newer = (at: string | null | undefined) => Date.parse(at ?? "") >= Date.parse(evidence.received_at) && Date.parse(at ?? "") <= now;
  // Robinhood NOT_VERIFIED also describes index-only quote failures, not a failed stock authorization.
  const gaps = (snapshot.dataSources ?? []).filter((source) => newer(source.checked_at) && (source.source === "ROBINHOOD" ? ["EXPIRED", "NOT_CONFIGURED"].includes(source.authorization) : source.source === "FINNHUB" && source.authorization !== "VALID")).map((source) => `${source.source}最新授权未通过，原个股计划不再可用`);
  const trustCodes = ["SQLITE_READ_WRITE_FAILED", "UTC_STORAGE_MISALIGNED", "DEPLOYMENT_VERSION_UNKNOWN", "DEPLOYMENT_VERSION_DRIFT"];
  for (const incident of snapshot.selfCheck?.active ?? []) if (incident.status === "ACTIVE" && incident.details?.evidence_scope !== "HISTORICAL" && trustCodes.includes(incident.code) && newer(incident.last_seen_at)) gaps.push(`当前全局信任检查失败：${incident.title}`);
  const account = snapshot.outputs.SCHEDULE_CHECKPOINT.find((row) => row.kind === "POSITION_MONITOR" && row.slot_id.startsWith("timeline:position_monitor:"));
  if (account && newer(account.completed_at) && (account.status !== "SUCCEEDED" || account.position_check?.account_status !== "LIVE" || !account.position_check.checks_completed)) gaps.push("后续账户检查未通过，不能沿用原个股开仓计划");
  return gaps;
}

export type StockPlanProgress = {
  symbol: string; direction: StockPlanEvidence["direction"]; observed_at: string; evidence_id: string;
  stage: "WAITING" | "DECLINED" | "OWNER_REVIEW" | "EXPIRED"; executable: false;
  quote_current: boolean; quote_as_of: string | null; last: number | null;
  break_level: number | null; invalidation_price: number | null; structure_confirmed: boolean;
  review_count: number; reasons: string[]; news: StockPlanEvidence["news"]["items"];
};

export type StockConditionalPlan = {
  plan_id: string; symbol: string; contract_id: string; option_type: "call" | "put"; expiration: string; strike: number;
  quantity: 1; max_debit_usd: number; reference_price: number; entry_trigger_price: number; invalidation_price: number; target_price: number;
  stop_loss_pct: number; take_profit_pct: number; holding_period: string; contract_selection_reason: string;
  reasons: string[]; entry_conditions: string[]; invalidation: string[]; pending_conditions: string[];
  observed_at: string; valid_until: string; source_ref: string; approval_ref: string;
  automated_execution: false; owner_confirmation_required: true; stage: "WAITING_TRIGGER" | "EXPIRED";
};

// Both kinds use the same contract, independent-review and money checks. A pre-plan is never an entry approval.
function projectStockPlans(outputs: StockManualPlanOutput[], currentTime: number, conditional: boolean) {
  const plans: OwnerManualPlan[] = [], blocked_reasons: string[] = [], seen = new Set<string>();
  const conditional_plans: StockConditionalPlan[] = [];
  let validated: StockManualPlanOutput[];
  try { validated = outputs.slice(0, 100).map(validateStockManualPlanOutput).toSorted((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at)); }
  catch (error) { return { plans: [], conditional_plans, blocked_reasons: [error instanceof Error ? error.message : "个股计划合同无效"], progress: [] }; }
  const latestRun = validated[0]?.run_id, capacities = new Map<string, { newPosition: boolean; remaining: number }>();
  for (const output of validated.filter((row) => row.run_id === latestRun)) {
    const e = output.evidence;
    // One latest immutable output per stock; a newer refusal must not resurrect an older approval.
    if (seen.has(e.symbol)) continue;
    seen.add(e.symbol);
    if (conditional && (output.contract_version !== "stock-plan-v2" || output.status !== "CONDITIONAL")) continue;
    // Expired pre-plans remain identifiable for review, with their original price and source time.
    const now = conditional ? Date.parse(output.observed_at) : currentTime;
    const gaps = conditional ? stockPlanAnalysisGaps(e, now) : stockPlanEvidenceGaps(e, now), d = output.decisions.find((row) => row.role === "D"), a3 = output.decisions.find((row) => row.role === "A3");
    if (!Number.isFinite(currentTime) || now > currentTime) gaps.push("计划时间无效或来自未来");
    if (!conditional && (output.status !== "APPROVED" || output.blocked_reasons.length)) gaps.push(...output.blocked_reasons, "个股尚未形成完整批准");
    const action = conditional ? "CONDITIONAL_PLAN" : "MANUAL_BUY";
    if (!d || !a3 || d.action !== action || a3.action !== action) gaps.push("缺少真实独立D与A3的同类计划复核");
    if (d && a3) {
      if (d.invocation_id === a3.invocation_id || d.decision_id === a3.decision_id || d.evidence_id !== e.evidence_id || a3.evidence_id !== e.evidence_id) gaps.push("D/A3不是独立调用或未绑定同一冻结证据");
      if (![d, a3].every((row) => fresh(row.observed_at, now, 420) && Date.parse(row.observed_at) >= Date.parse(e.received_at) && Date.parse(row.observed_at) <= Date.parse(output.observed_at)) || Date.parse(a3.observed_at) < Date.parse(d.observed_at) || !fresh(output.observed_at, now, 420)) gaps.push("审批时间过期、来自未来或先于真实证据");
      if (!["symbol", "contract_id", "option_type", "expiration", "strike", "quantity"].every((key) => d[key as keyof StockPlanDecision] === a3[key as keyof StockPlanDecision]) || d.symbol !== e.symbol || d.option_type !== (e.direction === "BULLISH" ? "call" : "put")) gaps.push("D/A3未批准同一只个股、方向和精确合约");
      if (e.contract_version === "stock-plan-v2" && ![d, a3].every((row) => positive(row.entry_trigger_price) && positive(row.invalidation_price) && row.entry_trigger_price === e.planning_context?.entry_trigger && row.invalidation_price === e.planning_context?.invalidation_price && row.target_price === e.planning_context?.target_price && text(row.holding_period) && text(row.contract_selection_reason))) gaps.push("两次复核未绑定冻结触发、失效、目标或未解释期限选择");
      if (![d, a3].every((row) => Number.isInteger(row.score) && row.score >= 9 && row.score <= 10 && row.quantity === 1 && row.max_entry_debit > 0 && row.max_entry_debit <= 1_000 && row.stop_loss_pct >= -50 && row.stop_loss_pct <= -30 && row.take_profit_pct >= 30 && row.take_profit_pct <= 70 && row.entry_conditions.length > 0 && row.invalidation.length > 0 && positive(row.target_price) && (e.direction === "BULLISH" ? row.target_price > e.quote.last! : row.target_price < e.quote.last!))) gaps.push("批准评分、数量、预算、原止损止盈、目标或触发失效条件不合规");
      const contract = e.contracts.find((row) => row.contract_id === d.contract_id);
      if (!contract || contract.expiration !== d.expiration || contract.strike !== d.strike || contract.option_type !== d.option_type) gaps.push("批准合约不在该个股真实冻结期权链内");
      if (contract) {
        gaps.push(...stockOptionGaps(e, contract, now));
        if (positive(contract.bid) && positive(contract.ask)) {
          const cost = Number((contract.ask * 100).toFixed(2));
          if (cost > Math.min(d.max_entry_debit, a3.max_entry_debit)) gaps.push("一张合约真实Ask成本超过批准预算");
          const positions = e.account.positions ?? [], matching = positions.filter((row) => row.contract_id === contract.contract_id);
          if (matching.some((row) => row.direction !== "long" || row.symbol !== e.symbol || row.option_type !== contract.option_type || row.expiration !== contract.expiration || row.strike !== contract.strike)) gaps.push("原持仓方向或合约身份与新方案冲突");
          if (!matching.length && positions.length >= 3) gaps.push("已达到原最多3笔持仓上限");
          const prior = matching.reduce((sum, row) => sum + row.quantity! * row.average_price! * 100, 0);
          if (prior + Math.min(d.max_entry_debit, a3.max_entry_debit) > 1_000) gaps.push("本仓加上批准新预算后累计超过1000美元");
        }
      }
      if (!gaps.length && contract && positive(contract.ask)) {
        const day = exchangeDateKey(now), minutes = nyseClosePtMinutes(day), sessionEnd = utcForPt(day, `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`).getTime();
        const news = verifiedNewsAt(e, now), entryEnd = conditional || news.some((item) => item.market_moving && exchangeDateKey(item.published_at) === day) ? sessionEnd : utcForPt(day, "10:30").getTime();
        const until = Math.min(Date.parse(e.account.as_of!) + 120_000, ...[e.observed_at, e.received_at, e.quote.as_of!, e.news.checked_at, e.global_risk.checked_at, contract.as_of!, d.observed_at, a3.observed_at, ...(!conditional ? [e.bars.as_of!] : []), ...(e.planning_context ? [e.planning_context.observed_at] : [])].map((at) => Date.parse(at) + 420_000), ...news.map((item) => Date.parse(item.expires_at!)), entryEnd, sessionEnd);
        if (conditional) {
          conditional_plans.push({ plan_id: `stock-conditional:${e.evidence_id}:${a3.decision_id}`, symbol: e.symbol, contract_id: contract.contract_id, option_type: contract.option_type, expiration: contract.expiration, strike: contract.strike, quantity: 1,
            reference_price: contract.ask, max_debit_usd: Math.min(d.max_entry_debit, a3.max_entry_debit), entry_trigger_price: a3.entry_trigger_price!, invalidation_price: a3.invalidation_price!, target_price: a3.target_price,
            stop_loss_pct: a3.stop_loss_pct, take_profit_pct: a3.take_profit_pct, holding_period: a3.holding_period!, contract_selection_reason: a3.contract_selection_reason!,
            reasons: [...new Set([...d.reasons, ...a3.reasons])], entry_conditions: [...new Set([...d.entry_conditions, ...a3.entry_conditions])], invalidation: [...new Set([...d.invalidation, ...a3.invalidation])],
            pending_conditions: [...new Set([...stockPlanEvidenceGaps(e, now), ...output.blocked_reasons, "必须用新证据重新复核；条件预案不能直接执行，也不会自动转为买入批准"])],
            observed_at: output.observed_at, valid_until: new Date(until).toISOString(), source_ref: e.evidence_id, approval_ref: `${d.decision_id}|${a3.decision_id}`, automated_execution: false, owner_confirmation_required: true,
            stage: currentTime >= until || robinhoodSessionAt(currentTime).phase !== "REGULAR" ? "EXPIRED" : "WAITING_TRIGGER" });
          capacities.set(conditional_plans.at(-1)!.plan_id, { newPosition: !e.account.positions!.some((row) => row.contract_id === contract.contract_id), remaining: Math.max(0, 3 - e.account.positions!.length) });
          continue;
        }
        plans.push({ plan_id: `stock-manual:${e.evidence_id}:${a3.decision_id}`, side: "BUY_TO_OPEN", holding_id: null, symbol: e.symbol, contract_id: contract.contract_id, option_type: contract.option_type, expiration: contract.expiration, strike: contract.strike,
          quantity: 1, quantity_basis: "APPROVED", reference_price: contract.ask, max_debit_usd: Math.min(d.max_entry_debit, a3.max_entry_debit), trigger: [...new Set([...d.entry_conditions, ...a3.entry_conditions])].join("；"), trigger_state: "OWNER_CHECK_REQUIRED",
          stop_loss_pct: a3.stop_loss_pct, take_profit_pct: a3.take_profit_pct, first_target: `${e.symbol} ${a3.target_price.toFixed(2)}（标的目标，不是期权卖价或保证收益）`, holding_period: a3.holding_period || `合约${contract.expiration}到期；按触发、失效和原批准止盈止损复核，不保证持有至到期`,
          invalidation: [...new Set([...d.invalidation, ...a3.invalidation, "仍须你核对当前价格、数量和触发；计划不代表已触发或已成交", "报价/账户过期、收盘或证据变化后失效；跳空可能损失全部权利金"])], valid_until: new Date(until).toISOString(), source_ref: e.evidence_id, approval_ref: `${d.decision_id}|${a3.decision_id}`, automated_execution: false, owner_confirmation_required: true });
        capacities.set(plans.at(-1)!.plan_id, { newPosition: !e.account.positions!.some((row) => row.contract_id === contract.contract_id), remaining: Math.max(0, 3 - e.account.positions!.length) });
      }
    }
    blocked_reasons.push(...[...new Set(gaps)].map((gap) => `${e.symbol}：${gap}`));
  }
  const remaining = Math.min(3, ...[...capacities.values()].map((row) => row.remaining));
  let proposed = 0;
  const withinCapacity = (plan: OwnerManualPlan | StockConditionalPlan) => {
    if (!capacities.get(plan.plan_id)!.newPosition || proposed < remaining) { if (capacities.get(plan.plan_id)!.newPosition) proposed++; return true; }
    blocked_reasons.push(`${plan.symbol}：同时展示的新仓计划合计不能超过原3笔持仓上限`); return false;
  };
  const capped = plans.filter(withinCapacity), conditionalCapped = conditional_plans.filter(withinCapacity).slice(0, 3);
  const now = currentTime;
  // Display the latest real attempt even when it was refused; this projection never creates an approval.
  const progress: StockPlanProgress[] = [...seen].slice(0, 3).map((symbol) => {
    const output = validated.find((row) => row.run_id === latestRun && row.evidence.symbol === symbol)!;
    const e = output.evidence, structure = stockPlanStructure(e);
    const current = Number.isFinite(now) && robinhoodSessionAt(now).phase === "REGULAR" && fresh(e.received_at, now, 420) && fresh(output.observed_at, now, 420);
    const approved = capped.some((plan) => plan.symbol === symbol);
    const verified = new Set(verifiedNewsAt(e, now).map((item) => item.id));
    return {
      symbol, direction: e.direction, observed_at: output.observed_at, evidence_id: e.evidence_id,
      stage: !current ? "EXPIRED" : approved ? "OWNER_REVIEW" : output.status === "NO_TRADE" ? "DECLINED" : "WAITING", executable: false,
      quote_current: current && e.quote.status === "LIVE" && positive(e.quote.last) && positive(e.quote.bid) && positive(e.quote.ask) && e.quote.ask >= e.quote.bid && fresh(e.quote.as_of, now, 420), quote_as_of: e.quote.as_of, last: e.quote.last,
      break_level: structure.break_level, invalidation_price: structure.invalidation_price, structure_confirmed: current && structure.eligible,
      review_count: new Set(output.decisions.filter((row) => row.evidence_id === e.evidence_id).map((row) => row.role)).size,
      reasons: [...new Set([...blocked_reasons.filter((reason) => reason.startsWith(`${symbol}：`)).map((reason) => reason.slice(symbol.length + 1)), ...output.decisions.flatMap((row) => row.reasons)])],
      news: e.news.items.filter((item) => item.symbols.includes(symbol) || item.market_moving).slice(0, 3).map((item) => ({ ...item, verified: verified.has(item.id) })),
    };
  });
  return { plans: capped, conditional_plans: conditionalCapped, blocked_reasons: [...new Set(blocked_reasons)], progress };
}

export function projectStockManualPlans(outputs: StockManualPlanOutput[], now: number): { plans: OwnerManualPlan[]; blocked_reasons: string[]; progress: StockPlanProgress[] } {
  const { plans, blocked_reasons, progress } = projectStockPlans(outputs, now, false);
  return { plans, blocked_reasons, progress };
}

export function projectStockConditionalPlans(outputs: StockManualPlanOutput[], now: number): { plans: StockConditionalPlan[]; blocked_reasons: string[] } {
  const { conditional_plans: plans, blocked_reasons } = projectStockPlans(outputs, now, true);
  return { plans, blocked_reasons };
}
