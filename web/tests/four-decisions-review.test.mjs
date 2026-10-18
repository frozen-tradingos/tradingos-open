import assert from "node:assert/strict";
import test from "node:test";
import { buildMacroEventLearning } from "../app/macro-event-learning.ts";
import { positionCheckSummary } from "../app/today-action.ts";
import { assessPositionRisks } from "../server/position-copilot.ts";
import { decisionReview } from "../app/decision-review.ts";
import { TS_SETTLEMENT_CAUSAL_CONTRACT } from "../app/ts-settlement.ts";

test("frozen source material is not a frozen macro call or a scored prediction", () => {
  const macro = {
    events: [{ event_id: "jobs", release_name: "Employment Situation", scheduled_at: "2026-09-04T12:30:00Z" }],
    observations: [{ series_id: "NONFARM_PAYROLL_CHANGE", value: -23, previous_value: 10 }, { series_id: "LNS14000000", value: 4.1, previous_value: 4.2 }],
    results: [], policy_results: [],
  };
  const evening = { record_id: "natural:evening:A1", role: "EVENING", observed_at: "2026-09-04T01:00:43Z", official_macro: macro, quotes: [], sector_advance_pct: 45.5 };
  const latest = { ...evening, role: "LATEST" };
  const [before] = buildMacroEventLearning([evening, latest], "2026-09-04T02:00:00Z").studies;
  assert.notEqual(before.stage, "FROZEN", "no saved call exists in the source A1");
  assert.equal(before.frozen_at, null);
  assert.match(before.limitations.join(" "), /原判断.*未.*冻结|未.*保存.*判断/);
  const reported = { ...latest, observed_at: "2026-09-04T15:00:00Z", official_macro: { ...macro, results: [{ status: "VERIFIED", release_name: "Employment Situation", scheduled_at: "2026-09-04T12:30:00Z", metrics: [{ name: "PAYROLL_EMPLOYMENT_CHANGE", value: 80000 }] }] } };
  const [after] = buildMacroEventLearning([evening, reported], "2026-09-04T16:00:00Z").studies;
  assert.notEqual(after.review?.verdict, "CORRECT");
  assert.notEqual(after.review?.verdict, "WRONG");
  assert.equal(after.frozen_at, null);
});

test("home risk distinguishes a fresh risk breach, missing plan and an expired check", () => {
  const at = Date.parse("2026-09-04T16:00:00Z"), row = { symbol: "SPY", quote_status: "LIVE", quote_as_of: new Date(at).toISOString(), risks: ["APPROVED_STOP_REACHED"] };
  const checkpoint = { kind: "POSITION_MONITOR", position_check: { checked_at: new Date(at).toISOString(), account_as_of: new Date(at).toISOString(), checks_completed: true, observations: [row, { ...row, symbol: "NOK", risks: ["PLAN_NOT_BOUND"] }] } };
  assert.equal(positionCheckSummary(checkpoint, at).alerts.length, 1);
  assert.equal(positionCheckSummary(checkpoint, at).gaps.length, 1);
  assert.equal(positionCheckSummary(checkpoint, at + 120000).current, true);
  assert.equal(positionCheckSummary(checkpoint, at + 120001).current, false);
  assert.equal(positionCheckSummary(checkpoint, at - 1).current, false);
  assert.equal(positionCheckSummary(null, at).current, false);
  assert.equal(positionCheckSummary(checkpoint, at + 120001).alerts.length, 0, "history stays available but is not a current alert");
});

test("risk display ages account and each source quote without renewing the 120-second contract", () => {
  const checkedAt = "2026-09-04T16:00:00.000Z", at = Date.parse(checkedAt), oldQuote = new Date(at - 119_000).toISOString();
  const position = { symbol: "AVGO", option_type: "call", expiration: "2026-09-04", strike: 100, contract_id: "synthetic-avgo", account_label: "账户-aaaaaaaaaaaaaaaa", direction: "long", quantity: 1, average_price: 2, bid: 1.2, ask: 1.3, as_of: oldQuote };
  const account = { source: "ROBINHOOD", status: "LIVE", as_of: checkedAt, positions: [position, { ...position, symbol: "SPY", contract_id: "synthetic-spy", as_of: checkedAt }] };
  const monitor = { positions: account.positions.map((row) => ({ position_id: `${row.symbol}-call-2026-09-04-100`, plan_status: "ACTIVE", plan_run_id: "synthetic-plan", plan_receipt_hash: "a".repeat(64), position_snapshot_hash: "b".repeat(64), checked_at: checkedAt, stop_loss_pct: -30, take_profit_pct: 50 })) };
  const check = assessPositionRisks(account, monitor, checkedAt, account), original = structuredClone(check);
  const checkpoint = { kind: "POSITION_MONITOR", position_check: check };
  assert.ok(positionCheckSummary(checkpoint, at + 1_000).check.observations[0].risks.includes("APPROVED_STOP_REACHED"), "exactly 120 source seconds remains usable, including non-SPY/QQQ plans");
  const later = positionCheckSummary(checkpoint, at + 1_001), stale = later.check.observations[0];
  assert.equal(stale.quote_status, "STALE");
  assert.equal(stale.exit_return_pct, null);
  assert.ok(stale.risks.includes("POSITION_QUOTE_STALE"));
  assert.ok(!stale.risks.includes("APPROVED_STOP_REACHED"));
  assert.ok(stale.risks.includes("EXPIRY_TODAY"), "quote expiry must not hide expiry risk");
  assert.equal(later.gaps.length, 1);
  assert.ok(later.alerts.some((row) => row.symbol === "SPY" && row.risks.includes("APPROVED_STOP_REACHED")), "another fresh holding retains its stop alert");
  for (const quote_as_of of [null, "invalid", new Date(at + 1_000).toISOString()]) {
    const missing = positionCheckSummary({ ...checkpoint, position_check: { ...check, observations: [{ ...check.observations[0], quote_as_of, risks: [] }] } }, at);
    assert.equal(missing.check.observations[0].exit_return_pct, null);
    assert.ok(missing.gaps[0].risks.includes("POSITION_QUOTE_UNAVAILABLE"));
    assert.match(missing.title, /检查缺口/);
  }
  for (const account_as_of of [oldQuote, null, "invalid", new Date(at + 2_000).toISOString()]) {
    const oldAccount = { ...checkpoint, position_check: { ...check, account_as_of } };
    assert.equal(positionCheckSummary(oldAccount, at + 1_001).current, false, "new check time never renews stale, missing or future account evidence");
    assert.match(positionCheckSummary(oldAccount, at + 1_001).title, /尚未核验/);
  }
  const noQuotes = assessPositionRisks({ ...account, positions: [{ ...position, expiration: "2026-09-11", as_of: null, bid: null, ask: null }] }, null, checkedAt);
  assert.match(positionCheckSummary({ ...checkpoint, position_check: noQuotes }, at).title, /检查缺口/);
  assert.deepEqual(check, original, "the archived risk check stays immutable");
});

test("five review dimensions do not infer Owner fault, trade PnL or scores from replay", () => {
  const row = { forecast_run_id: "natural:1", published_at: "2026-09-04T16:00:00Z", eligibility: "OFFICIAL_LIVE", scoring_contract: TS_SETTLEMENT_CAUSAL_CONTRACT, qualification: { status: "WAIT" }, forecast_identity: { status: "VERIFIED_RUNTIME", received_at: "2026-09-04T16:00:02Z", gateway_delay_ms: 2000 }, settlement: { contract_version: "v2", forecast_run_id: "natural:1", status: "RESOLVED", settled_at: "2026-09-04T17:00:00Z", symbols: { SPY: { forecast_direction: "BULLISH", actual_direction: "BEARISH", direction_correct: false }, QQQ: { forecast_direction: "RANGE", actual_direction: "RANGE", direction_correct: true } } } };
  const at = Date.parse("2026-09-04T17:00:01Z");
  const review = decisionReview({ recent: [row] }, at);
  assert.equal(review.forecastId, row.forecast_run_id);
  assert.equal(review.dimensions.length, 5);
  assert.match(review.dimensions[0].result, /SPY.*不符.*QQQ.*相符/);
  assert.match(review.dimensions[2].result, /2秒.*不等于你已看见/);
  assert.match(review.dimensions[3].result, /未达到条件.*不认定你错过/);
  assert.equal(decisionReview({ recent: [{ ...row, eligibility: "EXCLUDED_REPLAY" }] }, at).forecastId, null);
  assert.equal(decisionReview({ recent: [row] }, at - 2000).forecastId, null);
  assert.equal(decisionReview({ recent: [{ ...row, forecast_identity: { ...row.forecast_identity, status: "LEGACY_PROJECTION" } }] }, at).forecastId, null);
  const partial = { ...row, forecast_run_id: "latest-partial", published_at: "2026-09-04T16:01:00Z", settlement: { ...row.settlement, forecast_run_id: "latest-partial", status: "PARTIAL" } };
  const latestReview = decisionReview({ recent: [row, partial] }, at);
  assert.equal(latestReview.forecastId, "latest-partial");
  assert.match(latestReview.dimensions[0].result, /SPY.*不符.*路径未完整/);
});
