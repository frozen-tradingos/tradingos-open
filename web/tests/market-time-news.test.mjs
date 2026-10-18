import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { formatEtAxisTimestamp, formatPtTime, isPtShadowWindow, latestCompletedNyseSession, robinhoodSessionAt, spxOptionSessionAt, utcIso } from "../app/market-time.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { collectFinnhubOfficial } from "../server/finnhub.ts";
import { createIncidentGuard } from "../server/incident-guard.ts";
import { classifySpxContractQuote, collectRobinhoodMarketChart, MARKET_CHART_MAX_AGE_SECONDS, selectChartSessions } from "../server/robinhood-mcp.ts";
import { buildTsEvidenceContract } from "../app/ts-forecast-state.ts";

const observedAt = "2026-08-12T21:55:00.000Z";
const publishedAt = Math.floor(Date.parse("2026-08-12T21:50:00.000Z") / 1_000);

function officialResponse(url) {
  if (url.pathname.endsWith("/news")) return new Response(JSON.stringify([
    { id: 1, headline: "Consumer Price Index released", summary: "", source: "Reuters", datetime: publishedAt, related: "SPY, QQQ", url: "https://example.test/reuters-cpi" },
    { id: 2, headline: "Consumer Price Index report", summary: "", source: "AP News", datetime: publishedAt, related: "SPY QQQ", url: "https://example.test/ap-cpi" },
  ]), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname.endsWith("/calendar/earnings")) return new Response(JSON.stringify({ earningsCalendar: [
    { symbol: "NVDA", date: "2026-08-13", hour: "amc", epsActual: 0, revenueActual: 0, revenueEstimate: 1_000 },
    { symbol: "AAPL", date: "2026-08-11", hour: "amc", epsActual: 2.1, epsEstimate: 2, revenueActual: 1050, revenueEstimate: 1000 },
  ] }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response("not found", { status: 404 });
}

test("Finnhub response receipt follows each decoded body, not the shared collection round", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(observedAt) });
  const bodies = new Map();
  const collection = collectFinnhubOfficial({ credentialPath: "unused", token: "test-token", request: async (input) => {
    const url = new URL(input), value = await officialResponse(url).json();
    return { ok: true, json: () => new Promise((resolve) => bodies.set(url.pathname, () => resolve(value))) };
  } }, observedAt);
  await new Promise(setImmediate);
  assert.equal(bodies.size, 2);
  context.mock.timers.tick(1_250); bodies.get("/api/v1/news")();
  await new Promise(setImmediate);
  context.mock.timers.tick(2_750); bodies.get("/api/v1/calendar/earnings")();
  const update = await collection;
  assert.equal(update.events.filter((event) => event.kind === "NEWS").every((event) => event.response_received_at === "2026-08-12T21:55:01.250Z"), true);
  assert.equal(update.events.filter((event) => event.kind === "EARNINGS").every((event) => event.response_received_at === "2026-08-12T21:55:04.000Z"), true);
  const immediate = await collectFinnhubOfficial({ credentialPath: "unused", token: "test-token", request: (input) => officialResponse(new URL(input)) }, observedAt);
  const withoutReceipt = (value) => ({ ...value, events: value.events.map(({ response_received_at, ...event }) => { assert.ok(response_received_at); return event; }) });
  assert.deepEqual(withoutReceipt(update), withoutReceipt(immediate), "all pre-existing source, event, raw JSON, hash and round fields stay identical");
  for (const fail of [async () => { throw new Error("body interrupted"); }, async () => ({ error: "failure" })]) {
    const failed = await collectFinnhubOfficial({ credentialPath: "unused", token: "test-token", request: async () => ({ ok: true, json: fail }) }, observedAt);
    assert.deepEqual(failed.events, []);
    assert.equal(failed.source.status, "DATA_BLOCKED");
  }
});

test("news receipt migration keeps old NULL and duplicate or cached first receipts immutable", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-news-receipt-")), file = join(directory, "news.sqlite");
  let store, database;
  context.after(async () => { database?.close(); store?.close(); await rm(directory, { recursive: true, force: true }); });
  const collected = await collectFinnhubOfficial({ credentialPath: "unused", token: "test-token", request: (input) => officialResponse(new URL(input)) }, observedAt);
  const legacy = { ...collected, events: collected.events.map(({ response_received_at, ...event }) => { void response_received_at; return event; }) };
  store = openSnapshotDatabase(file);
  store.importMarketIntelligence(legacy); store.close(); store = undefined;
  database = new DatabaseSync(file);
  if (database.prepare("PRAGMA table_info(market_events)").all().some((row) => row.name === "response_received_at")) database.exec("ALTER TABLE market_events DROP COLUMN response_received_at");
  const before = database.prepare("SELECT * FROM market_events ORDER BY sequence").all(); database.close(); database = undefined;
  store = openSnapshotDatabase(file); database = new DatabaseSync(file);
  assert.equal(store.importMarketIntelligence(collected).inserted, 0);
  const legacyAfter = database.prepare("SELECT * FROM market_events ORDER BY sequence").all();
  assert.equal(legacyAfter.every((row) => row.response_received_at === null), true, "re-reading legacy articles must not manufacture their first receipt");
  assert.deepEqual(legacyAfter.map(({ response_received_at, ...row }) => { void response_received_at; return row; }), before.map((row) => ({ ...row })));
  const first = { ...collected, events: [{ ...collected.events[0], event_id: "isolated-new-article", response_received_at: "2026-08-12T21:55:04.000Z" }] };
  assert.equal(store.importMarketIntelligence(first).inserted, 1);
  assert.equal(store.importMarketIntelligence(first).inserted, 0, "cached update reuses its original evidence");
  assert.equal(store.importMarketIntelligence({ ...first, events: [{ ...first.events[0], response_received_at: "2026-08-12T22:00:00.000Z" }] }).inserted, 0);
  assert.equal(database.prepare("SELECT response_received_at FROM market_events WHERE event_id=?").get("isolated-new-article").response_received_at, first.events[0].response_received_at);
  assert.equal("response_received_at" in store.getActive().marketIntelligence.events[0], false, "receipt evidence must not alter ordinary TS runtime event inputs");
  assert.deepEqual(store.checkUtcStorage(), []);
});

test("stores UTC while PT/ET display and schedule handling remain DST-safe", () => {
  assert.equal(utcIso("2026-08-12T10:00:00-07:00"), "2026-08-12T17:00:00.000Z");
  assert.equal(formatPtTime("2026-01-15T17:30:00.000Z"), "09:30");
  assert.equal(formatPtTime("2026-07-15T16:30:00.000Z"), "09:30");
  assert.equal(isPtShadowWindow(new Date("2026-01-15T14:34:00.000Z")), false);
  assert.equal(isPtShadowWindow(new Date("2026-01-15T14:35:00.000Z")), true);
  assert.equal(isPtShadowWindow(new Date("2026-07-15T13:34:00.000Z")), false);
  assert.equal(isPtShadowWindow(new Date("2026-07-15T13:35:00.000Z")), true);
  assert.equal(isPtShadowWindow(new Date("2026-07-03T17:00:00.000Z")), false);
  assert.equal(isPtShadowWindow(new Date("2026-11-27T17:59:00.000Z")), true);
  assert.equal(isPtShadowWindow(new Date("2026-11-27T18:00:00.000Z")), false);
  assert.equal(latestCompletedNyseSession("2026-07-04T18:00:00.000Z"), "2026-07-02");
  assert.equal(formatEtAxisTimestamp(Date.parse("2026-08-11T13:30:00.000Z") / 1_000), "08/11, 09:30");
  assert.equal(formatEtAxisTimestamp(Date.parse("2026-08-12T13:30:00.000Z") / 1_000), "08/12, 09:30");
  assert.deepEqual(robinhoodSessionAt("2026-08-17T01:30:00.000Z"), { phase: "OVERNIGHT", trading_date: "2026-08-17", calendar_date: "2026-08-16", timezone: "America/New_York" });
  assert.deepEqual(robinhoodSessionAt("2026-08-17T05:30:00.000Z"), { phase: "OVERNIGHT", trading_date: "2026-08-17", calendar_date: "2026-08-17", timezone: "America/New_York" });
  assert.equal(robinhoodSessionAt("2026-08-15T01:30:00.000Z").phase, "CLOSED");
  assert.deepEqual(spxOptionSessionAt("2026-08-17T20:30:00.000Z"), { session: "CURB", trading_date: "2026-08-17", calendar_date: "2026-08-17", timezone: "America/New_York" });
  assert.deepEqual(spxOptionSessionAt("2026-08-18T01:00:00.000Z"), { session: "GTH", trading_date: "2026-08-18", calendar_date: "2026-08-17", timezone: "America/New_York" });
  assert.deepEqual(spxOptionSessionAt("2026-08-18T13:25:00.000Z"), { session: "CLOSED", trading_date: "2026-08-18", calendar_date: "2026-08-18", timezone: "America/New_York" });
  assert.deepEqual(spxOptionSessionAt("2026-08-18T13:30:00.000Z"), { session: "RTH", trading_date: "2026-08-18", calendar_date: "2026-08-18", timezone: "America/New_York" });
});

test("next-session evidence is deterministic and does not call pre-open RTH DATA_BLOCKED", () => {
  const ts = {
    report_type: "NEXT_SESSION",
    evidence_snapshot: { market_time: { market_date: "2026-08-24", observed_at: "2026-08-25T01:02:35.806Z" } },
    next_validation: { at: "2026-08-25T13:30:00.000Z" }, causal_chains: [],
    evidence_assessment: {
      core_sources: ["SPY_QUOTE", "QQQ_QUOTE", "MARKET_CLOCK", "A2_STRUCTURE"], core_gaps: [],
      enhanced_available: ["OPTIONS_POSITIONING", "RATES_CONTEXT", "SECTOR_BREADTH"], enhanced_missing: ["A2_HISTORICAL_SIMILARITY", "MACRO_SCHEDULE", "MARKET_MOVING_NEWS", "OIL_CONTEXT", "OVERNIGHT_FUTURES"],
    },
  };
  const before = buildTsEvidenceContract(ts, "NEXT_SESSION", "2026-08-25T01:30:00.000Z", { trading_date: "2026-08-24", state: "DATA_BLOCKED", data_timestamp: null });
  assert.deepEqual([before.required_available, before.required_total, before.next_rth.state, before.items.find((item) => item.key === "OIL_CONTEXT").role, before.items.find((item) => item.key === "A2_HISTORICAL_SIMILARITY").role], [4, 4, "NOT_STARTED", "ENHANCEMENT", "ENHANCEMENT"]);
  const after = buildTsEvidenceContract(ts, "NEXT_SESSION", "2026-08-25T13:31:00.000Z", { trading_date: "2026-08-25", state: "DATA_BLOCKED", data_timestamp: null });
  assert.equal(after.next_rth.state, "DATA_BLOCKED");
});

test("SPX exact quote states distinguish stale RTH snapshots from missing GTH coverage", () => {
  const stale = classifySpxContractQuote({ bid: 38.2, ask: 38.4, mark: 38.3, quoted_at: "2026-08-24T20:14:59.997Z", freshness_seconds: 18_699 }, "2026-08-25T01:25:00.000Z");
  assert.deepEqual(stale, { status: "CONTRACT_FOUND_QUOTE_STALE", source_session: "RTH", observed_session: "GTH" });
  assert.equal(classifySpxContractQuote({ bid: null, ask: null, mark: null, quoted_at: null, freshness_seconds: null }, "2026-08-25T01:25:00.000Z").status, "PROVIDER_GTH_UNAVAILABLE");
  assert.equal(classifySpxContractQuote({ bid: 38.2, ask: null, mark: null, quoted_at: "2026-08-24T18:00:00.000Z", freshness_seconds: 10 }, "2026-08-24T18:00:10.000Z").status, "CONTRACT_FOUND_NO_TWO_SIDED_QUOTE");
});

test("market chart defaults to the latest real session and keeps five-session review bounded", () => {
  const bars = Array.from({ length: 7 }, (_, day) => ({ begins_at: new Date(Date.parse("2026-08-03T13:30:00.000Z") + day * 86_400_000).toISOString(), close: 100 + day }));
  assert.deepEqual(selectChartSessions(bars, "1d").bars.map((bar) => bar.close), [106]);
  assert.deepEqual(selectChartSessions(bars, "5d").bars.map((bar) => bar.close), [102, 103, 104, 105, 106]);
});

test("cross-midnight overnight bars stay attached to the next trading day", () => {
  const bars = [
    { begins_at: "2026-08-14T19:55:00.000Z", trading_date: "2026-08-14", close: 99 },
    { begins_at: "2026-08-17T01:30:00.000Z", trading_date: "2026-08-17", close: 100 },
    { begins_at: "2026-08-17T05:30:00.000Z", trading_date: "2026-08-17", close: 101 },
  ];
  assert.deepEqual(selectChartSessions(bars, "1d"), { bars: bars.slice(1), dates: ["2026-08-17"] });
});

test("24-hour, RTH and after-hours/GTH views remain continuous across the 20:00 ET trading-date switch", () => {
  const bars = [
    { begins_at: "2026-08-24T13:30:00.000Z", trading_date: "2026-08-24", session: "REGULAR", close: 100 },
    { begins_at: "2026-08-24T23:55:00.000Z", trading_date: "2026-08-24", session: "AFTER_HOURS", close: 101 },
    { begins_at: "2026-08-25T00:00:00.000Z", trading_date: "2026-08-25", session: "OVERNIGHT", close: 102 },
    { begins_at: "2026-08-25T00:20:00.000Z", trading_date: "2026-08-25", session: "OVERNIGHT", close: 103 },
  ];
  assert.deepEqual(selectChartSessions(bars, "24h"), { bars, dates: ["2026-08-24", "2026-08-25"] });
  assert.deepEqual(selectChartSessions(bars, "1d").bars.map((bar) => bar.close), [102, 103]);
  assert.deepEqual(selectChartSessions(bars, "rth").bars.map((bar) => bar.close), [100]);
  assert.deepEqual(selectChartSessions(bars, "gth").bars.map((bar) => bar.close), [101, 102, 103]);
});

test("market chart measures five-minute freshness from bar completion", async () => {
  const bar = (begins_at, price) => ({ begins_at, open_price: String(price), high_price: String(price + 1), low_price: String(price - 1), close_price: String(price), volume: "10" });
  const session = { async call(tool) {
    if (tool === "get_equity_quotes") return { content: [], structuredContent: { results: [{ quote: { symbol: "SPY", last_trade_price: "503", venue_last_trade_time: "2026-08-25T00:28:00.000Z" } }] } };
    return { content: [], structuredContent: { results: [{ symbol: "SPY", bars: [bar("2026-08-24T13:30:00.000Z", 500), bar("2026-08-24T23:55:00.000Z", 501), bar("2026-08-25T00:00:00.000Z", 502), bar("2026-08-25T00:20:00.000Z", 503)] }] } };
  } };
  const chart = await collectRobinhoodMarketChart(session, "SPY", "5m", "2026-08-25T00:29:10.000Z", "24h");
  const stale = await collectRobinhoodMarketChart(session, "SPY", "5m", "2026-08-25T00:32:01.000Z", "24h");
  assert.equal(MARKET_CHART_MAX_AGE_SECONDS["5m"], 420);
  assert.deepEqual([chart.status, chart.quote_freshness_seconds, chart.bar_as_of, chart.bar_freshness_seconds, chart.bars.length, chart.session_dates], ["LIVE", 70, "2026-08-25T00:25:00.000Z", 250, 4, ["2026-08-24", "2026-08-25"]]);
  assert.deepEqual([stale.status, stale.bar_freshness_seconds], ["STALE", 421]);
});

test("Finnhub official news and earnings are validated, deduplicated and preserved raw", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-news-"));
  const databasePath = join(directory, "news.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const update = await collectFinnhubOfficial({ credentialPath: join(directory, "missing.json"), token: "test-token", request: (input) => officialResponse(new URL(input)) }, observedAt);
  assert.equal(update.source.status, "LIVE");
  assert.equal(update.source.authorization, "VALID");
  assert.deepEqual(update.source.capabilities, { news: true, earnings_calendar: true, earnings_results: true });
  assert.equal(update.events.length, 4);
  assert.equal(update.events.filter((event) => event.kind === "NEWS").every((event) => event.importance === "MARKET_MOVING"), true);
  assert.equal(update.events[0].event_fingerprint, update.events[1].event_fingerprint);
  assert.equal(update.events.find((event) => event.affected_symbols[0] === "NVDA").earnings_result.reported, false);

  const store = openSnapshotDatabase(databasePath);
  assert.equal(store.importMarketIntelligence(update).inserted, 4);
  assert.equal(store.importMarketIntelligence(update).inserted, 0);
  const state = store.getActive();
  assert.equal(state.marketIntelligence.eventCount, 4);
  assert.deepEqual(state.marketIntelligence.events.find((event) => event.event_type === "earnings_result").earnings_result, { session: "AMC", eps_actual: 2.1, eps_estimate: 2, revenue_actual: 1050, revenue_estimate: 1000, reported: true });
  assert.deepEqual(state.marketIntelligence.events.find((event) => event.affected_symbols[0] === "NVDA").earnings_result, { session: "AMC", eps_actual: null, eps_estimate: null, revenue_actual: null, revenue_estimate: 1000, reported: false });
  assert.equal(state.marketIntelligence.causalChains.length, 1);
  assert.equal(state.marketIntelligence.causalChains[0].event_evidence_state, "VERIFIED");
  assert.equal(state.marketIntelligence.causalChains[0].evidence_state, "待验证假设");
  assert.equal(state.marketIntelligence.causalChains[0].mechanism, "待验证假设");
  assert.equal(state.marketIntelligence.causalChains[0].confidence, null);
  assert.deepEqual(state.marketIntelligence.causalChains[0].affected, ["SPY", "QQQ"]);
  assert.deepEqual(store.checkUtcStorage(), []);
  store.close();

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const raw = database.prepare("SELECT raw_json, fetched_at FROM market_events WHERE kind = 'NEWS' LIMIT 1").get();
  assert.match(raw.raw_json, /Consumer Price Index/);
  assert.match(raw.fetched_at, /Z$/);
  database.close();
});

test("Finnhub maps fixed70 company headlines without turning null earnings into results", async () => {
  const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "test-token", request: (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/news")) return new Response(JSON.stringify([
      { id: 11, headline: "Tesla prepares Cybercab launch", source: "Reuters", datetime: publishedAt, related: "" },
      { id: 12, headline: "Apple announces September event", source: "Reuters", datetime: publishedAt, related: "" },
      { id: 13, headline: "Dell lifts outlook after AI server demand", source: "Reuters", datetime: publishedAt, related: "" },
    ]), { status: 200 });
    return new Response(JSON.stringify({ earningsCalendar: [
      { symbol: "DELL", date: "2026-08-12", hour: "amc", epsActual: null, epsEstimate: 5, revenueActual: null, revenueEstimate: 45_000 },
    ] }), { status: 200 });
  } }, observedAt);
  assert.deepEqual(update.events.filter((event) => event.kind === "NEWS").map((event) => event.affected_symbols), [["TSLA"], ["AAPL"], ["DELL"]]);
  const earnings = update.events.find((event) => event.kind === "EARNINGS");
  assert.equal(earnings.event_type, "earnings");
  assert.equal(earnings.earnings_result.reported, false);
});

test("Finnhub machine-scope credential is readable outside the setup process", { skip: process.platform !== "win32" }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-finnhub-credential-"));
  const credentialPath = join(directory, "finnhub-credentials.json");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const escaped = credentialPath.replaceAll("'", "''");
  const command = `Add-Type -AssemblyName System.Security;$b=[Text.Encoding]::UTF8.GetBytes('test-token');$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine);$j=@{version=2;provider='FINNHUB';protection_scope='LOCAL_MACHINE';protected_token=[Convert]::ToBase64String($p)}|ConvertTo-Json -Compress;[IO.File]::WriteAllText('${escaped}',$j,[Text.UTF8Encoding]::new($false))`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true });
  const update = await collectFinnhubOfficial({ credentialPath, request: (input) => {
    assert.equal(new URL(input).searchParams.get("token"), "test-token");
    return officialResponse(new URL(input));
  } }, observedAt);
  assert.equal(update.source.status, "LIVE");
  assert.equal(update.source.authorization, "VALID");
});

test("Finnhub isolates an incomplete earnings row without discarding valid official results", async () => {
  const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "test-token", request: (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/news")) return new Response("[]", { status: 200 });
    return new Response(JSON.stringify({ earningsCalendar: [
      { symbol: "AAPL", date: "2026-08-11", hour: "amc", epsActual: 2.1, epsEstimate: 2 },
      { symbol: "", date: "", hour: "" },
    ] }), { status: 200 });
  } }, observedAt);
  assert.equal(update.source.status, "DEGRADED");
  assert.equal(update.source.capabilities.earnings_calendar, true);
  assert.match(update.source.error, /隔离1条/);
  assert.deepEqual(update.events.map((event) => [event.kind, event.affected_symbols[0], event.earnings_result?.reported]), [["EARNINGS", "AAPL", true]]);
});

test("Finnhub never performs a request without local credentials and reports expired authorization", async () => {
  let requests = 0;
  const notConfigured = await collectFinnhubOfficial({ credentialPath: "Z:\\definitely-missing.json", request: async () => { requests += 1; return new Response(); } }, observedAt);
  assert.equal(notConfigured.source.status, "NOT_CONFIGURED");
  assert.equal(notConfigured.source.configured, false);
  assert.equal(requests, 0);

  const expired = await collectFinnhubOfficial({ credentialPath: "unused", token: "expired", request: async () => new Response("unauthorized", { status: 401 }) }, observedAt);
  assert.equal(expired.source.status, "DATA_BLOCKED");
  assert.equal(expired.source.authorization, "EXPIRED");
  assert.equal(expired.events.length, 0);
});

test("self-check records missing news source and unresolved causal evidence without duplicate complaints", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-news-guard-"));
  const store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const closedMarket = { source: "ROBINHOOD", symbol: "SPY", interval: "5m", status: "MARKET_CLOSED", as_of: observedAt, freshness_seconds: 0, market_session: "POSTMARKET", current_price: 1, bars: [], error: null };
  const notConfigured = await collectFinnhubOfficial({ credentialPath: join(directory, "missing.json") }, observedAt);
  const first = createIncidentGuard({ store, siteVersion: "test", dataRoot: directory, now: () => new Date(observedAt), pageProbe: async () => true, marketProbe: async () => closedMarket, newsProbe: async () => notConfigured, desktopProbe: async () => [] });
  await first.runOnce();
  assert.ok(store.getSelfCheck().active.some((item) => item.code === "NEWS_SOURCE_NOT_CONFIGURED"));
  const complaintCount = store.listComplaints().length;
  await first.runOnce();
  assert.equal(store.listComplaints().length, complaintCount);

  const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "test-token", request: (input) => officialResponse(new URL(input)) }, observedAt);
  const causal = createIncidentGuard({ store, siteVersion: "test", dataRoot: directory, now: () => new Date(observedAt), pageProbe: async () => true, marketProbe: async () => closedMarket, newsProbe: async () => update, desktopProbe: async () => [] });
  await causal.runOnce();
  assert.ok(store.getSelfCheck().active.some((item) => item.code === "CAUSAL_EVIDENCE_MISSING"));
});
