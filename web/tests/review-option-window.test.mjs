import assert from "node:assert/strict";
import test from "node:test";
import { settleOptionAdvice } from "../app/option-lifecycle.ts";
import { utcForPt } from "../app/timeline-schedule.ts";
import { nyseClosePtMinutes } from "../app/market-time.ts";

const date = "2026-08-13", at = (time, day = date) => utcForPt(day, time).toISOString();
function example(day = date) {
  const bars = Array.from({ length: (nyseClosePtMinutes(day) - 390) / 5 }, (_, index) => ({ begins_at: new Date(Date.parse(at("06:30", day)) + index * 300_000).toISOString(), session_date: day, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000, snapshot_hash: "a".repeat(64) }));
  const input = { source_type: "OPTION_STRATEGY_SIGNAL", source_id: "synthetic-window", holding_id: null, observed_at: at("09:00", day), received_at: at("09:08", day), action: "EXECUTABLE", symbol: "SPY", direction: "BULLISH", target_1: 102, target_2: null, price_invalidation: 98, time_invalidation: null };
  return { input, bars, settle: (settled = at("13:01", day), archive = []) => settleOptionAdvice(input, { SPY: bars, QQQ: [] }, settled, archive) };
}
const candidate = { symbol: "SPY", expiration: "2026-08-14", entry_debit: 2, legs: [{ contract_id: "synthetic-call", side: "BUY", iv: .2, theta: -.1, vega: .1 }] };
function quote(overrides = {}, contractOverrides = {}) {
  return { source: "ROBINHOOD", source_mode: "LIVE", snapshot_id: "synthetic-quote", observed_at: at("12:49"), received_at: at("12:51"), market_date: date, symbol: "SPY", expiration: candidate.expiration, spot: 100, contracts: [{ contract_id: "synthetic-call", bid: 2.2, ask: 2.3, iv: .2, as_of: at("12:50"), ...contractOverrides }], ...overrides };
}

test("published receipt, not earlier A1 time, starts the complete-Bar observation window", () => {
  const sample = example();
  sample.bars.find((bar) => bar.begins_at === at("09:05")).high = 110;
  sample.bars.find((bar) => bar.begins_at === at("09:10")).open = 100.25;
  const result = sample.settle();
  assert.equal(result.outcome, "HELD_RANGE");
  assert.equal(result.actual[0].start_price, 100.25);
  assert.equal(result.actual[0].high, 100.5);
  assert.deepEqual([result.observation_window.contract_version, result.observation_window.start_at, result.observation_window.end_at], ["RECEIVED_RTH_WINDOW_V1", at("09:08"), at("13:00")]);
  assert.equal(result.path_scoring_version, "FIRST_TERMINAL_V2");
});

test("existing end-of-day timing stays intact even with future full-day bars or an earlier invalidation", () => {
  const sample = example();
  sample.input.time_invalidation = at("10:00");
  assert.equal(sample.settle(at("12:59:59")), null);
});

test("a timestamp deadline excludes overlapping and later Bars but a date is not invented as an exit timestamp", () => {
  const sample = example();
  sample.input.time_invalidation = at("10:12");
  sample.bars.find((bar) => bar.begins_at === at("10:10")).high = 110;
  assert.equal(sample.settle().outcome, "HELD_RANGE");
  assert.equal(sample.settle().observation_window.end_at, at("10:12"));
  sample.input.time_invalidation = date;
  assert.equal(sample.settle().outcome, "TARGET_1");
  sample.input.time_invalidation = "2026-08-12";
  assert.equal(sample.settle().scoreable, false);
  assert.deepEqual(sample.settle().actual, []);
  sample.input.time_invalidation = "2026-08-14";
  assert.equal(sample.settle().observation_window.end_at, at("13:00"));
});

test("empty or unverified advice windows never borrow the pre-advice day", () => {
  const sample = example();
  sample.input.observed_at = at("13:00:01");
  sample.input.received_at = at("13:00:02");
  assert.deepEqual(sample.settle().actual, []);
  assert.equal(sample.settle().scoreable, false);
  for (const receipt of [undefined, "invalid", "2026-08-13T16:08:00"]) {
    const missing = example(); missing.input.received_at = receipt;
    assert.equal(missing.settle().scoreable, false);
    assert.deepEqual(missing.settle().actual, []);
    assert.ok(missing.settle().observation_window.data_gaps.length);
  }
  sample.input.received_at = at("13:02");
  assert.equal(sample.settle(), null);
});

test("each leg needs a real in-window quote and a compatible receipt available by settlement", () => {
  const sample = example(); sample.input.candidate = candidate;
  assert.equal(sample.settle(undefined, [quote()]).volatility_result.actual_option_return_pct, 10);
  const badRows = [quote({ received_at: undefined }), quote({ received_at: "invalid" }), quote({ received_at: at("13:02") }), quote({ received_at: at("12:49") }), quote({ observed_at: at("12:52") }), quote({}, { as_of: null }), quote({}, { as_of: "invalid" }), quote({}, { as_of: at("09:05") }), quote({}, { as_of: at("13:02") }), quote({ received_at: at("13:00:01") }, { as_of: at("13:00:01") })];
  for (const row of badRows) {
    const result = sample.settle(undefined, [row]);
    assert.equal(result.volatility_result.actual_option_return_pct, null);
    assert.ok(result.observation_window.data_gaps.length);
  }
  sample.input.time_invalidation = at("12:45");
  assert.equal(sample.settle(undefined, [quote()]).volatility_result.actual_option_return_pct, null);
});

test("one invalid spread leg rejects the estimate, while valid BBO arithmetic is unchanged", () => {
  const sample = example();
  sample.input.candidate = { ...candidate, entry_debit: 1, legs: [...candidate.legs, { ...candidate.legs[0], contract_id: "synthetic-short", side: "SELL" }] };
  const row = quote(); row.contracts.push({ contract_id: "synthetic-short", bid: .9, ask: 1, iv: .2, as_of: at("12:50") });
  assert.equal(sample.settle(undefined, [row]).volatility_result.actual_option_exit_value_usd, 120);
  row.contracts[1].as_of = at("13:02");
  assert.equal(sample.settle(undefined, [row]).volatility_result.actual_option_exit_value_usd, null);
});

test("winter early-close uses the existing exchange calendar, not a hard-coded UTC end", () => {
  const day = "2026-11-27", sample = example(day);
  assert.equal(sample.settle(at("09:59:59", day)), null);
  assert.equal(sample.settle(at("10:01", day)).observation_window.end_at, "2026-11-27T18:00:00.000Z");
});

test("a late-arriving older quote cannot replace a newer valid source quote", () => {
  const sample = example(); sample.input.candidate = candidate;
  const newer = quote({}, { bid: 2.4, ask: 2.5 });
  const olderReceivedLater = quote({ observed_at: at("12:29"), received_at: at("12:52") }, { as_of: at("12:30") });
  assert.equal(sample.settle(undefined, [newer, olderReceivedLater]).volatility_result.actual_option_return_pct, 20);
});
