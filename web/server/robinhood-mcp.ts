import { spawn } from "node:child_process";
import { assertPublicAutomation, publicProfile } from "./public-runtime.ts";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { APPROVED_CORE70, APPROVED_EXTRA_STOCKS, APPROVED_UNIVERSE, OWNER_WATCHLIST, MARKET_ENVIRONMENT_SYMBOLS, type ApprovedCapabilitySnapshot, type MarketDataStatus, type MarketEnvironment, type MarketEnvironmentQuote, type ReadonlyMarketSources, type SpxContractQuoteStatus, type SpxOptionContract, type SpxOptionQuote } from "../app/snapshot-import.ts";
import { inferNewsSymbols, type MarketEvent, type MarketIntelligenceState } from "../app/market-intelligence.ts";
import { exchangeDateKey, isNyseRegularSession, latestCompletedNyseSession, MARKET_5M_MAX_AGE_SECONDS, ptDateKey, robinhoodSessionAt, spxOptionSessionAt } from "../app/market-time.ts";
import { assessCapital, assessExecutableQuote, MAX_EXECUTABLE_RELATIVE_SPREAD_PCT, resolveSpxContractMultiplier } from "../app/spx-convexity-ledger.ts";
import type { OwnerCapitalContext } from "../app/investment-kernel.ts";
import { isPaperOptionExpiration, representativeOptionExpirations } from "./option-horizon.ts";

export const ROBINHOOD_MCP_SERVER = "robinhood-trading";
export const ROBINHOOD_READONLY_TOOLS = [
  "get_accounts",
  "get_equity_quotes",
  "get_equity_historicals",
  "get_option_chains",
  "get_option_instruments",
  "get_option_quotes",
  "get_option_historicals",
  "get_option_positions",
  "get_option_orders",
  "get_portfolio",
  "get_realized_pnl",
] as const;

type ToolDefinition = { name: string; description?: string | null; inputSchema: unknown; annotations?: unknown };
type ToolCallResponse = { content: unknown[]; structuredContent?: unknown; isError?: boolean | null };
export type McpSession = {
  listTools(): Promise<Record<string, ToolDefinition>>;
  call(tool: string, args: unknown): Promise<ToolCallResponse>;
};

export type RobinhoodTimingEvent = {
  event: string; at: string; monotonic_ms: number; spawn_pid?: number;
  request_id?: number; method?: string; tool?: string; duration_ms?: number;
  outcome?: "SUCCESS" | "REMOTE_ERROR" | "PROVIDER_ERROR" | "TIMEOUT" | "PROCESS_ERROR" | "PROCESS_EXIT" | "SESSION_CLOSED" | "INVALID_JSON";
  text_code_units?: number; deadline_at?: string; budget_ms?: number;
};
export type RobinhoodTimingObserver = (event: RobinhoodTimingEvent) => void;
function emitTiming(observer: RobinhoodTimingObserver | undefined, event: Omit<RobinhoodTimingEvent, "at" | "monotonic_ms">) {
  if (!observer) return;
  try { observer({ ...event, at: new Date().toISOString(), monotonic_ms: performance.now() }); } catch { /* Timing is best-effort and must not change collection. */ }
}

export type RobinhoodChartInterval = "1m" | "5m" | "15m";
export type RobinhoodChartRange = "1d" | "24h" | "rth" | "gth" | "5d";
export type RobinhoodChartData = {
  source: "ROBINHOOD";
  symbol: "SPY" | "QQQ";
  interval: RobinhoodChartInterval;
  range: RobinhoodChartRange;
  session_bounds: "OFFICIAL_24_5" | "REGULAR_ONLY_EOD_FALLBACK" | "NOT_OBSERVED";
  data_grade: "OFFICIAL_OHLCV" | "RECENT_OFFICIAL_EOD" | "READ_FAILED";
  session_dates: string[];
  status: "LIVE" | "MARKET_CLOSED" | "STALE" | "DATA_BLOCKED";
  as_of: string | null;
  freshness_seconds: number | null;
  quote_as_of: string | null;
  quote_freshness_seconds: number | null;
  bar_as_of: string | null;
  bar_freshness_seconds: number | null;
  gap_status: "SOURCE_GAP" | null;
  market_session: ReturnType<typeof robinhoodMarketSession>;
  current_price: number | null;
  bars: Array<{ begins_at: string; open: number; high: number; low: number; close: number; volume: number | null; session: "PREMARKET" | "REGULAR" | "AFTER_HOURS" | "OVERNIGHT"; trading_date: string; data_grade: "OFFICIAL_OHLCV" }>;
  error: string | null;
};

const FORBIDDEN_TOOL = /^(?:review|place|submit|cancel|replace|modify|update|create|delete|add|remove|follow|unfollow|exercise)_/i;

export class RobinhoodMcpError extends Error {
  constructor(message: string) { super(message); this.name = "RobinhoodMcpError"; }
}

export function assertRobinhoodReadonlyTool(tool: string, allowlist: readonly string[] = ROBINHOOD_READONLY_TOOLS) {
  if (!allowlist.includes(tool) || FORBIDDEN_TOOL.test(tool)) throw new RobinhoodMcpError(`Robinhood MCP tool is not read-only allowlisted: ${tool}`);
  return tool;
}

/** Current tools return an opaque cursor; older tools returned a URL. Never fetch that URL. */
export function robinhoodOptionCursor(next: unknown): string | undefined {
  if (typeof next !== "string" || /[^\x21-\x7e]/.test(next)) return undefined;
  let cursor = next;
  if (/^https?:\/\//i.test(next)) {
    try {
      const url = new URL(next);
      if (url.searchParams.getAll("cursor").length !== 1) return undefined;
      cursor = url.searchParams.get("cursor")!;
    } catch { return undefined; }
  }
  return /^[A-Za-z0-9+/_=-]{1,1024}$/.test(cursor) ? cursor : undefined;
}

export function resolveCodexExecutable(projectRoot: string) {
  const store = resolve(projectRoot, "node_modules", ".pnpm");
  const packageDirectory = readdirSync(store, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && /^@openai\+codex@.+-win32-x64$/.test(entry.name));
  if (!packageDirectory) throw new RobinhoodMcpError("Standalone Codex CLI is missing");
  return resolve(store, packageDirectory.name, "node_modules", "@openai", "codex", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
}

function safeError(value: unknown) {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:code|token|state|account(?:_number)?)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b\d{8,}\b/g, "[REDACTED_NUMBER]")
    .slice(0, 2_000);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown>[] : [];
}

function text(value: unknown) { return typeof value === "string" && value ? value : null; }
function number(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function nonnegative(value: unknown) { const parsed = number(value); return parsed !== null && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null; }
function optionPositionAveragePrice(value: unknown) { const amount = number(value); return amount === null ? null : amount / 100; }
function iso(value: unknown) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function freshness(asOf: string | null, observedAt: string) { return asOf ? Math.max(0, (Date.parse(observedAt) - Date.parse(asOf)) / 1_000) : null; }
function completedBarAt(beginsAt: string | null | undefined, minutes: number) { const start = beginsAt ? Date.parse(beginsAt) : NaN; return Number.isFinite(start) ? new Date(start + minutes * 60_000).toISOString() : null; }
function oldest(values: Array<string | null>) { return values.filter((value): value is string => value !== null).sort().at(0) ?? null; }
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

export function robinhoodMarketSession(observedAt: string): ReadonlyMarketSources["market_session"] {
  const session = robinhoodSessionAt(observedAt);
  return { state: session.phase === "REGULAR" ? "REGULAR" : "CLOSED", phase: session.phase, timezone: "America/New_York", observed_at: observedAt, market_date: session.trading_date, trading_date: session.trading_date, source: "DERIVED_US_EQUITY_HOURS" };
}

function currentEod(asOf: string | null, observedAt: string) { return asOf !== null && exchangeDateKey(asOf) === latestCompletedNyseSession(observedAt); }

function marketBar(value: Record<string, unknown>) {
  return { begins_at: iso(value.begins_at) ?? "", open: number(value.open_price), high: number(value.high_price), low: number(value.low_price), close: number(value.close_price), volume: number(value.volume) };
}

function completeMarketBars(values: Record<string, unknown>[]) {
  const unique = new Map<string, RobinhoodChartData["bars"][number]>();
  for (const value of values) {
    if (value.interpolated === true) continue;
    const bar = marketBar(value);
    if (bar.begins_at && bar.open !== null && bar.high !== null && bar.low !== null && bar.close !== null) {
      const session = robinhoodSessionAt(bar.begins_at);
      if (session.phase !== "CLOSED") unique.set(bar.begins_at, { ...bar, open: bar.open, high: bar.high, low: bar.low, close: bar.close, session: session.phase, trading_date: session.trading_date, data_grade: "OFFICIAL_OHLCV" } as RobinhoodChartData["bars"][number]);
    }
  }
  return [...unique.values()].sort((left, right) => Date.parse(left.begins_at) - Date.parse(right.begins_at)) as RobinhoodChartData["bars"];
}

function fifteenMinuteBars(values: RobinhoodChartData["bars"]) {
  const grouped = new Map<number, RobinhoodChartData["bars"]>();
  for (const bar of values) {
    const bucket = Math.floor(Date.parse(bar.begins_at) / 900_000) * 900_000;
    grouped.set(bucket, [...(grouped.get(bucket) ?? []), bar]);
  }
  return [...grouped.entries()].map(([bucket, bars]) => ({
    begins_at: new Date(bucket).toISOString(),
    open: bars[0].open,
    high: Math.max(...bars.map((bar) => bar.high)),
    low: Math.min(...bars.map((bar) => bar.low)),
    close: bars.at(-1)!.close,
    volume: bars.some((bar) => bar.volume !== null) ? bars.reduce((total, bar) => total + (bar.volume ?? 0), 0) : null,
    session: bars[0].session,
    trading_date: bars[0].trading_date,
    data_grade: "OFFICIAL_OHLCV" as const,
  }));
}

export function robinhoodResponseBody(response: ToolCallResponse) {
  if (response.structuredContent && typeof response.structuredContent === "object") return object(response.structuredContent);
  const item = response.content.find((entry) => entry && typeof entry === "object" && object(entry).type === "text" && typeof object(entry).text === "string");
  try { return object(JSON.parse(String(object(item).text ?? "{}"))); }
  catch { throw new RobinhoodMcpError("Robinhood MCP returned invalid JSON"); }
}

function dataRows(body: Record<string, unknown>, key: string) {
  const data = object(body.data);
  return rows(data[key] ?? body[key] ?? data.results ?? body.results);
}

export type ExternalOptionFilter = { symbol: string; expiration: string; strike: number; option_type: "call" | "put" };
export type ExternalOptionQuote = { contract_id: string; bid: number | null; ask: number | null; mark: number; iv: number | null; delta: number | null; gamma: number | null; theta: number | null; vega: number | null; quoted_at: string; received_at?: string; freshness_seconds: number };

export async function collectExternalOptionQuote(session: McpSession, filter: ExternalOptionFilter, observedAt?: string): Promise<ExternalOptionQuote | null> {
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(filter.symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(filter.expiration) || !Number.isFinite(filter.strike) || filter.strike <= 0) return null;
  const instrumentBody = robinhoodResponseBody(await session.call("get_option_instruments", { chain_symbol: filter.symbol, expiration_dates: filter.expiration, strike_price: filter.strike.toFixed(4), state: "active" }));
  const instrument = dataRows(instrumentBody, "instruments").find((row) => row.chain_symbol === filter.symbol && row.expiration_date === filter.expiration && number(row.strike_price) === filter.strike && row.type === filter.option_type);
  const contractId = text(instrument?.id);
  if (!contractId) return null;
  const quoteBody = robinhoodResponseBody(await session.call("get_option_quotes", { instrument_ids: [contractId] }));
  const receivedAt = new Date().toISOString();
  const quote = object(dataRows(quoteBody, "results").find((row) => text(object(row.quote).instrument_id) === contractId)?.quote);
  const quotedAt = iso(quote.updated_at), mark = number(quote.mark_price), quotedMs = Date.parse(quotedAt ?? ""), age = (Date.parse(observedAt ?? receivedAt) - quotedMs) / 1_000;
  if (!quotedAt || mark === null || mark < 0 || !Number.isFinite(age) || age < 0 || age > MARKET_5M_MAX_AGE_SECONDS || quotedMs > Date.parse(receivedAt)) return null;
  return { contract_id: contractId, bid: number(quote.bid_price), ask: number(quote.ask_price), mark, iv: number(quote.implied_volatility), delta: number(quote.delta), gamma: number(quote.gamma), theta: number(quote.theta), vega: number(quote.vega), quoted_at: quotedAt, received_at: receivedAt, freshness_seconds: age };
}

export type SpxOptionChain = { chain_id: string; chain_symbol: "SPX" | "SPXW"; settlement: "AM" | "PM"; expiration_dates: string[] };

export async function collectSpxOptionChains(session: McpSession): Promise<SpxOptionChain[]> {
  const body = robinhoodResponseBody(await session.call("get_option_chains", { underlying_symbol: "SPX" }));
  const chains = dataRows(body, "chains").flatMap((row) => {
    const symbol = text(row.symbol), id = text(row.id), expirations = Array.isArray(row.expiration_dates) ? row.expiration_dates.filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) : [];
    if ((symbol !== "SPX" && symbol !== "SPXW") || !id || typeof row.settle_on_open !== "boolean") return [];
    return [{ chain_id: id, chain_symbol: symbol as "SPX" | "SPXW", settlement: row.settle_on_open ? "AM" as const : "PM" as const, expiration_dates: expirations }];
  });
  if (!chains.some((chain) => chain.chain_symbol === "SPX" && chain.settlement === "AM") || !chains.some((chain) => chain.chain_symbol === "SPXW" && chain.settlement === "PM")) throw new RobinhoodMcpError("Robinhood SPX/SPXW settlement identity is unavailable");
  return chains;
}

function spxContract(row: Record<string, unknown>, chains: SpxOptionChain[]): SpxOptionContract | null {
  const contractId = text(row.id), chainId = text(row.chain_id), chainSymbol = text(row.chain_symbol), expiration = text(row.expiration_date), strike = number(row.strike_price), optionType = text(row.type);
  const chain = chains.find((item) => item.chain_id === chainId && item.chain_symbol === chainSymbol);
  if (!contractId || !chain || !expiration || strike === null || (optionType !== "call" && optionType !== "put")) return null;
  return { contract_id: contractId, chain_id: chain.chain_id, chain_symbol: chain.chain_symbol, settlement: chain.settlement, expiration_date: expiration, strike, option_type: optionType, state: text(row.state) ?? "unknown", tradability: text(row.tradability) ?? "unknown", ...resolveSpxContractMultiplier(row) };
}

export async function collectSpxOptionContracts(session: McpSession, filter: { chain_symbol: "SPX" | "SPXW"; expiration_date: string; strike: number; option_type: "call" | "put" }): Promise<SpxOptionContract[]> {
  const chains = await collectSpxOptionChains(session), chain = chains.find((item) => item.chain_symbol === filter.chain_symbol);
  if (!chain || !chain.expiration_dates.includes(filter.expiration_date) || !Number.isFinite(filter.strike) || filter.strike <= 0) return [];
  const body = robinhoodResponseBody(await session.call("get_option_instruments", { chain_id: chain.chain_id, expiration_dates: filter.expiration_date, strike_price: String(filter.strike), type: filter.option_type, state: "active" }));
  return dataRows(body, "instruments").flatMap((row) => { const contract = spxContract(row, chains); return contract ? [contract] : []; });
}

export async function collectSpxOptionContractsById(session: McpSession, contractIds: string[]): Promise<SpxOptionContract[]> {
  if (!contractIds.length || contractIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) return [];
  const chains = await collectSpxOptionChains(session), body = robinhoodResponseBody(await session.call("get_option_instruments", { ids: contractIds.join(",") }));
  return dataRows(body, "instruments").flatMap((row) => { const contract = spxContract(row, chains); return contract ? [contract] : []; });
}

export function classifySpxContractQuote(quote: Pick<SpxOptionQuote, "bid" | "ask" | "mark" | "quoted_at" | "freshness_seconds">, observedAt = new Date().toISOString()) {
  const observedSession = spxOptionSessionAt(observedAt).session, sourceSession = quote.quoted_at ? spxOptionSessionAt(quote.quoted_at).session : null;
  const twoSided = quote.bid !== null && quote.ask !== null && quote.mark !== null && quote.bid > 0 && quote.ask >= quote.bid;
  let status: SpxContractQuoteStatus;
  if (!twoSided) status = observedSession === "GTH" && sourceSession !== "GTH" ? "PROVIDER_GTH_UNAVAILABLE" : "CONTRACT_FOUND_NO_TWO_SIDED_QUOTE";
  else status = quote.freshness_seconds !== null && quote.freshness_seconds <= MARKET_5M_MAX_AGE_SECONDS ? "CONTRACT_FOUND_QUOTE_LIVE" : "CONTRACT_FOUND_QUOTE_STALE";
  return { status, source_session: sourceSession, observed_session: observedSession };
}

export async function collectSpxOptionQuotes(session: McpSession, contracts: SpxOptionContract[], observedAt = new Date().toISOString()): Promise<Array<{ contract: SpxOptionContract; quote: SpxOptionQuote }>> {
  if (!contracts.length) return [];
  const body = robinhoodResponseBody(await session.call("get_option_quotes", { instrument_ids: contracts.map((contract) => contract.contract_id) }));
  const byId = new Map(dataRows(body, "results").map((row) => { const quote = object(row.quote); return [text(quote.instrument_id), quote] as const; }));
  return contracts.map((contract) => {
    const row = byId.get(contract.contract_id) ?? {}, quotedAt = iso(row.updated_at), age = freshness(quotedAt, observedAt), bid = number(row.bid_price), ask = number(row.ask_price), mark = number(row.mark_price);
    const classified = classifySpxContractQuote({ bid, ask, mark, quoted_at: quotedAt, freshness_seconds: age }, observedAt), current = classified.status === "CONTRACT_FOUND_QUOTE_LIVE";
    const quote: SpxOptionQuote = { bid, ask, mark, iv: number(row.implied_volatility), delta: number(row.delta), gamma: number(row.gamma), theta: number(row.theta), vega: number(row.vega), quoted_at: quotedAt, freshness_seconds: age, status: current ? robinhoodMarketSession(observedAt).state === "REGULAR" ? "LIVE" : "MARKET_CLOSED" : "DATA_BLOCKED", contract_quote_status: classified.status, source_session: classified.source_session, observed_session: classified.observed_session };
    return { contract, quote };
  });
}

export type SpxObservationCandidate = {
  contract: SpxOptionContract; quote: SpxOptionQuote;
  quote_assessment: ReturnType<typeof assessExecutableQuote>; capital_assessment: ReturnType<typeof assessCapital>;
  volume: number | null; open_interest: number | null;
};
export async function collectSpxObservationCandidate(session: McpSession, input: {
  direction: "BULLISH" | "BEARISH"; capitalContext: OwnerCapitalContext | null; observedAt?: string; excludeContractIds?: string[];
}) {
  const selection = { rule: "SPXW_PAPER_7_30_V1" as const, dte_min: 7, dte_max: 30, expirations: [] as string[], scanned_contracts: 0, quoted_contracts: 0, rpc_calls: 0,
    scope: "EARLIEST_TWO_VERIFIED_SPXW_PM_EXPIRIES" as const, complete: false };
  const reasons = new Set<string>(), rawQuotes = new Map<string, Record<string, unknown>>();
  const result = (candidate: SpxObservationCandidate | null = null) => ({ candidate, reasons: [...reasons], selection });
  const fail = (reason: string): never => { reasons.add(reason); throw new RobinhoodMcpError(reason); };
  const providerRows = (body: Record<string, unknown>, key: string) => {
    const list = object(body.data)[key] ?? body[key] ?? object(body.data).results ?? body.results;
    if (!Array.isArray(list) || list.some((row) => !row || typeof row !== "object" || Array.isArray(row))) return fail("SPXW_RESPONSE_INVALID");
    return list as Record<string, unknown>[];
  };
  // ponytail: fully list at most two expiries/three pages each and 1,000 identities, then quote in batches of 100; not the full SPXW market.
  const bounded: McpSession = { listTools: () => session.listTools(), async call(tool, args) {
    if (!["get_option_chains", "get_option_instruments", "get_option_quotes"].includes(tool) || selection.rpc_calls >= 17) return fail("SPXW_READ_BUDGET_EXCEEDED");
    selection.rpc_calls++;
    const response = await session.call(tool, args);
    if (response.isError) return fail("SPXW_PROVIDER_READ_FAILED");
    const body = robinhoodResponseBody(response);
    const next = object(body.data).next ?? body.next;
    if (tool === "get_option_chains") {
      providerRows(body, "chains");
      if (next !== undefined && next !== null && next !== "") return fail("SPXW_CHAIN_LIST_INCOMPLETE");
    }
    if (tool === "get_option_quotes") {
      const expected = new Set(object(args).instrument_ids as string[]), seen = new Set<string>();
      for (const row of providerRows(body, "results")) {
        const quote = object(row.quote), id = text(quote.instrument_id);
        if (!id || !expected.has(id) || seen.has(id)) return fail("SPXW_QUOTE_IDENTITY_INVALID");
        seen.add(id); rawQuotes.set(id, quote);
      }
      if (next !== undefined && next !== null && next !== "") return fail("SPXW_QUOTES_INCOMPLETE");
      if (seen.size !== expected.size) reasons.add("SPXW_QUOTES_MISSING");
      selection.quoted_contracts += seen.size;
    }
    return response;
  } };
  try {
    const at = iso(input.observedAt ?? new Date().toISOString());
    if (!at || !["BULLISH", "BEARISH"].includes(input.direction)) return fail("SPXW_DIRECTION_OR_TIME_INVALID");
    const optionType = input.direction === "BULLISH" ? "call" : "put", uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    const chains = (await collectSpxOptionChains(bounded)).filter((chain) => chain.chain_symbol === "SPXW" && chain.settlement === "PM");
    if (chains.length !== 1 || !uuid.test(chains[0].chain_id)) return fail("SPXW_CHAIN_IDENTITY_INVALID");
    const chain = chains[0];
    selection.expirations = [...new Set(chain.expiration_dates)].filter((date) => iso(`${date}T00:00:00.000Z`)?.slice(0, 10) === date && isNyseRegularSession(date) && isPaperOptionExpiration(date, exchangeDateKey(at))).sort().slice(0, 2);
    if (!selection.expirations.length) return fail("SPXW_NO_7_30_DTE_EXPIRATION");
    const contracts = new Map<string, SpxOptionContract>();
    for (const expiration of selection.expirations) {
      const cursors = new Set<string>(); let cursor: string | undefined;
      for (let page = 0; page < 3; page++) {
        const body = robinhoodResponseBody(await bounded.call("get_option_instruments", { chain_id: chain.chain_id, expiration_dates: expiration, type: optionType, state: "active", tradability: "tradable", ...(cursor ? { cursor } : {}) }));
        for (const row of providerRows(body, "instruments")) {
          const contract = spxContract(row, [chain]);
          if (!contract || !uuid.test(contract.contract_id) || contract.expiration_date !== expiration || contract.option_type !== optionType || contract.strike <= 0 || contract.state !== "active" || contract.tradability !== "tradable") return fail("SPXW_INSTRUMENT_IDENTITY_INVALID");
          if (contracts.has(contract.contract_id)) return fail("SPXW_DUPLICATE_INSTRUMENT");
          contracts.set(contract.contract_id, contract); selection.scanned_contracts++;
          if (selection.scanned_contracts > 1_000) return fail("SPXW_INSTRUMENT_LIMIT_EXCEEDED");
        }
        const next = object(body.data).next ?? body.next;
        if (next === undefined || next === null || next === "") break;
        cursor = robinhoodOptionCursor(next);
        if (!cursor || cursors.has(cursor) || page === 2) return fail("SPXW_INSTRUMENT_LIST_INCOMPLETE");
        cursors.add(cursor); // Only the opaque cursor is returned to the read-only tool; never fetch a provider URL.
      }
    }
    const eligible = [...contracts.values()].filter((contract) => !input.excludeContractIds?.includes(contract.contract_id));
    if (!eligible.length) return fail("SPXW_NO_NEW_VERIFIED_CONTRACT");
    const candidates: SpxObservationCandidate[] = [];
    for (let offset = 0; offset < eligible.length; offset += 100) {
      const quotes = await collectSpxOptionQuotes(bounded, eligible.slice(offset, offset + 100)), receivedAt = new Date().toISOString();
      for (const { contract, quote } of quotes) {
        const quotedAt = Date.parse(quote.quoted_at ?? ""), age = Date.parse(receivedAt) - quotedAt;
        if (!Number.isFinite(age) || age < 0 || age > 120_000 || quote.bid === null || quote.ask === null || quote.bid <= 0 || quote.ask < quote.bid || quote.mark === null || quote.mark < 0) { reasons.add("SPXW_QUOTE_NOT_CURRENT_BBO"); continue; }
        if (quote.delta === null || Math.abs(quote.delta) <= 0 || Math.abs(quote.delta) >= 1 || (optionType === "call" ? quote.delta < 0 : quote.delta > 0)) { reasons.add("SPXW_DELTA_UNAVAILABLE_OR_WRONG_DIRECTION"); continue; }
        const quote_assessment = assessExecutableQuote(quote, new Date(Date.parse(receivedAt) - 120_000).toISOString(), receivedAt), capital_assessment = assessCapital(quote.ask, contract.contract_multiplier, input.capitalContext);
        if (quote_assessment.relative_spread_pct === null || quote_assessment.relative_spread_pct > MAX_EXECUTABLE_RELATIVE_SPREAD_PCT) { reasons.add("SPXW_RELATIVE_SPREAD_TOO_WIDE"); continue; }
        if (!["NORMAL_FIT", "LOW_COST_REVIEW"].includes(capital_assessment.fit)) { reasons.add("SPXW_OWNER_CAPITAL_UNFIT"); continue; }
        const raw = rawQuotes.get(contract.contract_id) ?? {};
        candidates.push({ contract, quote, quote_assessment, capital_assessment, volume: nonnegative(raw.volume), open_interest: nonnegative(raw.open_interest) });
      }
    }
    selection.complete = selection.quoted_contracts === eligible.length;
    const currentCandidates = candidates.filter(({ quote }) => { const age = Date.now() - Date.parse(quote.quoted_at!); return age >= 0 && age <= 120_000; });
    if (currentCandidates.length < candidates.length) reasons.add("SPXW_QUOTE_NOT_CURRENT_BBO");
    const candidate = currentCandidates.sort((left, right) => Math.abs(Math.abs(left.quote.delta!) - .5) - Math.abs(Math.abs(right.quote.delta!) - .5)
      || left.quote_assessment.relative_spread_pct! - right.quote_assessment.relative_spread_pct! || (right.volume ?? -1) - (left.volume ?? -1) || (right.open_interest ?? -1) - (left.open_interest ?? -1)
      || Number(right.capital_assessment.normal_range) - Number(left.capital_assessment.normal_range) || left.contract.contract_id.localeCompare(right.contract.contract_id))[0] ?? null;
    if (!candidate) reasons.add("SPXW_NO_RESEARCH_CANDIDATE");
    else {
      if (candidate.quote_assessment.status !== "PASS") reasons.add(`FORMAL_QUOTE_BLOCKED:${candidate.quote_assessment.reason}`);
      if (candidate.capital_assessment.risk_limits_status !== "PASS") reasons.add("OWNER_RISK_LIMIT_UNCONFIGURED");
      reasons.add("RESEARCH_ONLY_NOT_APPROVAL_OR_FILL");
    }
    return result(candidate);
  } catch { reasons.add("SPXW_COLLECTION_BLOCKED"); return result(); }
}

export async function collectSpxOptionHistory(session: McpSession, contractIds: string[], startTime: string, endTime: string) {
  if (!contractIds.length || contractIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id)) || !iso(startTime) || !iso(endTime) || Date.parse(endTime) <= Date.parse(startTime)) throw new RobinhoodMcpError("SPX option history request is invalid");
  const body = robinhoodResponseBody(await session.call("get_option_historicals", { instrument_ids: contractIds, start_time: iso(startTime), end_time: iso(endTime), bounds: "regular" }));
  return dataRows(body, "results").map((row) => ({ instrument_id: text(row.instrument_id), interval: text(row.interval), bounds: text(row.bounds), bars: rows(row.bars).flatMap((bar) => {
    const beginsAt = iso(bar.begins_at), open = number(bar.open_price), high = number(bar.high_price), low = number(bar.low_price), close = number(bar.close_price);
    return beginsAt && open !== null && high !== null && low !== null && close !== null && bar.interpolated !== true ? [{ begins_at: beginsAt, open, high, low, close, session: text(bar.session) }] : [];
  }) }));
}

function batches<T>(values: T[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

type FixedHistory = Record<"daily" | "four_hour" | "one_hour" | "thirty_minute", Record<string, unknown> | undefined>;
type FixedTimeframe = ApprovedCapabilitySnapshot["fixed_pool"]["rows"][number]["timeframes"]["daily"];

function completedStructureBars(historyRow: Record<string, unknown> | undefined, timeframe: FixedTimeframe["timeframe"], observedAt: string, marketSession: ReadonlyMarketSources["market_session"]) {
  const values = completeMarketBars(rows(historyRow?.bars));
  if (timeframe === "1d") {
    const marketDate = marketSession.market_date;
    return values.filter((bar) => bar.begins_at.slice(0, 10) < marketDate || marketSession.state === "CLOSED");
  }
  if (marketSession.state === "CLOSED") return values;
  const duration = timeframe === "4h" ? 14_400_000 : timeframe === "1h" ? 3_600_000 : 1_800_000;
  return values.filter((bar) => Date.parse(bar.begins_at) + duration <= Date.parse(observedAt));
}

function analyzeStructure(bars: RobinhoodChartData["bars"], timeframe: FixedTimeframe["timeframe"]): FixedTimeframe {
  if (bars.length < 21) return { timeframe, available: false, pattern: "unavailable", state: "unavailable", direction: "NOT_OBSERVED", confidence: null, support: null, resistance: null, volume_context: "未观察到", data_cutoff: bars.at(-1)?.begins_at ?? null, limitation: `少于21根官方${timeframe}完整K线` };
  const recent = bars.slice(-20), prior = bars.slice(-21, -1), close = recent.at(-1)!.close, priorClose = recent.at(-2)!.close;
  const support = Math.min(...prior.map((bar) => bar.low)), resistance = Math.max(...prior.map((bar) => bar.high));
  const preBreakoutResistance = Math.max(...recent.slice(0, -2).map((bar) => bar.high));
  const volumes = prior.map((bar) => bar.volume).filter((item): item is number => item !== null), latestVolume = recent.at(-1)!.volume;
  const averageVolume = volumes.length ? volumes.reduce((sum, item) => sum + item, 0) / volumes.length : null;
  const volumeRatio = latestVolume !== null && averageVolume ? latestVolume / averageVolume : null;
  const first = recent.slice(0, 10), second = recent.slice(10);
  const firstRange = Math.max(...first.map((bar) => bar.high)) - Math.min(...first.map((bar) => bar.low));
  const secondRange = Math.max(...second.map((bar) => bar.high)) - Math.min(...second.map((bar) => bar.low));
  const risingLows = Math.min(...recent.slice(-5).map((bar) => bar.low)) > Math.min(...recent.slice(0, 5).map((bar) => bar.low));
  const fallingHighs = Math.max(...recent.slice(-5).map((bar) => bar.high)) < Math.max(...recent.slice(0, 5).map((bar) => bar.high));
  let pattern = "range", state = "unclear", direction: FixedTimeframe["direction"] = "RANGE";
  if (priorClose > preBreakoutResistance && close < preBreakoutResistance) [pattern, state] = ["false_breakout", "failed"];
  else if (close > resistance && priorClose <= resistance) { pattern = volumeRatio !== null && volumeRatio >= 1.35 ? "volume_breakout" : "breakout"; state = "breakout_pending_confirmation"; direction = "BULLISH"; }
  else if (risingLows && fallingHighs && secondRange < firstRange * .8) [pattern, state] = ["symmetrical_triangle", "compression"];
  else if (risingLows && Math.abs(Math.max(...recent.slice(-8).map((bar) => bar.high)) - resistance) / resistance < .025) { pattern = "ascending_triangle"; state = "breakout_watch"; direction = "BULLISH"; }
  else if (fallingHighs && Math.abs(Math.min(...recent.slice(-8).map((bar) => bar.low)) - support) / support < .025) { pattern = "descending_triangle"; state = "breakdown_watch"; direction = "BEARISH"; }
  else if (close > recent.at(-6)!.close && risingLows) { pattern = "higher_high_higher_low"; state = "trend_continuation"; direction = "BULLISH"; }
  else if (close < recent.at(-6)!.close && fallingHighs) { pattern = "lower_high_lower_low"; state = "trend_continuation"; direction = "BEARISH"; }
  return { timeframe, available: true, pattern, state, direction, confidence: pattern === "volume_breakout" || pattern === "false_breakout" ? .8 : pattern === "range" ? .35 : .65, support: Math.round(support * 100) / 100, resistance: Math.round(resistance * 100) / 100, volume_context: volumeRatio === null ? "未观察到" : volumeRatio >= 1.35 ? "放量" : volumeRatio <= .75 ? "缩量" : "正常", data_cutoff: bars.at(-1)!.begins_at, limitation: null, return_pct: recent[0].close ? Math.round((close / recent[0].close - 1) * 100_000) / 1_000 : null };
}

function fixed70Structure(symbol: string, quoteRow: Record<string, unknown> | undefined, histories: FixedHistory, observedAt: string, marketSession: ReadonlyMarketSources["market_session"]): ApprovedCapabilitySnapshot["fixed_pool"]["rows"][number] {
  const quote = object(quoteRow?.quote);
  const timeframes = {
    daily: analyzeStructure(completedStructureBars(histories.daily, "1d", observedAt, marketSession), "1d"),
    four_hour: analyzeStructure(completedStructureBars(histories.four_hour, "4h", observedAt, marketSession), "4h"),
    one_hour: analyzeStructure(completedStructureBars(histories.one_hour, "1h", observedAt, marketSession), "1h"),
    thirty_minute: analyzeStructure(completedStructureBars(histories.thirty_minute, "30m", observedAt, marketSession), "30m"),
  };
  const structures = Object.values(timeframes), daily = timeframes.daily;
  const last = number(quote.last_trade_price), previousClose = number(quote.previous_close), asOf = iso(quote.venue_last_trade_time ?? quote.updated_at) ?? structures.map((item) => item.data_cutoff).filter((item): item is string => Boolean(item)).sort().at(-1) ?? null;
  const current = marketSession.state === "CLOSED" ? currentEod(asOf, observedAt) : freshness(asOf, observedAt) !== null && freshness(asOf, observedAt)! <= MARKET_5M_MAX_AGE_SECONDS;
  const status: MarketDataStatus = last === null || structures.some((item) => !item.available) ? "DATA_BLOCKED" : marketSession.state === "CLOSED" ? current ? "MARKET_CLOSED" : "STALE" : current ? "LIVE" : "STALE";
  const direction = daily.direction, aligned = direction === "BULLISH" || direction === "BEARISH" ? structures.filter((item) => item.direction === direction).length : 0;
  const opposite = direction === "BULLISH" ? "BEARISH" : "BULLISH";
  const intradayOpposed = direction !== "RANGE" && timeframes.one_hour.direction === opposite && timeframes.thirty_minute.direction === opposite;
  const extended = last !== null && (direction === "BULLISH" && daily.resistance !== null && last > daily.resistance * 1.04 || direction === "BEARISH" && daily.support !== null && last < daily.support * .96);
  const stage = status === "DATA_BLOCKED" ? "DATA_BLOCKED" : daily.pattern === "false_breakout" ? "INVALIDATED" : direction === "RANGE" || direction === "NOT_OBSERVED" ? "WAIT" : extended ? "EXTENDED" : aligned >= 3 && !intradayOpposed ? "CONFIRMED" : "EARLY_WATCH";
  const missing = structures.filter((item) => !item.available).map((item) => `${item.timeframe}完整K线不足`);
  if (!missing.length) {
    if (stage === "WAIT") missing.push("等待日线走出有效方向");
    else if (stage === "EARLY_WATCH") missing.push(intradayOpposed ? "1小时和30分钟短周期反向；只降低波段成熟度，不推翻日线或4小时逻辑" : "等待至少三个周期与日线同向");
    else if (stage === "EXTENDED") missing.push("价格已离开正常结构区，等待回踩，不追价");
    else if (stage === "INVALIDATED") missing.push("日线假突破，等待高周期结构重建");
  }
  const why = [daily.available ? `日线${daily.pattern}，方向${daily.direction}` : "日线结构不足", `已观察${structures.filter((item) => item.available).length}/4个周期，同向${aligned}/4`, daily.volume_context === "未观察到" ? "成交量确认缺失" : `日线成交量${daily.volume_context}`];
  const invalidation = direction === "BULLISH" && daily.resistance !== null ? `跌回日线突破位 ${daily.resistance.toFixed(2)} 下方` : direction === "BEARISH" && daily.support !== null ? `重新站上日线支撑 ${daily.support.toFixed(2)}` : "日线方向尚未形成，暂不设交易失效位";
  const noChase = stage !== "CONFIRMED" || daily.pattern.includes("breakout");
  return {
    symbol, status, as_of: asOf, last, previous_close: previousClose, change_pct: last !== null && previousClose ? Math.round((last - previousClose) / previousClose * 100_000) / 1_000 : null,
    pattern: daily.pattern, state: daily.state, direction, confidence: daily.confidence, support: daily.support, resistance: daily.resistance, volume_context: daily.volume_context, no_chase: noChase,
    limitation: status === "DATA_BLOCKED" ? missing.join("；") : "完整多周期波段研究已生成；交易执行仍需独立的分钟级、期权流动性与事件风险门禁",
    timeframes, swing: { stage, direction, aligned_timeframes: aligned, observed_timeframes: structures.filter((item) => item.available).length, why_watch: why, missing_confirmation: missing, next_check: marketSession.state === "REGULAR" ? "下一自然TS槽（最晚30分钟）" : "下一交易日06:30加州时间", invalidation },
  };
}

type Fixed70Row = ApprovedCapabilitySnapshot["fixed_pool"]["rows"][number];
const SECTOR_ETFS = new Set<string>(MARKET_ENVIRONMENT_SYMBOLS.sectors);

function tradingDateAfter(dateKey: string, sessions: number) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  let remaining = sessions;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isNyseRegularSession(date.toISOString().slice(0, 10))) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

function directional(value: FixedTimeframe["direction"]) { return value === "BULLISH" || value === "BEARISH"; }

function relativeStrength(row: Fixed70Row, spy: Fixed70Row | undefined) {
  const symbolReturn = row.timeframes.daily.return_pct ?? null, spyReturn = spy?.timeframes.daily.return_pct ?? null;
  const delta = symbolReturn === null || spyReturn === null ? null : Math.round((symbolReturn - spyReturn) * 1_000) / 1_000;
  const sectorSymbol = SECTOR_ETFS.has(row.symbol) ? row.symbol : null;
  const classification = delta === null ? "NOT_OBSERVED" as const
    : delta < -1 ? "LAGGING" as const
    : symbolReturn! > 0 && delta > 1 ? "INDEPENDENT_STRENGTH" as const
    : "INDEX_FOLLOWING" as const;
  const reason = delta === null ? "20根已完成日线不足，不能比较相对SPY强弱"
    : `${row.symbol} 20根已完成日线 ${symbolReturn! >= 0 ? "+" : ""}${symbolReturn!.toFixed(2)}%，SPY ${spyReturn! >= 0 ? "+" : ""}${spyReturn!.toFixed(2)}%，相差 ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} 个百分点。${sectorSymbol ? "该标的本身就是板块ETF。" : "当前批准链没有股票到板块ETF的可靠映射，所属板块比较保持未观察到。"}`;
  return { basis: "20_COMPLETED_DAILY_BARS" as const, symbol_return_pct: symbolReturn, spy_return_pct: spyReturn, vs_spy_pct: delta, sector_symbol: sectorSymbol, vs_sector_pct: sectorSymbol ? 0 : null, classification, reason };
}

function swingLevels(row: Fixed70Row, primary: FixedTimeframe | null) {
  const bullish = primary?.direction === "BULLISH", bearish = primary?.direction === "BEARISH", last = row.last;
  const entryLevel = bullish ? row.timeframes.four_hour.resistance ?? primary?.resistance ?? null : bearish ? row.timeframes.four_hour.support ?? primary?.support ?? null : null;
  const entryTrigger = entryLevel !== null && last !== null && (bullish && entryLevel > last || bearish && entryLevel < last) ? entryLevel : null;
  const priceInvalidation = bullish ? row.timeframes.daily.support : bearish ? row.timeframes.daily.resistance : null;
  const targetLevel = bullish ? row.timeframes.daily.resistance : bearish ? row.timeframes.daily.support : null;
  const target1 = targetLevel !== null && last !== null && entryLevel !== targetLevel && (bullish && targetLevel > Math.max(last, entryLevel ?? last) || bearish && targetLevel < Math.min(last, entryLevel ?? last)) ? targetLevel : null;
  return { entryTrigger, priceInvalidation, target1, target2: null };
}

export function applyFixed70SwingManagement(snapshot: ApprovedCapabilitySnapshot, previous: ApprovedCapabilitySnapshot | null | undefined, environment?: MarketEnvironment): ApprovedCapabilitySnapshot {
  const previousRows = new Map(previous?.fixed_pool.rows.map((row) => [row.symbol, row]) ?? []), spy = snapshot.fixed_pool.rows.find((row) => row.symbol === "SPY");
  const positionSymbols = new Set(snapshot.real_positions.status === "OBSERVED" ? snapshot.real_positions.symbols : []);
  const positionsBlocked = snapshot.real_positions.status === "DATA_BLOCKED";
  const coreRows = snapshot.fixed_pool.rows.filter((row) => APPROVED_CORE70.includes(row.symbol) && row.status !== "DATA_BLOCKED");
  const breadth = snapshot.contract_version === "v3" ? coreRows.length ? Math.round(coreRows.filter((row) => (row.change_pct ?? 0) > 0).length / coreRows.length * 1_000) / 10 : null : snapshot.fixed_pool.breadth.advance_pct;
  const marketRegime = spy?.direction === "RANGE" || breadth !== null && breadth >= 40 && breadth <= 60 ? "CHOPPY" as const : spy && directional(spy.direction) ? "TRENDING" as const : "NOT_OBSERVED" as const;
  const generatedDate = ptDateKey(snapshot.generated_at);
  const earningsRisk = new Set(snapshot.earnings_center.items.filter((item) => item.result_status !== "IMPACT_OBSERVED").map((item) => item.symbol));
  const verifiedEvents = new Set(snapshot.event_scan.items.filter((item) => item.evidence_state === "VERIFIED").flatMap((item) => item.affected_symbols));
  const eventRank = new Map<string, number>();
  for (const item of snapshot.event_scan.items) for (const symbol of new Set([...item.affected_symbols, ...item.impact_mapping])) eventRank.set(symbol, Math.max(eventRank.get(symbol) ?? 0, item.evidence_state === "VERIFIED" ? 3 : item.evidence_state === "PARTIAL" ? 2 : 1));
  const earningsRank = new Map(snapshot.earnings_center.items.map((item) => [item.symbol, item.result_status === "IMPACT_OBSERVED" ? 4 : item.result_status === "REPORTED_WAITING_REACTION" ? 3 : 0]));
  const rows = snapshot.fixed_pool.rows.map((row): Fixed70Row => {
    const priorRow = previousRows.get(row.symbol), stored = priorRow?.swing.management;
    const daily = row.timeframes.daily, fourHour = row.timeframes.four_hour;
    const primary = directional(daily.direction) ? daily : directional(fourHour.direction) ? fourHour : null;
    const primaryTimeframe = primary?.timeframe === "1d" || primary?.timeframe === "4h" ? primary.timeframe : "NOT_OBSERVED";
    const holding = positionSymbols.has(row.symbol), qualifying = row.status !== "DATA_BLOCKED" && (holding || ["EARLY_WATCH", "CONFIRMED", "EXTENDED"].includes(row.swing.stage));
    const restart = stored?.archive_status === "ARCHIVED" && qualifying && ptDateKey(stored.last_reviewed_at) < generatedDate;
    const prior = restart ? undefined : stored;
    if (!prior && !qualifying) return row;
    if (prior?.last_reviewed_at === snapshot.generated_at) return { ...row, swing: { ...row.swing, management: prior } };
    const firstSeen = prior?.first_seen_at ?? snapshot.generated_at;
    const timeInvalidation = tradingDateAfter(ptDateKey(firstSeen), 10);
    const opposite = primary?.direction === "BULLISH" ? "BEARISH" : "BULLISH";
    const shortOpposed = directional(primary?.direction ?? "NOT_OBSERVED") && row.timeframes.one_hour.direction === opposite && row.timeframes.thirty_minute.direction === opposite;
    const priorDirection = priorRow?.swing.direction;
    const directionReversed = prior && directional(priorDirection ?? "NOT_OBSERVED") && directional(primary?.direction ?? "NOT_OBSERVED") && priorDirection !== primary?.direction;
    const relative = relativeStrength(row, spy);
    const levels = swingLevels(row, primary);
    const priorInvalidation = prior?.price_invalidation ?? null;
    const crossedInvalidation = priorInvalidation !== null && row.last !== null && (priorRow?.swing.direction === "BULLISH" && row.last < priorInvalidation || priorRow?.swing.direction === "BEARISH" && row.last > priorInvalidation);
    const invalidated = row.swing.stage === "INVALIDATED" || directionReversed || crossedInvalidation;
    const timeStopped = generatedDate >= timeInvalidation && !holding && !(prior?.state === "HOLDING" && positionsBlocked);
    let state: NonNullable<Fixed70Row["swing"]["management"]>["state"], reason: string, settlementReason: string | null = null;
    if (prior?.state === "INVALIDATED" && ptDateKey(prior.state_changed_at) < generatedDate) { state = "SETTLED"; reason = "失效机会已跨过一个加州交易日，自动归档并保留历史"; settlementReason = "价格或高周期结构失效后自动结算"; }
    else if (prior?.state === "HOLDING" && !positionsBlocked && !holding) { state = "SETTLED"; reason = "真实持仓已不在Robinhood官方账户只读结果中"; settlementReason = "持仓离开官方只读持仓池；不推断成交原因"; }
    else if (timeStopped) { state = "SETTLED"; reason = "10个交易日内没有形成成熟入场窗口，自动降级归档"; settlementReason = "波段时间失效；没有回填或假设交易"; }
    else if (prior && (row.status === "DATA_BLOCKED" || prior.state === "HOLDING" && positionsBlocked)) { state = prior.state; reason = prior.state === "HOLDING" && positionsBlocked ? "本槽Robinhood账户只读受阻，保留上一自然槽持仓状态，不推断离场" : "本槽观察池结构读取受阻，保留上一自然槽状态但不升级成熟度"; }
    else if (invalidated) { state = "INVALIDATED"; reason = directionReversed ? "日线/4小时核心方向发生反转；短周期噪音未单独触发本状态" : "价格或日线核心结构达到失效条件"; settlementReason = "等待下一加州交易日自动归档"; }
    else if (holding) { state = "HOLDING"; reason = "Robinhood官方只读账户已识别该标的真实持仓；由现有D、A3和持仓副驾驶继续管理"; }
    else if (!prior) { state = "DISCOVERED"; reason = "首次在自然观察池冻结快照中满足波段观察条件"; }
    else if (row.swing.stage === "EXTENDED" || shortOpposed || relative.classification === "LAGGING") { state = "WEAKENING"; reason = row.swing.stage === "EXTENDED" ? "价格已离开正常结构区，不追价" : shortOpposed ? "1小时和30分钟反向，只将波段状态降为减弱，不推翻日线/4小时" : "20根已完成日线相对SPY落后，机会强度减弱"; }
    else if (row.swing.stage === "CONFIRMED") { state = snapshot.fixed_pool.missing_gates.length || earningsRisk.has(row.symbol) || marketRegime === "CHOPPY" && relative.classification !== "INDEPENDENT_STRENGTH" ? "WAITING_CONFIRMATION" : "EXECUTABLE"; reason = state === "EXECUTABLE" ? "多周期、相对强弱、事件和执行门禁均已通过；仍为Shadow人工决策" : marketRegime === "CHOPPY" && relative.classification !== "INDEPENDENT_STRENGTH" ? "大盘震荡且没有证明独立强势，等待确认，不追随指数反弹" : "多周期结构已确认，但分钟级、合约或事件门禁尚未完整"; }
    else { state = "OBSERVING"; reason = "高周期逻辑仍在，继续观察下一次自然复核"; }
    const missing = [...new Set([...row.swing.missing_confirmation, ...snapshot.fixed_pool.missing_gates, ...(earningsRisk.has(row.symbol) ? ["财报结果或财报后价格影响尚未完成验证"] : []), ...(marketRegime === "CHOPPY" && relative.classification !== "INDEPENDENT_STRENGTH" ? ["大盘震荡中尚未证明独立结构"] : []), ...(!relative.sector_symbol && !SECTOR_ETFS.has(row.symbol) ? ["所属板块ETF映射未在批准链中上报，板块相对强弱保持未观察到"] : []), ...(verifiedEvents.has(row.symbol) ? [] : ["当前没有映射到该标的的已核验重大事件"]), ...(levels.entryTrigger === null && !holding ? ["分钟级价格确认位未在观察池官方快照中形成"] : []), ...(levels.target1 === null ? ["当前已观察结构没有更远的第一目标"] : []), "第二目标没有可审计结构位，保持未观察到"])];
    const changed = prior?.state !== state;
    return { ...row, swing: { ...row.swing, management: {
      lifecycle_id: prior?.lifecycle_id ?? `fixed70-${row.symbol.toLowerCase()}-${(primary?.direction ?? "unknown").toLowerCase()}-${generatedDate.replaceAll("-", "")}`,
      state, archive_status: state === "SETTLED" ? "ARCHIVED" : "ACTIVE", first_seen_at: firstSeen, state_changed_at: changed ? snapshot.generated_at : prior!.state_changed_at, last_reviewed_at: snapshot.generated_at,
      review_count: prior?.last_reviewed_at === snapshot.generated_at ? prior.review_count : (prior?.review_count ?? 0) + 1,
      primary_timeframe: primaryTimeframe, primary_reason: primary ? `${primary.timeframe} ${primary.pattern} / ${primary.state} 是本轮最高有效周期；1小时和30分钟只负责确认或减弱` : "日线和4小时没有形成可观察方向",
      market_context: { regime: marketRegime, sector_breadth_advance_pct: breadth, rates_status: environment?.rates.status ?? null, oil_status: environment?.oil.status ?? null, reason: marketRegime === "CHOPPY" ? `SPY处于区间或${snapshot.contract_version === "v3" ? "核心70" : "固定70"}上涨占比接近均衡；只有独立结构才允许继续成熟` : marketRegime === "TRENDING" ? `SPY高周期方向与${snapshot.contract_version === "v3" ? "核心70" : "固定70"}上涨占比不属于均衡震荡` : "市场环境证据不足" },
      relative_strength: relative, entry_trigger: levels.entryTrigger, price_invalidation: levels.priceInvalidation, time_invalidation_date: timeInvalidation, target_1: levels.target1, target_2: levels.target2,
      next_check: row.swing.next_check, state_reason: reason, missing_confirmation: missing, settlement_reason: settlementReason,
    } } };
  });
  const rank = { HOLDING: 8, EXECUTABLE: 7, WAITING_CONFIRMATION: 6, DISCOVERED: 5, OBSERVING: 4, WEAKENING: 3, INVALIDATED: 1, SETTLED: 0 } as const;
  const relativeRank = { INDEPENDENT_STRENGTH: 2, INDEX_FOLLOWING: 1, LAGGING: 0, NOT_OBSERVED: 0 } as const;
  const candidates = rows.filter((row) => row.swing.management?.archive_status === "ACTIVE" && !["INVALIDATED"].includes(row.swing.management.state)).sort((left, right) =>
    rank[right.swing.management!.state] - rank[left.swing.management!.state]
    || Math.max(eventRank.get(right.symbol) ?? 0, earningsRank.get(right.symbol) ?? 0) - Math.max(eventRank.get(left.symbol) ?? 0, earningsRank.get(left.symbol) ?? 0)
    || relativeRank[right.swing.management!.relative_strength.classification] - relativeRank[left.swing.management!.relative_strength.classification]
    || Math.abs(right.change_pct ?? 0) - Math.abs(left.change_pct ?? 0)
    || Number(right.volume_context === "放量") - Number(left.volume_context === "放量")
    || right.swing.aligned_timeframes - left.swing.aligned_timeframes
    || (right.confidence ?? 0) - (left.confidence ?? 0)
    || left.symbol.localeCompare(right.symbol)
  ).slice(0, 5).map((row) => row.symbol);
  return { ...snapshot, fixed_pool: { ...snapshot.fixed_pool, rows, candidates } };
}

function pctDifference(actual: number | null, estimate: number | null) { return actual !== null && estimate !== null && estimate !== 0 ? Math.round((actual - estimate) / Math.abs(estimate) * 100_000) / 1_000 : null; }

function earningsCenterItem(event: MarketEvent, dailyHistory: Record<string, unknown> | undefined, observedAt: string, marketSession: ReadonlyMarketSources["market_session"]): ApprovedCapabilitySnapshot["earnings_center"]["items"][number] {
  const symbol = event.affected_symbols[0], scheduled = event.scheduled_for!, eventDate = scheduled.slice(0, 10), result = event.earnings_result;
  const bars = completedStructureBars(dailyHistory, "1d", observedAt, marketSession).map((bar) => ({ ...bar, date: bar.begins_at.slice(0, 10) }));
  const session = result?.session ?? "UNKNOWN";
  const before = bars.filter((bar) => session === "AMC" ? bar.date <= eventDate : bar.date < eventDate).at(-1);
  const after = bars.find((bar) => session === "AMC" ? bar.date > eventDate : bar.date >= eventDate);
  const returnPct = before && after ? Math.round((after.close - before.close) / before.close * 100_000) / 1_000 : null;
  const reactionObserved = returnPct !== null;
  const epsSurprise = pctDifference(result?.eps_actual ?? null, result?.eps_estimate ?? null), revenueSurprise = pctDifference(result?.revenue_actual ?? null, result?.revenue_estimate ?? null);
  const resultStatus = reactionObserved ? "IMPACT_OBSERVED" : !result?.reported ? "SCHEDULED" : "REPORTED_WAITING_REACTION";
  const resultSummary = epsSurprise === null ? "EPS比较数据不完整" : `EPS${epsSurprise >= 0 ? "高于" : "低于"}预期${Math.abs(epsSurprise).toFixed(1)}%`;
  const why = resultStatus === "SCHEDULED" ? "即将公布，事件跳空风险需要单独门禁" : resultStatus === "REPORTED_WAITING_REACTION" ? `${resultSummary}；等待首个完整常规交易日收盘验证价格影响` : `${resultSummary}；财报前后常规交易日价格${returnPct! >= 0 ? "上涨" : "下跌"}${Math.abs(returnPct!).toFixed(2)}%（仅为同期反应，不自动推断因果）`;
  return {
    symbol, scheduled_for: scheduled, session, source: event.source, evidence_state: event.event_evidence_state, result_status: resultStatus,
    eps_actual: result?.eps_actual ?? null, eps_estimate: result?.eps_estimate ?? null, eps_surprise_pct: epsSurprise,
    revenue_actual: result?.revenue_actual ?? null, revenue_estimate: result?.revenue_estimate ?? null, revenue_surprise_pct: revenueSurprise,
    reaction: { status: reactionObserved ? "OBSERVED" : "NOT_OBSERVED", from_session: before?.date ?? null, to_session: after?.date ?? null, return_pct: returnPct, source: "ROBINHOOD_OFFICIAL_TRADING_MCP" },
    why_watch: why,
    missing_confirmation: resultStatus === "SCHEDULED" ? ["等待官方财报结果", "等待财报后完整常规交易日价格"] : resultStatus === "REPORTED_WAITING_REACTION" ? ["等待财报后完整常规交易日价格"] : [],
    next_check: resultStatus === "SCHEDULED" ? `${eventDate} ${session === "BMO" ? "开盘后" : session === "AMC" ? "收盘后" : "财报公布后"}` : resultStatus === "REPORTED_WAITING_REACTION" ? "下一个常规交易日收盘后" : "下一自然TS槽复核影响是否延续",
  };
}

async function collectApprovedCapabilities(session: McpSession, observedAt: string, marketIntelligence?: Pick<MarketIntelligenceState, "events" | "causalChains">, primaryReady: Promise<unknown> = Promise.resolve()): Promise<{ approved: Omit<ApprovedCapabilitySnapshot, "real_positions">; extended: NonNullable<MarketEnvironment["extended_hours"]>; errors: ReadonlyMarketSources["errors"] }> {
  const marketSession = robinhoodMarketSession(observedAt);
  const failures = new Map<string, string>();
  const fetchBatches = async (pool: readonly string[], tool: "get_equity_quotes" | "get_equity_historicals", args: (symbols: string[]) => Record<string, unknown>) => {
    const results = await Promise.allSettled(batches([...pool], 10).map((symbols) => session.call(tool, args(symbols)).then(robinhoodResponseBody)));
    for (const result of results) if (result.status === "rejected") failures.set(`watch_pool:${tool}:${String(args([]).interval ?? "quotes")}`, safeError(result.reason instanceof Error ? result.reason.message : result.reason));
    return results.flatMap((result) => result.status === "fulfilled" ? dataRows(result.value, "results") : []);
  };
  const historySpecs = [
    ["daily", "day", 180], ["four_hour", "4hour", 90], ["one_hour", "hour", 30], ["thirty_minute", "30minute", 15],
  ] as const;
  const fetchPool = (pool: readonly string[]) => Promise.all([
    fetchBatches(pool, "get_equity_quotes", (symbols) => ({ symbols })),
    fetchBatches(pool, "get_equity_historicals", (symbols) => ({ symbols, start_time: new Date(Date.parse(observedAt) - 10 * 86_400_000).toISOString(), end_time: observedAt, interval: "30minute", bounds: "24_5", adjustment_type: "split" })),
    ...historySpecs.map(([, interval, days]) => fetchBatches(pool, "get_equity_historicals", (symbols) => ({ symbols, start_time: new Date(Date.parse(observedAt) - days * 86_400_000).toISOString(), end_time: observedAt, interval, bounds: "regular", adjustment_type: "split" }))),
  ]);
  const coreGroups = await fetchPool(APPROVED_CORE70);
  // Expansion shares the existing deadline and starts after core options/account evidence.
  await primaryReady;
  const extraGroups = await fetchPool(APPROVED_EXTRA_STOCKS);
  const [quoteRows, extendedRows, ...historyGroups] = coreGroups.map((group, index) => [...group, ...extraGroups[index]]);
  const histories = Object.fromEntries(historySpecs.map(([key], index) => [key, new Map(historyGroups[index].map((row) => [String(row.symbol), row]))])) as Record<keyof FixedHistory, Map<string, Record<string, unknown>>>;
  const fixedRows = APPROVED_UNIVERSE.map((symbol) => fixed70Structure(symbol, quoteRows.find((item) => object(item.quote).symbol === symbol), { daily: histories.daily.get(symbol), four_hour: histories.four_hour.get(symbol), one_hour: histories.one_hour.get(symbol), thirty_minute: histories.thirty_minute.get(symbol) }, observedAt, marketSession));
  const observed = fixedRows.filter((row) => row.status !== "DATA_BLOCKED"), missing = APPROVED_UNIVERSE.filter((symbol) => !observed.some((row) => row.symbol === symbol));
  const fixedStatus: MarketDataStatus = missing.length ? "DATA_BLOCKED" : observed.some((row) => row.status === "STALE") ? "STALE" : marketSession.state === "CLOSED" ? "MARKET_CLOSED" : "LIVE";
  const news = marketIntelligence?.events.filter((event) => event.kind === "NEWS") ?? [];
  const chains = new Map((marketIntelligence?.causalChains ?? []).map((chain) => [chain.event_fingerprint, chain]));
  const eventItems = news.map((event) => ({ event, affectedSymbols: inferNewsSymbols(event.title, event.affected_symbols) })).filter(({ event, affectedSymbols }) => event.importance === "MARKET_MOVING" || affectedSymbols.length).slice(0, 20).map(({ event, affectedSymbols }) => {
    const chain = event.event_fingerprint ? chains.get(event.event_fingerprint) : undefined;
    return { event_id: event.event_id, title: event.title, source: event.source, published_at: event.published_at, importance: event.importance, affected_symbols: affectedSymbols, evidence_state: chain?.event_evidence_state ?? event.event_evidence_state, impact_mapping: chain?.affected ?? affectedSymbols };
  });
  const fixed = new Set<string>(APPROVED_UNIVERSE), verifiedDiscovery = eventItems.filter((item) => item.importance === "MARKET_MOVING" && item.evidence_state === "VERIFIED").flatMap((item) => item.impact_mapping).filter((symbol) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) && !fixed.has(symbol));
  const discovery = [...new Set(verifiedDiscovery)].slice(0, 12);
  const earningsByRelease = new Map<string, MarketEvent>();
  for (const event of (marketIntelligence?.events ?? []).filter((item) => item.kind === "EARNINGS" && item.scheduled_for && item.affected_symbols.length && fixed.has(item.affected_symbols[0]) && Date.parse(item.scheduled_for!) >= Date.parse(observedAt) - 7 * 86_400_000 && Date.parse(item.scheduled_for!) <= Date.parse(observedAt) + 7 * 86_400_000)) {
    const key = `${event.affected_symbols[0]}:${event.scheduled_for!.slice(0, 10)}`, previous = earningsByRelease.get(key);
    if (!previous || event.earnings_result?.reported && !previous.earnings_result?.reported || event.fetched_at > previous.fetched_at) earningsByRelease.set(key, event);
  }
  const earnings = [...earningsByRelease.values()].sort((left, right) => left.scheduled_for!.localeCompare(right.scheduled_for!)).slice(0, 20).map((event) => earningsCenterItem(event, histories.daily.get(event.affected_symbols[0]), observedAt, marketSession));
  const stageRank = { CONFIRMED: 3, EARLY_WATCH: 2, WAIT: 1, EXTENDED: 0, INVALIDATED: 0, DATA_BLOCKED: 0 } as const;
  const candidates = observed.filter((row) => ["CONFIRMED", "EARLY_WATCH"].includes(row.swing.stage)).sort((left, right) => stageRank[right.swing.stage] - stageRank[left.swing.stage] || right.swing.aligned_timeframes - left.swing.aligned_timeframes || (right.confidence ?? 0) - (left.confidence ?? 0)).slice(0, 5).map((row) => row.symbol);
  return { approved: {
    contract_version: "v3", component: "APPROVED_CAPABILITY_SNAPSHOT", mode: "SHADOW", actionable: false, generated_at: observedAt, source: "ROBINHOOD_OFFICIAL_TRADING_MCP",
    fixed_pool: { status: fixedStatus, data_grade: "OFFICIAL_READONLY_MULTI_TIMEFRAME_SWING", universe_size: 90, observed_count: observed.length, missing_symbols: [...missing], rows: fixedRows, breadth: { bullish: observed.filter((row) => row.direction === "BULLISH").length, bearish: observed.filter((row) => row.direction === "BEARISH").length, range: observed.filter((row) => row.direction === "RANGE").length, advance_pct: observed.length ? Math.round(observed.filter((row) => (row.change_pct ?? 0) > 0).length / observed.length * 1_000) / 10 : null }, candidates, qualification: "MULTI_TIMEFRAME_SWING_RESEARCH", missing_gates: ["1/3/5分钟执行确认、VWAP、EMA9与OR15", "逐标的期权流动性与预算", "事件风险最终门禁"] },
    owner_watchlist: { status: OWNER_WATCHLIST.length ? "OBSERVED" : "NOT_OBSERVED", items: [...OWNER_WATCHLIST], reason: OWNER_WATCHLIST.length ? "用户自行设置的研究观察优先级" : "尚未设置个人观察列表" },
    earnings_center: { status: earnings.length ? "OBSERVED" : "NOT_OBSERVED", items: earnings, limitation: "Finnhub提供官方财报日历、实际值与预期值；Robinhood只读日线验证财报前后价格反应。同期反应不是自动因果结论。" },
    event_scan: { status: eventItems.length ? "OBSERVED" : "NOT_OBSERVED", items: eventItems },
    extended_discovery: { status: discovery.length ? "OBSERVED" : "NOT_OBSERVED", ttl_days: 7, max_symbols: 12, symbols: discovery, reason: discovery.length ? "仅纳入已核验重大事件且不属于当前观察池的明确影响标的" : "当前没有同时满足已核验重大事件、明确影响标的和当前观察池之外三个条件的临时发现" },
    provenance: [
      { capability: "固定股票池定义；见包内app/snapshot-import.ts", repository: "BUNDLED_REVIEWED_SOURCE", commit: "8387bb1", path: "system_d/system_d/fixed70_opportunity_radar.py" },
      { capability: "System A技术结构", repository: "BUNDLED_REVIEWED_SOURCE", commit: "fc67147", path: "system_d/system_d/technical_structure.py" },
      { capability: "Extended Discovery与Event Scan", repository: "BUNDLED_REVIEWED_SOURCE", commit: "d48e387", path: "system_d/system_d/market_event_pool.py" },
    ],
  }, extended: extendedHours(quoteRows, extendedRows, observedAt), errors: [...failures].map(([scope, message]) => ({ code: "ENHANCEMENT_FAILED", scope, message })) };
}

function extendedHours(quoteRows: Record<string, unknown>[], historyRows: Record<string, unknown>[], observedAt: string): NonNullable<MarketEnvironment["extended_hours"]> {
  const current = robinhoodSessionAt(observedAt), targetDate = current.trading_date;
  const instruments = APPROVED_UNIVERSE.map((symbol) => {
    const quote = object(quoteRows.find((item) => object(item.quote).symbol === symbol)?.quote);
    const allBars = completeMarketBars(rows((historyRows.find((item) => item.symbol === symbol) ?? {}).bars));
    const targetBars = allBars.filter((bar) => bar.trading_date === targetDate);
    const latestBar = targetBars.at(-1) ?? allBars.at(-1) ?? null;
    const sampledAsOf = iso(quote.venue_last_non_reg_trade_time), sampledPrice = number(quote.last_non_reg_trade_price);
    const sampledSession = sampledAsOf ? robinhoodSessionAt(sampledAsOf) : null;
    const previousClose = number(quote.previous_close), hasCurrentBars = targetBars.length > 0, hasHistory = allBars.length > 0;
    const capability = hasCurrentBars ? "OFFICIAL_OHLCV" as const : hasHistory ? "RECENT_EOD" as const : sampledAsOf && sampledPrice !== null ? "LOCAL_SAMPLED_QUOTE" as const : "READ_FAILED" as const;
    const asOf = latestBar?.begins_at ?? sampledAsOf, price = latestBar?.close ?? sampledPrice;
    const session = latestBar?.session ?? sampledSession?.phase ?? null;
    const status = capability === "READ_FAILED" ? "DATA_BLOCKED" as const : capability === "LOCAL_SAMPLED_QUOTE" && sampledSession?.trading_date !== targetDate ? "STALE" as const : "OBSERVED" as const;
    const overnightBars = targetBars.filter((bar) => bar.session === "OVERNIGHT");
    const previousRegularDates = [...new Set(allBars.filter((bar) => bar.session === "REGULAR" && bar.trading_date < targetDate).map((bar) => bar.trading_date))].sort();
    const previousRegularDate = previousRegularDates.at(-1), previousRegular = allBars.filter((bar) => bar.session === "REGULAR" && bar.trading_date === previousRegularDate);
    const overnightOpen = overnightBars[0]?.open ?? null, overnightHigh = overnightBars.length ? Math.max(...overnightBars.map((bar) => bar.high)) : null, overnightLow = overnightBars.length ? Math.min(...overnightBars.map((bar) => bar.low)) : null, overnightLast = overnightBars.at(-1)?.close ?? null;
    const previousHigh = previousRegular.length ? Math.max(...previousRegular.map((bar) => bar.high)) : null, previousLow = previousRegular.length ? Math.min(...previousRegular.map((bar) => bar.low)) : null;
    return {
      symbol, session, status, capability, trading_date: targetDate, as_of: asOf, price, previous_close: previousClose,
      change_pct: price !== null && previousClose ? Math.round((price - previousClose) / previousClose * 100_000) / 1_000 : null, bar_count: targetBars.length,
      overnight: {
        status: overnightBars.length ? "OBSERVED" as const : "NOT_OBSERVED" as const, open: overnightOpen, high: overnightHigh, low: overnightLow, last: overnightLast,
        volume: overnightBars.some((bar) => bar.volume !== null) ? overnightBars.reduce((total, bar) => total + (bar.volume ?? 0), 0) : null,
        direction: overnightLast === null || previousClose === null ? "NOT_OBSERVED" as const : overnightLast > previousClose ? "UP" as const : overnightLast < previousClose ? "DOWN" as const : "FLAT" as const,
        gap_pct: overnightLast !== null && previousClose ? Math.round((overnightLast - previousClose) / previousClose * 100_000) / 1_000 : null,
        previous_regular_high: previousHigh, previous_regular_low: previousLow,
        broke_previous_high: overnightHigh === null || previousHigh === null ? null : overnightHigh > previousHigh,
        broke_previous_low: overnightLow === null || previousLow === null ? null : overnightLow < previousLow,
        confirmation: "隔夜仅作低置信度背景；开盘后必须用常规时段价格、VWAP、成交量和真实期权 Bid/Ask 重新确认。",
      },
    };
  });
  const coverage = {
    official_ohlcv: instruments.filter((item) => item.capability === "OFFICIAL_OHLCV").length,
    local_sampled_quote: instruments.filter((item) => item.capability === "LOCAL_SAMPLED_QUOTE").length,
    recent_eod: instruments.filter((item) => item.capability === "RECENT_EOD").length,
    not_supported: 0,
    read_failed: instruments.filter((item) => item.capability === "READ_FAILED").length,
  };
  const coreFailed = instruments.some((item) => (item.symbol === "SPY" || item.symbol === "QQQ") && item.status === "DATA_BLOCKED");
  return {
    status: coreFailed ? "DATA_BLOCKED" : instruments.some((item) => item.status === "OBSERVED") ? "OBSERVED" : instruments.some((item) => item.status === "STALE") ? "STALE" : "NOT_OBSERVED",
    source: "ROBINHOOD_OFFICIAL_TRADING_MCP", as_of: oldest(instruments.map((item) => item.as_of)), data_grade: "OFFICIAL_READONLY_24_5_OHLCV", universe_version: "OWNER_90_V1", error: coreFailed ? "SPY 或 QQQ 官方 24_5 K线读取失败" : null,
    phase: current.phase, trading_date: targetDate, coverage, risk_boundary: { confidence: "LOW", can_override_regular_regime: false, can_generate_option_order: false, requires_regular_open_confirmation: true }, instruments,
  };
}

function marketEnvironment(quoteRows: Record<string, unknown>[], observedAt: string, marketSession: ReadonlyMarketSources["market_session"], extended: NonNullable<MarketEnvironment["extended_hours"]>): MarketEnvironment {
  const environmentSymbols = [...MARKET_ENVIRONMENT_SYMBOLS.rates, ...MARKET_ENVIRONMENT_SYMBOLS.oil, ...MARKET_ENVIRONMENT_SYMBOLS.sectors];
  const instruments = environmentSymbols.map((symbol): MarketEnvironmentQuote => {
    const quote = object(quoteRows.find((item) => object(item.quote).symbol === symbol)?.quote);
    const asOf = iso(quote.venue_last_trade_time ?? quote.updated_at);
    const age = freshness(asOf, observedAt);
    const last = number(quote.last_trade_price), previousClose = number(quote.previous_close);
    const status: MarketDataStatus = last === null || previousClose === null || asOf === null ? "DATA_BLOCKED" : marketSession.state === "CLOSED" ? currentEod(asOf, observedAt) ? "MARKET_CLOSED" : "STALE" : age === null || age > MARKET_5M_MAX_AGE_SECONDS ? "STALE" : "LIVE";
    return {
      symbol,
      role: (MARKET_ENVIRONMENT_SYMBOLS.rates as readonly string[]).includes(symbol) ? "RATES_PROXY" : (MARKET_ENVIRONMENT_SYMBOLS.oil as readonly string[]).includes(symbol) ? "OIL_PROXY" : "SECTOR",
      instrument: "ETF_PROXY", source: "ROBINHOOD", status, as_of: asOf, freshness_seconds: age,
      last, previous_close: previousClose, change_pct: last !== null && previousClose ? Math.round((last - previousClose) / previousClose * 100_000) / 1_000 : null,
    };
  });
  const rates = instruments.filter((item) => item.role === "RATES_PROXY"), oil = instruments.filter((item) => item.role === "OIL_PROXY"), sectors = instruments.filter((item) => item.role === "SECTOR");
  const groupStatus = (values: MarketEnvironmentQuote[]): MarketDataStatus => values.some((item) => item.status === "DATA_BLOCKED") ? "DATA_BLOCKED" : values.some((item) => item.status === "STALE") ? "STALE" : values.every((item) => item.status === "MARKET_CLOSED") ? "MARKET_CLOSED" : "LIVE";
  const advancing = sectors.every((item) => item.change_pct !== null) ? sectors.filter((item) => item.change_pct! > 0).length : null;
  const declining = advancing === null ? null : sectors.filter((item) => item.change_pct! < 0).length;
  const unchanged = advancing === null ? null : sectors.length - advancing - declining!;
  const status = groupStatus(instruments);
  return {
    contract_version: "v1", component: "MARKET_ENVIRONMENT", mode: "SHADOW", status,
    as_of: oldest(instruments.map((item) => item.as_of)),
    futures: { status: "NOT_SUPPORTED", source: null, as_of: null, error: "Robinhood 官方 Trading MCP 当前没有期货只读工具" },
    rates: { status: groupStatus(rates), interpretation: "ETF_PROXY_NOT_YIELD", instruments: rates },
    oil: { status: groupStatus(oil), interpretation: "ETF_PROXY_NOT_SPOT_OR_FUTURES", instruments: oil },
    sector_breadth: { status: groupStatus(sectors), interpretation: "SECTOR_ETF_ADVANCE_DECLINE", advancing, declining, unchanged, advance_pct: advancing === null ? null : Math.round(advancing / sectors.length * 1_000) / 10, instruments: sectors },
    extended_hours: extended,
    capabilities: { futures: false, rates_proxy: rates.every((item) => !["DATA_BLOCKED", "STALE"].includes(item.status)), oil_proxy: oil.every((item) => !["DATA_BLOCKED", "STALE"].includes(item.status)), sector_breadth: sectors.every((item) => !["DATA_BLOCKED", "STALE"].includes(item.status)), extended_hours: extended.status === "OBSERVED" },
    data_gaps: ["OVERNIGHT_FUTURES_NOT_SUPPORTED_BY_OFFICIAL_ROBINHOOD_MCP", ...(extended.status === "OBSERVED" ? [] : ["EXTENDED_HOURS_NOT_OBSERVED"]), ...(extended.coverage?.not_supported ? ["XSP_24_5_NOT_SUPPORTED"] : []), ...(extended.coverage?.read_failed ? ["FIXED70_EXTENDED_HOURS_READ_FAILED"] : [])],
  };
}

export function selectChartSessions<T extends { begins_at: string }>(bars: T[], range: RobinhoodChartRange) {
  const tradingDate = (bar: T) => "trading_date" in bar && typeof bar.trading_date === "string" ? bar.trading_date : robinhoodSessionAt(bar.begins_at).trading_date;
  const session = (bar: T) => "session" in bar && typeof bar.session === "string" ? bar.session : robinhoodSessionAt(bar.begins_at).phase;
  const allDates = [...new Set(bars.map(tradingDate))].sort(), latestAt = Math.max(...bars.map((bar) => Date.parse(bar.begins_at)).filter(Number.isFinite));
  let selected: T[];
  if (range === "24h") selected = bars.filter((bar) => Date.parse(bar.begins_at) >= latestAt - 86_400_000);
  else if (range === "rth") {
    const date = bars.filter((bar) => session(bar) === "REGULAR").map(tradingDate).sort().at(-1);
    selected = date ? bars.filter((bar) => tradingDate(bar) === date && session(bar) === "REGULAR") : [];
  } else if (range === "gth") {
    const date = allDates.at(-1), priorDate = allDates.at(-2), latestSession = bars.at(-1) ? session(bars.at(-1)!) : "CLOSED";
    selected = bars.filter((bar) => session(bar) === "OVERNIGHT" && tradingDate(bar) === date || session(bar) === "AFTER_HOURS" && (tradingDate(bar) === date || latestSession === "OVERNIGHT" && tradingDate(bar) === priorDate));
  }
  else {
    const dates = allDates.slice(range === "1d" ? -1 : -5);
    selected = bars.filter((bar) => dates.includes(tradingDate(bar)));
  }
  return { bars: selected, dates: [...new Set(selected.map(tradingDate))].sort() };
}

export const MARKET_CHART_MAX_AGE_SECONDS = { "1m": 360, "5m": MARKET_5M_MAX_AGE_SECONDS, "15m": 1_200 } as const;

export async function collectRobinhoodMarketChart(session: McpSession, symbol: "SPY" | "QQQ", interval: RobinhoodChartInterval, observedAt = new Date().toISOString(), range: RobinhoodChartRange = "1d"): Promise<RobinhoodChartData> {
  const start = new Date(Date.parse(observedAt) - (range === "5d" ? 10 : 3) * 24 * 60 * 60 * 1_000).toISOString();
  const requestedInterval = interval === "1m" ? "minute" : "5minute";
  const [quoteBody, historyBody] = await Promise.all([
    session.call("get_equity_quotes", { symbols: [symbol] }).then(robinhoodResponseBody),
    session.call("get_equity_historicals", { symbols: [symbol], start_time: start, end_time: observedAt, interval: requestedInterval, bounds: "24_5", adjustment_type: "split" }).then(robinhoodResponseBody),
  ]);
  const quote = object(dataRows(quoteBody, "results").find((item) => object(item.quote).symbol === symbol)?.quote);
  const history = dataRows(historyBody, "results").find((item) => item.symbol === symbol) ?? {};
  let officialBars = completeMarketBars(rows(history.bars)), fallback = false;
  if (!officialBars.length) {
    const fallbackBody = robinhoodResponseBody(await session.call("get_equity_historicals", { symbols: [symbol], start_time: start, end_time: observedAt, interval: requestedInterval, bounds: "regular", adjustment_type: "split" }));
    officialBars = completeMarketBars(rows((dataRows(fallbackBody, "results").find((item) => item.symbol === symbol) ?? {}).bars));
    fallback = officialBars.length > 0;
  }
  const selected = selectChartSessions(officialBars, range);
  const directBars = selected.bars;
  const bars = interval === "15m" ? fifteenMinuteBars(directBars) : directBars;
  const quoteAsOf = iso(quote.venue_last_trade_time ?? quote.updated_at);
  const barAsOf = completedBarAt((interval === "15m" ? directBars : bars).at(-1)?.begins_at, interval === "1m" ? 1 : 5);
  const asOf = barAsOf ?? quoteAsOf;
  const quoteAge = freshness(quoteAsOf, observedAt), barAge = freshness(barAsOf, observedAt), age = barAge ?? quoteAge;
  const currentPrice = selected.bars.at(-1)?.close ?? number(quote.last_trade_price);
  const marketSession = robinhoodMarketSession(observedAt);
  const complete = bars.length > 0 && currentPrice !== null;
  const phase = marketSession.phase, viewActive = range === "rth" ? phase === "REGULAR" : range === "gth" ? phase === "AFTER_HOURS" || phase === "OVERNIGHT" : phase !== "CLOSED", maxAge = MARKET_CHART_MAX_AGE_SECONDS[interval];
  const status = !complete ? "DATA_BLOCKED" : fallback ? viewActive ? "STALE" : currentEod(asOf, observedAt) ? "MARKET_CLOSED" : "STALE" : viewActive ? age === null || age > maxAge ? "STALE" : "LIVE" : "MARKET_CLOSED";
  const sourceGap = officialBars.length > 0 && bars.length === 0;
  return {
    source: "ROBINHOOD", symbol, interval, range, session_bounds: fallback ? "REGULAR_ONLY_EOD_FALLBACK" : "OFFICIAL_24_5", data_grade: fallback ? "RECENT_OFFICIAL_EOD" : "OFFICIAL_OHLCV", session_dates: selected.dates, status, as_of: asOf, freshness_seconds: age,
    quote_as_of: quoteAsOf, quote_freshness_seconds: quoteAge, bar_as_of: barAsOf, bar_freshness_seconds: barAge, gap_status: sourceGap ? "SOURCE_GAP" : null,
    market_session: marketSession, current_price: currentPrice, bars,
    error: sourceGap ? `SOURCE_GAP：官方源没有返回${range === "rth" ? "RTH" : range === "gth" ? "盘后/GTH" : "所选范围"}K线` : status === "DATA_BLOCKED" ? "Robinhood 官方只读行情缺少报价和 K 线" : fallback ? "24_5 K线读取失败；仅显示最近可用常规时段 EOD" : status === "STALE" ? `Robinhood 官方K线已超过${maxAge}秒新鲜度阈值` : null,
  };
}

async function collectMarketOptions(session: McpSession, observedAt: string, prices: Record<string, number | null>): Promise<ReadonlyMarketSources["options"]> {
  const symbols = ["SPY", "QQQ"] as const;
  const marketSession = robinhoodMarketSession(observedAt);
  const start = new Date(Date.parse(observedAt) - 7 * 86_400_000).toISOString();
  const optionSeeds: Array<{ symbol: "SPY" | "QQQ"; option_type: "call" | "put"; expiration: string; strike: number; id: string }> = [];
  const chainCounts = new Map<string, { expiration_count: number; expirations: string[]; nearest_expiration: string | null; contract_count: number }>();
  const chainBodies = await Promise.all(symbols.map((symbol) => session.call("get_option_chains", { underlying_symbol: symbol }).then(robinhoodResponseBody)));
  for (const [index, symbol] of symbols.entries()) {
    const chainBody = chainBodies[index];
    const chain = dataRows(chainBody, "chains").find((item) => item.symbol === symbol) ?? {};
    const expirations = (Array.isArray(chain.expiration_dates) ? chain.expiration_dates : []).filter((value): value is string => typeof value === "string").sort();
    const expiration = expirations.find((value) => value >= marketSession.market_date) ?? null;
    const selectedExpirations = [...new Set([...representativeOptionExpirations(expirations, marketSession.market_date), ...(expiration ? [expiration] : [])])];
    const spot = prices[symbol];
    if (expiration && spot !== null) {
      const requests = (selectedExpirations.length ? selectedExpirations : [expiration]).flatMap((expiry) => [Math.round(spot) - 1, Math.round(spot), Math.round(spot) + 1].map((strikePrice) => ({ chain_symbol: symbol, expiration_dates: expiry, strike_price: strikePrice.toFixed(4), state: "active" })));
      // Independent reads share a four-request cap; Promise.all preserves the original selection order.
      for (const batch of batches(requests, 4)) {
        const instrumentBodies = await Promise.all(batch.map((args) => session.call("get_option_instruments", args).then(robinhoodResponseBody)));
        for (const instrumentBody of instrumentBodies) {
          const instruments = dataRows(instrumentBody, "instruments");
          for (const optionType of ["call", "put"] as const) {
            const instrument = instruments.find((item) => item.type === optionType);
            const id = text(instrument?.id), strike = number(instrument?.strike_price), instrumentExpiration = text(instrument?.expiration_date);
            if (id && strike !== null && instrumentExpiration && !optionSeeds.some((item) => item.id === id)) optionSeeds.push({ symbol, option_type: optionType, expiration: instrumentExpiration, strike, id });
          }
        }
      }
    }
    chainCounts.set(symbol, { expiration_count: expirations.length, expirations, nearest_expiration: expiration, contract_count: optionSeeds.filter((item) => item.symbol === symbol).length });
  }
  const optionIds = optionSeeds.map((item) => item.id);
  const nearestOptionIds = optionSeeds.filter((item) => item.expiration === chainCounts.get(item.symbol)?.nearest_expiration).map((item) => item.id);
  const quoteAndHistoryReads = optionIds.length ? [
    () => session.call("get_option_quotes", { instrument_ids: optionIds }).then(robinhoodResponseBody),
    ...batches(nearestOptionIds, 4).map((batch) => () => session.call("get_option_historicals", { instrument_ids: batch, start_time: start, end_time: observedAt, interval: "30minute", bounds: "regular" }).then(robinhoodResponseBody)),
  ] : [];
  const quoteAndHistoryBodies: Record<string, unknown>[] = [];
  for (const batch of batches(quoteAndHistoryReads, 4)) quoteAndHistoryBodies.push(...await Promise.all(batch.map((read) => read())));
  const optionQuoteBody = quoteAndHistoryBodies[0] ?? {};
  const optionQuoteMap = new Map(dataRows(optionQuoteBody, "results").map((item) => [text(object(item.quote).instrument_id), object(item.quote)]));
  const optionHistoryRows = quoteAndHistoryBodies.slice(1).flatMap((body) => dataRows(body, "results"));
  const optionHistoryMap = new Map(optionHistoryRows.map((item) => [text(item.instrument_id), item]));
  return symbols.map((symbol) => {
    const chain = chainCounts.get(symbol) ?? { expiration_count: 0, expirations: [], nearest_expiration: null, contract_count: 0 };
    const contracts = optionSeeds.filter((item) => item.symbol === symbol).map(({ id, option_type, expiration, strike }) => {
      const quote = optionQuoteMap.get(id) ?? {};
      const history = optionHistoryMap.get(id) ?? {};
      const historyBars = rows(history.bars);
      return {
        contract_id: id, option_type, expiration, strike, bid: number(quote.bid_price), ask: number(quote.ask_price), mark: number(quote.mark_price), volume: number(quote.volume), open_interest: number(quote.open_interest), iv: number(quote.implied_volatility),
        delta: number(quote.delta), gamma: number(quote.gamma), theta: number(quote.theta), vega: number(quote.vega), as_of: iso(quote.updated_at),
        history_bars: historyBars.length, history_as_of: iso(historyBars.at(-1)?.begins_at),
      };
    });
    const asOf = oldest(contracts.map((contract) => contract.as_of));
    const age = freshness(asOf, observedAt);
    return {
      source: "ROBINHOOD" as const, symbol, status: "DATA_BLOCKED" as const,
      as_of: asOf, freshness_seconds: age, ...chain,
      bbo_count: contracts.filter((item) => item.bid !== null && item.ask !== null).length,
      iv_count: contracts.filter((item) => item.iv !== null).length,
      greeks_count: contracts.filter((item) => [item.delta, item.gamma, item.theta, item.vega].every((value) => value !== null)).length,
      contracts,
    };
  });
}

export async function collectRobinhoodReadonly(session: McpSession, observedAt = new Date().toISOString(), marketIntelligence?: Pick<MarketIntelligenceState, "events" | "causalChains">, previousApprovedCapabilities?: ApprovedCapabilitySnapshot | null, freezeDeadlineAt?: string, onTiming?: RobinhoodTimingObserver): Promise<ReadonlyMarketSources> {
  const symbols = ["SPY", "QQQ"] as const;
  const environmentSymbols = [...MARKET_ENVIRONMENT_SYMBOLS.rates, ...MARKET_ENVIRONMENT_SYMBOLS.oil, ...MARKET_ENVIRONMENT_SYMBOLS.sectors];
  const start = new Date(Date.parse(observedAt) - 7 * 24 * 60 * 60 * 1_000).toISOString();
  const dailyStart = new Date(Date.parse(observedAt) - 120 * 24 * 60 * 60 * 1_000).toISOString();
  const marketSession = robinhoodMarketSession(observedAt);
  const enhancementErrors: ReadonlyMarketSources["errors"] = [];
  const enhancementFailed = (scope: string, error: unknown) => { enhancementErrors.push({ code: "ENHANCEMENT_FAILED", scope, message: safeError(error instanceof Error ? error.message : error) }); return null; };
  const coreStarted = performance.now();
  emitTiming(onTiming, { event: "core_begin" });
  const parseCore = (response: ToolCallResponse) => {
    const started = performance.now();
    emitTiming(onTiming, { event: "core_parse_begin" });
    try { return robinhoodResponseBody(response); }
    finally { emitTiming(onTiming, { event: "core_parse_end", duration_ms: performance.now() - started }); }
  };
  // Required evidence finishes before optional requests can occupy the MCP transport.
  const [quoteBody, historyBody, dailyHistoryBody] = await Promise.all([
    session.call("get_equity_quotes", { symbols }).then(parseCore),
    session.call("get_equity_historicals", { symbols, start_time: start, end_time: observedAt, interval: "5minute", bounds: "regular", adjustment_type: "split" }).then(parseCore),
    session.call("get_equity_historicals", { symbols, start_time: dailyStart, end_time: observedAt, interval: "day", bounds: "regular", adjustment_type: "split" }).then(parseCore),
  ]);
  const quoteRows = dataRows(quoteBody, "results");
  const quotes = symbols.map((symbol) => {
    const quote = object(quoteRows.find((item) => object(item.quote).symbol === symbol)?.quote);
    const asOf = iso(quote.venue_last_trade_time ?? quote.updated_at);
    const age = freshness(asOf, observedAt);
    return { source: "ROBINHOOD" as const, symbol, status: "DATA_BLOCKED" as const, as_of: asOf, freshness_seconds: age, last: number(quote.last_trade_price), bid: number(quote.bid_price), ask: number(quote.ask_price), previous_close: number(quote.previous_close) };
  });

  const historyRows = dataRows(historyBody, "results");
  const dailyHistoryRows = dataRows(dailyHistoryBody, "results");
  const bars = symbols.map((symbol) => {
    const history = historyRows.find((item) => item.symbol === symbol) ?? {};
    const rawValues = rows(history.bars);
    const rawDaily = rows((dailyHistoryRows.find((item) => item.symbol === symbol) ?? {}).bars);
    const values = rawValues.map(marketBar).filter((item) => item.begins_at);
    const daily = rawDaily.map(marketBar).filter((item) => item.begins_at);
    const latest = values.at(-1) ?? null;
    const asOf = completedBarAt(latest?.begins_at, 5);
    const age = freshness(asOf, observedAt);
    return {
      source: "ROBINHOOD" as const, symbol, interval: "5min" as const, status: "DATA_BLOCKED" as const,
      as_of: asOf, freshness_seconds: age, bar_count: values.length, daily_bar_count: daily.length,
      latest: latest ? { open: latest.open, high: latest.high, low: latest.low, close: latest.close, volume: latest.volume } : null,
      values, daily,
    };
  });

  emitTiming(onTiming, { event: "core_end", duration_ms: performance.now() - coreStarted });
  // ponytail: share one existing 60s RPC timeout across all enhancements, not one per
  // sequential call. Leave 5s for snapshot hashing, transport closure and A1 persistence;
  // the hard slot deadline is unchanged. Split collection if natural coverage remains insufficient.
  const budgetMs = freezeDeadlineAt === undefined ? 60_000 : Math.max(0, Math.min(60_000, Date.parse(freezeDeadlineAt) - Date.now() - 5_000) || 0);
  const deadlineAt = Date.now() + budgetMs;
  const enhancementStarted = performance.now();
  let expired = budgetMs === 0;
  let timer: NodeJS.Timeout;
  const deadlineError = new RobinhoodMcpError("ENHANCEMENT_DEADLINE: optional evidence missed its freeze budget");
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; emitTiming(onTiming, { event: "enhancement_budget_actual_expired", deadline_at: new Date(deadlineAt).toISOString(), duration_ms: performance.now() - enhancementStarted }); reject(deadlineError); }, budgetMs);
  });
  emitTiming(onTiming, { event: "enhancement_budget_begin", deadline_at: new Date(deadlineAt).toISOString(), budget_ms: budgetMs });
  const enhancementSession: McpSession = {
    listTools: () => session.listTools(),
    call: (tool, args) => Promise.race([expired || Date.now() >= deadlineAt ? Promise.reject(deadlineError) : session.call(tool, args), deadline]),
  };
  const environmentRead = Promise.all(batches(environmentSymbols, 10).map((batch) => enhancementSession.call("get_equity_quotes", { symbols: batch }).then(robinhoodResponseBody).catch((error) => { enhancementFailed("market_environment", error); return {}; }))).then((bodies) => bodies.flatMap((body) => dataRows(body, "results")));
  const optionsRead = collectMarketOptions(enhancementSession, observedAt, Object.fromEntries(quotes.map((quote) => [quote.symbol, quote.last]))).catch((error) => {
      enhancementFailed("options", error);
      return symbols.map((symbol) => ({ source: "ROBINHOOD" as const, symbol, status: "DATA_BLOCKED" as const, as_of: null, freshness_seconds: null, expiration_count: 0, expirations: [], nearest_expiration: null, contract_count: 0, bbo_count: 0, iv_count: 0, greeks_count: 0, contracts: [] }));
    });
  const accountRead = collectRobinhoodAccount(enhancementSession, observedAt).catch((error) => {
      enhancementFailed("account", error);
      return { source: "ROBINHOOD" as const, status: "DATA_BLOCKED" as const, as_of: null, freshness_seconds: null, account_count: null, positions: null, orders: null, portfolio_value: null, option_value: null, realized_pnl: null };
    });
  const primaryReady = Promise.all([environmentRead, optionsRead, accountRead]);
  const [environmentRows, capabilityBundle, options, account] = await Promise.all([
    environmentRead,
    collectApprovedCapabilities(enhancementSession, observedAt, marketIntelligence, primaryReady).catch((error) => enhancementFailed("watch_pool", error)),
    optionsRead,
    accountRead,
  ]).finally(() => { clearTimeout(timer); emitTiming(onTiming, { event: "enhancement_budget_completed", deadline_at: new Date(deadlineAt).toISOString(), duration_ms: performance.now() - enhancementStarted }); });
  enhancementErrors.push(...capabilityBundle?.errors ?? []);
  const environment = capabilityBundle ? marketEnvironment([...quoteRows, ...environmentRows], observedAt, marketSession, capabilityBundle.extended) : undefined;

  const providerAsOf = oldest([...quotes.map((item) => item.as_of), ...bars.map((item) => item.as_of)]);
  const providerAge = freshness(providerAsOf, observedAt);
  const capabilities = {
    quotes: quotes.length === symbols.length && quotes.every((item) => item.last !== null && item.bid !== null && item.ask !== null),
    intraday_bars: bars.length === symbols.length && bars.every((item) => item.bar_count > 0),
    daily_bars: bars.length === symbols.length && bars.every((item) => item.daily_bar_count >= 20),
    option_chain: options.length === symbols.length && options.every((item) => item.expiration_count > 0 && item.contracts.length >= 2),
    option_bbo: options.length === symbols.length && options.every((item) => item.bbo_count >= 2),
    option_iv: options.length === symbols.length && options.every((item) => item.iv_count >= 2),
    option_greeks: options.length === symbols.length && options.every((item) => item.greeks_count >= 2),
  };
  const errors = [...enhancementErrors, ...Object.entries(capabilities).filter(([, available]) => !available).map(([capability]) => ({ code: "CAPABILITY_UNAVAILABLE", scope: capability, message: `Robinhood read-only ${capability} is unavailable` }))];
  const complete = capabilities.quotes && capabilities.intraday_bars && capabilities.daily_bars;
  const eodCurrent = currentEod(providerAsOf, observedAt);
  if (complete && marketSession.state === "CLOSED" && !eodCurrent) errors.push({ code: "STALE_EOD", scope: "market_data", message: "Robinhood EOD does not match the latest completed NYSE session" });
  const status: ReadonlyMarketSources["status"] = !complete ? "DATA_BLOCKED" : marketSession.state === "CLOSED" ? eodCurrent ? "MARKET_CLOSED" : "STALE" : providerAge === null || providerAge > MARKET_5M_MAX_AGE_SECONDS ? "STALE" : "LIVE";
  const approvedCapabilities = capabilityBundle && environment ? applyFixed70SwingManagement({ ...capabilityBundle.approved, real_positions: { status: account.status !== "LIVE" ? "DATA_BLOCKED" as const : account.positions?.length ? "OBSERVED" as const : "NOT_OBSERVED" as const, count: account.status === "LIVE" ? account.positions?.length ?? 0 : null, symbols: [...new Set((account.positions ?? []).map((item) => item.symbol).filter((item): item is string => Boolean(item)))], source: "ROBINHOOD_OFFICIAL_TRADING_MCP" as const } }, previousApprovedCapabilities, environment) : undefined;
  const snapshot: Omit<ReadonlyMarketSources, "snapshot_id" | "snapshot_hash"> = {
    contract_name: "TRADING_OS_MARKET_DATA" as const, contract_version: "v1" as const, mode: "SHADOW" as const, status,
    generated_at: observedAt, as_of: providerAsOf, freshness_seconds: providerAge, market_session: marketSession, capabilities, errors,
    ...(environment ? { market_environment: environment, approved_capabilities: approvedCapabilities } : {}),
    providers: [
      { source: "TRADIER", status: "DISABLED_BACKUP", as_of: null, freshness_seconds: null, error: "账户已停用；适配器仅保留备用" },
      { source: "ROBINHOOD", status, as_of: providerAsOf, freshness_seconds: providerAge, error: status === "LIVE" || status === "MARKET_CLOSED" ? null : errors.map((item) => item.scope).join(", ") || "market data is stale" },
    ],
    quotes: quotes.map((item) => ({ ...item, status })), bars: bars.map((item) => ({ ...item, status })), options: options.map((item) => {
      const complete = item.expiration_count > 0 && item.contracts.length >= 2 && item.bbo_count >= 2 && item.iv_count >= 2 && item.greeks_count >= 2;
      const eodCurrent = currentEod(item.as_of, observedAt);
      const optionStatus: ReadonlyMarketSources["status"] = !complete ? "DATA_BLOCKED" : marketSession.state === "CLOSED" ? eodCurrent ? "MARKET_CLOSED" : "STALE" : item.freshness_seconds === null || item.freshness_seconds > MARKET_5M_MAX_AGE_SECONDS ? "STALE" : "LIVE";
      return { ...item, status: optionStatus };
    }),
    account,
    discrepancies: [],
  };
  const hashStarted = performance.now();
  emitTiming(onTiming, { event: "snapshot_hash_begin" });
  const snapshotHash = hash(snapshot);
  emitTiming(onTiming, { event: "snapshot_hash_end", duration_ms: performance.now() - hashStarted });
  const result = { ...snapshot, snapshot_id: `market-${snapshotHash.slice(0, 24)}`, snapshot_hash: snapshotHash };
  if (freezeDeadlineAt === undefined) return result;
  const freshnessStarted = performance.now(), checkedAt = new Date().toISOString();
  emitTiming(onTiming, { event: "freshness_begin" });
  try { return refreshCoreFreshness(result, checkedAt); }
  finally { emitTiming(onTiming, { event: "freshness_end", duration_ms: performance.now() - freshnessStarted }); }
}

export function refreshCoreFreshness(snapshot: ReadonlyMarketSources, checkedAt: string): ReadonlyMarketSources {
  const age = freshness(snapshot.as_of, checkedAt);
  const complete = snapshot.capabilities.quotes && snapshot.capabilities.intraday_bars && snapshot.capabilities.daily_bars;
  const sourceTimes = [...snapshot.quotes, ...snapshot.bars].map((row) => Date.parse(row.as_of ?? ""));
  const validTimes = Number.isFinite(Date.parse(checkedAt)) && sourceTimes.every((time) => Number.isFinite(time) && time <= Date.parse(checkedAt));
  const status = !complete || !validTimes ? "DATA_BLOCKED" : snapshot.market_session.state === "CLOSED" ? currentEod(snapshot.as_of, checkedAt) ? "MARKET_CLOSED" : "STALE" : age === null || age > MARKET_5M_MAX_AGE_SECONDS ? "STALE" : "LIVE";
  const updated: ReadonlyMarketSources = {
    ...snapshot, status, freshness_seconds: age,
    quotes: snapshot.quotes.map((row) => ({ ...row, status, freshness_seconds: freshness(row.as_of, checkedAt) })),
    bars: snapshot.bars.map((row) => ({ ...row, status, freshness_seconds: freshness(row.as_of, checkedAt) })),
    providers: snapshot.providers.map((row) => row.source === "ROBINHOOD" ? { ...row, status, freshness_seconds: age, error: status === "LIVE" || status === "MARKET_CLOSED" ? null : "Core Quote/Bar unavailable or stale at freeze" } : row),
  };
  const snapshotHash = hash(Object.fromEntries(Object.entries(updated).filter(([key]) => key !== "snapshot_hash" && key !== "snapshot_id")));
  return { ...updated, snapshot_hash: snapshotHash, snapshot_id: `market-${snapshotHash.slice(0, 24)}` };
}

export async function collectRobinhoodAccount(session: McpSession, observedAt?: string, scope: "FULL" | "POSITIONS" = "FULL"): Promise<ReadonlyMarketSources["account"]> {
  const checkedAt = observedAt ?? new Date().toISOString();
  const accountsBody = robinhoodResponseBody(await session.call("get_accounts", {}));
  const accountData = object(accountsBody.data), inventory = accountData.accounts ?? accountsBody.accounts ?? accountData.results ?? accountsBody.results;
  if (!Array.isArray(inventory) || inventory.some((account) => !text(object(account).account_number)) || new Set(inventory.map((account) => text(object(account).account_number))).size !== inventory.length) throw new RobinhoodMcpError("ACCOUNT_INVENTORY_INCOMPLETE");
  const accounts = inventory.map(object);
  const accountPositions: NonNullable<ReadonlyMarketSources["account"]["positions"]> = [];
  const accountOrders: NonNullable<ReadonlyMarketSources["account"]["orders"]> = [];
  const rawPositions: Array<{ label: string; value: Record<string, unknown> }> = [];
  let portfolioValue = 0, optionValue = 0, realizedPnl = 0, portfolioObserved = false, optionObserved = false, pnlObserved = false, accountPayloadsValid = true;
  for (const account of accounts) {
    const accountNumber = text(account.account_number)!;
    const rhsAccountNumber = text(account.rhs_account_number);
    const label = `账户-${hash({ account_number: accountNumber }).slice(0, 16)}`;
    let ordersReceivedAt: string | null = null;
    const [positionsBody, ordersBody, portfolioBody, pnlBody] = await Promise.all([
      session.call("get_option_positions", { account_number: accountNumber, nonzero: true }).then(robinhoodResponseBody),
      scope === "FULL" ? session.call("get_option_orders", { account_number: accountNumber }).then((result) => { ordersReceivedAt = new Date().toISOString(); return robinhoodResponseBody(result); }) : Promise.resolve({}),
      scope === "FULL" ? session.call("get_portfolio", { account_number: accountNumber }).then(robinhoodResponseBody) : Promise.resolve({}),
      scope === "FULL" && rhsAccountNumber ? session.call("get_realized_pnl", { account_number: rhsAccountNumber, span: "year", asset_classes: ["option"] }).then(robinhoodResponseBody) : Promise.resolve({}),
    ]);
    accountPayloadsValid &&= Array.isArray(object(positionsBody.data).positions) && (scope === "POSITIONS" || Array.isArray(object(object(ordersBody).data).orders));
    for (const position of dataRows(positionsBody, "positions")) rawPositions.push({ label, value: position });
    for (const order of dataRows(ordersBody, "orders")) accountOrders.push({
      account_label: label, symbol: text(order.chain_symbol), state: text(order.state), direction: text(order.direction), quantity: number(order.quantity), price: number(order.price), premium: number(order.premium), created_at: iso(order.created_at),
      evidence: {
        order_id: text(order.id) ? `order-${hash({ account: label, id: order.id }).slice(0, 32)}` : null,
        received_at: ordersReceivedAt!, updated_at: iso(order.updated_at), processed_quantity: nonnegative(order.processed_quantity),
        legs: Array.isArray(order.legs) ? rows(order.legs).map((leg) => ({
          leg_id: text(leg.id) ? `leg-${hash({ account: label, order: order.id ?? null, id: leg.id }).slice(0, 32)}` : null,
          contract_id: typeof (leg.option_id ?? leg.instrument_id) === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(String(leg.option_id ?? leg.instrument_id)) ? String(leg.option_id ?? leg.instrument_id) : null,
          side: leg.side === "buy" || leg.side === "sell" ? leg.side : null, position_effect: leg.position_effect === "open" || leg.position_effect === "close" ? leg.position_effect : null,
          ratio_quantity: nonnegative(leg.ratio_quantity),
          executions: Array.isArray(leg.executions) ? rows(leg.executions).map((fill) => ({
            execution_id: text(fill.id) ? `fill-${hash({ account: label, order: order.id ?? null, id: fill.id }).slice(0, 32)}` : null,
            quantity: nonnegative(fill.quantity), price: nonnegative(fill.price), executed_at: iso(fill.timestamp),
          })) : null,
        })) : null,
      },
    });
    const portfolio = object(object(portfolioBody).data);
    const total = number(portfolio.total_value), option = number(portfolio.options_value);
    if (total !== null) { portfolioValue += total; portfolioObserved = true; }
    if (option !== null) { optionValue += option; optionObserved = true; }
    const pnl = number(object(object(pnlBody).data).total_returns);
    if (pnl !== null) { realizedPnl += pnl; pnlObserved = true; }
  }
  const positionIds = rawPositions.map((item) => text(item.value.option_id)).filter((value): value is string => value !== null);
  const instruments = new Map<string, Record<string, unknown>>();
  if (positionIds.length) {
    const instrumentBody = robinhoodResponseBody(await session.call("get_option_instruments", { ids: positionIds.join(",") }));
    for (const item of dataRows(instrumentBody, "instruments")) if (text(item.id)) instruments.set(text(item.id)!, item);
  }
  const positionQuotes = new Map<string, Record<string, unknown>>();
  for (const batch of batches(positionIds, 20)) {
    const quoteBody = robinhoodResponseBody(await session.call("get_option_quotes", { instrument_ids: batch }));
    for (const item of dataRows(quoteBody, "results")) if (text(object(item.quote).instrument_id)) positionQuotes.set(text(object(item.quote).instrument_id)!, object(item.quote));
  }
  for (const { label, value } of rawPositions) {
    const id = text(value.option_id);
    const instrument = id ? instruments.get(id) ?? {} : {};
    const quote = id ? positionQuotes.get(id) ?? {} : {};
    const optionType = instrument.type === "call" || instrument.type === "put" ? instrument.type : null;
    const direction = value.type === "long" || value.type === "short" ? value.type : null;
    accountPositions.push({
      account_label: label, contract_id: id, symbol: text(value.chain_symbol), option_type: optionType,
      expiration: text(instrument.expiration_date ?? value.expiration_date), strike: number(instrument.strike_price), direction,
      quantity: number(value.quantity), average_price: optionPositionAveragePrice(value.average_price),
      bid: number(quote.bid_price), ask: number(quote.ask_price), mark: number(quote.mark_price), iv: number(quote.implied_volatility),
      delta: number(quote.delta), gamma: number(quote.gamma), theta: number(quote.theta), vega: number(quote.vega),
      open_interest: number(quote.open_interest), volume: number(quote.volume), as_of: iso(quote.updated_at),
    });
  }
  const live = accounts.length > 0 && accountPayloadsValid && (scope === "POSITIONS" || portfolioObserved && optionObserved && pnlObserved);
  return {
    source: "ROBINHOOD", status: live ? "LIVE" : "DATA_BLOCKED", as_of: accounts.length ? checkedAt : null, freshness_seconds: accounts.length ? 0 : null,
    account_count: accounts.length, positions: accounts.length ? accountPositions : null, orders: scope === "FULL" && accounts.length ? accountOrders : null,
    portfolio_value: portfolioObserved ? portfolioValue : null, option_value: optionObserved ? optionValue : null, realized_pnl: pnlObserved ? realizedPnl : null,
  };
}

export async function withRobinhoodMcp<T>(options: { projectRoot?: string; codexHome?: string; timeoutMs?: number; allowlist?: readonly string[]; onTiming?: RobinhoodTimingObserver }, run: (session: McpSession) => Promise<T>) {
  assertPublicAutomation();
  const projectRoot = options.projectRoot ?? process.cwd();
  const codexHome = publicProfile(projectRoot, "broker");
  if (options.codexHome && resolve(options.codexHome) !== codexHome) throw new RobinhoodMcpError("External broker profiles are forbidden");
  const allowlist = options.allowlist ?? ROBINHOOD_READONLY_TOOLS;
  for (const tool of allowlist) assertRobinhoodReadonlyTool(tool);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production", ...Object.fromEntries(["SystemRoot", "PATH", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"].flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : [])) };
  const appServerArgs = ["app-server", "--stdio", "-c", 'cli_auth_credentials_store="file"', "-c", 'mcp_oauth_credentials_store="file"', "-c", `mcp_servers.${ROBINHOOD_MCP_SERVER}.enabled=true`];
  appServerArgs.push("-c", `mcp_servers.${ROBINHOOD_MCP_SERVER}.enabled_tools=${JSON.stringify(allowlist)}`);
  const child = spawn(resolveCodexExecutable(projectRoot), appServerArgs, {
    cwd: projectRoot,
    env: { ...environment, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  emitTiming(options.onTiming, { event: "spawn", spawn_pid: child.pid });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; finish(outcome: RobinhoodTimingEvent["outcome"], textCodeUnits?: number): void }>();
  let requestId = 0;
  let stderr = "";
  const failPending = (error: Error, outcome: RobinhoodTimingEvent["outcome"]) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.finish(outcome); item.reject(error); }
    pending.clear();
  };
  child.stderr.setEncoding("utf8").on("data", (chunk) => { if (stderr.length < 2_000) stderr += chunk; });
  child.once("error", (error) => failPending(new RobinhoodMcpError(safeError(error)), "PROCESS_ERROR"));
  child.once("exit", (code) => { if (pending.size) failPending(new RobinhoodMcpError(safeError(stderr) || `Codex MCP app-server exited ${code}`), "PROCESS_EXIT"); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    const parseStarted = performance.now();
    emitTiming(options.onTiming, { event: "rpc_line_parse_begin", text_code_units: line.length });
    try { message = JSON.parse(line); } catch { emitTiming(options.onTiming, { event: "rpc_line_parse_end", outcome: "INVALID_JSON", duration_ms: performance.now() - parseStarted }); return; }
    emitTiming(options.onTiming, { event: "rpc_line_parse_end", ...(typeof message.id === "number" ? { request_id: message.id } : {}), outcome: "SUCCESS", duration_ms: performance.now() - parseStarted });
    if (typeof message.id !== "number") return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    const content = options.onTiming && object(message.result).content;
    item.finish(message.error ? "REMOTE_ERROR" : object(message.result).isError === true ? "PROVIDER_ERROR" : "SUCCESS", Array.isArray(content) ? content.reduce((sum, entry) => sum + (typeof object(entry).text === "string" ? (object(entry).text as string).length : 0), 0) : undefined);
    if (message.error) item.reject(new RobinhoodMcpError(safeError(message.error.message)));
    else item.resolve(message.result);
  });
  const request = (method: string, params: unknown, tool?: string) => new Promise<unknown>((resolveRequest, rejectRequest) => {
    const id = ++requestId;
    const started = performance.now();
    const finish = (outcome: RobinhoodTimingEvent["outcome"], textCodeUnits?: number) => emitTiming(options.onTiming, { event: "rpc_end", request_id: id, method, ...(tool ? { tool } : {}), duration_ms: performance.now() - started, outcome, ...(textCodeUnits === undefined ? {} : { text_code_units: textCodeUnits }) });
    const timer = setTimeout(() => {
      pending.delete(id);
      finish("TIMEOUT");
      rejectRequest(new RobinhoodMcpError(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer, finish });
    emitTiming(options.onTiming, { event: "rpc_begin", request_id: id, method, ...(tool ? { tool } : {}) });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });

  try {
    await request("initialize", { clientInfo: { name: "trading-os-readonly", title: "Trading OS Read-Only Gateway", version: "1" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const started = await request("thread/start", { cwd: projectRoot, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" }) as { thread?: { id?: unknown } };
    const threadId = started.thread?.id;
    if (typeof threadId !== "string" || !threadId) throw new RobinhoodMcpError("Codex MCP thread did not start");
    const session: McpSession = {
      async listTools() {
        const response = await request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" }) as { data?: Array<{ name?: unknown; authStatus?: unknown; tools?: unknown }> };
        const server = response.data?.find((item) => item.name === ROBINHOOD_MCP_SERVER);
        if (!server) throw new RobinhoodMcpError("Robinhood MCP server is not configured");
        if (server.authStatus !== "oAuth") throw new RobinhoodMcpError(`Robinhood MCP authorization status: ${String(server.authStatus ?? "unknown")}`);
        if (!server.tools || typeof server.tools !== "object" || Array.isArray(server.tools)) throw new RobinhoodMcpError("Robinhood MCP tool inventory is unavailable");
        return server.tools as Record<string, ToolDefinition>;
      },
      async call(tool, args) {
        assertRobinhoodReadonlyTool(tool, allowlist);
        try {
          const result = await request("mcpServer/tool/call", { server: ROBINHOOD_MCP_SERVER, threadId, tool, arguments: args }, tool) as ToolCallResponse;
          if (result.isError) throw new RobinhoodMcpError("returned an error");
          return result;
        } catch (error) {
          throw new RobinhoodMcpError(`Robinhood MCP ${tool}: ${safeError(error instanceof Error ? error.message : error)}`);
        }
      },
    };
    emitTiming(options.onTiming, { event: "callback_begin" });
    return await run(session);
  } finally {
    child.stdin.end();
    child.kill();
    failPending(new RobinhoodMcpError("Codex MCP session closed"), "SESSION_CLOSED");
  }
}
