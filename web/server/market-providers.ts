import { createHash } from "node:crypto";
import { exchangeDateKey, isNyseRegularSession, latestCompletedNyseSession, MARKET_5M_MAX_AGE_SECONDS, nyseClosePtMinutes, robinhoodSessionAt, utcIso } from "../app/market-time.ts";
import type { MarketDataBar, MarketDataStatus, ReadonlyMarketSources } from "../app/snapshot-import.ts";
import { canonicalJson } from "./robinhood-mcp.ts";

export type TradierEnvironment = "production" | "sandbox";
export type MarketSymbol = "SPY" | "QQQ";
export type TradierMarketOptions = { token: string; environment: TradierEnvironment; request?: typeof fetch; timeoutMs?: number; freezeDeadlineAt?: string };
export type TradierBarsRequest = { symbol: MarketSymbol; interval: "5min" | "daily"; start: string; end: string };
export type TradierQuote = { source: "TRADIER"; symbol: MarketSymbol; last: number; bid: number | null; ask: number | null; previous_close: number | null; as_of: string; last_at: string; bid_at: string | null; ask_at: string | null };
const SYMBOLS: MarketSymbol[] = ["SPY", "QQQ"];
const HOSTS = { production: "https://api.tradier.com", sandbox: "https://sandbox.tradier.com" } as const;
const PATHS = new Set(["/v1/markets/quotes", "/v1/markets/timesales", "/v1/markets/history"]);

export class MarketProviderError extends Error {
  code: string;
  httpStatus: number | null;
  constructor(code: string, httpStatus: number | null = null) {
    super(`Tradier ${code}${httpStatus === null ? "" : ` (HTTP ${httpStatus})`}`);
    this.name = "MarketProviderError"; this.code = code; this.httpStatus = httpStatus;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MarketProviderError("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function rows(value: unknown) { return value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function number(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const result = Number(value); return Number.isFinite(result) ? result : null;
}
function price(value: unknown) { const result = number(value); return result !== null && result > 0 ? result : null; }
function epoch(value: unknown, scale: number) {
  const result = number(value);
  if (result === null || !Number.isSafeInteger(result) || result <= 0) throw new MarketProviderError("INVALID_TIMESTAMP");
  try { const iso = utcIso(result * scale); if (!/^\d{4}-/.test(iso)) throw new Error(); return iso; }
  catch { throw new MarketProviderError("INVALID_TIMESTAMP"); }
}
function dateOnly(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || utcIso(value).slice(0, 10) !== value) throw new MarketProviderError("INVALID_DATE");
  return value;
}
function rangeValue(value: string, interval: "5min" | "daily") {
  if (interval === "daily") return dateOnly(value);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14)) > 59) throw new MarketProviderError("INVALID_RANGE");
  dateOnly(value.slice(0, 10)); return value;
}
function ohlcv(raw: Record<string, unknown>) {
  const open = price(raw.open), high = price(raw.high), low = price(raw.low), close = price(raw.close), volume = number(raw.volume);
  if (open === null || high === null || low === null || close === null || volume === null || volume < 0 || !Number.isSafeInteger(volume) || low > Math.min(open, close) || high < Math.max(open, close) || low > high) throw new MarketProviderError("INVALID_OHLCV");
  return { open, high, low, close, volume };
}
function oldest(values: Array<string | null>) { return values.filter((value): value is string => value !== null).sort()[0] ?? null; }
function age(asOf: string | null, at: string) { return asOf === null ? null : Math.max(0, (Date.parse(at) - Date.parse(asOf)) / 1_000); }

/** Official GET market endpoints only. Tokens are injected by the caller, never read from a profile or environment. */
export function createTradierMarketProvider(options: TradierMarketOptions) {
  if (!Object.hasOwn(HOSTS, options.environment)) throw new MarketProviderError("INVALID_ENVIRONMENT");
  if (typeof options.token !== "string" || !options.token.trim() || /[\r\n]/.test(options.token)) throw new MarketProviderError("NOT_AUTHORIZED");
  const timeoutMs = options.timeoutMs ?? 10_000, deadline = options.freezeDeadlineAt === undefined ? null : Date.parse(options.freezeDeadlineAt);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000 || deadline !== null && !Number.isFinite(deadline)) throw new MarketProviderError("INVALID_DEADLINE");
  const request = options.request ?? fetch;
  async function read(path: string, params: Record<string, string>) {
    if (!PATHS.has(path)) throw new MarketProviderError("ENDPOINT_FORBIDDEN");
    const remaining = Math.min(timeoutMs, deadline === null ? timeoutMs : deadline - Date.now());
    if (remaining <= 0) throw new MarketProviderError("DEADLINE_EXCEEDED");
    const url = new URL(path, HOSTS[options.environment]);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MarketProviderError("DEADLINE_EXCEEDED")); }, remaining); });
    try {
      const response = await Promise.race([request(url, { method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${options.token.trim()}` }, redirect: "error", signal: controller.signal }), expired]);
      if (response.redirected) throw new MarketProviderError("REDIRECT_FORBIDDEN");
      if (!response.ok) throw new MarketProviderError(response.status === 401 || response.status === 403 ? "NOT_AUTHORIZED" : "HTTP_ERROR", response.status);
      const value: unknown = await Promise.race([response.json(), expired]);
      return object(value);
    } catch (error) {
      if (error instanceof MarketProviderError) throw error;
      // Provider bodies, thrown fetch messages and credentials are never reflected into logs or UI.
      throw new MarketProviderError(controller.signal.aborted ? "DEADLINE_EXCEEDED" : "REQUEST_FAILED");
    } finally { clearTimeout(timer!); }
  }
  return {
    source: "TRADIER" as const, environment: options.environment, delayed: options.environment === "sandbox",
    async readQuotes(): Promise<{ source: "TRADIER"; environment: TradierEnvironment; delayed: boolean; received_at: string; quotes: TradierQuote[] }> {
      const payload = await read("/v1/markets/quotes", { symbols: SYMBOLS.join(","), greeks: "false" });
      const seen = new Set<string>();
      const quotes = rows(object(payload.quotes).quote).map((value): TradierQuote => {
        const item = object(value), symbol = item.symbol;
        if ((symbol !== "SPY" && symbol !== "QQQ") || seen.has(symbol)) throw new MarketProviderError("INVALID_SYMBOLS");
        seen.add(symbol);
        const last = price(item.last), lastAt = epoch(item.trade_date, 1), bidValue = price(item.bid), askValue = price(item.ask);
        if (last === null) throw new MarketProviderError("INCOMPLETE_QUOTE");
        if (bidValue !== null && askValue !== null && bidValue > askValue) throw new MarketProviderError("CROSSED_QUOTE");
        const bidAt = bidValue === null || !item.bid_date ? null : epoch(item.bid_date, 1), askAt = askValue === null || !item.ask_date ? null : epoch(item.ask_date, 1);
        return { source: "TRADIER", symbol, last, bid: bidAt ? bidValue : null, ask: askAt ? askValue : null, previous_close: price(item.prevclose), as_of: oldest([lastAt, bidAt, askAt])!, last_at: lastAt, bid_at: bidAt, ask_at: askAt };
      });
      if (seen.size !== SYMBOLS.length) throw new MarketProviderError("INCOMPLETE_QUOTES");
      return { source: "TRADIER", environment: options.environment, delayed: options.environment === "sandbox", received_at: utcIso(Date.now()), quotes };
    },
    async readBars(input: TradierBarsRequest): Promise<{ source: "TRADIER"; environment: TradierEnvironment; delayed: boolean; received_at: string; date_semantics: "PROVIDER_EPOCH_START" | "EXCHANGE_SESSION_DATE_ONLY"; bars: MarketDataBar[] }> {
      if (!SYMBOLS.includes(input.symbol) || input.interval !== "5min" && input.interval !== "daily") throw new MarketProviderError("INVALID_BARS_REQUEST");
      const start = rangeValue(input.start, input.interval), end = rangeValue(input.end, input.interval);
      if (start > end) throw new MarketProviderError("INVALID_RANGE");
      const intraday = input.interval === "5min";
      const payload = await read(intraday ? "/v1/markets/timesales" : "/v1/markets/history", { symbol: input.symbol, interval: input.interval, start, end, ...(intraday ? { session_filter: "open" } : {}) });
      const values = rows(intraday ? object(payload.series).data : object(payload.history).day), seen = new Set<string>();
      if (values.length > 20_000) throw new MarketProviderError("RESPONSE_TOO_LARGE");
      const bars = values.map((value) => {
        const item = object(value), beginsAt = intraday ? epoch(item.timestamp, 1_000) : dateOnly(item.date);
        if (seen.has(beginsAt)) throw new MarketProviderError("DUPLICATE_BAR");
        seen.add(beginsAt); return { begins_at: beginsAt, ...ohlcv(item) };
      }).sort((a, b) => a.begins_at.localeCompare(b.begins_at));
      return { source: "TRADIER", environment: options.environment, delayed: options.environment === "sandbox", received_at: utcIso(Date.now()), date_semantics: intraday ? "PROVIDER_EPOCH_START" : "EXCHANGE_SESSION_DATE_ONLY", bars };
    },
  };
}

/** Market data only; missing options and account capabilities stay unavailable. No broker/model calls. */
export async function collectTradierReadonly(options: TradierMarketOptions, observedAt = utcIso(Date.now()), freezeDeadlineAt = options.freezeDeadlineAt): Promise<ReadonlyMarketSources> {
  const observed = utcIso(observedAt), clock = robinhoodSessionAt(observed), sessionDate = clock.phase === "REGULAR" ? exchangeDateKey(observed) : latestCompletedNyseSession(observed);
  const completedSession = latestCompletedNyseSession(observed), historyStart = utcIso(Date.parse(`${sessionDate}T00:00:00Z`) - 100 * 86_400_000).slice(0, 10);
  const closeMinutes = nyseClosePtMinutes(sessionDate) + 180, end = `${sessionDate} ${String(Math.floor(closeMinutes / 60)).padStart(2, "0")}:${String(closeMinutes % 60).padStart(2, "0")}`;
  const deadline = Math.min(Date.now() + (options.timeoutMs ?? 10_000), freezeDeadlineAt === undefined ? Infinity : Date.parse(freezeDeadlineAt));
  const environment = Object.hasOwn(HOSTS, options.environment) ? options.environment : "invalid";
  const errors: ReadonlyMarketSources["errors"] = [{ code: "PROVIDER_ENVIRONMENT", scope: "TRADIER", message: `TRADIER ${environment}; ${environment === "sandbox" ? "delayed sandbox data, never LIVE" : "official production host; authorization and freshness remain required"}` }, { code: "DAILY_DATE_ONLY", scope: "daily_bars", message: "Daily begins_at preserves the provider's exchange session date, not an observed quote timestamp." }, { code: "CAPABILITY_UNAVAILABLE", scope: "options", message: "Tradier options/IV/Greeks/history are not collected by this adapter; no execution qualification." }, { code: "ACCOUNT_NOT_CONNECTED", scope: "account", message: "A market-data token is not a broker account connection; no account or position data was requested." }];
  let provider: ReturnType<typeof createTradierMarketProvider> | null = null;
  try { provider = createTradierMarketProvider({ ...options, freezeDeadlineAt: utcIso(deadline) }); }
  catch (error) { errors.push({ code: error instanceof MarketProviderError ? error.code : "INVALID_CONFIGURATION", scope: "TRADIER", message: "Tradier configuration is incomplete or invalid; no request was made." }); }
  async function attempt<T>(scope: string, read: () => Promise<T>, fallback: T): Promise<T> {
    try { return await read(); }
    catch (error) { errors.push({ code: error instanceof MarketProviderError ? error.code : "REQUEST_FAILED", scope, message: error instanceof MarketProviderError ? error.message : "Tradier request failed" }); return fallback; }
  }
  const [quoteRead, barReads] = await Promise.all([
    provider ? attempt("quotes", () => provider!.readQuotes(), null) : null,
    Promise.all(SYMBOLS.map(async (symbol) => {
      const [five, daily] = await Promise.all([
        provider ? attempt(`${symbol}/5min`, () => provider!.readBars({ symbol, interval: "5min", start: `${sessionDate} 09:30`, end }), null) : null,
        provider ? attempt(`${symbol}/daily`, () => provider!.readBars({ symbol, interval: "daily", start: historyStart, end: sessionDate }), null) : null,
      ]);
      return { symbol, five, daily };
    })),
  ]);
  const checkedAt = freezeDeadlineAt === undefined ? observed : utcIso(Date.now()), checkedMs = Date.parse(checkedAt), sandbox = options.environment === "sandbox";
  const quotes: ReadonlyMarketSources["quotes"] = (quoteRead?.quotes ?? []).map((quote) => ({ source: "TRADIER", symbol: quote.symbol, status: "DATA_BLOCKED", as_of: quote.as_of, freshness_seconds: age(quote.as_of, checkedAt), last: quote.last, bid: quote.bid, ask: quote.ask, previous_close: quote.previous_close }));
  const bars: ReadonlyMarketSources["bars"] = barReads.map(({ symbol, five, daily: history }) => {
    const values = (five?.bars ?? []).filter((bar) => Date.parse(bar.begins_at) + 300_000 <= checkedMs && exchangeDateKey(bar.begins_at) === sessionDate && robinhoodSessionAt(bar.begins_at).phase === "REGULAR");
    // Date-only daily indices are never used as intraday receipt/freshness timestamps.
    const daily = (history?.bars ?? []).filter((bar) => bar.begins_at <= completedSession && isNyseRegularSession(bar.begins_at));
    const latest = values.at(-1), asOf = latest ? utcIso(Date.parse(latest.begins_at) + 300_000) : null;
    return { source: "TRADIER", symbol, interval: "5min", status: "DATA_BLOCKED", as_of: asOf, freshness_seconds: age(asOf, checkedAt), bar_count: values.length, daily_bar_count: daily.length, latest: latest ? { open: latest.open, high: latest.high, low: latest.low, close: latest.close, volume: latest.volume } : null, values, daily };
  });
  const capabilities = { quotes: !sandbox && quotes.length === 2 && quotes.every((quote) => quote.last !== null && quote.bid !== null && quote.ask !== null), intraday_bars: !sandbox && bars.every((bar) => bar.bar_count > 0), daily_bars: !sandbox && bars.every((bar) => bar.daily_bar_count >= 20 && bar.daily.at(-1)?.begins_at === completedSession), option_chain: false, option_bbo: false, option_iv: false, option_greeks: false };
  const asOf = oldest([...quotes.map((quote) => quote.as_of), ...bars.map((bar) => bar.as_of)]), freshness = age(asOf, checkedAt), complete = capabilities.quotes && capabilities.intraday_bars && capabilities.daily_bars;
  const future = [...(quoteRead?.quotes ?? []).flatMap((quote) => [quote.last_at, quote.bid_at, quote.ask_at]), ...bars.map((bar) => bar.as_of)].some((at) => at !== null && Date.parse(at) > checkedMs);
  const currentEod = [...quotes, ...bars].every((item) => item.as_of !== null && exchangeDateKey(item.as_of) === completedSession);
  const status: MarketDataStatus = sandbox || !complete || future ? "DATA_BLOCKED" : clock.phase === "REGULAR" ? freshness !== null && freshness <= MARKET_5M_MAX_AGE_SECONDS ? "LIVE" : "STALE" : currentEod ? "MARKET_CLOSED" : "STALE";
  if (sandbox) errors.push({ code: "SANDBOX_DELAYED_NOT_LIVE", scope: "market_data", message: "Sandbox data is delayed test evidence and is excluded from LIVE qualification." });
  if (future) errors.push({ code: "FUTURE_SOURCE_TIME", scope: "market_data", message: "Provider observation time is later than the collection freeze." });
  const snapshot: Omit<ReadonlyMarketSources, "snapshot_id" | "snapshot_hash"> = {
    contract_name: "TRADING_OS_MARKET_DATA", contract_version: "v1", mode: "SHADOW", generated_at: observed, status, as_of: asOf, freshness_seconds: freshness,
    market_session: { state: clock.phase === "REGULAR" ? "REGULAR" : "CLOSED", phase: clock.phase, timezone: "America/New_York", observed_at: observed, market_date: clock.trading_date, trading_date: clock.trading_date, source: "DERIVED_US_EQUITY_HOURS" },
    capabilities, errors, providers: [{ source: "TRADIER", status: errors.some((error) => error.code === "NOT_AUTHORIZED") ? "NOT_AUTHORIZED" : status, as_of: asOf, freshness_seconds: freshness, error: status === "LIVE" || status === "MARKET_CLOSED" ? null : "Tradier data is missing, stale, unauthorized or delayed sandbox evidence" }],
    quotes: quotes.map((quote) => ({ ...quote, status })), bars: bars.map((bar) => ({ ...bar, status })),
    options: SYMBOLS.map((symbol) => ({ source: "TRADIER", symbol, status: "DATA_BLOCKED", as_of: null, freshness_seconds: null, expiration_count: 0, expirations: [], nearest_expiration: null, contract_count: 0, bbo_count: 0, iv_count: 0, greeks_count: 0, contracts: [] })),
    account: { source: "ROBINHOOD", status: "NOT_AUTHORIZED", as_of: null, freshness_seconds: null, account_count: null, positions: null, orders: null, portfolio_value: null, option_value: null, realized_pnl: null }, discrepancies: [],
  };
  const snapshotHash = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  return { ...snapshot, snapshot_hash: snapshotHash, snapshot_id: `market-${snapshotHash.slice(0, 24)}` };
}
