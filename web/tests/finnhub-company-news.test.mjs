import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { collectFinnhubOfficial } from "../server/finnhub.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";

const observedAt = "2026-09-09T17:30:00.000Z";
const publishedAt = Math.floor(Date.parse("2026-09-09T17:25:00.000Z") / 1_000);
const row = (symbol, overrides = {}) => ({ symbol, status: "LIVE", swing: { stage: "CONFIRMED", direction: "BULLISH" }, ...overrides });
const approvedCapabilities = { fixed_pool: {
  candidates: ["SPY", "NOT_APPROVED", "TSLA", "TSLA", "NVDA", "AMD", "TEM", "XOM", "AAPL"],
  rows: [row("SPY"), row("NOT_APPROVED"), row("TSLA"), row("NVDA", { status: "DATA_BLOCKED" }), row("AMD", { swing: { stage: "WAIT", direction: "BULLISH" } }), row("TEM"), row("XOM", { swing: { stage: "EARLY_WATCH", direction: "BEARISH" } }), row("AAPL")],
} };
const article = (id, extra = {}) => ({ id, headline: "Company announces a new development", source: "Reuters", datetime: publishedAt, related: "", url: `https://example.test/news/${id}`, ...extra });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const baseline = (url) => url.pathname.endsWith("/calendar/earnings") ? response({ earningsCalendar: [] }) : response([article(1, { headline: "General market briefing" })]);

test("company news covers at most three approved equity candidates without promoting headlines", async () => {
  const calls = [];
  const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "fixture-token", approvedCapabilities,
    request: async (input, options) => {
      const url = new URL(input); calls.push({ url, signal: options.signal });
      return url.pathname.endsWith("/company-news") ? response([article(1), article(2, { related: "QQQ" })]) : baseline(url);
    },
  }, observedAt);
  const companyCalls = calls.filter(({ url }) => url.pathname.endsWith("/company-news"));
  assert.deepEqual(companyCalls.map(({ url }) => url.searchParams.get("symbol")), ["TSLA", "TEM", "XOM"]);
  assert.equal(calls.length, 5);
  assert.equal(new Set(calls.map(({ signal }) => signal)).size, 1, "all requests share the original collection deadline");
  assert.ok(companyCalls.every(({ url }) => url.searchParams.get("from") === "2026-09-08" && url.searchParams.get("to") === "2026-09-09"));
  assert.equal(update.source.status, "LIVE");
  assert.equal(update.events.length, 7);
  assert.equal(new Set(update.events.map((event) => event.event_id)).size, 7, "query provenance survives an earlier general-news observation");
  const company = update.events.filter((event) => JSON.parse(event.raw_json).request?.symbol === "TSLA");
  assert.deepEqual(company.map((event) => event.affected_symbols), [[], ["QQQ"]]);
  assert.deepEqual(JSON.parse(company[1].raw_json), { request: { path: "/company-news", symbol: "TSLA" }, response: article(2, { related: "QQQ" }) });
  assert.ok(company.every((event) => event.published_at === "2026-09-09T17:25:00.000Z" && event.fetched_at === observedAt && Date.parse(event.response_received_at) >= Date.parse(event.fetched_at)));
  assert.ok(update.events.every((event) => event.event_fingerprint === null && event.expires_at === null && event.event_evidence_state === "UNVERIFIED" && event.importance === "NOT_VERIFIED"));
});

test("one company failure does not discard general news or a sibling and does not retry", async () => {
  const calls = [];
  const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "fixture-token", approvedCapabilities,
    request: async (input) => {
      const url = new URL(input); calls.push(url);
      if (!url.pathname.endsWith("/company-news")) return baseline(url);
      return url.searchParams.get("symbol") === "TSLA" ? response({ error: "fixture failure" }, 503) : response([article(3)]);
    },
  }, observedAt);
  assert.equal(calls.length, 5);
  assert.equal(update.source.status, "DEGRADED");
  assert.equal(update.source.authorization, "VALID");
  assert.equal(update.source.capabilities.news, true);
  assert.match(update.source.error, /company-news.*TSLA.*503/);
  assert.doesNotMatch(update.source.error, /fixture-token/);
  assert.equal(update.events.length, 3);
  assert.equal(update.events[0].title, "General market briefing");
  assert.deepEqual(update.events.slice(1).map((event) => event.affected_symbols), [[], []]);
  assert.deepEqual(update.events.slice(1).map((event) => JSON.parse(event.raw_json).request.symbol), ["TEM", "XOM"]);
});

test("querying NVDA does not make an unrelated article affect NVDA, while headline and related evidence survive", async () => {
  const articles = [
    article(901, { headline: "Apple announces fixture results" }),
    article(902),
    article(903, { headline: "NVIDIA announces fixture results" }),
    article(904, { related: "NVDA" }),
  ];
  const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "fixture-token", approvedCapabilities: { fixed_pool: { candidates: ["NVDA"], rows: [row("NVDA")] } },
    request: async (input) => response(new URL(input).pathname.endsWith("/company-news") ? articles : new URL(input).pathname.endsWith("/calendar/earnings") ? { earningsCalendar: [] } : []),
  }, observedAt);
  assert.deepEqual(update.events.map((event) => event.affected_symbols), [["AAPL"], [], ["NVDA"], ["NVDA"]]);
  assert.deepEqual(update.events.map((event) => JSON.parse(event.raw_json)), articles.map((raw) => ({ request: { path: "/company-news", symbol: "NVDA" }, response: raw })));
  assert.ok(update.events.every((event) => event.event_evidence_state === "UNVERIFIED" && event.importance === "NOT_VERIFIED" && event.event_fingerprint === null));
});

test("slow company requests abort together inside the existing budget, retaining received news", async () => {
  const signals = [], aborted = [];
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    const started = performance.now();
    const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "fixture-token", approvedCapabilities, timeoutMs: 60,
      request: async (input, options) => {
        const url = new URL(input); signals.push(options.signal);
        if (!url.pathname.endsWith("/company-news")) return baseline(url);
        return new Promise((_accept, reject) => options.signal.addEventListener("abort", () => { aborted.push(url.searchParams.get("symbol")); reject(options.signal.reason); }, { once: true }));
      },
    }, observedAt);
    assert.ok(performance.now() - started < 600);
    assert.equal(new Set(signals).size, 1);
    assert.deepEqual(aborted, ["TSLA", "TEM", "XOM"]);
    assert.equal(update.source.status, "DEGRADED");
    assert.equal(update.events.length, 1);
  } finally { clearTimeout(keepAlive); }
});

test("no approved snapshot adds no company request and the existing event TTL is unchanged", async () => {
  const calls = [];
  const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "fixture-token", request: async (input) => {
    const url = new URL(input); calls.push(url.pathname);
    return url.pathname.endsWith("/news") ? response([article(4, { headline: "Consumer Price Index released", source: "BLS" })]) : baseline(url);
  } }, observedAt);
  assert.equal(calls.length, 2);
  assert.equal(update.events[0].event_evidence_state, "VERIFIED");
  assert.equal(update.events[0].expires_at, "2026-09-09T23:25:00.000Z");
});

test("company collection never fresh-stamps old items or accepts future and malformed publication times", async () => {
  const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "fixture-token", approvedCapabilities,
    request: async (input) => {
      const url = new URL(input);
      if (!url.pathname.endsWith("/company-news")) return baseline(url);
      const symbol = url.searchParams.get("symbol");
      return response([symbol === "TSLA" ? article(5, { datetime: publishedAt - 86_400 }) : symbol === "TEM" ? article(6, { datetime: 9_000_000_000 }) : article(7, { datetime: null })]);
    },
  }, observedAt);
  assert.equal(update.source.status, "DEGRADED");
  assert.equal(update.events.length, 1);
  assert.match(update.source.error, /TEM.*未来发布时间/);
  assert.match(update.source.error, /XOM.*不完整项目/);
  assert.equal(update.events[0].published_at, "2026-09-09T17:25:00.000Z");
});

test("production Finnhub cache reads existing approved candidates, never waits on A1", async () => {
  const source = readFileSync(new URL("../server/local-owner-server.ts", import.meta.url), "utf8");
  const start = source.indexOf("  const finnhubNews = () => {");
  const block = source.slice(start, source.indexOf("\n  const sessionFor", start));
  assert.match(block, /approvedCapabilities/);
  assert.doesNotMatch(block, /withRobinhoodMcp|runOnce|runTsCore|executeStep/);
  const createCheck = new Function("snapshots", "collectFinnhubOfficial", "options", "resolve", "dataRoot", "publicAutomationEnabled", `let finnhubCache = null;\n${block}\nreturn finnhubNews;`);
  const received = [];
  const collect = async (options) => { received.push(options); return { source: { status: "LIVE", error: null }, events: [article(1)] }; };
  let reads = 0;
  const getActiveAsync = async () => { throw Error("full snapshot read is forbidden for news coverage"); };
  const check = createCheck({ getActiveAsync, getMarketRadar: () => { reads++; return { snapshot: approvedCapabilities }; } }, collect, { finnhubCredentialPath: "unused" }, () => "unused", "unused", () => true);
  const first = check();
  assert.equal(check(), first, "existing cache coalesces the new coverage too");
  assert.equal((await first).source.status, "LIVE");
  assert.equal(received.length, 1);
  assert.equal(reads, 1, "one exact archived-candidate read, no snapshot worker");
  assert.equal(received[0].approvedCapabilities, approvedCapabilities);
  const failed = createCheck({ getActiveAsync, getMarketRadar: () => { throw Error("fixture read failure"); } }, collect, { finnhubCredentialPath: "unused" }, () => "unused", "unused", () => true);
  const result = await failed();
  assert.equal(received[1].approvedCapabilities, undefined);
  assert.equal(result.source.status, "DEGRADED");
  assert.match(result.source.error, /候选读取失败/);
  assert.equal(result.events.length, 1, "fresh general results survive the candidate-read failure");
  const blocked = createCheck({ getMarketRadar: () => assert.fail("disabled mode must not read candidates") }, async (options) => {
    assert.equal(options.token, ""); assert.equal(options.credentialPath, "");
    return { source: { status: "NOT_CONFIGURED" }, events: [] };
  }, {}, () => "unused", "unused", () => false);
  assert.equal((await blocked()).source.status, "NOT_CONFIGURED", "the offline branch never supplies stored credentials");
});

// Isolated synthetic articles only: these URLs are shape fixtures, never fetched.
const announcement = "https://ir.tesla.com/press-release/tesla-announces-fixture-model-launch";
const officialArticle = (id, extra = {}) => article(id, { headline: "Tesla announces fixture model launch", source: "Tesla", url: announcement, summary: "Isolated fixture, not a real announcement.", ...extra });
const companyUpdate = (articles) => collectFinnhubOfficial({ credentialPath: "unused", token: "fixture-token", approvedCapabilities: { fixed_pool: { candidates: ["TSLA"], rows: [row("TSLA")] } }, request: async (input) => {
  const url = new URL(input);
  return response(url.pathname.endsWith("/company-news") ? articles : url.pathname.endsWith("/calendar/earnings") ? { earningsCalendar: [] } : []);
} }, observedAt);
async function newsStore(context) {
  const root = resolve(import.meta.dirname, "..");
  const directory = await mkdtemp(join(root, ".isolated-company-news-"));
  const store = openSnapshotDatabase(join(directory, "news.sqlite"));
  context.after(async () => { store.close(); assert.equal(resolve(directory, ".."), root); await rm(directory, { recursive: true }); });
  return store;
}

test("official-looking company link remains unverified without matching original article evidence", async (context) => {
  const raw = officialArticle(101), update = await companyUpdate([raw]);
  assert.equal(update.events[0].event_category, null);
  assert.equal(update.events[0].event_fingerprint, null);
  assert.equal(update.events[0].event_evidence_state, "UNVERIFIED");
  assert.equal(update.events[0].importance, "NOT_VERIFIED");
  assert.equal(update.events[0].expires_at, null);
  assert.deepEqual(JSON.parse(update.events[0].raw_json).response, raw);
  const store = await newsStore(context);
  store.importMarketIntelligence(update);
  const state = store.getActive().marketIntelligence;
  assert.equal(state.events[0].event_evidence_state, "UNVERIFIED");
  assert.equal(state.causalChains.length, 0);
  assert.deepEqual(state.events[0].affected_symbols, ["TSLA"]);
});

test("old Tesla earnings URL with a fabricated new launch headline and today's timestamp cannot verify a launch", async (context) => {
  const raw = officialArticle(104, {
    headline: "Tesla announces new model launch",
    url: "https://ir.tesla.com/press-release/tesla-releases-second-quarter-2026-financial-results",
    summary: "Isolated mismatch fixture: this URL refers to older quarterly financial results, not this headline.",
  });
  const update = await companyUpdate([raw]);
  const store = await newsStore(context);
  assert.equal(update.events[0].published_at, "2026-09-09T17:25:00.000Z", "retain provider claim without treating it as official verification");
  assert.equal(update.events[0].event_evidence_state, "UNVERIFIED");
  assert.equal(update.events[0].event_fingerprint, null);
  assert.equal(update.events[0].expires_at, null);
  assert.deepEqual(JSON.parse(update.events[0].raw_json).response, raw);
  store.importMarketIntelligence(update);
  assert.equal(store.getActive().marketIntelligence.causalChains.length, 0);
});

test("retained company category cannot borrow two publisher labels or an official label to become verified", async (context) => {
  const store = await newsStore(context);
  const update = await companyUpdate([officialArticle(105), officialArticle(106)]);
  const fingerprint = "c".repeat(64);
  const input = { ...update, events: update.events.map((event, index) => ({
    ...event, source: index ? "AP News" : "SEC", event_fingerprint: fingerprint,
    event_category: "company_announcement", event_evidence_state: "PARTIAL", expires_at: "2026-09-09T23:25:00.000Z",
  })) };
  store.importMarketIntelligence(input);
  const state = store.getActive().marketIntelligence;
  assert.equal(state.eventCount, 2);
  assert.ok(state.events.every((event) => event.event_evidence_state === "PARTIAL"));
  assert.equal(state.causalChains.length, 1);
  assert.equal(state.causalChains[0].event_evidence_state, "PARTIAL");
  assert.deepEqual(state.causalChains[0].supporting_evidence.map((event) => event.title).sort(), input.events.map((event) => event.title).sort());
  assert.equal(state.causalChains.filter((chain) => chain.event_evidence_state === "VERIFIED").length, 0);
});

test("different publishers citing one announcement remain unverified without the actual official article", async (context) => {
  const store = await newsStore(context);
  const articles = [
    officialArticle(102, { headline: "Tesla launches fixture model at company event", source: "Reuters", url: "https://www.reuters.com/business/autos/tesla-fixture-launch", summary: `Fixture original reporting. Announcement: ${announcement}` }),
    officialArticle(103, { headline: "Tesla introduces fixture model with new configuration", source: "AP News", url: "https://apnews.com/article/tesla-fixture-introduction", summary: `Fixture independently reported announcement: ${announcement}?utm_source=fixture` }),
  ];
  const update = await companyUpdate(articles);
  assert.ok(update.events.every((event) => event.event_fingerprint === null && event.expires_at === null && event.event_evidence_state === "UNVERIFIED" && event.importance === "NOT_VERIFIED"));
  store.importMarketIntelligence(update);
  assert.equal(store.getActive().marketIntelligence.causalChains.length, 0);
  assert.equal(store.getActive().marketIntelligence.eventCount, 2);
});

test("company name, source label, homepage, opinion, advertising and lookalike hosts are not announcement evidence", async () => {
  const invalid = [
    { url: "https://ir.tesla.com.evil.test/press-release/tesla-announces-fixture-model-launch" },
    { url: "https://ir.tesla.com@evil.test/press-release/tesla-announces-fixture-model-launch" },
    { url: announcement.replace("https:", "http:") },
    { url: announcement.replace("ir.tesla.com", "ir.tesla.com:8443") },
    { url: "https://ir.tesla.com/" }, { url: "https://ir.tesla.com/press-release/" },
    { url: `${announcement}?article=another-event` },
    { url: "https://www.tesla.com/shop/tesla-announces-fixture-sale" },
    { headline: "Opinion: Tesla announces a fixture model, should investors buy?" },
    { headline: "Sponsored: Tesla announces fixture discount offer" },
    { headline: "Tesla may announce a fixture model" },
    { url: "https://www.apple.com/newsroom/2026/09/apple-announces-fixture-model/" },
    { headline: "Apple announces fixture model", url: "https://www.apple.com/newsroom/2026/09/apple-announces-fixture-model/" },
    { source: "SEC", url: "https://example.test/tesla-announcement" },
  ];
  for (const [index, extra] of invalid.entries()) {
    const update = await companyUpdate([officialArticle(200 + index, extra)]);
    assert.equal(update.events[0].event_fingerprint, null, JSON.stringify(extra));
    assert.equal(update.events[0].event_evidence_state, "UNVERIFIED");
    assert.equal(update.events[0].expires_at, null);
  }
});

test("distinct company links retain separate raw observations without inventing verified event identities", async (context) => {
  const store = await newsStore(context);
  const update = await companyUpdate([
    officialArticle(301),
    officialArticle(302, { headline: "Tesla reports fixture quarterly results", url: `${announcement}-different-release` }),
  ]);
  assert.notEqual(update.events[0].event_id, update.events[1].event_id);
  assert.ok(update.events.every((event) => event.event_fingerprint === null));
  store.importMarketIntelligence(update);
  assert.equal(store.getActive().marketIntelligence.eventCount, 2);
  assert.equal(store.getActive().marketIntelligence.causalChains.length, 0);
});

test("reprints, identical copy and untrusted publisher URLs never supply a second independent source", async (context) => {
  const variants = [
    { source: "Yahoo Finance", url: "https://finance.yahoo.com/news/tesla-fixture-reprint.html", summary: `(Reuters) ${announcement}` },
    { source: "AP News", url: "https://apnews.com/article/tesla-fixture-reprint", summary: `By Reuters. ${announcement}` },
    { source: "CNBC", url: "https://www.cnbc.com/2026/09/09/tesla-fixture.html", headline: "Tesla announces fixture model launch" },
    { source: "AP News", url: "https://example.test/fake-ap-story" },
    { source: "Reuters", url: "https://apnews.com/article/source-label-mismatch" },
  ];
  const store = await newsStore(context);
  for (const [index, extra] of variants.entries()) {
    const primary = `${announcement}-${index}`;
    const update = await companyUpdate([
      officialArticle(400 + index * 2, { source: "Reuters", url: `https://www.reuters.com/business/autos/fixture-${index}`, summary: primary }),
      officialArticle(401 + index * 2, { headline: "Tesla introduces fixture model", summary: primary, ...extra, ...(extra.summary ? { summary: extra.summary.replace(announcement, primary) } : {}) }),
    ]);
    store.importMarketIntelligence(update);
    assert.equal(store.getActive().marketIntelligence.causalChains.length, 0, JSON.stringify(extra));
    assert.ok(update.events.every((event) => event.event_evidence_state === "UNVERIFIED" && event.expires_at === null && event.event_fingerprint === null));
  }
});

for (const kind of ["identical body under changed headlines", "CNBC PR Newswire repost", "background link to a prior event"]) test(`media cannot establish company identity: ${kind}`, async (context) => {
  const store = await newsStore(context);
  const body = `Copied or background reporting about Tesla. ${announcement}`;
  const rows = [
    officialArticle(451, { source: "Reuters", url: "https://www.reuters.com/business/autos/fixture-current", summary: body }),
    officialArticle(452, { source: "AP News", url: "https://apnews.com/article/fixture-current", headline: "Tesla introduces fixture model configuration", summary: body }),
  ];
  if (kind === "CNBC PR Newswire repost") rows[1] = { ...rows[1], source: "CNBC", url: "https://www.cnbc.com/2026/09/09/tesla-fixture-release.html", summary: `PR Newswire. SOURCE Tesla, Inc. ${announcement}` };
  if (kind === "background link to a prior event") {
    rows[0].summary = `Current fixture model launch. Background only, prior quarterly results: ${announcement}-prior-results`;
    rows[1].headline = "Tesla reports fixture quarterly results";
    rows[1].summary = `The reported results are explained in ${announcement}-prior-results`;
  }
  const update = await companyUpdate(rows);
  assert.ok(update.events.every((event) => event.event_evidence_state === "UNVERIFIED" && event.event_fingerprint === null && event.expires_at === null));
  assert.deepEqual(update.events.map((event) => JSON.parse(event.raw_json).response), rows);
  store.importMarketIntelligence(update);
  assert.equal(store.getActive().marketIntelligence.causalChains.length, 0);
  assert.equal(store.getActive().marketIntelligence.eventCount, 2);
});

test("old company items retain publication age and cached imports cannot manufacture verified expiry", async (context) => {
  const store = await newsStore(context);
  const update = await companyUpdate([officialArticle(501, { datetime: publishedAt - 7 * 3_600 })]);
  assert.equal(update.events[0].published_at, "2026-09-09T10:25:00.000Z");
  assert.equal(update.events[0].expires_at, null);
  store.importMarketIntelligence(update);
  const before = store.getActive().marketIntelligence;
  assert.equal(store.importMarketIntelligence({ ...update, source: { ...update.source, checked_at: "2026-09-10T17:30:00.000Z" } }).inserted, 0);
  assert.equal(store.getActive().marketIntelligence.causalChains.length, 0);
  assert.deepEqual(store.getActive().marketIntelligence.events, before.events);
});

test("new company normalization never rewrites an already archived unverified article", async (context) => {
  const store = await newsStore(context), update = await companyUpdate([officialArticle(601, { headline: "NVIDIA announces fixture results" })]);
  assert.deepEqual(update.events[0].affected_symbols, ["NVDA"]);
  const legacy = { ...update, events: update.events.map((event) => ({ ...event, affected_symbols: ["TSLA", "NVDA"], event_fingerprint: null, event_category: null, event_type: "general", event_evidence_state: "UNVERIFIED", expires_at: null })) };
  store.importMarketIntelligence(legacy);
  const before = store.getActive().marketIntelligence;
  assert.equal(store.importMarketIntelligence(update).inserted, 0);
  assert.deepEqual(store.getActive().marketIntelligence, before, "old rows are not migrated, relabeled, or fresh-stamped");
  assert.deepEqual(before.events[0].affected_symbols, ["TSLA", "NVDA"], "the old query-derived association remains historical evidence, not rewritten by the fix");
});

test("all official-looking release paths remain source links rather than event verification in general news", async () => {
  const fixtures = [
    ["TSLA", "Tesla", announcement],
    ["AAPL", "Apple", "https://www.apple.com/newsroom/2026/09/apple-announces-fixture-launch/"],
    ["DELL", "Dell Technologies", "https://investors.delltechnologies.com/news-releases/news-release-details/dell-announces-fixture-results"],
    ["CRWV", "CoreWeave", "https://investors.coreweave.com/news/news-details/2026/CoreWeave-Announces-Fixture-Results/default.aspx"],
    ["XOM", "Exxon Mobil", "https://corporate.exxonmobil.com/news/news-releases/2026/0909-exxon-announces-fixture-results"],
    ["MU", "Micron", "https://investors.micron.com/news/press-release/2026/Micron-Announces-Fixture-Results/default.aspx"],
    ["TEM", "Tempus AI", "https://investors.tempus.com/news-releases/news-release-details/tempus-announces-fixture-results"],
    ["NVDA", "NVIDIA", "https://nvidianews.nvidia.com/news/nvidia-announces-fixture-results"],
    ["MSFT", "Microsoft", "https://news.microsoft.com/2026/09/09/microsoft-announces-fixture-results/"],
  ];
  const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "fixture-token", request: async (input) => {
    const url = new URL(input);
    return response(url.pathname.endsWith("/news") ? fixtures.map(([, company, url], i) => officialArticle(700 + i, { headline: `${company} announces fixture results`, source: company, url })) : { earningsCalendar: [] });
  } }, observedAt);
  assert.deepEqual(update.events.map((event) => event.affected_symbols[0]), fixtures.map(([symbol]) => symbol));
  assert.ok(update.events.every((event) => event.event_evidence_state === "UNVERIFIED" && event.importance === "NOT_VERIFIED" && event.expires_at === null));
  const future = await companyUpdate([officialArticle(799, { datetime: 9_000_000_000 })]);
  assert.equal(future.events.length, 0);
  assert.match(future.source.error, /company-news.*未来发布时间/);
});

test("historical official release URLs remain unverified source links with original dates", async () => {
  // Public issuer pages read on 2026-09-09. Metadata-only historical fixtures; never fetched by tests or imported into production.
  const releases = [
    ["TSLA", "Tesla Releases Second Quarter 2026 Financial Results", "2026-07-22", "https://ir.tesla.com/press-release/tesla-releases-second-quarter-2026-financial-results"],
    ["AAPL", "Apple unveils next generation of Apple Intelligence, Siri AI, and more", "2026-06-08", "https://www.apple.com/newsroom/2026/06/apple-unveils-next-generation-of-apple-intelligence-siri-ai-and-more/"],
    ["DELL", "Dell Technologies Delivers Second Quarter Fiscal 2027 Financial Results", "2026-09-01", "https://investors.delltechnologies.com/news-releases/news-release-details/dell-technologies-delivers-second-quarter-fiscal-2027-financial"],
    ["CRWV", "CoreWeave Reports Strong Second Quarter 2026 Results", "2026-08-11", "https://investors.coreweave.com/news/news-details/2026/CoreWeave-Reports-Strong-Second-Quarter-2026-Results/default.aspx"],
    ["XOM", "ExxonMobil announces 2025 results", "2026-01-30", "https://corporate.exxonmobil.com/news/news-releases/2026/0130-exxonmobil-announces-2025-results"],
    ["MU", "Micron Technology, Inc. Reports Results for the Second Quarter of Fiscal 2026", "2026-03-18", "https://investors.micron.com/news/press-release/2026/Micron-Technology-Inc--Reports-Results-for-the-Second-Quarter-of-Fiscal-2026-03-18-2026/default.aspx"],
    ["TEM", "Tempus Reports Second Quarter 2026 Results", "2026-07-30", "https://investors.tempus.com/news-releases/news-release-details/tempus-reports-second-quarter-2026-results"],
    ["NVDA", "NVIDIA Announces Financial Results for Second Quarter Fiscal 2027", "2026-08-26", "https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-second-quarter-fiscal-2027"],
  ];
  const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "fixture-token", request: async (input) => response(new URL(input).pathname.endsWith("/news")
    ? releases.map(([symbol, headline, day, url], index) => ({ id: 800 + index, headline, source: symbol, related: symbol, datetime: Date.parse(`${day}T12:00:00Z`) / 1_000, url })) : { earningsCalendar: [] }) }, observedAt);
  assert.ok(update.events.every((event) => event.event_evidence_state === "UNVERIFIED"));
  assert.deepEqual(update.events.map((event) => event.affected_symbols), releases.map(([symbol]) => [symbol]));
  assert.ok(update.events.every((event) => event.importance === "NOT_VERIFIED" && event.expires_at === null));
  assert.deepEqual(update.events.map((event) => event.published_at.slice(0, 10)), releases.map(([, , day]) => day));
});
