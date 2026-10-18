import test from "node:test";
import assert from "node:assert/strict";
import { buildTsSignalCandidate, settleTsSignalCandidate } from "../app/ts-signal-candidate.ts";
import { parseOutputEnvelope } from "../app/snapshot-import.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const observedAt = "2026-08-25T17:00:00.000Z";
const bars = (symbol, start, step) => Array.from({ length: 10 }, (_, index) => {
  const open = start + step * index, close = open + step;
  return { begins_at: new Date(Date.parse("2026-08-25T16:05:00.000Z") + index * 300_000).toISOString(), open, high: Math.max(open, close) + .02, low: Math.min(open, close) - .02, close, volume: 1_000 + index };
});
const market = {
  contract_name: "TRADING_OS_MARKET_DATA", contract_version: "v1", mode: "SHADOW", snapshot_id: "snapshot-1", snapshot_hash: "a".repeat(64), status: "LIVE", generated_at: observedAt, as_of: observedAt, freshness_seconds: 0,
  market_session: { state: "REGULAR", phase: "REGULAR", timezone: "America/New_York", observed_at: observedAt, market_date: "2026-08-25", source: "DERIVED_US_EQUITY_HOURS" },
  capabilities: { quotes: true, intraday_bars: true, daily_bars: true, option_chain: false, option_bbo: false, option_iv: false, option_greeks: false }, errors: [], providers: [], quotes: [], options: [], account: { source: "ROBINHOOD", status: "LIVE", as_of: observedAt, freshness_seconds: 0, account_count: 0, positions: [], orders: [], portfolio_value: null, option_value: null, realized_pnl: null }, discrepancies: [],
  bars: [
    { source: "ROBINHOOD", symbol: "SPY", interval: "5min", status: "LIVE", as_of: "2026-08-25T16:50:00.000Z", freshness_seconds: 300, bar_count: 10, daily_bar_count: 0, latest: null, values: bars("SPY", 650, -0.18), daily: [] },
    { source: "ROBINHOOD", symbol: "QQQ", interval: "5min", status: "LIVE", as_of: "2026-08-25T16:50:00.000Z", freshness_seconds: 300, bar_count: 10, daily_bar_count: 0, latest: null, values: bars("QQQ", 580, 0.18), daily: [] },
  ],
};

test("candidate freezes independent symbol and horizon contracts without changing official TS", () => {
  const candidate = buildTsSignalCandidate({ sourceMode: "LIVE", sourceRunId: "live-shadow:20260825T170000Z", slotId: "live-shadow:20260825T170000Z", officialForecastRunId: "official-1", observedAt, dataCutoffAt: observedAt, market });
  assert.ok(candidate);
  assert.equal(candidate.validation_status, "TS_SIGNAL_CANDIDATE_UNVALIDATED");
  assert.deepEqual(candidate.contracts.map((item) => `${item.symbol}:${item.horizon}`).sort(), ["QQQ:30M", "QQQ:60M", "SPY:30M", "SPY:60M"]);
  assert.equal(candidate.contracts.find((item) => item.symbol === "SPY" && item.horizon === "60M").forecast_layer.direction, "BULLISH");
  assert.equal(candidate.contracts.find((item) => item.symbol === "QQQ" && item.horizon === "60M").forecast_layer.direction, "BEARISH");
  assert.ok(candidate.contracts.filter((item) => item.horizon === "30M").every((item) => item.trade_qualification.conclusion === "NO_TRADE"));
  const raw = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "live-shadow:20260825T170000Z:TS_SIGNAL_CANDIDATE", output_type: "TS_SIGNAL_CANDIDATE", channel: "SHADOW", observed_at: candidate.observed_at, payload: candidate });
  assert.equal(parseOutputEnvelope(raw).output_type, "TS_SIGNAL_CANDIDATE");
});

test("candidate settlement freezes each horizon independently and uses only fully causal bars", () => {
  const candidate = buildTsSignalCandidate({ sourceMode: "LIVE", sourceRunId: "live-shadow:20260825T170000Z", slotId: "live-shadow:20260825T170000Z", officialForecastRunId: "official-1", observedAt, dataCutoffAt: observedAt, market });
  assert.ok(candidate);
  const after = (symbol, step) => Array.from({ length: 12 }, (_, index) => { const open = 600 + step * index, close = open + step; return { begins_at: new Date(Date.parse(observedAt) + index * 300_000).toISOString(), open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1_000 }; });
  const history = { SPY: after("SPY", 0.1), QQQ: after("QQQ", -0.1) };
  assert.equal(settleTsSignalCandidate(candidate, history, observedAt, "2026-08-25T17:29:59.000Z", "30M"), null);
  const thirty = settleTsSignalCandidate(candidate, history, observedAt, "2026-08-25T17:30:00.000Z", "30M");
  assert.ok(thirty); assert.equal(thirty.contract_version, "TS_SIGNAL_CANDIDATE_SETTLEMENT_V2"); assert.equal(thirty.horizon, "30M");
  assert.equal(thirty.results.length, 2); assert.ok(thirty.results.every((item) => item.status === "SETTLED" && item.bar_count === 6));
  assert.equal(settleTsSignalCandidate(candidate, history, observedAt, "2026-08-25T17:59:59.000Z", "60M"), null);
  const sixty = settleTsSignalCandidate(candidate, history, observedAt, "2026-08-25T18:00:00.000Z", "60M");
  assert.ok(sixty); assert.equal(sixty.horizon, "60M"); assert.ok(sixty.results.every((item) => item.status === "SETTLED" && item.bar_count === 12));
  const raw = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `${candidate.candidate_forecast_id}:settlement:30M`, output_type: "TS_SIGNAL_CANDIDATE_SETTLEMENT", channel: "SHADOW", observed_at: thirty.settled_at, payload: thirty });
  assert.equal(parseOutputEnvelope(raw).output_type, "TS_SIGNAL_CANDIDATE_SETTLEMENT");
});

test("candidate settlement starts at the first aligned bar after received_at and excludes bars closing after expiry", () => {
  const candidate = buildTsSignalCandidate({ sourceMode: "LIVE", sourceRunId: "live-shadow:20260825T170000Z", slotId: "live-shadow:20260825T170000Z", officialForecastRunId: "official-1", observedAt, dataCutoffAt: observedAt, market });
  assert.ok(candidate);
  const receivedAt = "2026-08-25T17:02:00.000Z", after = (step) => Array.from({ length: 12 }, (_, index) => { const open = 600 + step * index, close = open + step; return { begins_at: new Date(Date.parse(observedAt) + index * 300_000).toISOString(), open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1_000 }; });
  const settlement = settleTsSignalCandidate(candidate, { SPY: after(.1), QQQ: after(-.1) }, receivedAt, "2026-08-25T17:30:00.000Z", "30M");
  assert.ok(settlement); assert.ok(settlement.results.every((item) => item.status === "SETTLED" && item.bar_count === 5));
  assert.equal(settlement.results.find((item) => item.symbol === "SPY").start_price, 600.1);
});

test("candidate research inventory is idempotent and never duplicates", () => {
  const candidate = buildTsSignalCandidate({ sourceMode: "LIVE", sourceRunId: "live-shadow:20260825T170000Z", slotId: "live-shadow:20260825T170000Z", officialForecastRunId: "official-1", observedAt, dataCutoffAt: observedAt, market });
  assert.ok(candidate);
  const raw = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "live-shadow:20260825T170000Z:TS_SIGNAL_CANDIDATE", output_type: "TS_SIGNAL_CANDIDATE", channel: "SHADOW", observed_at: candidate.observed_at, payload: candidate });
  const root = mkdtempSync(join(tmpdir(), "ts-candidate-")), store = openSnapshotDatabase(join(root, "candidate.sqlite"));
  try {
    assert.equal(store.importOutputRaw(raw, observedAt, true).duplicate, false);
    assert.equal(store.importOutputRaw(raw, observedAt, true).duplicate, true);
    assert.equal(store.getActive().outputs.TS_SIGNAL_CANDIDATE.length, 1);
    assert.equal(store.getActive().outputs.TS_SIGNAL_CANDIDATE_SETTLEMENT.length, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the existing settlement executor emits each due candidate horizon once", () => {
  const candidate = buildTsSignalCandidate({ sourceMode: "LIVE", sourceRunId: "live-shadow:20260825T170000Z", slotId: "live-shadow:20260825T170000Z", officialForecastRunId: "official-1", observedAt, dataCutoffAt: observedAt, market });
  assert.ok(candidate);
  const root = mkdtempSync(join(tmpdir(), "ts-candidate-settlement-")), file = join(root, "candidate.sqlite"), raw = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "live-shadow:20260825T170000Z:TS_SIGNAL_CANDIDATE", output_type: "TS_SIGNAL_CANDIDATE", channel: "SHADOW", observed_at: candidate.observed_at, payload: candidate });
  let store = openSnapshotDatabase(file);
  try { store.importOutputRaw(raw, observedAt, true); } finally { store.close(); }
  const database = new DatabaseSync(file), insert = database.prepare("INSERT INTO ts_market_bars (source, symbol, begins_at, session_date, open, high, low, close, volume, snapshot_hash, observed_at) VALUES ('ROBINHOOD', ?, ?, '2026-08-25', ?, ?, ?, ?, 1000, ?, ?)");
  for (const symbol of ["SPY", "QQQ"]) for (let index = 0; index < 12; index += 1) { const beginsAt = new Date(Date.parse(observedAt) + index * 300_000).toISOString(), open = 600 + index * .1; insert.run(symbol, beginsAt, open, open + .2, open - .1, open + .1, "c".repeat(64), beginsAt); }
  database.close(); store = openSnapshotDatabase(file);
  try {
    store.settleTsForecasts("2026-08-25T17:30:00.000Z");
    assert.deepEqual(store.getActive().outputs.TS_SIGNAL_CANDIDATE_SETTLEMENT.filter((item) => item.candidate_forecast_id === candidate.candidate_forecast_id).map((item) => item.horizon), ["30M"]);
    store.settleTsForecasts("2026-08-25T17:30:00.000Z");
    assert.equal(store.getActive().outputs.TS_SIGNAL_CANDIDATE_SETTLEMENT.filter((item) => item.candidate_forecast_id === candidate.candidate_forecast_id).length, 1);
    store.settleTsForecasts("2026-08-25T18:00:00.000Z");
    const rows = store.getActive().outputs.TS_SIGNAL_CANDIDATE_SETTLEMENT.filter((item) => item.candidate_forecast_id === candidate.candidate_forecast_id);
    assert.deepEqual(rows.map((item) => item.horizon).sort(), ["30M", "60M"]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
