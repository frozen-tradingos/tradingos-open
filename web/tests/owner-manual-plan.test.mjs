import assert from "node:assert/strict";
import test from "node:test";
import { projectOwnerManualPlans } from "../app/owner-manual-plan.ts";
import { projectStockManualPlans } from "../app/stock-manual-plan.ts";
import { assessPositionRisks } from "../server/position-copilot.ts";
import { ownerSnapshotView } from "../server/local-owner-server.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { buildCurrentTruth } from "../app/current-truth.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

// Isolated control-flow evidence, not a natural forecast, approval or Broker order.
const observedAt = "2026-09-04T16:00:00.000Z", now = Date.parse(observedAt);
const hash = "a".repeat(64), marketHash = "b".repeat(64), run = "live-shadow:20260904T160000Z";
const dateAt = (offset) => new Date(now + offset).toISOString();
function positionFixture() {
  const position = { symbol: "AVGO", option_type: "call", expiration: "2026-09-11", strike: 100, contract_id: "synthetic-avgo", account_label: "账户-aaaaaaaaaaaaaaaa", direction: "long", quantity: 3, average_price: 2, bid: 1.2, ask: 1.3, as_of: observedAt };
  const account = { source: "ROBINHOOD", status: "LIVE", as_of: observedAt, positions: [position] };
  const monitor = { positions: [{ position_id: "AVGO-call-2026-09-11-100", plan_status: "ACTIVE", plan_run_id: "synthetic-original-approval", plan_receipt_hash: hash, position_snapshot_hash: marketHash, checked_at: observedAt, stop_loss_pct: -30, take_profit_pct: 50 }] };
  const checkpoint = { kind: "POSITION_MONITOR", status: "SUCCEEDED", slot_id: "timeline:position_monitor:20260904:0900", completed_at: observedAt, position_check: assessPositionRisks(account, monitor, observedAt, account) };
  return { account, monitor, snapshot: { outputs: { SCHEDULE_CHECKPOINT: [checkpoint], OPTION_STRATEGY_SIGNAL: [], TS_SHADOW_OUTPUT: [] }, recentOutputs: [], runLedger: { runs: [] } } };
}
function buyFixture() {
  const snapshot = positionFixture().snapshot;
  snapshot.outputs.SCHEDULE_CHECKPOINT = [];
  const leg = { side: "BUY", option_type: "call", contract_id: "synthetic-spy", strike: 100, bid: 2, ask: 2.05, iv: 0.2, delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.08, open_interest: 200, volume: 100, as_of: observedAt };
  const candidate = { candidate_id: "option-candidate-synthetic", symbol: "SPY", strategy_type: "LONG_CALL", expiration: "2026-09-08", holding_horizon: "SHORT_2_7", legs: [leg], max_risk_usd: 205, entry_debit: 2.05, status: "PASS", liquidity: { status: "PASS" }, volatility_gate: { status: "PASS" }, market_edge: { covers_spread_and_decay: true }, data_gaps: [] };
  const ts = { evidence_snapshot: { run_id: "20260904T160000Z-aaaaaaaaaa", market_time: { observed_at: observedAt, market_date: "2026-09-04", state: "OPEN" } }, forecast_window: { start_at: observedAt, end_at: dateAt(3_600_000) }, next_validation: { at: dateAt(1_800_000) }, tradeability: { status: "READY_FOR_D_REVIEW" }, symbol_outlooks: { SPY: { direction: "BULLISH" } } };
  ts.scenarios = { main: { sequence: [{ conditions: [{ symbol: "SPY", metric: "LAST_PRICE", operator: "ABOVE", value: 105, upper_value: null, confirmation: "ONE_5M_CLOSE" }] }] } };
  snapshot.outputs.TS_SHADOW_OUTPUT = [ts];
  snapshot.outputs.OPTION_STRATEGY_SIGNAL = [{ source_mode: "LIVE", mode: "SHADOW", automated_execution: false, source_run_id: run, slot_id: run, signal_id: "option-signal-synthetic", observed_at: observedAt, data_cutoff_at: observedAt, market_snapshot_id: "market-synthetic", market_snapshot_hash: marketHash, ts_run_id: ts.evidence_snapshot.run_id, d_action: "MANUAL_BUY", a3_decision: "MANUAL_BUY", owner_action: "EXECUTABLE", decision_basis: "EXECUTABLE", selected_candidate_id: candidate.candidate_id, candidates: [candidate], risk_summary: { context_hash: hash, core_hard_block_count: 0, new_entry_block_count: 0, issues: [] }, data_gaps: [] }];
  const market = { snapshot_id: "market-synthetic", snapshot_hash: marketHash, generated_at: observedAt, as_of: observedAt, status: "LIVE", market_session: { state: "REGULAR", market_date: "2026-09-04" }, quotes: ["SPY", "QQQ"].map((symbol) => ({ symbol, source: "ROBINHOOD", status: "LIVE", as_of: observedAt, last: 100, bid: 99.99, ask: 100.01 })), account: { source: "ROBINHOOD", status: "LIVE", as_of: observedAt, positions: [] } };
  snapshot.outputs.A1_SHADOW_RESULT = { source_mode: "LIVE", status: "HEALTHY", market_sources: market };
  snapshot.outputs.A2_SHADOW_RESULT = { source_mode: "LIVE", status: "HEALTHY" };
  const terms = { underlying: "SPY", option_side: "call", expiration: candidate.expiration, strike: 100, quantity: 1, max_entry_debit: 250, stop_loss_pct: -30, take_profit_pct: 50, invalidation: ["Underlying loses approved support"] };
  snapshot.outputs.D_SHADOW_OUTPUT = { ...terms, action: "MANUAL_BUY", entry_conditions: ["Owner confirms approved entry condition"], data_gaps: [] };
  snapshot.outputs.A3_FINAL_SHADOW = { ...terms, decision: "MANUAL_BUY", data_status: "HEALTHY" };
  const components = { A1: "A1_SHADOW_RESULT", A2: "A2_SHADOW_RESULT", TS: "TS_SHADOW_OUTPUT", COMMITTEE: "COMMITTEE_SHADOW_OUTPUT", D: "D_SHADOW_OUTPUT", A3: "A3_FINAL_SHADOW", CODEX_GUARD: "CODEX_GUARD_SHADOW" };
  snapshot.recentOutputs = Object.entries(components).map(([component, output_type]) => ({ record_id: `${run}:${component}`, output_type, channel: "SHADOW", observed_at: observedAt }));
  snapshot.runLedger.runs = Object.keys(components).map((agent_id) => ({ agent_id, skill_id: agent_id === "A3" ? "A3_FINAL_LIVE_SHADOW" : `${agent_id}_LIVE_SHADOW`, run_id: run, slot_id: run, channel: "SHADOW", status: "SUCCEEDED", output_status: "PRODUCED", website_delivery: "DELIVERED", evidence_refs: [] }));
  snapshot.currentTruth = { source_mode: "LIVE", run_id: run, forecast_id: ts.evidence_snapshot.run_id, market_session: "REGULAR", health_status: "HEALTHY", natural_slot: { slot_id: run, status: "SUCCEEDED", statistical_eligibility: "ELIGIBLE_NATURAL_EVIDENCE" }, market_data_health: { quote_health: "LIVE", bar_health: "LIVE" } };
  return snapshot;
}

test("manual exit uses the exact bound original threshold and preserves source lifetime and bytes", () => {
  const { snapshot } = positionFixture(), original = JSON.stringify(snapshot);
  const row = snapshot.outputs.SCHEDULE_CHECKPOINT[0].position_check.observations[0];
  row.quote_as_of = dateAt(-119_000);
  const before = JSON.stringify(snapshot), first = projectOwnerManualPlans(snapshot, now), later = projectOwnerManualPlans(snapshot, now + 1_000);
  assert.equal(first.plans.length, 1);
  const plan = first.plans[0];
  assert.equal(plan.side, "SELL_TO_CLOSE");
  assert.equal(plan.holding_id, row.holding_id);
  assert.equal(plan.symbol, "AVGO", "an already-approved non-SPY/QQQ exit is not a new-entry candidate");
  assert.equal(plan.quantity, 3);
  assert.equal(plan.quantity_basis, "HELD_MAX_CONFIRM_OWNER");
  assert.equal(plan.trigger_state, "OBSERVED");
  assert.equal(plan.reference_price, 1.2);
  assert.equal(plan.valid_until, dateAt(1_000));
  assert.equal(later.plans[0].plan_id, plan.plan_id);
  assert.equal(later.plans[0].valid_until, plan.valid_until);
  assert.equal(projectOwnerManualPlans(snapshot, now + 1_001).plans.length, 0);
  assert.equal(plan.automated_execution, false);
  assert.equal(plan.owner_confirmation_required, true);
  assert.match(plan.first_target, /50%/);
  assert.match(plan.holding_period, /未给出剩余持有时长/);
  assert.match(plan.approval_ref, new RegExp(hash));
  assert.equal(JSON.stringify(snapshot), before);
  assert.notEqual(original, before, "only the fixture setup changed its source timestamp");
});

test("stale, future, missing, failed, unbound and expiry-only checks never become sell plans", () => {
  const mutations = [
    (cp) => { cp.status = "FAILED"; },
    (cp) => { cp.slot_id = "replay:position-monitor"; },
    (cp) => { cp.position_check.account_status = "DATA_BLOCKED"; },
    (cp) => { cp.position_check.checks_completed = false; },
    ...["checked_at", "account_as_of"].flatMap((key) => [dateAt(-120_001), dateAt(1), null, "invalid"].map((value) => (cp) => { cp.position_check[key] = value; })),
    ...[dateAt(-120_001), dateAt(1), null, "invalid"].map((value) => (cp) => { cp.position_check.observations[0].quote_as_of = value; }),
    ...[
      { plan_receipt_hash: null }, { plan_status: "PLAN_NOT_BOUND" }, { plan_run_id: null }, { quantity: 0 }, { direction: "short" }, { contract_id: null }, { bid: 0 }, { ask: 0.5 },
      { dte: -1, expiration: "2026-09-03", risks: ["POSITION_EXPIRED"] },
      { risks: ["PLAN_NOT_BOUND", "APPROVED_STOP_REACHED"] }, { risks: ["EXPIRY_TODAY"] }, { risks: ["APPROVED_TARGET_REACHED"] },
    ].map((change) => (cp) => Object.assign(cp.position_check.observations[0], change)),
  ];
  for (const mutate of mutations) {
    const { snapshot } = positionFixture();
    mutate(snapshot.outputs.SCHEDULE_CHECKPOINT[0]);
    assert.equal(projectOwnerManualPlans(snapshot, now).plans.length, 0, String(mutate));
  }
  assert.equal(projectOwnerManualPlans(positionFixture().snapshot, Number.NaN).plans.length, 0);
  const { snapshot } = positionFixture();
  snapshot.outputs.SCHEDULE_CHECKPOINT.unshift({ ...snapshot.outputs.SCHEDULE_CHECKPOINT[0], status: "FAILED", position_check: undefined });
  assert.equal(projectOwnerManualPlans(snapshot, now).plans.length, 0, "never fall back to an older successful check");
});

test("missing original approval and changed quantity cannot inherit a plan or Owner text approval", () => {
  const { snapshot, account, monitor } = positionFixture();
  const cp = snapshot.outputs.SCHEDULE_CHECKPOINT[0];
  cp.position_check = assessPositionRisks({ ...account, positions: [{ ...account.positions[0], quantity: 2 }] }, monitor, observedAt, account);
  snapshot.ownerPositionContext = { original_logic: "Owner wants to exit", stop_loss_pct: -30, approved: true };
  assert.equal(projectOwnerManualPlans(snapshot, now).plans.length, 0);
  assert.ok(projectOwnerManualPlans(snapshot, now).risks.gaps[0].risks.includes("PLAN_NOT_BOUND"));
});

test("position protection is independent of new-entry blocks and preserves sibling expiry warnings", () => {
  const { snapshot } = positionFixture(), check = snapshot.outputs.SCHEDULE_CHECKPOINT[0].position_check;
  check.observations.push({ ...check.observations[0], holding_id: "expired-sibling", expiration: "2026-09-03", dte: -1, risks: ["POSITION_EXPIRED"] });
  snapshot.currentTruth = { health_status: "BLOCKED" };
  const projected = projectOwnerManualPlans(snapshot, now);
  assert.equal(projected.plans.length, 1);
  assert.ok(projected.risks.alerts.some((row) => row.risks.includes("POSITION_EXPIRED")));
});

test("same-day expiry never hides an approved fresh stop or target, but is not itself approval", () => {
  for (const bid of [1.2, 3.2]) {
    const { snapshot, account, monitor } = positionFixture();
    account.positions[0] = { ...account.positions[0], bid, ask: bid + 0.1, expiration: "2026-09-04" };
    monitor.positions[0].position_id = "AVGO-call-2026-09-04-100";
    snapshot.outputs.SCHEDULE_CHECKPOINT[0].position_check = assessPositionRisks(account, monitor, observedAt, account);
    const result = projectOwnerManualPlans(snapshot, now);
    assert.equal(result.plans[0].side, "SELL_TO_CLOSE");
    assert.ok(result.risks.alerts[0].risks.includes("EXPIRY_TODAY"));
    assert.match(result.plans[0].trigger, bid < 2 ? /止损/ : /止盈/);
  }
});

test("buy projection requires an existing complete formal approval and remains Owner-confirmed", () => {
  const snapshot = buyFixture(), before = JSON.stringify(snapshot);
  Object.defineProperty(snapshot.outputs, "TS_SIGNAL_CANDIDATE", { get() { throw new Error("unvalidated candidate must never be read"); } });
  const result = projectOwnerManualPlans(snapshot, now);
  assert.deepEqual(result.blocked_reasons.filter((reason) => reason.startsWith("买入")), []);
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].side, "BUY_TO_OPEN");
  assert.equal(result.plans[0].quantity_basis, "APPROVED");
  assert.equal(result.plans[0].trigger_state, "OWNER_CHECK_REQUIRED");
  assert.equal(result.plans[0].valid_until, dateAt(120_000));
  assert.equal(result.plans[0].reference_price, 2.05);
  assert.equal(result.plans[0].max_debit_usd, 250);
  assert.match(result.plans[0].first_target, /105.00/);
  assert.match(result.plans[0].holding_period, /2–7 DTE/);
  assert.equal(JSON.stringify(snapshot), before);
});

test("filtering a stock entry must not consume bound holding exits when an index plan replaces stock entries", () => {
  const snapshot = buyFixture(), held = positionFixture();
  held.account.positions.push({ ...held.account.positions[0], symbol: "NOK", contract_id: "synthetic-nok", quantity: 2 });
  held.monitor.positions.push({ ...held.monitor.positions[0], position_id: "NOK-call-2026-09-11-100" });
  const checkpoint = held.snapshot.outputs.SCHEDULE_CHECKPOINT[0];
  checkpoint.position_check = assessPositionRisks(held.account, held.monitor, observedAt, held.account);
  snapshot.outputs.SCHEDULE_CHECKPOINT = [checkpoint];
  snapshot.outputs.A1_SHADOW_RESULT.market_sources.account = held.account;
  const values = Array.from({ length: 24 }, (_, index) => {
    const base = 100 + Math.floor(index / 3) * 0.8;
    return { begins_at: new Date(Date.parse("2026-09-04T13:55:00.000Z") + index * 300_000).toISOString(), open: base + 0.1, high: base + 0.9, low: base, close: base + 0.6, volume: 100 };
  });
  values[9].low = 100.5;
  values[22] = { ...values[22], open: 106.1, high: 107.2, low: 106, close: 107 };
  values[23] = { ...values[23], open: 107, high: 107.4, low: 106.6, close: 107.1 };
  const stockContract = { ...snapshot.outputs.OPTION_STRATEGY_SIGNAL[0].candidates[0].legs[0], contract_id: "synthetic-nvda", expiration: "2026-09-11", strike: 110, mark: 2.025, history_bars: 0, history_as_of: null,
    instrument: { chain_id: "synthetic-nvda-chain", chain_symbol: "NVDA", expiration_date: "2026-09-11", strike_price: 110, type: "call", state: "active", tradability: "tradable", trade_value_multiplier: 100 } };
  delete stockContract.side;
  const evidence = { contract_version: "stock-plan-v1", evidence_id: hash, run_id: run, slot_id: run, source_mode: "LIVE", mode: "SHADOW", automated_execution: false, observed_at: dateAt(-2_000), received_at: observedAt, source_snapshot_id: "synthetic-stock", source_snapshot_hash: marketHash, symbol: "NVDA", instrument_type: "EQUITY", direction: "BULLISH",
    quote: { source: "ROBINHOOD", symbol: "NVDA", status: "LIVE", last: 107.2, bid: 107.19, ask: 107.21, as_of: observedAt }, bars: { source: "ROBINHOOD", symbol: "NVDA", interval: "5min", as_of: "2026-09-04T15:55:00.000Z", values }, pattern: { source: "A2_CLASSIFY_PATTERN_V1", regime: "TREND_UP", direction: "bullish" }, contracts: [stockContract],
    account: { ...held.account, freshness_seconds: 0, account_count: 1, orders: null, portfolio_value: null, option_value: null, realized_pnl: null, positions: held.account.positions.map((row) => ({ ...row, mark: null, iv: null, delta: null, gamma: null, theta: null, vega: null, open_interest: null, volume: null })) },
    news: { checked_at: observedAt, status: "LIVE", items: [{ id: "synthetic-news", headline: "Synthetic company release", url: "https://example.com/test", source: "SYNTHETIC", published_at: dateAt(-60_000), expires_at: dateAt(3_600_000), verified: true, market_moving: false, symbols: ["NVDA"] }] }, global_risk: { checked_at: observedAt, critical_blockers: [], new_entry_blockers: [] }, data_gaps: [] };
  const terms = { contract_version: "stock-plan-v1", evidence_id: hash, observed_at: observedAt, action: "MANUAL_BUY", symbol: "NVDA", contract_id: stockContract.contract_id, option_type: "call", expiration: stockContract.expiration, strike: 110, quantity: 1, max_entry_debit: 220, stop_loss_pct: -30, take_profit_pct: 50, score: 9, entry_conditions: ["Synthetic approved trigger"], invalidation: ["Synthetic support fails"], target_price: 112, reasons: ["Synthetic independent approval"] };
  snapshot.outputs.STOCK_MANUAL_PLAN = [{ contract_version: "stock-plan-v1", component: "STOCK_MANUAL_PLAN", mode: "SHADOW", source_mode: "LIVE", automated_execution: false, run_id: run, slot_id: run, observed_at: observedAt, evidence, decisions: [{ ...terms, role: "D", decision_id: "synthetic-stock-D", invocation_id: "synthetic-call-D" }, { ...terms, role: "A3", decision_id: "synthetic-stock-A3", invocation_id: "synthetic-call-A3" }], status: "APPROVED", blocked_reasons: [] }];
  assert.equal(projectStockManualPlans(snapshot.outputs.STOCK_MANUAL_PLAN, now).plans.length, 1, "the frozen stock approval really exists before current-source filtering");
  snapshot.dataSources = [{ source: "FINNHUB", authorization: "EXPIRED", checked_at: observedAt }];
  const before = JSON.stringify(snapshot), result = projectOwnerManualPlans(snapshot, now);
  assert.match(result.blocked_reasons.join(";"), /FINNHUB最新授权/);
  assert.deepEqual(result.plans.map((plan) => [plan.symbol, plan.side]), [["AVGO", "SELL_TO_CLOSE"], ["NOK", "SELL_TO_CLOSE"], ["SPY", "BUY_TO_OPEN"]]);
  assert.equal(JSON.stringify(snapshot), before);
});

test("candidate, mismatched approval, incomplete delivery, market blocks and spreads cannot produce buys", () => {
  const cases = [
    (s) => { s.outputs.OPTION_STRATEGY_SIGNAL[0].owner_action = "WAIT"; },
    (s) => { s.outputs.OPTION_STRATEGY_SIGNAL[0].source_mode = "REPLAY"; },
    (s) => { s.outputs.OPTION_STRATEGY_SIGNAL[0].risk_summary.new_entry_block_count = 1; },
    (s) => { s.outputs.OPTION_STRATEGY_SIGNAL[0].candidates[0].status = "BLOCKED"; },
    (s) => { s.outputs.OPTION_STRATEGY_SIGNAL[0].candidates[0].strategy_type = "CALL_DEBIT_SPREAD"; },
    (s) => { s.outputs.OPTION_STRATEGY_SIGNAL[0].candidates[0].volatility_gate.status = "BLOCKED"; },
    (s) => { s.outputs.TS_SHADOW_OUTPUT[0].tradeability.status = "WAIT"; },
    (s) => { s.outputs.TS_SHADOW_OUTPUT[0].forecast_window.start_at = "invalid"; },
    (s) => { s.outputs.TS_SHADOW_OUTPUT[0].scenarios.main.sequence = []; },
    (s) => { s.outputs.D_SHADOW_OUTPUT.quantity = 2; },
    (s) => { s.outputs.D_SHADOW_OUTPUT.data_gaps = ["approval evidence missing"]; },
    (s) => { s.outputs.D_SHADOW_OUTPUT.entry_conditions = []; },
    (s) => { s.outputs.A3_FINAL_SHADOW.decision = "MANUAL_EXIT"; },
    (s) => { s.outputs.A3_FINAL_SHADOW.data_status = "DEGRADED"; },
    (s) => { s.outputs.A3_FINAL_SHADOW.max_entry_debit = 100; },
    (s) => { s.recentOutputs.find((row) => row.output_type === "D_SHADOW_OUTPUT").record_id = "other-run:D"; },
    (s) => { s.runLedger.runs.find((row) => row.agent_id === "A3").skill_id = "A3_REVIEW_LIVE_SHADOW"; },
    (s) => { s.runLedger.runs.find((row) => row.agent_id === "D").website_delivery = "FAILED"; },
    (s) => { s.currentTruth.forecast_id = "another-forecast"; },
    (s) => { s.currentTruth.health_status = "BLOCKED"; },
    (s) => { s.currentTruth.natural_slot.statistical_eligibility = "NOT_ELIGIBLE"; },
    (s) => { s.outputs.A1_SHADOW_RESULT.market_sources.status = "STALE"; },
    (s) => { s.outputs.A1_SHADOW_RESULT.market_sources.snapshot_hash = hash; },
    (s) => { s.outputs.A1_SHADOW_RESULT.market_sources.quotes[0].status = "STALE"; },
    (s) => { s.outputs.A1_SHADOW_RESULT.market_sources.account.status = "DATA_BLOCKED"; },
  ];
  for (const mutate of cases) {
    const snapshot = buyFixture(); mutate(snapshot);
    const result = projectOwnerManualPlans(snapshot, now);
    assert.equal(result.plans.length, 0, String(mutate));
    assert.ok(result.blocked_reasons.length, "missing evidence has an explicit reason");
  }
});

test("existing degraded IV maturity and optional department gaps do not invent new trading gates", () => {
  const snapshot = buyFixture();
  snapshot.outputs.OPTION_STRATEGY_SIGNAL[0].candidates[0].volatility_gate.status = "DEGRADED";
  snapshot.outputs.A2_SHADOW_RESULT.status = "DEGRADED";
  snapshot.recentOutputs = snapshot.recentOutputs.filter((row) => !["CODEX_GUARD_SHADOW", "COMMITTEE_SHADOW_OUTPUT"].includes(row.output_type));
  snapshot.runLedger.runs = snapshot.runLedger.runs.filter((row) => !["CODEX_GUARD", "COMMITTEE"].includes(row.agent_id));
  assert.equal(projectOwnerManualPlans(snapshot, now).plans[0].side, "BUY_TO_OPEN");
  snapshot.outputs.OPTION_STRATEGY_SIGNAL[0].risk_summary.new_entry_block_count = 1;
  snapshot.outputs.OPTION_STRATEGY_SIGNAL[0].risk_summary.issues = [{ layer: "NEW_ENTRY_BLOCK", scope: "QQQ" }];
  assert.equal(projectOwnerManualPlans(snapshot, now).plans[0].side, "BUY_TO_OPEN", "QQQ-only blocking never blocks a formally approved SPY plan");
  snapshot.outputs.OPTION_STRATEGY_SIGNAL[0].risk_summary.issues[0].scope = "SPY";
  assert.equal(projectOwnerManualPlans(snapshot, now).plans.length, 0);
});

test("real snapshot views retain only required same-run plan provenance and preserve null account evidence", () => {
  const store = openSnapshotDatabase(":memory:", { investmentProfile: "BLANK" });
  try {
    const state = store.getActive(), fixture = buyFixture();
    const snapshot = { ...state, ...fixture, outputs: { ...state.outputs, ...fixture.outputs }, dataSources: [{ source: "ROBINHOOD", status: "LIVE", authorization: "VALID", as_of: observedAt, checked_at: observedAt, capabilities: { market_quotes: true, intraday_bars: true } }] };
    snapshot.runLedger.runs = snapshot.runLedger.runs.map((row) => ({ ...row, data_cutoff_at: observedAt, event_at: observedAt, received_at: observedAt }));
    snapshot.currentTruth = buildCurrentTruth(snapshot, now);
    assert.equal(snapshot.currentTruth.market_session, "REGULAR", "use actual Robinhood current-truth contract, not SPX RTH");
    const expected = projectOwnerManualPlans(snapshot, now);
    assert.equal(expected.plans.length, 1);
    snapshot.runLedger.runs.unshift(...Array.from({ length: 35 }, (_, index) => ({ ...snapshot.runLedger.runs[0], run_id: `unrelated-${index}`, skill_id: "CODEX_MANAGER_AUDIT" })));
    const original = JSON.stringify(snapshot);
    for (const view of ["home", "options"]) {
      const compact = ownerSnapshotView(snapshot, view);
      assert.equal(compact.recentOutputs.length, 5);
      assert.deepEqual(projectOwnerManualPlans(compact, now).plans, expected.plans);
      assert.equal(compact.runLedger.runs.filter((row) => row.run_id === run).length, 5);
    }
    assert.equal(JSON.stringify(snapshot), original);
    snapshot.outputs.A1_SHADOW_RESULT.market_sources.account.positions = null;
    for (const view of ["home", "options"]) {
      const compact = ownerSnapshotView(snapshot, view);
      assert.equal(compact.outputs.A1_SHADOW_RESULT.market_sources.account.positions, null);
      assert.equal(projectOwnerManualPlans(compact, now).plans.length, 0, "null positions never masquerades as a complete empty account");
    }
  } finally { store.close(); }
});

test("buy time uses original account and quote clocks, forecast deadline and real regular session", () => {
  for (const value of [dateAt(-420_001), dateAt(1), "invalid", null]) {
    const snapshot = buyFixture();
    snapshot.outputs.OPTION_STRATEGY_SIGNAL[0].candidates[0].legs[0].as_of = value;
    assert.equal(projectOwnerManualPlans(snapshot, now).plans.length, 0);
  }
  const snapshot = buyFixture();
  snapshot.outputs.OPTION_STRATEGY_SIGNAL[0].candidates[0].legs[0].as_of = dateAt(-419_000);
  assert.equal(projectOwnerManualPlans(snapshot, now).plans[0].valid_until, dateAt(1_000));
  assert.equal(projectOwnerManualPlans(snapshot, now + 1_001).plans.length, 0);
  const expiry = buyFixture();
  expiry.outputs.TS_SHADOW_OUTPUT[0].next_validation.at = dateAt(1_000);
  assert.equal(projectOwnerManualPlans(expiry, now).plans[0].valid_until, dateAt(1_000));
  assert.equal(projectOwnerManualPlans(expiry, now + 1_001).plans.length, 0);
  assert.equal(projectOwnerManualPlans(buyFixture(), Date.parse("2026-09-05T16:00:00Z")).plans.length, 0);
});

test("plan lifetime ends at actual RTH close, including early close and winter time", () => {
  for (const [before, close] of [["2026-09-04T19:59:30.000Z", "2026-09-04T20:00:00.000Z"], ["2026-11-27T17:59:30.000Z", "2026-11-27T18:00:00.000Z"]]) {
    const at = Date.parse(before), { snapshot, account, monitor } = positionFixture();
    account.as_of = before;
    account.positions[0] = { ...account.positions[0], as_of: before, expiration: "2026-12-18" };
    monitor.positions[0] = { ...monitor.positions[0], checked_at: before, position_id: "AVGO-call-2026-12-18-100" };
    snapshot.outputs.SCHEDULE_CHECKPOINT[0].position_check = assessPositionRisks(account, monitor, before, account);
    assert.equal(projectOwnerManualPlans(snapshot, at).plans[0].valid_until, close);
    assert.equal(projectOwnerManualPlans(snapshot, Date.parse(close)).plans.length, 0);
    const buy = JSON.parse(JSON.stringify(buyFixture()).replaceAll(observedAt, before));
    const ts = buy.outputs.TS_SHADOW_OUTPUT[0], signal = buy.outputs.OPTION_STRATEGY_SIGNAL[0];
    ts.evidence_snapshot.market_time.market_date = before.slice(0, 10);
    ts.forecast_window.end_at = new Date(at + 3_600_000).toISOString();
    ts.next_validation.at = new Date(at + 1_800_000).toISOString();
    buy.outputs.A1_SHADOW_RESULT.market_sources.market_session.market_date = before.slice(0, 10);
    signal.candidates[0].expiration = buy.outputs.D_SHADOW_OUTPUT.expiration = buy.outputs.A3_FINAL_SHADOW.expiration = "2026-12-18";
    assert.equal(projectOwnerManualPlans(buy, at).plans[0].valid_until, close);
    assert.equal(projectOwnerManualPlans(buy, Date.parse(close)).plans.length, 0);
  }
});

test("SQLite resolves exact five approved source records after the recent-20 window is displaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manual-projection-")), file = join(directory, "CANARY.sqlite");
  const store = openSnapshotDatabase(file, { investmentProfile: "BLANK" }), database = new DatabaseSync(file);
  try {
    const fixture = buyFixture(), sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8")).contracts.TS_OUTPUT[0];
    const ts = fixture.outputs.TS_SHADOW_OUTPUT[0];
    fixture.outputs.TS_SHADOW_OUTPUT[0] = { ...sample, ...ts, evidence_snapshot: { ...sample.evidence_snapshot, ...ts.evidence_snapshot }, scenarios: { ...sample.scenarios, main: { ...sample.scenarios.main, ...ts.scenarios.main } } };
    Object.assign(fixture.outputs.A1_SHADOW_RESULT, { component: "A1", observed_at: observedAt, data_cutoff_at: observedAt, data_gaps: [] });
    Object.assign(fixture.outputs.A1_SHADOW_RESULT.market_sources, { bars: [], options: [], providers: [], errors: [], capabilities: {} });
    const insert = database.prepare("INSERT INTO output_records (record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const put = (id, type, payload, at = observedAt) => {
      const raw = JSON.stringify({ record_id: id, output_type: type, channel: "SHADOW", observed_at: at, payload });
      insert.run(id, type, "SHADOW", at, at, JSON.stringify(payload), raw, createHash("sha256").update(raw).digest("hex"));
    };
    // Direct isolated SQL fixture tests projection/provenance only, not gateway admission or forecast ability.
    for (const [agent, type] of Object.entries({ A1: "A1_SHADOW_RESULT", A2: "A2_SHADOW_RESULT", TS: "TS_SHADOW_OUTPUT", D: "D_SHADOW_OUTPUT", A3: "A3_FINAL_SHADOW" })) put(`${run}:${agent}`, type, agent === "TS" ? fixture.outputs.TS_SHADOW_OUTPUT[0] : fixture.outputs[type]);
    put(`${run}:OPTION_STRATEGY_SIGNAL`, "OPTION_STRATEGY_SIGNAL", fixture.outputs.OPTION_STRATEGY_SIGNAL[0]);
    for (let index = 0; index < 25; index += 1) put(`synthetic-later-${index}`, "COMMITTEE_OUTPUT", { summary: "CANARY metadata displacement only" }, dateAt(index + 1));
    assert.ok(database.prepare("SELECT record_id FROM output_records ORDER BY julianday(observed_at) DESC, sequence DESC LIMIT 20").all().every((row) => !row.record_id.startsWith(run)));
    const state = store.getActive();
    assert.deepEqual(state.recentOutputs.filter((row) => row.record_id.startsWith(`${run}:`)).map((row) => row.record_id).sort(), ["A1", "A2", "TS", "D", "A3"].map((agent) => `${run}:${agent}`).sort());
    state.runLedger = fixture.runLedger;
    state.currentTruth = fixture.currentTruth;
    const expected = projectOwnerManualPlans(state, now);
    assert.equal(expected.plans.length, 1);
    for (const view of ["home", "options"]) assert.deepEqual(projectOwnerManualPlans(ownerSnapshotView(state, view), now).plans, expected.plans);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM output_records").get().count, 31, "projection appends no forecast, delivery, approval or order");
  } finally { database.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
