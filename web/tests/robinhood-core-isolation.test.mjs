import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as robinhood from "../server/robinhood-mcp.ts";
import { assessPositionRisks } from "../server/position-copilot.ts";
import { APPROVED_CORE70, APPROVED_EXTRA_STOCKS, APPROVED_FIXED70, APPROVED_UNIVERSE, parseOutputEnvelope } from "../app/snapshot-import.ts";

const observedAt = "2026-09-04T17:00:00.000Z";
const response = (data) => ({ content: [], structuredContent: { data } });
const parseA1Sources = (marketSources) => parseOutputEnvelope(JSON.stringify({
  gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "synthetic-watch-pool-validator", output_type: "A1_SHADOW_RESULT", channel: "SHADOW", observed_at: observedAt,
  payload: { contract_version: "v1", component: "A1", mode: "SHADOW", actionable: false, source_mode: "REPLAY", status: "HEALTHY", observed_at: observedAt, data_cutoff_at: observedAt, freshness_seconds: 0, result_hash: "a".repeat(64), evidence_ref: "synthetic/watch-pool.json", market_snapshot_id: marketSources.snapshot_id, market_snapshot_hash: marketSources.snapshot_hash, data_gaps: [], v2_result: {}, market_sources: marketSources },
}));
function marketSession(calls) {
  return { async call(tool, args) {
    calls.push({ tool, args });
    if (tool === "get_equity_quotes") return response({ results: args.symbols.map((symbol) => ({ quote: { symbol, last_trade_price: "100", bid_price: "99.99", ask_price: "100.01", previous_close: "99", updated_at: observedAt } })) });
    if (tool === "get_equity_historicals") return response({ results: args.symbols.map((symbol) => ({ symbol, bars: Array.from({ length: args.interval === "5minute" ? 2 : args.symbols.length === 2 && args.interval === "day" ? 25 : 40 }, (_, index) => ({ begins_at: new Date(Date.parse(observedAt) - (args.interval === "5minute" ? (2 - index) * 300_000 : (41 - index) * 86_400_000)).toISOString(), open_price: "99", high_price: "101", low_price: "98", close_price: "100", volume: "1000" })) })) });
    if (tool === "get_option_chains") return response({ chains: [{ symbol: args.underlying_symbol, expiration_dates: ["2026-09-11"] }] });
    if (tool === "get_option_instruments") return response({ instruments: ["call", "put"].map((type) => ({ id: `${args.chain_symbol}-${type}`, type, expiration_date: "2026-09-11", strike_price: "100" })) });
    if (tool === "get_option_quotes") return response({ results: args.instrument_ids.map((id) => ({ quote: { instrument_id: id, bid_price: "1.50", ask_price: "1.55", mark_price: "1.525", implied_volatility: "0.2", delta: "0.5", gamma: "0.01", theta: "-0.01", vega: "0.01", updated_at: observedAt } })) });
    if (tool === "get_option_historicals") return response({ results: args.instrument_ids.map((instrument_id) => ({ instrument_id, bars: [{ begins_at: "2026-09-04T16:30:00.000Z" }] })) });
    if (tool === "get_accounts") return response({ accounts: [{ account_number: "private-number", rhs_account_number: "private-rhs" }] });
    if (tool === "get_option_positions") return response({ positions: [] });
    if (tool === "get_option_orders") return response({ orders: [] });
    if (tool === "get_portfolio") return response({ total_value: "1000", options_value: "0" });
    if (tool === "get_realized_pnl") return response({ total_returns: "0" });
    throw new Error(`${tool} unavailable`);
  } };
}

function multiExpirySession(calls) {
  const session = marketSession(calls);
  return { async call(tool, args) {
    if (tool === "get_option_chains") {
      calls.push({ tool, args });
      return response({ chains: [{ symbol: args.underlying_symbol, expiration_dates: ["2026-09-11", "2026-10-02", "2026-12-18"] }] });
    }
    if (tool === "get_option_instruments" && args.chain_symbol) {
      calls.push({ tool, args });
      return response({ instruments: ["call", "put"].map((type) => ({ id: `${args.chain_symbol}-${args.expiration_dates}-${args.strike_price}-${type}`, type, expiration_date: args.expiration_dates, strike_price: args.strike_price })) });
    }
    return session.call(tool, args);
  } };
}

test("independent option reads use bounded parallel batches without changing selected evidence", async (context) => {
  const start = Date.parse(observedAt);
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  const expectedCalls = [], expected = await robinhood.collectRobinhoodReadonly(multiExpirySession(expectedCalls), observedAt);
  assert.deepEqual(expected.approved_capabilities.owner_watchlist, { status: "NOT_OBSERVED", items: [], reason: "尚未设置个人观察列表" });
  assert.ok(expected.approved_capabilities.provenance.every((row) => row.repository === "BUNDLED_REVIEWED_SOURCE"));
  // Public metadata removes the prior personal watchlist and private repository identities; market evidence stays frozen.
  assert.equal(expected.snapshot_hash, "a96ac3b45f4c8cf814f76e221efd235f97b961ff80474f17fd31003f2ca59bee", "preserve the complete de-identified v3/90 fixture snapshot");
  const calls = [], session = multiExpirySession(calls), pending = [], waves = [];
  const optionTools = new Set(["get_option_chains", "get_option_instruments", "get_option_quotes", "get_option_historicals"]);
  let finished = false;
  const run = robinhood.collectRobinhoodReadonly({ async call(tool, args) {
    if (optionTools.has(tool)) await new Promise((resolve) => pending.push({ tool, resolve }));
    return session.call(tool, args);
  } }, observedAt).finally(() => { finished = true; });
  try {
    for (let tick = 0; !finished && tick < 60; tick++) {
      await new Promise(setImmediate);
      const wave = pending.splice(0);
      if (!wave.length) continue;
      waves.push(wave.map((item) => item.tool));
      context.mock.timers.tick(1_000);
      for (const item of wave.toReversed()) item.resolve(); // Preserve source order even when responses race.
    }
    const actual = await run;
    context.diagnostic(JSON.stringify({ simulated_rpc_ms: 1_000, simulated_elapsed_ms: Date.now() - start, requests: calls.filter((item) => optionTools.has(item.tool)).length, wave_sizes: waves.map((wave) => wave.length), snapshot_hash: actual.snapshot_hash }));
    assert.deepEqual(actual, expected, "all frozen fields, timestamps, ordering and hashes stay identical");
    const canonicalCalls = (rows) => rows.map((row) => JSON.stringify(row)).sort();
    assert.deepEqual(canonicalCalls(calls), canonicalCalls(expectedCalls), "the same calls and arguments must be retained");
    assert.equal(calls.filter(({ tool }) => optionTools.has(tool)).length, 24);
    assert.deepEqual(waves[0], ["get_option_chains", "get_option_chains"], "independent index chains must start together");
    assert.equal(Math.max(...waves.map((wave) => wave.length)), 4, "instrument and quote/history stages allow at most four concurrent calls");
    assert.ok(waves.at(-1).includes("get_option_quotes") && waves.at(-1).includes("get_option_historicals"), "BBO must not delay independent history reads");
    assert.ok(Date.now() - start <= 8_000, "24 one-second RPCs should need no more than eight dependency waves");
  } finally {
    for (const item of pending.splice(0)) item.resolve();
    context.mock.timers.tick(60_000);
    await run;
  }
});

for (const failure of ["error", "deadline"]) test(`option batch ${failure} prevents later I/O and late mutation`, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse(observedAt) });
  const calls = [], started = [], pending = [], session = multiExpirySession(calls);
  const run = robinhood.collectRobinhoodReadonly({ async call(tool, args) {
    started.push({ tool, args });
    if (tool === "get_option_instruments" && args.chain_symbol) await new Promise((resolve, reject) => pending.push({ resolve, reject }));
    return session.call(tool, args);
  } }, observedAt);
  try {
    await new Promise(setImmediate);
    if (failure === "error") pending[0].reject(new Error("synthetic instrument failure"));
    else context.mock.timers.tick(60_000);
    const result = await run, frozen = JSON.stringify(result), startedCount = started.length;
    assert.equal(result.status, "LIVE");
    assert.equal(result.capabilities.option_bbo, false);
    assert.ok(result.errors.some((item) => item.scope === "options"));
    for (const item of pending) item.resolve();
    await new Promise(setImmediate);
    assert.equal(started.length, startedCount, "a failed/expired batch must not start later instrument, quote or history requests");
    assert.equal(JSON.stringify(result), frozen, "late responses cannot rewrite a frozen degraded snapshot");
  } finally {
    for (const item of pending) item.resolve();
    context.mock.timers.tick(60_000);
    await run;
  }
});

test("an oversized provider nearest-expiration set cannot exceed the four-request cap", async () => {
  const session = multiExpirySession([]);
  let active = 0, maximum = 0, historyCalls = 0;
  await robinhood.collectRobinhoodReadonly({ async call(tool, args) {
    const result = await session.call(tool, args);
    if (tool === "get_option_instruments" && args.chain_symbol) {
      // An inconsistent provider response must not invalidate the I/O concurrency bound.
      for (const item of result.structuredContent.data.instruments) item.expiration_date = "2026-09-11";
    }
    if (tool === "get_option_historicals") {
      historyCalls++; active++; maximum = Math.max(maximum, active);
      await new Promise(setImmediate); active--;
    }
    return result;
  } }, observedAt);
  assert.equal(historyCalls, 9);
  assert.equal(maximum, 4);
});

test("normal FULL preserves all evidence and account failure cannot discard good core evidence", async () => {
  const calls = [], session = marketSession(calls);
  const normal = await robinhood.collectRobinhoodReadonly(session, observedAt);
  assert.equal(normal.status, "LIVE");
  assert.equal(normal.account.status, "LIVE");
  assert.equal(normal.account.portfolio_value, 1000);
  assert.equal(normal.capabilities.option_bbo, true);
  assert.equal(normal.approved_capabilities.fixed_pool.rows.length, 90);
  assert.equal(normal.approved_capabilities.fixed_pool.observed_count, 90);
  assert.equal(normal.market_environment.sector_breadth.status, "LIVE");
  const result = await robinhood.collectRobinhoodReadonly({ async call(tool, args) { if (tool === "get_accounts") throw new Error("get_accounts unavailable"); return session.call(tool, args); } }, observedAt);
  assert.equal(result.status, "LIVE");
  assert.equal(result.bars.length, 2);
  assert.ok(result.bars.every((bar) => bar.freshness_seconds === 0 && bar.daily_bar_count === 25));
  assert.deepEqual(result.quotes, normal.quotes);
  assert.deepEqual(result.bars, normal.bars);
  assert.deepEqual(result.options, normal.options);
  assert.deepEqual(result.approved_capabilities.fixed_pool, normal.approved_capabilities.fixed_pool);
  assert.equal(result.account.status, "DATA_BLOCKED");
  assert.equal(result.account.positions, null);
  assert.ok(result.errors.some((item) => item.scope === "account" && item.message === "get_accounts unavailable"));
  const optionalFailed = await robinhood.collectRobinhoodReadonly({ async call(tool, args) {
    if (tool === "get_option_chains" || tool.startsWith("get_equity_") && args.symbols.join(",") !== "SPY,QQQ") throw new Error(`${tool} unavailable`);
    return session.call(tool, args);
  } }, observedAt);
  assert.equal(optionalFailed.status, "LIVE");
  assert.equal(optionalFailed.capabilities.option_bbo, false);
  assert.equal(optionalFailed.options.length, 2);
  assert.ok(["options", "market_environment"].every((scope) => optionalFailed.errors.some((item) => item.scope === scope)));
  assert.ok(optionalFailed.errors.some((item) => item.scope.startsWith("watch_pool:")));
  await assert.rejects(robinhood.collectRobinhoodReadonly({ async call() { throw new Error("Auth required"); } }, observedAt), /Auth required/);
});

test("healthy enhancements taking 25 seconds retain the full watch pool, options and account evidence", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse(observedAt) });
  const calls = [], session = marketSession(calls);
  let release;
  const providerReady = new Promise((resolve) => { release = resolve; });
  const run = robinhood.collectRobinhoodReadonly({ async call(tool, args) {
    if (!(tool.startsWith("get_equity_") && args.symbols.join(",") === "SPY,QQQ")) await providerReady;
    return session.call(tool, args);
  } }, observedAt, undefined, null, new Date(Date.parse(observedAt) + 90_000).toISOString());
  await new Promise(setImmediate);
  context.mock.timers.tick(25_000); release();
  const result = await run;
  assert.equal(result.account.status, "LIVE");
  assert.equal(result.capabilities.option_bbo, true);
  assert.equal(result.approved_capabilities.fixed_pool.observed_count, 90);
  assert.equal(result.freshness_seconds, 25);
  assert.equal(result.errors.length, 0);
});

test("the extra 20 wait for all 42 core-pool reads plus options, account and environment", async () => {
  const coreRead = ({ tool, args }) => tool.startsWith("get_equity_") && args.symbols.length === 10 && args.symbols.every((symbol) => APPROVED_CORE70.includes(symbol));
  const extraRead = ({ tool, args }) => tool.startsWith("get_equity_") && args.symbols.some((symbol) => APPROVED_EXTRA_STOCKS.includes(symbol));
  for (const blocked of ["core", "options", "account", "environment"]) {
    const session = marketSession([]), completed = [], started = [], gate = Promise.withResolvers();
    let completedBeforeExtra;
    const run = robinhood.collectRobinhoodReadonly({ async call(tool, args) {
      const request = { tool, args };
      started.push(request);
      if (extraRead(request)) completedBeforeExtra ??= completed.slice();
      if (blocked === "core" && tool === "get_equity_historicals" && args.interval === "day" && args.symbols.includes("AAPL")
        || blocked === "options" && tool === "get_option_quotes"
        || blocked === "account" && tool === "get_portfolio"
        || blocked === "environment" && tool === "get_equity_quotes" && args.symbols.includes("SHY")) await gate.promise;
      const result = await session.call(tool, args);
      completed.push(request);
      return result;
    } }, observedAt);
    try {
      await new Promise(setImmediate);
      assert.deepEqual(started.slice(0, 3).map((item) => item.args.symbols), [["SPY", "QQQ"], ["SPY", "QQQ"], ["SPY", "QQQ"]]);
      assert.equal(started.filter(extraRead).length, 0, `${blocked} alone must hold extra I/O until it finishes`);
      gate.resolve();
      const result = await run;
      assert.equal(completedBeforeExtra.filter(coreRead).length, 42, "the complete core pool precedes any extra request");
      assert.ok(completedBeforeExtra.some((item) => item.tool === "get_option_quotes") && completedBeforeExtra.some((item) => item.tool === "get_option_historicals"));
      assert.ok(completedBeforeExtra.some((item) => item.tool === "get_portfolio"));
      assert.ok(completedBeforeExtra.some((item) => item.tool === "get_equity_quotes" && item.args.symbols.includes("SHY")));
      assert.equal(started.filter(coreRead).length, 42);
      assert.equal(started.filter(extraRead).length, 12);
      assert.ok(started.filter(extraRead).every((item) => item.args.symbols.length === 10 && item.args.symbols.every((symbol) => APPROVED_EXTRA_STOCKS.includes(symbol))));
      assert.equal(result.approved_capabilities.contract_version, "v3");
      assert.equal(result.approved_capabilities.fixed_pool.universe_size, 90);
      assert.equal(result.approved_capabilities.fixed_pool.observed_count, 90);
      assert.deepEqual(result.approved_capabilities.fixed_pool.missing_symbols, []);
      assert.deepEqual(result.approved_capabilities.fixed_pool.rows.map((row) => row.symbol), APPROVED_UNIVERSE);
      assert.equal(result.market_environment.extended_hours.universe_version, "OWNER_90_V1");
      assert.deepEqual(result.market_environment.extended_hours.instruments.map((row) => row.symbol), APPROVED_UNIVERSE);
      assert.deepEqual(result.approved_capabilities.owner_watchlist.items, []);
      assert.equal(result.approved_capabilities.owner_watchlist.status, "NOT_OBSERVED");
      assert.equal(started.some((item) => item.args.symbols?.includes("XSP")), false);
      assert.doesNotThrow(() => parseA1Sources(result), "the real collector output must pass the A1 ingress validator");
    } finally {
      gate.resolve();
      await run;
    }
  }
});

test("partial extras share the original deadline and preserve core evidence with truthful missing rows", async (context) => {
  const start = Date.parse(observedAt);
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  const baseline = await robinhood.collectRobinhoodReadonly(marketSession([]), observedAt);
  const calls = [], started = [], session = marketSession(calls), priority = Promise.withResolvers(), late = Promise.withResolvers();
  const missing = APPROVED_EXTRA_STOCKS.slice(10);
  let finished = false;
  const run = robinhood.collectRobinhoodReadonly({ async call(tool, args) {
    started.push({ tool, args, at: Date.now() });
    if (tool === "get_portfolio") await priority.promise;
    if (tool.startsWith("get_equity_") && args.symbols.some((symbol) => missing.includes(symbol))) await late.promise;
    return session.call(tool, args);
  } }, observedAt).finally(() => { finished = true; });
  try {
    await new Promise(setImmediate);
    context.mock.timers.tick(55_000);
    priority.resolve();
    await new Promise(setImmediate);
    const extraRequests = started.filter((item) => item.args.symbols?.some((symbol) => APPROVED_EXTRA_STOCKS.includes(symbol)));
    assert.equal(extraRequests.length, 12);
    assert.ok(extraRequests.every((item) => item.at === start + 55_000));
    context.mock.timers.tick(4_999);
    await new Promise(setImmediate);
    assert.equal(finished, false, "the shared budget is still available at 59.999 seconds");
    context.mock.timers.tick(1);
    await new Promise(setImmediate);
    assert.equal(finished, true, "extras do not receive another 60-second budget after primary evidence completes");
    const result = await run, fixed = result.approved_capabilities.fixed_pool;
    assert.equal(result.status, "LIVE");
    for (const field of ["quotes", "bars", "options", "account"]) assert.deepEqual(result[field], baseline[field], `${field} survives partial extra failure`);
    for (const field of ["rates", "oil", "sector_breadth"]) assert.deepEqual(result.market_environment[field], baseline.market_environment[field]);
    assert.deepEqual(fixed.rows.filter((row) => APPROVED_CORE70.includes(row.symbol)), baseline.approved_capabilities.fixed_pool.rows.filter((row) => APPROVED_CORE70.includes(row.symbol)));
    assert.equal(fixed.universe_size, 90);
    assert.equal(fixed.rows.length, 90);
    assert.equal(fixed.observed_count, 80);
    assert.equal(fixed.status, "DATA_BLOCKED");
    assert.deepEqual(fixed.missing_symbols, missing);
    assert.ok(fixed.rows.filter((row) => missing.includes(row.symbol)).every((row) => row.status === "DATA_BLOCKED" && row.last === null && row.as_of === null));
    assert.ok(fixed.rows.filter((row) => APPROVED_EXTRA_STOCKS.slice(0, 10).includes(row.symbol)).every((row) => row.status !== "DATA_BLOCKED"));
    assert.equal(result.market_environment.extended_hours.coverage.read_failed, 10);
    assert.ok(result.market_environment.extended_hours.instruments.filter((row) => missing.includes(row.symbol)).every((row) => row.status === "DATA_BLOCKED" && row.price === null && row.as_of === null));
    assert.ok(result.errors.some((item) => item.scope.startsWith("watch_pool:") && item.message.includes("ENHANCEMENT_DEADLINE")));
    assert.doesNotThrow(() => parseA1Sources(result), "honest partial coverage remains a valid archived snapshot");
    const frozen = JSON.stringify(result), startedCount = started.length;
    late.resolve();
    await new Promise(setImmediate);
    assert.equal(started.length, startedCount, "a late extra response cannot launch more I/O");
    assert.equal(JSON.stringify(result), frozen, "late data cannot replace frozen missing evidence");
  } finally {
    priority.resolve(); late.resolve();
    context.mock.timers.tick(60_000);
    await run;
  }
});

test("A1 ingress accepts versioned 90 and legacy 70 snapshots but rejects inconsistent current coverage", async () => {
  const current = await robinhood.collectRobinhoodReadonly(marketSession([]), observedAt), before = JSON.stringify(current);
  assert.doesNotThrow(() => parseA1Sources(current));
  const legacy = structuredClone(current), approved = legacy.approved_capabilities, fixed = approved.fixed_pool;
  approved.contract_version = "v2";
  const legacyRows = (rows) => rows.filter((row) => APPROVED_CORE70.includes(row.symbol)).map((row) => ({ ...row, symbol: row.symbol === "XOP" ? "XSP" : row.symbol }));
  fixed.rows = legacyRows(fixed.rows);
  fixed.universe_size = fixed.observed_count = 70;
  fixed.candidates = fixed.candidates.filter((symbol) => APPROVED_CORE70.includes(symbol)).map((symbol) => symbol === "XOP" ? "XSP" : symbol);
  for (const [key, direction] of [["bullish", "BULLISH"], ["bearish", "BEARISH"], ["range", "RANGE"]]) fixed.breadth[key] = fixed.rows.filter((row) => row.direction === direction).length;
  const extended = legacy.market_environment.extended_hours;
  delete extended.universe_version;
  extended.instruments = legacyRows(extended.instruments);
  for (const key of Object.keys(extended.coverage)) extended.coverage[key] = extended.instruments.filter((row) => row.capability === key.toUpperCase()).length;
  assert.deepEqual(fixed.rows.map((row) => row.symbol), APPROVED_FIXED70);
  assert.doesNotThrow(() => parseA1Sources(legacy), "legacy v2 data remains a 70-symbol archive without expansion");
  fixed.rows = fixed.rows.filter((row) => row.symbol !== "XSP");
  fixed.observed_count = 69; fixed.missing_symbols = ["XSP"]; fixed.status = "DATA_BLOCKED";
  assert.doesNotThrow(() => parseA1Sources(legacy), "legacy snapshots may omit an unsupported XSP row");
  const mutations = [
    ["missing row", (value) => { const pool = value.approved_capabilities.fixed_pool; pool.missing_symbols = [pool.rows.pop().symbol]; pool.observed_count--; pool.status = "DATA_BLOCKED"; }],
    ["wrong missing identity", (value) => { const pool = value.approved_capabilities.fixed_pool; pool.rows.at(-1).status = "DATA_BLOCKED"; pool.observed_count--; pool.missing_symbols = ["MP"]; pool.status = "DATA_BLOCKED"; }],
    ["legacy size under v3", (value) => { value.approved_capabilities.fixed_pool.universe_size = 70; }],
    ["unknown capability version", (value) => { value.approved_capabilities.contract_version = "v4"; }],
    ["mismatched 24_5 version", (value) => { delete value.market_environment.extended_hours.universe_version; }],
    ["unknown 24_5 version", (value) => { value.market_environment.extended_hours.universe_version = "OWNER_100_V1"; }],
  ];
  for (const [label, mutate] of mutations) {
    const invalid = structuredClone(current); mutate(invalid);
    assert.throws(() => parseA1Sources(invalid), { code: "INVALID_FORMAT" }, label);
  }
  assert.equal(JSON.stringify(current), before, "compatibility checks must not mutate the current frozen snapshot");
});

test("stalled enhancements have one bounded wait and cannot discard or later rewrite core evidence", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse(observedAt) });
  const calls = [], session = marketSession(calls);
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const run = robinhood.collectRobinhoodReadonly({ async call(tool, args) {
    const core = tool.startsWith("get_equity_") && args.symbols.join(",") === "SPY,QQQ";
    if (!core) await stalled;
    return session.call(tool, args);
  } }, observedAt);
  try {
    await new Promise(setImmediate);
    assert.equal(calls.length, 3, "only the required core calls completed");
    context.mock.timers.tick(60_000);
    const result = await Promise.race([run, delay(100, "CORE_STILL_WAITING")]);
    assert.notEqual(result, "CORE_STILL_WAITING", "optional requests must not retain the core result after the shared 60s budget");
    assert.equal(result.status, "LIVE");
    assert.equal(result.account.status, "DATA_BLOCKED");
    assert.equal(result.account.positions, null);
    assert.equal(result.options.length, 2);
    assert.ok(result.bars.every((bar) => bar.daily_bar_count === 25));
    assert.ok(result.errors.some((item) => item.message.includes("ENHANCEMENT_DEADLINE")));
    const frozen = JSON.stringify(result);
    release();
    await new Promise(setImmediate);
    assert.equal(JSON.stringify(result), frozen, "late evidence must not change the frozen input");
    assert.equal(calls.some(({ tool }) => tool === "get_option_instruments" || tool === "get_option_positions"), false, "expired collectors must not start further calls");
  } finally { release(); await run; }
});

for (const remainingMs of [30_000, 3_000]) test(`optional evidence leaves time to commit A1 with ${remainingMs}ms remaining`, async (context) => {
  const start = Date.parse(observedAt), calls = [], session = marketSession(calls);
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  const freezeAt = start + remainingMs;
  let settled = false;
  const run = robinhood.collectRobinhoodReadonly({ async call(tool, args) {
    if (!(tool.startsWith("get_equity_") && args.symbols.join(",") === "SPY,QQQ")) return new Promise(() => {});
    return session.call(tool, args);
  } }, observedAt, undefined, null, new Date(freezeAt).toISOString()).then((result) => { settled = true; return result; });
  try {
    await new Promise(setImmediate);
    context.mock.timers.tick(Math.max(0, remainingMs - 5_000));
    await new Promise(setImmediate);
    assert.equal(settled, true, "optional I/O must finish before the hard freeze deadline, leaving serialization and persistence time");
    const result = await run;
    assert.equal(result.status, "LIVE");
    assert.equal(result.account.status, "DATA_BLOCKED");
    assert.ok(Date.now() + 1 < freezeAt, "even a 1ms commit must not turn the completed core into A1_SLOT_FREEZE_DEADLINE_EXCEEDED");
  } finally { context.mock.timers.tick(remainingMs); await run; }
});

test("enhancement budget respects the slot deadline and freshness is rechecked before freezing", async (context) => {
  const start = Date.parse(observedAt);
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  const calls = [], session = marketSession(calls);
  const coreOnly = { async call(tool, args) {
    if (!(tool.startsWith("get_equity_") && args.symbols.join(",") === "SPY,QQQ")) return new Promise(() => {});
    const result = await session.call(tool, args);
    if (tool === "get_equity_quotes") for (const row of result.structuredContent.data.results) row.quote.updated_at = new Date(start - 419_000).toISOString();
    return result;
  } };
  const run = robinhood.collectRobinhoodReadonly(coreOnly, observedAt, undefined, null, new Date(start + 10_000).toISOString());
  await new Promise(setImmediate);
  context.mock.timers.tick(5_000);
  const result = await Promise.race([run, delay(100, null)]);
  assert.ok(result, "remaining slot budget caps the enhancement wait");
  assert.equal(result.status, "STALE");
  assert.equal(result.freshness_seconds, 424);
  const frozen = JSON.stringify(result), later = robinhood.refreshCoreFreshness(result, new Date(start + 15_000).toISOString());
  assert.equal(later.freshness_seconds, 434);
  assert.notEqual(later.snapshot_hash, result.snapshot_hash);
  assert.equal(JSON.stringify(result), frozen, "refresh before a new freeze never mutates prior evidence");
  const alreadyExpired = await robinhood.collectRobinhoodReadonly(session, observedAt, undefined, null, observedAt);
  assert.equal(calls.some(({ tool }) => tool.startsWith("get_option_") || tool === "get_accounts"), false);
  assert.equal(alreadyExpired.account.status, "DATA_BLOCKED");
  context.mock.timers.setTime(start);
  let optionalCalls = 0;
  await robinhood.collectRobinhoodReadonly({ async call(tool, args) {
    if (!(tool.startsWith("get_equity_") && args.symbols.join(",") === "SPY,QQQ")) {
      optionalCalls++;
      context.mock.timers.setTime(start + 61_000); // wall clock advanced; deadline timer has not fired
    }
    return session.call(tool, args);
  } }, observedAt);
  assert.equal(optionalCalls, 1, "every new I/O checks the absolute deadline even before its timer callback runs");
});

test("position-only collection checks all held contracts without market scan or portfolio dependencies", async () => {
  const calls = [];
  const session = { async call(tool, args) {
    calls.push({ tool, args });
    if (tool === "get_accounts") return response({ accounts: [{ account_number: "private-number" }] });
    if (tool === "get_option_positions") return response({ positions: ["TSLA", "NOK"].map((symbol) => ({ option_id: symbol, chain_symbol: symbol, type: "long", quantity: "1", average_price: "200" })) });
    if (tool === "get_option_instruments") return response({ instruments: ["TSLA", "NOK"].map((id) => ({ id, type: "put", expiration_date: "2026-10-16", strike_price: "100" })) });
    if (tool === "get_option_quotes") return response({ results: args.instrument_ids.map((id) => ({ quote: { instrument_id: id, bid_price: "1.50", ask_price: "1.55", mark_price: "1.525", updated_at: observedAt } })) });
    throw new Error(`must not call ${tool}`);
  } };
  assert.equal(typeof robinhood.collectRobinhoodAccount, "function");
  const result = await robinhood.collectRobinhoodAccount(session, observedAt, "POSITIONS");
  assert.equal(result.status, "LIVE");
  assert.deepEqual(result.positions.map((row) => row.symbol), ["TSLA", "NOK"]);
  assert.ok(result.positions.every((row) => row.average_price === 2 && row.as_of === observedAt));
  assert.deepEqual(calls.map(({ tool }) => tool), ["get_accounts", "get_option_positions", "get_option_instruments", "get_option_quotes"]);
  assert.equal(JSON.stringify(result).includes("private-number"), false);
  assert.equal(result.orders, null);
  assert.equal(result.portfolio_value, null);
  assert.equal(result.realized_pnl, null);
  const missing = await robinhood.collectRobinhoodAccount({ ...session, async call(tool, args) { return tool === "get_option_positions" ? response({}) : session.call(tool, args); } }, observedAt, "POSITIONS");
  assert.equal(missing.status, "DATA_BLOCKED");
});

test("slow quote collection cannot refresh the earlier account-read timestamp", async (context) => {
  const start = Date.parse(observedAt), finish = start + 121_000;
  context.mock.timers.enable({ apis: ["Date"], now: start });
  const session = { async call(tool, args) {
    if (tool === "get_accounts") return response({ accounts: [{ account_number: "private-number" }] });
    if (tool === "get_option_positions") return response({ positions: [{ option_id: "held", chain_symbol: "TSLA", type: "long", quantity: "1", average_price: "200" }] });
    if (tool === "get_option_instruments") return response({ instruments: [{ id: "held", type: "call", expiration_date: "2026-10-16", strike_price: "100" }] });
    if (tool === "get_option_quotes") {
      context.mock.timers.setTime(finish);
      return response({ results: args.instrument_ids.map((id) => ({ quote: { instrument_id: id, bid_price: "1.50", ask_price: "1.55", updated_at: new Date().toISOString() } })) });
    }
    throw new Error(`must not call ${tool}`);
  } };
  const current = await robinhood.collectRobinhoodAccount(session, undefined, "POSITIONS");
  assert.equal(current.as_of, observedAt);
  assert.equal(current.positions[0].as_of, new Date(finish).toISOString());
  assert.equal(assessPositionRisks(current, null, new Date().toISOString()).status, "DATA_BLOCKED");
  const frozen = await robinhood.collectRobinhoodAccount(session, observedAt, "POSITIONS");
  assert.equal(frozen.as_of, observedAt);
});

test("reordering returned accounts cannot attach a holding to another account label", async () => {
  const accounts = ["private-first", "private-second"];
  const session = (order) => ({ async call(tool, args) {
    if (tool === "get_accounts") return response({ accounts: order.map((account_number) => ({ account_number })) });
    if (tool === "get_option_positions") return response({ positions: [{ option_id: `contract-${accounts.indexOf(args.account_number)}`, chain_symbol: "TSLA", type: "long", quantity: "1", average_price: "200" }] });
    if (tool === "get_option_instruments") return response({ instruments: args.ids.split(",").map((id) => ({ id, type: "call", expiration_date: "2026-10-16", strike_price: "100" })) });
    if (tool === "get_option_quotes") return response({ results: args.instrument_ids.map((id) => ({ quote: { instrument_id: id, bid_price: "1.50", ask_price: "1.55", updated_at: observedAt } })) });
    throw new Error(`must not call ${tool}`);
  } });
  const first = await robinhood.collectRobinhoodAccount(session(accounts), observedAt, "POSITIONS");
  const reversed = await robinhood.collectRobinhoodAccount(session(accounts.toReversed()), observedAt, "POSITIONS");
  const identities = (result) => Object.fromEntries(result.positions.toSorted((a, b) => a.contract_id.localeCompare(b.contract_id)).map((row) => [row.contract_id, row.account_label]));
  assert.deepEqual(identities(first), identities(reversed));
  assert.equal(new Set(first.positions.map((row) => row.account_label)).size, 2);
  assert.ok(first.positions.every((row) => /^账户-[a-f0-9]{16}$/.test(row.account_label)));
  assert.ok(accounts.every((account) => !JSON.stringify([first, reversed]).includes(account)));
});

test("incomplete or duplicate account inventories cannot become a smaller verified account list", async () => {
  for (const accounts of [[{ account_number: "synthetic-valid" }, {}], [{ account_number: "synthetic-valid" }, null], [{ account_number: "synthetic-valid" }, { account_number: "synthetic-valid" }], { account_number: "synthetic-valid" }]) {
    let positionCalls = 0;
    await assert.rejects(robinhood.collectRobinhoodAccount({ async call(tool) {
      if (tool === "get_accounts") return response({ accounts });
      positionCalls++; return response({ positions: [] });
    } }, observedAt, "POSITIONS"), /ACCOUNT_INVENTORY_INCOMPLETE/);
    assert.equal(positionCalls, 0, "do not query a partial account set and call it complete");
  }
});
