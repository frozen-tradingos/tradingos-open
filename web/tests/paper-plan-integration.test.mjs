import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { makePaperEvent } from "../server/paper-plan-store.ts";
import { assessPositionRisks } from "../server/position-copilot.ts";
import { timelineOccurrencesForPtDate } from "../app/timeline-schedule.ts";
import { paperPlanId, paperReturnPct } from "../app/paper-plan.ts";

const at = "2026-09-10T13:45:00.000Z";
const plan = {
  plan_id: "paper-plan:2026-09-10", market_date: "2026-09-10", created_at: at, expires_at: "2026-09-18T20:00:00.000Z", symbol: "NVDA", direction: "BULLISH",
  contract: { contract_id: "integration-option", chain_id: "integration-chain", expiration: "2026-09-18", strike: 110, option_type: "call", multiplier: 100 },
  reference: { kind: "SIMULATED_REFERENCE", ask: 2.1, bid: 2, quoted_at: at, recorded_at: at, quantity: 1 },
  source: { evidence_id: "a".repeat(64), snapshot_id: "integration-synthetic", snapshot_hash: "b".repeat(64), observed_at: at },
  why_watch: ["Synthetic integration evidence, not natural trading"], warnings: ["Not a trade or fill"], levels: { entry: 105, invalidation: 100, target: 110 },
  stop_loss_pct: -40, take_profit_pct: 30, mode: "SHADOW", automated_execution: false, executable: false, performance: "EXCLUDED",
};
function fixture(context, investmentProfile = "OWNER") {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) + 60_000 });
  const root = dirname(fileURLToPath(import.meta.url)), directory = mkdtempSync(join(root, "paper-plan-integration-")), file = join(directory, "test.sqlite");
  const store = openSnapshotDatabase(file, { investmentProfile }), db = new DatabaseSync(file);
  context.after(() => { db.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(root) + sep)); rmSync(directory, { recursive: true, force: true }); });
  return { store, db, file };
}
function preserve(db) {
  return Object.fromEntries(["output_records", "stock_manual_plans", "owner_position_plan_versions", "owner_action_events", "ts_forecast_archive", "ts_forecast_settlements", "option_advice_settlements"].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test("paper event reaches real snapshot projection without changing formal outputs or a real-holding-shaped observation", (context) => {
  const { store, db } = fixture(context);
  const occurrence = timelineOccurrencesForPtDate("2026-09-10").find((row) => row.kind === "POSITION_MONITOR" && row.business_slot === "06:45");
  assert.ok(occurrence);
  const position = { account_label: "账户-aaaaaaaaaaaaaaaa", contract_id: "unrelated-holding", symbol: "AVGO", option_type: "call", expiration: "2026-09-18", strike: 410, direction: "long", quantity: 2, average_price: 2, bid: 1.9, ask: 2, as_of: at };
  const check = assessPositionRisks({ source: "ROBINHOOD", status: "LIVE", as_of: at, positions: [position] }, null, at);
  const checkpoint = { ...occurrence, contract_version: "v1", role: "TIMELINE_SCHEDULER", status: "SUCCEEDED", started_at: at, completed_at: at, late_seconds: 0, result_ref: null, reason: null, position_check: check };
  store.importOutputRaw(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `checkpoint:${occurrence.slot_id}`, output_type: "SCHEDULE_CHECKPOINT", channel: "SYSTEM", observed_at: at, payload: checkpoint }), at);
  const before = preserve(db), beforeState = store.getActive(), holdings = store.getOwnerPositionPlans();
  assert.equal(holdings.holdings.length, 1);
  const papers = [plan, ...["AAPL", "MSFT"].map((symbol, index) => ({ ...plan, plan_id: paperPlanId(plan.market_date, index + 2), symbol, contract: { ...plan.contract, contract_id: `integration-${symbol}`, chain_id: `integration-chain-${symbol}` } }))];
  for (const paper of papers) store.appendPaperPlanEvent(makePaperEvent(paper.plan_id, at, "CREATED", { plan: paper }));
  const after = store.getActive();
  assert.deepEqual(after.paperPlans.plans.map((row) => row.plan.contract.contract_id).sort(), papers.map((paper) => paper.contract.contract_id).sort());
  assert.ok(after.paperPlans.plans.every((row) => row.plan.executable === false));
  assert.equal(after.paperPlans.learning.summary.total, 3);
  assert.equal(after.paperPlans.learning.summary.pending, 3);
  assert.equal(after.paperPlans.learning.summary.win_rate_pct, null);
  assert.equal(store.getActivePaperPlans().length, 3);
  assert.deepEqual(after.outputs, beforeState.outputs);
  assert.deepEqual(store.getOwnerPositionPlans(), holdings);
  assert.deepEqual(preserve(db), before);
});

test("BLANK profile cannot append or activate paper plans", (context) => {
  const { store, db } = fixture(context, "BLANK");
  assert.throws(() => store.appendPaperPlanEvent(makePaperEvent(plan.plan_id, at, "CREATED", { plan })), /Owner|空白/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paper_plan_events").get().n, 0);
  assert.deepEqual(store.getActive().paperPlans.plans, []);
});

test("full snapshot retains old active WIN and LOSS tickets beyond ten newer origins and keeps expired history in statistics", (context) => {
  // These are archived legacy origins, all before the Sep 25 liquidity-policy activation.
  const { store, db } = fixture(context), papers = ["08", "09", "10", "11", "14", "15", "16", "17", "18", "21", "22", "23", "24"].map((day, index) => {
    const stamp = `2026-09-${day}T13:45:00.000Z`, expiration = index === 0 ? "2026-09-18" : "2026-10-16";
    return { ...plan, plan_id: paperPlanId(`2026-09-${day}`), market_date: `2026-09-${day}`, created_at: stamp, expires_at: `${expiration}T20:00:00.000Z`, contract: { ...plan.contract, contract_id: `history-${day}`, expiration }, reference: { ...plan.reference, quoted_at: stamp, recorded_at: stamp }, source: { ...plan.source, observed_at: stamp } };
  });
  for (const paper of papers) store.appendPaperPlanEvent(makePaperEvent(paper.plan_id, paper.created_at, "CREATED", { plan: paper }));
  for (const [paper, bid] of [[papers[1], 3], [papers[2], 1]]) {
    const stamp = paper.created_at.replace("13:45", "14:00");
    store.appendPaperPlanEvent(makePaperEvent(paper.plan_id, stamp, "MARK", { quote: { source: "ROBINHOOD", contract_id: paper.contract.contract_id, symbol: paper.symbol, expiration: paper.contract.expiration, strike: paper.contract.strike, option_type: paper.contract.option_type, bid, ask: bid + 0.1, quoted_at: stamp }, estimated_return_pct: paperReturnPct(paper, bid) }));
  }
  store.appendPaperPlanEvent(makePaperEvent(papers[0].plan_id, papers[0].expires_at, "ENDED", { reason: "EXPIRATION", ended_at: papers[0].expires_at, terminal_value: "UNKNOWN" }));
  const originalRows = db.prepare("SELECT * FROM paper_plan_events ORDER BY sequence").all(), protectedRows = preserve(db);
  context.mock.timers.setTime(Date.parse("2026-09-24T14:15:00.000Z"));
  const view = store.getActive().paperPlans, ids = view.plans.map((row) => row.plan.plan_id);
  assert.equal(ids.length, 12); assert.equal(new Set(ids).size, 12);
  assert.ok(ids.includes(papers[1].plan_id)); assert.ok(ids.includes(papers[2].plan_id));
  assert.ok(!ids.includes(papers[0].plan_id));
  assert.equal(store.getActivePaperPlans().length, 12);
  assert.equal(view.learning.summary.total, 13); assert.equal(view.learning.summary.unknown, 1);
  assert.equal(view.learning.summary.wins, 1); assert.equal(view.learning.summary.losses, 1); assert.equal(view.learning.summary.pending, 10);
  assert.equal(view.learning.recent_results.find((row) => row.plan_id === papers[1].plan_id).status, "WIN");
  assert.equal(view.learning.recent_results.find((row) => row.plan_id === papers[2].plan_id).status, "LOSS");
  assert.ok(!view.learning.recent_results.some((row) => row.plan_id === papers[0].plan_id));
  assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events ORDER BY sequence").all(), originalRows);
  assert.deepEqual(preserve(db), protectedRows);
});

test("real core can open an old-schema database read-only without adding the paper table", (context) => {
  const { db, file } = fixture(context);
  db.exec("DROP TABLE paper_plan_events"); // Only this newly created test database: emulate the pre-feature schema.
  const readonly = openSnapshotDatabase(file, { readOnly: true, investmentProfile: "OWNER" });
  try {
    assert.deepEqual(readonly.getActive().paperPlans.plans, []);
    assert.deepEqual(readonly.getActivePaperPlans(), []);
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'paper_plan_events'").get(), undefined);
    assert.throws(() => readonly.appendPaperPlanEvent(makePaperEvent(plan.plan_id, at, "CREATED", { plan })), /只读/);
  } finally { readonly.close(); }
});

test("current earnings membership can refresh or disappear without changing archived schedules", (context) => {
  const { store, db } = fixture(context);
  assert.equal(store.getActive().marketIntelligence.earningsCalendar, null);
  const source = { source: "FINNHUB", status: "LIVE", configured: true, authorization: "VALID", last_success_at: at, as_of: at, freshness_seconds: 0, error: null, checked_at: at, capabilities: { earnings_calendar: true } };
  const scheduled = { event_id: "synthetic-earnings-original", event_fingerprint: null, kind: "EARNINGS", title: "Synthetic NVDA earnings", source: "Finnhub Earnings Calendar", source_url: null, published_at: null, scheduled_for: "2026-09-11", fetched_at: at, response_received_at: at, affected_symbols: ["NVDA"], industry: null, event_type: "earnings", event_category: null, novelty: "NEW", importance: "SCHEDULED", event_evidence_state: "UNVERIFIED", expires_at: null, raw_json: JSON.stringify({ symbol: "NVDA", date: "2026-09-11", hour: "bmo" }), raw_sha256: "a".repeat(64) };
  store.importMarketIntelligence({ source, events: [scheduled] });
  assert.equal(store.getActive().marketIntelligence.eventResponseReceivedAt[scheduled.event_id], at);
  const originalRows = db.prepare("SELECT * FROM market_events ORDER BY sequence").all();
  const refresh = "2026-09-10T14:00:00.000Z";
  const refreshed = { ...scheduled, fetched_at: refresh, response_received_at: "2026-09-10T14:00:10.000Z" };
  store.importMarketIntelligence({ source: { ...source, checked_at: refresh }, events: [refreshed] });
  assert.deepEqual(store.getActive().marketIntelligence.earningsCalendar, { checked_at: refresh, response_received_at: refreshed.response_received_at, event_ids: [scheduled.event_id] });
  assert.deepEqual(db.prepare("SELECT * FROM market_events ORDER BY sequence").all(), originalRows);
  const laterNews = Array.from({ length: 210 }, (_, index) => ({ ...scheduled, kind: "NEWS", event_type: "general", source: "Synthetic", source_url: "https://example.com/synthetic", event_id: `synthetic-later-${index}`, published_at: "2026-09-12T13:45:00.000Z", scheduled_for: null }));
  store.importMarketIntelligence({ source: { ...source, checked_at: refresh }, events: [refreshed, ...laterNews] });
  const crowdedArchive = db.prepare("SELECT * FROM market_events ORDER BY sequence").all();
  assert.equal(store.getActive().marketIntelligence.eventResponseReceivedAt[store.getActive().marketIntelligence.events.find((event) => event.kind === "NEWS").event_id], at, "NEWS projection retains its actual response receipt");
  assert.ok(store.getActive().marketIntelligence.currentEarnings.some((event) => event.event_id === scheduled.event_id), "current due earnings survive the 200 recent-event display cap");
  assert.equal(store.getActive().marketIntelligence.events.some((event) => event.event_id === scheduled.event_id), false, "ordinary TS event inputs retain the existing recent-event cap");
  store.importMarketIntelligence({ source: { ...source, checked_at: "2026-09-10T14:15:00.000Z" }, events: [] });
  assert.deepEqual(store.getActive().marketIntelligence.earningsCalendar.event_ids, [], "an absent or cancelled event is not current just because its archive survives");
  assert.deepEqual(db.prepare("SELECT * FROM market_events ORDER BY sequence").all(), crowdedArchive);
  store.importMarketIntelligence({ source: { ...source, checked_at: "2026-09-10T14:30:00.000Z", status: "DATA_BLOCKED", capabilities: { earnings_calendar: false } }, events: [] });
  assert.equal(store.getActive().marketIntelligence.earningsCalendar, null);
  db.prepare("UPDATE self_check_state SET state_value = ? WHERE state_key = 'paper_earnings_calendar_current'").run('{"checked_at":"not-a-time","event_ids":[1]}');
  assert.equal(store.getActive().marketIntelligence.earningsCalendar, null, "malformed replaceable metadata fails closed");
  assert.deepEqual(db.prepare("SELECT * FROM market_events ORDER BY sequence").all(), crowdedArchive);
});
