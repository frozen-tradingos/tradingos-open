import assert from "node:assert/strict";
import test from "node:test";
import { buildTsRegimeRiskContext } from "../app/ts-regime-risk.ts";

const observedAt = "2026-08-13T16:00:00.000Z";
const snapshotHash = "a".repeat(64);

function bars(symbol, base) {
  return { source: "ROBINHOOD", symbol, interval: "5min", status: "LIVE", as_of: observedAt, freshness_seconds: 0, bar_count: 31, daily_bar_count: 1, latest: null, daily: [], values: Array.from({ length: 31 }, (_, index) => ({ begins_at: new Date(Date.parse(observedAt) - (30 - index) * 300_000).toISOString(), open: base + index * .02, high: base + index * .02 + .04, low: base + index * .02 - .04, close: base + index * .02, volume: 1_000 })) };
}

function option(symbol, base) {
  return { source: "ROBINHOOD", symbol, status: "LIVE", as_of: observedAt, freshness_seconds: 0, expiration_count: 1, nearest_expiration: "2026-08-14", contract_count: 1, bbo_count: 1, iv_count: 1, greeks_count: 1, contracts: [{ contract_id: `${symbol}-call`, option_type: "call", expiration: "2026-08-14", strike: base, bid: 1, ask: 1.05, mark: 1.025, volume: 100, open_interest: 200, iv: .2, delta: .5, gamma: .02, theta: -.05, vega: .08, as_of: observedAt, history_bars: 1, history_as_of: observedAt }] };
}

function market(withBadHolding = true) {
  return {
    contract_name: "TRADING_OS_MARKET_DATA", contract_version: "v1", mode: "SHADOW", snapshot_id: `market-${snapshotHash.slice(0, 24)}`, snapshot_hash: snapshotHash,
    status: "LIVE", generated_at: observedAt, as_of: observedAt, freshness_seconds: 0,
    market_session: { state: "REGULAR", timezone: "America/New_York", observed_at: observedAt, market_date: "2026-08-13", source: "DERIVED_US_EQUITY_HOURS" },
    capabilities: { quotes: true, intraday_bars: true, daily_bars: true, option_chain: true, option_bbo: true, option_iv: true, option_greeks: true }, errors: [], providers: [],
    quotes: [{ source: "ROBINHOOD", symbol: "SPY", status: "LIVE", as_of: observedAt, freshness_seconds: 0, last: 100.07, bid: 100.06, ask: 100.08, previous_close: 100 }, { source: "ROBINHOOD", symbol: "QQQ", status: "LIVE", as_of: observedAt, freshness_seconds: 0, last: 80.07, bid: 80.06, ask: 80.08, previous_close: 80 }],
    bars: [bars("SPY", 100), bars("QQQ", 80)], options: [option("SPY", 100), option("QQQ", 80)],
    account: { source: "ROBINHOOD", status: "LIVE", as_of: observedAt, freshness_seconds: 0, account_count: 1, positions: withBadHolding ? [{ account_label: "owner", contract_id: "holding-1", symbol: "SPY", option_type: "call", expiration: "2026-08-14", strike: 100, direction: "long", quantity: 1, average_price: 1, bid: null, ask: null, mark: null, iv: null, delta: null, gamma: null, theta: null, vega: null, open_interest: null, volume: null, as_of: observedAt }] : [], orders: [], portfolio_value: 1_000, option_value: 100, realized_pnl: 0 }, discrepancies: [],
    market_environment: { extended_hours: {
      status: "OBSERVED", source: "ROBINHOOD_OFFICIAL_TRADING_MCP", as_of: observedAt, data_grade: "OFFICIAL_READONLY_24_5_OHLCV", error: null, trading_date: "2026-08-13",
      instruments: ["SPY", "QQQ"].map((symbol) => ({
        symbol, session: "OVERNIGHT", status: "OBSERVED", capability: "OFFICIAL_OHLCV", as_of: observedAt,
        price: symbol === "SPY" ? 100.2 : 80.1, previous_close: symbol === "SPY" ? 100 : 80, change_pct: .2,
        overnight: {
          status: "OBSERVED", open: symbol === "SPY" ? 100.1 : 80.05, high: symbol === "SPY" ? 100.3 : 80.2, low: symbol === "SPY" ? 99.9 : 79.9,
          last: symbol === "SPY" ? 100.2 : 80.1, volume: 100, direction: "UP", gap_pct: .2,
          previous_regular_high: symbol === "SPY" ? 100.5 : 80.5, previous_regular_low: symbol === "SPY" ? 99.5 : 79.5,
          broke_previous_high: false, broke_previous_low: false, confirmation: "开盘确认",
        },
      })),
    } },
  };
}

function a2(regime = "NARROW_RANGE") {
  return { component: "A2", observed_at: observedAt, pattern_evidence: { symbols: { SPY: { current_state: regime }, QQQ: { current_state: regime } } }, v2_result: {} };
}

test("regime-first context separates entry, holding and soft degradation on one frozen snapshot", () => {
  const macro = { events: [{ release_name: "CPI", scheduled_at: "2026-08-13T16:30:00.000Z", category: "inflation" }] };
  const result = buildTsRegimeRiskContext({ market: market(), a2: a2(), officialMacro: macro, observedAt });
  assert.equal(result.base_regime, "NARROW_RANGE");
  assert.equal(result.market_type, "MAJOR_EVENT");
  assert.equal(result.symbols.SPY.entry_gate, "WAIT");
  assert.ok(result.symbols.SPY.vwap !== null && result.symbols.SPY.range_width_pct > 0 && result.symbols.SPY.remaining_regular_minutes > 0);
  assert.equal(result.risk_layers.core_hard.length, 0);
  assert.ok(result.risk_layers.new_entry.some((item) => item.code === "MAJOR_EVENT_WINDOW"));
  assert.deepEqual(result.risk_layers.position_management.map((item) => item.scope), ["HOLDING:holding-1"]);
  assert.deepEqual(result.risk_layers.soft.map((item) => item.code), ["UW_NOT_SUPPORTED", "GEX_NOT_SUPPORTED", "ACTIVE_BUY_SELL_DIRECTION_NOT_SUPPORTED", "OVERNIGHT_CONTEXT_LOW_CONFIDENCE"]);
  assert.deepEqual([result.overnight_context.status, result.overnight_context.confidence, result.overnight_context.can_override_regular_regime, result.overnight_context.can_generate_option_order], ["OBSERVED", "LOW", false, false]);
  assert.equal(result.overnight_context.symbols[0].gap_pct, .2);
  assert.match(result.context_hash, /^[0-9a-f]{64}$/);
});

test("confirmed trend remains conditional while false breakdown becomes formal no-trade", () => {
  const trend = buildTsRegimeRiskContext({ market: market(false), a2: a2("TREND_UP"), observedAt });
  assert.deepEqual([trend.market_type, trend.symbols.SPY.entry_gate, trend.risk_layers.new_entry.length], ["TREND_UP", "CONDITIONAL", 0]);
  const falseBreak = buildTsRegimeRiskContext({ market: market(false), a2: a2("FALSE_BREAKDOWN"), observedAt });
  assert.deepEqual([falseBreak.market_type, falseBreak.symbols.QQQ.breakout_state, falseBreak.symbols.QQQ.entry_gate], ["FALSE_BREAKOUT", "FALSE_BREAKDOWN", "NO_TRADE"]);
});

test("date-only macro placeholders cannot activate a precise ninety-minute event window", () => {
  const event = { release_name: "FOMC Meeting Decision", scheduled_at: "2026-08-13T16:30:00.000Z", category: "central_bank" };
  assert.equal(buildTsRegimeRiskContext({ market: market(false), a2: a2("TREND_UP"), officialMacro: { events: [{ ...event, confidence: "issuing_agency_official_date_only" }] }, observedAt }).event_overlay.status, "NOT_OBSERVED");
  for (const [precision, active] of [[undefined, true], ["EXACT", true], ["DATE_ONLY", false], ["UNKNOWN", false]]) {
    const result = buildTsRegimeRiskContext({ market: market(false), a2: a2("TREND_UP"), officialMacro: { events: [{ ...event, ...(precision ? { time_precision: precision } : {}) }] }, observedAt });
    assert.equal(result.event_overlay.status, active ? "ACTIVE" : "NOT_OBSERVED", String(precision));
    assert.equal(result.risk_layers.new_entry.some((row) => row.code === "MAJOR_EVENT_WINDOW"), active);
  }
});

test("frozen completed RTH evidence excludes unfinished, future, overnight and previous-day bars without mutating inputs", () => {
  const original = market(false), base = buildTsRegimeRiskContext({ market: original, a2: a2(), observedAt });
  const contaminated = structuredClone(original);
  for (const chart of contaminated.bars) {
    const extreme = { open: 1000, high: 1001, low: 999, close: 1000, volume: 1e9 };
    chart.values = [...chart.values.slice(0, -1), ...["2026-08-12T13:30:00.000Z", "2026-08-13T13:25:00.000Z", observedAt, "2026-08-13T16:05:00.000Z"].map((begins_at) => ({ ...extreme, begins_at }))];
  }
  const before = JSON.stringify(contaminated), actual = buildTsRegimeRiskContext({ market: contaminated, a2: a2(), observedAt });
  assert.deepEqual(actual, base);
  assert.equal(JSON.stringify(contaminated), before);
  assert.equal(actual.symbols.SPY.completed_bars.closed_at, observedAt);
  assert.equal(actual.symbols.SPY.completed_bars.bar_count, 30);
  assert.equal(actual.completed_structure.frozen_at, observedAt);
});

test("completed structure exposes fresh breakout while preserving the old A2 regime and gates", () => {
  const source = a2(), prior = { current_state: "NARROW_RANGE", candidate_state: "TREND_UP", candidate_bars: 2, data_time: "2026-08-13T15:50:00.000Z", state_since: "2026-08-13T14:00:00.000Z" };
  source.pattern_evidence.symbols.SPY = prior;
  const result = buildTsRegimeRiskContext({ market: market(false), a2: source, observedAt });
  assert.equal(result.base_regime, "NARROW_RANGE");
  assert.equal(result.symbols.SPY.entry_gate, "WAIT");
  assert.deepEqual(result.symbols.SPY.completed_bars.a2_pattern, prior);
  assert.equal(result.symbols.SPY.completed_bars.opening_range_relation, "ABOVE");
  assert.deepEqual([result.completed_structure.paired_observation.direction, result.completed_structure.paired_observation.path_stage], ["UP", "CONFIRMED"]);
  assert.match(result.completed_structure.interpretation, /A2候选态只保留诊断/);
  const down = market(false);
  for (const chart of down.bars) chart.values = chart.values.map((b) => ({ ...b, open: 300 - b.open, high: 300 - b.low, low: 300 - b.high, close: 300 - b.close }));
  const opposite = buildTsRegimeRiskContext({ market: down, a2: source, observedAt });
  assert.deepEqual([opposite.completed_structure.paired_observation.direction, opposite.symbols.SPY.completed_bars.opening_range_relation, opposite.base_regime], ["DOWN", "BELOW", "NARROW_RANGE"]);
});

test("gaps, duplicate candles, missing volume, invalid OHLC and day mismatch cannot confirm a structure", () => {
  const cases = [
    (m) => m.bars[0].values.splice(7, 1),
    (m) => m.bars[0].values.splice(7, 0, structuredClone(m.bars[0].values[7])),
    (m) => { m.bars[0].values[7].volume = null; },
    (m) => { m.bars[0].values[7].volume = -1; },
    (m) => m.bars[0].values.forEach((b) => { b.volume = 0; }),
    (m) => { m.bars[0].values[7].high = 1; },
    (m) => { m.market_session.market_date = "2026-08-12"; },
    (m) => m.bars[0].values.shift(),
  ];
  for (const mutate of cases) {
    const m = market(false); mutate(m);
    const result = buildTsRegimeRiskContext({ market: m, a2: a2(), observedAt });
    assert.equal(result.symbols.SPY.completed_bars.status, "INCOMPLETE");
    assert.equal(result.completed_structure.paired_observation.state, "DATA_BLOCKED");
    assert.equal(result.completed_structure.paired_observation.direction, "NONE");
    assert.equal(result.base_regime, "NARROW_RANGE");
  }
  const noVolume = market(false); noVolume.bars[0].values[7].volume = null;
  assert.equal(buildTsRegimeRiskContext({ market: noVolume, a2: a2(), observedAt }).symbols.SPY.vwap, null);
});

test("stale or missing completed bars remain explicit and a new day cannot inherit yesterday's structure", () => {
  const m = market(false), later = "2026-08-13T16:13:00.000Z";
  const stale = buildTsRegimeRiskContext({ market: m, a2: a2(), observedAt: later });
  assert.equal(stale.symbols.SPY.completed_bars.status, "STALE");
  assert.equal(stale.completed_structure.paired_observation.state, "DATA_BLOCKED");
  const next = buildTsRegimeRiskContext({ market: m, a2: a2(), observedAt: "2026-08-14T13:32:00.000Z" });
  assert.equal(next.symbols.SPY.completed_bars.status, "NOT_OBSERVED");
  assert.equal(next.symbols.SPY.vwap, null);
  assert.equal(next.completed_structure.paired_observation.state, "DATA_BLOCKED");
  assert.equal(next.symbols.SPY.completed_bars.a2_pattern.current_state, "NARROW_RANGE", "old A2 source remains visible separately, never rewritten");
  const boundary = buildTsRegimeRiskContext({ market: m, a2: a2(), observedAt: "2026-08-13T16:12:00.000Z" });
  assert.equal(boundary.symbols.SPY.completed_bars.status, "LIVE");
  assert.equal(buildTsRegimeRiskContext({ market: m, a2: a2(), observedAt: "2026-08-13T16:12:00.001Z" }).symbols.SPY.completed_bars.status, "STALE");
  m.bars[0].status = "STALE";
  assert.equal(buildTsRegimeRiskContext({ market: m, a2: a2(), observedAt }).completed_structure.paired_observation.state, "DATA_BLOCKED");
});

test("missing, invalid or future chart and snapshot source times cannot confirm completed structure", () => {
  for (const value of [null, "invalid", "2026-08-13T16:00:00.001Z"]) for (const field of ["chart", "snapshot"]) {
    const m = market(false);
    if (field === "chart") m.bars[0].as_of = value;
    else m.generated_at = value;
    const result = buildTsRegimeRiskContext({ market: m, a2: a2(), observedAt });
    assert.equal(result.symbols.SPY.completed_bars.status, "INCOMPLETE", `${field}: ${value}`);
    assert.equal(result.symbols.SPY.completed_bars.bar_count, 30, "raw completed facts remain visible");
    assert.equal(result.completed_structure.paired_observation.state, "DATA_BLOCKED");
    assert.equal(result.completed_structure.paired_observation.direction, "NONE");
    assert.equal(result.base_regime, "NARROW_RANGE");
    assert.equal(result.symbols.SPY.entry_gate, "WAIT");
  }
});

test("NYSE half-day cutoff excludes after-hours candles from completed structure", () => {
  const m = market(false), at = "2026-11-27T18:05:00.000Z";
  m.market_session.market_date = "2026-11-27";
  for (const chart of m.bars) chart.values = Array.from({ length: 43 }, (_, index) => ({ begins_at: new Date(Date.parse("2026-11-27T14:30:00.000Z") + index * 300_000).toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
  for (const chart of m.bars) chart.values.at(-1).high = 10000;
  const result = buildTsRegimeRiskContext({ market: m, a2: a2(), observedAt: at });
  assert.equal(result.symbols.SPY.completed_bars.bar_count, 42);
  assert.equal(result.symbols.SPY.completed_bars.closed_at, "2026-11-27T18:00:00.000Z");
  assert.equal(result.symbols.SPY.session_high, 101);
});
