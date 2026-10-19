// SYNTHETIC only: isolated SQLite fixtures, no credentials, providers, models or natural performance evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { validateSourceSettings } from "../../tools/source-settings.mjs";

const root = resolve(import.meta.dirname, "../.."), working = join(root, "_工作文件");
const observed = "2026-08-11T13:30:00.000Z", received = "2026-08-11T13:32:00.000Z", finish = "2026-08-11T14:06:00.000Z";
const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
function selection(revision = 1, provider = "TRADIER", environment = "LIVE", news = "OFFICIAL_ONLY") {
  const body = { version: 1, revision, selected: { market: { provider, environment }, news: { provider: news }, broker: { provider: "NONE" } } };
  return validateSourceSettings({ ...body, selection_id: createHash("sha256").update(JSON.stringify(body)).digest("hex") });
}
async function fixture(context) {
  await mkdir(working, { recursive: true });
  const directory = await mkdtemp(join(working, "synthetic-source-isolation-")), file = join(directory, "fixture.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  return file;
}
function forecast(suffix = "aaaaaaaaaa") {
  const output = structuredClone(sample.contracts.TS_OUTPUT[0]);
  output.report_type = "OPENING_FORECAST";
  output.evidence_snapshot.run_id = `20260811T133000Z-${suffix}`;
  output.evidence_snapshot.packet_hash = "c".repeat(64);
  output.evidence_snapshot.market_time = { timezone: "America/Los_Angeles", observed_at: observed, market_date: "2026-08-11", state: "OPEN" };
  output.forecast_window = { horizon: "OPEN_TO_60_MINUTES", start_at: observed, end_at: "2026-08-11T14:00:00.000Z", end_condition: "AT_TIMESTAMP" };
  output.forecast_update = { mode: "NEW", prior_run_id: null, prior_forecast_hash: null, prior_status: "NOT_APPLICABLE", change_summary: "SYNTHETIC test forecast" };
  output.next_validation = { at: output.forecast_window.end_at, checkpoint: "OPEN_30M", purpose: "SYNTHETIC test window" };
  return output;
}
function envelope(output, id = "live-shadow:20260811T133000Z:TS") { return JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: id, output_type: "TS_SHADOW_OUTPUT", channel: "SHADOW", observed_at: observed, payload: output }); }
function frozenEvidence(db, chosen, output, mutate = () => {}) {
  const market = { status: "LIVE", snapshot_id: `market-${"a".repeat(24)}`, snapshot_hash: "b".repeat(64), providers: [{ source: chosen.selected.market.provider, status: "LIVE" }], quotes: [], bars: [], options: [] };
  const a1 = { source_mode: "LIVE", market_sources: market, v2_result: { source_selection: chosen } };
  const a2 = { source_mode: "LIVE", v2_result: { source_selection: chosen, packet: { run_id: output.evidence_snapshot.run_id, packet_hash: output.evidence_snapshot.packet_hash, a1: { market_data: { source: chosen.selected.market.provider, snapshot_id: market.snapshot_id, snapshot_hash: market.snapshot_hash } } } } };
  const rows = { a1, a2, a1Received: "2026-08-11T13:30:30.000Z", a2Received: "2026-08-11T13:31:00.000Z" }; mutate(rows);
  const insert = db.prepare("INSERT INTO output_records(record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,?,'SHADOW',?,?,?,?,?)");
  for (const [component, payload, at] of [["A1", a1, rows.a1Received], ["A2", a2, rows.a2Received]]) { const raw = JSON.stringify(payload); insert.run(`live-shadow:20260811T133000Z:${component}`, `${component}_SHADOW_RESULT`, observed, at, raw, raw, "f".repeat(64)); }
}
function charts(chosen, source = chosen.selected.market.provider) {
  return [["SPY", 100], ["QQQ", 200]].map(([symbol, price]) => ({ source, source_selection_id: chosen.selection_id, source_revision: chosen.revision, environment: chosen.selected.market.environment, symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: 7 }, (_, index) => ({ begins_at: new Date(Date.parse(observed) + index * 300_000).toISOString(), open: price, high: price + 1, low: price - 1, close: price + .1, volume: 1000 })) }));
}

test("SYNTHETIC selected bars preserve provider and epoch; stale/wrong-source/sandbox charts cannot enter or rewrite legacy bars", async (context) => {
  const file = await fixture(context), initial = selection();
  let store = openSnapshotDatabase(file), db = new DatabaseSync(file);
  store.recordTsMarketCharts(charts(selection(1, "ROBINHOOD")).map(({ source, symbol, interval, status, bars }) => ({ source, symbol, interval, status, bars })), finish);
  const old = db.prepare("SELECT * FROM ts_market_bars ORDER BY symbol,begins_at").all();
  store.close(); store = openSnapshotDatabase(file, { sourceSelection: initial });
  store.recordTsMarketCharts(charts(initial, "ROBINHOOD"), finish);
  store.recordTsMarketCharts(charts({ ...initial, revision: 99 }), finish);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ts_source_market_bars").get().n, 0);
  store.recordTsMarketCharts(charts(initial), finish);
  assert.deepEqual(db.prepare("SELECT DISTINCT source,selection_id FROM ts_source_market_bars").all().map((row) => ({ ...row })), [{ source: "TRADIER", selection_id: initial.selection_id }]);
  assert.equal(store.getActive().intradayRegime.current, null, "Robinhood-specific regime is not renamed to Tradier");
  store.close(); const next = selection(2); store = openSnapshotDatabase(file, { sourceSelection: next });
  store.recordTsMarketCharts(charts(initial), finish);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ts_source_market_bars WHERE selection_id=?").get(next.selection_id).n, 0);
  store.recordTsMarketCharts(charts(next), finish);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ts_source_market_bars").get().n, 28);
  store.close(); store = openSnapshotDatabase(file, { sourceSelection: selection(3, "TRADIER", "SANDBOX") });
  store.recordTsMarketCharts(charts(selection(3, "TRADIER", "SANDBOX")), finish);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ts_source_market_bars").get().n, 28);
  assert.deepEqual(db.prepare("SELECT * FROM ts_market_bars ORDER BY symbol,begins_at").all(), old);
  store.close(); db.close();
});

test("SYNTHETIC forecast binding needs the same selected A1/A2/TS and ordered receipts; configuration alone is not verified", async (context) => {
  const mutations = [null, (r) => { r.a1.v2_result.source_selection = selection(2); }, (r) => { r.a2.v2_result.packet.a1.market_data.source = "ROBINHOOD"; }, (r) => { r.a2.v2_result.packet.a1.market_data.snapshot_hash = "e".repeat(64); }, (r) => { r.a2.v2_result.packet.packet_hash = "d".repeat(64); }, (r) => { r.a2.v2_result.packet.run_id = "foreign-run"; }, (r) => { r.a2Received = "2026-08-11T13:33:00.000Z"; }, (r) => { r.a1Received = "2026-08-11T13:31:30.000Z"; }];
  for (const [index, mutation] of mutations.entries()) {
    const file = await fixture(context), chosen = selection(), store = openSnapshotDatabase(file, { sourceSelection: chosen }), db = new DatabaseSync(file), output = forecast();
    if (index !== 0) frozenEvidence(db, chosen, output, mutation);
    store.importOutputRaw(envelope(output), received, true);
    assert.equal(db.prepare("SELECT verified FROM ts_forecast_source_bindings").get().verified, 0);
    assert.equal(db.prepare("SELECT forecast_identity_json FROM ts_forecast_archive").get().forecast_identity_json, null, "no old runtime option or source choice upgrades provenance");
    store.close(); db.close();
  }
  const file = await fixture(context), chosen = selection(), store = openSnapshotDatabase(file, { sourceSelection: chosen }), db = new DatabaseSync(file), output = forecast();
  frozenEvidence(db, chosen, output); store.importOutputRaw(envelope(output), received, true);
  assert.equal(db.prepare("SELECT verified FROM ts_forecast_source_bindings").get().verified, 1);
  assert.equal(db.prepare("SELECT forecast_identity_json FROM ts_forecast_archive").get().forecast_identity_json, null, "source binding does not replace actual bundled runtime verification");
  store.close(); db.close();
});

test("SYNTHETIC new epoch cannot settle old forecast, count old trusted days or expose its triggers; history stays immutable", async (context) => {
  const file = await fixture(context), chosen = selection(), next = selection(2), output = forecast();
  let store = openSnapshotDatabase(file, { sourceSelection: chosen }); const db = new DatabaseSync(file);
  frozenEvidence(db, chosen, output); store.importOutputRaw(envelope(output), received, true);
  // Controlled test-only identity fixture exercises cohort math, not a claim of real runtime/model provenance.
  const identity = { contract_id: "TS_FORECAST_IDENTITY@1.0.0", status: "VERIFIED_RUNTIME", forecast_contract_version: output.contract_version, model_release_commit: output.evidence_snapshot.release_commit, generator_commit: "a".repeat(40), runtime_release_sha256: "b".repeat(64), observed_at: observed, received_at: received, gateway_delay_ms: 120000 };
  db.prepare("UPDATE ts_forecast_archive SET forecast_identity_json=?").run(JSON.stringify(identity));
  const original = db.prepare("SELECT * FROM ts_forecast_archive").all();
  store.close(); store = openSnapshotDatabase(file, { sourceSelection: next });
  assert.equal(store.recordTsMarketCharts(charts(next), finish).newlySettled, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ts_forecast_settlements").get().n, 0);
  assert.equal(store.getActive().tsSettlement.official_live_count, 0);
  assert.equal(store.getActive().ownerTrigger.current.SPY, null);
  assert.equal(store.getCodexManagerState().ts_readiness.trusted_forecasts, 0);
  assert.deepEqual(db.prepare("SELECT * FROM ts_forecast_archive").all(), original);
  store.close(); store = openSnapshotDatabase(file, { sourceSelection: chosen });
  assert.equal(store.recordTsMarketCharts(charts(chosen), finish).newlySettled, 1);
  const settled = JSON.parse(db.prepare("SELECT payload_json FROM ts_forecast_settlements").get().payload_json);
  assert.equal(settled.source, "TRADIER"); assert.equal(settled.swing_observation.basis, "TRADIER_REGULAR_SESSION");
  assert.equal(store.getCodexManagerState().ts_readiness.trusted_forecasts, 1);
  assert.equal(store.getCodexManagerState().ts_readiness.independent_trading_days, 1);
  store.close(); store = openSnapshotDatabase(file, { sourceSelection: next });
  assert.equal(store.getActive().tsSettlement.settled_count, 0);
  assert.equal(store.getCodexManagerState().ts_readiness.independent_trading_days, 0);
  assert.equal(store.getActive().tsSettlement.recent.length, 1, "old record remains inspectable, never reclassified as a new-source sample");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ts_forecast_settlements").get().n, 1);
  store.close(); db.close();
});

test("SYNTHETIC file-backed worker and synchronous current-source projections agree; an old epoch never becomes a model/PAPER prior", async (context) => {
  const file = await fixture(context), chosen = selection(), next = selection(2), output = forecast(), run = "live-shadow:20260811T133000Z";
  let store = openSnapshotDatabase(file, { sourceSelection: chosen }); const db = new DatabaseSync(file);
  frozenEvidence(db, chosen, output); store.importOutputRaw(envelope(output), received, true);
  db.prepare("INSERT INTO ts_core_slot_ownership(slot_id,run_id,idempotency_key,lease_owner,lease_acquired_at,lease_expires_at,status,terminal_outcome,forecast_id,delivery_record_id,updated_at) VALUES (?,?,?,'SYNTHETIC',?,?,'TERMINAL','NO_TRADE',?,?,?)").run(run, run, run, observed, received, output.evidence_snapshot.run_id, `${run}:TS`, received);
  db.prepare("INSERT INTO agent_run_events(event_id,run_key,agent_id,skill_id,run_id,slot_id,channel,version,data_cutoff_at,event_at,status,output_status,evidence_refs_json,website_delivery,discord_delivery,received_at,raw_json,canonical_sha256) VALUES (?,?,'TS','TS_LIVE_SHADOW',?,?,'SHADOW','ts-output-v2',?,?,'SUCCEEDED','PRODUCED','[]','DELIVERED','NOT_APPLICABLE',?,'{}',?)").run("SYNTHETIC-delivery", `TS|TS_LIVE_SHADOW|${run}|${run}`, run, run, observed, received, received, "a".repeat(64));
  const before = JSON.stringify([db.prepare("SELECT * FROM output_records").all(), db.prepare("SELECT * FROM ts_forecast_archive").all()]);
  for (const changed of [false, true]) {
    if (changed) { store.close(); store = openSnapshotDatabase(file, { sourceSelection: next }); }
    const expected = changed ? [] : [output.evidence_snapshot.run_id];
    const current = store.getActive(), asynchronous = await store.getActiveAsync();
    assert.deepEqual(current.outputs.TS_SHADOW_OUTPUT.map((row) => row.evidence_snapshot.run_id), expected);
    assert.deepEqual(asynchronous.outputs.TS_SHADOW_OUTPUT, current.outputs.TS_SHADOW_OUTPUT);
    const syncContext = store.getRuntimeContext(), asyncContext = await store.getRuntimeContextAsync();
    assert.deepEqual(asyncContext.tsOutputs, syncContext.tsOutputs); assert.deepEqual(asyncContext.dataSources, syncContext.dataSources);
    assert.deepEqual(asyncContext.spxConvexity, syncContext.spxConvexity);
    assert.deepEqual((await store.getScheduleLedgerSupervisionAsync(finish)), store.getScheduleLedgerSupervision(finish));
    assert.equal(store.getLatestOutputRaw("A2_SHADOW_RESULT", "LIVE") === null, changed);
    assert.deepEqual(store.getPriorTsForecasts("2026-08-11T13:45:00.000Z").map((row) => row.forecast_id), expected);
    assert.deepEqual(store.getPaperForecastContext("2026-08-11T13:45:00.000Z").map((row) => row.forecast_id), expected);
    assert.equal(store.getPaperEntryMarketEvidence("SPY", finish), null, "Tradier PAPER pattern provenance is not connected");
  }
  assert.equal(JSON.stringify([db.prepare("SELECT * FROM output_records").all(), db.prepare("SELECT * FROM ts_forecast_archive").all()]), before);
  store.close(); db.close();
});

test("SYNTHETIC source status/news proof belongs to one selection; NONE/OFFICIAL_ONLY and a new revision cannot revive old FINNHUB results", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(received) + 601_000 });
  const file = await fixture(context), chosen = selection(1, "TRADIER", "LIVE", "FINNHUB");
  let store = openSnapshotDatabase(file); const db = new DatabaseSync(file);
  const source = { source: "FINNHUB", status: "LIVE", configured: true, authorization: "VALID", last_success_at: received, as_of: received, freshness_seconds: 0, error: null, checked_at: received, capabilities: { news: true } };
  const event = (id) => ({ event_id: `SYNTHETIC-${id}`, event_fingerprint: `SYNTHETIC-${id}`, kind: "NEWS", title: `SYNTHETIC ${id}`, source: "SYNTHETIC_OFFLINE", source_url: "https://example.invalid/synthetic", published_at: observed, scheduled_for: null, fetched_at: received, response_received_at: received, affected_symbols: ["SPY"], industry: null, event_type: "NEWS", event_category: "macro", novelty: "NEW", importance: "NOT_VERIFIED", event_evidence_state: "UNVERIFIED", expires_at: finish, raw_json: "{}", raw_sha256: "d".repeat(64) });
  store.importMarketIntelligence({ source, events: [event("old")] });
  const legacy = db.prepare("SELECT * FROM data_source_status").all();
  store.close(); store = openSnapshotDatabase(file, { sourceSelection: chosen });
  assert.equal(store.getActive().marketIntelligence.eventCount, 0);
  assert.equal(store.getRuntimeContext().dataSources.find((row) => row.source === "FINNHUB").status, "NOT_VERIFIED");
  store.importMarketIntelligence({ source, events: [event("new")] });
  assert.deepEqual(store.getRuntimeContext().marketIntelligence.events.map((row) => row.event_id), ["SYNTHETIC-new"]);
  assert.deepEqual(store.getRuntimeContext().marketIntelligence.causalChains.map((row) => row.chain_id), ["SYNTHETIC-new"]);
  assert.equal(store.getRuntimeContext().dataSources.find((row) => row.source === "FINNHUB").status, "LIVE");
  assert.equal(store.getRuntimeContext().dataSources.find((row) => row.source === "FINNHUB").freshness_seconds, 601);
  context.mock.timers.tick(60_000);
  const aged = store.getRuntimeContext().dataSources.find((row) => row.source === "FINNHUB");
  assert.equal(aged.freshness_seconds, 661); assert.equal(aged.as_of, received); assert.equal(aged.checked_at, received);
  assert.deepEqual(db.prepare("SELECT * FROM data_source_status").all(), legacy, "legacy source states are not overwritten by a selected epoch");
  for (const value of [selection(2, "TRADIER", "LIVE", "FINNHUB"), selection(3, "TRADIER", "LIVE", "NONE"), selection(4)]) {
    store.close(); store = openSnapshotDatabase(file, { sourceSelection: value });
    assert.deepEqual(store.getRuntimeContext().marketIntelligence.events, []);
    assert.notEqual(store.getRuntimeContext().dataSources.find((row) => row.source === "FINNHUB").status, "LIVE");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM market_events").get().n, 2);
  store.close(); db.close();
});

test("SYNTHETIC sandbox cannot insert a natural LIVE forecast and leaves no partial gateway record", async (context) => {
  const file = await fixture(context), chosen = selection(1, "TRADIER", "SANDBOX"), store = openSnapshotDatabase(file, { sourceSelection: chosen }), db = new DatabaseSync(file);
  assert.throws(() => store.importOutputRaw(envelope(forecast()), received, true), /Sandbox/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ts_forecast_archive").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM output_records").get().n, 0);
  store.close(); db.close();
});
