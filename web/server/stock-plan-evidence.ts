import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { APPROVED_STOCKS, type ApprovedCapabilitySnapshot, type MarketDataBar, type ReadonlyMarketSources } from "../app/snapshot-import.ts";
import type { StockPlanEvidence, StockPlanningContext } from "../app/stock-manual-plan.ts";
import { exchangeDateKey, latestCompletedNyseSession, MARKET_5M_MAX_AGE_SECONDS, robinhoodSessionAt } from "../app/market-time.ts";
import { utcForPt } from "../app/timeline-schedule.ts";
import { isPaperOptionExpiration, optionDte, representativeOptionExpirations } from "./option-horizon.ts";
import { assertRobinhoodReadonlyTool, canonicalJson, collectRobinhoodAccount, robinhoodOptionCursor, robinhoodResponseBody, type McpSession } from "./robinhood-mcp.ts";
import { invocationCommand } from "./stock-plan-review.ts";
import { isPaperIndexSymbol, paperCodexQualifiedActive, paperFallbackDirectionConflict, paperIndexResearchActive, type PaperSelectionCandidate } from "../app/paper-selection.ts";

type Inputs = Pick<StockPlanEvidence, "run_id" | "slot_id" | "source_snapshot_id" | "source_snapshot_hash" | "news" | "global_risk"> & {
  approvedCapabilities: ApprovedCapabilitySnapshot;
  deadlineMs?: number;
  v2Root?: string;
  classifyPatterns?: typeof classifyStockPatterns;
  paperResearch?: true;
  paperPreflight?: true;
  paperCandidateOffset?: number;
  paperExcludedSymbols?: string[];
  paperSelectedCandidates?: PaperSelectionCandidate[];
  paperIndexOnly?: true;
  paperEquityOnly?: true;
};
const patternRegimes = new Set(["TREND_UP", "TREND_DOWN", "NARROW_RANGE", "WIDE_CHOP", "V_REVERSAL_UP", "V_REVERSAL_DOWN", "FALSE_BREAKOUT", "FALSE_BREAKDOWN", "TRANSITION", "UNKNOWN"]);
// Owner's existing mainstream-stock preference, not a live market-cap or liquidity ranking.
const preferredPaperStocks = new Set(["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD"]);

/** Read-only reuse of the original pure classifier, never the stateful SPY/QQQ tracker. */
export async function classifyStockPatterns(batches: MarketDataBar[][], v2Root: string | undefined, timeoutMs: number): Promise<StockPlanEvidence["pattern"][]> {
  if (!v2Root || !isAbsolute(v2Root) || !Number.isFinite(timeoutMs) || timeoutMs <= 250 || batches.length > 3) throw Error("STOCK_PATTERN_INPUT_OR_BUDGET_INVALID");
  const deadline = performance.now() + timeoutMs;
  const run = (executable: string, args: string[], input = "") => new Promise<string>((accept, reject) => {
    // Reserve cleanup time inside the collector deadline; the shared Windows Job kills every descendant on close.
    const remaining = Math.floor(deadline - performance.now() - 250);
    if (remaining <= 0) { reject(Error("STOCK_PATTERN_DEADLINE")); return; }
    const command = invocationCommand(executable, args);
    const child = execFile(command.command, command.args, { windowsHide: true, timeout: remaining, killSignal: "SIGKILL", maxBuffer: 16_384, encoding: "utf8" }, (error, stdout) => error ? reject(Error("STOCK_PATTERN_PROCESS_FAILED")) : accept(stdout));
    child.stdin?.on("error", () => { child.kill("SIGKILL"); });
    child.stdin?.end(input);
  });
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const python = resolve(packageRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!existsSync(python)) throw Error("STOCK_PATTERN_PYTHON_UNAVAILABLE");
  const program = "import json,sys,tzdata; sys.path.insert(0,sys.argv[1]); from trading_os_v2.a2.pattern_tracker import classify_pattern; rows=[classify_pattern(bars,0) for bars in json.load(sys.stdin)]; print(json.dumps([{'source':'A2_CLASSIFY_PATTERN_V1','regime':regime,'direction':traits['direction']} for regime,traits in rows],allow_nan=False))";
  const output: unknown = JSON.parse(await run(python, ["-I", "-X", "utf8", "-B", "-c", program, v2Root], JSON.stringify(batches)));
  if (!Array.isArray(output) || output.length !== batches.length) throw Error("STOCK_PATTERN_OUTPUT_INVALID");
  return output.map((value) => {
    const row = obj(value);
    return Object.keys(row).length === 3 && row.source === "A2_CLASSIFY_PATTERN_V1" && patternRegimes.has(text(row.regime)) && ["bullish", "bearish", "neutral", "unknown"].includes(text(row.direction)) ? row as NonNullable<StockPlanEvidence["pattern"]> : null;
  });
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const num = (value: unknown) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) ? Number(value) : null;
const iso = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = (value: unknown) => typeof value === "string" ? value : "";
function providerRows(body: Record<string, unknown>, key: string) {
  const data = obj(body.data), value = data[key] ?? body[key] ?? data.results ?? body.results;
  if (!Array.isArray(value)) throw Error("MALFORMED_PROVIDER_ROWS");
  return value.map(obj);
}
function one(rows: Record<string, unknown>[], matches: (row: Record<string, unknown>) => boolean) {
  const matchesFound = rows.filter(matches);
  if (matchesFound.length !== 1) throw Error("MISSING_OR_DUPLICATE_IDENTITY");
  return matchesFound[0];
}
function fresh(at: string | null, receivedAt: string, seconds = MARKET_5M_MAX_AGE_SECONDS) {
  const age = Date.parse(receivedAt) - Date.parse(at ?? "");
  return Number.isFinite(age) && age >= 0 && age <= seconds * 1_000;
}
function blockedAccount(): ReadonlyMarketSources["account"] {
  return { source: "ROBINHOOD", status: "DATA_BLOCKED", as_of: null, freshness_seconds: null, account_count: null, positions: null, orders: null, portfolio_value: null, option_value: null, realized_pnl: null };
}

/** Separate, bounded manual-plan evidence lane. Never called by the A1 core collector. */
export async function collectStockPlanEvidence(session: McpSession, input: Inputs): Promise<StockPlanEvidence[]> {
  const startedAt = new Date().toISOString(), marketDate = exchangeDateKey(startedAt);
  const news = structuredClone(input.news), globalRisk = structuredClone(input.global_risk);
  const contextAt = iso(input.approvedCapabilities.generated_at);
  const paperContext = input.paperResearch === true && /^paper-check:\d{8}T\d{6}Z$/.test(input.run_id) && input.slot_id === input.run_id
    && input.approvedCapabilities.source === "ROBINHOOD_OFFICIAL_TRADING_MCP" && contextAt !== null && Date.parse(contextAt) <= Date.parse(startedAt)
    && exchangeDateKey(contextAt) >= latestCompletedNyseSession(startedAt);
  if (input.paperResearch === true && !paperContext) return [];
  const indexResearch = paperContext && paperIndexResearchActive(startedAt);
  const equitySymbols = new Set<string>([...APPROVED_STOCKS, ...(indexResearch ? ["SPY", "QQQ"] : [])]);
  const qualifiedPaper = paperContext && paperCodexQualifiedActive(startedAt), preflight = qualifiedPaper && input.paperPreflight === true;
  if (input.paperPreflight && !preflight) return [];
  const candidateOffset = paperContext ? input.paperCandidateOffset ?? 0 : 0;
  if (!Number.isSafeInteger(candidateOffset) || candidateOffset < 0) throw Error("INVALID_PAPER_CANDIDATE_OFFSET");
  // Preserve the ranked shortlist, then eligible stocks in the original fixed pool; ETFs cannot hide every stock.
  const choices = paperContext && !preflight ? input.paperSelectedCandidates : undefined;
  const eligible = [...new Set(choices ? choices.map((row) => row.symbol) : [...input.approvedCapabilities.fixed_pool.candidates, ...input.approvedCapabilities.fixed_pool.rows.map((row) => row.symbol)])].flatMap((symbol) => {
    const row = input.approvedCapabilities.fixed_pool.rows.find((entry) => entry.symbol === symbol);
    const choice = choices?.find((entry) => entry.symbol === symbol);
    const rowAt = iso(row?.as_of);
    // generated_at is the collection start / bar cutoff; quotes can arrive later in that same frozen batch.
    const recentFrozenRow = paperContext && rowAt !== null && Date.parse(rowAt) <= Date.parse(startedAt) && exchangeDateKey(rowAt) >= latestCompletedNyseSession(startedAt);
    const paperStage = paperContext && row && (preflight || ["WAIT", "EXTENDED"].includes(row.swing.stage)) ? row.swing.stage : null;
    if (!equitySymbols.has(symbol) || !row || !(row.status === "LIVE" || recentFrozenRow && row.status === "MARKET_CLOSED") || preflight && !recentFrozenRow
      || !preflight && !choice && !paperStage && !["EARLY_WATCH", "CONFIRMED"].includes(row.swing.stage)
      || !preflight && !choice && (row.swing.direction !== "BULLISH" && row.swing.direction !== "BEARISH")) return [];
    const observedAt = iso(input.approvedCapabilities.generated_at);
    const fourHour = row.timeframes?.four_hour, level = num(row.swing.direction === "BULLISH" ? fourHour?.resistance : fourHour?.support), frozenLast = num(row.last);
    let entryTrigger = num(row.swing.management?.entry_trigger);
    if (row.swing.management?.entry_trigger === null && fourHour?.timeframe === "4h" && fourHour.available && fourHour.direction === row.swing.direction
      && observedAt && iso(fourHour.data_cutoff) && Date.parse(fourHour.data_cutoff!) + 14_400_000 <= Date.parse(observedAt)
      && level !== null && level > 0 && frozenLast !== null && frozenLast > 0 && (row.swing.direction === "BULLISH" ? frozenLast >= level : frozenLast <= level)) entryTrigger = level;
    const planningContext: StockPlanningContext | null = observedAt && Date.parse(observedAt) <= Date.parse(startedAt)
      && Array.isArray(row.swing.why_watch) && row.swing.why_watch.every((value) => typeof value === "string" && value.trim())
      && ["daily", "four_hour", "one_hour", "thirty_minute"].every((key) => Object.keys(obj(obj(row.timeframes)[key])).length > 0)
      ? structuredClone({ observed_at: observedAt, entry_trigger: entryTrigger, invalidation_price: num(row.swing.management?.price_invalidation), target_price: num(row.swing.management?.target_1), why_watch: row.swing.why_watch, timeframes: row.timeframes }) : null;
    if ((paperStage || choice || preflight) && (!planningContext?.why_watch.length || !Object.values(planningContext.timeframes).some((frame) => frame.available && (preflight || choice || frame.direction === row.swing.direction) && iso(frame.data_cutoff) && Date.parse(frame.data_cutoff!) <= Date.parse(planningContext.observed_at)))) return [];
    if (preflight && Object.values(planningContext!.timeframes).some((frame) => frame.data_cutoff && (!iso(frame.data_cutoff) || Date.parse(frame.data_cutoff) > Date.parse(planningContext!.observed_at)))) return [];
    if (paperContext && !preflight && !choice && paperFallbackDirectionConflict(row.swing.direction, planningContext?.timeframes)) return [];
    return [{ symbol, direction: choice?.direction ?? row.swing.direction as "BULLISH" | "BEARISH", planningContext, paperStage, contractId: qualifiedPaper ? choice?.contract_id : undefined }];
  });
  const ordered = eligible.filter((row) => (!paperContext || !input.paperExcludedSymbols?.includes(row.symbol))
    && (!indexResearch || (!input.paperIndexOnly || isPaperIndexSymbol(row.symbol)) && (!input.paperEquityOnly || !isPaperIndexSymbol(row.symbol))));
  if (paperContext && !choices) ordered.sort((left, right) => Number(preferredPaperStocks.has(right.symbol)) - Number(preferredPaperStocks.has(left.symbol)));
  const equities = indexResearch && !choices ? ordered.filter((row) => !isPaperIndexSymbol(row.symbol)) : ordered;
  const offset = equities.length ? candidateOffset % equities.length : 0;
  const indexes = indexResearch && !choices ? ["SPY", "QQQ"].flatMap((symbol) => ordered.filter((row) => row.symbol === symbol)) : [];
  const index = indexes.length ? indexes[(preflight ? 0 : Math.floor(candidateOffset / 3)) % indexes.length] : undefined;
  const stocks = choices ? ordered.slice(0, 3) : [...(index ? [index] : []), ...equities.slice(offset), ...equities.slice(0, offset)].slice(0, 3);
  const selected = preflight ? stocks.flatMap((row) => (["BULLISH", "BEARISH"] as const).map((direction) => ({ ...row, direction }))) : stocks;
  if (!selected.length) return [];
  const requestedBudget = input.deadlineMs ?? 20_000;
  if (!Number.isFinite(requestedBudget) || requestedBudget <= 0) throw Error("INVALID_STOCK_EVIDENCE_BUDGET");
  const deadlineAt = Date.now() + Math.min(requestedBudget, 30_000);
  let calls = 0, expired = false;
  const deadlineError = Error("STOCK_EVIDENCE_DEADLINE");
  const rpcLimitError = Error("STOCK_EVIDENCE_RPC_LIMIT");
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { expired = true; reject(deadlineError); }, Math.min(requestedBudget, 30_000)); });
  // ponytail: at most 32 RPCs and one shared deadline; page a larger universe only in a separately budgeted lane.
  const bounded: McpSession = {
    listTools: () => Promise.reject(Error("STOCK_EVIDENCE_NO_TOOL_DISCOVERY")),
    call: async (tool, args) => {
      assertRobinhoodReadonlyTool(tool);
      if (expired || Date.now() >= deadlineAt) throw deadlineError;
      if (++calls > 32) throw rpcLimitError;
      const response = await Promise.race([session.call(tool, args), deadline]);
      if (response.isError) throw Error("PROVIDER_REJECTED_REQUEST");
      return response;
    },
  };
  const sharedGaps: string[] = [];
  const read = async (tool: string, args: Record<string, unknown>) => robinhoodResponseBody(await bounded.call(tool, args));
  try {
    const requested = [...new Set(selected.map((row) => row.symbol))];
    const [quotes, histories, account] = await Promise.all([
      read("get_equity_quotes", { symbols: requested }).then((body) => providerRows(body, "results")).catch(() => { sharedGaps.push("EQUITY_QUOTES_UNAVAILABLE"); return []; }),
      paperContext ? [] : read("get_equity_historicals", { symbols: requested, start_time: `${marketDate}T00:00:00.000Z`, end_time: startedAt, interval: "5minute", bounds: "regular", adjustment_type: "split" }).then((body) => providerRows(body, "results")).catch(() => { sharedGaps.push("EQUITY_BARS_UNAVAILABLE"); return []; }),
      paperContext ? blockedAccount() : collectRobinhoodAccount(bounded, undefined, "POSITIONS").catch((error) => { sharedGaps.push("ACCOUNT_READ_UNAVAILABLE"); if (error === rpcLimitError) sharedGaps.push("STOCK_EVIDENCE_RPC_LIMIT"); return blockedAccount(); }),
    ]);
    const collected = await Promise.all(selected.map(async ({ symbol, direction, planningContext, contractId }) => {
      const gaps: string[] = [];
      let quote: StockPlanEvidence["quote"] = { source: "ROBINHOOD", symbol, status: "DATA_BLOCKED", last: null, bid: null, ask: null, as_of: null };
      let bars: StockPlanEvidence["bars"] = { source: "ROBINHOOD", symbol, interval: "5min", as_of: null, values: [] };
      let contracts: StockPlanEvidence["contracts"] = [];
      try {
        const raw = obj(one(quotes, (row) => obj(row.quote).symbol === symbol).quote);
        quote = { source: "ROBINHOOD", symbol, status: "DATA_BLOCKED", last: num(raw.last_trade_price), bid: num(raw.bid_price), ask: num(raw.ask_price), as_of: iso(raw.venue_last_trade_time ?? raw.updated_at) };
      } catch { gaps.push("EQUITY_QUOTE_IDENTITY_MISSING"); }
      if (!paperContext) try {
        const raw = one(histories, (row) => row.symbol === symbol);
        if (raw.interval !== "5minute" || raw.bounds !== "regular" || !Array.isArray(raw.bars)) throw Error("MALFORMED_BARS");
        const values: MarketDataBar[] = [], seen = new Set<string>();
        const receivedMs = Date.now();
        for (const entry of raw.bars) {
          const row = obj(entry), begins = iso(row.begins_at);
          if (!begins || Date.parse(begins) > receivedMs) throw Error("INVALID_BAR_TIME");
          if (exchangeDateKey(begins) !== marketDate || robinhoodSessionAt(begins).phase !== "REGULAR" || Date.parse(begins) + 330_000 > receivedMs) continue;
          if (row.interpolated !== undefined && row.interpolated !== false || row.session !== undefined && row.session !== "" && row.session !== "reg") throw Error("SYNTHETIC_OR_NON_REGULAR_BAR");
          const open = num(row.open_price ?? row.open), high = num(row.high_price ?? row.high), low = num(row.low_price ?? row.low), close = num(row.close_price ?? row.close), volume = num(row.volume);
          if (Date.parse(begins) % 300_000 !== 0 || seen.has(begins) || open === null || high === null || low === null || close === null || volume === null || Math.min(open, high, low, close) <= 0 || volume < 0 || high < Math.max(open, low, close) || low > Math.min(open, high, close)) throw Error("INVALID_BAR");
          seen.add(begins); values.push({ begins_at: begins, open, high, low, close, volume });
        }
        values.sort((left, right) => left.begins_at.localeCompare(right.begins_at));
        bars = { source: "ROBINHOOD", symbol, interval: "5min", as_of: values.length ? new Date(Date.parse(values.at(-1)!.begins_at) + 300_000).toISOString() : null, values };
      } catch { gaps.push("EQUITY_BARS_INVALID_OR_MISSING"); }
      // Only local stage codes reach frozen evidence; provider errors may contain private response data.
      let optionFailure = "NO_SPOT_FOR_CONTRACT_SELECTION";
      try {
        if (quote.last === null || quote.last <= 0) throw Error("NO_SPOT_FOR_CONTRACT_SELECTION");
        const optionType = direction === "BULLISH" ? "call" : "put";
        let nearest: Record<string, unknown>[];
        if (contractId !== undefined) {
          optionFailure = "OPTION_SELECTED_CONTRACT_ID_INVALID";
          if (!uuid.test(contractId) || !["BULLISH", "BEARISH"].includes(direction)) throw Error(optionFailure);
          optionFailure = "OPTION_INSTRUMENT_READ_FAILED";
          const body = await read("get_option_instruments", { ids: contractId });
          optionFailure = "OPTION_SELECTED_CONTRACT_IDENTITY_INVALID";
          const rows = providerRows(body, "instruments"), row = one(rows, (entry) => entry.id === contractId);
          if (rows.length !== 1 || row.chain_symbol !== symbol || !uuid.test(text(row.chain_id)) || row.underlying_type !== "equity" || row.type !== optionType
            || row.state !== "active" || row.tradability !== "tradable" || num(row.strike_price) === null || num(row.strike_price)! <= 0
            || num(row.trade_value_multiplier) !== 100 || !/^\d{4}-\d{2}-\d{2}$/.test(text(row.expiration_date))
            || iso(`${row.expiration_date}T00:00:00.000Z`)?.slice(0, 10) !== row.expiration_date || !isPaperOptionExpiration(text(row.expiration_date), marketDate)) throw Error(optionFailure);
          nearest = [row];
        } else {
          optionFailure = "OPTION_CHAIN_READ_FAILED";
          const chainBody = await read("get_option_chains", { underlying_symbol: symbol });
          optionFailure = "OPTION_CHAIN_RESPONSE_INVALID";
          const chain = one(providerRows(chainBody, "chains"), (row) => row.symbol === symbol);
          if (!uuid.test(text(chain.id)) || !Array.isArray(chain.expiration_dates)) throw Error("INVALID_CHAIN");
          const availableExpirations = [...new Set(chain.expiration_dates.filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && iso(`${value}T00:00:00.000Z`)?.slice(0, 10) === value && optionDte(value, marketDate)! >= 0))].sort();
          const expirations = paperContext ? availableExpirations.filter((expiration) => isPaperOptionExpiration(expiration, marketDate)).slice(0, 2) : representativeOptionExpirations(availableExpirations, marketDate);
          if (paperContext && expirations.length === 2) {
            const friday = availableExpirations.find((expiration) => isPaperOptionExpiration(expiration, marketDate) && new Date(expiration).getUTCDay() === 5);
            if (friday && !expirations.includes(friday)) expirations[1] = friday;
          }
          // Retain a real alternative even when the existing horizon buckets omit 8-13 or 61-89 DTE.
          if (!paperContext) for (const expiration of availableExpirations) { if (expirations.length >= Math.min(2, availableExpirations.length)) break; if (!expirations.includes(expiration)) expirations.push(expiration); }
          optionFailure = "NO_OPTION_EXPIRATION_OBSERVED";
          if (!expirations.length) throw Error("NO_OPTION_EXPIRATION_OBSERVED");
          const valid: Record<string, unknown>[] = [];
          try {
            // ponytail: bounded expiries and three complete pages each; PAPER V2 adds two moderate OTM targets to the nearest two strikes. All share the 32-RPC/deadline ceiling.
            for (const expiration of expirations) {
              const cursors = new Set<string>();
              let cursor: string | undefined;
              for (let page = 0; page < 3; page++) {
                optionFailure = "OPTION_INSTRUMENT_READ_FAILED";
                const body = await read("get_option_instruments", { chain_symbol: symbol, expiration_dates: expiration, type: optionType, state: "active", tradability: "tradable", ...(cursor ? { cursor } : {}) });
                optionFailure = "OPTION_INSTRUMENT_RESPONSE_INVALID";
                const rows = providerRows(body, "instruments");
                optionFailure = "OPTION_PAGE_TOO_LARGE";
                if (rows.length > 1_000) throw Error("OPTION_PAGE_TOO_LARGE");
                const identities = rows.filter((row) => row.chain_symbol === symbol && row.chain_id === chain.id && row.underlying_type === "equity" && row.expiration_date === expiration && uuid.test(text(row.id)) && num(row.strike_price) !== null && num(row.strike_price)! > 0 && row.state === "active" && row.tradability === "tradable" && row.type === optionType);
                if (identities.length !== rows.length) gaps.push("OPTION_INSTRUMENT_IDENTITIES_REJECTED");
                valid.push(...identities);
                const next = obj(body.data).next ?? body.next;
                if (next === undefined || next === null || next === "") break;
                optionFailure = "OPTION_PAGINATION_INCOMPLETE";
                cursor = robinhoodOptionCursor(next);
                // The provider URL is never fetched. Only its opaque cursor goes back to the same allowlisted tool.
                if (!cursor || cursors.has(cursor) || page === 2) throw Error("OPTION_PAGINATION_INCOMPLETE");
                cursors.add(cursor);
              }
            }
          } catch (error) { gaps.push("OPTION_INSTRUMENT_LIST_PARTIAL"); throw error; }
          const ids = new Set<string>();
          optionFailure = "DUPLICATE_OPTION_IDENTITY";
          for (const row of valid) { const id = text(row.id); if (ids.has(id)) throw Error("DUPLICATE_OPTION_IDENTITY"); ids.add(id); }
          optionFailure = "NO_VALID_OPTION_IDENTITIES";
          if (!valid.length || gaps.includes("OPTION_INSTRUMENT_IDENTITIES_REJECTED")) throw Error("NO_VALID_OPTION_IDENTITIES");
          nearest = expirations.flatMap((expiration) => {
            const rows = valid.filter((row) => row.expiration_date === expiration);
            const byDistance = (target: number) => (left: Record<string, unknown>, right: Record<string, unknown>) => Math.abs(num(left.strike_price)! - target) - Math.abs(num(right.strike_price)! - target) || num(left.strike_price)! - num(right.strike_price)!;
            const sampled = [...rows].sort(byDistance(quote.last!)).slice(0, 2);
            if (qualifiedPaper) {
              const side = optionType === "call" ? 1 : -1;
              const otm = rows.filter((row) => { const distance = side * (num(row.strike_price)! / quote.last! - 1); return distance > 0 && distance <= 0.02 + Number.EPSILON; });
              for (const distance of [0.005, 0.01]) { const candidate = [...otm].sort(byDistance(quote.last! * (1 + side * distance)))[0]; if (candidate && !sampled.some((row) => row.id === candidate.id)) sampled.push(candidate); }
            }
            return sampled;
          });
        }
        if (qualifiedPaper) nearest = nearest.filter((row) => (optionType === "call" ? 1 : -1) * (num(row.strike_price)! / quote.last! - 1) <= 0.02 + Number.EPSILON);
        optionFailure = "NO_MODERATE_STRIKE";
        if (!nearest.length) throw Error(optionFailure);
        optionFailure = "OPTION_QUOTES_READ_FAILED";
        const quoteBody = await read("get_option_quotes", { instrument_ids: nearest.map((row) => row.id) });
        optionFailure = "OPTION_QUOTE_RESPONSE_INVALID";
        const optionQuotes = providerRows(quoteBody, "results");
        optionFailure = "OPTION_QUOTE_IDENTITY_MISSING_OR_DUPLICATE";
        contracts = nearest.map((instrument) => {
          const id = text(instrument.id), raw = obj(one(optionQuotes, (row) => obj(row.quote).instrument_id === id).quote);
          return {
            contract_id: id, option_type: optionType, expiration: text(instrument.expiration_date), strike: num(instrument.strike_price)!, bid: num(raw.bid_price), ask: num(raw.ask_price), mark: num(raw.mark_price), volume: num(raw.volume), open_interest: num(raw.open_interest), iv: num(raw.implied_volatility), delta: num(raw.delta), gamma: num(raw.gamma), theta: num(raw.theta), vega: num(raw.vega), as_of: iso(raw.updated_at), history_bars: 0, history_as_of: null,
            instrument: { chain_id: text(instrument.chain_id), chain_symbol: text(instrument.chain_symbol), expiration_date: text(instrument.expiration_date), strike_price: num(instrument.strike_price)!, type: optionType, state: text(instrument.state), tradability: text(instrument.tradability), trade_value_multiplier: num(instrument.trade_value_multiplier) },
          };
        });
      } catch (error) {
        gaps.push(optionFailure);
        if (error === deadlineError) gaps.push("STOCK_EVIDENCE_DEADLINE");
        if (error === rpcLimitError) gaps.push("STOCK_EVIDENCE_RPC_LIMIT");
      }
      return { symbol, direction, planningContext, quote, bars, contracts, gaps };
    }));
    let patterns: StockPlanEvidence["pattern"][] = collected.map(() => null);
    if (!paperContext) try {
      patterns = await (input.classifyPatterns ?? classifyStockPatterns)(collected.map((row) => row.bars.values), input.v2Root, deadlineAt - Date.now());
      if (expired || Date.now() >= deadlineAt || patterns.length !== collected.length) throw deadlineError;
    } catch { patterns = collected.map(() => null); if (expired || Date.now() >= deadlineAt) sharedGaps.push("STOCK_EVIDENCE_DEADLINE"); }
    const receivedAt = new Date().toISOString();
    return collected.map(({ symbol, direction, planningContext, quote, bars, contracts, gaps }, index): StockPlanEvidence => {
      gaps.push(...sharedGaps);
      const setupGaps: string[] = [];
      const pattern = patterns[index] ?? null;
      if (paperContext) setupGaps.push("PAPER_FROZEN_STRUCTURE_ONLY：未采集本轮盘中K线或盘型，仅沿用原冻结结构，不是当前入场确认");
      if (selected[index].paperStage) setupGaps.push(`PAPER_RESEARCH_STAGE_${selected[index].paperStage}：原冻结阶段为${selected[index].paperStage}，仅作研究观察，不是当前入场确认`);
      if (!pattern || pattern.regime === "UNKNOWN") setupGaps.push("STOCK_PATTERN_CLASSIFICATION_UNAVAILABLE");
      if (!planningContext) gaps.push("STOCK_PLANNING_CONTEXT_NOT_OBSERVED");
      if (quote.last === null || quote.last <= 0 || quote.bid === null || quote.bid <= 0 || quote.ask === null || quote.ask < quote.bid || !fresh(quote.as_of, receivedAt)) gaps.push("EQUITY_QUOTE_STALE_OR_INCOMPLETE");
      else quote.status = "LIVE";
      if (bars.values.length < 5) setupGaps.push("EQUITY_BARS_INSUFFICIENT_FOR_SETUP");
      if (!paperContext && (bars.values.length ? !fresh(bars.as_of, receivedAt) : Date.parse(receivedAt) >= utcForPt(marketDate, "06:30").getTime() + 330_000)) gaps.push("EQUITY_BARS_STALE_OR_MISSING");
      if (!contracts.length) gaps.push("OPTION_CONTRACTS_NOT_OBSERVED");
      if (contracts.some((row) => row.instrument.trade_value_multiplier !== 100)) gaps.push("OPTION_STANDARD_100_MULTIPLIER_NOT_CONFIRMED");
      if (contracts.some((row) => !fresh(row.as_of, receivedAt) || row.bid === null || row.bid <= 0 || row.ask === null || row.ask < row.bid || row.mark === null || row.mark <= 0 || row.volume === null || row.volume < 0 || row.open_interest === null || row.open_interest < 0 || row.iv === null || row.iv <= 0 || [row.delta, row.gamma, row.theta, row.vega].some((value) => value === null))) gaps.push("OPTION_QUOTES_STALE_OR_INCOMPLETE");
      if (account.status !== "LIVE" || !Array.isArray(account.positions) || !fresh(account.as_of, receivedAt, 120)) gaps.push("ACCOUNT_NOT_CURRENT");
      if (robinhoodSessionAt(receivedAt).phase !== "REGULAR") gaps.push("MARKET_NOT_REGULAR");
      const evidence: Omit<StockPlanEvidence, "evidence_id"> = {
        contract_version: "stock-plan-v2", entry_rule: "MULTI_TIMEFRAME_BREAK_HOLD_V1", run_id: input.run_id, slot_id: input.slot_id, source_mode: "LIVE", mode: "SHADOW", automated_execution: false,
        observed_at: startedAt, received_at: receivedAt, source_snapshot_id: input.source_snapshot_id, source_snapshot_hash: input.source_snapshot_hash,
        symbol, instrument_type: "EQUITY", direction, planning_context: planningContext, quote, bars, pattern, contracts, account, news, global_risk: globalRisk, data_gaps: [...new Set(gaps)], setup_gaps: [...new Set(setupGaps)],
      };
      return { ...evidence, evidence_id: createHash("sha256").update(canonicalJson(evidence)).digest("hex") };
    });
  } finally { clearTimeout(timer!); }
}
