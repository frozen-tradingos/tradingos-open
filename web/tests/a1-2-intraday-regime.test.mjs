import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { evaluateIntradayRegime } from "../app/intraday-regime.ts";
import { resolveSpxDataCapability } from "../app/spx-data-contract.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";

const id = (event, index) => ({ ...event, event_id: `test-regime-${index}` });
function charts(count, status = "LIVE") {
  return [["SPY", 100, .2], ["QQQ", 200, .4]].map(([symbol, start, step]) => ({
    source: "ROBINHOOD", symbol, interval: "5m", status,
    bars: Array.from({ length: count }, (_, index) => {
      const close = start + step * index;
      return { begins_at: new Date(Date.parse("2026-08-24T13:30:00.000Z") + index * 300_000).toISOString(), open: close - step / 2, high: close + step / 2, low: close - step / 2, close, volume: 10_000 + index };
    }),
  }));
}

test("SPX market contract accepts only fresh direct SPX spot and real five-minute OHLC", () => {
  const at = "2026-08-24T14:00:00.000Z";
  assert.deepEqual([resolveSpxDataCapability(null, at).status, resolveSpxDataCapability(null, at).analysis_mode], ["DATA_BLOCKED", "SPY_PROXY"]);
  const candidate = { source: "ROBINHOOD_OFFICIAL_MCP", authorization: "READ_ONLY", symbol: "SPX", derived: false, observed_at: at, session: "RTH", spot: { value: 6500, market_time: "2026-08-24T13:59:30.000Z" }, bars_5m: [{ symbol: "SPX", begins_at: "2026-08-24T13:55:00.000Z", open: 6495, high: 6502, low: 6494, close: 6500 }] };
  const live = resolveSpxDataCapability(candidate, at);
  assert.deepEqual([live.status, live.analysis_mode, live.spot.value, live.kline_5m.bar_count], ["LIVE", "SPX_DIRECT", 6500, 1]);
  assert.deepEqual([resolveSpxDataCapability({ ...candidate, symbol: "SPY" }, at).status, resolveSpxDataCapability({ ...candidate, derived: true }, at).status, resolveSpxDataCapability(candidate, "2026-08-24T14:20:00.000Z").status, resolveSpxDataCapability({ ...candidate, bars_5m: [{ ...candidate.bars_5m[0], high: 6400 }] }, at).status], ["DATA_BLOCKED", "DATA_BLOCKED", "DATA_BLOCKED", "DATA_BLOCKED"]);
});

test("a blocked morning can requalify, confirmation precedes chase risk, and research stays excluded", () => {
  const blocked = id(evaluateIntradayRegime({ charts: [], observedAt: "2026-08-24T13:50:00.000Z", previous: null }), 0);
  const candidate = id(evaluateIntradayRegime({ charts: charts(5), observedAt: "2026-08-24T13:55:00.001Z", previous: blocked }), 1);
  const confirmed = id(evaluateIntradayRegime({ charts: charts(6), observedAt: "2026-08-24T14:00:00.001Z", previous: candidate }), 2);
  const extended = id(evaluateIntradayRegime({ charts: charts(7), observedAt: "2026-08-24T14:05:00.001Z", previous: confirmed }), 3);
  assert.deepEqual([blocked.state, candidate.path_stage, candidate.requalification.status], ["DATA_BLOCKED", "FORMING", "REQUALIFIED"]);
  assert.deepEqual([confirmed.path_stage, confirmed.participation_window.status === "CHASE_RISK_HIGH", extended.participation_window.status], ["CONFIRMED", false, "CHASE_RISK_HIGH"]);
  assert.equal(confirmed.measurement.system_confirmed_at <= extended.data_timestamp, true);
  const research = evaluateIntradayRegime({ charts: charts(6), observedAt: "2026-08-24T14:00:00.001Z", previous: null, sourceMode: "RESEARCH" });
  assert.deepEqual([research.source_mode, research.replay, research.evidence_eligibility, research.execution_scope], ["RESEARCH", false, "EXCLUDED_RESEARCH", "OBSERVATION_ONLY_NO_ORDER"]);
});

test("stale charts fail closed without generating SPX levels or carrying an old trend", () => {
  const event = evaluateIntradayRegime({ charts: charts(6, "STALE"), observedAt: "2026-08-24T14:00:00.001Z", previous: null });
  assert.deepEqual([event.state, event.direction, event.path_stage, event.participation_window.status, event.evidence.spx_spot_used, event.evidence.spx_kline_used], ["DATA_BLOCKED", "NONE", "NOT_FORMED", "DATA_BLOCKED", false, false]);
});

test("new direction and same-direction requalification clear prior confirmation while a continuous path keeps its own clock", () => {
  const prices = [100, 100, 100, 99.8, 99.6, 99.4, 99.2, 99, 99.1, 99.4, 99.8, 100.2, 100.4, 100.6, 100.8, 101, 100.6, 100.2, 99.8, 99.7, 100, 100.4, 100.8, 101.2, 101.4, 101.6];
  const at = (count) => new Date(Date.parse("2026-08-24T13:30:00.000Z") + count * 300_000).toISOString();
  const evidence = (count) => ["SPY", "QQQ"].map((symbol, index) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: prices.slice(0, count).map((price, bar) => ({ begins_at: at(bar), open: price * (index + 1), high: (price + .05) * (index + 1), low: (price - .05) * (index + 1), close: price * (index + 1), volume: 10_000 })) }));
  const events = new Map(); let previous = null;
  for (let count = 3; count <= prices.length; count += 1) {
    previous = id(evaluateIntradayRegime({ charts: evidence(count), observedAt: at(count), previous }), count);
    events.set(count, previous);
  }
  assert.deepEqual([events.get(8).direction, events.get(8).path_stage, events.get(12).path_stage], ["DOWN", "CONFIRMED", "INVALIDATED"]);
  for (const [candidateIndex, confirmedIndex] of [[13, 15], [23, 25]]) {
    const candidate = events.get(candidateIndex), confirmed = events.get(confirmedIndex), continued = events.get(confirmedIndex + 1);
    assert.deepEqual([candidate.direction, candidate.path_stage, candidate.measurement.qualification_started_at, candidate.measurement.system_confirmed_at, candidate.measurement.confirmation_delay_minutes, candidate.participation_window.opened_at], ["UP", "FORMING", at(candidateIndex), null, null, null]);
    assert.deepEqual([confirmed.path_stage, confirmed.measurement.qualification_started_at, confirmed.measurement.system_confirmed_at, confirmed.participation_window.opened_at], ["CONFIRMED", at(candidateIndex), at(confirmedIndex), at(confirmedIndex)]);
    assert.deepEqual([continued.state, continued.measurement.qualification_started_at, continued.measurement.system_confirmed_at, continued.participation_window.opened_at], ["TREND_CONTINUATION", at(candidateIndex), at(confirmedIndex), at(confirmedIndex)]);
  }
  const old = events.get(10), frozenOld = JSON.stringify(old);
  const directlyReversed = evaluateIntradayRegime({ charts: evidence(15), observedAt: at(15), previous: old });
  assert.equal(old.participation_window.status, "CHASE_RISK_HIGH");
  assert.deepEqual([directlyReversed.direction, directlyReversed.path_stage, directlyReversed.measurement.qualification_started_at, directlyReversed.measurement.system_confirmed_at, directlyReversed.participation_window.opened_at, directlyReversed.participation_window.closed_at], ["UP", "CONFIRMED", at(15), at(15), at(15), null]);
  assert.notEqual(directlyReversed.participation_window.status, "CHASE_RISK_HIGH", "the opposite path cannot inherit the old closed participation window");
  assert.equal(JSON.stringify(old), frozenOld, "prior events remain immutable");
});

test("SQLite stores only append-only natural regime evidence and CURRENT_TRUTH reads it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-a1-2-")), file = join(directory, "a1-2.sqlite"), store = openSnapshotDatabase(file);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const recorded = store.recordTsMarketCharts(charts(6), "2026-08-24T14:00:00.001Z");
  assert.equal(recorded.intradayEvents, 1);
  const active = store.getActive();
  assert.deepEqual([active.intradayRegime.current.source_mode, active.currentTruth.intraday_regime.data_time, active.currentTruth.spx_market_data.status], ["LIVE", "2026-08-24T14:00:00.000Z", "DATA_BLOCKED"]);
  store.close();
  const audit = new DatabaseSync(file);
  const row = audit.prepare("SELECT source_mode, evidence_eligibility FROM ts_intraday_regime_events").get();
  assert.deepEqual([row.source_mode, row.evidence_eligibility], ["LIVE", "NATURAL_STRUCTURE_ONLY"]);
  assert.throws(() => audit.prepare("UPDATE ts_intraday_regime_events SET state='RANGE'").run(), /append-only/);
  assert.throws(() => audit.prepare("DELETE FROM ts_intraday_regime_events").run(), /append-only/);
  audit.close();
});
