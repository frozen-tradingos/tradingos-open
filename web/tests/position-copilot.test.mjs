import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { buildPositionCopilotState } from "../server/position-copilot.ts";
import * as positionRisk from "../server/position-copilot.ts";
import { isHoldingAdviceCurrent } from "../app/today-action.ts";
import { isNyseRegularSession, nyseClosePtMinutes } from "../app/market-time.ts";
import { utcForPt } from "../app/timeline-schedule.ts";
import { ownerPositionIdentity } from "../app/owner-position-plan.ts";
import { parseOutputEnvelope } from "../app/snapshot-import.ts";

const observedAt = "2026-08-13T16:00:00.000Z";
const position = { account_label: "账户-aaaaaaaaaaaaaaaa", contract_id: "spy-call", symbol: "SPY", option_type: "call", expiration: "2026-08-14", strike: 100, direction: "long", quantity: 2, average_price: 2, bid: 2.4, ask: 2.45, mark: 2.425, iv: .2, delta: .5, gamma: .02, theta: -.05, vega: .08, open_interest: 200, volume: 100, as_of: observedAt };
const market = { snapshot_id: `market-${"b".repeat(24)}`, snapshot_hash: "b".repeat(64), generated_at: observedAt, as_of: observedAt, status: "LIVE", market_session: { state: "REGULAR" }, quotes: [{ source: "ROBINHOOD", symbol: "SPY", last: 100 }], account: { status: "LIVE", positions: [position] } };
const monitor = { contract_version: "v1", status: "HEALTHY", checked_at: observedAt, cadence_seconds: 60, open_position_count: 1, positions: [{ position_id: "SPY-call-2026-08-14-100", position_snapshot_hash: "a".repeat(64), option_symbol: "SPY260814C00100000", monitor_status: "HEALTHY", quote_status: "HEALTHY", checked_at: observedAt, source_quote_at: observedAt, bid: 2.4, ask: 2.45, exit_return_pct: 20, peak_exit_return_pct: 20, trough_exit_return_pct: 20, max_drawdown_from_peak_pct: 0, dte: 1, plan_status: "ACTIVE", plan_run_id: "run-1", plan_receipt_hash: "c".repeat(64), stop_loss_pct: -30, take_profit_pct: 50, invalidation: ["SPY跌破99"], pending_event_ids: [] }], pending_events: [] };
const condition = (value) => ({ conditions: [{ symbol: "SPY", metric: "LAST_PRICE", operator: "ABOVE", value, upper_value: null, confirmation: "ONE_5M_CLOSE" }] });
const ts = { report_type: "OPENING_FORECAST", evidence_snapshot: { run_id: "20260813T160000Z-aaaaaaaaaa", market_time: { observed_at: observedAt, market_date: "2026-08-13" } }, forecast_update: { change_summary: "首次" }, symbol_outlooks: { SPY: { direction: "BULLISH" }, QQQ: { direction: "RANGE" } }, tradeability: { status: "CONDITIONAL" }, key_levels: [{ symbol: "SPY", label: "支撑", value: 99 }, { symbol: "SPY", label: "阻力", value: 103 }], scenarios: { main: { bias: "BULLISH", probability_pct: 50, activation: condition(100), sequence: [condition(102), condition(104)], invalidation: condition(98) }, reverse: { bias: "RANGE", probability_pct: 30, activation: condition(100), sequence: [condition(99)], invalidation: condition(98) }, extreme: { bias: "BEARISH", probability_pct: 20, activation: condition(99), sequence: [condition(97)], invalidation: condition(101) } }, next_validation: { at: "2026-08-13T16:30:00.000Z" } };
const d = { action: "OBSERVE", underlying: "SPY", option_side: "call", expiration: "2026-08-14", strike: 100 };
const a3 = { decision: "OBSERVE", underlying: "SPY", option_side: "call", expiration: "2026-08-14", strike: 100 };

test("explicit holding intent freezes only exact known plans and never selects management from DTE", () => {
  const currentMarket = { ...market, account: { ...market.account, source: "ROBINHOOD", as_of: observedAt } };
  const identity = ownerPositionIdentity(positionRisk.assessPositionRisks(currentMarket.account, null, observedAt).observations[0]);
  const fingerprint = createHash("sha256").update(JSON.stringify(identity, Object.keys(identity).sort())).digest("hex");
  const plan = { holding_id: identity.holding_id, plan_version_id: "owner-position-plan-22222222-2222-4222-8222-222222222222", source_record_id: "live-shadow:20260813T153000Z:A1", recorded_at: observedAt,
    source_checked_at: observedAt, source_account_as_of: observedAt, source_mode: "OWNER_STATED", binding_status: "MATCHED_LATEST_ARCHIVED", position: identity, position_fingerprint: fingerprint,
    original_logic: "Owner明确说明", holding_intent: { period: "ONE_TO_THREE_TRADING_DAYS", review_on: "2026-08-17", effect: "REVIEW_ONLY" } };
  const args = { runId: "live-shadow:20260813T160000Z", slotId: "live-shadow:20260813T160000Z", sourceMode: "LIVE", market: currentMarket, monitor, ts, d, a3, observedAt };
  const legacy = buildPositionCopilotState(args), original = structuredClone(legacy), beforePlan = structuredClone(plan);
  assert.equal(legacy.holdings[0].owner_action, "HOLD");
  const state = buildPositionCopilotState({ ...args, ownerPositionPlans: [plan] }), row = state.holdings[0];
  assert.equal(row.owner_action, "WAIT"); assert.equal(row.dte, 1);
  assert.equal(row.holding_horizon, "UNCLASSIFIED");
  assert.equal(row.holding_intent.plan_version_id, plan.plan_version_id);
  assert.deepEqual([row.target_1, row.target_2, row.price_invalidation, row.time_invalidation, row.next_check_at], [null, null, null, null, null]);
  assert.match(row.explanation, /已记录1–3交易日意图.*尚无该计划的持有\/退出判断/);
  const envelope = (payload) => JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `${payload.source_run_id}:POSITION_COPILOT_STATE`, output_type: "POSITION_COPILOT_STATE", channel: "SHADOW", observed_at: payload.observed_at, payload });
  assert.equal(parseOutputEnvelope(envelope(state)).payload.holdings[0].holding_intent.period, "ONE_TO_THREE_TRADING_DAYS");
  assert.equal(parseOutputEnvelope(envelope(legacy)).payload.holdings[0].holding_intent, undefined);
  for (const mutate of [(value) => { value.holdings[0].owner_action = "HOLD"; }, (value) => { value.holdings[0].target_1 = 110; }, (value) => { value.holdings[0].holding_intent.recorded_at = "2026-08-13T16:00:01Z"; }, (value) => { value.holdings[0].next_check_at = "2026-08-13T16:30:00Z"; }, (value) => { value.holdings[0].normal_range.low = 99; }]) {
    const invalid = structuredClone(state); mutate(invalid); assert.throws(() => parseOutputEnvelope(envelope(invalid)));
  }
  for (const ownerPositionPlans of [[{ ...plan, recorded_at: "2026-08-13T16:00:00.001Z" }], [{ ...plan, binding_status: "POSITION_CHANGED" }], [plan, plan], [{ ...plan, holding_intent: undefined }]]) {
    assert.deepEqual(buildPositionCopilotState({ ...args, ownerPositionPlans }), legacy, "unknown, future, changed or ambiguous intent preserves old behavior without inventing intent");
  }
  for (const changed of [{ ...position, account_label: "账户-bbbbbbbbbbbbbbbb" }, { ...position, average_price: 2.1 }, { ...position, quantity: 3 }]) {
    const changedMarket = { ...currentMarket, account: { ...currentMarket.account, positions: [changed] } };
    assert.equal(buildPositionCopilotState({ ...args, market: changedMarket, ownerPositionPlans: [plan] }).holdings[0].holding_intent, undefined);
  }
  for (const changedAccount of [{ ...currentMarket.account, as_of: "2026-08-13T16:00:00.001Z" }, { ...currentMarket.account, positions: [position, position] }]) {
    assert.ok(buildPositionCopilotState({ ...args, market: { ...currentMarket, account: changedAccount }, ownerPositionPlans: [plan] }).holdings.every((holding) => !holding.holding_intent), "future account snapshots and duplicate exact positions cannot bind intent");
  }
  const twoAccounts = { ...currentMarket, account: { ...currentMarket.account, positions: [position, { ...position, account_label: "账户-bbbbbbbbbbbbbbbb" }] } };
  const paired = buildPositionCopilotState({ ...args, market: twoAccounts, ownerPositionPlans: [plan] });
  assert.ok(paired.holdings[0].holding_intent); assert.equal(paired.holdings[1].holding_intent, undefined);
  const expiration = "2026-09-18", longPosition = { ...position, expiration };
  const longMarket = { ...currentMarket, account: { ...currentMarket.account, positions: [longPosition] }, approved_capabilities: { fixed_pool: { rows: [{ symbol: "SPY", support: 95, resistance: 110, swing: { stage: "CONFIRMED", direction: "BULLISH", management: { price_invalidation: 94, target_1: 108, target_2: 115 } } }] } } };
  const longIdentity = ownerPositionIdentity(positionRisk.assessPositionRisks(longMarket.account, null, observedAt).observations[0]);
  const longPlan = { ...plan, holding_id: longIdentity.holding_id, position: longIdentity, position_fingerprint: createHash("sha256").update(JSON.stringify(longIdentity, Object.keys(longIdentity).sort())).digest("hex") };
  const longArgs = { ...args, market: longMarket, monitor: { ...monitor, positions: [{ ...monitor.positions[0], position_id: `SPY-call-${expiration}-100`, dte: 36 }] }, d: { ...d, expiration }, a3: { ...a3, expiration } };
  assert.equal(buildPositionCopilotState(longArgs).holdings[0].target_1, 108);
  const longRow = buildPositionCopilotState({ ...longArgs, ownerPositionPlans: [longPlan] }).holdings[0];
  assert.deepEqual([longRow.dte, longRow.holding_horizon, longRow.owner_action, longRow.target_1], [36, "UNCLASSIFIED", "WAIT", null]);
  const later = "2026-08-18T16:00:00Z", laterMarket = { ...longMarket, account: { ...longMarket.account, as_of: later, positions: [{ ...longPosition, as_of: later }] } };
  const due = buildPositionCopilotState({ ...longArgs, observedAt: later, market: laterMarket, ownerPositionPlans: [longPlan] }).holdings[0];
  assert.equal(due.owner_action, "WAIT"); assert.match(due.data_gaps.join(" "), /已到计划复查日/);
  assert.equal(due.time_invalidation, null, "review date never becomes an automatic third-day exit");
  assert.deepEqual(plan, beforePlan); assert.deepEqual(legacy, original);
});

test("position copilot uses the exact Robinhood holding and V2 monitor without inventing entry logic", () => {
  const state = buildPositionCopilotState({ runId: "live-shadow:20260813T160000Z", slotId: "live-shadow:20260813T160000Z", sourceMode: "LIVE", market, monitor, ts, d, a3 });
  assert.equal(state.holdings[0].owner_action, "HOLD");
  assert.equal(state.holdings[0].thesis_status, "NOT_VERIFIED");
  assert.equal(state.holdings[0].original_logic, null);
  assert.deepEqual(state.holdings[0].normal_range, { low: 99, high: 103, basis: "当前 TS 支撑/阻力；不是原始建仓逻辑" });
  assert.equal(state.holdings[0].price_invalidation, 98);
  assert.deepEqual([state.holdings[0].target_1, state.holdings[0].target_2], [102, 104]);
  assert.deepEqual([state.holdings[0].discovery_context.underlying_price, state.holdings[0].discovery_context.owner_history_status], [100, "NOT_PROVIDED"]);
  assert.equal(state.automated_execution, false);
});

test("first discovery context is frozen and V2 re-entry ids create a new holding", () => {
  const first = buildPositionCopilotState({ runId: "live-shadow:20260813T160000Z", slotId: "live-shadow:20260813T160000Z", sourceMode: "LIVE", market, monitor, ts, d, a3 });
  const laterMarket = { ...market, generated_at: "2026-08-13T16:15:00.000Z", quotes: [{ source: "ROBINHOOD", symbol: "SPY", last: 105 }] };
  const later = buildPositionCopilotState({ runId: "live-shadow:20260813T161500Z", slotId: "live-shadow:20260813T161500Z", sourceMode: "LIVE", market: laterMarket, monitor, ts, d, a3, previous: first });
  assert.deepEqual(later.holdings[0].discovery_context, first.holdings[0].discovery_context);
  const reentryMonitor = { ...monitor, positions: [{ ...monitor.positions[0], position_id: `${monitor.positions[0].position_id}-r2` }] };
  const reentry = buildPositionCopilotState({ runId: "live-shadow:20260813T163000Z", slotId: "live-shadow:20260813T163000Z", sourceMode: "LIVE", market: laterMarket, monitor: reentryMonitor, ts, d, a3, previous: later, observedAt: "2026-08-13T16:30:00.000Z" });
  assert.notEqual(reentry.holdings[0].holding_id, first.holdings[0].holding_id);
  assert.equal(reentry.holdings[0].position_id.endsWith("-r2"), true);
  assert.equal(reentry.holdings[0].discovery_context.first_seen_at, "2026-08-13T16:30:00.000Z");
});

test("position actions require matching D and A3, while unsupported holdings remain visible", () => {
  const wait = buildPositionCopilotState({ runId: "live-shadow:20260813T161500Z", slotId: "live-shadow:20260813T161500Z", sourceMode: "LIVE", market, monitor, ts, d: { ...d, action: "MANUAL_REDUCE" }, a3 });
  assert.equal(wait.holdings[0].owner_action, "WAIT");
  const reduced = buildPositionCopilotState({ runId: "live-shadow:20260813T163000Z", slotId: "live-shadow:20260813T163000Z", sourceMode: "LIVE", market, monitor, ts, d: { ...d, action: "MANUAL_REDUCE" }, a3: { ...a3, decision: "MANUAL_ADJUST" }, previous: wait, observedAt: "2026-08-13T16:30:00.000Z" });
  assert.equal(reduced.holdings[0].owner_action, "REDUCE");
  assert.match(reduced.change_summary, /WAIT.*REDUCE/);
  const other = { ...market, account: { ...market.account, positions: [{ ...position, contract_id: "nok-call", symbol: "NOK" }] } };
  assert.equal(buildPositionCopilotState({ runId: "live-shadow:20260813T164500Z", slotId: "live-shadow:20260813T164500Z", sourceMode: "LIVE", market: other, monitor: null, ts, d, a3 }).holdings[0].owner_action, "NOT_SUPPORTED");
});

test("14+ DTE holdings use multi-timeframe evidence and reject a short-TS-only exit", () => {
  const expiration = "2027-02-19";
  const longPosition = { ...position, contract_id: "spy-long-call", expiration };
  const longMonitor = { ...monitor, positions: [{ ...monitor.positions[0], position_id: `SPY-call-${expiration}-100`, dte: 190, plan_status: "ACTIVE", monitor_status: "HEALTHY" }] };
  const longMarket = { ...market, account: { ...market.account, positions: [longPosition] }, approved_capabilities: { fixed_pool: { rows: [{ symbol: "SPY", support: 95, resistance: 110, swing: { stage: "CONFIRMED", direction: "BULLISH", management: { price_invalidation: 94, time_invalidation_date: "2026-12-31", target_1: 108, target_2: 115, next_check: "下一自然波段槽" } } }] } } };
  const bound = { underlying: "SPY", option_side: "call", expiration, strike: 100 };
  const state = buildPositionCopilotState({ runId: "live-shadow:20260813T170000Z", slotId: "live-shadow:20260813T170000Z", sourceMode: "LIVE", market: longMarket, monitor: longMonitor, ts, d: { ...bound, action: "MANUAL_EXIT" }, a3: { ...bound, decision: "MANUAL_EXIT" } });
  assert.deepEqual([state.holdings[0].holding_horizon, state.holdings[0].owner_action], ["LONG_90_PLUS", "WAIT"]);
  assert.deepEqual([state.holdings[0].price_invalidation, state.holdings[0].target_1, state.holdings[0].target_2], [94, 108, 115]);
  assert.match(state.holdings[0].data_gaps.join(" "), /短周期 TS.*不能单独推翻/);
});

test("holding targets never borrow the opposite research direction or an expired research deadline", () => {
  const held = { ...position, symbol: "AVGO", contract_id: "avgo-call", expiration: "2027-02-19" };
  const heldMarket = { ...market, account: { ...market.account, positions: [held] }, approved_capabilities: { fixed_pool: { rows: [{ symbol: "AVGO", support: 95, resistance: 110, swing: { stage: "CONFIRMED", direction: "BEARISH", management: { price_invalidation: 110, time_invalidation_date: "2026-08-12", target_1: 94, target_2: 90 } } }] } } };
  const state = buildPositionCopilotState({ runId: "risk-test", slotId: "risk-test", sourceMode: "LIVE", market: heldMarket, monitor: null, ts, d, a3 });
  const row = state.holdings[0];
  assert.deepEqual([row.price_invalidation, row.target_1, row.target_2], [null, null, null]);
  assert.equal(row.time_invalidation, held.expiration);
  assert.match(row.data_gaps.join(" "), /方向.*不一致/);
  const aligned = structuredClone(heldMarket);
  aligned.approved_capabilities.fixed_pool.rows[0].swing.direction = "BULLISH";
  aligned.approved_capabilities.fixed_pool.rows[0].swing.management = { price_invalidation: 94, time_invalidation_date: "2026-08-12", target_1: 108, target_2: 115 };
  assert.equal(buildPositionCopilotState({ runId: "risk-test", slotId: "risk-test", sourceMode: "LIVE", market: aligned, monitor: null, ts, d, a3 }).holdings[0].time_invalidation, held.expiration);
  const shortTs = { ...ts, symbol_outlooks: { ...ts.symbol_outlooks, SPY: { direction: "BEARISH" } } };
  assert.equal(buildPositionCopilotState({ runId: "risk-test", slotId: "risk-test", sourceMode: "LIVE", market, monitor, ts: shortTs, d, a3 }).holdings[0].target_1, null);
});

test("deterministic checks cover all real holdings without TS or entry approval and use only bound plans", () => {
  assert.equal(typeof positionRisk.assessPositionRisks, "function");
  const account = { ...market.account, source: "ROBINHOOD", as_of: observedAt, positions: [
    { ...position, bid: 1.2, ask: 1.3 },
    { ...position, symbol: "AVGO", contract_id: "avgo-call" },
    { ...position, symbol: "NOK", contract_id: "nok-put", option_type: "put" },
    { ...position, symbol: "TSLA", contract_id: "tsla-short", direction: "short" },
  ] };
  const check = positionRisk.assessPositionRisks(account, monitor, observedAt, account);
  assert.equal(check.checks_completed, true);
  assert.equal(check.observations.length, 4);
  assert.equal(check.observations[0].exit_return_pct, -40);
  assert.ok(check.observations[0].risks.includes("APPROVED_STOP_REACHED"));
  assert.equal(check.observations[1].quote_status, "LIVE");
  assert.ok(check.observations[1].risks.includes("PLAN_NOT_BOUND"));
  assert.equal(check.observations[2].exit_return_pct, 20);
  assert.equal(check.observations[3].exit_return_pct, null);
  assert.ok(check.observations[3].risks.includes("POSITION_MODEL_UNSUPPORTED"));
  assert.equal(check.automated_execution, false);
  const changed = { ...account, positions: [{ ...account.positions[0], quantity: 3 }] };
  assert.ok(positionRisk.assessPositionRisks(changed, monitor, observedAt, account).observations[0].risks.includes("PLAN_NOT_BOUND"));
  assert.ok(!positionRisk.assessPositionRisks(changed, monitor, observedAt, account).observations[0].risks.includes("APPROVED_STOP_REACHED"));
  const ambiguous = { ...account, positions: [...account.positions, { ...account.positions[0], account_label: "账户 2" }] };
  assert.equal(positionRisk.assessPositionRisks(ambiguous, monitor, observedAt, ambiguous).observations[0].plan_run_id, null);
  const noReceipt = { ...monitor, positions: [{ ...monitor.positions[0], plan_receipt_hash: null }] };
  assert.equal(positionRisk.assessPositionRisks(account, noReceipt, observedAt, account).observations[0].plan_run_id, null);
  const laterAccount = { ...account, as_of: "2026-08-13T16:01:00.000Z", positions: account.positions.map((p) => ({ ...p, as_of: "2026-08-13T16:01:00.000Z" })) };
  assert.equal(positionRisk.assessPositionRisks(laterAccount, monitor, laterAccount.as_of, account).observations[0].plan_run_id, "run-1");
  const put = { ...position, option_type: "put", bid: 3.2, ask: 3.3 };
  const putAccount = { ...account, positions: [put] };
  const putMonitor = { ...monitor, positions: [{ ...monitor.positions[0], position_id: "SPY-put-2026-08-14-100" }] };
  const gain = positionRisk.assessPositionRisks(putAccount, putMonitor, observedAt, putAccount).observations[0];
  assert.equal(gain.exit_return_pct, 60);
  assert.ok(gain.risks.includes("APPROVED_TARGET_REACHED"));
  const expiredAt = "2026-08-17T16:00:00.000Z", expiredAccount = { ...account, as_of: expiredAt, positions: [{ ...account.positions[0], as_of: expiredAt }] };
  const expired = positionRisk.assessPositionRisks(expiredAccount, monitor, expiredAt, account).observations[0];
  assert.equal(expired.plan_run_id, null);
  assert.ok(expired.risks.includes("POSITION_EXPIRED"));
});

test("risk observations preserve quote freshness, account failure and unsupported price evidence", () => {
  assert.equal(typeof positionRisk.assessPositionRisks, "function");
  const at = "2026-08-13T16:03:00.000Z";
  const account = { ...market.account, source: "ROBINHOOD", as_of: at, positions: [position, { ...position, contract_id: "future", as_of: "2026-08-13T17:00:00.000Z" }, { ...position, contract_id: "empty", bid: null, ask: null, mark: 20 }] };
  const check = positionRisk.assessPositionRisks(account, null, at);
  assert.equal(check.checks_completed, true);
  assert.deepEqual(check.observations.map((p) => p.quote_status), ["STALE", "UNAVAILABLE", "UNAVAILABLE"]);
  assert.ok(check.observations.every((p) => p.exit_return_pct === null));
  assert.equal(positionRisk.assessPositionRisks({ ...account, status: "DATA_BLOCKED" }, null, at).checks_completed, false);
  assert.equal(positionRisk.assessPositionRisks({ ...account, as_of: observedAt }, null, at).status, "DATA_BLOCKED");
  assert.equal(positionRisk.assessPositionRisks({ ...account, positions: [] }, null, at).status, "CHECKED");
});

test("legacy account indices and a changed stable account identity never inherit a holding plan", () => {
  const account = { ...market.account, source: "ROBINHOOD", as_of: observedAt };
  const legacy = { ...account, positions: [{ ...position, account_label: "账户 1" }] };
  const changed = { ...account, positions: [{ ...position, account_label: "账户-bbbbbbbbbbbbbbbb" }] };
  assert.equal(positionRisk.assessPositionRisks(account, monitor, observedAt, account).observations[0].plan_run_id, "run-1");
  for (const [current, original] of [[legacy, legacy], [account, legacy], [changed, account]]) {
    const checked = positionRisk.assessPositionRisks(current, monitor, observedAt, original);
    assert.equal(checked.checks_completed, true);
    assert.equal(checked.observations[0].plan_run_id, null);
    assert.ok(checked.observations[0].risks.includes("PLAN_NOT_BOUND"));
    assert.ok(!checked.observations[0].risks.includes("APPROVED_STOP_REACHED"));
  }
});

test("old holding advice with expired deadlines or reversed levels is never projected as current", () => {
  const state = { source_mode: "LIVE", observed_at: "2026-09-04T18:30:00.000Z" };
  const at = Date.parse("2026-09-04T19:00:00.000Z"), date = "2026-09-04";
  const holding = { option_type: "call", expiration: "2027-02-19", next_check_at: "2026-09-04T20:00:00.000Z", time_invalidation: "2026-09-04", price_invalidation: 98, target_1: 102, target_2: 104 };
  const original = structuredClone(holding);
  assert.equal(isHoldingAdviceCurrent(state, holding, date, at), true);
  assert.equal(isHoldingAdviceCurrent(state, { ...holding, time_invalidation: "2026-08-31" }, date, at), false);
  assert.equal(isHoldingAdviceCurrent(state, { ...holding, time_invalidation: "2026-09-04T18:59:59Z" }, date, at), false);
  assert.equal(isHoldingAdviceCurrent(state, { ...holding, time_invalidation: "not-a-date" }, date, at), false);
  assert.equal(isHoldingAdviceCurrent(state, { ...holding, price_invalidation: 432.73, target_1: 350.06 }, date, at), false);
  assert.equal(isHoldingAdviceCurrent(state, { ...holding, target_2: 98 }, date, at), false);
  assert.equal(isHoldingAdviceCurrent(state, { ...holding, option_type: "put" }, date, at), false);
  assert.equal(isHoldingAdviceCurrent(state, { ...holding, option_type: "put", price_invalidation: 105, target_1: 102, target_2: 98 }, date, at), true);
  assert.equal(isHoldingAdviceCurrent({ ...state, observed_at: "2026-09-04T19:01:00Z" }, holding, date, at), false);
  assert.equal(isHoldingAdviceCurrent({ ...state, source_mode: "REPLAY" }, holding, date, at), false);
  assert.deepEqual(holding, original);
});

test("gateway preserves immutable position advice across duplicate import and restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-position-copilot-")), file = join(directory, "state.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const first = buildPositionCopilotState({ runId: "live-shadow:20260813T160000Z", slotId: "live-shadow:20260813T160000Z", sourceMode: "LIVE", market, monitor, ts, d, a3 });
  const second = buildPositionCopilotState({ runId: "live-shadow:20260813T161500Z", slotId: "live-shadow:20260813T161500Z", sourceMode: "LIVE", market, monitor, ts, d: { ...d, action: "MANUAL_EXIT" }, a3: { ...a3, decision: "MANUAL_EXIT" }, previous: first, observedAt: "2026-08-13T16:15:00.000Z" });
  const envelope = (state) => JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `${state.source_run_id}:POSITION_COPILOT_STATE`, output_type: "POSITION_COPILOT_STATE", channel: "SHADOW", observed_at: state.observed_at, payload: state });
  let store = openSnapshotDatabase(file);
  assert.equal(store.importOutputRaw(envelope(first)).duplicate, false);
  assert.equal(store.importOutputRaw(envelope(first)).duplicate, true);
  assert.equal(store.importOutputRaw(envelope(second)).duplicate, false);
  const badLink = { ...second, source_run_id: "live-shadow:20260813T163000Z", state_id: `position-state-${"d".repeat(24)}`, previous_state_id: null, observed_at: "2026-08-13T16:30:00.000Z" };
  assert.throws(() => store.importOutputRaw(envelope(badLink)), /必须引用最近一条/);
  store.close(); store = openSnapshotDatabase(file);
  assert.deepEqual(store.getActive().outputs.POSITION_COPILOT_STATE.map((item) => item.holdings[0].owner_action), ["EXIT", "HOLD"]);
  assert.equal(store.getActive().outputs.POSITION_COPILOT_STATE[0].previous_state_id, first.state_id);
  store.close();
});

test("natural LIVE holding advice settles against immutable Robinhood bars", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-position-settlement-")), file = join(directory, "state.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const day = new Date(Date.now() + 86_400_000);
  while (!isNyseRegularSession(day.toISOString().slice(0, 10)) || nyseClosePtMinutes(day.toISOString().slice(0, 10)) !== 780) day.setUTCDate(day.getUTCDate() + 1);
  const marketDate = day.toISOString().slice(0, 10), observedAt = utcForPt(marketDate, "09:00").toISOString(), receivedAt = new Date(Date.parse(observedAt) + 1000).toISOString();
  const sessionOpen = utcForPt(marketDate, "06:30").getTime(), settledAt = utcForPt(marketDate, "13:01").toISOString(), runId = `live-shadow:${observedAt.replaceAll("-", "").replaceAll(":", "").replace(".000", "")}`;
  const currentPosition = { ...position, expiration: marketDate, as_of: observedAt };
  const currentMarket = { ...market, generated_at: observedAt, as_of: observedAt, market_session: { ...market.market_session, market_date: marketDate }, quotes: market.quotes.map((quote) => ({ ...quote, as_of: observedAt })), account: { ...market.account, as_of: observedAt, positions: [currentPosition] } };
  const currentMonitor = { ...monitor, checked_at: observedAt, positions: monitor.positions.map((item) => ({ ...item, position_id: `SPY-call-${marketDate}-100`, option_symbol: `SPY${marketDate.replaceAll("-", "").slice(2)}C00100000`, checked_at: observedAt, source_quote_at: observedAt, dte: 0 })) };
  const currentTs = { ...ts, evidence_snapshot: { ...ts.evidence_snapshot, run_id: `${runId.slice("live-shadow:".length)}-aaaaaaaaaa`, market_time: { observed_at: observedAt, market_date: marketDate } }, next_validation: { at: utcForPt(marketDate, "09:30").toISOString() } };
  const state = buildPositionCopilotState({ runId, slotId: runId, sourceMode: "LIVE", market: currentMarket, monitor: currentMonitor, ts: currentTs, d: { ...d, expiration: marketDate }, a3: { ...a3, expiration: marketDate }, observedAt });
  assert.deepEqual([state.holdings[0].time_invalidation, state.holdings[0].target_1, state.holdings[0].target_2], [marketDate, 102, 104]);
  const raw = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "natural:position", output_type: "POSITION_COPILOT_STATE", channel: "SHADOW", observed_at: state.observed_at, payload: state });
  let store = openSnapshotDatabase(file);
  store.importOutputRaw(raw, receivedAt);
  const bars = Array.from({ length: 78 }, (_, index) => ({ begins_at: new Date(sessionOpen + index * 300_000).toISOString(), open: 100 + index * .07, high: 100 + index * .07 + .08, low: 100 + index * .07 - .04, close: 100 + index * .07 + .04, volume: 1000 }));
  assert.equal(store.recordTsMarketCharts([{ source: "ROBINHOOD", symbol: "SPY", interval: "5m", status: "LIVE", bars }], settledAt).optionNewlySettled, 1);
  store.close(); store = openSnapshotDatabase(file);
  const settlement = store.getActive().optionLifecycle.recent_settlements[0];
  assert.deepEqual([settlement.action, settlement.outcome, settlement.scoreable, settlement.target_2_hit], ["HOLD", "TARGET_2", true, true]);
  assert.equal(settlement.observation_window.start_at, receivedAt);
  assert.equal(store.getActive().outputs.POSITION_COPILOT_STATE[0].holdings[0].discovery_context.evidence_hash.length, 64);
  store.close();
});
