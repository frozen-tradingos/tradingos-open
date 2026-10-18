import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTsProduct } from "../app/ts-settlement.ts";

const at = (time) => `2026-09-04T${time}Z`;
const record = (id, received, end, settled, spy = "BULLISH", qqq = "BEARISH") => ({
  received_at: at(received),
  output: { evidence_snapshot: { run_id: id, market_time: { market_date: "2026-09-04" } }, symbol_outlooks: { SPY: { direction: "BULLISH" }, QQQ: { direction: "BEARISH" } }, tradeability: { status: "WAIT" } },
  settlement: { settled_at: at(settled), observation_window: { start_at: at(received), end_at: at(end) }, actual_scenario: "UNRESOLVED", symbols: { SPY: { actual_direction: spy }, QQQ: { actual_direction: qqq } } },
});
const current = () => record("current", "14:15:00.000", "15:15:00.000", "15:16:00.000");
const timely = () => record("prior", "13:30:00.000", "14:00:00.000", "14:01:00.000");
const evaluate = (records) => evaluateTsProduct(records, { SPY: [], QQQ: [] });
const priorPrediction = (records, symbol = "SPY") => evaluate(records).by_forecast.current[symbol].find((item) => item.baseline === "PRIOR_MAJORITY").prediction;

test("late settlement appended after publication cannot retroactively supply the majority baseline", () => {
  const delayed = timely(); delayed.settlement.settled_at = at("16:00:00.000");
  assert.equal(priorPrediction([current()]), null);
  assert.equal(priorPrediction([delayed, current()]), null);
  assert.equal(priorPrediction([current(), delayed]), null);
});

test("only already received and settled prior results count, including the exact cutoff", () => {
  assert.equal(priorPrediction([timely(), current()]), "BULLISH");
  const exact = timely(); exact.settlement.settled_at = at("14:15:00.000");
  assert.equal(priorPrediction([exact, current()]), "BULLISH");
  exact.settlement.settled_at = at("14:15:00.001");
  assert.equal(priorPrediction([exact, current()]), null);
});

test("missing or invalid prior receipt, window, and settlement timestamps are excluded", () => {
  for (const value of [undefined, null, "", "not-a-time", "2026-13-04T14:00:00Z"]) {
    for (const field of ["received_at", "start_at", "end_at", "settled_at"]) {
      const prior = timely();
      if (field === "received_at") prior.received_at = value;
      else if (field === "settled_at") prior.settlement.settled_at = value;
      else prior.settlement.observation_window[field] = value;
      assert.equal(priorPrediction([prior, current()]), null, `${field}=${value}`);
    }
  }
});

test("contradictory time chains and windows still open at publication cannot count", () => {
  const changes = [
    (prior) => { prior.received_at = at("14:16:00.000"); },
    (prior) => { prior.received_at = at("13:31:00.000"); },
    (prior) => { prior.settlement.observation_window.start_at = at("14:01:00.000"); },
    (prior) => { prior.settlement.settled_at = at("13:59:59.999"); },
    (prior) => { prior.settlement.observation_window.end_at = at("14:16:00.000"); prior.settlement.settled_at = at("14:16:00.000"); },
  ];
  for (const change of changes) { const prior = timely(); change(prior); assert.equal(priorPrediction([prior, current()]), null); }
});

test("SPY and QQQ majority counts remain independent and ties remain unscored", () => {
  const prior = timely(), next = record("prior-2", "13:35:00.000", "14:05:00.000", "14:06:00.000", "BULLISH", "BULLISH");
  assert.equal(priorPrediction([prior, current()], "SPY"), "BULLISH");
  assert.equal(priorPrediction([prior, current()], "QQQ"), "BEARISH");
  assert.equal(priorPrediction([prior, next, current()], "SPY"), "BULLISH");
  assert.equal(priorPrediction([prior, next, current()], "QQQ"), null);
});

test("baseline correction neither mutates inputs nor changes other baseline or TS metrics", () => {
  const records = [timely(), current()], before = JSON.stringify(records), timelyResult = evaluate(records);
  const delayed = structuredClone(records); delayed[0].settlement.settled_at = at("16:00:00.000");
  const delayedBefore = JSON.stringify(delayed), delayedResult = evaluate(delayed);
  const otherBaselines = (result) => result.baselines.filter((item) => item.baseline !== "PRIOR_MAJORITY");
  assert.deepEqual(otherBaselines(delayedResult), otherBaselines(timelyResult));
  assert.equal(delayedResult.direction_mcc, timelyResult.direction_mcc);
  assert.deepEqual(delayedResult.risk_coverage, timelyResult.risk_coverage);
  assert.equal(JSON.stringify(records), before);
  assert.equal(JSON.stringify(delayed), delayedBefore);
});
