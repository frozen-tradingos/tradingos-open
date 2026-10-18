import assert from "node:assert/strict";
import test from "node:test";
import { buildNextSessionObservation } from "../app/next-session-observation.ts";
import { resolveTsForecastContext } from "../app/ts-forecast-state.ts";
import { timelineOccurrencesForPtDate } from "../app/timeline-schedule.ts";

const friday = {
  report_type: "NEXT_SESSION", path_bias: "BULLISH", one_line_forecast: "开盘后重新确认，未形成交易批准。",
  evidence_assessment: { core_status: "READY" },
  evidence_snapshot: { run_id: "friday-frozen-forecast", market_time: { market_date: "2026-09-04", observed_at: "2026-09-04T18:00:55.489-07:00" } },
};
const sundayFailure = {
  ...timelineOccurrencesForPtDate("2026-09-06").find((row) => row.kind === "EVENING_ANALYSIS"),
  status: "FAILED", completed_at: "2026-09-07T01:01:29.032Z", reason: "A1 FAILED", result_ref: "sqlite://agent_run_events/live-shadow:20260907T010000Z",
};
const base = { outputs: [friday], checkpoints: [sundayFailure], incidents: [], tradingDate: "2026-09-08", at: "2026-09-08T03:02:18.388Z" };

test("holiday card and chart share the target-date forecast without calling it a new Monday forecast", () => {
  const before = structuredClone(base), card = buildNextSessionObservation(base);
  const chart = resolveTsForecastContext(base.outputs, null, base.at);
  assert.equal(card.phase, "READY");
  assert.equal(card.forecast_id, chart.selected.evidence_snapshot.run_id);
  assert.equal(card.target_date, chart.tradingDate);
  assert.equal(card.formed_at, friday.evidence_snapshot.market_time.observed_at);
  assert.match(card.status, /沿用/);
  assert.match(card.reason, /2026\/09\/04/);
  assert.deepEqual(base, before, "projection cannot rewrite forecasts or failed updates");
});

test("a holiday without an evening occurrence is not a missing or failed Monday run", () => {
  assert.equal(timelineOccurrencesForPtDate("2026-09-07").some((row) => row.kind === "EVENING_ANALYSIS"), false);
  const card = buildNextSessionObservation({ ...base, outputs: [], checkpoints: [] });
  assert.equal(card.phase, "PENDING");
  assert.equal(card.forecast_id, null);
  assert.equal(card.due_at, null);
  assert.match(card.status, /无.*排期/);
  assert.doesNotMatch(card.reason, /找不到当天18:00|没有找到当天18:00/);
});

test("the real Sunday failed update remains visible independently from the retained forecast", () => {
  const card = buildNextSessionObservation(base);
  assert.equal(card.phase, "READY");
  assert.equal(card.latest_update.slot_id, sundayFailure.slot_id);
  assert.equal(card.latest_update.status, "FAILED");
  assert.equal(card.latest_update.completed_at, sundayFailure.completed_at);
  assert.match(card.reason, /2026-09-06.*失败/);
  const noForecast = buildNextSessionObservation({ ...base, outputs: [] });
  assert.equal(noForecast.phase, "PENDING", "do not invent a Monday scheduled failure");
  assert.equal(noForecast.latest_update.status, "FAILED");
});

test("the same forecast remains selected after PT midnight before Tuesday natural open", () => {
  const input = { ...base, at: "2026-09-08T10:00:00Z" };
  const card = buildNextSessionObservation(input), chart = resolveTsForecastContext(input.outputs, null, input.at);
  assert.equal(card.forecast_id, chart.selected.evidence_snapshot.run_id);
  assert.equal(card.target_date, "2026-09-08");
  assert.equal(card.formed_at, friday.evidence_snapshot.market_time.observed_at);
});

test("an older target cannot replace a missing next-session forecast after that session closes", () => {
  const card = buildNextSessionObservation({ ...base, at: "2026-09-09T01:12:00Z" });
  assert.equal(card.phase, "FAILED");
  assert.equal(card.target_date, "2026-09-09");
  assert.equal(card.forecast_id, null);
  assert.equal(card.latest_update, null, "Sunday failure belongs to Tuesday, not Wednesday");
});

test("scheduled evening pending and grace states still use the unchanged schedule", () => {
  const input = { outputs: [], checkpoints: [], incidents: [], tradingDate: "2026-09-08" };
  const pending = buildNextSessionObservation({ ...input, at: "2026-09-09T00:59:00Z" });
  assert.equal(pending.phase, "PENDING");
  assert.equal(pending.due_at, "2026-09-09T01:00:00.000Z");
  const forming = buildNextSessionObservation({ ...input, at: "2026-09-09T01:01:00Z" });
  assert.equal(forming.phase, "FORMING");
});

test("future same-target output cannot appear in the card or last-completed archive", () => {
  const card = buildNextSessionObservation({ ...base, checkpoints: [], at: "2026-09-04T17:59:00-07:00" });
  assert.equal(card.phase, "PENDING");
  assert.equal(card.forecast_id, null);
  assert.equal(card.last_completed, null);
});

test("future same-target output cannot become the default chart forecast", () => {
  const chart = resolveTsForecastContext([friday], null, "2026-09-04T17:59:00-07:00");
  assert.equal(chart.selected, null);
  assert.equal(chart.mode, "NONE");
});

test("historical deep links retain their exact identity but never disclose a future record", () => {
  const historical = { ...friday, report_type: "INTRADAY_30_60M", evidence_snapshot: { ...friday.evidence_snapshot, run_id: "historical-friday", market_time: { market_date: "2026-09-04", observed_at: "2026-09-04T12:00:00-07:00" } } };
  const before = structuredClone([historical, friday]);
  const existing = resolveTsForecastContext(before, "historical-friday", base.at);
  assert.equal(existing.mode, "HISTORICAL");
  assert.equal(existing.selected.evidence_snapshot.run_id, "historical-friday");
  const future = resolveTsForecastContext(before, friday.evidence_snapshot.run_id, "2026-09-04T17:59:00-07:00");
  assert.equal(future.mode, "MISSING");
  assert.equal(future.selected, null, "never silently substitute the historical record");
  assert.match(future.consistencyError, /尚未形成/);
  assert.deepEqual(before, [historical, friday]);
});

test("the exact observation boundary is visible and a future checkpoint is not", () => {
  const at = friday.evidence_snapshot.market_time.observed_at;
  assert.equal(resolveTsForecastContext([friday], null, at).selected.evidence_snapshot.run_id, friday.evidence_snapshot.run_id);
  assert.equal(buildNextSessionObservation({ ...base, checkpoints: [], at }).forecast_id, friday.evidence_snapshot.run_id);
  const futureCheckpoint = { ...sundayFailure, ...timelineOccurrencesForPtDate("2026-09-04").find((row) => row.kind === "EVENING_ANALYSIS"), completed_at: "2026-09-05T01:12:00Z" };
  const card = buildNextSessionObservation({ ...base, outputs: [], checkpoints: [futureCheckpoint], at: "2026-09-05T01:01:00Z" });
  assert.equal(card.phase, "FORMING");
  assert.equal(card.latest_update, null);
});
