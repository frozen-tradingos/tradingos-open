import assert from "node:assert/strict";
import test from "node:test";
import { projectCompanyEvidence } from "../app/company-evidence.ts";

const at = "2026-09-29T18:00:00.000Z", fetched = "2026-09-29T17:59:00.000Z", received = "2026-09-29T17:59:30.000Z";
const news = (extra = {}) => ({ event_id: "news-1", event_fingerprint: null, kind: "NEWS", title: "Nvidia announces product update",
  source: "Fixture news", source_url: "https://example.com/news", published_at: "2026-09-29T17:00:00.000Z", scheduled_for: null,
  fetched_at: fetched, affected_symbols: ["NVDA"], industry: null, event_type: "company", novelty: "NEW", importance: "NOT_VERIFIED", event_evidence_state: "UNVERIFIED", ...extra });
const earnings = (extra = {}) => ({ ...news(), event_id: "earnings-1", kind: "EARNINGS", title: "NVDA 财报日历", source: "Finnhub Earnings Calendar",
  source_url: null, published_at: null, scheduled_for: "2026-10-01", event_type: "earnings",
  earnings_result: { session: "AMC", reported: false, eps_actual: null, eps_estimate: 1.2, revenue_actual: null, revenue_estimate: 100 }, ...extra });
const state = (extra = {}) => ({ eventCount: 1, events: [news()], causalChains: [], eventResponseReceivedAt: { "news-1": received },
  currentEarnings: [earnings()], earningsCalendar: { checked_at: fetched, response_received_at: received, event_ids: ["earnings-1"] }, ...extra });

test("projects headline mentions and current earnings without changing inputs or original numbers", () => {
  const input = state({ currentEarnings: [earnings({ event_type: "earnings_result", earnings_result: { session: "AMC", reported: true, eps_actual: -1.2, eps_estimate: 0,
    revenue_actual: 0, revenue_estimate: null } })] }), before = structuredClone(input);
  const result = projectCompanyEvidence("NVDA", input, at);
  assert.deepEqual(result.news, [{ evidence_ref: "news:news-1", title: news().title, source: news().source, url: news().source_url,
    published_at: news().published_at, received_at: received }]);
  assert.deepEqual(result.earnings[0], { evidence_ref: "earnings:earnings-1", title: "NVDA 财报日历", date: "2026-10-01", fetched_at: fetched,
    session: "AMC", reported: true, eps_actual: -1.2, eps_estimate: 0, revenue_actual: 0, revenue_estimate: null });
  assert.deepEqual(input, before);
  result.earnings[0].eps_actual = 999;
  assert.deepEqual(input, before, "output fields cannot mutate the archived event");
  assert.match(result.limitations.join(" "), /币种与财期未独立核实/);
});

test("rejects future or missing receipt and future published/fetched times", () => {
  const future = "2026-09-29T18:00:01.000Z";
  for (const input of [state({ eventResponseReceivedAt: { "news-1": future } }), state({ eventResponseReceivedAt: {} }),
    state({ eventResponseReceivedAt: { "news-1": null } }), state({ eventResponseReceivedAt: { "news-1": "bad-time" } }),
    state({ events: [news({ published_at: future })] }), state({ events: [news({ fetched_at: future })] }),
    state({ eventResponseReceivedAt: { "news-1": "2026-09-29T17:58:00.000Z" } })]) {
    assert.deepEqual(projectCompanyEvidence("NVDA", input, at).news, []);
  }
  assert.match(projectCompanyEvidence("NVDA", state({ eventResponseReceivedAt: {} }), at).limitations.join(" "), /缺少归档接收时间/);
});

test("ignores old company-query associations and keeps only seven-day headline matches", () => {
  assert.deepEqual(projectCompanyEvidence("NVDA", state({ events: [news({ title: "Apple announces results", affected_symbols: ["NVDA"] })] }), at).news, []);
  assert.equal(projectCompanyEvidence("AAPL", state({ events: [news({ title: "Apple announces results", affected_symbols: ["NVDA"] })] }), at).news.length, 1);
  assert.equal(projectCompanyEvidence("NVDA", state({ events: [news({ published_at: "2026-09-22T18:00:00.000Z" })] }), at).news.length, 1);
  assert.deepEqual(projectCompanyEvidence("NVDA", state({ events: [news({ published_at: "2026-09-22T17:59:59.999Z" })] }), at).news, []);
});

test("requires a current calendar and membership; archived earnings never reactivate on their own", () => {
  for (const extra of [{ earningsCalendar: null }, { earningsCalendar: undefined }, { currentEarnings: undefined },
    { earningsCalendar: { checked_at: fetched, response_received_at: received, event_ids: [] } },
    { earningsCalendar: { checked_at: fetched, response_received_at: received, event_ids: ["other-id"] } },
    { earningsCalendar: { checked_at: "2026-09-28T17:59:59.999Z", response_received_at: received, event_ids: ["earnings-1"] } },
    { earningsCalendar: { checked_at: fetched, response_received_at: "2026-09-29T18:00:01.000Z", event_ids: ["earnings-1"] } },
    { earningsCalendar: { checked_at: "2026-09-29T18:00:01.000Z", response_received_at: received, event_ids: ["earnings-1"] } },
    { earningsCalendar: { checked_at: fetched, response_received_at: "2026-09-29T17:58:00.000Z", event_ids: ["earnings-1"] } }]) {
    assert.deepEqual(projectCompanyEvidence("NVDA", state({ events: [earnings()], ...extra }), at).earnings, []);
  }
  const result = projectCompanyEvidence("NVDA", state(), at);
  assert.equal(result.earnings[0].reported, false, "future scheduled date stays planned; no new reported calculation");
  assert.equal(projectCompanyEvidence("NVDA", state({ currentEarnings: [earnings({ scheduled_for: "2026-02-30" })] }), at).earnings.length, 0);
  assert.equal(projectCompanyEvidence("NVDA", state({ currentEarnings: [earnings({ fetched_at: received })] }), at).earnings.length, 0);
  assert.equal(projectCompanyEvidence("NVDA", state({ currentEarnings: [earnings({ event_type: "company" })] }), at).earnings.length, 0);
});

test("caps news at five and earnings at three without sorting the source arrays", () => {
  const events = Array.from({ length: 7 }, (_, i) => news({ event_id: `n-${i}`, published_at: `2026-09-29T1${i}:00:00.000Z` }));
  const currentEarnings = Array.from({ length: 4 }, (_, i) => earnings({ event_id: `e-${i}` }));
  const input = state({ events, currentEarnings, eventResponseReceivedAt: Object.fromEntries(events.map((row) => [row.event_id, received])),
    earningsCalendar: { checked_at: fetched, response_received_at: received, event_ids: currentEarnings.map((row) => row.event_id) } }), before = structuredClone(input);
  const result = projectCompanyEvidence("NVDA", input, at);
  assert.equal(result.news.length, 5); assert.equal(result.news[0].evidence_ref, "news:n-6"); assert.equal(result.earnings.length, 3);
  assert.deepEqual(input, before);
});

test("invalid cutoff and empty archives remain explicit missing coverage", () => {
  const result = projectCompanyEvidence("NVDA", state(), "invalid");
  assert.deepEqual(result.news, []); assert.deepEqual(result.earnings, []); assert.match(result.limitations.join(" "), /截止时间无效/);
  const empty = projectCompanyEvidence("NVDA", state({ events: [], currentEarnings: [] }), at);
  assert.deepEqual(empty.news, []); assert.deepEqual(empty.earnings, []); assert.match(empty.limitations.join(" "), /空列表不代表没有/);
});
