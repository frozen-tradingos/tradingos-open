import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { assessPaperContracts, assessPaperEntryConditions, assessPaperPlanEntryConditions, buildPaperPlan, PAPER_DAILY_TARGET, PAPER_ENTRY_QUALITY_START_AT, paperPlanId, paperReturnPct, paperExpiryClose, paperTrackingWindow, projectPaperTracking, validatePaperPlan, validatePaperEvent, projectPaperPlans, projectPaperLearning, paperMarkExitReason } from "../app/paper-plan.ts";
import { makePaperEvent, openPaperPlanStore } from "../server/paper-plan-store.ts";
import { buildEntrySpecialDays } from "../app/macro-event-learning.ts";

// Synthetic observations only. No providers, filesystem database, real fills or natural acceptance.
const at = "2026-09-10T13:45:00.000Z";
function evidence(symbol = "NVDA") {
  const frame = { timeframe: "1d", available: true, pattern: "higher low", state: "OBSERVED", direction: "BULLISH", confidence: 0.6, support: 90, resistance: 110, volume_context: "正常", data_cutoff: "2026-09-09T20:00:00.000Z", limitation: null };
  const contract = { contract_id: `${symbol.toLowerCase()}-call`, option_type: "call", expiration: "2026-10-09", strike: 110, bid: 2, ask: 2.1, mark: 2.05, volume: 100, open_interest: 200, iv: 0.3, delta: 0.5, gamma: 0.03, theta: -0.05, vega: 0.04, as_of: at, history_bars: 0, history_as_of: null,
    instrument: { chain_id: `${symbol.toLowerCase()}-chain`, chain_symbol: symbol, expiration_date: "2026-10-09", strike_price: 110, type: "call", state: "active", tradability: "tradable", trade_value_multiplier: 100 } };
  return { contract_version: "stock-plan-v2", evidence_id: "a".repeat(64), run_id: "paper-check:20260910T134500Z", slot_id: "paper-check:20260910T134500Z", source_mode: "LIVE", mode: "SHADOW", automated_execution: false, observed_at: at, received_at: at, source_snapshot_id: "old-a1", source_snapshot_hash: "b".repeat(64), symbol, instrument_type: "EQUITY", direction: "BULLISH",
    quote: { source: "ROBINHOOD", symbol, status: "LIVE", last: 105, bid: 104.9, ask: 105.1, as_of: at }, bars: { source: "ROBINHOOD", symbol, interval: "5min", as_of: null, values: [] }, pattern: null, contracts: [contract],
    account: { status: "DATA_BLOCKED" }, news: { status: "DATA_BLOCKED", items: [] }, global_risk: { critical_blockers: ["review blocked"], new_entry_blockers: [] }, data_gaps: ["No complete entry structure"], setup_gaps: ["Formal trigger not ready"],
    planning_context: { observed_at: "2026-09-09T20:01:00.000Z", entry_trigger: 106, invalidation_price: 90, target_price: 110, why_watch: ["Frozen higher lows"], timeframes: { daily: frame, four_hour: { ...frame, timeframe: "4h" }, one_hour: { ...frame, timeframe: "1h" }, thirty_minute: { ...frame, timeframe: "30m" } } } };
}

// Historical test origins deliberately bypass today's builder; old evidence is never re-qualified.
function legacyPlan(rows, stamp = at, ordinal = 1, events = []) {
  const e = rows[0], c = e.contracts[0], context = e.planning_context;
  const plan = { plan_id: paperPlanId(stamp.slice(0,10), ordinal), market_date: stamp.slice(0,10), created_at: stamp, expires_at: paperExpiryClose(c.expiration), symbol: e.symbol, direction: e.direction,
    contract: { contract_id:c.contract_id,chain_id:c.instrument.chain_id,expiration:c.expiration,strike:c.strike,option_type:c.option_type,multiplier:c.instrument.trade_value_multiplier },
    reference: {kind:'SIMULATED_REFERENCE',ask:c.ask,bid:c.bid,quoted_at:c.as_of,recorded_at:stamp,quantity:1},
    source:{evidence_id:e.evidence_id,snapshot_id:e.source_snapshot_id,snapshot_hash:e.source_snapshot_hash,observed_at:context.observed_at},
    why_watch:[...context.why_watch],warnings:['Historical synthetic baseline'],levels:{entry:context.entry_trigger,invalidation:context.invalidation_price,target:context.target_price},
    stop_loss_pct:events.length?-10:-40,take_profit_pct:events.length?10:30,...(events.length?{threshold_policy:{version:'SPECIAL_DAY_10_10_V1',events:structuredClone(events)}}:{}),mode:'SHADOW',automated_execution:false,executable:false,performance:'EXCLUDED'};
  validatePaperPlan(plan);return {plan,reasons:[]};
}
const qualifiedAt='2026-09-10T13:55:45.000Z';
function qualifiedEvidence(symbol='NVDA') {
  const e=evidence(symbol);e.entry_rule='MULTI_TIMEFRAME_BREAK_HOLD_V1';
  e.observed_at=e.received_at=e.quote.as_of=e.contracts[0].as_of=qualifiedAt;
  Object.assign(e.quote,{last:107,bid:106.99,ask:107.01});
  e.global_risk={checked_at:qualifiedAt,critical_blockers:[],new_entry_blockers:[]};
  e.pattern={source:'A2_CLASSIFY_PATTERN_V1',regime:'TREND_UP',direction:'bullish'};
  e.bars={source:'ROBINHOOD',symbol,interval:'5min',as_of:'2026-09-10T13:55:00.000Z',values:[[101,102,100,101.5],[102,103,101,102.5],[104,105.5,103,105],[105,107,104.5,106.5],[106.5,108,106,107]].map(([open,high,low,close],i)=>({begins_at:new Date(Date.parse('2026-09-10T13:30:00.000Z')+i*300000).toISOString(),open,high,low,close,volume:100}))};
  for(const [key,frame] of Object.entries(e.planning_context.timeframes)){frame.support=90;frame.resistance=106;frame.data_cutoff=key==='daily'?'2026-09-08T00:00:00Z':'2026-09-09T13:30:00Z';}
  return e;
}

test("entry conditions distinguish confirmation, invalidation, direction conflict and missing evidence without blocking research", () => {
  const e = qualifiedEvidence(), assessment = assessPaperEntryConditions(e, qualifiedAt);
  assert.equal(assessment.status, "CONFIRMED"); assert.ok(assessment.checks.every((row) => row.status === "PASS"));
  for (const [mutate, status, condition, result] of [
    [e => { e.quote.last = 89; }, "INVALIDATED", "INVALIDATION", "FAIL"],
    [e => { e.quote.last = 105; }, "NOT_CONFIRMED", "TRIGGER", "FAIL"],
    [e => { e.direction = "BEARISH"; }, "CONFLICT", "LEVELS", "CONFLICT"],
    [e => { e.bars.values = []; }, "DATA_GAP", "BARS", "UNKNOWN"],
    [e => { e.bars.values.splice(1, 1); }, "DATA_GAP", "BARS", "UNKNOWN"],
    [e => { e.bars.symbol = "SPY"; }, "DATA_GAP", "BARS", "UNKNOWN"],
    [e => { e.quote.as_of = "2026-09-10T13:40:00Z"; }, "DATA_GAP", "QUOTE", "STALE"],
    [e => { e.pattern = null; }, "DATA_GAP", "STRUCTURE", "UNKNOWN"],
    [e => { e.pattern.regime = "UNSUPPLIED_REGIME"; }, "DATA_GAP", "STRUCTURE", "UNKNOWN"],
    [e => { e.bars.values.at(-1).low = 105; }, "NOT_CONFIRMED", "STRUCTURE", "FAIL"],
  ]) {
    const row = structuredClone(e); mutate(row); const actual = assessPaperEntryConditions(row, qualifiedAt);
    assert.equal(actual.status, status); assert.equal(actual.checks.find((check) => check.condition === condition).status, result);
    if (status === "CONFLICT") assert.deepEqual(actual.levels, { entry: null, invalidation: null, target: null });
  }
  const missing = qualifiedEvidence(); missing.bars.values = []; missing.pattern = null;
  const plan = buildPaperPlan([missing], qualifiedAt).plan;
  assert.ok(plan); assert.equal(plan.entry_confirmation.status, "DATA_GAP");
  assert.equal(plan.stop_loss_pct, -40); assert.equal(plan.take_profit_pct, 30); assert.equal(plan.executable, false);
  const forged = structuredClone(plan); forged.entry_confirmation.status = "CONFIRMED";
  assert.throws(() => validatePaperPlan(forged), /逐项核验/);
});

test("later entry evidence is append-only, causal, same-symbol and never rewrites first PAPER result", () => {
  const e = qualifiedEvidence(); e.bars.values = []; e.pattern = null;
  const plan = buildPaperPlan([e], qualifiedAt).plan, original = JSON.stringify(plan), later = "2026-09-10T13:56:00.000Z", full = qualifiedEvidence();
  const market = { bars: full.bars, pattern: full.pattern, quote: { ...full.quote, as_of: later }, received_at: later, source_ref: "same-symbol-original-A1-A2" };
  const confirmed = assessPaperEntryConditions(plan.entry_policy.evidence, later, market);
  assert.equal(confirmed.status, "CONFIRMED");
  const event = mark(plan, later, 2.9); event.payload.entry_confirmation = confirmed;
  assert.doesNotThrow(() => validatePaperEvent(event, plan));
  const events = [makePaperEvent(plan.plan_id, plan.created_at, "CREATED", { plan }), event];
  assert.equal(projectPaperPlans(events, later).plans[0].latest_entry_confirmation.status, "CONFIRMED");
  assert.equal(projectPaperLearning(events).summary.wins, 1);
  const failed = structuredClone(event); failed.recorded_at = "2026-09-10T13:57:00.000Z"; failed.payload.quote.quoted_at = failed.recorded_at;
  failed.payload.entry_confirmation = assessPaperEntryConditions(plan.entry_policy.evidence, failed.recorded_at, { ...market, quote: { ...market.quote, last: 89, as_of: failed.recorded_at }, received_at: failed.recorded_at });
  assert.equal(failed.payload.entry_confirmation.status, "INVALIDATED"); assert.doesNotThrow(() => validatePaperEvent(failed, plan));
  assert.equal(JSON.stringify(plan), original); assert.equal(projectPaperLearning([...events, failed]).summary.wins, 1);
  for (const mutation of [{ received_at: "2026-09-10T14:00:00Z" }, { bars: { ...full.bars, symbol: "SPY" } }]) {
    const untrusted = assessPaperEntryConditions(plan.entry_policy.evidence, later, { ...market, ...mutation });
    assert.notEqual(untrusted.status, "CONFIRMED");
  }
  const nextDay = JSON.parse(JSON.stringify(market).replaceAll("2026-09-10", "2026-09-11"));
  const carried = assessPaperEntryConditions(plan.entry_policy.evidence, "2026-09-11T13:56:00.000Z", nextDay);
  assert.equal(carried.status, "CONFIRMED", "a 1–3 day plan retains its original valid levels while requiring new current-day Quote/Bar evidence");
  assert.deepEqual(carried.levels, confirmed.levels); assert.equal(JSON.stringify(plan), original);
  assert.equal(assessPaperEntryConditions(plan.entry_policy.evidence, "2026-09-11T13:56:00.000Z", { ...nextDay, quote: { ...nextDay.quote, last: 89 } }).status, "INVALIDATED", "today's quote still invalidates the original frozen level across days");
  assert.notEqual(assessPaperEntryConditions(plan.entry_policy.evidence, "2026-09-11T13:56:00.000Z", market).status, "CONFIRMED", "yesterday's current-price evidence still cannot confirm today");
});

test("Codex structured conditions freeze explicit cited values while old or null conditions remain unconfirmed", () => {
  const stamp = "2026-09-25T16:00:00Z", e = qualityEvidence("NVDA", stamp), entry = { evidence_ref: `entry:${"f".repeat(64)}`, entry: 106, invalidation: 90, target: 110 };
  e.contracts[0].contract_id = "00000000-0000-4000-8000-000000000001";
  const source = { version: "CODEX_PAPER_SELECTION_V2", kind: "CODEX", market_date: "2026-09-25", decision_id: "paper-selection:2026-09-25", requested_at: stamp, completed_at: stamp,
    reason: "synthetic exact conditions", input_hash: "a".repeat(64), input_snapshot_id: "snapshot", input_snapshot_hash: "b".repeat(64), invocation_id: "invocation", thread_id: "thread", model: "synthetic", cli_version: "synthetic", output_hash: "c".repeat(64),
    candidates: ["NVDA", "AAPL", "MSFT"].map((symbol, i) => ({ symbol, direction: "BULLISH", contract_id: `00000000-0000-4000-8000-00000000000${i + 1}`, reason: "synthetic", evidence_refs: [`stock:${symbol}`, `contract:00000000-0000-4000-8000-00000000000${i + 1}`, entry.evidence_ref], entry_conditions: entry })) };
  const plan = buildPaperPlan([e], stamp, 1, [], source).plan;
  assert.ok(plan); assert.deepEqual(plan.levels, { entry: 106, invalidation: 90, target: 110 });
  assert.equal(plan.entry_confirmation.scope, "CODEX_FROZEN_CONDITIONS_RESEARCH"); assert.equal(plan.entry_confirmation.status, "DATA_GAP");
  const forged = structuredClone(plan); forged.levels.entry = 107; assert.throws(() => validatePaperPlan(forged), /明确选择/);
  const noConditions = structuredClone(source); noConditions.candidates[0].entry_conditions = null;
  const unknown = buildPaperPlan([e], stamp, 1, [], noConditions).plan;
  assert.ok(unknown); assert.equal(unknown.entry_confirmation.checks.find((row) => row.condition === "LEVELS").status, "UNKNOWN");
  delete noConditions.candidates[0].entry_conditions;
  const legacy = buildPaperPlan([e], stamp, 1, [], noConditions).plan;
  assert.ok(legacy); assert.deepEqual(legacy.levels, { entry: null, invalidation: null, target: null });
  assert.equal(assessPaperEntryConditions(e, stamp, null, { ...entry, entry: 107 }).status, "CONFLICT", "a changed current context cannot silently replace original model conditions");
});

test("formal short-horizon comparison is causal, same-symbol, non-executable and cannot outlive its original window", () => {
  const at = "2026-10-01T14:00:45.000Z", e = qualityEvidence("SPY", at); e.planning_context.observed_at = "2026-09-30T20:00:00Z";
  const plan = buildPaperPlan([e], at).plan;
  const review = { assessed_at: at, status: "ALIGNED", context_status: "AVAILABLE", forecast_direction: "BULLISH", evidence_ref: "formal-ts:forecast-fixture:SPY",
    source: { forecast_id: "forecast-fixture", source_record_id: "live-shadow:20261001T140000Z:TS", forecast_hash: "f".repeat(64), observed_at: "2026-10-01T14:00:00Z", received_at: "2026-10-01T14:00:10Z", delivered_at: "2026-10-01T14:00:20Z",
      forecast_window: { horizon: "NEXT_30_TO_60_MINUTES", start_at: "2026-10-01T14:00:00Z", end_at: "2026-10-01T15:00:00Z", end_condition: "original" }, next_validation_at: "2026-10-01T14:30:00Z" } };
  plan.formal_forecast_review = structuredClone(review); assert.doesNotThrow(() => validatePaperPlan(plan)); assert.equal(plan.executable, false);
  for (const change of [r => { r.forecast_direction = "BEARISH"; }, r => { r.evidence_ref = "formal-ts:forecast-fixture:QQQ"; }, r => { r.source.delivered_at = "2026-10-01T14:01:00Z"; }, r => { r.source.next_validation_at = "2026-10-01T14:00:30Z"; }]) {
    const copy = structuredClone(plan); change(copy.formal_forecast_review); assert.throws(() => validatePaperPlan(copy));
  }
  const m = mark(plan, "2026-10-01T14:30:45Z", 2.2);
  m.payload.formal_forecast_review = { ...review, assessed_at: m.recorded_at, status: "UNAVAILABLE", context_status: "REVIEW_DUE", forecast_direction: null, evidence_ref: null };
  assert.doesNotThrow(() => validatePaperEvent(m, plan));
  assert.equal(projectPaperPlans([makePaperEvent(plan.plan_id, at, "CREATED", { plan }), m]).plans[0].latest_formal_forecast_review.context_status, "REVIEW_DUE");
  const equity = qualityEvidence("NVDA", at); equity.planning_context.observed_at = e.planning_context.observed_at;
  const stockPlan = buildPaperPlan([equity], at, 2).plan; stockPlan.formal_forecast_review = review;
  assert.throws(() => validatePaperPlan(stockPlan), /同指数/);
});

test("next-session background stays separate, causal and limited to its first target session without rewriting old origins", () => {
  const at = "2026-10-01T14:00:45.000Z", e = qualityEvidence("SPY", at); e.planning_context.observed_at = "2026-09-30T20:00:00Z";
  const plan = buildPaperPlan([e], at).plan, original = JSON.stringify(plan);
  const review = { scope: "NEXT_SESSION_BACKGROUND", assessed_at: at, status: "CONFLICT", context_status: "AVAILABLE", forecast_direction: "BEARISH", evidence_ref: "next-session-ts:night-fixture:SPY", summary: "原隔夜观点：压力位未突破，先观察回落。",
    source: { forecast_id: "night-fixture", source_record_id: "live-shadow:20261001T010000Z:TS", forecast_hash: "e".repeat(64), observed_at: "2026-10-01T01:00:00Z", received_at: "2026-10-01T01:00:10Z", delivered_at: "2026-10-01T01:00:20Z",
      forecast_window: { horizon: "NEXT_REGULAR_SESSION", start_at: "2026-10-01T01:00:00Z", end_at: null, end_condition: "NEXT_REGULAR_SESSION_CLOSE" }, next_validation_at: "2026-10-01T13:30:00Z" } };
  const frozen = structuredClone(plan); frozen.next_session_forecast_review = structuredClone(review);
  assert.doesNotThrow(() => validatePaperPlan(frozen), "06:30 review checkpoint does not expire a separately labelled daily background");
  frozen.next_session_forecast_review.source.forecast_window = { ...review.source.forecast_window, horizon: "NEXT_REGULAR_SESSION_AND_WEEK", end_condition: "NEXT_FIVE_REGULAR_SESSIONS_CLOSE" };
  assert.doesNotThrow(() => validatePaperPlan(frozen), "a weekend contract only supplies its first target day as background");
  const lateNight = structuredClone(review);
  Object.assign(lateNight.source, { source_record_id: "live-shadow:20261001T043000Z:TS", observed_at: "2026-10-01T04:30:00Z", received_at: "2026-10-01T04:30:10Z", delivered_at: "2026-10-01T04:30:20Z" });
  lateNight.source.forecast_window.start_at = lateNight.source.observed_at;
  const lateNightPlan = { ...plan, next_session_forecast_review: lateNight };
  assert.doesNotThrow(() => validatePaperPlan(lateNightPlan), "21:30 PT is still the prior local date, even after NYSE's overnight date rolls forward");
  const wrongDay = mark(plan, "2026-10-02T14:00:45Z", 2.2);
  wrongDay.payload.next_session_forecast_review = { ...lateNight, assessed_at: wrongDay.recorded_at };
  assert.throws(() => validatePaperEvent(wrongDay, plan), /原期限/, "the late-night background cannot remain AVAILABLE one target session later");
  for (const change of [r => { delete r.scope; }, r => { r.evidence_ref = "next-session-ts:night-fixture:QQQ"; }, r => { r.source.delivered_at = "2026-10-01T14:01:00Z"; },
    r => { r.source.observed_at = "2026-09-30T01:00:00Z"; }, r => { r.source.forecast_window.horizon = "NEXT_30_TO_60_MINUTES"; }, r => { r.source.forecast_window.start_at = "2026-10-01T15:00:00Z"; },
    r => { r.source.forecast_window.end_at = "2026-10-01T13:59:00Z"; }, r => { r.source.forecast_window.end_condition = "guessed close"; }, r => { r.summary = "x".repeat(4001); }, r => { r.summary = ""; }]) {
    const copy = structuredClone(plan); copy.next_session_forecast_review = structuredClone(review); change(copy.next_session_forecast_review); assert.throws(() => validatePaperPlan(copy));
  }
  const mixed = structuredClone(plan); mixed.formal_forecast_review = review; assert.throws(() => validatePaperPlan(mixed), /必须分开/);
  const later = mark(plan, "2026-10-01T14:30:45Z", 2.9); later.payload.next_session_forecast_review = { ...review, assessed_at: later.recorded_at };
  const created = makePaperEvent(plan.plan_id, plan.created_at, "CREATED", { plan }), events = [created, later];
  assert.doesNotThrow(() => validatePaperEvent(later, plan));
  assert.equal(projectPaperPlans(events, at).plans[0].latest_next_session_forecast_review, undefined, "a future MARK is not current background");
  const view = projectPaperPlans(events, later.recorded_at).plans[0];
  assert.equal(view.latest_next_session_forecast_review.status, "CONFLICT"); assert.equal(view.latest_formal_forecast_review, undefined);
  assert.equal(JSON.stringify(plan), original); assert.equal(plan.next_session_forecast_review, undefined, "late reads never backfill CREATED");
  assert.equal(projectPaperLearning(events).summary.wins, 1);
  const expired = mark(plan, "2026-10-02T14:00:45Z", 2.2);
  expired.payload.next_session_forecast_review = { ...review, assessed_at: expired.recorded_at, status: "UNAVAILABLE", context_status: "EXPIRED", forecast_direction: null, evidence_ref: null }; delete expired.payload.next_session_forecast_review.summary;
  assert.doesNotThrow(() => validatePaperEvent(expired, plan), "stale original evidence may explain an unavailable background without a direction");
  const equity = qualityEvidence("NVDA", at); equity.planning_context.observed_at = e.planning_context.observed_at;
  const stock = buildPaperPlan([equity], at, 2).plan; stock.next_session_forecast_review = review; assert.throws(() => validatePaperPlan(stock), /同指数/);
  const db = new DatabaseSync(":memory:"), store = openPaperPlanStore(db); store.append(created); store.append(makePaperEvent(later.plan_id, later.recorded_at, "MARK", later.payload)); assert.equal(JSON.stringify(store.eventsForPlan(plan.plan_id)[0]), JSON.stringify(created)); db.close();
});

function mark(plan, time, bid) {
  return makePaperEvent(plan.plan_id, time, "MARK", { quote: { source: "ROBINHOOD", contract_id: plan.contract.contract_id, symbol: plan.symbol, expiration: plan.contract.expiration, strike: plan.contract.strike, option_type: plan.contract.option_type, bid, ask: Math.max(bid + 0.1, 0.1), quoted_at: time }, estimated_return_pct: paperReturnPct(plan, bid) });
}

test("tracking windows preserve local clock across DST, count three exchange sessions and respect early expiration", () => {
  const plan = legacyPlan([evidence()]).plan;
  for (const [created_at, expected] of [["2026-10-30T13:45:12.345Z", "2026-11-06T14:45:12.345Z"], ["2026-03-06T14:45:12.345Z", "2026-03-13T13:45:12.345Z"]]) {
    const window = paperTrackingWindow({ ...plan, created_at, market_date: created_at.slice(0, 10), expires_at: "2027-01-15T21:00:00.000Z" });
    assert.equal(window.ends_at, expected, "seven calendar dates preserve PT time, not a fixed 168 UTC hours");
  }
  const holiday = { ...plan, created_at: "2026-09-04T13:45:00.000Z", market_date: "2026-09-04" };
  assert.equal(paperTrackingWindow(holiday).focus_ends_at, "2026-09-09T20:00:00.000Z", "Labor Day and weekend do not count as sessions");
  const early = { ...plan, created_at: "2026-11-25T14:45:00.000Z", market_date: "2026-11-25", expires_at: "2026-11-27T18:00:00.000Z" };
  assert.equal(paperTrackingWindow(early).ends_at, early.expires_at);
  assert.equal(projectPaperTracking(early, [], "2026-11-27T18:00:00.000Z").reason, "EXPIRATION");
});

test("window research retains first append order and deadline evidence through SQL compaction without rewriting historical results", () => {
  for (const reverse of [false, true]) {
    const db = new DatabaseSync(":memory:"), store = openPaperPlanStore(db), plan = legacyPlan([evidence()]).plan;
    try {
      store.append(makePaperEvent(plan.plan_id, at, "CREATED", { plan }));
      const stamp = "2026-09-10T14:00:00.000Z";
      for (const [i, bid] of (reverse ? [3, 1] : [1, 3]).entries()) {
        const event = mark(plan, stamp, bid); event.payload.quote.quoted_at = `2026-09-10T13:59:${i ? "45" : "30"}.000Z`;
        store.append(makePaperEvent(plan.plan_id, stamp, "MARK", event.payload));
      }
      store.append(makePaperEvent(plan.plan_id, "2026-09-11T14:00:00.000Z", "GAP", { reasons: ["SYNTHETIC_MISSING_QUOTE"] }));
      store.append(mark(plan, "2026-09-16T14:00:00.000Z", 2.2));
      store.append(mark(plan, "2026-09-18T14:00:00.000Z", 20));
      const prior = structuredClone(store.learning()), rows = db.prepare("SELECT * FROM paper_plan_events ORDER BY sequence").all();
      const window = paperTrackingWindow(plan), ending = makePaperEvent(plan.plan_id, "2026-09-18T14:01:00.000Z", "ENDED", { reason: "OBSERVATION_WINDOW", policy: window.policy, ended_at: window.ends_at, terminal_value: "UNKNOWN" });
      store.append(ending);
      const full = projectPaperPlans(store.eventsForPlan(plan.plan_id), ending.recorded_at).plans[0], compact = projectPaperPlans(store.recentEvents(), ending.recorded_at).plans[0];
      assert.deepEqual(compact.window_research, full.window_research); assert.equal(compact.status, "ARCHIVED");
      assert.equal(compact.window_research.best_return_pct, paperReturnPct(plan, 3), "the later 20-dollar quote is outside the seven-day window");
      assert.equal(compact.window_research.gap_observed, true);
      assert.equal(compact.window_research.recovery_after_loss?.bid ?? null, reverse ? null : 3);
      assert.equal(compact.window_research.target_after_loss?.bid ?? null, reverse ? null : 3);
      assert.deepEqual(store.learning().recent_results, prior.recent_results);
      assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events WHERE event_type != 'ENDED' ORDER BY sequence").all(), rows);
      assert.throws(() => store.append(mark(plan, "2026-09-18T14:02:00.000Z", 2)), /观察期已结束/);
    } finally { db.close(); }
  }
  const db = new DatabaseSync(":memory:"), store = openPaperPlanStore(db), plan = legacyPlan([evidence()]).plan;
  try {
    store.append(makePaperEvent(plan.plan_id, at, "CREATED", { plan }));
    store.append(mark(plan, "2026-09-18T14:00:00.000Z", 3));
    const window = paperTrackingWindow(plan), atEnd = "2026-09-18T14:01:00.000Z";
    store.append(makePaperEvent(plan.plan_id, atEnd, "ENDED", { reason: "OBSERVATION_WINDOW", policy: window.policy, ended_at: window.ends_at, terminal_value: "UNKNOWN" }));
    assert.equal(store.learning().summary.wins, 1, "a historical first WIN beyond seven days is retained, never rewritten by the new sampling limit");
    assert.equal(projectPaperPlans(store.recentEvents(), atEnd).plans[0].window_research.best_return_pct, null);
  } finally { db.close(); }
});
function riskMark(plan, stamp, bid, overrides = {}) {
  const event = mark(plan, stamp, bid);
  return makePaperEvent(plan.plan_id, stamp, "MARK", { ...event.payload, risk_exit: {
    rule_version: "PAPER_RISK_EXIT_V1", reason: "EARNINGS_WINDOW", decision_at: stamp,
    event_id: "synthetic-earnings-event", title: `${plan.symbol} earnings calendar`, source: "Finnhub Earnings Calendar", source_url: null,
    published_at: null, scheduled_for: "2026-09-25", session: "BMO", source_observed_at: stamp, source_checked_at: stamp, scope: plan.symbol, ...overrides,
  } });
}

const specialDay = { market_date: "2026-09-10", label: "FOMC 议息日", release_name: "FOMC Meeting Decision", scheduled_at: "2026-09-10T12:00:00Z", time_precision: "DATE_ONLY", confidence: "official_schedule",
  source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", source_record_id: "live-shadow:20260909T200000Z:A1", observed_at: "2026-09-09T20:00:00Z", received_at: "2026-09-09T20:00:20Z", as_of: "2026-09-09T20:00:00Z" };

function qualityEvidence(symbol = "NVDA", stamp = PAPER_ENTRY_QUALITY_START_AT) {
  const e = evidence(symbol);
  e.observed_at = e.received_at = e.quote.as_of = e.contracts[0].as_of = stamp;
  e.planning_context.observed_at = "2026-09-24T20:00:00Z";
  return e;
}

test("new liquidity gate rejects wide/unknown/zero-bid contracts without rejecting genuine zero opening volume or rewriting legacy", () => {
  const events = [{ ...specialDay, market_date: "2026-09-25", scheduled_at: "2026-09-25T12:00:00Z", observed_at: "2026-09-24T20:00:00Z", received_at: "2026-09-24T20:00:20Z", as_of: "2026-09-24T20:00:00Z" }];
  for (const days of [[], events]) {
    for (const [change, allowed] of [[{bid:1.95,ask:2.05},true],[{bid:1.949,ask:2.05},false],[{bid:3,ask:3.15},true],[{bid:3,ask:3.1501},false],[{bid:0},false],[{open_interest:0},false],[{open_interest:null},false],[{volume:null},false],[{volume:-1},false],[{volume:0},true],[{delta:null},false]]) {
      const e = qualityEvidence(); Object.assign(e.contracts[0], change);
      const result = buildPaperPlan([e], PAPER_ENTRY_QUALITY_START_AT, 1, days);
      assert.equal(Boolean(result.plan),allowed,JSON.stringify({change,days:days.length,reasons:result.reasons}));
      if (result.plan) {
        assert.equal(result.plan.entry_policy.quality_version,"PAPER_LIQUIDITY_V1");
        const forged = structuredClone(result.plan); delete forged.entry_policy.quality_version;
        assert.throws(()=>validatePaperPlan(forged),/质量版本/);
      }
    }
  }
  const stamp = "2026-09-25T15:57:59.000Z", old = qualityEvidence("HUBB",stamp); Object.assign(old.contracts[0],{bid:10.3,ask:17,volume:0,open_interest:1});
  const plan = buildPaperPlan([old],stamp).plan, original = JSON.stringify(plan);
  assert.ok(plan); assert.equal(plan.entry_policy.quality_version,undefined); assert.doesNotThrow(()=>validatePaperPlan(plan)); assert.equal(JSON.stringify(plan),original);
});

test("Owner void appends a terminal annotation, preserves the first loss, and requires all originals voided before a distinct reselection", () => {
  const db = new DatabaseSync(":memory:"), store = openPaperPlanStore(db);
  try {
    const stamp="2026-09-25T13:45:00Z", originals=["DDOG","NET","BWXT"].map((symbol,i)=>buildPaperPlan([qualityEvidence(symbol,stamp)],stamp,i+1).plan);
    for(const plan of originals)store.append(makePaperEvent(plan.plan_id,stamp,"CREATED",{plan}));
    const loss=mark(originals[0],"2026-09-25T14:00:00Z",1); store.append(loss);
    const before=store.learning().recent_results.find(r=>r.plan_id===originals[0].plan_id), originalBytes=JSON.stringify(store.eventsForPlan(originals[0].plan_id));
    const request={request_id:"quality-20260925-01",requested_at:PAPER_ENTRY_QUALITY_START_AT,reason:"Owner requested fresh research after quote-quality failure",replaces_plan_ids:originals.map(p=>p.plan_id)};
    const at="2026-09-25T16:00:00Z", source={version:"CODEX_PAPER_SELECTION_V2",kind:"RULE_FALLBACK",market_date:"2026-09-25",decision_id:`paper-selection:2026-09-25:owner-reselect:${request.request_id}`,requested_at:at,completed_at:at,reason:"Synthetic source",input_hash:"a".repeat(64),input_snapshot_id:"synthetic",input_snapshot_hash:"b".repeat(64),invocation_id:null,thread_id:null,model:null,cli_version:null,output_hash:null,candidates:[],owner_reselection:request};
    const replacement=buildPaperPlan([qualityEvidence("MSFT",at)],at,1,[],source,request).plan;
    assert.ok(replacement); assert.equal(replacement.plan_id,`${originals[0].plan_id}:reselect:${request.request_id}`);
    assert.throws(()=>store.append(makePaperEvent(replacement.plan_id,at,"CREATED",{plan:replacement})),/作废全部/);
    for(const plan of originals) {
      const ended=makePaperEvent(plan.plan_id,"2026-09-25T15:59:00Z","ENDED",{reason:"OWNER_VOID",ended_at:"2026-09-25T15:59:00Z",terminal_value:"UNKNOWN",detail:"Quote liquidity unsuitable",owner_request_ref:request.request_id});
      assert.throws(()=>store.append(makePaperEvent(plan.plan_id,ended.recorded_at,"ENDED",{...ended.payload,owner_request_ref:""})),/授权来源/);
      store.append(ended); assert.equal(store.append(ended).duplicate,true);
      assert.throws(()=>store.append(mark(plan,at,3)),/已作废/);
    }
    assert.equal(store.activePlans().length,0);
    assert.equal(JSON.stringify(store.eventsForPlan(originals[0].plan_id).slice(0,-1)),originalBytes);
    const learning=store.learning(), after=learning.recent_results.find(r=>r.plan_id===originals[0].plan_id);
    const {owner_void,...preserved}=after; assert.deepEqual(preserved,before); assert.equal(owner_void.detail,"Quote liquidity unsuitable");
    assert.equal(learning.summary.losses,1); assert.equal(learning.summary.voided,3); assert.equal(learning.eligible_summary.total,0);
    assert.equal(learning.recent_results.find(r=>r.plan_id===originals[1].plan_id).status,"PENDING","void does not invent an expiry or a loss");
    assert.ok(projectPaperPlans(store.recentEvents()).plans.every(row=>row.status==="VOIDED"&&row.owner_void));
    const missing=structuredClone(replacement); delete missing.owner_reselection; assert.throws(()=>validatePaperPlan(missing),/授权来源/);
    const mismatched=structuredClone(replacement); mismatched.owner_reselection.request_id="different"; assert.throws(()=>validatePaperPlan(mismatched),/重选单/);
    const unrelatedRequest={...request,request_id:"unrelated-owner-request"}, unrelatedSource={...source,owner_reselection:unrelatedRequest,decision_id:`paper-selection:2026-09-25:owner-reselect:${unrelatedRequest.request_id}`};
    const unrelated=buildPaperPlan([qualityEvidence("MSFT",at)],at,1,[],unrelatedSource,unrelatedRequest).plan;
    assert.ok(unrelated); assert.throws(()=>store.append(makePaperEvent(unrelated.plan_id,at,"CREATED",{plan:unrelated})),/作废授权不一致/);
    assert.equal(store.eventsForPlan(unrelated.plan_id).length,0,"a separate request cannot reuse another request's void authorization");
    store.append(makePaperEvent(replacement.plan_id,at,"CREATED",{plan:replacement})); assert.equal(store.activePlans().length,1);
    assert.equal(store.learning().eligible_summary.total,1); assert.equal(store.learning().summary.total,4);
    assert.deepEqual(store.learning(),projectPaperLearning([...originals,replacement].flatMap(p=>store.eventsForPlan(p.plan_id))));
  } finally {db.close();}
});

test("restored baseline freezes special-day thresholds without imposing later ordinary-day cost gates", () => {
  const e=qualifiedEvidence(), inputs=[structuredClone(specialDay)], before=structuredClone(inputs);
  const {plan,reasons}=buildPaperPlan([e],qualifiedAt,1,inputs);assert.ok(plan,reasons.join(';'));
  assert.deepEqual(plan.threshold_policy,{version:'SPECIAL_DAY_10_10_V1',events:before});
  assert.equal(plan.entry_policy.version,'BASELINE_PAPER_RESEARCH_V1');
  assert.deepEqual(plan.holding_intent,{min_trading_days:1,max_trading_days:3,time_exit:'REVIEW_ONLY'});
  inputs[0].label='external change';e.bars.values[0].close=999;assert.equal(plan.entry_policy.evidence.bars.values[0].close,101.5);assert.deepEqual(plan.threshold_policy.events,before);
  assert.equal(plan.contract.expiration,'2026-10-09');assert.equal(plan.expires_at,paperExpiryClose('2026-10-09'));
  for(const change of [{stop_loss_pct:-40},{take_profit_pct:30},{threshold_policy:undefined},{entry_policy:{...plan.entry_policy,version:'UNKNOWN'}},{holding_intent:undefined},{holding_intent:{...plan.holding_intent,time_exit:'AUTO_EXIT'}}])assert.throws(()=>validatePaperPlan({...plan,...change}));
  assert.equal(buildPaperPlan([qualifiedEvidence()],qualifiedAt,1,[{...specialDay,received_at:'2026-09-10T14:00:00Z'}]).plan,null);
  const ordinary=buildPaperPlan([qualifiedEvidence()],qualifiedAt).plan;assert.equal(ordinary.take_profit_pct,30);assert.equal(ordinary.stop_loss_pct,-40);
  for(const [bid,ask,accepted] of [[1.95,2.05,true],[1.949,2.05,false],[1.9499999,2.05,false],[3,3.15,true],[3,3.16,false],[.09,.15,false]])for(const days of [[],[specialDay]]){
    const q=qualifiedEvidence();Object.assign(q.contracts[0],{bid,ask});const result=buildPaperPlan([q],qualifiedAt,1,days);
    assert.equal(Boolean(result.plan),!days.length || (bid / ask - 1) * 100 > -10,JSON.stringify({bid,ask,days}));
    if (result.plan) {
      const prior = structuredClone(result.plan); prior.entry_policy.version = 'DAILY_PAPER_RESEARCH_V1';
      if (accepted) assert.doesNotThrow(() => validatePaperPlan(prior)); else assert.throws(() => validatePaperPlan(prior), undefined, 'historical daily cost gate stays strict');
    }
  }
  const wide=qualifiedEvidence();wide.contracts[0].bid=1.8;wide.contracts[0].ask=2;
  wide.contracts.push({...wide.contracts[0],contract_id:'qualifying-contract',bid:1.95});
  assert.equal(buildPaperPlan([wide],qualifiedAt,1,[specialDay]).plan.contract.contract_id,'qualifying-contract');
});

test("reviewed scheduled events freeze Sep 18 PAPER thresholds before the first natural A1 completes", () => {
  const stamp = "2026-09-18T13:30:45Z", e = evidence(), days = buildEntrySpecialDays(undefined, stamp);
  e.observed_at = e.received_at = e.quote.as_of = e.contracts[0].as_of = stamp;
  e.planning_context.observed_at = "2026-09-17T20:00:00Z";
  const { plan, reasons } = buildPaperPlan([e], stamp, 1, days);
  assert.ok(plan, reasons.join(";"));
  assert.equal(plan.take_profit_pct, 10); assert.equal(plan.stop_loss_pct, -10);
  assert.equal(plan.entry_policy.version, "BASELINE_PAPER_RESEARCH_V1");
  assert.deepEqual(plan.threshold_policy.events, days);
  assert.doesNotThrow(() => validatePaperPlan(plan));
  e.contracts[0].bid = 1.8; e.contracts[0].ask = 2;
  assert.equal(buildPaperPlan([e], stamp, 1, days).plan, null, "special-day spread loss at 10 percent remains rejected");
  assert.ok(buildPaperPlan([e], stamp).plan, "ordinary baseline itself remains unchanged");
});

test("reviewed Sep 21 PAPER uses special thresholds without changing Tuesday or accepting backdated receipt", () => {
  const stamp = "2026-09-21T13:30:45Z", e = evidence(), days = buildEntrySpecialDays(undefined, stamp);
  e.observed_at = e.received_at = e.quote.as_of = e.contracts[0].as_of = stamp;
  e.planning_context.observed_at = "2026-09-18T20:00:00Z";
  const { plan, reasons } = buildPaperPlan([e], stamp, 1, days);
  assert.ok(plan, reasons.join(";"));
  assert.equal(plan.take_profit_pct, 10); assert.equal(plan.stop_loss_pct, -10);
  assert.deepEqual(plan.threshold_policy.events, days);
  assert.doesNotThrow(() => validatePaperPlan(plan));
  for (const received_at of ["2026-09-18T06:58:58.033Z", "2026-09-21T14:00:00Z"]) assert.equal(buildPaperPlan([e], stamp, 1, [{ ...days[0], received_at }]).plan, null, "reviewed receipt may be neither backdated nor later than entry");
  e.observed_at = e.received_at = e.quote.as_of = e.contracts[0].as_of = "2026-09-22T13:30:45Z";
  e.planning_context.observed_at = "2026-09-21T20:00:00Z";
  const ordinary = buildPaperPlan([e], e.received_at, 1, days).plan;
  assert.ok(ordinary);
  assert.equal(ordinary.take_profit_pct, 30); assert.equal(ordinary.stop_loss_pct, -40);
  assert.equal(ordinary.threshold_policy, undefined, "Monday's known facts do not impose Tuesday thresholds");
});

test("mixed immutable rules settle on each first threshold crossing even after a later reversal and restart", () => {
  const db = new DatabaseSync(":memory:"), store = openPaperPlanStore(db);
  try {
    const plans = [legacyPlan([evidence()], at).plan, legacyPlan([evidence("AAPL")], at, 2, [specialDay]).plan, legacyPlan([evidence("TSLA")], at, 3, [specialDay]).plan];
    for (const plan of plans) store.append(makePaperEvent(plan.plan_id, at, "CREATED", { plan }));
    const origins = db.prepare("SELECT * FROM paper_plan_events WHERE event_type='CREATED' ORDER BY sequence").all();
    for (const [index, bid] of [[0, 2.31], [1, 2.31], [2, 1.89]]) store.append(mark(plans[index], "2026-09-10T13:46:00Z", bid));
    const first = store.learning();
    assert.equal(first.recent_results.find((row) => row.plan_id === plans[0].plan_id).status, "PENDING", "legacy +10% is not a +30% exit");
    for (const [index, bid] of [[0, 1.89], [1, 1.89], [2, 2.31]]) store.append(mark(plans[index], "2026-09-10T13:47:00Z", bid));
    for (const plan of plans) store.append(mark(plan, "2026-09-10T13:48:00Z", 2.1));
    const reopened = openPaperPlanStore(db, { readOnly: true }), learning = reopened.learning();
    assert.deepEqual(learning.recent_results, first.recent_results, "first ±10% exits survive reversal and SQL compaction; legacy stays pending");
    assert.equal(learning.rule, "FIRST_OBSERVED_PLAN_THRESHOLDS_OR_RISK_EXIT_V3");
    assert.deepEqual(learning.groups.filter((row) => row.dimension === "RISK_POLICY").map((row) => [row.label, row.stats.total]), [["常规规则 +30% / -40%", 1], ["特殊日规则 +10% / -10%", 2]]);
    const views = projectPaperPlans(reopened.recentEvents()).plans;
    for (const plan of plans.slice(1)) {
      const view = views.find((row) => row.plan.plan_id === plan.plan_id);
      assert.equal(view.stop_observed, true); assert.equal(view.take_profit_observed, true);
    }
    assert.equal(views.find((row) => row.plan.plan_id === plans[0].plan_id).stop_observed, false);
    assert.equal(views.find((row) => row.plan.plan_id === plans[0].plan_id).take_profit_observed, false);
    store.append(mark(plans[0], "2026-09-10T13:49:00Z", 2.73));
    assert.equal(store.learning().recent_results.find((row) => row.plan_id === plans[0].plan_id).return_pct, 30);
    assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events WHERE event_type='CREATED' ORDER BY sequence").all(), origins);
  } finally { db.close(); }
});

test("restored baseline preserves quote trust and old entry validators without adding formal setup gates", () => {
  const e=qualifiedEvidence(), accepted=buildPaperPlan([e],qualifiedAt);assert.ok(accepted.plan,accepted.reasons.join(';'));
  const priorQualified=structuredClone(accepted.plan);priorQualified.entry_policy.version='QUALIFIED_PAPER_ENTRY_V1';assert.doesNotThrow(()=>validatePaperPlan(priorQualified),'previous qualified records retain their original validator');
  assert.equal(accepted.plan.executable,false);assert.equal(accepted.plan.performance,'EXCLUDED');assert.match(accepted.plan.warnings.join(';'),/账户风险/);
  for(const [name,mutate] of [
    ['not-triggered',v=>{v.bars.values[3].close=105.5;}],['invalidated',v=>{v.quote.last=90;}],['lost-hold',v=>{v.quote.last=105.9;}],
    ['wrong-target',v=>{v.planning_context.target_price=100;}],['wrong-direction',v=>{v.pattern.direction='bearish';}],['incomplete-frame',v=>{v.planning_context.timeframes.daily.available=false;}],
    ['missing-bars',v=>{v.bars.values=[];}],['future-bar',v=>{v.bars.values.at(-1).begins_at='2026-09-10T13:55:00Z';}],['old-bars',v=>{v.bars.as_of='2026-09-09T20:00:00Z';}],['missing-middle-bar',v=>{v.bars.values.splice(1,1);} ],
    ['global-block',v=>{v.global_risk.new_entry_blockers=['official event window'];}],['critical',v=>{v.global_risk.critical_blockers=['trust failed'];}],['stale-risk',v=>{v.global_risk.checked_at='2026-09-09T20:00:00Z';}],
  ]){const research=structuredClone(e);mutate(research);const result=buildPaperPlan([research],qualifiedAt);assert.ok(result.plan,`${name}: ${result.reasons.join(';')}`);assert.equal(result.plan.entry_policy.version,'BASELINE_PAPER_RESEARCH_V1');
    const prior=structuredClone(result.plan);prior.entry_policy.version='QUALIFIED_PAPER_ENTRY_V1';assert.throws(()=>validatePaperPlan(prior),undefined,`old qualified validation preserved: ${name}`);
  }
  for(const [name,mutate] of [
    ['stale-equity',v=>{v.quote.as_of='2026-09-09T20:00:00Z';}],['future-equity',v=>{v.quote.as_of='2026-09-10T13:56:00Z';}],
    ['no-direction-evidence',v=>{for(const frame of Object.values(v.planning_context.timeframes))frame.direction='RANGE';}],['future-analysis',v=>{v.planning_context.observed_at='2026-09-10T13:56:00Z';}],
    ['stale-option',v=>{v.contracts[0].as_of='2026-09-10T13:52:59Z';}],['future-option',v=>{v.contracts[0].as_of='2026-09-10T13:56:00Z';}],
    ['short-DTE',v=>{v.contracts[0].expiration=v.contracts[0].instrument.expiration_date='2026-09-11';}],['long-DTE',v=>{v.contracts[0].expiration=v.contracts[0].instrument.expiration_date='2026-12-18';}],
  ]){const bad=structuredClone(e);mutate(bad);assert.equal(buildPaperPlan([bad],qualifiedAt).plan,null,name);}
  for (const mutate of [v=>{v.quote.bid=0;},v=>{v.contracts[0].open_interest=null;},v=>{v.contracts[0].open_interest=0;},v=>{v.contracts[0].volume=null;},v=>{v.contracts[0].delta=null;}]) {
    const restored=structuredClone(e);mutate(restored);const result=buildPaperPlan([restored],qualifiedAt);
    assert.ok(result.plan,result.reasons.join(';'));
    const prior=structuredClone(result.plan);prior.entry_policy.version='DAILY_PAPER_RESEARCH_V1';
    assert.throws(()=>validatePaperPlan(prior),undefined,'prior daily schema is not weakened by restored baseline');
  }
  const bearish=structuredClone(e);bearish.direction='BEARISH';bearish.pattern={source:'A2_CLASSIFY_PATTERN_V1',regime:'TREND_DOWN',direction:'bearish'};
  for(const frame of Object.values(bearish.planning_context.timeframes)){frame.direction='BEARISH';frame.support=106;frame.resistance=122;}
  Object.assign(bearish.planning_context,{entry_trigger:106,invalidation_price:122,target_price:100});Object.assign(bearish.quote,{last:105,bid:104.99,ask:105.01});
  for(const bar of bearish.bars.values){const old={...bar};Object.assign(bar,{open:212-old.open,high:212-old.low,low:212-old.high,close:212-old.close});}
  bearish.contracts[0].option_type=bearish.contracts[0].instrument.type='put';assert.ok(buildPaperPlan([bearish],qualifiedAt).plan);
  const early=structuredClone(e);early.observed_at=early.received_at=early.quote.as_of=early.contracts[0].as_of='2026-09-10T13:30:45Z';early.bars.values=[];early.bars.as_of=null;
  const opening=buildPaperPlan([early],early.received_at);assert.ok(opening.plan,opening.reasons.join(';'));
  assert.equal(opening.plan.entry_policy.version,'BASELINE_PAPER_RESEARCH_V1');
  const beforeConfirmation=structuredClone(e);beforeConfirmation.contracts[0].as_of='2026-09-10T13:54:59Z';assert.ok(buildPaperPlan([beforeConfirmation],qualifiedAt).plan,'fresh quote does not require a formal breakout before daily research');
  const badCall=structuredClone(e);badCall.contracts[0].as_of='2026-09-09T20:00:00Z';
  assert.equal(buildPaperPlan([badCall,bearish],qualifiedAt).plan.contract.option_type,'put','a rejected call does not end evaluation of a real bearish candidate');
});

test("fallback skips two opposed intraday frames without flipping direction or invalidating history", () => {
  for (const direction of ["BULLISH", "BEARISH"]) {
    const e = qualifiedEvidence(), opposite = direction === "BULLISH" ? "BEARISH" : "BULLISH";
    e.direction = direction;
    e.contracts[0].option_type = e.contracts[0].instrument.type = direction === "BULLISH" ? "call" : "put";
    for (const frame of Object.values(e.planning_context.timeframes)) frame.direction = direction;
    const old = buildPaperPlan([e], qualifiedAt).plan;
    for (const key of ["one_hour", "thirty_minute"]) {
      e.planning_context.timeframes[key].direction = opposite;
      old.entry_policy.evidence.planning_context.timeframes[key].direction = opposite;
    }
    old.entry_confirmation = assessPaperPlanEntryConditions(old, qualifiedAt);
    const saved = structuredClone(old), rejected = buildPaperPlan([e], qualifiedAt);
    assert.equal(rejected.plan, null); assert.match(rejected.reasons.join(), /FALLBACK_DIRECTION_CONFLICT/);
    assert.equal(buildPaperPlan([e, qualifiedEvidence("AAPL")], qualifiedAt).plan.symbol, "AAPL");
    assert.equal(assessPaperContracts(e, qualifiedAt, [], true).contracts.length, 1, "independent Codex and preflight directions remain available");
    assert.doesNotThrow(() => validatePaperPlan(old)); assert.deepEqual(old, saved);
    for (const change of [{ available: false }, { direction: "RANGE" }, { direction }]) {
      const mixed = structuredClone(e); Object.assign(mixed.planning_context.timeframes.one_hour, change);
      assert.ok(buildPaperPlan([mixed], qualifiedAt).plan, "one opposed or unknown frame is not a two-frame conflict");
    }
  }
});

test("legacy wide-spread origins remain byte-identical and cannot count as current-entry results", () => {
  const db=new DatabaseSync(':memory:'),store=openPaperPlanStore(db);
  try{
    const e=evidence();e.contracts[0].bid=1.2;const old=legacyPlan([e]).plan;assert.equal(old.entry_policy,undefined);
    const current=buildPaperPlan([qualifiedEvidence('AAPL')],qualifiedAt,2).plan;
    store.append(makePaperEvent(old.plan_id,old.created_at,'CREATED',{plan:old}));const before=db.prepare('SELECT * FROM paper_plan_events ORDER BY sequence').all();
    store.append(makePaperEvent(current.plan_id,current.created_at,'CREATED',{plan:current}));store.append(mark(old,'2026-09-10T14:00:00Z',1.26));
    const learning=store.learning();assert.deepEqual(learning.groups.filter(g=>g.dimension==='ENTRY_POLICY').map(g=>[g.label,g.stats.total,g.stats.losses,g.stats.pending]),[['旧观察基线',1,1,0],['原方向研究规则',1,0,1]]);
    assert.deepEqual(db.prepare('SELECT * FROM paper_plan_events WHERE sequence <= ? ORDER BY sequence').all(before.at(-1).sequence),before);
    assert.equal(openPaperPlanStore(db,{readOnly:true}).eventsForPlan(old.plan_id)[0].payload.plan.entry_policy,undefined);
  }finally{db.close();}
});

test("immutable daily origin allows subsequent-day marks, gaps and expiry UNKNOWN but never fabricated zero", () => {
  const db = new DatabaseSync(":memory:"), store = openPaperPlanStore(db), plan = legacyPlan([evidence()], at).plan;
  try {
    store.append(makePaperEvent(plan.plan_id, at, "ATTEMPT", { reasons: ["Waiting for quote"] }));
    const created = makePaperEvent(plan.plan_id, at, "CREATED", { plan });
    assert.deepEqual(store.append(created), { duplicate: false });
    assert.deepEqual(store.append(created), { duplicate: true });
    const second = structuredClone(plan); second.created_at = second.reference.recorded_at = "2026-09-10T13:45:01.000Z";
    assert.throws(() => store.append(makePaperEvent(plan.plan_id, second.created_at, "CREATED", { plan: second })), /已有原始模拟单/);
    assert.throws(() => store.append({ ...created, payload: { plan: { ...plan, executable: true } } }), /冲突/);
    assert.throws(() => db.prepare("DELETE FROM paper_plan_events").run(), /append-only/);
    assert.throws(() => db.prepare("UPDATE paper_plan_events SET market_date='2026-09-11'").run(), /append-only/);
    const nextDay = "2026-09-11T13:45:00.000Z";
    store.append(mark(plan, nextDay, 3));
    store.append(mark(plan, "2026-09-11T14:00:00.000Z", 0));
    store.append(makePaperEvent(plan.plan_id, "2026-09-14T14:00:00.000Z", "GAP", { reasons: ["Host was off; missing prices not backfilled"] }));
    const view = projectPaperPlans(store.recentEvents(), "2026-09-14T14:00:00.000Z").plans[0];
    assert.equal(view.status, "DATA_GAP");
    assert.equal(view.lowest_observed_return_pct, -100);
    assert.equal(view.stop_observed, true);
    assert.equal(view.take_profit_observed, true);
    assert.equal(store.activePlans().length, 1);
    const wrong = mark(plan, "2026-09-14T14:15:00.000Z", 1); wrong.payload.quote.contract_id = "different-contract";
    assert.throws(() => store.append(makePaperEvent(plan.plan_id, wrong.recorded_at, "MARK", wrong.payload)), /同一精确合约/);
    assert.throws(() => store.append(mark(plan, "2026-09-11T15:00:00.000Z", 1)), /倒序/);
    assert.throws(() => store.append(makePaperEvent(plan.plan_id, "2026-09-14T15:00:00.000Z", "ENDED", { reason: "EXPIRATION", ended_at: plan.expires_at, terminal_value: "UNKNOWN" })), /到期/);
    store.append(makePaperEvent(plan.plan_id, plan.expires_at, "ENDED", { reason: "EXPIRATION", ended_at: plan.expires_at, terminal_value: "UNKNOWN" }));
    assert.equal(store.activePlans().length, 0);
    assert.equal(projectPaperPlans(store.recentEvents(), plan.expires_at).plans[0].status, "EXPIRED");
    assert.throws(() => store.append(makePaperEvent(plan.plan_id, "2026-10-19T14:15:00.000Z", "GAP", { reasons: ["Late observation"] })), /已到期/);
  } finally { db.close(); }
});

test("PR178 daily origin migrates byte-identically into three distinct immutable paper tickets", () => {
  const db = new DatabaseSync(":memory:"), legacy = openPaperPlanStore(db), first = legacyPlan([evidence()], at).plan;
  try {
    // Emulate the shipped PR178 schema in this in-memory database only.
    db.exec("DROP INDEX paper_plan_once_per_id; DROP INDEX paper_plan_distinct_daily_symbol; CREATE UNIQUE INDEX paper_plan_once_daily ON paper_plan_events(market_date) WHERE event_type = 'CREATED'");
    legacy.append(makePaperEvent(first.plan_id, at, "CREATED", { plan: first }));
    const original = db.prepare("SELECT * FROM paper_plan_events ORDER BY sequence").all();
    const schema = () => db.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'paper_plan_events' ORDER BY name").all();
    const oldSchema = schema(), readonly = openPaperPlanStore(db, { readOnly: true });
    assert.deepEqual(readonly.activePlans(), [first]); assert.deepEqual(schema(), oldSchema);
    assert.throws(() => readonly.append(makePaperEvent(first.plan_id, at, "GAP", { reasons: ["Read-only check"] })), /只读/);
    const store = openPaperPlanStore(db);
    assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events ORDER BY sequence").all(), original);
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'paper_plan_once_daily'").get(), undefined);
    assert.equal(PAPER_DAILY_TARGET, 3); assert.equal(paperPlanId(first.market_date), first.plan_id);
    const duplicateSymbol = legacyPlan([evidence()], at, 2).plan;
    assert.throws(() => store.append(makePaperEvent(duplicateSymbol.plan_id, at, "CREATED", { plan: duplicateSymbol })), /UNIQUE/);
    const plans = [first, ...["AAPL", "MSFT"].map((symbol, index) => legacyPlan([evidence(symbol)], at, index + 2).plan)];
    for (const plan of plans.slice(1)) {
      assert.equal(makePaperEvent(plan.plan_id, at, "CREATED", { plan }).market_date, first.market_date);
      store.append(makePaperEvent(plan.plan_id, at, "CREATED", { plan }));
    }
    assert.deepEqual(store.activePlans().map((plan) => plan.plan_id), [first.plan_id, `${first.plan_id}:2`, `${first.plan_id}:3`]);
    const duplicateId = { ...plans[1], symbol: "AMD" };
    assert.throws(() => store.append(makePaperEvent(duplicateId.plan_id, at, "CREATED", { plan: duplicateId })), /已有原始模拟单/);
    for (const suffix of [":1", ":4", ":02"]) {
      const invalid = { ...first, plan_id: `${first.plan_id}${suffix}`, symbol: "AMD" };
      assert.throws(() => store.append(makePaperEvent(invalid.plan_id, at, "CREATED", { plan: invalid })), /无效/);
    }
    for (const plan of plans) {
      store.append(mark(plan, "2026-09-11T13:45:00.000Z", 3));
      store.append(makePaperEvent(plan.plan_id, plan.expires_at, "ENDED", { reason: "EXPIRATION", ended_at: plan.expires_at, terminal_value: "UNKNOWN" }));
    }
    assert.equal(store.activePlans().length, 0);
    assert.equal(projectPaperPlans(store.recentEvents()).plans.filter((row) => row.status === "EXPIRED").length, 3);
    assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events WHERE sequence = 1").all(), original);
    assert.throws(() => db.exec("DELETE FROM paper_plan_events"), /append-only/);
    assert.throws(() => db.exec("UPDATE paper_plan_events SET market_date = '2026-09-11'"), /append-only/);
    openPaperPlanStore(db); // Migration remains idempotent after multiple same-day origins.
  } finally { db.close(); }
});

test("old readonly database works without schema migration and every active original survives recent-10 projection", () => {
  const old = new DatabaseSync(":memory:"), empty = openPaperPlanStore(old, { readOnly: true });
  assert.deepEqual(empty.recentEvents(), []); assert.deepEqual(empty.activePlans(), []); assert.deepEqual(empty.eventsForPlan("missing"), []); old.close();
  const db = new DatabaseSync(":memory:"), store = openPaperPlanStore(db);
  try {
    for (const day of ["10", "11", "14", "15", "16", "17", "18", "21", "22", "23", "24"]) {
      const stamp = `2026-09-${day}T13:45:00.000Z`, e = evidence();
      e.observed_at = e.received_at = e.quote.as_of = e.contracts[0].as_of = stamp;
      e.planning_context.observed_at = stamp;
      const plan = legacyPlan([e], stamp).plan;
      assert.ok(plan);
      store.append(makePaperEvent(plan.plan_id, stamp, "CREATED", { plan }));
    }
    assert.equal(store.activePlans().length, 11);
    assert.equal(projectPaperPlans(store.recentEvents()).plans.length, 11);
    assert.equal(store.activePlans()[0].market_date, "2026-09-10");
    const oldest = store.activePlans()[0];
    store.append(makePaperEvent(oldest.plan_id, "2026-09-24T14:00:00.000Z", "GAP", { reasons: ["Quote missing"] }));
    assert.equal(store.activePlans().at(-1).market_date, "2026-09-10");
  } finally { db.close(); }
});

test("failed paper index migration rolls back without changing legacy rows or its caller transaction", () => {
  const db = new DatabaseSync(":memory:"); openPaperPlanStore(db);
  try {
    db.exec("DROP INDEX paper_plan_once_per_id; DROP INDEX paper_plan_distinct_daily_symbol; CREATE UNIQUE INDEX paper_plan_once_daily ON paper_plan_events(market_date) WHERE event_type = 'CREATED'");
    db.prepare("INSERT INTO paper_plan_events(event_id, plan_id, market_date, event_type, recorded_at, payload_hash, payload_json) VALUES (?, ?, ?, 'CREATED', ?, ?, ?)").run("corrupt-test-only", "paper-plan:2026-09-10", "2026-09-10", at, "corrupt-test-only", "invalid JSON");
    const before = db.prepare("SELECT * FROM paper_plan_events").all();
    db.exec("BEGIN");
    assert.throws(() => openPaperPlanStore(db), /malformed JSON/);
    assert.equal(db.isTransaction, true);
    assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'paper_plan_once_daily'").get());
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'paper_plan_once_per_id'").get(), undefined);
    assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events").all(), before);
    db.exec("ROLLBACK");
  } finally { db.close(); }
});

test("learning counts all originals and first observed thresholds, not extrema, open PnL or unknown expiry", () => {
  const db = new DatabaseSync(":memory:"), store = openPaperPlanStore(db), dates = ["10", "11", "14", "15", "16", "17", "18", "21", "22", "23", "24"], plans = [];
  try {
    assert.equal(store.learning().summary.win_rate_pct, null);
    for (const day of dates) {
      const stamp = `2026-09-${day}T13:45:00.000Z`, e = evidence();
      e.observed_at = e.received_at = e.quote.as_of = e.contracts[0].as_of = e.planning_context.observed_at = stamp;
      const plan = legacyPlan([e], stamp).plan;
      plans.push(plan); store.append(makePaperEvent(plan.plan_id, stamp, "CREATED", { plan }));
    }
    const before = db.prepare("SELECT * FROM paper_plan_events ORDER BY sequence").all();
    const push = (index, minute, bid) => store.append(mark(plans[index], `2026-09-24T14:${minute}:00.000Z`, bid));
    store.append(makePaperEvent(plans[0].plan_id, "2026-09-24T14:00:00.000Z", "GAP", { reasons: ["Missing samples before outcome"] }));
    push(0, "01", 2.835); // First +35%, not the later +100% maximum or loss.
    push(0, "02", 4.2); push(0, "03", 0);
    push(1, "01", 1.155); push(1, "02", 4.2); // First -45%, then winner: remains a loss.
    store.append(makePaperEvent(plans[1].plan_id, "2026-09-24T14:03:00.000Z", "GAP", { reasons: ["Missing after outcome does not alter its gap flag"] }));
    push(2, "01", 2.31); push(3, "01", 2.52); // Positive marks alone never become wins.
    for (const index of [0, 1, 2]) store.append(makePaperEvent(plans[index].plan_id, plans[index].expires_at, "ENDED", { reason: "EXPIRATION", ended_at: plans[index].expires_at, terminal_value: "UNKNOWN" }));
    assert.equal(projectPaperPlans(store.recentEvents()).plans.length, 10);
    assert.ok(!store.recentEvents().some((event) => event.plan_id === plans[0].plan_id), "oldest winning original is outside the recent cards");
    const learning = store.learning(), summary = learning.summary;
    assert.deepEqual([summary.total, summary.wins, summary.losses, summary.pending, summary.unknown, summary.resolved_days], [11, 1, 1, 8, 1, 2]);
    assert.equal(learning.current_round.start_date, "2026-09-14");
    assert.deepEqual([learning.current_round.summary.total, learning.current_round.summary.wins, learning.current_round.summary.losses, learning.current_round.summary.pending, learning.current_round.summary.unknown], [9, 0, 0, 8, 1]);
    assert.equal(learning.current_round.summary.win_rate_pct, null, "pending or expired-unknown new tickets do not establish a win rate");
    assert.deepEqual([learning.archived_summary.total, learning.archived_summary.wins, learning.archived_summary.losses], [2, 1, 1], "archive every pre-round origin, even when it settles after the start date; exclude old wins and losses equally");
    assert.equal(learning.archived_summary.win_rate_pct, 50);
    assert.deepEqual(learning.current_round.groups.find((group) => group.dimension === "DIRECTION").stats, learning.current_round.summary);
    assert.equal(summary.win_rate_pct, 50); assert.equal(summary.average_return_pct, -5);
    assert.ok(Math.abs(summary.profit_factor - 73.5 / 94.5) < 1e-10, "uses observed dollar payoff, not nominal +30/-40 levels");
    assert.equal(summary.gap_count, 1);
    assert.ok(Math.abs(summary.average_entry_spread_pct - 100 / 21) < 1e-6);
    assert.equal(learning.recent_results.find((row) => row.plan_id === plans[1].plan_id).return_pct, -45);
    assert.equal(learning.recent_results.find((row) => row.plan_id === plans[2].plan_id).status, "UNKNOWN");
    assert.equal(learning.recent_results.find((row) => row.plan_id === plans[3].plan_id).status, "PENDING");
    assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events WHERE sequence <= ? ORDER BY sequence").all(before.at(-1).sequence), before);
    assert.equal(store.activePlans().length, 8, "threshold learning never closes the tracked contract");
    assert.deepEqual(learning.groups.find((group) => group.dimension === "DIRECTION").stats, summary);
    assert.equal(store.learning(), learning, "no new event reuses the same projection");
    push(3, "04", 2.73); // Exactly +30% resolves once and invalidates the cached summary.
    const updated = store.learning();
    assert.equal(updated.summary.wins, 2); assert.equal(updated.summary.pending, 7);
    assert.deepEqual([updated.current_round.summary.wins, updated.current_round.summary.losses, updated.current_round.summary.pending, updated.current_round.summary.unknown], [1, 0, 7, 1]);
    assert.equal(updated.current_round.summary.win_rate_pct, 100, "round denominator is its settled tickets only");
    assert.deepEqual(updated.archived_summary, learning.archived_summary, "new outcomes do not rewrite archived results");
    assert.equal(updated.recent_results.find((row) => row.plan_id === plans[3].plan_id).status, "WIN");
    assert.equal(store.activePlans().length, 8);
  } finally { db.close(); }
  const legacy = new DatabaseSync(":memory:");
  try { const empty = openPaperPlanStore(legacy, { readOnly: true }).learning(); assert.equal(empty.summary.total, 0); assert.equal(empty.summary.win_rate_pct, null); assert.equal(empty.current_round.summary.total, 0); assert.equal(empty.current_round.summary.win_rate_pct, null); assert.equal(empty.archived_summary.total, 0); } finally { legacy.close(); }
  const boundaries = new DatabaseSync(":memory:"), grouped = openPaperPlanStore(boundaries);
  try {
    for (const [index, symbol] of ["NVDA", "AAPL", "MSFT"].entries()) {
      const e = evidence(symbol), expiration = ["2026-09-18", "2026-10-16", "2026-12-18"][index];
      e.contracts[0].ask = 2; e.contracts[0].bid = [1.9, 1.8, 1.7][index];
      if (index === 2) { e.direction = "BEARISH"; e.contracts[0].option_type = e.contracts[0].instrument.type = "put"; for (const frame of Object.values(e.planning_context.timeframes)) frame.direction = "BEARISH"; }
      const plan = legacyPlan([e], at, index + 1).plan;
      // Legacy long-dated origins remain valid; new selection never rewrites them.
      plan.contract.expiration = expiration; plan.expires_at = paperExpiryClose(expiration);
      validatePaperPlan(plan);
      grouped.append(makePaperEvent(plan.plan_id, at, "CREATED", { plan }));
      if (index < 2) grouped.append(mark(plan, "2026-09-10T14:00:00.000Z", index === 0 ? 2.6 : 1.2));
    }
    const learning = grouped.learning();
    assert.deepEqual(learning.groups.filter((group) => group.dimension === "ENTRY_SPREAD").map((group) => [group.label, group.stats.total]), [["入场价差 ≤5%", 1], ["入场价差 >5%–10%", 1], ["入场价差 >10%", 1]]);
    assert.deepEqual(learning.groups.filter((group) => group.dimension === "DTE").map((group) => group.stats.total), [1, 1, 1]);
    assert.equal(learning.groups.find((group) => group.label === "看跌 Put").stats.win_rate_pct, null);
    assert.equal(learning.groups.find((group) => group.label === "入场价差 ≤5%").stats.profit_factor, null, "no loss denominator never becomes infinity or zero");
    assert.deepEqual([learning.summary.wins, learning.summary.losses, learning.summary.pending], [1, 1, 1]);
  } finally { boundaries.close(); }
});

test("risk exits require a fresh exact quote and traceable evidence known before that quote", () => {
  const db = new DatabaseSync(":memory:"), store = openPaperPlanStore(db), plan = legacyPlan([evidence()], at).plan;
  const stamp = "2026-09-10T14:00:00.000Z", earlier = "2026-09-10T13:59:59.000Z", later = "2026-09-10T14:00:01.000Z";
  try {
    const original = makePaperEvent(plan.plan_id, at, "CREATED", { plan }); store.append(original);
    const before = db.prepare("SELECT * FROM paper_plan_events").all(), schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'paper_plan_events' ORDER BY name").all();
    const invalid = [
      { rule_version: "UNVERIFIED" }, { reason: "SENTIMENT" }, { event_id: "" }, { title: "" }, { source: "" }, { scope: "SPY" },
      { decision_at: earlier }, { decision_at: later }, { source_observed_at: later }, { source_checked_at: later },
      { source_observed_at: stamp, source_checked_at: earlier }, { published_at: later }, { published_at: "2026-09-10" },
      { scheduled_for: "2026-02-30" }, { scheduled_for: null }, { session: null }, { session: "POSTMARKET" },
      { source: "unverified calendar" }, { scope: "GLOBAL" }, { source_url: "http://example.com/event" },
      { reason: "VERIFIED_MAJOR_EVENT", published_at: earlier, source_url: null },
      { reason: "VERIFIED_MAJOR_EVENT", published_at: null, source_url: "https://example.com/event" },
      { reason: "VERIFIED_MAJOR_EVENT", published_at: earlier, source_url: "https://user:secret@example.com/event" },
      { reason: "OFFICIAL_MACRO_WINDOW", source_url: "https://example.com/event", scheduled_for: "2026-09-10T14:30:00.000Z" },
      { reason: "OFFICIAL_MACRO_WINDOW", scope: "GLOBAL", source_url: "https://example.com/event", scheduled_for: "2026-09-10" },
    ];
    for (const overrides of invalid) {
      const event = riskMark(plan, stamp, 2.2, overrides);
      assert.throws(() => store.append(event), /模拟观察记录无效/, JSON.stringify(overrides));
      assert.equal(paperMarkExitReason(plan, event), null);
    }
    for (const mutate of [
      (event) => { event.payload.quote = null; },
      (event) => { event.payload.quote.contract_id = "another-contract"; },
      (event) => { event.payload.quote.bid = null; },
      (event) => { event.payload.quote.quoted_at = "2026-09-10T13:57:59.000Z"; },
      (event) => { event.payload.quote.quoted_at = earlier; }, // Evidence was not known at quote time.
      (event) => { event.payload.quote.quoted_at = later; },
      (event) => { event.payload.estimated_return_pct = 50; },
    ]) {
      const event = riskMark(plan, stamp, 2.2); mutate(event);
      assert.throws(() => store.append(makePaperEvent(event.plan_id, event.recorded_at, "MARK", event.payload)), /模拟观察记录无效/);
    }
    assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events").all(), before);
    const valid = riskMark(plan, stamp, 2.2, { source_observed_at: earlier });
    valid.payload.quote.quoted_at = earlier; // Supplier timestamps can precede decision by a second.
    store.append(makePaperEvent(valid.plan_id, valid.recorded_at, "MARK", valid.payload));
    assert.equal(store.learning().recent_results[0].exit_reason, "EARNINGS_WINDOW");
    assert.equal(store.learning().recent_results[0].bid, 2.2);
    assert.deepEqual(db.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'paper_plan_events' ORDER BY name").all(), schema);
    assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events WHERE sequence = 1").all(), before);
    const beforeCreation = riskMark(plan, "2026-09-10T13:44:59.000Z", 2.2);
    assert.equal(paperMarkExitReason(plan, beforeCreation), null);
    const afterExpiry = riskMark(plan, "2026-10-09T20:00:01.000Z", 2.2, { source_observed_at: plan.expires_at });
    afterExpiry.payload.quote.quoted_at = plan.expires_at;
    assert.equal(paperMarkExitReason(plan, afterExpiry), null);
  } finally { db.close(); }
});

test("first risk exit freezes actual win loss or flat while all contracts continue to expiry", () => {
  const db = new DatabaseSync(":memory:"), store = openPaperPlanStore(db), plans = [];
  try {
    for (const day of ["10", "11", "14", "15", "16", "17", "18", "21", "22", "23", "24"]) {
      const stamp = `2026-09-${day}T13:45:00.000Z`, e = evidence();
      e.observed_at = e.received_at = e.quote.as_of = e.contracts[0].as_of = e.planning_context.observed_at = stamp;
      const plan = legacyPlan([e], stamp).plan; plans.push(plan);
      store.append(makePaperEvent(plan.plan_id, stamp, "CREATED", { plan }));
    }
    const originals = db.prepare("SELECT * FROM paper_plan_events ORDER BY sequence").all();
    const eventAt = "2026-09-24T14:01:00.000Z", later = "2026-09-24T14:02:00.000Z";
    store.append(makePaperEvent(plans[0].plan_id, "2026-09-24T14:00:00.000Z", "GAP", { reasons: ["Missing observation before exit"] }));
    const win = riskMark(plans[0], eventAt, 2.31);
    store.append(win); store.append(mark(plans[0], later, 0));
    const loss = riskMark(plans[1], eventAt, 1.89, { reason: "VERIFIED_MAJOR_EVENT", source: "Synthetic official source", source_url: "https://example.com/news", published_at: "2026-09-24T14:00:00.000Z", scheduled_for: null, session: null });
    store.append(loss); store.append(mark(plans[1], later, 4.2));
    store.append(makePaperEvent(plans[1].plan_id, "2026-09-24T14:03:00.000Z", "GAP", { reasons: ["Gap after settled loss"] }));
    const flat = riskMark(plans[2], eventAt, 2.1, { reason: "OFFICIAL_MACRO_WINDOW", scope: "GLOBAL", source: "Synthetic official calendar", source_url: "https://example.com/calendar", scheduled_for: "2026-09-24T14:30:00.000Z", session: null });
    store.append(flat); store.append(mark(plans[2], later, 4.2));
    store.append(riskMark(plans[3], eventAt, 2.73)); // Same sample: exact threshold takes precedence over attached risk evidence.
    store.append(riskMark(plans[4], eventAt, 1.26));
    store.append(mark(plans[5], eventAt, 2.31)); // Unsettled positive mark stays pending.
    assert.equal(store.activePlans().length, 11);
    const full = plans.flatMap((plan) => store.eventsForPlan(plan.plan_id));
    const learning = store.learning();
    assert.deepEqual(learning, projectPaperLearning(full), "compacted SQL retains the first risk exit, not a later threshold or extremum");
    assert.equal(learning.rule, "FIRST_OBSERVED_30_OR_MINUS_40_OR_RISK_EXIT_V2");
    assert.deepEqual([learning.summary.wins, learning.summary.losses, learning.summary.flats, learning.summary.risk_exits, learning.summary.pending, learning.summary.unknown], [2, 2, 1, 3, 6, 0]);
    assert.equal(learning.summary.win_rate_pct, 40, "flat is a settled sample and is not a win");
    assert.equal(learning.summary.average_return_pct, -2);
    assert.deepEqual(learning.groups.filter((group) => group.dimension === "EXIT_REASON").map(({ label, stats }) => [label, stats.wins, stats.losses, stats.flats, stats.risk_exits, stats.pending, stats.average_return_pct]), [
      ["财报窗口", 1, 0, 0, 1, 0, 10], ["已核验重大事件", 0, 1, 0, 1, 0, -10], ["官方宏观窗口", 0, 0, 1, 1, 0, 0],
      ["止盈阈值", 1, 0, 0, 0, 0, 30], ["止损阈值", 0, 1, 0, 0, 0, -40], ["未结算", 0, 0, 0, 0, 6, null],
    ]);
    const result = (index) => learning.recent_results.find((row) => row.plan_id === plans[index].plan_id);
    assert.deepEqual([result(0).status, result(0).event_id, result(0).return_pct, result(0).pnl, result(0).gap_before_result], ["WIN", win.event_id, 10, 21, true]);
    assert.deepEqual([result(1).status, result(1).event_id, result(1).return_pct, result(1).pnl, result(1).gap_before_result], ["LOSS", loss.event_id, -10, -21, false]);
    assert.deepEqual([result(2).status, result(2).event_id, result(2).return_pct, result(2).pnl], ["FLAT", flat.event_id, 0, 0]);
    assert.deepEqual([result(3).exit_reason, result(4).exit_reason, result(3).risk_exit, result(4).risk_exit], ["TAKE_PROFIT", "STOP_LOSS", null, null]);
    assert.equal(store.learning(), learning);
    for (const index of [0, 1, 2, 6]) store.append(makePaperEvent(plans[index].plan_id, plans[index].expires_at, "ENDED", { reason: "EXPIRATION", ended_at: plans[index].expires_at, terminal_value: "UNKNOWN" }));
    const reopened = openPaperPlanStore(db, { readOnly: true });
    const after = reopened.learning();
    assert.equal(after.summary.wins, 2); assert.equal(after.summary.losses, 2); assert.equal(after.summary.flats, 1); assert.equal(after.summary.risk_exits, 3);
    assert.equal(after.summary.unknown, 1); assert.equal(after.summary.pending, 5); assert.equal(after.summary.win_rate_pct, 40);
    assert.equal(reopened.activePlans().length, 7);
    assert.equal(reopened.recentEvents().some((row) => row.plan_id === plans[0].plan_id), false, "oldest settled case is outside recent ten but remains in aggregate");
    assert.equal(after.recent_results.find((row) => row.plan_id === plans[1].plan_id).event_id, loss.event_id);
    assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events WHERE sequence <= ? ORDER BY sequence").all(originals.at(-1).sequence), originals);
  } finally { db.close(); }
});
