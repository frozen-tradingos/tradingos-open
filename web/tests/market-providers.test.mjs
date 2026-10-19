// All responses and prices below are SYNTHETIC. No provider or natural performance writes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { collectTradierReadonly, createTradierMarketProvider } from "../server/market-providers.ts";
import { isNyseRegularSession } from "../app/market-time.ts";
import { defaultExecutor } from "../server/live-shadow-runtime.ts";
import { collectRobinhoodReadonly } from "../server/robinhood-mcp.ts";
import { saveSourceSettings } from "../../tools/source-settings.mjs";

const observedAt = "2026-08-11T14:05:00.000Z", token = "SYNTHETIC_CALLER_ONLY_TOKEN";
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
function quotes(at = observedAt) {
  return { quotes: { quote: ["SPY", "QQQ"].map((symbol, index) => ({ symbol, last: 100 + index, bid: 99 + index, ask: 101 + index, prevclose: 98 + index, trade_date: Date.parse(at), bid_date: Date.parse(at), ask_date: Date.parse(at) })) } };
}
const candle = (at) => ({ timestamp: Date.parse(at) / 1000, open: 100, high: 102, low: 99, close: 101, volume: 1000 });
function history(lastDate = "2026-08-10") {
  const values = [];
  for (let time = Date.parse(lastDate); values.length < 22; time -= 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    if (isNyseRegularSession(date)) values.unshift({ date, open: 100, high: 102, low: 99, close: 101, volume: 1000 });
  }
  return { history: { day: values } };
}
function fixture(overrides = {}) {
  const calls = [];
  return { calls, options: { token, environment: "production", request: async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    if (url.pathname.endsWith("/quotes")) return response(overrides.quotes ?? quotes());
    if (url.pathname.endsWith("/timesales")) return response({ series: { data: overrides.bars ?? [candle("2026-08-11T13:55:00Z"), candle("2026-08-11T14:00:00Z")] } });
    if (url.pathname.endsWith("/history")) return response(overrides.history ?? history());
    throw new Error("Unexpected endpoint; no network fallback exists");
  } } };
}

test("SYNTHETIC Tradier uses only official GET market endpoints, injected tokens and provider timestamps", async () => {
  const { calls, options } = fixture(), provider = createTradierMarketProvider(options);
  const result = await provider.readQuotes();
  assert.equal(result.source, "TRADIER"); assert.equal(result.environment, "production"); assert.equal(result.delayed, false);
  assert.equal(result.quotes[0].as_of, observedAt); assert.equal(result.quotes[0].last_at, observedAt);
  assert.equal(result.quotes[0].bid_at, observedAt); assert.equal(result.quotes[0].ask_at, observedAt);
  const five = await provider.readBars({ symbol: "SPY", interval: "5min", start: "2026-08-11 09:30", end: "2026-08-11 16:00" });
  assert.equal(five.bars[0].begins_at, "2026-08-11T13:55:00.000Z"); assert.equal(five.date_semantics, "PROVIDER_EPOCH_START");
  const daily = await provider.readBars({ symbol: "QQQ", interval: "daily", start: "2026-07-01", end: "2026-08-10" });
  assert.equal(daily.bars.at(-1).begins_at, "2026-08-10"); assert.equal(daily.date_semantics, "EXCHANGE_SESSION_DATE_ONLY");
  assert.deepEqual(calls.map(({ url }) => url.pathname), ["/v1/markets/quotes", "/v1/markets/timesales", "/v1/markets/history"]);
  assert.ok(calls.every(({ url, options }) => url.origin === "https://api.tradier.com" && options.method === "GET" && options.redirect === "error" && options.headers.Authorization === `Bearer ${token}` && !url.href.includes(token) && !options.body));
  assert.equal(calls[1].url.searchParams.get("session_filter"), "open");
});

test("SYNTHETIC invalid credentials, host selection, symbol or ranges make no request", async () => {
  let calls = 0; const request = async () => { calls++; throw new Error(token); };
  for (const options of [{ token: "", environment: "production" }, { token: `${token}\r\nX: test`, environment: "production" }, { token, environment: "https://example.test" }]) assert.throws(() => createTradierMarketProvider({ ...options, request }), /NOT_AUTHORIZED|INVALID_ENVIRONMENT/);
  const provider = createTradierMarketProvider({ token, environment: "production", request });
  for (const input of [{ symbol: "SPY&token=bad", interval: "5min", start: "2026-08-11 09:30", end: "2026-08-11 16:00" }, { symbol: "SPY", interval: "daily", start: "2026-02-30", end: "2026-03-01" }, { symbol: "SPY", interval: "5min", start: "2026-08-11 99:30", end: "2026-08-11 16:00" }]) await assert.rejects(provider.readBars(input), /INVALID_/);
  assert.equal(calls, 0);
});

test("SYNTHETIC errors never reflect a token, response body or thrown request message", async () => {
  for (const request of [async () => { throw new Error(`Bearer ${token}`); }, async () => response({ secret: token }, 401), async () => new Response(token), async () => { const result = response({ secret: token }); Object.defineProperty(result, "redirected", { value: true }); return result; }]) {
    const provider = createTradierMarketProvider({ token, environment: "production", request });
    await assert.rejects(provider.readQuotes(), (error) => !String(error.stack).includes(token) && /REQUEST_FAILED|NOT_AUTHORIZED|REDIRECT_FORBIDDEN/.test(error.message));
  }
});

test("SYNTHETIC production snapshot preserves Tradier origin and does not invent option or account capabilities", async () => {
  const { calls, options } = fixture(); const result = await collectTradierReadonly(options, observedAt);
  assert.equal(calls.length, 5); assert.equal(result.status, "LIVE");
  assert.ok([...result.providers, ...result.quotes, ...result.bars, ...result.options].every((row) => row.source === "TRADIER"));
  assert.equal(result.as_of, observedAt); assert.equal(result.bars[0].as_of, observedAt);
  assert.deepEqual(result.capabilities, { quotes: true, intraday_bars: true, daily_bars: true, option_chain: false, option_bbo: false, option_iv: false, option_greeks: false });
  assert.equal(result.account.status, "NOT_AUTHORIZED"); assert.equal(result.account.positions, null);
  assert.ok(result.errors.some((error) => error.code === "PROVIDER_ENVIRONMENT" && error.message.includes("production")));
  assert.ok(result.errors.some((error) => error.code === "DAILY_DATE_ONLY"));
  assert.ok(!JSON.stringify(result).includes(token));
});

test("SYNTHETIC sandbox is fixed delayed and DATA_BLOCKED even when its timestamps look fresh", async () => {
  const { calls, options } = fixture(); const result = await collectTradierReadonly({ ...options, environment: "sandbox" }, observedAt);
  assert.ok(calls.every(({ url }) => url.origin === "https://sandbox.tradier.com"));
  assert.equal(result.status, "DATA_BLOCKED"); assert.ok(Object.values(result.capabilities).every((value) => value === false));
  assert.ok([...result.providers, ...result.quotes, ...result.bars].every((row) => row.status === "DATA_BLOCKED"));
  assert.equal(result.quotes[0].as_of, observedAt); assert.ok(result.errors.some((error) => error.code === "SANDBOX_DELAYED_NOT_LIVE"));
});

test("SYNTHETIC stale/future/incomplete quotes and unfinished bars never qualify as LIVE", async () => {
  const future = quotes(); future.quotes.quote[0].trade_date += 300_000;
  const crossed = quotes(); crossed.quotes.quote[0].bid = 102;
  for (const overrides of [{ quotes: quotes("2026-08-11T13:45:00Z") }, { quotes: future }, { quotes: crossed }, { quotes: { quotes: { quote: quotes().quotes.quote.slice(0, 1) } } }, { bars: [candle("2026-08-11T14:05:00Z")] }, { bars: [candle("2026-08-11T13:55:00Z"), { ...candle("2026-08-11T14:00:00Z"), low: 103 }] }, { history: { history: { day: history().history.day.slice(0, 2) } } }]) {
    const result = await collectTradierReadonly(fixture(overrides).options, observedAt);
    assert.notEqual(result.status, "LIVE");
  }
  const valid = await collectTradierReadonly(fixture({ bars: [candle("2026-08-11T13:55:00Z"), candle("2026-08-11T14:00:00Z"), candle("2026-08-11T14:05:00Z")] }).options, observedAt);
  assert.equal(valid.bars[0].bar_count, 2);
});

test("SYNTHETIC missing or rejected authorization is explicit and never reads another provider", async () => {
  let calls = 0;
  const missing = await collectTradierReadonly({ token: "", environment: "production", request: async () => { calls++; throw new Error(); } }, observedAt);
  assert.equal(calls, 0); assert.equal(missing.providers[0].status, "NOT_AUTHORIZED"); assert.equal(missing.status, "DATA_BLOCKED");
  const rejected = await collectTradierReadonly({ token, environment: "production", request: async () => response({ private_error: token }, 401) }, observedAt);
  assert.equal(rejected.providers[0].status, "NOT_AUTHORIZED"); assert.equal(rejected.status, "DATA_BLOCKED");
  assert.ok(!JSON.stringify(rejected).includes(token));
});

test("SYNTHETIC weekend reads the last completed exchange session, without restamping old data", async () => {
  const at = "2026-08-14T20:00:00Z", { calls, options } = fixture({ quotes: quotes(at), bars: [candle("2026-08-14T19:55:00Z")], history: history("2026-08-14") });
  const result = await collectTradierReadonly(options, "2026-08-16T18:00:00Z");
  assert.equal(result.status, "MARKET_CLOSED"); assert.equal(result.as_of, "2026-08-14T20:00:00.000Z");
  assert.ok(calls.filter(({ url }) => url.pathname.endsWith("/timesales")).every(({ url }) => url.searchParams.get("start") === "2026-08-14 09:30"));
});

test("SYNTHETIC one shared freeze deadline bounds every request, even a transport that ignores AbortSignal", async () => {
  let calls = 0; const start = performance.now();
  const result = await collectTradierReadonly({ token, environment: "production", timeoutMs: 1000, request: async () => { calls++; return new Promise(() => {}); } }, observedAt, new Date(Date.now() + 35).toISOString());
  assert.ok(performance.now() - start < 500); assert.equal(calls, 5); assert.equal(result.status, "DATA_BLOCKED");
  assert.equal(result.errors.filter((error) => error.code === "DEADLINE_EXCEEDED").length, 5);
  let expiredCalls = 0;
  await collectTradierReadonly({ token, environment: "production", request: async () => { expiredCalls++; throw new Error(); } }, observedAt, new Date(Date.now() - 1).toISOString());
  assert.equal(expiredCalls, 0);
});

test("SYNTHETIC adapter to actual A1 executor never upgrades a hard block or erases authorization failure", async (context) => {
  const work = resolve(import.meta.dirname, "../../_工作文件");
  mkdirSync(work, { recursive: true });
  const fixtureRoot = mkdtempSync(join(work, "synthetic-market-refresh-"));
  const originalCwd = process.cwd(), originalSelection = process.env.TRADING_OS_SOURCE_SETTINGS, originalRole = process.env.TRADING_OS_RUNTIME_ROLE;
  context.after(() => {
    process.chdir(originalCwd);
    if (originalSelection === undefined) delete process.env.TRADING_OS_SOURCE_SETTINGS; else process.env.TRADING_OS_SOURCE_SETTINGS = originalSelection;
    if (originalRole === undefined) delete process.env.TRADING_OS_RUNTIME_ROLE; else process.env.TRADING_OS_RUNTIME_ROLE = originalRole;
    assert.ok(fixtureRoot.startsWith(work + sep) && fixtureRoot.slice(work.length + 1).startsWith("synthetic-market-refresh-"));
    rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const selection = saveSourceSettings({ market: { provider: "TRADIER", environment: "LIVE" }, news: { provider: "NONE" }, broker: { provider: "NONE" } }, { packageRoot: fixtureRoot, confirmed: true });
  process.chdir(join(fixtureRoot, "web"));
  process.env.TRADING_OS_SOURCE_SETTINGS = JSON.stringify(selection);
  delete process.env.TRADING_OS_RUNTIME_ROLE;
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(observedAt) });
  const future = quotes(); future.quotes.quote[0].trade_date += 300_000;
  const permitted = fixture().options;
  const partialPermission = { ...permitted, request: (input, options) => new URL(input).pathname.endsWith("/timesales") ? response({}, 401) : permitted.request(input, options) };
  const cases = [
    { name: "valid-live", options: fixture().options, status: "LIVE" },
    { name: "future-last-old-bid-ask", options: fixture({ quotes: future }).options, status: "DATA_BLOCKED", future: true },
    { name: "sandbox", options: { ...fixture().options, environment: "sandbox" }, status: "DATA_BLOCKED" },
    { name: "missing-authorization", options: { ...fixture().options, token: "" }, status: "DATA_BLOCKED", unauthorized: true },
    { name: "partial-authorization", options: partialPermission, status: "DATA_BLOCKED", unauthorized: true },
  ];
  let subprocessCalls = 0;
  for (const item of cases) {
    const snapshot = await collectTradierReadonly(item.options, observedAt);
    assert.equal(snapshot.status, item.status, `${item.name}: collector status`);
    if (item.future) {
      assert.equal(snapshot.quotes[0].as_of, observedAt, "an older bid/ask must not conceal the future trade time");
      assert.ok(snapshot.errors.some((error) => error.code === "FUTURE_SOURCE_TIME"));
    }
    const execute = defaultExecutor({ dataRoot: join(fixtureRoot, "synthetic-shadow"), v2Root: join(fixtureRoot, "unused-v2") }, { readMarket: async () => snapshot, spawnProcess: () => { subprocessCalls++; throw new Error("No real subprocess is allowed in this synthetic test"); } });
    const result = await execute("A1", { run_id: `synthetic-${item.name}`, source_mode: "LIVE", RUNTIME_CONTEXT: {}, SLOT_FREEZE_DEADLINE_AT: new Date(Date.now() + 90_000).toISOString() });
    assert.equal(result.payload.market_sources.status, item.status, `${item.name}: actual A1 refresh status`);
    assert.equal(result.payload.v2_result.source, "TRADIER_READONLY_MARKET_API");
    assert.equal(result.payload.v2_result.source_selection.selection_id, selection.selection_id);
    assert.equal(result.downstreamReason, item.status === "LIVE" ? undefined : "DATA_BLOCKED");
    if (item.unauthorized) assert.equal(result.payload.market_sources.providers[0].status, "NOT_AUTHORIZED", `${item.name}: retain permission failure`);
  }
  assert.equal(subprocessCalls, 0);
});

test("SYNTHETIC brokerage MARKET_ONLY probe performs exactly three SPY/QQQ reads without optional collection", async () => {
  const calls = [];
  const session = { async call(tool, args) {
    calls.push({ tool, args });
    assert.deepEqual(args.symbols, ["SPY", "QQQ"]);
    let results;
    if (tool === "get_equity_quotes") results = args.symbols.map((symbol) => ({ quote: { symbol, last_trade_price: "100", bid_price: "99", ask_price: "101", previous_close: "98", updated_at: observedAt } }));
    else {
      assert.equal(tool, "get_equity_historicals");
      const dates = args.interval === "day" ? history().history.day.map((bar) => `${bar.date}T20:00:00.000Z`) : ["2026-08-11T14:00:00.000Z"];
      results = args.symbols.map((symbol) => ({ symbol, bars: dates.map((begins_at) => ({ begins_at, open_price: "100", high_price: "102", low_price: "99", close_price: "101", volume: "1000" })) }));
    }
    return { content: [], structuredContent: { data: { results } } };
  } };
  const result = await collectRobinhoodReadonly(session, observedAt, undefined, undefined, undefined, undefined, "MARKET_ONLY");
  assert.deepEqual(calls.map(({ tool, args }) => [tool, args.interval ?? null]), [["get_equity_quotes", null], ["get_equity_historicals", "5minute"], ["get_equity_historicals", "day"]]);
  assert.equal(result.status, "LIVE");
  assert.deepEqual(result.capabilities, { quotes: true, intraday_bars: true, daily_bars: true, option_chain: false, option_bbo: false, option_iv: false, option_greeks: false });
  assert.deepEqual(result.options, []);
  assert.equal(result.account.status, "NOT_AUTHORIZED"); assert.equal(result.account.positions, null); assert.equal(result.account.account_count, null);
  assert.equal(result.market_environment, undefined); assert.equal(result.approved_capabilities, undefined);
});
