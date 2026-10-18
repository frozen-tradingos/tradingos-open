import assert from "node:assert/strict";
import test from "node:test";
import { settleOptionAdvice } from "../app/option-lifecycle.ts";

const observedAt = "2026-08-13T16:00:00.000Z", settledAt = "2026-08-13T20:01:00.000Z";
function example(direction, moves, target2 = true) {
  const bars = Array.from({ length: 78 }, (_, index) => ({ begins_at: new Date(Date.parse("2026-08-13T13:30:00.000Z") + index * 300_000).toISOString(), session_date: "2026-08-13", session: "REGULAR", open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000, snapshot_hash: "a".repeat(64) }));
  const bullish = direction === "BULLISH", target = bullish ? "high" : "low", invalid = bullish ? "low" : "high";
  const input = { source_type: "OPTION_STRATEGY_SIGNAL", source_id: "synthetic-path", holding_id: null, observed_at: observedAt, received_at: observedAt, action: "EXECUTABLE", symbol: "SPY", direction, target_1: bullish ? 102 : 98, target_2: target2 ? bullish ? 104 : 96 : null, price_invalidation: bullish ? 98 : 102, time_invalidation: null };
  moves.forEach((events, index) => {
    if (events.includes("T1")) bars[30 + index][target] = input.target_1;
    if (events.includes("T2")) bars[30 + index][target] = bullish ? 104 : 96;
    if (events.includes("INVALID")) bars[30 + index][invalid] = input.price_invalidation;
  });
  return { input, bars, settle: (values = bars) => settleOptionAdvice(input, { SPY: values, QQQ: [] }, settledAt) };
}

test("T1 then invalidation then T2 preserves the failed terminal instead of resurrecting a win", () => {
  for (const direction of ["BULLISH", "BEARISH"]) {
    const sample = example(direction, [["T1"], ["INVALID"], ["T2"]]);
    const result = sample.settle();
    assert.equal(result.outcome, "INVALIDATED");
    assert.equal(result.path_scoring_version, "FIRST_TERMINAL_V2");
    assert.deepEqual([result.target_1_hit, result.target_2_hit, result.price_invalidation_hit], [true, true, true]);
    assert.match(result.notes.join(" "), /第一目标.*随后.*失效/);
    assert.match(result.notes.join(" "), /物理触及.*不等于.*失效前/);
    assert.deepEqual(sample.settle([...sample.bars].reverse()), result);
  }
});

test("a single target is terminal and cannot be undone by a later invalidation", () => {
  for (const direction of ["BULLISH", "BEARISH"]) {
    const result = example(direction, [["T1"], ["INVALID"]], false).settle();
    assert.equal(result.outcome, "TARGET_1");
    assert.equal(result.price_invalidation_hit, true);
    assert.equal(result.target_2_hit, null);
    assert.equal(result.status, "RESOLVED");
  }
});

test("only simultaneous competing terminal events are ambiguous", () => {
  for (const direction of ["BULLISH", "BEARISH"]) {
    assert.equal(example(direction, [["T1", "INVALID"], ["T2"]]).settle().outcome, "INVALIDATED");
    assert.equal(example(direction, [["T1"], ["T2", "INVALID"]]).settle().outcome, "AMBIGUOUS");
    assert.equal(example(direction, [["T1", "INVALID"]], false).settle().outcome, "AMBIGUOUS");
    assert.equal(example(direction, [["T2"], ["INVALID"]]).settle().outcome, "TARGET_2");
  }
});

test("unordered input, failed first terminal and partial paths retain the same result without mutating history", () => {
  for (const direction of ["BULLISH", "BEARISH"]) {
    const sample = example(direction, [["INVALID"], ["T1"], ["T2", "INVALID"]]);
    const original = JSON.stringify(sample.bars), result = sample.settle();
    assert.equal(result.outcome, "INVALIDATED");
    assert.deepEqual(sample.settle([...sample.bars].reverse()), result);
    assert.equal(JSON.stringify(sample.bars), original);
    assert.equal(example(direction, [["T1"]]).settle().outcome, "TARGET_1");
    assert.equal(example(direction, []).settle().outcome, "HELD_RANGE");
    const blocked = example(direction, [["T2"]]);
    blocked.input.action = "NO_TRADE";
    assert.deepEqual([blocked.settle().outcome, blocked.settle().scoreable], ["NO_TRADE", false]);
  }
});
