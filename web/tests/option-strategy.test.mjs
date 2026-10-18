import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { parseOutputEnvelope } from "../app/snapshot-import.ts";
import { buildCodexManagerReview } from "../app/codex-manager.ts";
import { settleOptionAdvice } from "../app/option-lifecycle.ts";
import { isNyseRegularSession } from "../app/market-time.ts";
import { buildOptionStrategySignal } from "../server/option-strategy.ts";
import { optionHorizon, representativeOptionExpirations } from "../server/option-horizon.ts";

const observedAt = "2026-08-13T16:00:00.000Z";
const snapshotHash = "b".repeat(64);

function contract(symbol, type, strike, bid, ask, delta, expiration = "2026-08-14") {
  return { contract_id: `${symbol}-${type}-${expiration}-${strike}`, option_type: type, expiration, strike, bid, ask, mark: (bid + ask) / 2, volume: 100, open_interest: 200, iv: 0.2, delta, gamma: 0.02, theta: -0.05, vega: 0.08, as_of: observedAt, history_bars: 10, history_as_of: observedAt };
}

function optionRow(symbol, spot) {
  return { source: "ROBINHOOD", symbol, status: "LIVE", as_of: observedAt, freshness_seconds: 0, expiration_count: 1, expirations: ["2026-08-14"], nearest_expiration: "2026-08-14", contract_count: 6, bbo_count: 6, iv_count: 6, greeks_count: 6, contracts: [
    contract(symbol, "call", spot - 1, 2.7, 2.75, 0.65), contract(symbol, "put", spot - 1, 1.4, 1.45, -0.35),
    contract(symbol, "call", spot, 2, 2.05, 0.5), contract(symbol, "put", spot, 1.9, 1.95, -0.5),
    contract(symbol, "call", spot + 1, 1.55, 1.6, 0.35), contract(symbol, "put", spot + 1, 2.5, 2.55, -0.65),
  ] };
}

function market(status = "LIVE") {
  return {
    contract_name: "TRADING_OS_MARKET_DATA", contract_version: "v1", mode: "SHADOW", snapshot_id: `market-${snapshotHash.slice(0, 24)}`, snapshot_hash: snapshotHash,
    status, generated_at: observedAt, as_of: observedAt, freshness_seconds: status === "LIVE" ? 0 : 900,
    market_session: { state: "REGULAR", timezone: "America/New_York", observed_at: observedAt, market_date: "2026-08-13", source: "DERIVED_US_EQUITY_HOURS" },
    capabilities: { quotes: true, intraday_bars: true, daily_bars: true, option_chain: true, option_bbo: true, option_iv: true, option_greeks: true }, errors: [], providers: [],
    quotes: [{ source: "ROBINHOOD", symbol: "SPY", status, as_of: observedAt, freshness_seconds: 0, last: 100, bid: 99.99, ask: 100.01, previous_close: 99 }, { source: "ROBINHOOD", symbol: "QQQ", status, as_of: observedAt, freshness_seconds: 0, last: 80, bid: 79.99, ask: 80.01, previous_close: 79 }],
    bars: [], options: [optionRow("SPY", 100), optionRow("QQQ", 80)], account: { source: "ROBINHOOD", status: "LIVE", as_of: observedAt, freshness_seconds: 0, account_count: 1, positions: [], orders: [], portfolio_value: 1000, option_value: 0, realized_pnl: 0 }, discrepancies: [],
  };
}

function condition(symbol, value) { return { symbol, metric: "LAST_PRICE", operator: "ABOVE", value, upper_value: null, confirmation: "ONE_5M_CLOSE" }; }
function ts() {
  return {
    contract_version: "v2", role: "TS", path_bias: "BULLISH",
    evidence_snapshot: { run_id: "20260813T160000Z-aaaaaaaaaa", packet_hash: "a".repeat(64), analysis_freshness_hash: "c".repeat(64), release_commit: "f1b99765d5dd26e70b42969070b34ca68a5d8bb0", market_time: { timezone: "America/Los_Angeles", observed_at: observedAt, market_date: "2026-08-13", state: "OPEN" } },
    forecast_window: { horizon: "NEXT_30_TO_60_MINUTES", start_at: observedAt, end_at: "2026-08-13T17:00:00.000Z", end_condition: "AT_TIMESTAMP" },
    symbol_outlooks: { SPY: { direction: "BULLISH", relative_strength: "LEADER", summary: "test" }, QQQ: { direction: "BULLISH", relative_strength: "LAGGER", summary: "test" } },
    scenarios: {
      main: { bias: "BULLISH", probability_pct: 50, summary: "up", activation: { conditions: [] }, sequence: [{ order: 1, label: "target", conditions: [condition("SPY", 104), condition("QQQ", 84)] }], invalidation: {} },
      reverse: { bias: "RANGE", probability_pct: 30, summary: "flat", activation: { conditions: [] }, sequence: [{ order: 1, label: "target", conditions: [condition("SPY", 100), condition("QQQ", 80)] }], invalidation: {} },
      extreme: { bias: "BEARISH", probability_pct: 20, summary: "down", activation: { conditions: [] }, sequence: [{ order: 1, label: "target", conditions: [condition("SPY", 98), condition("QQQ", 78)] }], invalidation: {} },
    },
  };
}

const noTrade = { action: "NO_TRADE" };
const a3NoTrade = { decision: "NO_TRADE" };
const manual = parseOutputEnvelope(JSON.stringify({
  gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "strict-d-manual", output_type: "D_SHADOW_OUTPUT", channel: "SHADOW", observed_at: observedAt,
  payload: { contract_version: "v1", role: "D", action: "MANUAL_BUY", score: 9, underlying: "SPY", option_side: "call", expiration: "2026-08-14", strike: 100, quantity: 1, max_entry_debit: 1_000, stop_loss_pct: -25, take_profit_pct: 50, summary: "Strict D v1 manual plan", entry_conditions: ["Same-slot approved entry"], invalidation: ["Original plan invalidated"], data_gaps: [] },
})).payload;
const a3Manual = { decision: "MANUAL_BUY", underlying: "SPY", option_side: "call", expiration: "2026-08-14", strike: 100, quantity: 1, max_entry_debit: 1_000, data_status: "HEALTHY" };
const riskContext = (issues = []) => ({ context_hash: "f".repeat(64), market_type: "TREND_UP", risk_layers: { core_hard: [], new_entry: issues, position_management: [], soft: [] } });

function ivHistory(sessionCount) {
  return Array.from({ length: sessionCount }, (_, index) => {
    const day = new Date(Date.UTC(2026, 6, 1 + index)), marketDate = day.toISOString().slice(0, 10);
    day.setUTCDate(day.getUTCDate() + 1);
    const expiration = day.toISOString().slice(0, 10), iv = 0.1 + index * 0.005;
    return { source: "ROBINHOOD", source_mode: "LIVE", snapshot_id: `market-${index.toString(16).padStart(24, "0")}`, observed_at: `${marketDate}T16:00:00.000Z`, market_date: marketDate, symbol: "SPY", expiration, spot: 100, contracts: optionRow("SPY", 100).contracts.map((item) => ({ ...item, expiration, iv })) };
  });
}

test("holding-period buckets keep unapproved DTE gaps explicit and select one real expiry per approved horizon", () => {
  assert.deepEqual([optionHorizon(0), optionHorizon(5), optionHorizon(30), optionHorizon(120), optionHorizon(10)], ["INTRADAY_0_1", "SHORT_2_7", "SWING_14_60", "LONG_90_PLUS", "UNCLASSIFIED"]);
  assert.deepEqual(representativeOptionExpirations(["2026-08-13", "2026-08-18", "2026-08-23", "2026-09-11", "2026-11-13"], "2026-08-13"), ["2026-08-13", "2026-08-18", "2026-09-11", "2026-11-13"]);
});

test("strategy compiler compares only supported structures and never hides unsupported GEX", () => {
  const signal = buildOptionStrategySignal({ runId: "live-shadow:20260813T160000Z", slotId: "live-shadow:20260813T160000Z", sourceMode: "LIVE", market: market(), ts: ts(), d: noTrade, a3: a3NoTrade, riskContext: riskContext() });
  assert.equal(signal.owner_action, "NO_TRADE");
  assert.equal(signal.automated_execution, false);
  assert.deepEqual(new Set(signal.candidates.map((item) => item.strategy_type)), new Set(["LONG_CALL", "CALL_DEBIT_SPREAD"]));
  assert.equal(signal.candidates.length, 6);
  assert.ok(signal.candidates.some((item) => item.status === "PASS"));
  assert.ok(signal.candidates.every((item) => item.gex.status === "NOT_SUPPORTED" && item.scenario_pnl.length === 3 && item.market_edge.covers_spread_and_decay === (item.status === "PASS")));
  const bearishTs = ts();
  bearishTs.path_bias = "BEARISH";
  bearishTs.symbol_outlooks.SPY.direction = "BEARISH";
  bearishTs.symbol_outlooks.QQQ.direction = "BEARISH";
  const bearish = buildOptionStrategySignal({ runId: "live-shadow:20260813T161500Z", slotId: "live-shadow:20260813T161500Z", sourceMode: "LIVE", market: market(), ts: bearishTs, d: noTrade, a3: a3NoTrade, riskContext: riskContext() });
  assert.deepEqual(new Set(bearish.candidates.map((item) => item.strategy_type)), new Set(["LONG_PUT", "PUT_DEBIT_SPREAD"]));
});

test("single-leg comparison separates approved holding horizons and keeps observable execution costs", () => {
  const source = market();
  const expirations = ["2026-08-13", "2026-08-18", "2026-09-11", "2026-11-13"];
  source.options = source.options.map((row) => ({ ...row, expiration_count: expirations.length, expirations, nearest_expiration: expirations[0], contracts: expirations.flatMap((expiration) => {
    const spot = row.symbol === "SPY" ? 100 : 80;
    return [
      contract(row.symbol, "call", spot - 1, 2.7, 2.75, .65, expiration), contract(row.symbol, "call", spot, 2, 2.05, .5, expiration), contract(row.symbol, "call", spot + 1, 1.55, 1.6, .35, expiration),
      contract(row.symbol, "put", spot - 1, 1.4, 1.45, -.35, expiration), contract(row.symbol, "put", spot, 1.9, 1.95, -.5, expiration), contract(row.symbol, "put", spot + 1, 2.5, 2.55, -.65, expiration),
    ];
  }) }));
  source.approved_capabilities = { fixed_pool: { rows: ["SPY", "QQQ"].map((symbol) => ({ symbol, swing: { stage: "CONFIRMED", direction: "BULLISH" } })) } };
  const risk = { ...riskContext(), symbols: { SPY: { remaining_regular_minutes: 240 }, QQQ: { remaining_regular_minutes: 240 } } };
  const next = structuredClone(ts()); next.report_type = "NEXT_SESSION";
  const signal = buildOptionStrategySignal({ runId: "live-shadow:20260813T160000Z", slotId: "live-shadow:20260813T160000Z", sourceMode: "LIVE", market: source, ts: ts(), tsHistory: [next], d: noTrade, a3: a3NoTrade, riskContext: risk });
  assert.deepEqual(new Set(signal.candidates.filter((item) => item.strategy_type === "LONG_CALL").map((item) => item.holding_horizon)), new Set(["INTRADAY_0_1", "SHORT_2_7", "SWING_14_60", "LONG_90_PLUS"]));
  assert.ok(signal.candidates.length <= 20 && signal.best_candidate_id);
  assert.ok(signal.candidates.filter((item) => item.strategy_type === "LONG_CALL").every((item) => Math.abs(item.execution_cost.entry_at_ask_usd - item.entry_debit * 100) < .001 && item.execution_cost.one_way_slippage_from_mid_usd > 0));
  assert.ok(signal.candidates.some((item) => item.scenario_node_pnl.some((node) => node.window === "CURRENT_SLOT" && node.node === "条件节点1")));
  assert.equal(signal.decision_basis, "DEPARTMENT_NO_TRADE");
  assert.equal(parseOutputEnvelope(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "horizon-contract", output_type: "OPTION_STRATEGY_SIGNAL", channel: "SHADOW", observed_at: signal.observed_at, payload: signal })).payload.best_candidate_id, signal.best_candidate_id);
});

test("D and A3 permission can select one risk-gated manual structure, while stale data waits", () => {
  assert.equal(Object.hasOwn(manual, "data_status"), false);
  assert.deepEqual(manual.data_gaps, []);
  const executable = buildOptionStrategySignal({ runId: "live-shadow:20260813T160000Z", slotId: "live-shadow:20260813T160000Z", sourceMode: "LIVE", market: market(), ts: ts(), d: manual, a3: a3Manual, riskContext: riskContext() });
  assert.equal(executable.owner_action, "EXECUTABLE");
  assert.ok(executable.selected_candidate_id);
  assert.equal(executable.candidates.find((item) => item.candidate_id === executable.selected_candidate_id).status, "PASS");
  const stale = buildOptionStrategySignal({ runId: "live-shadow:20260813T161500Z", slotId: "live-shadow:20260813T161500Z", sourceMode: "LIVE", market: market("STALE"), ts: ts(), d: manual, a3: a3Manual, riskContext: riskContext(), previous: executable, observedAt: "2026-08-13T16:15:00.000Z" });
  assert.equal(stale.owner_action, "WAIT");
  assert.equal(stale.selected_candidate_id, null);
  assert.match(stale.change_summary, /EXECUTABLE.*WAIT/);
  const overnight = market();
  overnight.market_session = { ...overnight.market_session, state: "CLOSED", phase: "OVERNIGHT", trading_date: "2026-08-14" };
  const overnightSignal = buildOptionStrategySignal({ runId: "live-shadow:20260814T013000Z", slotId: "live-shadow:20260814T013000Z", sourceMode: "LIVE", market: overnight, ts: ts(), d: manual, a3: a3Manual, riskContext: riskContext() });
  assert.equal(overnightSignal.owner_action, "WAIT");
  assert.equal(overnightSignal.selected_candidate_id, null);
});

test("manual approval rejects D gaps, unhealthy legacy status, A3, quantity, identity and budget failures", () => {
  const input = { runId: "live-shadow:strict-d-gates", slotId: "live-shadow:strict-d-gates", sourceMode: "LIVE", market: market(), ts: ts(), d: manual, a3: a3Manual, riskContext: riskContext() };
  const legacyHealthy = buildOptionStrategySignal({ ...input, d: { ...manual, data_status: "HEALTHY" } });
  assert.equal(legacyHealthy.owner_action, "EXECUTABLE");
  for (const [name, overrides] of [
    ["D data gaps", { d: { ...manual, data_gaps: ["Missing official evidence"], data_status: "HEALTHY" } }],
    ["D missing gaps", { d: { ...manual, data_gaps: undefined, data_status: "HEALTHY" } }],
    ["D malformed gaps", { d: { ...manual, data_gaps: null, data_status: "HEALTHY" } }],
    ["legacy D unhealthy", { d: { ...manual, data_status: "DATA_BLOCKED" } }],
    ["legacy D null status", { d: { ...manual, data_status: null } }],
    ["A3 unhealthy", { a3: { ...a3Manual, data_status: "DATA_BLOCKED" } }],
    ["A3 missing health", { a3: { ...a3Manual, data_status: undefined } }],
    ["D contract mismatch", { d: { ...manual, strike: 101 } }],
    ["quantity mismatch", { d: { ...manual, quantity: 2 } }],
    ["aligned excessive quantity", { d: { ...manual, quantity: 2 }, a3: { ...a3Manual, quantity: 2 } }],
    ["D budget", { d: { ...manual, max_entry_debit: 1 } }],
    ["A3 budget", { a3: { ...a3Manual, max_entry_debit: 1 } }],
    ["new-entry risk", { riskContext: riskContext([{ code: "SPY_WAIT", layer: "NEW_ENTRY_BLOCK", scope: "SPY", reason: "Entry remains blocked", source: "A2_PATTERN_TRACKER" }]) }],
  ]) {
    const signal = buildOptionStrategySignal({ ...input, ...overrides });
    assert.equal(signal.owner_action, "WAIT", name);
    assert.equal(signal.selected_candidate_id, null, name);
    assert.equal(signal.automated_execution, false, name);
  }
});

test("new-entry risk is symbol-scoped and every candidate accounts for BBO, IV and decay", () => {
  const issue = { code: "SPY_RANGE_WAIT", layer: "NEW_ENTRY_BLOCK", scope: "SPY", reason: "SPY 仍在震荡区间内等待确认", source: "A2_PATTERN_TRACKER" };
  const signal = buildOptionStrategySignal({ runId: "live-shadow:20260813T160000Z", slotId: "live-shadow:20260813T160000Z", sourceMode: "LIVE", market: market(), ts: ts(), d: noTrade, a3: a3NoTrade, riskContext: riskContext([issue]) });
  assert.ok(signal.candidates.filter((item) => item.symbol === "SPY").every((item) => item.status === "BLOCKED"));
  assert.ok(signal.candidates.filter((item) => item.symbol === "QQQ").some((item) => item.status === "PASS"));
  assert.ok(signal.candidates.every((item) => item.market_edge.model === "TS_PROBABILITY_DELTA_GAMMA_THETA_STATIC_IV_MINUS_BBO" && item.market_edge.estimated_round_trip_spread_cost_usd > 0));
  assert.deepEqual([signal.risk_summary.new_entry_block_count, signal.risk_summary.position_management_block_count], [1, 0]);
});

test("volatility gate never fabricates IV rank and can prefer a debit spread over an expensive single leg", () => {
  const forecast = ts(); forecast.symbol_outlooks.QQQ.direction = "RANGE";
  const accumulating = buildOptionStrategySignal({ runId: "live-shadow:iv-19", slotId: "live-shadow:iv-19", sourceMode: "LIVE", market: market(), ts: forecast, d: { action: "WAIT" }, a3: { decision: "WAIT" }, riskContext: riskContext(), ivHistory: ivHistory(19) });
  const accumulatingSingle = accumulating.candidates.find((item) => item.strategy_type === "LONG_CALL");
  assert.deepEqual([accumulating.volatility_summary.archive_status, accumulatingSingle.volatility_gate.iv_history.status, accumulatingSingle.volatility_gate.iv_history.iv_rank_pct, accumulatingSingle.volatility_gate.iv_history.iv_percentile_pct], ["ACCUMULATING", "INSUFFICIENT_SAMPLE", null, null]);

  const ready = buildOptionStrategySignal({ runId: "live-shadow:iv-20", slotId: "live-shadow:iv-20", sourceMode: "LIVE", market: market(), ts: forecast, d: { action: "WAIT" }, a3: { decision: "WAIT" }, riskContext: riskContext(), ivHistory: ivHistory(20) });
  const single = ready.candidates.find((item) => item.strategy_type === "LONG_CALL"), spread = ready.candidates.find((item) => item.strategy_type === "CALL_DEBIT_SPREAD");
  assert.equal(single.volatility_gate.iv_history.iv_percentile_pct, 100);
  assert.deepEqual([single.volatility_gate.price_state, single.status, spread.status, ready.decision_basis], ["EXPENSIVE", "BLOCKED", "PASS", "SINGLE_LEG_BLOCKED_SPREAD_ACCEPTABLE"]);
});

test("immutable option settlement attributes direction-correct losses and compares single leg with debit spread", () => {
  const signal = buildOptionStrategySignal({ runId: "live-shadow:settle-vol", slotId: "live-shadow:settle-vol", sourceMode: "LIVE", market: market(), ts: ts(), d: manual, a3: a3Manual, riskContext: riskContext() });
  const single = signal.candidates.find((item) => item.candidate_id === signal.selected_candidate_id), spread = signal.candidates.find((item) => item.symbol === "SPY" && item.strategy_type === "CALL_DEBIT_SPREAD");
  const bars = Array.from({ length: 78 }, (_, index) => ({ begins_at: new Date(Date.parse("2026-08-13T13:30:00.000Z") + index * 300_000).toISOString(), session_date: "2026-08-13", session: "REGULAR", open: 100 + index * .01, high: 100.05 + index * .01, low: 99.95 + index * .01, close: 100.01 + index * .01, volume: 1000, snapshot_hash: "a".repeat(64) }));
  const closingContracts = optionRow("SPY", 100).contracts.map((item) => ({ ...(item.strike === 100 && item.option_type === "call" ? { ...item, bid: 1, ask: 1.05, iv: .1 } : item.strike === 101 && item.option_type === "call" ? { ...item, bid: .35, ask: .4, iv: .1 } : { ...item, iv: .1 }), as_of: "2026-08-13T19:55:00.000Z" }));
  const settlement = settleOptionAdvice({ source_type: "OPTION_STRATEGY_SIGNAL", source_id: signal.signal_id, holding_id: null, observed_at: observedAt, received_at: observedAt, action: "EXECUTABLE", symbol: "SPY", direction: "BULLISH", target_1: 104, target_2: null, price_invalidation: 98, time_invalidation: null, candidate: single, single_leg_candidate: single, debit_spread_candidate: spread, volatility_gate: single.volatility_gate }, { SPY: bars, QQQ: [] }, "2026-08-13T20:01:00.000Z", [{ source: "ROBINHOOD", source_mode: "LIVE", snapshot_id: "market-closing0000000000000", observed_at: "2026-08-13T19:55:00.000Z", received_at: "2026-08-13T19:55:01.000Z", market_date: "2026-08-13", symbol: "SPY", expiration: "2026-08-14", spot: 100.78, contracts: closingContracts }]);
  assert.deepEqual([settlement.volatility_result.direction_correct, settlement.volatility_result.direction_correct_but_option_lost, settlement.volatility_result.path_fit], [true, true, "DEBIT_SPREAD"]);
  assert.ok(settlement.volatility_result.single_leg_actual_pnl_usd < 0 && settlement.volatility_result.debit_spread_actual_pnl_usd > 0);
});

test("gateway keeps immutable strategy transitions across duplicate import and restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-option-strategy-")), file = join(directory, "strategy.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const first = buildOptionStrategySignal({ runId: "live-shadow:20260813T160000Z", slotId: "live-shadow:20260813T160000Z", sourceMode: "LIVE", market: market(), ts: ts(), d: noTrade, a3: a3NoTrade, riskContext: riskContext() });
  const second = buildOptionStrategySignal({ runId: "live-shadow:20260813T161500Z", slotId: "live-shadow:20260813T161500Z", sourceMode: "LIVE", market: market(), ts: ts(), d: manual, a3: a3Manual, riskContext: riskContext(), previous: first, observedAt: "2026-08-13T16:15:00.000Z" });
  const envelope = (recordId, signal) => JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: recordId, output_type: "OPTION_STRATEGY_SIGNAL", channel: "SHADOW", observed_at: signal.observed_at, payload: signal });
  const rawFirst = envelope("live-shadow:20260813T160000Z:OPTION_STRATEGY_SIGNAL", first), rawSecond = envelope("live-shadow:20260813T161500Z:OPTION_STRATEGY_SIGNAL", second);
  assert.equal(parseOutputEnvelope(rawFirst).payload.signal_id, first.signal_id);
  let store = openSnapshotDatabase(file);
  assert.equal(store.importOutputRaw(rawFirst).duplicate, false);
  assert.equal(store.importOutputRaw(rawFirst).duplicate, true);
  assert.equal(store.importOutputRaw(rawSecond).duplicate, false);
  const badLink = { ...second, signal_id: `option-signal-${"d".repeat(24)}`, previous_signal_id: null, observed_at: "2026-08-13T16:30:00.000Z" };
  assert.throws(() => store.importOutputRaw(envelope("bad-link", badLink)), /必须引用最近一条/);
  const outOfOrder = { ...second, signal_id: `option-signal-${"e".repeat(24)}`, previous_signal_id: second.signal_id, observed_at: first.observed_at };
  assert.throws(() => store.importOutputRaw(envelope("out-of-order", outOfOrder)), /拒绝乱序写入/);
  store.close();
  store = openSnapshotDatabase(file);
  const history = store.getActive().outputs.OPTION_STRATEGY_SIGNAL;
  assert.equal(history.length, 2);
  assert.equal(history[0].previous_signal_id, first.signal_id);
  assert.equal(history[1].signal_id, first.signal_id);
  store.close();
});

test("SQLite derives IV history only from immutable A1 LIVE snapshots and keeps it across restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-iv-archive-")), file = join(directory, "iv.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  let store = openSnapshotDatabase(file); store.close();
  const database = new DatabaseSync(file), payload = JSON.stringify({ source_mode: "LIVE", observed_at: observedAt, market_sources: market() });
  database.prepare("INSERT INTO output_records (record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, 'A1_SHADOW_RESULT', 'SHADOW', ?, ?, ?, '{}', ?)").run("iv-live", observedAt, observedAt, payload, "a".repeat(64));
  database.prepare("INSERT INTO output_records (record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, 'A1_SHADOW_RESULT', 'SHADOW', ?, ?, ?, '{}', ?)").run("iv-replay", observedAt, observedAt, JSON.stringify({ source_mode: "REPLAY", observed_at: observedAt, market_sources: market() }), "b".repeat(64));
  database.close();
  store = openSnapshotDatabase(file);
  assert.deepEqual(store.getOptionIvHistory().map((item) => item.symbol), ["SPY", "QQQ"]);
  store.close(); store = openSnapshotDatabase(file);
  assert.equal(store.getOptionIvHistory().length, 2);
  store.close();
});

test("IV projection preserves missing, null and noncontract historical scalar identities without merging them", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-iv-legacy-scalars-")), file = join(directory, "iv.sqlite"), store = openSnapshotDatabase(file), database = new DatabaseSync(file);
  context.after(async () => { database.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const insert = database.prepare("INSERT INTO output_records (record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,'A1_SHADOW_RESULT','SHADOW',?,?,?,'{}',?)");
  for (const [index, identity] of [undefined, null, true, 1].entries()) {
    const archived = market(); archived.snapshot_id = identity;
    if (identity === true || identity === 1) archived.market_session.market_date = identity;
    const payload = { source_mode: "LIVE", observed_at: identity === true || identity === 1 ? identity : observedAt, market_sources: archived };
    insert.run(`legacy-${index}`, observedAt, observedAt, JSON.stringify(payload), "a".repeat(64));
  }
  const raw = database.prepare("SELECT * FROM output_records ORDER BY sequence").all(), result = store.getOptionIvHistory();
  assert.deepEqual(result.map(row => [row.snapshot_id, row.observed_at, row.market_date]), [
    [1, 1, 1], [1, 1, 1], [true, true, true], [true, true, true],
    [null, observedAt, "2026-08-13"], [null, observedAt, "2026-08-13"], [undefined, observedAt, "2026-08-13"], [undefined, observedAt, "2026-08-13"],
  ]);
  assert.deepEqual(result.map(row => row.symbol), ["SPY", "QQQ", "SPY", "QQQ", "SPY", "QQQ", "SPY", "QQQ"]);
  assert.deepEqual(result[6].contracts, market().options[0].contracts);
  assert.deepEqual(database.prepare("SELECT * FROM output_records ORDER BY sequence").all(), raw);
});

test("SQLite passes actual advice and quote receipts, excludes pre-receipt evidence, and never rewrites a legacy settlement", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-option-window-wiring-")), file = join(directory, "window.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-13T13:00:00.000Z") });
  const receivedAt = "2026-08-13T16:08:00.000Z", quoteReceivedAt = "2026-08-13T16:09:00.000Z";
  const signal = buildOptionStrategySignal({ runId: "live-shadow:window-wiring", slotId: "live-shadow:window-wiring", sourceMode: "LIVE", market: market(), ts: ts(), d: manual, a3: a3Manual, riskContext: riskContext() });
  const holding = { holding_id: "synthetic-holding", symbol: "SPY", option_type: "call", owner_action: "HOLD", target_1: 104, target_2: null, price_invalidation: 98, time_invalidation: null };
  const state = { state_id: "synthetic-current", source_mode: "LIVE", observed_at: observedAt, holdings: [holding] };
  const oldState = { ...state, state_id: "synthetic-legacy" }, oldKey = `${oldState.state_id}:${holding.holding_id}`;
  const oldPayload = JSON.stringify({ source_id: oldState.state_id, outcome: "TARGET_1", notes: ["immutable legacy fixture; no observation-window version"] });
  let store = openSnapshotDatabase(file); store.close();
  const database = new DatabaseSync(file);
  const insertOutput = database.prepare("INSERT INTO output_records (record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, ?, 'SHADOW', ?, ?, ?, '{}', ?)");
  insertOutput.run("window-strategy", "OPTION_STRATEGY_SIGNAL", observedAt, receivedAt, JSON.stringify(signal), "a".repeat(64));
  insertOutput.run("window-position", "POSITION_COPILOT_STATE", observedAt, receivedAt, JSON.stringify(state), "b".repeat(64));
  insertOutput.run("window-legacy", "POSITION_COPILOT_STATE", observedAt, observedAt, JSON.stringify(oldState), "c".repeat(64));
  database.prepare("INSERT INTO option_advice_settlements (source_key, source_type, source_id, holding_id, source_mode, observed_at, settled_at, market_date, status, settlement_hash, payload_json) VALUES (?, 'POSITION_COPILOT_STATE', ?, ?, 'LIVE', ?, ?, '2026-08-13', 'RESOLVED', ?, ?)").run(oldKey, oldState.state_id, holding.holding_id, observedAt, "2026-08-13T20:00:00.000Z", "d".repeat(64), oldPayload);
  const archivedMarket = market();
  for (const chain of archivedMarket.options) for (const item of chain.contracts) item.as_of = "2026-08-13T16:05:00.000Z";
  insertOutput.run("window-quote", "A1_SHADOW_RESULT", observedAt, quoteReceivedAt, JSON.stringify({ source_mode: "LIVE", observed_at: observedAt, market_sources: archivedMarket }), "e".repeat(64));
  const immutableRows = database.prepare("SELECT * FROM output_records ORDER BY sequence").all(), legacyRow = database.prepare("SELECT * FROM option_advice_settlements WHERE source_key = ?").get(oldKey);
  database.close(); store = openSnapshotDatabase(file);
  assert.deepEqual(store.getOptionIvHistory().map((row) => row.received_at), [quoteReceivedAt, quoteReceivedAt]);
  const charts = ["SPY", "QQQ"].map((symbol) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: 78 }, (_, index) => ({ begins_at: new Date(Date.parse("2026-08-13T13:30:00.000Z") + index * 300_000).toISOString(), open: 100 + index * .01, high: index === 31 ? 150 : 100.05 + index * .01, low: 99.95 + index * .01, close: 100.01 + index * .01, volume: 1000 })) }));
  const settled = store.recordTsMarketCharts(charts, "2026-08-13T20:01:00.000Z");
  assert.deepEqual([settled.optionNewlySettled, settled.optionErrors], [2, []]);
  const evidence = new DatabaseSync(file, { readOnly: true });
  const rows = evidence.prepare("SELECT * FROM option_advice_settlements ORDER BY source_key").all();
  for (const row of rows.filter((item) => item.source_key !== oldKey)) {
    const result = JSON.parse(row.payload_json);
    assert.deepEqual([result.observation_window.start_at, result.observation_window.end_at], [receivedAt, "2026-08-13T20:00:00.000Z"]);
    assert.deepEqual([result.actual[0].start_price, result.actual[0].high], [100.32, 100.82]);
    assert.equal(result.target_1_hit, result.source_type === "POSITION_COPILOT_STATE" ? false : null);
    if (result.source_type === "OPTION_STRATEGY_SIGNAL") {
      assert.equal(result.volatility_result.actual_option_exit_value_usd, null);
      assert.ok(result.observation_window.data_gaps.includes("OPTION_QUOTE_WINDOW_NOT_VERIFIED"));
    }
  }
  assert.deepEqual(evidence.prepare("SELECT * FROM option_advice_settlements WHERE source_key = ?").get(oldKey), legacyRow);
  assert.deepEqual(evidence.prepare("SELECT * FROM output_records ORDER BY sequence").all(), immutableRows);
  evidence.close(); store.close(); store = openSnapshotDatabase(file);
  assert.equal(store.recordTsMarketCharts(charts, "2026-08-13T20:02:00.000Z").optionNewlySettled, 0);
  store.close();
  const afterRestart = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(afterRestart.prepare("SELECT * FROM option_advice_settlements ORDER BY source_key").all(), rows);
  afterRestart.close();
});

test("legacy strategy rows without regime-risk fields remain readable without rewriting history", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-option-legacy-")), file = join(directory, "legacy.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const signal = buildOptionStrategySignal({ runId: "live-shadow:legacy-compat", slotId: "live-shadow:legacy-compat", sourceMode: "LIVE", market: market(), ts: ts(), d: noTrade, a3: a3NoTrade, riskContext: riskContext(), observedAt: future });
  const raw = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "legacy:option-strategy", output_type: "OPTION_STRATEGY_SIGNAL", channel: "SHADOW", observed_at: signal.observed_at, payload: signal });
  let store = openSnapshotDatabase(file);
  store.importOutputRaw(raw);
  store.close();
  const legacy = structuredClone(signal);
  delete legacy.risk_summary;
  for (const candidate of legacy.candidates) delete candidate.market_edge;
  const database = new DatabaseSync(file);
  database.prepare("UPDATE output_records SET payload_json = ? WHERE output_type = 'OPTION_STRATEGY_SIGNAL'").run(JSON.stringify(legacy));
  database.close();
  store = openSnapshotDatabase(file);
  assert.deepEqual([store.getActive().optionLifecycle.live_strategy_count, store.getActive().optionLifecycle.pending_count], [1, 1]);
  store.close();
});

test("NO TRADE remains a valid natural LIVE result and settles without entering accuracy", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-no-trade-settlement-")), file = join(directory, "state.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const day = new Date(Date.now() + 86_400_000); while (!isNyseRegularSession(day.toISOString().slice(0, 10))) day.setUTCDate(day.getUTCDate() + 1);
  const marketDate = day.toISOString().slice(0, 10), signalAt = `${marketDate}T16:00:00.000Z`;
  const signal = buildOptionStrategySignal({ runId: `live-shadow:${marketDate.replaceAll("-", "")}T160000Z`, slotId: `live-shadow:${marketDate.replaceAll("-", "")}T160000Z`, sourceMode: "LIVE", market: market(), ts: ts(), d: noTrade, a3: a3NoTrade, riskContext: riskContext(), observedAt: signalAt });
  const raw = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "natural:no-trade", output_type: "OPTION_STRATEGY_SIGNAL", channel: "SHADOW", observed_at: signal.observed_at, payload: signal });
  let store = openSnapshotDatabase(file);
  store.importOutputRaw(raw, signalAt);
  assert.deepEqual([store.getActive().optionLifecycle.live_strategy_count, store.getActive().optionLifecycle.pending_count], [1, 1]);
  const charts = [["SPY", 100], ["QQQ", 200]].map(([symbol, base]) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: 78 }, (_, index) => ({ begins_at: new Date(Date.parse(`${marketDate}T13:30:00.000Z`) + index * 300_000).toISOString(), open: base + index * .01, high: base + index * .01 + .03, low: base + index * .01 - .03, close: base + index * .01 + .01, volume: 1000 })) }));
  assert.equal(store.recordTsMarketCharts(charts, `${marketDate}T20:01:00.000Z`).optionNewlySettled, 1);
  store.close(); store = openSnapshotDatabase(file);
  const settlement = store.getActive().optionLifecycle.recent_settlements[0];
  assert.deepEqual([settlement.outcome, settlement.scoreable, settlement.actual.length], ["NO_TRADE", false, 2]);
  assert.equal(settlement.avoidance_assessment.status, "DISCIPLINE_PRESERVED");
  assert.match(settlement.notes.join(" "), /合法结果/);
  assert.match(buildCodexManagerReview(store.getActive(), new Date(`${marketDate}T20:55:00.000Z`), "POST_CLOSE").prediction_review.summary, /NO_TRADE→NO_TRADE.*不进入准确率/);
  store.close();
});
