import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { classifyStockPatterns, collectStockPlanEvidence } from "../server/stock-plan-evidence.ts";
import { canonicalJson, robinhoodOptionCursor } from "../server/robinhood-mcp.ts";
import { stockPlanAnalysisGaps, stockPlanEvidenceGaps, stockPlanStructure, validateStockPlanEvidence } from "../app/stock-manual-plan.ts";
import { buildPaperPlan } from "../app/paper-plan.ts";

const at = "2026-09-09T17:00:00.000Z", quoteAt = "2026-09-09T16:59:50.000Z";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const symbols = ["NVDA", "AAPL", "TSLA", "MSFT"];
const paperExpirations = ["2026-09-18", "2026-10-09"];
const timeframe = (timeframe, direction) => ({ timeframe, available: true, pattern: "TREND", state: "CONFIRMED", direction, confidence: 0.7, support: 210, resistance: 225, volume_context: "正常", data_cutoff: quoteAt, limitation: null });
const input = () => ({
  run_id: "live-shadow:20260909T170000Z", slot_id: "live-shadow:20260909T170000Z",
  source_snapshot_id: "market-original", source_snapshot_hash: "a".repeat(64),
  approvedCapabilities: {
    source: "ROBINHOOD_OFFICIAL_TRADING_MCP", generated_at: at,
    fixed_pool: { candidates: ["SPY", "QQQ", "XSP", ...symbols], rows: symbols.map((symbol) => {
      const direction = symbol === "AAPL" ? "BEARISH" : "BULLISH";
      return { symbol, status: "LIVE", direction, as_of: quoteAt,
        timeframes: { daily: timeframe("1d", direction), four_hour: timeframe("4h", direction), one_hour: timeframe("1h", direction), thirty_minute: timeframe("30m", direction) },
        swing: { direction, stage: "CONFIRMED", why_watch: ["原四周期已观察到的理由"], management: direction === "BEARISH" ? { entry_trigger: 215, price_invalidation: 225, target_1: 200 } : { entry_trigger: 225, price_invalidation: 210, target_1: 240 } } };
    }) },
  },
  news: { checked_at: quoteAt, status: "LIVE", items: [] },
  global_risk: { checked_at: quoteAt, critical_blockers: [], new_entry_blockers: [] },
  classifyPatterns: async (batches) => batches.map(() => ({ source: "A2_CLASSIFY_PATTERN_V1", regime: "TREND_UP", direction: "bullish" })),
});
function fixture(change = () => {}, expirations = ["2026-09-09", "2026-09-11", "2026-10-16"], poolSymbols = symbols) {
  const calls = [];
  const session = {
    async listTools() { return {}; },
    async call(tool, args) {
      calls.push({ tool, args });
      let data;
      if (tool === "get_accounts") data = { accounts: [{ account_number: "TEST_ONLY_ACCOUNT" }] };
      else if (tool === "get_option_positions") data = { positions: [] };
      else if (tool === "get_equity_quotes") data = { results: args.symbols.map((symbol) => ({ quote: { symbol, last_trade_price: "220", bid_price: "219.99", ask_price: "220.01", venue_last_trade_time: quoteAt } })) };
      else if (tool === "get_equity_historicals") data = { results: args.symbols.map((symbol) => ({ symbol, interval: "5minute", bounds: "regular", bars: Array.from({ length: 42 }, (_, index) => ({ begins_at: new Date(Date.parse("2026-09-09T13:30:00.000Z") + index * 300_000).toISOString(), open_price: "218", high_price: "221", low_price: "217", close_price: "220", volume: "10000", session: "reg", interpolated: false })) })) };
      else if (tool === "get_option_chains") data = { chains: [{ id: uuid(100 + poolSymbols.indexOf(args.underlying_symbol)), symbol: args.underlying_symbol, expiration_dates: [...expirations] }] };
      else if (tool === "get_option_instruments" && args.ids) data = { instruments: args.ids.split(",").map((id) => ({ id, chain_symbol: "MSFT", expiration_date: "2026-12-08", strike_price: "220", type: "call" })) };
      else if (tool === "get_option_instruments") {
        assert.equal(args.strike_price, undefined, "must use actual official strikes, not rounded guessed strikes");
        assert.match(args.expiration_dates, /^\d{4}-\d{2}-\d{2}$/, "reuse the evidenced single-expiry parameter, never assume comma support");
        data = { instruments: [217.5, 220, 225, 230].flatMap((strike, index) => ["call", "put"].map((type, side) => ({ id: uuid(Number(args.expiration_dates.replaceAll("-", "")) * 1_000 + poolSymbols.indexOf(args.chain_symbol) * 100 + index * 2 + side + 1), chain_id: uuid(100 + poolSymbols.indexOf(args.chain_symbol)), chain_symbol: args.chain_symbol, underlying_type: "equity", expiration_date: args.expiration_dates, strike_price: String(strike), type, state: "active", tradability: "tradable", trade_value_multiplier: "100" }))).filter((row) => !args.type || row.type === args.type) };
      } else if (tool === "get_option_quotes") data = { results: args.instrument_ids.map((id) => ({ quote: { instrument_id: id, bid_price: "3.3", ask_price: "3.4", mark_price: "3.35", volume: "300", open_interest: "500", implied_volatility: ".4", delta: ".5", gamma: ".02", theta: "-.03", vega: ".1", updated_at: quoteAt } })) };
      else assert.fail(`unexpected tool ${tool}`);
      change(tool, data, args);
      return { content: [], structuredContent: { data } };
    },
  };
  return { session, calls };
}

const qualifiedAt = "2026-09-22T17:00:00.000Z";
function qualifiedInput() {
  const value = JSON.parse(JSON.stringify(input()).replaceAll("2026-09-09", "2026-09-22"));
  value.paperResearch = true; value.paperPreflight = true;
  value.run_id = value.slot_id = "paper-check:20260922T170000Z";
  return value;
}
function qualifiedFixture(strikes = [97, 98, 99, 99.5, 100, 100.5, 101, 102, 103], mutate = () => {}, poolSymbols = symbols, observedAt = qualifiedAt) {
  const offered = ["2026-09-25", "2026-09-29", "2026-10-02", "2026-10-09", "2026-10-23"];
  const instruments = poolSymbols.flatMap((symbol, stock) => offered.flatMap((expiration, expiry) => strikes.flatMap((strike, index) => ["call", "put"].map((type, side) => ({
    id: uuid(10_000 + stock * 1_000 + expiry * 100 + index * 2 + side), chain_id: uuid(100 + stock), chain_symbol: symbol, underlying_type: "equity", expiration_date: expiration,
    strike_price: String(strike), type, state: "active", tradability: "tradable", trade_value_multiplier: "100",
  })))));
  const calls = [], session = { async listTools() { throw Error("no discovery in synthetic fixture"); }, async call(tool, args) {
    calls.push({ tool, args });
    let data;
    if (tool === "get_equity_quotes") data = { results: args.symbols.map((symbol) => ({ quote: { symbol, last_trade_price: "100", bid_price: "99.99", ask_price: "100.01", venue_last_trade_time: observedAt } })) };
    else if (tool === "get_option_chains") data = { chains: [{ id: uuid(100 + poolSymbols.indexOf(args.underlying_symbol)), symbol: args.underlying_symbol, expiration_dates: offered }] };
    else if (tool === "get_option_instruments") {
      if (Object.hasOwn(args, "instrument_ids") || Object.hasOwn(args, "ids") && typeof args.ids !== "string") throw Error("get_option_instruments requires ids as a comma-separated string");
      data = { instruments: structuredClone(instruments.filter((row) => args.ids ? args.ids.split(",").includes(row.id) : row.chain_symbol === args.chain_symbol && row.expiration_date === args.expiration_dates && row.type === args.type)) };
    }
    else if (tool === "get_option_quotes") data = { results: args.instrument_ids.map((id) => ({ quote: { instrument_id: id, bid_price: "1.9", ask_price: "2", mark_price: "1.95", volume: "300", open_interest: "500", implied_volatility: ".4", delta: ".5", gamma: ".02", theta: "-.03", vega: ".1", updated_at: observedAt } })) };
    else assert.fail(`unexpected preflight tool ${tool}`);
    mutate(tool, data, args);
    return { content: [], structuredContent: { data } };
  } };
  return { calls, session, instruments };
}

function indexInput(date = "2026-10-01") {
  const value = JSON.parse(JSON.stringify(qualifiedInput()).replaceAll("2026-09-22", date));
  value.run_id = value.slot_id = `paper-check:${date.replaceAll("-", "")}T170000Z`;
  value.approvedCapabilities.fixed_pool.rows.unshift(...["SPY", "QQQ", "XSP"].map((symbol) => ({ ...structuredClone(value.approvedCapabilities.fixed_pool.rows[0]), symbol })));
  return value;
}

test("PAPER index reservation samples one ETF and two stocks within the existing budget, with QQQ backup and slot isolation", async (context) => {
  const indexAt = "2026-10-01T17:00:00.000Z", pool = ["SPY", "QQQ", "XSP", ...symbols];
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(indexAt) });
  const value = indexInput(), frozen = structuredClone(value.approvedCapabilities);
  const cases = [
    [{}, ["SPY", "NVDA", "AAPL"]],
    [{ paperExcludedSymbols: ["SPY", "NVDA", "AAPL"] }, ["QQQ", "TSLA", "MSFT"]],
    [{ paperExcludedSymbols: ["SPY", "QQQ"] }, ["NVDA", "AAPL", "TSLA"]],
    [{ paperEquityOnly: true }, ["NVDA", "AAPL", "TSLA"]],
    [{ paperIndexOnly: true }, ["SPY"]],
  ];
  for (const [options, expected] of cases) {
    const provider = qualifiedFixture(undefined, undefined, pool, indexAt);
    const rows = await collectStockPlanEvidence(provider.session, { ...value, ...options });
    assert.deepEqual(rows.map((row) => [row.symbol, row.direction]), expected.flatMap((symbol) => [[symbol, "BULLISH"], [symbol, "BEARISH"]]));
    assert.deepEqual(provider.calls.filter((call) => call.tool === "get_equity_quotes").map((call) => call.args.symbols), [expected]);
    assert.equal(provider.calls.length, 1 + expected.length * 8, "index coverage reuses the same two-expiry, two-direction reads");
    assert.ok(provider.calls.length <= 32);
    assert.ok(rows.every((row) => row.contracts.length && row.contracts.every((contract) => ["2026-10-09", "2026-10-23"].includes(contract.expiration))));
  }
  const blockedSpy = indexInput(); blockedSpy.approvedCapabilities.fixed_pool.rows[0].status = "DATA_BLOCKED";
  const backup = await collectStockPlanEvidence(qualifiedFixture(undefined, undefined, pool, indexAt).session, blockedSpy);
  assert.equal(backup[0].symbol, "QQQ");
  assert.deepEqual(value.approvedCapabilities, frozen, "selection cannot rewrite the frozen input");

  const manual = indexInput(); delete manual.paperResearch; delete manual.paperPreflight;
  manual.paperIndexOnly = true; manual.classifyPatterns = input().classifyPatterns;
  const manualProvider = fixture(undefined, ["2026-10-09", "2026-10-23"], pool);
  const manualRows = await collectStockPlanEvidence(manualProvider.session, manual);
  assert.deepEqual(manualRows.map((row) => row.symbol), ["NVDA", "AAPL", "TSLA"], "PAPER flags do not admit ETFs into ordinary stock analysis");
  context.mock.timers.setTime(Date.parse("2026-09-30T17:00:00.000Z"));
  const prior = indexInput("2026-09-30"); prior.paperIndexOnly = true;
  const oldRows = await collectStockPlanEvidence(qualifiedFixture(undefined, undefined, pool, "2026-09-30T17:00:00.000Z").session, prior);
  assert.deepEqual([...new Set(oldRows.map((row) => row.symbol))], ["NVDA", "AAPL", "TSLA"], "the new index slot does not change earlier dates");
});

test("PAPER index reservation rotates fallback indices but preserves Codex exact contract order and identity", async (context) => {
  const indexAt = "2026-10-01T17:00:00.000Z", pool = ["SPY", "QQQ", "XSP", ...symbols];
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(indexAt) });
  const value = indexInput(); delete value.paperPreflight;
  for (const onlyIndex of [false, true]) for (const [offset, expected] of [[0, "SPY"], [3, "QQQ"], [6, "SPY"]]) {
    const provider = qualifiedFixture(undefined, undefined, pool, indexAt);
    const rows = await collectStockPlanEvidence(provider.session, { ...value, paperCandidateOffset: offset, ...(onlyIndex ? { paperIndexOnly: true } : {}) });
    assert.equal(rows[0].symbol, expected, "mixed and index-only recovery both let QQQ follow a failed SPY attempt");
    assert.equal(rows.length, onlyIndex ? 1 : 3);
    assert.equal(rows.filter((row) => ["SPY", "QQQ"].includes(row.symbol)).length, 1);
    assert.ok(provider.calls.length <= 32);
  }
  const provider = qualifiedFixture(undefined, undefined, pool, indexAt);
  const exact = ["QQQ", "NVDA", "SPY"].map((symbol) => provider.instruments.find((row) => row.chain_symbol === symbol && row.expiration_date === "2026-10-09" && row.type === (symbol === "QQQ" ? "put" : "call") && row.strike_price === "101"));
  value.paperSelectedCandidates = exact.map((row) => ({ symbol: row.chain_symbol, direction: row.type === "put" ? "BEARISH" : "BULLISH", contract_id: row.id, reason: "synthetic selected contract", evidence_refs: [`stock:${row.chain_symbol}`] }));
  value.paperCandidateOffset = 3;
  const rows = await collectStockPlanEvidence(provider.session, value);
  assert.deepEqual(rows.map((row) => row.symbol), exact.map((row) => row.chain_symbol));
  assert.deepEqual(rows.map((row) => row.contracts.map((contract) => [contract.contract_id, contract.option_type, contract.strike])), exact.map((row) => [[row.id, row.type, 101]]));
  assert.deepEqual(provider.calls.filter((call) => call.tool === "get_option_instruments").map((call) => call.args), exact.map((row) => ({ ids: row.id })));
  assert.equal(provider.calls.some((call) => call.tool === "get_option_chains"), false, "exact candidates never fall back to another chain or strike");
});

test("fallback filters conflicting directions before the bounded three-symbol quote collection", async (context) => {
  const stamp = "2026-10-05T17:00:00.000Z", pool = ["SPY", "QQQ", "XSP", ...symbols];
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(stamp) });
  const value = indexInput("2026-10-05"); delete value.paperPreflight;
  for (const symbol of ["SPY", "NVDA"]) {
    const row = value.approvedCapabilities.fixed_pool.rows.find((row) => row.symbol === symbol);
    row.timeframes.one_hour.direction = row.timeframes.thirty_minute.direction = "BEARISH";
  }
  const frozen = structuredClone(value), provider = qualifiedFixture(undefined, undefined, pool, stamp);
  const rows = await collectStockPlanEvidence(provider.session, value);
  assert.deepEqual(rows.map((row) => row.symbol), ["QQQ", "AAPL", "TSLA"]);
  assert.deepEqual(provider.calls.find((call) => call.tool === "get_equity_quotes").args.symbols, ["QQQ", "AAPL", "TSLA"]);
  assert.ok(provider.calls.length <= 32); assert.deepEqual(value, frozen);
  const preflight = await collectStockPlanEvidence(qualifiedFixture(undefined, undefined, pool, stamp).session, { ...value, paperPreflight: true });
  assert.deepEqual([...new Set(preflight.map((row) => row.symbol))], ["SPY", "NVDA", "AAPL"], "Codex still evaluates both directions on original candidates");
});

test("qualified PAPER preflight samples both sides of three recent stocks independent of stage without duplicate spot reads", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(qualifiedAt) });
  const value = qualifiedInput();
  value.approvedCapabilities.fixed_pool.rows.forEach((row, index) => { row.swing.stage = ["INVALIDATED", "WAIT", "DATA_BLOCKED", "EXTENDED"][index]; row.swing.direction = "RANGE"; });
  const frozen = structuredClone(value.approvedCapabilities), provider = qualifiedFixture();
  const rows = await collectStockPlanEvidence(provider.session, value);
  assert.deepEqual(rows.map((row) => [row.symbol, row.direction]), ["NVDA", "AAPL", "TSLA"].flatMap((symbol) => [[symbol, "BULLISH"], [symbol, "BEARISH"]]));
  assert.deepEqual(provider.calls.filter((call) => call.tool === "get_equity_quotes").map((call) => call.args.symbols), [["NVDA", "AAPL", "TSLA"]]);
  assert.equal(provider.calls.length, 25); assert.ok(provider.calls.length <= 32);
  for (const row of rows) {
    assert.deepEqual([...new Set(row.contracts.map((contract) => contract.expiration))], ["2026-09-29", "2026-10-02"]);
    assert.deepEqual(row.contracts.filter((contract) => contract.expiration === "2026-09-29").map((contract) => contract.strike), row.direction === "BULLISH" ? [100, 99.5, 100.5, 101] : [100, 99.5, 99]);
    const { evidence_id, ...raw } = row; assert.equal(evidence_id, createHash("sha256").update(canonicalJson(raw)).digest("hex"));
  }
  assert.deepEqual(value.approvedCapabilities, frozen);
  value.paperExcludedSymbols = ["NVDA"]; value.paperCandidateOffset = 1;
  assert.deepEqual([...new Set((await collectStockPlanEvidence(qualifiedFixture().session, value)).map((row) => row.symbol))], ["TSLA", "MSFT", "AAPL"]);
  for (const fault of ["old-row", "future-row", "future-frame", "no-frame", "blocked-row"]) {
    const invalid = qualifiedInput(); invalid.approvedCapabilities.fixed_pool.rows = invalid.approvedCapabilities.fixed_pool.rows.slice(0, 1);
    const row = invalid.approvedCapabilities.fixed_pool.rows[0];
    if (fault === "old-row") row.as_of = "2026-09-18T20:00:00.000Z";
    if (fault === "future-row") row.as_of = "2026-09-22T17:01:00.000Z";
    if (fault === "future-frame") row.timeframes.daily.data_cutoff = "2026-09-22T17:01:00.000Z";
    if (fault === "no-frame") Object.values(row.timeframes).forEach((frame) => { frame.available = false; });
    if (fault === "blocked-row") row.status = "DATA_BLOCKED";
    const fixture = qualifiedFixture(); assert.deepEqual(await collectStockPlanEvidence(fixture.session, invalid), [], fault); assert.equal(fixture.calls.length, 0);
  }
});

test("qualified PAPER OTM targets deduplicate sparse grids and cannot add ITM or beyond two percent strikes", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(qualifiedAt) });
  const value = qualifiedInput(); value.approvedCapabilities.fixed_pool.rows = value.approvedCapabilities.fixed_pool.rows.slice(0, 1);
  for (const [grid, expected] of [[[99, 100, 101], [[100, 99, 101], [100, 99]]], [[97, 100, 103], [[100, 97], [100]]], [[99.9, 100, 100.1, 103], [[100, 99.9, 100.1], [100, 99.9]]], [[98, 100, 102], [[100, 98, 102], [100, 98]]], [[103, 104], [[], [103, 104]]]]) {
    const provider = qualifiedFixture(grid), rows = await collectStockPlanEvidence(provider.session, value);
    assert.deepEqual(rows.map((row) => row.contracts.filter((contract) => contract.expiration === "2026-09-29").map((contract) => contract.strike)), expected);
    rows.forEach((row) => assert.equal(new Set(row.contracts.map((contract) => contract.contract_id)).size, row.contracts.length));
    assert.ok(provider.calls.filter((call) => call.tool === "get_option_quotes").every((call) => call.args.instrument_ids.length > 0));
    if (!expected[0].length) assert.ok(rows[0].data_gaps.includes("NO_MODERATE_STRIKE"));
  }
});

test("PAPER accepts quotes received after archived collection began, preserves bar cutoffs and prioritizes existing mainstream stocks", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(qualifiedAt) });
  const value = qualifiedInput(), pool = ["NET", "BWXT", "HUBB", ...symbols];
  value.approvedCapabilities.generated_at = "2026-09-21T17:00:00.000Z";
  value.approvedCapabilities.fixed_pool.candidates = pool;
  value.approvedCapabilities.fixed_pool.rows = pool.map((symbol) => {
    const row = { ...structuredClone(value.approvedCapabilities.fixed_pool.rows[0]), symbol, as_of: "2026-09-21T17:00:30.000Z" };
    Object.values(row.timeframes).forEach((frame) => { frame.data_cutoff = "2026-09-21T16:59:00.000Z"; });
    return row;
  });
  const original = structuredClone(value.approvedCapabilities);
  const rows = await collectStockPlanEvidence(qualifiedFixture().session, value);
  assert.deepEqual([...new Set(rows.map((row) => row.symbol))], ["NVDA", "AAPL", "TSLA"], "same-batch delayed quotes do not erase mainstream alternatives");
  assert.deepEqual(value.approvedCapabilities, original, "historical timestamps and hashes are not rewritten");
  for (const fault of ["quote-after-decision", "bar-after-archive-cutoff"]) {
    const invalid = structuredClone(value); invalid.approvedCapabilities.fixed_pool.rows = invalid.approvedCapabilities.fixed_pool.rows.slice(3, 4);
    const row = invalid.approvedCapabilities.fixed_pool.rows[0];
    if (fault === "quote-after-decision") row.as_of = "2026-09-22T17:00:01.000Z";
    else row.timeframes.daily.data_cutoff = "2026-09-21T17:00:01.000Z";
    const provider = qualifiedFixture();
    assert.deepEqual(await collectStockPlanEvidence(provider.session, invalid), [], fault);
    assert.equal(provider.calls.length, 0, "future evidence is rejected before provider reads");
  }
  const formal = structuredClone(value); delete formal.paperResearch; delete formal.paperPreflight; formal.classifyPatterns = input().classifyPatterns;
  const manualRows = await collectStockPlanEvidence(fixture(undefined, paperExpirations, pool).session, formal);
  assert.deepEqual(manualRows.map((row) => row.symbol), ["NET", "BWXT", "HUBB"], "manual-plan ordering remains unchanged");
});

test("qualified PAPER exact contract refresh never substitutes a nearer ATM contract and rejects changed identity", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(qualifiedAt) });
  const provider = qualifiedFixture(), exact = provider.instruments.find((row) => row.chain_symbol === "NVDA" && row.expiration_date === "2026-09-29" && row.type === "put" && row.strike_price === "99");
  const value = qualifiedInput(); delete value.paperPreflight;
  value.paperSelectedCandidates = [{ symbol: "NVDA", direction: "BEARISH", contract_id: exact.id, reason: "synthetic moderate OTM", evidence_refs: ["stock:NVDA"] }];
  const { capturePaperQuoteEvidence } = await import("../server/paper-quote-evidence.ts");
  const captured = capturePaperQuoteEvidence(provider.session, () => new Date(qualifiedAt));
  const rows = await collectStockPlanEvidence(captured.session, value);
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].contracts.map((contract) => [contract.contract_id, contract.strike]), [[exact.id, 99]]);
  assert.deepEqual(provider.calls.filter((call) => call.tool.startsWith("get_option")).map((call) => [call.tool, call.args]), [["get_option_instruments", { ids: exact.id }], ["get_option_quotes", { instrument_ids: [exact.id] }]]);
  const quote = rows[0].contracts[0], proof = captured.proof({ symbol: "NVDA", contract: { contract_id: exact.id, chain_id: exact.chain_id, expiration: exact.expiration_date, strike: 99, option_type: "put", multiplier: 100 } }, { bid: quote.bid, ask: quote.ask, mark: quote.mark, quoted_at: quote.as_of }, qualifiedAt);
  assert.equal(proof?.instrument.id, exact.id); assert.equal(proof?.quote.instrument_id, exact.id);
  await assert.rejects(qualifiedFixture().session.call("get_option_instruments", { instrument_ids: [exact.id] }), /requires ids/);
  for (const fault of ["id", "symbol", "type", "chain", "underlying", "expiration", "invalid-date", "multiplier", "state", "tradability", "strike", "duplicate", "quote-id"]) {
    const bad = qualifiedFixture(undefined, (tool, data) => {
      if (tool === "get_option_quotes" && fault === "quote-id") data.results[0].quote.instrument_id = uuid(999);
      if (tool !== "get_option_instruments") return;
      const row = data.instruments[0];
      if (fault === "id") row.id = uuid(999);
      if (fault === "symbol") row.chain_symbol = "AAPL";
      if (fault === "type") row.type = "call";
      if (fault === "chain") row.chain_id = "invalid";
      if (fault === "underlying") row.underlying_type = "index";
      if (fault === "expiration") row.expiration_date = "2026-09-25";
      if (fault === "invalid-date") row.expiration_date = "2026-09-31";
      if (fault === "multiplier") row.trade_value_multiplier = "10";
      if (fault === "state") row.state = "inactive";
      if (fault === "tradability") row.tradability = "untradable";
      if (fault === "strike") row.strike_price = "0";
      if (fault === "duplicate") data.instruments.push({ ...row });
    });
    const rejected = await collectStockPlanEvidence(bad.session, value);
    assert.equal(rejected[0].contracts.length, 0, fault);
    assert.ok(rejected[0].data_gaps.includes(fault === "quote-id" ? "OPTION_QUOTE_IDENTITY_MISSING_OR_DUPLICATE" : "OPTION_SELECTED_CONTRACT_IDENTITY_INVALID"), fault);
    assert.equal(bad.calls.some((call) => call.tool === "get_option_chains"), false, "rejection never falls back to the ATM chain");
  }
});

test("qualified PAPER sampling does not activate before September 22 and preflight still shares one RPC/deadline cap", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(qualifiedAt) });
  const value = qualifiedInput(), paged = qualifiedFixture(undefined, (tool, data, args) => {
    if (tool === "get_option_instruments" && !args.cursor) { data.instruments = []; data.next = "https://provider.invalid/?cursor=page-2"; }
  });
  const rows = await collectStockPlanEvidence(paged.session, value);
  assert.equal(rows.length, 6); assert.equal(paged.calls.length, 32); assert.ok(rows.some((row) => row.data_gaps.includes("STOCK_EVIDENCE_RPC_LIMIT")));
  const stalled = qualifiedFixture(), original = stalled.session.call;
  stalled.session.call = async (tool, args) => tool === "get_option_chains" ? new Promise(() => {}) : original(tool, args);
  const timed = await collectStockPlanEvidence(stalled.session, { ...value, deadlineMs: 10 });
  assert.ok(timed.every((row) => row.contracts.length === 0 && row.data_gaps.includes("STOCK_EVIDENCE_DEADLINE")));
  const manual = qualifiedInput(); delete manual.paperResearch; delete manual.paperPreflight; manual.run_id = manual.slot_id = "live-shadow:20260922T170000Z"; manual.classifyPatterns = input().classifyPatterns;
  const manualFixture = fixture(undefined, ["2026-09-25", "2026-10-09"]), manualRows = await collectStockPlanEvidence(manualFixture.session, manual);
  assert.equal(manualRows.length, 3); assert.deepEqual(manualRows[0].contracts.map((row) => row.strike), [220, 217.5, 220, 217.5]);
  assert.ok(manualFixture.calls.some((call) => call.tool === "get_accounts"));
  context.mock.timers.setTime(Date.parse("2026-09-21T17:00:00.000Z"));
  const yesterday = JSON.parse(JSON.stringify(qualifiedInput()).replaceAll("2026-09-22", "2026-09-21")); delete yesterday.paperPreflight; yesterday.run_id = yesterday.slot_id = "paper-check:20260921T170000Z";
  const yesterdayRows = await collectStockPlanEvidence(qualifiedFixture().session, yesterday);
  assert.equal(yesterdayRows.length, 3); assert.deepEqual(yesterdayRows[0].contracts.map((row) => row.strike), [100, 99.5, 100, 99.5]);
  context.mock.timers.setTime(Date.parse(at));
  const old = input(); old.paperResearch = true; old.run_id = old.slot_id = "paper-check:20260909T170000Z";
  const before = await collectStockPlanEvidence(fixture(undefined, paperExpirations).session, old);
  assert.deepEqual(before[0].contracts.map((row) => row.strike), [220, 217.5, 220, 217.5]);
  old.paperPreflight = true; const inactive = fixture(); assert.deepEqual(await collectStockPlanEvidence(inactive.session, old), []); assert.equal(inactive.calls.length, 0);
});

test("stock collector keeps core separate, selects only three equity candidates and real mixed strike increments", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const { session, calls } = fixture(), rows = await collectStockPlanEvidence(session, input());
  assert.deepEqual(rows.map((row) => row.symbol), ["NVDA", "AAPL", "TSLA"]);
  assert.ok(rows.every((row) => row.data_gaps.length === 0));
  assert.ok(rows.every((row) => validateStockPlanEvidence(row) === row));
  for (const row of rows) assert.deepEqual(stockPlanAnalysisGaps(row, Date.parse(at)), [], row.symbol);
  assert.deepEqual(rows[0].contracts.map((row) => row.strike), [220, 217.5, 220, 217.5, 220, 217.5]);
  assert.ok(rows[1].contracts.every((row) => row.option_type === "put"));
  assert.equal(rows[0].account.status, "LIVE");
  assert.equal(rows[0].bars.values.length, 41, "the existing 30-second completed-bar grace is retained");
  assert.equal(rows[0].bars.as_of, "2026-09-09T16:55:00.000Z");
  assert.equal(rows[0].quote.as_of, quoteAt);
  assert.equal(rows[0].received_at, at);
  assert.equal(rows[0].source_snapshot_hash, input().source_snapshot_hash);
  assert.match(rows[0].evidence_id, /^[a-f0-9]{64}$/);
  const { evidence_id, ...evidence } = rows[0];
  assert.equal(evidence_id, createHash("sha256").update(canonicalJson(evidence)).digest("hex"));
  assert.equal(rows[0].contracts[0].instrument.trade_value_multiplier, 100);
  assert.ok(calls.length <= 19, JSON.stringify(calls));
  assert.equal(calls.filter((row) => row.tool === "get_accounts").length, 1);
  assert.equal(calls.filter((row) => row.tool === "get_option_chains").length, 3);
  assert.equal(calls.filter((row) => row.tool === "get_option_quotes").flatMap((row) => row.args.instrument_ids).length, 18);
});

test("Codex PAPER direction is separate from immutable swing and selects the corresponding real option side", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input(); value.paperResearch = true; value.run_id = value.slot_id = "paper-check:20260909T170000Z";
  value.approvedCapabilities.mode = "SHADOW"; value.approvedCapabilities.actionable = false;
  value.paperSelectedCandidates = [{ symbol: "NVDA", direction: "BEARISH", reason: "synthetic opposite view", evidence_refs: ["stock:NVDA"] }];
  const original = structuredClone(value.approvedCapabilities), { session, calls } = fixture(() => {}, paperExpirations);
  const rows = await collectStockPlanEvidence(session, value);
  assert.equal(rows.length, 1); assert.equal(rows[0].direction, "BEARISH");
  assert.equal(rows[0].planning_context.timeframes.daily.direction, "BULLISH");
  assert.ok(rows[0].contracts.every((contract) => contract.option_type === "put" && contract.instrument.type === "put"));
  assert.deepEqual(value.approvedCapabilities, original);
  assert.ok(!calls.some(({ tool }) => ["get_accounts", "get_equity_historicals"].includes(tool)));
  const formal = input(); formal.paperSelectedCandidates = value.paperSelectedCandidates;
  const formalRows = await collectStockPlanEvidence(fixture().session, formal);
  assert.equal(formalRows[0].direction, "BULLISH", "new PAPER selection does not override formal manual-review lane");
});

test("complete empty expiries retain other verified contracts, but all-empty and rejected identities stay blocked in both lanes", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  for (const paper of [false, true]) for (const outcome of ["empty-front", "all-empty", "rejected-front", "mixed-identity"]) {
    const expirations = paper ? paperExpirations : ["2026-09-09", "2026-09-14", "2026-10-09", "2026-12-08"];
    const value = input();
    if (paper) { value.paperResearch = true; value.run_id = value.slot_id = "paper-check:20260909T170000Z"; }
    const provider = fixture((tool, data, args) => {
      if (tool === "get_option_chains") data.chains[0].expiration_dates = expirations;
      if (tool !== "get_option_instruments") return;
      if (outcome === "all-empty" || outcome === "empty-front" && args.expiration_dates === expirations[0]) data.instruments = [];
      if (outcome === "rejected-front" && args.expiration_dates === expirations[0]) data.instruments.forEach((row) => { row.expiration_date = expirations[1]; });
      if (outcome === "mixed-identity") data.instruments[0].chain_symbol = "QQQ";
    });
    const rows = await collectStockPlanEvidence(provider.session, value);
    assert.equal(rows.length, 3);
    if (outcome === "empty-front") {
      for (const row of rows) {
        assert.equal(row.contracts.length, paper ? 2 : 6);
        assert.deepEqual([...new Set(row.contracts.map((contract) => contract.expiration))], expirations.slice(1));
        assert.ok(row.contracts.every((contract) => contract.instrument.chain_symbol === row.symbol && contract.as_of === quoteAt));
        if (!paper) assert.deepEqual(row.data_gaps, []);
      }
      assert.ok(buildPaperPlan(rows, at).plan);
    } else {
      assert.ok(rows.every((row) => row.contracts.length === 0 && row.data_gaps.includes("NO_VALID_OPTION_IDENTITIES")), `${paper}/${outcome}`);
      assert.equal(provider.calls.filter((row) => row.tool === "get_option_quotes").length, 0);
      assert.equal(buildPaperPlan(rows, at).plan, null);
      assert.ok(rows.every((row) => row.data_gaps.includes("OPTION_INSTRUMENT_IDENTITIES_REJECTED") === (outcome !== "all-empty")));
    }
  }
});

test("PAPER keeps the nearest expiry and covers Friday within two supplied 7–30 DTE expiries", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const outside = ["2026-09-09", "2026-09-10", "2026-10-10", "2026-12-08"]; // 0, 1, 31, 90 DTE.
  const boundaries = ["2026-09-16", "2026-10-09"]; // Exact 7 and 30 DTE, both trading dates.
  for (const [offered, expected] of [
    [[...outside, ...boundaries].reverse(), boundaries],
    [[...outside, ...boundaries, "2026-09-18"].reverse(), ["2026-09-16", "2026-09-18"]],
    [["2026-09-25", "2026-09-23", "2026-09-21", "2026-09-25"], ["2026-09-21", "2026-09-25"]], // Mon/Wed must not hide the supplied Friday.
    [["2026-09-18", "2026-09-21", "2026-09-25"], ["2026-09-18", "2026-09-21"]], // Friday already first: preserve both.
    [["2026-09-21", "2026-09-25", "2026-09-28"], ["2026-09-21", "2026-09-25"]], // Friday already second.
    [["2026-09-16", "2026-09-21", "2026-09-23"], ["2026-09-16", "2026-09-21"]], // No Friday: retain the earliest two.
    [["2026-09-11", "2026-09-21", "2026-09-23", "2026-10-16"], ["2026-09-21", "2026-09-23"]], // Fridays outside 7–30 DTE cannot enter.
    [[...outside, boundaries[0]], [boundaries[0]]],
    [outside, []],
  ]) {
    const value = input(); value.paperResearch = true; value.run_id = value.slot_id = "paper-check:20260909T170000Z";
    const provider = fixture(undefined, offered), rows = await collectStockPlanEvidence(provider.session, value);
    assert.equal(rows.length, 3);
    assert.deepEqual([...new Set(provider.calls.filter((row) => row.tool === "get_option_instruments").map((row) => row.args.expiration_dates))], expected);
    assert.ok(provider.calls.length <= 13, "two dates per each of three stocks remain bounded");
    for (const row of rows) {
      assert.deepEqual(provider.calls.filter((call) => call.tool === "get_option_instruments" && call.args.chain_symbol === row.symbol).map((call) => [call.args.expiration_dates, call.args.type]), expected.map((expiration) => [expiration, row.direction === "BULLISH" ? "call" : "put"]));
      assert.deepEqual([...new Set(row.contracts.map((contract) => contract.expiration))], expected);
      assert.equal(row.contracts.length, expected.length * 2);
      assert.ok(row.contracts.every((contract) => contract.instrument.chain_symbol === row.symbol && contract.as_of === quoteAt));
      if (!expected.length) assert.ok(row.data_gaps.includes("NO_OPTION_EXPIRATION_OBSERVED"));
    }
    assert.equal(Boolean(buildPaperPlan(rows, at).plan), expected.length > 0);
    if (!expected.length) assert.equal(provider.calls.filter((row) => row.tool === "get_option_quotes").length, 0);
  }
  const formal = fixture(undefined, [...outside, ...boundaries]), rows = await collectStockPlanEvidence(formal.session, input());
  assert.deepEqual([...new Set(rows[0].contracts.map((row) => row.expiration))], ["2026-09-09", "2026-09-16", "2026-10-09", "2026-12-08"]);
  assert.ok(rows.every((row) => row.contracts.length === 8 && row.data_gaps.length === 0), "formal four-horizon selection remains unchanged");
});

test("three accounts with two real-shaped positions and all four stock horizons fit the shared 32-RPC budget", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const provider = fixture((tool, data, args) => {
    if (tool === "get_accounts") data.accounts = [0, 1, 2].map((n) => ({ account_number: `TEST_ONLY_${n}` }));
    if (tool === "get_option_positions" && args.account_number !== "TEST_ONLY_2") data.positions = [{ option_id: uuid(900 + Number(args.account_number.slice(-1))), chain_symbol: "MSFT", type: "long", quantity: "1", average_price: "335" }];
    if (tool === "get_option_chains") data.chains[0].expiration_dates = ["2026-09-09", "2026-09-14", "2026-10-09", "2026-12-08"];
  });
  const rows = await collectStockPlanEvidence(provider.session, input());
  assert.equal(provider.calls.length, 26);
  assert.equal(provider.calls.filter((row) => row.tool === "get_option_positions").length, 3);
  assert.equal(provider.calls.filter((row) => row.tool === "get_option_instruments" && row.args.expiration_dates).length, 12);
  assert.equal(provider.calls.filter((row) => row.tool === "get_option_quotes").length, 4);
  assert.ok(provider.calls.every((row) => row.tool.startsWith("get_")));
  for (const row of rows) {
    assert.deepEqual(row.data_gaps, []);
    assert.equal(row.contracts.length, 8);
    assert.equal(row.account.status, "LIVE");
    assert.equal(row.account.account_count, 3);
    assert.equal(row.account.positions.length, 2);
    assert.ok(row.account.positions.every((position) => position.average_price === 3.35 && position.mark === 3.35 && position.as_of === quoteAt));
    assert.ok(!JSON.stringify(row).includes("TEST_ONLY_"), "account identifiers remain sanitized");
  }
});

test("explicit PAPER reads current contracts from a recent MARKET_CLOSED context without changing formal selection or source timestamps", async (context) => {
  const openingAt = "2026-09-10T13:30:45.000Z", frozenAt = "2026-09-09T20:00:00.000Z";
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(openingAt) });
  const value = input(); value.approvedCapabilities.generated_at = frozenAt;
  value.approvedCapabilities.fixed_pool.candidates = ["NVDA"];
  value.approvedCapabilities.fixed_pool.rows = value.approvedCapabilities.fixed_pool.rows.slice(0, 1);
  value.approvedCapabilities.fixed_pool.rows[0].status = "MARKET_CLOSED";
  const original = structuredClone(value.approvedCapabilities);
  const defaultSession = fixture();
  assert.deepEqual(await collectStockPlanEvidence(defaultSession.session, value), []);
  assert.equal(defaultSession.calls.length, 0, "formal collector still refuses MARKET_CLOSED context");
  value.paperResearch = true; value.run_id = "paper-check:20260910T133000Z"; value.slot_id = value.run_id;
  value.classifyPatterns = async () => assert.fail("PAPER must not wait on fresh intraday pattern classification");
  const freshSession = () => fixture((tool, data) => {
    if (tool === "get_equity_quotes") data.results.forEach((row) => { row.quote.venue_last_trade_time = openingAt; });
    if (tool === "get_equity_historicals") data.results.forEach((row) => { row.bars = []; });
    if (tool === "get_option_chains") data.chains[0].expiration_dates = ["2026-10-09"];
    if (tool === "get_option_quotes") data.results.forEach((row) => { row.quote.updated_at = openingAt; });
  });
  const { session, calls } = freshSession(), rows = await collectStockPlanEvidence(session, value);
  assert.equal(rows.length, 1); assert.equal(rows[0].quote.as_of, openingAt); assert.equal(rows[0].bars.values.length, 0);
  assert.equal(rows[0].planning_context.observed_at, frozenAt); assert.deepEqual(value.approvedCapabilities, original);
  assert.equal(rows[0].contracts[0].expiration, "2026-10-09", "real 29 DTE contract is retained from the recent frozen context");
  assert.ok(calls.length <= 24); assert.ok(calls.every((row) => row.tool.startsWith("get_")));
  assert.ok(calls.every((row) => !["get_accounts", "get_option_positions", "get_equity_historicals"].includes(row.tool)), "PAPER has no account or fresh-bar dependency");
  assert.equal(rows[0].account.status, "DATA_BLOCKED"); assert.ok(rows[0].data_gaps.includes("ACCOUNT_NOT_CURRENT"));
  assert.match(rows[0].setup_gaps.join(";"), /PAPER_FROZEN_STRUCTURE_ONLY/);
  const { plan, reasons } = buildPaperPlan(rows, openingAt);
  assert.ok(plan, reasons.join(";")); assert.equal(plan.executable, false); assert.equal(plan.reference.quoted_at, openingAt);
  assert.match(plan.warnings.join(";"), /上一完整交易日/);
  for (const fault of ["formal-id", "old-context", "future-context", "old-row-time", "missing-row-time", "stale-row", "blocked-row"]) {
    const invalid = structuredClone({ ...value, classifyPatterns: undefined }); invalid.classifyPatterns = value.classifyPatterns;
    if (fault === "formal-id") invalid.run_id = invalid.slot_id = "live-shadow:20260910T133000Z";
    if (fault === "old-context") invalid.approvedCapabilities.generated_at = "2026-09-08T20:00:00.000Z";
    if (fault === "future-context") invalid.approvedCapabilities.generated_at = "2026-09-10T13:31:00.000Z";
    if (fault === "old-row-time") invalid.approvedCapabilities.fixed_pool.rows[0].as_of = "2026-09-08T20:00:00.000Z";
    if (fault === "missing-row-time") invalid.approvedCapabilities.fixed_pool.rows[0].as_of = null;
    if (fault === "stale-row") invalid.approvedCapabilities.fixed_pool.rows[0].status = "STALE";
    if (fault === "blocked-row") invalid.approvedCapabilities.fixed_pool.rows[0].status = "DATA_BLOCKED";
    const rejected = freshSession(); assert.deepEqual(await collectStockPlanEvidence(rejected.session, invalid), [], fault); assert.equal(rejected.calls.length, 0, fault);
  }
  const stale = fixture((tool, data) => {
    if (tool === "get_equity_historicals") data.results.forEach((row) => { row.bars = []; });
    if (tool === "get_option_chains") data.chains[0].expiration_dates = ["2026-10-09"];
  });
  assert.equal(buildPaperPlan(await collectStockPlanEvidence(stale.session, value), openingAt).plan, null, "frozen analysis never substitutes for fresh contract and underlying quotes");
});

test("formal and PAPER supplement ETF-only shortlists from eligible original stocks, keeping priority, deduplication and the three-stock cap", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input(); value.approvedCapabilities.fixed_pool.candidates = ["SPY", "QQQ", "IWM", "DIA", "XLK"];
  const original = structuredClone(value.approvedCapabilities), formal = fixture();
  assert.deepEqual((await collectStockPlanEvidence(formal.session, value)).map((row) => row.symbol), ["NVDA", "AAPL", "TSLA"]);
  assert.ok(formal.calls.some((row) => row.tool === "get_accounts")); assert.ok(formal.calls.some((row) => row.tool === "get_equity_historicals"));
  value.paperResearch = true; value.run_id = value.slot_id = "paper-check:20260909T170000Z";
  const paper = fixture(undefined, paperExpirations), rows = await collectStockPlanEvidence(paper.session, value);
  assert.deepEqual(rows.map((row) => row.symbol), ["NVDA", "AAPL", "TSLA"]); assert.deepEqual(value.approvedCapabilities, original);
  assert.ok(paper.calls.length <= 24); assert.ok(buildPaperPlan(rows, at).plan);
  value.approvedCapabilities.fixed_pool.candidates = ["MSFT", "MSFT", "SPY"];
  assert.deepEqual((await collectStockPlanEvidence(fixture(undefined, paperExpirations).session, value)).map((row) => row.symbol), ["MSFT", "NVDA", "AAPL"]);
});

test("PAPER rotates bounded original candidates after failures while formal priority remains unchanged", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input(), original = structuredClone(value.approvedCapabilities);
  value.paperResearch = true; value.run_id = value.slot_id = "paper-check:20260909T170000Z";
  const collect = async (offset) => {
    value.paperCandidateOffset = offset;
    const provider = fixture((tool, data, args) => { if (tool === "get_option_chains" && args.underlying_symbol !== "MSFT") data.chains = []; }, paperExpirations);
    const rows = await collectStockPlanEvidence(provider.session, value);
    assert.ok(rows.length <= 3); assert.ok(provider.calls.length <= 24);
    return rows;
  };
  const first = await collect(0);
  assert.deepEqual(first.map((row) => row.symbol), ["NVDA", "AAPL", "TSLA"]);
  assert.equal(buildPaperPlan(first, at).plan, null, "failed initial three cannot manufacture a plan");
  const retry = await collect(3);
  assert.deepEqual(retry.map((row) => row.symbol), ["MSFT", "NVDA", "AAPL"]);
  assert.equal(buildPaperPlan(retry, at).plan.symbol, "MSFT", "next real candidate supplies a current exact contract");
  assert.deepEqual((await collect(12)).map((row) => row.symbol), first.map((row) => row.symbol), "rotation wraps without exceeding the bounded pool");
  value.paperExcludedSymbols = ["NVDA", "AAPL"];
  assert.deepEqual((await collect(0)).map((row) => row.symbol), ["TSLA", "MSFT"], "completed daily symbols cannot consume the remaining candidate quota");
  value.paperExcludedSymbols = symbols; const completed = fixture();
  assert.deepEqual(await collectStockPlanEvidence(completed.session, value), []); assert.equal(completed.calls.length, 0);
  assert.deepEqual(value.approvedCapabilities, original);
  for (const offset of [-1, NaN, 0.5]) {
    value.paperCandidateOffset = offset; const provider = fixture();
    await assert.rejects(collectStockPlanEvidence(provider.session, value), /INVALID_PAPER_CANDIDATE_OFFSET/);
    assert.equal(provider.calls.length, 0);
  }
  const formal = input(); formal.paperCandidateOffset = 3; formal.paperExcludedSymbols = symbols;
  assert.deepEqual((await collectStockPlanEvidence(fixture().session, formal)).map((row) => row.symbol), ["NVDA", "AAPL", "TSLA"]);
});

test("only PAPER can observe real directional WAIT or EXTENDED context and preserves the original stage warning", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input();
  value.approvedCapabilities.fixed_pool.rows.forEach((row, index) => { row.swing.stage = ["WAIT", "EXTENDED", "INVALIDATED", "DATA_BLOCKED"][index]; });
  const original = structuredClone(value.approvedCapabilities), formal = fixture();
  assert.deepEqual(await collectStockPlanEvidence(formal.session, value), []); assert.equal(formal.calls.length, 0);
  value.paperResearch = true; value.run_id = value.slot_id = "paper-check:20260909T170000Z";
  const rows = await collectStockPlanEvidence(fixture(undefined, paperExpirations).session, value);
  assert.deepEqual(rows.map((row) => row.symbol), ["NVDA", "AAPL"]);
  for (const [index, stage] of ["WAIT", "EXTENDED"].entries()) {
    const plan = buildPaperPlan([rows[index]], at).plan;
    assert.ok(plan); assert.equal(plan.executable, false); assert.match(plan.warnings.join(";"), new RegExp(`PAPER_RESEARCH_STAGE_${stage}`));
    assert.deepEqual(plan.why_watch, original.fixed_pool.rows[index].swing.why_watch);
  }
  assert.deepEqual(value.approvedCapabilities, original);
  for (const fault of ["no-reasons", "range", "unknown", "no-support", "future-support"]) {
    const invalid = input(); invalid.paperResearch = true; invalid.run_id = invalid.slot_id = value.run_id;
    const row = invalid.approvedCapabilities.fixed_pool.rows[0]; invalid.approvedCapabilities.fixed_pool.rows = [row]; row.swing.stage = "WAIT";
    if (fault === "no-reasons") row.swing.why_watch = [];
    if (fault === "range" || fault === "unknown") row.swing.direction = fault === "range" ? "RANGE" : "NOT_OBSERVED";
    if (fault === "no-support") Object.values(row.timeframes).forEach((frame) => { frame.direction = "BEARISH"; });
    if (fault === "future-support") Object.values(row.timeframes).forEach((frame) => { frame.data_cutoff = "2026-09-09T17:01:00.000Z"; });
    const provider = fixture(); assert.deepEqual(await collectStockPlanEvidence(provider.session, invalid), [], fault); assert.equal(provider.calls.length, 0, fault);
  }
});

test("PAPER keeps the original swing direction with one opposed short frame and rejects invalidated or neutral rows", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input();
  value.paperResearch = true; value.run_id = value.slot_id = "paper-check:20260909T170000Z";
  for (const row of value.approvedCapabilities.fixed_pool.rows) {
    const direction = row.swing.direction === "BULLISH" ? "BEARISH" : "BULLISH";
    Object.assign(row.timeframes.one_hour, { direction, data_cutoff: "2026-09-09T16:00:00.000Z" });
  }
  const original = structuredClone(value.approvedCapabilities);
  const provider = fixture(undefined, paperExpirations), rows = await collectStockPlanEvidence(provider.session, value);
  assert.deepEqual(rows.map(row => [row.symbol, row.direction]), [["NVDA", "BULLISH"], ["AAPL", "BEARISH"], ["TSLA", "BULLISH"]]);
  for (const row of rows) {
    const frozen = original.fixed_pool.rows.find(item => item.symbol === row.symbol);
    assert.deepEqual(row.planning_context.why_watch, frozen.swing.why_watch);
    assert.equal(row.planning_context.entry_trigger, frozen.swing.management.entry_trigger);
    assert.ok(row.contracts.every(contract => contract.option_type === (row.direction === "BULLISH" ? "call" : "put")));
    assert.equal(buildPaperPlan([row], at).plan?.entry_policy.version, "BASELINE_PAPER_RESEARCH_V1");
  }
  assert.deepEqual(value.approvedCapabilities, original);
  assert.ok(!provider.calls.some(call => ["get_equity_historicals", "get_accounts", "get_option_positions"].includes(call.tool)));
  value.approvedCapabilities.fixed_pool.rows[0].swing.stage = "INVALIDATED";
  value.approvedCapabilities.fixed_pool.rows[1].swing.direction = "RANGE";
  const remaining = await collectStockPlanEvidence(fixture(undefined, paperExpirations).session, value);
  assert.deepEqual(remaining.map(row => row.symbol), ["TSLA", "MSFT"]);
});

test("PAPER preserves original rank and rotates every candidate without increasing its stock or RPC budget", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input(); value.approvedCapabilities.fixed_pool.candidates = ["NVDA", "TSLA", "MSFT", "AAPL"];
  const formal = await collectStockPlanEvidence(fixture().session, value);
  assert.deepEqual(formal.map((row) => row.symbol), ["NVDA", "TSLA", "MSFT"]);
  value.paperResearch = true; value.run_id = value.slot_id = "paper-check:20260909T170000Z";
  for (const [offset, expected] of [[0, ["NVDA", "TSLA", "MSFT"]], [3, ["AAPL", "NVDA", "TSLA"]]]) {
    value.paperCandidateOffset = offset;
    const provider = fixture(undefined, paperExpirations), rows = await collectStockPlanEvidence(provider.session, value);
    assert.deepEqual(rows.map((row) => row.symbol), expected);
    assert.ok(provider.calls.length <= 32);
  }
  value.paperCandidateOffset = 0; value.paperExcludedSymbols = ["AAPL"];
  const sameSide = await collectStockPlanEvidence(fixture(undefined, paperExpirations).session, value);
  assert.deepEqual(sameSide.map((row) => row.symbol), ["NVDA", "TSLA", "MSFT"]);
  assert.ok(sameSide.every((row) => row.direction === "BULLISH"), "no unsupported Put is invented when none remains");
  for (const pool of [["NVDA", "TSLA", "MSFT", "AMZN", "GOOGL", "AAPL"], ["NVDA", "AAPL", "TSLA", "MSFT", "AMZN", "GOOGL", "META"], ["NVDA", "TSLA", "MSFT", "AMZN", "GOOGL", "META", "CRM", "CRWD", "AAPL"]]) {
    const rotating = input(), seen = new Set();
    rotating.paperResearch = true; rotating.run_id = rotating.slot_id = value.run_id;
    rotating.approvedCapabilities.fixed_pool.candidates = pool;
    rotating.approvedCapabilities.fixed_pool.rows = pool.map((symbol) => ({ ...structuredClone(rotating.approvedCapabilities.fixed_pool.rows[symbol === "AAPL" ? 1 : 0]), symbol }));
    for (let round = 0; round < Math.ceil(pool.length / 3); round++) {
      rotating.paperCandidateOffset = round * 3;
      const provider = fixture((tool, data, args) => { if (tool === "get_option_chains" && args.underlying_symbol === "AAPL") data.chains = []; }, paperExpirations, pool);
      const rows = await collectStockPlanEvidence(provider.session, rotating);
      rows.forEach((row) => seen.add(row.symbol));
      assert.equal(rows.length, 3);
      assert.ok(provider.calls.length <= 32);
      const put = rows.find((row) => row.symbol === "AAPL");
      if (put) assert.equal(put.contracts.length, 0, "failed opposite-side quotes cannot prevent other stocks being examined");
    }
    assert.deepEqual([...seen].sort(), [...pool].sort(), `${pool.length}-stock pool retains complete coverage across rotations`);
  }
});

test("v2 freezes original multi-timeframe planning context before reads and compares four real option horizons", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input(), original = structuredClone(value.approvedCapabilities.fixed_pool.rows[0]);
  const dates = ["2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14", "2026-10-09", "2026-10-16", "2026-12-08", "2027-01-15"];
  const { session, calls } = fixture((tool, data) => {
    if (tool === "get_option_chains") {
      data.chains[0].expiration_dates = dates;
      value.approvedCapabilities.fixed_pool.rows[0].swing.management.entry_trigger = 999;
      value.approvedCapabilities.fixed_pool.rows[0].timeframes.daily.support = 999;
    }
  });
  const rows = await collectStockPlanEvidence(session, value);
  assert.ok(rows.every((row) => row.contract_version === "stock-plan-v2" && row.data_gaps.length === 0));
  assert.ok(rows.every((row) => row.entry_rule === "MULTI_TIMEFRAME_BREAK_HOLD_V1"));
  assert.deepEqual(rows[0].planning_context, { observed_at: at, entry_trigger: original.swing.management.entry_trigger, invalidation_price: original.swing.management.price_invalidation, target_price: original.swing.management.target_1, why_watch: original.swing.why_watch, timeframes: original.timeframes });
  assert.deepEqual([...new Set(rows[0].contracts.map((row) => row.expiration))], ["2026-09-09", "2026-09-14", "2026-10-09", "2026-12-08"]);
  assert.ok(rows.every((row) => row.contracts.length === 8));
  for (const row of rows) assert.deepEqual(stockPlanAnalysisGaps(validateStockPlanEvidence(row), Date.parse(at)), [], row.symbol);
  assert.ok(calls.length <= 22);
  assert.equal(calls.filter((row) => row.tool === "get_option_instruments").length, 12);
  for (const { evidence_id, ...evidence } of rows) assert.equal(evidence_id, createHash("sha256").update(canonicalJson(evidence)).digest("hex"));
});

test("early entry evidence preserves explicit levels and only recovers a crossed null trigger from the original completed four-hour level", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input(), [bull, bear, explicit] = value.approvedCapabilities.fixed_pool.rows;
  for (const row of [bull, bear]) {
    row.swing.management.entry_trigger = null;
    row.timeframes.four_hour.data_cutoff = "2026-09-09T13:00:00.000Z";
    row.last = row.swing.direction === "BULLISH" ? 226 : 209;
  }
  explicit.swing.management.entry_trigger = 224;
  const rows = await collectStockPlanEvidence(fixture().session, value);
  assert.deepEqual(rows.map((row) => row.planning_context.entry_trigger), [225, 210, 224]);
  assert.ok(rows.every((row) => row.entry_rule === "MULTI_TIMEFRAME_BREAK_HOLD_V1"));
  for (const row of rows) { const { evidence_id, ...payload } = row; assert.equal(evidence_id, createHash("sha256").update(canonicalJson(payload)).digest("hex")); }
  for (const fault of ["unclosed", "unavailable", "wrong-direction", "missing-time", "missing-management", "not-crossed"]) {
    const changed = structuredClone(value.approvedCapabilities), row = changed.fixed_pool.rows[0];
    if (fault === "unclosed") row.timeframes.four_hour.data_cutoff = "2026-09-09T13:00:00.001Z";
    if (fault === "unavailable") row.timeframes.four_hour.available = false;
    if (fault === "wrong-direction") row.timeframes.four_hour.direction = "BEARISH";
    if (fault === "missing-time") row.timeframes.four_hour.data_cutoff = null;
    if (fault === "missing-management") delete row.swing.management;
    if (fault === "not-crossed") row.last = 220;
    const blocked = await collectStockPlanEvidence(fixture().session, { ...value, approvedCapabilities: changed });
    assert.equal(blocked[0].planning_context.entry_trigger, null, fault);
  }
});

test("five-bar collector output reaches the real early entry gate while unknown own-stock classification still blocks", async (context) => {
  const earlyAt = "2026-09-09T13:55:30.000Z";
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(earlyAt) });
  const value = input(), stock = value.approvedCapabilities.fixed_pool.rows[0];
  value.approvedCapabilities.generated_at = earlyAt; value.approvedCapabilities.fixed_pool.candidates = [stock.symbol];
  stock.last = 226; stock.swing.management.entry_trigger = null;
  for (const [key, cutoff] of Object.entries({ daily: "2026-09-08T00:00:00.000Z", four_hour: "2026-09-08T13:30:00.000Z", one_hour: "2026-09-08T19:00:00.000Z", thirty_minute: "2026-09-08T19:30:00.000Z" })) stock.timeframes[key].data_cutoff = cutoff;
  value.news.checked_at = earlyAt; value.global_risk.checked_at = earlyAt;
  value.news.items = [{ id: "fixture-verified", headline: "Synthetic verified evidence, not real news", url: "https://example.com/fixture", source: "FIXTURE", published_at: "2026-09-09T13:00:00.000Z", expires_at: "2026-09-09T14:00:00.000Z", verified: true, market_moving: false, symbols: [stock.symbol] }];
  const { session } = fixture((tool, data) => {
    if (tool === "get_equity_quotes") Object.assign(data.results[0].quote, { last_trade_price: "226", bid_price: "225.99", ask_price: "226.01", venue_last_trade_time: earlyAt });
    if (tool === "get_option_quotes") data.results.forEach((row) => { row.quote.updated_at = earlyAt; });
    if (tool === "get_equity_historicals") data.results[0].bars = [[221, 222, 220.8, 221.8], [221.8, 223, 221.6, 222.6], [222.6, 224.8, 222.5, 224.4], [224.4, 226, 224.2, 225.6], [225.6, 226.5, 225.2, 226]].map(([open_price, high_price, low_price, close_price], index) => ({ begins_at: new Date(Date.parse("2026-09-09T13:30:00.000Z") + index * 300_000).toISOString(), open_price, high_price, low_price, close_price, volume: 100 }));
  });
  const [evidence] = await collectStockPlanEvidence(session, value);
  assert.equal(validateStockPlanEvidence(evidence), evidence);
  assert.deepEqual(evidence.data_gaps, []); assert.deepEqual(evidence.setup_gaps, []);
  assert.equal(evidence.planning_context.entry_trigger, 225);
  assert.deepEqual(stockPlanAnalysisGaps(evidence, Date.parse(earlyAt)), []);
  assert.deepEqual(stockPlanEvidenceGaps(evidence, Date.parse(earlyAt)), []);
  assert.equal(stockPlanStructure(evidence).eligible, true);
  for (const regime of ["UNKNOWN", "WIDE_CHOP"]) {
    const blocked = structuredClone(evidence); blocked.pattern = { source: "A2_CLASSIFY_PATTERN_V1", regime, direction: "unknown" };
    const payload = { ...blocked }; delete payload.evidence_id; blocked.evidence_id = createHash("sha256").update(canonicalJson(payload)).digest("hex");
    assert.equal(stockPlanStructure(validateStockPlanEvidence(blocked)).eligible, false);
    assert.ok(stockPlanEvidenceGaps(blocked, Date.parse(earlyAt)).length > 0);
  }
});

test("v2 retains real dates in unclassified horizon gaps instead of forcing a nearest 0-15DTE contract", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  for (const dates of [["2026-09-19", "2026-11-23"], ["2026-10-09", "2026-11-23"], ["2026-10-09"]]) {
    const { session } = fixture((tool, data) => { if (tool === "get_option_chains") data.chains[0].expiration_dates = dates; });
    const rows = await collectStockPlanEvidence(session, input());
    assert.ok(rows.every((row) => row.data_gaps.length === 0));
    assert.deepEqual([...new Set(rows[0].contracts.map((row) => row.expiration))].sort(), [...dates].sort());
  }
});

test("v2 separates insufficient setup bars from unavailable or invalid market data without guessing context", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input(); value.classifyPatterns = async (batches) => batches.map(() => null);
  for (const count of [3, 4, 5, 11]) {
    const small = fixture((tool, data) => { if (tool === "get_equity_historicals") data.results.forEach((row) => { row.bars = row.bars.slice(-count - 1, -1); }); });
    const waiting = await collectStockPlanEvidence(small.session, value);
    assert.ok(waiting.every((row) => row.data_gaps.length === 0 && row.bars.values.length === count && row.planning_context));
    assert.ok(waiting.every((row) => row.setup_gaps.includes("EQUITY_BARS_INSUFFICIENT_FOR_SETUP") === (count < 5) && row.setup_gaps.includes("STOCK_PATTERN_CLASSIFICATION_UNAVAILABLE")));
    for (const row of waiting) assert.deepEqual(stockPlanAnalysisGaps(validateStockPlanEvidence(row), Date.parse(at)), [], `${row.symbol}/${count} bars/null pattern can be analyzed, not approved`);
  }
  for (const mode of ["empty", "invalid", "future", "provider"]) {
    const broken = fixture((tool, data) => {
      if (tool !== "get_equity_historicals") return;
      if (mode === "provider") throw Error("fixture provider unavailable");
      data.results.forEach((row) => { if (mode === "empty") row.bars = []; else if (mode === "future") row.bars[30].begins_at = "2026-09-09T17:00:05.000Z"; else row.bars[30].high_price = "0"; });
    });
    const rows = await collectStockPlanEvidence(broken.session, value);
    assert.ok(rows.every((row) => row.data_gaps.some((gap) => gap.startsWith("EQUITY_BARS_"))), mode);
    assert.ok(rows.every((row) => stockPlanAnalysisGaps(validateStockPlanEvidence(row), Date.parse(at)).length > 0), `${mode} must block the real analysis gate`);
  }
  delete value.approvedCapabilities.fixed_pool.rows[0].timeframes;
  const missing = await collectStockPlanEvidence(fixture().session, value);
  assert.equal(missing[0].planning_context, null);
  assert.ok(missing[0].data_gaps.includes("STOCK_PLANNING_CONTEXT_NOT_OBSERVED"));
});

test("v2 waits for the first completed bar but treats missing bars after its grace boundary as unavailable data", async (context) => {
  const firstBarReady = Date.parse("2026-09-09T13:35:30.000Z");
  context.mock.timers.enable({ apis: ["Date"], now: firstBarReady - 1 });
  const value = input(), observed = new Date().toISOString(), source = new Date(Date.now() - 10_000).toISOString();
  value.approvedCapabilities.generated_at = observed;
  value.approvedCapabilities.fixed_pool.rows.forEach((row) => Object.values(row.timeframes).forEach((frame) => { frame.data_cutoff = source; }));
  value.news.checked_at = source; value.global_risk.checked_at = source;
  value.classifyPatterns = async (batches) => batches.map(() => ({ source: "A2_CLASSIFY_PATTERN_V1", regime: "UNKNOWN", direction: "unknown" }));
  const empty = () => fixture((tool, data) => {
    if (tool === "get_equity_historicals") data.results.forEach((row) => { row.bars = []; });
    if (tool === "get_equity_quotes") data.results.forEach((row) => { row.quote.venue_last_trade_time = source; });
    if (tool === "get_option_quotes") data.results.forEach((row) => { row.quote.updated_at = source; });
  });
  const before = await collectStockPlanEvidence(empty().session, value);
  assert.ok(before.every((row) => row.data_gaps.length === 0 && validateStockPlanEvidence(row) === row));
  assert.ok(before.every((row) => row.bars.as_of === null && row.setup_gaps.includes("EQUITY_BARS_INSUFFICIENT_FOR_SETUP") && row.setup_gaps.includes("STOCK_PATTERN_CLASSIFICATION_UNAVAILABLE")));
  context.mock.timers.setTime(firstBarReady);
  const after = await collectStockPlanEvidence(empty().session, value);
  assert.ok(after.every((row) => row.data_gaps.includes("EQUITY_BARS_STALE_OR_MISSING")));
});

test("v2 multi-expiry pagination shares 32 RPCs and refuses incomplete or wrong-expiry evidence", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const paged = fixture((tool, data, args) => {
    if (tool === "get_option_chains") data.chains[0].expiration_dates = ["2026-09-09", "2026-09-14", "2026-10-09", "2026-12-08"];
    if (tool === "get_option_instruments") {
      data.instruments = args.cursor === "third-page" ? data.instruments.slice(2) : args.cursor ? data.instruments.slice(1, 2) : data.instruments.slice(0, 1);
      if (args.cursor !== "third-page") data.next = `https://provider.invalid/options/instruments/?cursor=${args.cursor ? "third-page" : "second-page"}`;
    }
  });
  const rows = await collectStockPlanEvidence(paged.session, input());
  assert.equal(paged.calls.length, 32);
  assert.ok(rows.every((row) => row.contracts.length === 0 && row.data_gaps.includes("STOCK_EVIDENCE_RPC_LIMIT") && !row.data_gaps.includes("STOCK_EVIDENCE_DEADLINE") && row.data_gaps.includes("OPTION_INSTRUMENT_LIST_PARTIAL")));
  assert.equal(paged.calls.filter((row) => row.tool === "get_option_quotes").length, 0);
  assert.ok(new Set(paged.calls.filter((row) => row.tool === "get_option_instruments").map((row) => row.args.expiration_dates)).size > 1);
  const wrongExpiry = fixture((tool, data, args) => {
    if (tool === "get_option_instruments" && args.expiration_dates !== "2026-09-09") data.instruments.forEach((row) => { row.expiration_date = "2026-09-09"; });
  });
  const blocked = await collectStockPlanEvidence(wrongExpiry.session, input());
  assert.ok(blocked.every((row) => row.contracts.length === 0 && row.data_gaps.includes("OPTION_INSTRUMENT_IDENTITIES_REJECTED") && row.data_gaps.includes("NO_VALID_OPTION_IDENTITIES")));
});

test("wrong contract identity, stale or future prices and incomplete provider rows fail closed", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  for (const [name, change] of [
    ["identity", (tool, data) => { if (tool === "get_option_instruments") data.instruments.forEach((row) => { row.chain_symbol = "QQQ"; }); }],
    ["stale", (tool, data) => { if (tool === "get_option_quotes") data.results.forEach((row) => { row.quote.updated_at = "2026-09-09T15:00:00.000Z"; }); }],
    ["future", (tool, data) => { if (tool === "get_equity_quotes") data.results.forEach((row) => { row.quote.venue_last_trade_time = "2026-09-09T17:01:00.000Z"; }); }],
    ["missing", (tool, data) => { if (tool === "get_option_quotes") data.results.forEach((row) => { delete row.quote.open_interest; }); }],
    ["bad account", (tool, data) => { if (tool === "get_option_positions") delete data.positions; }],
    ["missing multiplier", (tool, data) => { if (tool === "get_option_instruments") data.instruments.forEach((row) => { delete row.trade_value_multiplier; }); }],
    ["adjusted multiplier", (tool, data) => { if (tool === "get_option_instruments") data.instruments.forEach((row) => { row.trade_value_multiplier = "150"; }); }],
    ["wrong underlying type", (tool, data) => { if (tool === "get_option_instruments") data.instruments.forEach((row) => { row.underlying_type = "index"; }); }],
  ]) {
    const { session } = fixture(change), rows = await collectStockPlanEvidence(session, input());
    assert.ok(rows.every((row) => row.data_gaps.length > 0), name);
    if (name === "identity") assert.ok(rows.every((row) => row.contracts.length === 0));
  }
});

test("option cursors preserve opaque values and reject malformed or ambiguous continuation values", () => {
  for (const cursor of ["cD03ODcuMDAwMA==", "page_2-Ab/+==", "x".repeat(1024)]) assert.equal(robinhoodOptionCursor(cursor), cursor);
  for (const protocol of ["http", "https"]) assert.equal(robinhoodOptionCursor(`${protocol}://provider.invalid/?cursor=cD03ODcuMDAwMA%3D%3D`), "cD03ODcuMDAwMA==");
  assert.equal(robinhoodOptionCursor(`https://provider.invalid/?cursor=${"x".repeat(1024)}`), "x".repeat(1024));
  assert.equal(robinhoodOptionCursor(`https://provider.invalid/?cursor=${"x".repeat(1025)}`), undefined);
  for (const next of [undefined, null, 1, {}, [], "", " ", "cursor\n", "cursor\u0000", "cursor\u007f", "x".repeat(1025), "file://host/?cursor=next", "ftp://host/?cursor=next", "https://host/no-cursor", "https://host/?cursor=", "https://host/?cursor=one&cursor=two", "https://host/?cursor=%00", "https://host/?cursor=%252F", "https://host/\n?cursor=next"]) assert.equal(robinhoodOptionCursor(next), undefined, JSON.stringify(next));
});

test("bare and URL cursors use the same tool and unchanged filters before choosing nearest actual strikes", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  for (const next of ["cD03ODcuMDAwMA==", "http://provider.invalid/options/instruments/?cursor=cD03ODcuMDAwMA%3D%3D"]) {
  const { session, calls } = fixture((tool, data, args) => {
    if (tool === "get_option_chains") data.chains[0].expiration_dates = ["2026-09-09"];
    if (tool !== "get_option_instruments") return;
    assert.equal(args.type, args.chain_symbol === "AAPL" ? "put" : "call");
    assert.equal(args.tradability, "tradable");
    if (!args.cursor) {
      data.instruments = data.instruments.slice(0, 1);
      data.next = next;
    } else {
      assert.equal(args.cursor, "cD03ODcuMDAwMA==");
      data.instruments = data.instruments.slice(1);
    }
  });
  const rows = await collectStockPlanEvidence(session, input());
  assert.ok(rows.every((row) => row.data_gaps.length === 0));
  assert.deepEqual(rows[0].contracts.map((row) => row.strike), [220, 217.5]);
  assert.equal(calls.filter((row) => row.tool === "get_option_instruments").length, 6);
  for (const call of calls.filter((row) => row.tool === "get_option_instruments" && row.args.cursor)) {
    const { cursor, ...args } = call.args;
    assert.equal(cursor, "cD03ODcuMDAwMA==");
    assert.deepEqual(args, calls.find((row) => row.tool === call.tool && row.args.chain_symbol === args.chain_symbol && !row.args.cursor).args);
  }
  assert.ok(calls.length <= 16);
  }
});

test("unfinished, malformed or repeating cursor pages fail closed within three pages per equity", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  for (const mode of ["unending", "malformed", "repeating", "raw-repeating", "mixed-repeating"]) {
    const { session, calls } = fixture((tool, data, args) => {
      if (tool !== "get_option_instruments") return;
      const cursor = mode === "unending" ? `${args.cursor ?? ""}x` : "same";
      data.next = mode === "malformed" ? "file://provider.invalid/?cursor=next" : mode === "raw-repeating" || mode === "mixed-repeating" && args.cursor ? cursor : `http://provider.invalid/options/instruments/?cursor=${cursor}`;
    });
    const rows = await collectStockPlanEvidence(session, input());
    assert.ok(rows.every((row) => row.data_gaps.includes("OPTION_INSTRUMENT_LIST_PARTIAL")), mode);
    assert.ok(rows.every((row) => row.contracts.length === 0), mode);
    assert.ok(calls.filter((row) => row.tool === "get_option_instruments").length <= 9);
    assert.equal(calls.filter((row) => row.tool === "get_option_quotes").length, 0);
    assert.ok(calls.length <= 16);
  }
});

test("synthetic gap-fill, wrong provider interval and wrong trading bounds are not analytical evidence", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  for (const kind of ["interpolated", "interval", "bounds", "session"]) {
    const { session } = fixture((tool, data) => {
      if (tool !== "get_equity_historicals") return;
      for (const row of data.results) {
        if (kind === "interpolated") row.bars[30].interpolated = true;
        if (kind === "session") row.bars[30].session = "post";
        if (kind === "interval") row.interval = "minute";
        if (kind === "bounds") row.bounds = "24_5";
      }
    });
    const rows = await collectStockPlanEvidence(session, input());
    assert.ok(rows.every((row) => row.data_gaps.includes("EQUITY_BARS_INVALID_OR_MISSING")), kind);
    assert.ok(rows.every((row) => row.bars.values.length === 0), kind);
  }
});

test("completed bars enter evidence only at the exact 30-second grace boundary", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) + 29_999 });
  const before = await collectStockPlanEvidence(fixture().session, input());
  assert.equal(before[0].bars.values.length, 41);
  assert.equal(before[0].bars.as_of, "2026-09-09T16:55:00.000Z");
  context.mock.timers.setTime(Date.parse(at) + 30_000);
  const after = await collectStockPlanEvidence(fixture().session, input());
  assert.equal(after[0].bars.values.length, 42);
  assert.equal(after[0].bars.as_of, at);
});

test("provider timestamps later than collection start are retained if actually received later", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const sourceAt = "2026-09-09T17:00:01.000Z", finish = "2026-09-09T17:00:02.000Z";
  const { session } = fixture((tool, data) => {
    if (tool === "get_option_quotes") {
      data.results.forEach((row) => { row.quote.updated_at = sourceAt; });
      context.mock.timers.setTime(Date.parse(finish));
    }
  });
  const rows = await collectStockPlanEvidence(session, input());
  assert.equal(rows[0].observed_at, at);
  assert.equal(rows[0].received_at, finish);
  assert.equal(rows[0].contracts[0].as_of, sourceAt);
  assert.ok(rows.every((row) => row.data_gaps.length === 0));
});

test("a hung provider is bounded by one deadline and the account RPC count is capped", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input(); value.deadlineMs = 10;
  const stalled = fixture(), original = stalled.session.call;
  stalled.session.call = async (tool, args) => tool === "get_option_chains" ? new Promise(() => {}) : original(tool, args);
  const rows = await collectStockPlanEvidence(stalled.session, value);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.data_gaps.includes("OPTION_CONTRACTS_NOT_OBSERVED")));
  const overloaded = fixture((tool, data) => { if (tool === "get_accounts") data.accounts = Array.from({ length: 100 }, (_, n) => ({ account_number: `TEST_${n}` })); });
  const blocked = await collectStockPlanEvidence(overloaded.session, input());
  assert.equal(overloaded.calls.length, 32);
  assert.ok(blocked.every((row) => row.data_gaps.includes("ACCOUNT_READ_UNAVAILABLE") && row.data_gaps.includes("STOCK_EVIDENCE_RPC_LIMIT") && !row.data_gaps.includes("STOCK_EVIDENCE_DEADLINE")));
});

test("one provider failure does not replace another stock's evidence and calls remain bounded", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const { session, calls } = fixture((tool, _data, args) => { if (tool === "get_option_chains" && args.underlying_symbol === "AAPL") throw Error("fixture failure"); });
  const rows = await collectStockPlanEvidence(session, input());
  assert.equal(rows[0].contracts.length, 6);
  assert.equal(rows[1].contracts.length, 0);
  assert.ok(rows[1].data_gaps.some((gap) => gap.includes("OPTION")));
  assert.equal(rows[2].contracts.length, 6);
  assert.ok(calls.length <= 19);
});

test("option failures retain fixed stage codes without provider text or altered contract selection", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const privateText = "fixture-private-token account=123456789 response-body";
  for (const [name, tool, change, code] of [
    ["chain request", "get_option_chains", () => { throw Error(privateText); }, "OPTION_CHAIN_READ_FAILED"],
    ["chain response", "get_option_chains", (data) => { delete data.chains; }, "OPTION_CHAIN_RESPONSE_INVALID"],
    ["chain identity", "get_option_chains", (data) => { data.chains.push({ ...data.chains[0] }); }, "OPTION_CHAIN_RESPONSE_INVALID"],
    ["expiration", "get_option_chains", (data) => { data.chains[0].expiration_dates = []; }, "NO_OPTION_EXPIRATION_OBSERVED"],
    ["instrument request", "get_option_instruments", () => { throw Error(privateText); }, "OPTION_INSTRUMENT_READ_FAILED"],
    ["instrument response", "get_option_instruments", (data) => { delete data.instruments; }, "OPTION_INSTRUMENT_RESPONSE_INVALID"],
    ["oversized page", "get_option_instruments", (data) => { data.instruments = Array(1_001).fill(data.instruments[0]); }, "OPTION_PAGE_TOO_LARGE"],
    ["cursor", "get_option_instruments", (data) => { data.next = privateText; }, "OPTION_PAGINATION_INCOMPLETE"],
    ["missing identity", "get_option_instruments", (data) => { data.instruments.forEach((row) => { row.chain_symbol = "QQQ"; }); }, "NO_VALID_OPTION_IDENTITIES"],
    ["duplicate identity", "get_option_instruments", (data) => { data.instruments.push({ ...data.instruments[0] }); }, "DUPLICATE_OPTION_IDENTITY"],
    ["quote request", "get_option_quotes", () => { throw Error(privateText); }, "OPTION_QUOTES_READ_FAILED"],
    ["quote response", "get_option_quotes", (data) => { delete data.results; }, "OPTION_QUOTE_RESPONSE_INVALID"],
    ["quote identity missing", "get_option_quotes", (data) => { data.results.pop(); }, "OPTION_QUOTE_IDENTITY_MISSING_OR_DUPLICATE"],
    ["quote identity duplicate", "get_option_quotes", (data) => { data.results.push({ ...data.results[0] }); }, "OPTION_QUOTE_IDENTITY_MISSING_OR_DUPLICATE"],
  ]) await context.test(name, async () => {
    const { session, calls } = fixture((actual, data) => { if (actual === tool) change(data); });
    const rows = await collectStockPlanEvidence(session, input());
    assert.deepEqual(rows.map((row) => row.symbol), ["NVDA", "AAPL", "TSLA"]);
    for (const row of rows) {
      assert.ok(row.data_gaps.includes(code), JSON.stringify(row.data_gaps));
      assert.ok(!row.data_gaps.includes("OPTION_CHAIN_IDENTITY_OR_QUOTES_UNAVAILABLE"));
      assert.equal(row.contracts.length, 0, "partial data remains blocked");
      assert.ok(row.data_gaps.every((gap) => /^[A-Z0-9_]+$/.test(gap)));
      assert.ok(!JSON.stringify(row).includes(privateText));
      const { evidence_id, ...evidence } = row;
      assert.equal(evidence_id, createHash("sha256").update(canonicalJson(evidence)).digest("hex"));
    }
    assert.ok(calls.length <= 19);
  });
});

test("rejected RPCs and the shared deadline retain their option request stage without leaking content", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  for (const [tool, code] of [["get_option_chains", "OPTION_CHAIN_READ_FAILED"], ["get_option_instruments", "OPTION_INSTRUMENT_READ_FAILED"], ["get_option_quotes", "OPTION_QUOTES_READ_FAILED"]]) {
    const { session, calls } = fixture(), original = session.call;
    session.call = async (actual, args) => {
      const response = await original(actual, args);
      return actual === tool ? { isError: true, content: [{ type: "text", text: "fixture-private-provider-response" }] } : response;
    };
    const rows = await collectStockPlanEvidence(session, input());
    assert.ok(rows.every((row) => row.data_gaps.includes(code) && row.contracts.length === 0));
    assert.ok(!JSON.stringify(rows).includes("fixture-private-provider-response"));
    assert.ok(calls.length <= 19);
  }
  const { session } = fixture(), original = session.call;
  session.call = async (tool, args) => tool === "get_option_chains" ? new Promise(() => {}) : original(tool, args);
  const rows = await collectStockPlanEvidence(session, { ...input(), deadlineMs: 10 });
  assert.ok(rows.every((row) => row.data_gaps.includes("OPTION_CHAIN_READ_FAILED") && row.data_gaps.includes("STOCK_EVIDENCE_DEADLINE") && row.contracts.length === 0));
});

test("empty eligible equity shortlist performs zero provider requests", async () => {
  const value = input(); value.approvedCapabilities.fixed_pool.candidates = ["SPY", "QQQ", "XSP"];
  value.approvedCapabilities.fixed_pool.rows.forEach((row) => { row.swing.stage = "WAIT"; });
  const { session, calls } = fixture();
  assert.deepEqual(await collectStockPlanEvidence(session, value), []);
  assert.equal(calls.length, 0);
});

test("the classifier receives exact retained stock bars and its result is bound into the evidence hash", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input();
  let receivedBars;
  value.classifyPatterns = async (batches, v2Root, timeoutMs) => {
    assert.ok(timeoutMs > 0 && timeoutMs <= 20_000);
    assert.equal(v2Root, "test-reference-path");
    receivedBars = structuredClone(batches);
    return [{ source: "A2_CLASSIFY_PATTERN_V1", regime: "WIDE_CHOP", direction: "neutral" }, null, { source: "A2_CLASSIFY_PATTERN_V1", regime: "FALSE_BREAKOUT", direction: "bearish" }];
  };
  value.v2Root = "test-reference-path";
  const rows = await collectStockPlanEvidence(fixture().session, value);
  assert.deepEqual(receivedBars, rows.map((row) => row.bars.values));
  assert.equal(rows[0].pattern.regime, "WIDE_CHOP");
  assert.equal(rows[1].pattern, null);
  assert.ok(rows[1].setup_gaps.includes("STOCK_PATTERN_CLASSIFICATION_UNAVAILABLE"));
  assert.equal(rows[2].pattern.direction, "bearish");
  for (const { evidence_id, ...evidence } of rows) assert.equal(evidence_id, createHash("sha256").update(canonicalJson(evidence)).digest("hex"));
});

test("missing or failed classification is explicit, never a guessed stock regime", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const value = input();
  value.classifyPatterns = async () => { throw Error("classifier unavailable"); };
  const rows = await collectStockPlanEvidence(fixture().session, value);
  assert.ok(rows.every((row) => row.pattern === null && row.setup_gaps.includes("STOCK_PATTERN_CLASSIFICATION_UNAVAILABLE")));
});

test("real read-only A2 Python classifier preserves wide-chop and trend results without a tracker", async () => {
  const v2Root = resolve(import.meta.dirname, "../../v2-reference");
  assert.ok(existsSync(resolve(v2Root, "trading_os_v2/a2/pattern_tracker.py")), "The bundled core must be installed");
  const referenceBefore = createHash("sha256").update(readFileSync(resolve(v2Root, "trading_os_v2/a2/pattern_tracker.py"))).digest("hex");
  const bars = (trend) => Array.from({ length: 12 }, (_, n) => ({ begins_at: new Date(Date.parse(at) + n * 300_000).toISOString(), open: 100 + n * trend, close: 100 + n * trend, high: 100.2 + n * trend, low: 99.8 + n * trend, volume: 100 }));
  const result = await classifyStockPatterns([bars(0), bars(1), bars(1).slice(0, 5)], v2Root, 20_000);
  assert.deepEqual(result, [
    { source: "A2_CLASSIFY_PATTERN_V1", regime: "WIDE_CHOP", direction: "neutral" },
    { source: "A2_CLASSIFY_PATTERN_V1", regime: "TREND_UP", direction: "bullish" },
    { source: "A2_CLASSIFY_PATTERN_V1", regime: "TREND_UP", direction: "bullish" },
  ]);
  assert.equal(createHash("sha256").update(readFileSync(resolve(v2Root, "trading_os_v2/a2/pattern_tracker.py"))).digest("hex"), referenceBefore);
});

test("a timed-out Python classification closes its actual Windows descendant tree inside the shared budget", async (context) => {
  if (process.platform !== "win32") { context.skip("Windows-specific process-tree contract; the real classifier check remains mandatory on every platform."); return; }
  const fixtureRoot = mkdtempSync(resolve("tests", ".stock-pattern-process-"));
  try {
    const moduleRoot = resolve(fixtureRoot, "trading_os_v2/a2");
    mkdirSync(moduleRoot, { recursive: true });
    writeFileSync(resolve(fixtureRoot, "trading_os_v2/__init__.py"), "");
    writeFileSync(resolve(moduleRoot, "__init__.py"), "");
    writeFileSync(resolve(moduleRoot, "pattern_tracker.py"), "import json,os,subprocess,sys,time\nfrom pathlib import Path\ndef classify_pattern(bars, daily_atr):\n    child=subprocess.Popen([sys.executable,'-I','-B','-c','import time; time.sleep(60)'])\n    Path(__file__).with_suffix('.pids.json').write_text(json.dumps([os.getpid(),child.pid]))\n    time.sleep(60)\n");
    const started = performance.now();
    await assert.rejects(classifyStockPatterns([[]], fixtureRoot, 3_000), /STOCK_PATTERN_PROCESS_FAILED/);
    assert.ok(performance.now() - started <= 3_000, "cleanup must fit the original shared budget");
    const pids = JSON.parse(readFileSync(resolve(moduleRoot, "pattern_tracker.pids.json"), "utf8"));
    assert.equal(pids.length, 2, "the canary must actually start both Python processes");
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.ok(!readdirSync(moduleRoot).includes("__pycache__"), "-B must keep the imported source read-only");
  } finally {
    assert.ok(fixtureRoot.startsWith(`${resolve("tests")}\\.stock-pattern-process-`));
    rmSync(fixtureRoot, { recursive: true });
  }
});
