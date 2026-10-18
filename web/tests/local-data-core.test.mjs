import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { evaluateTsProduct, settleTsForecast } from "../app/ts-settlement.ts";
import { timelineOccurrencesForPtDate } from "../app/timeline-schedule.ts";
import { createExternalExpertMonitor } from "../server/external-expert-monitor.ts";
import { candidateSupervision } from "../server/codex-production-manager.ts";

test("PAPER entry-day projection retains a verified current-day CPI when a later complete calendar omits it", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T14:00:00Z") });
  const directory = await mkdtemp(join(tmpdir(), "trading-os-paper-cpi-day-")), file = join(directory, "fixture.sqlite"), store = openSnapshotDatabase(file), db = new DatabaseSync(file);
  context.after(async () => { db.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const archivedId = "live-shadow:20261014T010000Z:A1", latestId = "live-shadow:20261014T133000Z:A1";
  const event = { release_name: "Consumer Price Index", scheduled_at: "2026-10-14T12:00:00+00:00", source_url: "https://fred.stlouisfed.org/releases/calendar?rid=10&view=year", time_precision: "DATE_ONLY", confidence: "official_federal_reserve_aggregator_date_only" };
  const insert = db.prepare("INSERT INTO output_records(record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,?,'SHADOW',?,?,?,?,'test-only')");
  for (const [id, at, events] of [[archivedId, "2026-10-14T01:00:17Z", [event]], [latestId, "2026-10-14T13:35:31Z", [{ ...event, scheduled_at: "2026-11-10T12:00:00+00:00" }]]]) {
    const payload = JSON.stringify({ source_mode: "LIVE", official_macro: { status: "DEGRADED", collected_at: at, events, coverage: { inflation: "LIVE", employment: "LIVE", central_bank: "LIVE", growth: "LIVE" }, results: [] } });
    insert.run(id, "A1_SHADOW_RESULT", at, at, payload, payload);
  }
  const checkpoint = JSON.stringify({ ...timelineOccurrencesForPtDate("2026-10-13").find((row) => row.kind === "EVENING_ANALYSIS"), status: "SUCCEEDED", completed_at: "2026-10-14T01:02:00Z", result_ref: "sqlite://agent_run_events/live-shadow:20261014T010000Z" });
  insert.run("test-only:evening-cpi", "SCHEDULE_CHECKPOINT", "2026-10-14T01:02:00Z", "2026-10-14T01:02:00Z", checkpoint, checkpoint);
  const before = db.prepare("SELECT * FROM output_records ORDER BY sequence").all();
  for (const view of ["home", "forecast", "settlements"]) {
    const macro = store.getActive(view).macroEventLearning;
    assert.equal(macro.calendar.source_record_id, latestId, "the current calendar identity remains current");
    assert.equal(macro.entry_special_days.length, 1);
    assert.equal(macro.entry_special_days[0].source_record_id, archivedId, "the earlier known positive keeps its actual source identity");
    assert.equal(macro.entry_special_days[0].market_date, "2026-10-14");
    assert.equal(macro.entry_special_days[0].time_precision, "DATE_ONLY");
  }
  assert.deepEqual(db.prepare("SELECT * FROM output_records ORDER BY sequence").all(), before);
  assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events").all(), [], "projection must not rewrite old plans or create new ones");
});

test("PAPER formal forecast lookup binds delivery identity and receipts as of the decision without hiding an older delivered forecast", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-paper-forecast-context-")), file = join(directory, "fixture.sqlite"), store = openSnapshotDatabase(file), db = new DatabaseSync(file);
  context.after(async () => { db.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const add = ({ id, published, received = published, delivered = published, eventSlot, ownershipRecord, marketDate = "2026-10-01", eligibility = "OFFICIAL_LIVE", report = "INTRADAY_30_60M" }) => {
    const run = `live-shadow:20261001T${id}Z`, record = `${run}:TS`, forecast = `forecast-${id}`, payload = JSON.stringify({ id });
    db.prepare("INSERT INTO output_records(record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,'TS_SHADOW_OUTPUT','SHADOW',?,?,?,?,?)").run(record, published, received, payload, payload, "a".repeat(64));
    db.prepare("INSERT INTO ts_forecast_archive(forecast_run_id,source_record_id,source_mode,eligibility,published_at,market_date,official_slot,phase,report_type,forecast_hash,payload_json) VALUES (?,?,'LIVE',?,?,?,?,'INTRADAY_REVISION',?,?,?)").run(forecast, record, eligibility, published, marketDate, id, report, "b".repeat(64), payload);
    db.prepare("INSERT INTO ts_core_slot_ownership(slot_id,run_id,idempotency_key,lease_owner,lease_acquired_at,lease_expires_at,status,terminal_outcome,forecast_id,delivery_record_id,updated_at) VALUES (?,?,?,'test',?,?,'TERMINAL','NO_TRADE',?,?,?)").run(run, run, run, published, published, forecast, ownershipRecord ?? record, published);
    if (delivered) db.prepare("INSERT INTO agent_run_events(event_id,run_key,agent_id,skill_id,run_id,slot_id,channel,version,data_cutoff_at,event_at,status,output_status,evidence_refs_json,website_delivery,discord_delivery,received_at,raw_json,canonical_sha256) VALUES (?,?,'TS','TS_LIVE_SHADOW',?,?,'SHADOW','ts-output-v2',?,?,'SUCCEEDED','PRODUCED','[]','DELIVERED','NOT_APPLICABLE',?,'{}',?)").run(`delivered-${id}`, `TS|TS_LIVE_SHADOW|${run}|${eventSlot ?? run}`, run, eventSlot ?? run, published, delivered, delivered, "c".repeat(64));
    return forecast;
  };
  const old = add({ id: "133000", published: "2026-10-01T13:31:00Z", delivered: "2026-10-01T13:32:00Z" });
  add({ id: "134000", published: "2026-10-01T13:40:00Z", delivered: null });
  add({ id: "134100", published: "2026-10-01T13:41:00Z", eventSlot: "different-slot" });
  add({ id: "134200", published: "2026-10-01T13:42:00Z", ownershipRecord: "unrelated-output" });
  add({ id: "134300", published: "2026-10-01T13:43:00Z", marketDate: "2026-09-30" });
  add({ id: "134400", published: "2026-10-01T13:44:00Z", eligibility: "EXCLUDED_NON_LIVE" });
  add({ id: "134500", published: "2026-10-01T13:45:00Z", report: "NEXT_SESSION" });
  add({ id: "134600", published: "2026-10-01T13:46:00Z", received: "2026-10-01T14:10:00Z", delivered: "2026-10-01T14:11:00Z" });
  const pending = add({ id: "134700", published: "2026-10-01T13:47:00Z", delivered: "2026-10-01T14:01:00Z" });
  add({ id: "141000", published: "2026-10-01T14:10:00Z" });
  assert.deepEqual(store.getPaperForecastContext("not-a-time"), []);
  assert.deepEqual(store.getPaperForecastContext("2026-10-01T13:31:59Z"), []);
  assert.equal(store.getPaperForecastContext("2026-10-01T13:32:00Z")[0].forecast_id, old);
  assert.equal(store.getPaperForecastContext("2026-10-01T14:00:00Z")[0].forecast_id, old, "undelivered/latest, future receipts and foreign identities cannot hide an earlier delivered forecast");
  assert.equal(store.getPaperForecastContext("2026-10-01T14:01:00Z")[0].forecast_id, pending);
  assert.deepEqual(store.getPaperForecastContext("2026-10-02T14:01:00Z"), []);
});

test("PAPER previous-night lookup keeps only delivered background for the first target trading day across a weekend", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-paper-night-context-")), file = join(directory, "fixture.sqlite"), store = openSnapshotDatabase(file), db = new DatabaseSync(file);
  context.after(async () => { db.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const add = ({ id, observed, marketDate, received = observed, delivered = observed, eventSlot, report = "NEXT_SESSION" }) => {
    const run = `live-shadow:${id}`, record = `${run}:TS`, forecast = `forecast-${id}`, payload = JSON.stringify({ report_type: report, evidence_snapshot: { market_time: { market_date: marketDate } } });
    db.prepare("INSERT INTO output_records(record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,'TS_SHADOW_OUTPUT','SHADOW',?,?,?,?,?)").run(record, observed, received, payload, payload, "a".repeat(64));
    db.prepare("INSERT INTO ts_forecast_archive(forecast_run_id,source_record_id,source_mode,eligibility,published_at,market_date,official_slot,phase,report_type,forecast_hash,payload_json) VALUES (?,?,'LIVE','OFFICIAL_LIVE',?,?,?,'FINAL',?,?,?)").run(forecast, record, observed, marketDate, id, report, "b".repeat(64), payload);
    db.prepare("INSERT INTO ts_core_slot_ownership(slot_id,run_id,idempotency_key,lease_owner,lease_acquired_at,lease_expires_at,status,terminal_outcome,forecast_id,delivery_record_id,updated_at) VALUES (?,?,?,'test',?,?,'TERMINAL','NO_TRADE',?,?,?)").run(run, run, run, observed, observed, forecast, record, observed);
    if (delivered) db.prepare("INSERT INTO agent_run_events(event_id,run_key,agent_id,skill_id,run_id,slot_id,channel,version,data_cutoff_at,event_at,status,output_status,evidence_refs_json,website_delivery,discord_delivery,received_at,raw_json,canonical_sha256) VALUES (?,?,'TS','TS_LIVE_SHADOW',?,?,'SHADOW','ts-output-v2',?,?,'SUCCEEDED','PRODUCED','[]','DELIVERED','NOT_APPLICABLE',?,'{}',?)").run(`delivered-${id}`, `TS|TS_LIVE_SHADOW|${run}|${eventSlot ?? run}`, run, eventSlot ?? run, observed, delivered, delivered, "c".repeat(64));
    return forecast;
  };
  add({ id: "20260918T010000Z", observed: "2026-09-18T01:00:00Z", marketDate: "2026-09-17" });
  const weekend = add({ id: "20260919T010000Z", observed: "2026-09-19T01:00:00Z", marketDate: "2026-09-18", report: "WEEKEND_OUTLOOK" });
  add({ id: "20260920T010000Z", observed: "2026-09-20T01:00:00Z", marketDate: "2026-09-19", delivered: null });
  add({ id: "20260920T011500Z", observed: "2026-09-20T01:15:00Z", marketDate: "2026-09-19", eventSlot: "different-slot" });
  const sunday = add({ id: "20260921T010000Z", observed: "2026-09-21T01:00:00Z", marketDate: "2026-09-20", received: "2026-09-21T13:31:00Z", delivered: "2026-09-21T13:32:00Z" });
  const scope = "NEXT_SESSION_BACKGROUND";
  assert.deepEqual(store.getPaperForecastContext("not-a-time", scope), []);
  assert.deepEqual(store.getPaperForecastContext("2026-09-20T14:00:00Z", scope), [], "weekend reading cannot call Monday's background today's");
  assert.equal(store.getPaperForecastContext("2026-09-21T13:30:45Z", scope)[0].forecast_id, weekend);
  assert.equal(store.getPaperForecastContext("2026-09-21T13:32:00Z", scope)[0].forecast_id, sunday, "late delivery is usable only in an actually later review");
  assert.deepEqual(store.getPaperForecastContext("2026-09-21T13:32:00Z"), [], "default intraday scope remains unchanged");
  assert.deepEqual(store.getPaperForecastContext("2026-09-22T13:32:00Z", scope), [], "a weekend horizon cannot occupy every following trading day");
});

test("PAPER market evidence pairs A1/A2 snapshots and retains unknown confirmation when original pattern is absent", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-paper-entry-market-")), file = join(directory, "fixture.sqlite"), store = openSnapshotDatabase(file), db = new DatabaseSync(file);
  context.after(async () => { db.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const put = (id, type, at, received, payload) => { const raw = JSON.stringify(payload); db.prepare("INSERT INTO output_records(record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,?,'SHADOW',?,?,?,?,?)").run(id, type, at, received, raw, raw, "a".repeat(64)); };
  const bar = (begins_at) => ({ begins_at, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
  const a1 = { source_mode: "LIVE", mode: "SHADOW", market_snapshot_id: "snapshot-1", market_snapshot_hash: "b".repeat(64), market_sources: {
    snapshot_id: "snapshot-1", snapshot_hash: "b".repeat(64),
    bars: [{ source: "ROBINHOOD", symbol: "SPY", interval: "5min", status: "LIVE", as_of: "2026-10-01T13:45:00Z", values: ["2026-09-30T13:30:00Z", "2026-10-01T13:25:00Z", "2026-10-01T13:30:00Z", "2026-10-01T13:35:00Z", "2026-10-01T13:40:00Z", "2026-10-01T13:45:00Z", "2026-10-01T13:50:00Z"].map(bar) }],
    quotes: [{ source: "ROBINHOOD", symbol: "SPY", status: "LIVE", last: 100, bid: 99.99, ask: 100.01, as_of: "2026-10-01T13:45:10Z" }],
  } };
  const a2 = { source_mode: "LIVE", mode: "SHADOW", market_snapshot_id: a1.market_snapshot_id, market_snapshot_hash: a1.market_snapshot_hash,
    pattern_evidence: { source_mode: "LIVE", data_grade: "NATURAL_LIVE_SLOT", status: "HEALTHY" },
    v2_result: { analysis: { pattern_tracker: { status: "HEALTHY", updated_at: "2026-10-01T13:46:00Z", symbols: { SPY: { symbol: "SPY", current_state: "TREND_UP", direction: "bullish", data_time: "2026-10-01T13:40:00Z" } } } } } };
  const slot = "live-shadow:20261001T134500Z";
  put(`${slot}:A1`, "A1_SHADOW_RESULT", "2026-10-01T13:45:40Z", "2026-10-01T13:46:00Z", a1);
  put(`${slot}:A2`, "A2_SHADOW_RESULT", "2026-10-01T13:46:00Z", "2026-10-01T13:46:30Z", a2);
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "2026-10-01T13:45:59Z"), null);
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "2026-10-01T13:46:15Z").pattern, null, "a later A2 receipt cannot backfill confirmation");
  const known = store.getPaperEntryMarketEvidence("SPY", "2026-10-01T13:46:30Z");
  assert.deepEqual(known.bars.values.map(b => b.begins_at), ["2026-10-01T13:30:00Z", "2026-10-01T13:35:00Z", "2026-10-01T13:40:00Z"]);
  assert.deepEqual(known.pattern, { source: "A2_PATTERN_TRACKER_V1", regime: "TREND_UP", direction: "bullish" });
  assert.equal(known.source_ref, `${slot}:A1|${slot}:A2`);
  assert.equal(known.received_at, "2026-10-01T13:46:30Z");
  assert.equal(store.getPaperEntryMarketEvidence("QQQ", "2026-10-01T13:46:30Z"), null);
  put("live-shadow:20261001T134700Z:A2", "A2_SHADOW_RESULT", "2026-10-01T13:47:00Z", "2026-10-01T13:47:00Z", a2);
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "2026-10-01T13:47:00Z").source_ref, `${slot}:A1|${slot}:A2`, "another slot cannot replace the paired A2 even with the same snapshot hash");
  put("live-shadow:20261001T134710Z:A1", "A1_SHADOW_RESULT", "2026-10-01T13:47:10Z", "2026-10-01T13:47:10Z", a1);
  put("live-shadow:20261001T134710Z:A2", "A2_SHADOW_RESULT", "2026-10-01T13:47:10Z", "2026-10-01T13:47:10Z", { ...a2, market_snapshot_hash: "c".repeat(64) });
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "2026-10-01T13:47:10Z").pattern, null, "a same-slot A2 with a mismatched snapshot cannot fall back to an older matching A2");
  const wrongSymbol = structuredClone(a2); wrongSymbol.v2_result.analysis.pattern_tracker.symbols.SPY.symbol = "QQQ";
  put("live-shadow:20261001T134800Z:A1", "A1_SHADOW_RESULT", "2026-10-01T13:48:00Z", "2026-10-01T13:48:00Z", a1);
  put("live-shadow:20261001T134800Z:A2", "A2_SHADOW_RESULT", "2026-10-01T13:48:00Z", "2026-10-01T13:48:00Z", wrongSymbol);
  const missing = store.getPaperEntryMarketEvidence("SPY", "2026-10-01T13:48:00Z");
  assert.equal(missing.pattern, null, "cannot borrow another symbol's confirmed pattern");
  assert.equal(missing.bars.values.length, 3, "absence of original pattern retains actual bars, not guessed confirmation");
  const futureTracker = structuredClone(a2); futureTracker.v2_result.analysis.pattern_tracker.updated_at = "2026-10-01T14:00:00Z";
  put("live-shadow:20261001T134810Z:A1", "A1_SHADOW_RESULT", "2026-10-01T13:48:10Z", "2026-10-01T13:48:10Z", a1);
  put("live-shadow:20261001T134810Z:A2", "A2_SHADOW_RESULT", "2026-10-01T13:48:10Z", "2026-10-01T13:48:10Z", futureTracker);
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "2026-10-01T13:48:10Z").pattern, null);
  put("live-shadow:20261001T141000Z:A1", "A1_SHADOW_RESULT", "2026-10-01T14:10:00Z", "2026-10-01T13:48:30Z", { ...a1, market_sources: { bars: [], quotes: [] } });
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "2026-10-01T13:49:00Z").bars.values.length, 3);
  const futureQuote = structuredClone(a1); futureQuote.market_sources.quotes[0].as_of = "2026-10-01T13:50:00Z";
  put("live-shadow:20261001T134900Z:A1", "A1_SHADOW_RESULT", "2026-10-01T13:49:00Z", "2026-10-01T13:49:00Z", futureQuote);
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "2026-10-01T13:49:00Z").quote.status, "DATA_BLOCKED");
  const mismatch = structuredClone(a1); mismatch.market_sources.snapshot_hash = "d".repeat(64);
  put("live-shadow:20261001T135000Z:A1", "A1_SHADOW_RESULT", "2026-10-01T13:50:00Z", "2026-10-01T13:50:00Z", mismatch);
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "2026-10-01T13:50:00Z"), null, "wrapper and embedded market snapshot identities must agree");
  const delayed = structuredClone(a1);
  delayed.market_sources.bars[0].values.push(bar("2026-10-01T13:55:00Z"), bar("2026-10-01T14:00:00Z"));
  put("live-shadow:20261001T140000Z:A1", "A1_SHADOW_RESULT", "2026-10-01T14:00:10Z", "2026-10-01T14:06:00Z", delayed);
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "2026-10-01T14:06:00Z").bars.values.at(-1).begins_at, "2026-10-01T13:50:00Z", "a late receipt cannot turn a candle unfinished at source freeze into completed evidence");
  put("replay-shadow:20261001T140700Z:A1", "A1_SHADOW_RESULT", "2026-10-01T14:07:00Z", "2026-10-01T14:07:00Z", a1);
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "2026-10-01T14:07:00Z"), null, "a non-natural A1 cannot supply research entry confirmation");
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "2026-10-02T13:49:00Z"), null);
  assert.equal(store.getPaperEntryMarketEvidence("SPY", "invalid"), null);
});

test("incident and complaint writes read only the current snapshot ID, not the whole site", async () => {
  const moduleUrl = process.env.SQLITE_MAINTENANCE_BASELINE_ROOT ? pathToFileURL(join(process.env.SQLITE_MAINTENANCE_BASELINE_ROOT, "build/local-data-core.ts")) : new URL("../build/local-data-core.ts", import.meta.url);
  const { openSnapshotDatabase: openSelected } = await import(moduleUrl.href);
  const prepare = DatabaseSync.prototype.prepare;
  let fullReads = 0;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (sql === "SELECT COUNT(*) AS value FROM snapshots") {
      const get = statement.get.bind(statement);
      statement.get = (...args) => { fullReads++; return get(...args); };
    }
    return statement;
  };
  let store;
  try {
    store = openSelected(":memory:");
    const complaint = { problem: "test", category: "OTHER", severity: "LOW", page: "/", screenshot: null };
    store.createComplaint(complaint, "test");
    assert.equal(store.listComplaints()[0].snapshot_id, null);
    const sample = await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8");
    const snapshotId = JSON.parse(sample).snapshot_id;
    store.importRaw(sample);
    fullReads = 0;
    store.createComplaint(complaint, "test");
    store.reconcileIncidents([{ fingerprint: "minimal-read-guard", layer: "SERVICE", code: "TEST", severity: "WARNING", title: "test", run_id: null, suggestion: "test", details: {} }], "test");
    store.manageManagerIncident({ action: "OPEN_INCIDENT", fingerprint: "minimal-read-manager", title: "test", reason: "test", evidence_refs: [] });
    assert.equal(fullReads, 0, "three lightweight writes must not rebuild getActive");
    assert.equal(store.listComplaints().filter((row) => row.snapshot_id === snapshotId).length, 3);
  } finally { store?.close(); DatabaseSync.prototype.prepare = prepare; }
});

test("SQLite startup waits for a concurrent writer instead of crashing Tier0", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-busy-timeout-")), file = join(directory, "busy.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  openSnapshotDatabase(file).close();
  const writer = spawn(process.execPath, ["--input-type=module", "-e", `import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.argv[1]); db.exec("BEGIN IMMEDIATE"); process.stdout.write("locked\\n"); setTimeout(() => { db.exec("COMMIT"); db.close(); }, 250);`, file], { stdio: ["ignore", "pipe", "inherit"] });
  context.after(() => writer.kill());
  const exited = new Promise((resolve, reject) => { writer.once("exit", resolve); writer.once("error", reject); });
  await new Promise((resolve, reject) => { writer.stdout.once("data", resolve); writer.once("error", reject); });
  const started = Date.now(), store = openSnapshotDatabase(file);
  assert.ok(Date.now() - started >= 150);
  store.close();
  assert.equal(await exited, 0);
});

test("SQLite startup refreshes stale statistics and indexes actual latest-time queries without changing business rows", async (context) => {
  const moduleUrl = process.env.SQLITE_MAINTENANCE_BASELINE_ROOT ? pathToFileURL(join(process.env.SQLITE_MAINTENANCE_BASELINE_ROOT, "build/local-data-core.ts")) : new URL("../build/local-data-core.ts", import.meta.url);
  const { openSnapshotDatabase: openSelected } = await import(moduleUrl.href), source = await readFile(moduleUrl, "utf8");
  const directory = await mkdtemp(join(tmpdir(), "trading-os-startup-query-plan-")), file = join(directory, "source.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  openSelected(file).close();
  const tableRows = (db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_stat%' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
  const put = (db, id, observed, type = "A1_SHADOW_RESULT") => {
    const payload = JSON.stringify({ id, source_mode: "LIVE", official_macro: { collected_at: observed, events: [{ id: "test-event" }] } });
    db.prepare("INSERT INTO output_records(record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,?,'SHADOW',?,'2026-09-08T17:01:00.000Z',?,?,?)").run(id, type, observed, payload, payload, "a".repeat(64));
  };
  const setup = new DatabaseSync(file);
  let before, stale;
  try {
    put(setup, "live-shadow:seed", "2026-09-08T10:00:00.000Z");
    setup.exec("ANALYZE");
    for (let index = 0; index < 64; index++) put(setup, `live-shadow:filler-${index}`, "2026-09-08T10:00:00.000Z");
    stale = setup.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'output_records_projection'").get().stat;
    assert.equal(stale, "1 1 1 1");
    before = tableRows(setup);
  } finally { setup.close(); }
  openSelected(file).close(); // Execute the actual selected old/new startup, not a test replacement.
  const database = new DatabaseSync(file), control = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(tableRows(database), before, "startup may maintain indexes/statistics, never business rows");
    // Query-only edge cases follow startup: its existing ISO validation/normalization is not under test.
    put(database, "live-shadow:offset-older", "2026-09-08T23:30:00+08:00");
    put(database, "live-shadow:offset-latest", "2026-09-08T10:00:00-07:00");
    put(database, "live-shadow:tie-winner", "2026-09-08T17:00:00Z");
    put(database, "null-jd-first", "not-a-date", "A2_SHADOW_RESULT");
    put(database, "null-jd-last", "", "A2_SHADOW_RESULT");
    assert.throws(() => put(database, "literal-null-is-invalid", null), /NOT NULL constraint failed/);
    assert.equal(database.prepare("SELECT julianday(observed_at) AS value FROM output_records WHERE record_id = 'null-jd-last'").get().value, null);
    control.exec("CREATE TABLE output_records(sequence INTEGER PRIMARY KEY,record_id TEXT,output_type TEXT,channel TEXT,observed_at TEXT,received_at TEXT,payload_json TEXT,raw_json TEXT,raw_sha256 TEXT)");
    const copy = control.prepare("INSERT INTO output_records VALUES (?,?,?,?,?,?,?,?,?)");
    for (const row of database.prepare("SELECT * FROM output_records ORDER BY sequence").all()) copy.run(...Object.values(row));
    const queries = [["latestOutputTypeRow", ["A1_SHADOW_RESULT"], "live-shadow:tie-winner"], ["latestOutputTypeRow", ["A2_SHADOW_RESULT"], "null-jd-last"], ["latestReadonlyAccount", [], "live-shadow:tie-winner"], ["latestMacroCalendarA1", ["2026-09-08T17:00:00.000Z"], "live-shadow:tie-winner"]];
    const plans = [];
    for (const [name, params, expected] of queries) {
      const sql = source.match(new RegExp("const " + name + " = database\\.prepare\\(([\"`])([\\s\\S]*?)\\1\\);"))?.[2];
      assert.ok(sql, `must execute actual production ${name}`);
      const actual = database.prepare(sql).get(...params);
      assert.deepEqual(actual, control.prepare(sql).get(...params));
      assert.equal(actual.record_id ?? JSON.parse(actual.payload_json).id, expected);
      plans.push({ name, plan: database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) });
    }
    const refreshed = database.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'output_records_projection'").get().stat;
    const indexes = database.prepare("SELECT name,sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'output_records'").all();
    context.diagnostic(JSON.stringify({ stale, refreshed, business_rows: before.output_records.length, indexes, plans }));
    assert.equal(Number(refreshed.split(" ")[0]), before.output_records.length, "startup must refresh the old one-row statistics after growth");
    const index = indexes.find((row) => /output_records\s*\(\s*output_type\s*,\s*julianday\(observed_at\)\s+DESC\s*,\s*sequence\s+DESC\s*\)/i.test(row.sql ?? ""));
    assert.ok(index, "startup must add the native index matching the unchanged latest-time SQL");
    assert.ok(indexes.some((row) => row.name === "output_records_projection"), "keep the existing index");
    assert.ok(plans.every(({ plan }) => plan.some((row) => row.detail.includes(index.name)) && !plan.some((row) => row.detail.includes("TEMP B-TREE"))));
  } finally { database.close(); control.close(); }
});

test("pending candidate settlements reuse one materialized history subset with stale statistics and preserve horizon semantics", async (context) => {
  const source = await readFile(process.env.SQLITE_MAINTENANCE_BASELINE_ROOT ? join(process.env.SQLITE_MAINTENANCE_BASELINE_ROOT, "build/local-data-core.ts") : new URL("../build/local-data-core.ts", import.meta.url), "utf8");
  const sql = source.match(/const pendingCandidateRows = database\.prepare\(`([\s\S]*?)`\);/)?.[1];
  assert.ok(sql, "test must execute the actual pendingCandidateRows SQL from the selected source");
  const originalSql = `
    SELECT forecast.record_id, forecast.received_at, forecast.payload_json
    FROM output_records forecast
    WHERE forecast.output_type = 'TS_SIGNAL_CANDIDATE'
      AND (
        NOT EXISTS (SELECT 1 FROM output_records settlement WHERE settlement.output_type = 'TS_SIGNAL_CANDIDATE_SETTLEMENT' AND json_extract(settlement.payload_json, '$.candidate_forecast_id') = json_extract(forecast.payload_json, '$.candidate_forecast_id') AND (json_extract(settlement.payload_json, '$.contract_version') = 'TS_SIGNAL_CANDIDATE_SETTLEMENT_V1' OR json_extract(settlement.payload_json, '$.horizon') = '30M'))
        OR NOT EXISTS (SELECT 1 FROM output_records settlement WHERE settlement.output_type = 'TS_SIGNAL_CANDIDATE_SETTLEMENT' AND json_extract(settlement.payload_json, '$.candidate_forecast_id') = json_extract(forecast.payload_json, '$.candidate_forecast_id') AND (json_extract(settlement.payload_json, '$.contract_version') = 'TS_SIGNAL_CANDIDATE_SETTLEMENT_V1' OR json_extract(settlement.payload_json, '$.horizon') = '60M'))
      )
    ORDER BY julianday(forecast.observed_at)
  `;
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE output_records (sequence INTEGER PRIMARY KEY, record_id TEXT NOT NULL UNIQUE, output_type TEXT NOT NULL, observed_at TEXT NOT NULL, received_at TEXT NOT NULL, payload_json TEXT NOT NULL); CREATE INDEX output_records_projection ON output_records(output_type, observed_at DESC, sequence DESC)");
    const insert = database.prepare("INSERT INTO output_records(record_id, output_type, observed_at, received_at, payload_json) VALUES (?, ?, ?, ?, ?)");
    const put = (id, type, payload, minute = 0) => { const at = `2026-09-08T20:${String(minute).padStart(2, "0")}:00.000Z`; insert.run(id, type, at, at, JSON.stringify(payload)); };
    put("unrelated", "A1_SHADOW_RESULT", {});
    database.exec("ANALYZE"); // Reproduce the actual stale statistics; do not refresh them after growth.
    const cases = ["none", "30M-only", "60M-only", "both", "legacy-V1", "null-id", "missing-id"];
    cases.forEach((id, index) => put(id, "TS_SIGNAL_CANDIDATE", id === "missing-id" ? {} : { candidate_forecast_id: id === "null-id" ? null : id }, index + 1));
    for (const [id, horizons] of [["30M-only", ["30M"]], ["60M-only", ["60M"]], ["both", ["30M", "60M"]]]) {
      for (const horizon of horizons) put(`${id}:${horizon}`, "TS_SIGNAL_CANDIDATE_SETTLEMENT", { candidate_forecast_id: id, contract_version: "TS_SIGNAL_CANDIDATE_SETTLEMENT_V2", horizon });
    }
    put("legacy-settlement", "TS_SIGNAL_CANDIDATE_SETTLEMENT", { candidate_forecast_id: "legacy-V1", contract_version: "TS_SIGNAL_CANDIDATE_SETTLEMENT_V1" });
    put("null-settlement", "TS_SIGNAL_CANDIDATE_SETTLEMENT", { candidate_forecast_id: null, contract_version: "TS_SIGNAL_CANDIDATE_SETTLEMENT_V1" });
    put("missing-settlement", "TS_SIGNAL_CANDIDATE_SETTLEMENT", { contract_version: "TS_SIGNAL_CANDIDATE_SETTLEMENT_V1" });
    database.exec("ANALYZE sqlite_schema");
    const stats = database.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'output_records_projection'").get().stat;
    assert.equal(stats, "1 1 1 1");
    const rows = database.prepare(sql).all();
    assert.deepEqual(rows, database.prepare(originalSql).all());
    assert.deepEqual(rows.map((row) => row.record_id), ["none", "30M-only", "60M-only", "null-id", "missing-id"]);
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
    context.diagnostic(JSON.stringify({ stale_statistics: stats, pending_ids: rows.map((row) => row.record_id), query_plan: plan }));
    const materialized = plan.filter((row) => row.detail === "MATERIALIZE candidate_settlements");
    assert.equal(materialized.length, 1, "settlement history must be materialized once rather than rescanned for every candidate");
    assert.match(sql, /WITH\s+candidate_settlements\s+AS\s+MATERIALIZED\s*\(\s*SELECT\s+payload_json\s+FROM\s+output_records\s+WHERE\s+output_type\s*=\s*'TS_SIGNAL_CANDIDATE_SETTLEMENT'\s*\)/i);
    const historySources = plan.filter((row) => /\b(?:SCAN|SEARCH) output_records\b/.test(row.detail));
    assert.equal(historySources.length, 1);
    assert.equal(historySources[0].parent, materialized[0].id, "the original settlement history is read only to build the shared filtered subset");
    const correlated = plan.filter((row) => /^CORRELATED SCALAR SUBQUERY\b/.test(row.detail));
    const probes = plan.filter((row) => /\b(?:SCAN|SEARCH) settlement\b/.test(row.detail));
    assert.equal(correlated.length, 2);
    assert.equal(probes.length, 2);
    assert.ok(probes.every((row) => correlated.some((query) => query.id === row.parent)));
    assert.equal(sql.match(/\bFROM\s+candidate_settlements\s+settlement\b/gi)?.length, 2, "both horizon probes must reuse the same materialized subset");
  } finally { database.close(); }
});

test("candidate projection joins both horizons for its 20 forecasts and preserves a genuinely missing settlement", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-candidate-projection-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const missing of [false, true]) {
    const file = join(directory, `${missing}.sqlite`);
    openSnapshotDatabase(file).close();
    const database = new DatabaseSync(file);
    const insert = database.prepare("INSERT INTO output_records(record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,?,'SHADOW',?,?,?,?,?)");
    const put = (id, type, at, payload) => { const raw = JSON.stringify(payload); insert.run(id, type, at, at, raw, raw, "a".repeat(64)); };
    for (let index = 0; index < 21; index++) {
      const id = `candidate-${index}`, at = new Date(Date.parse("2026-09-25T14:00:00Z") + index * 60_000).toISOString();
      put(id, "TS_SIGNAL_CANDIDATE", at, { candidate_forecast_id: id, contracts: ["30M", "60M"].map((horizon) => ({ horizon, expires_at: "2026-09-25T16:00:00Z", data_freshness: { status: "LIVE" } })) });
      for (const horizon of ["30M", "60M"]) {
        if (missing && index === 5 && horizon === "60M") continue;
        put(`${id}:${horizon}`, "TS_SIGNAL_CANDIDATE_SETTLEMENT", at, { candidate_forecast_id: id, contract_version: "TS_SIGNAL_CANDIDATE_SETTLEMENT_V2", horizon });
      }
    }
    const before = database.prepare("SELECT * FROM output_records ORDER BY sequence").all();
    const store = openSnapshotDatabase(file);
    try {
      const state = store.getActive(), forecastIds = state.outputs.TS_SIGNAL_CANDIDATE.map((item) => item.candidate_forecast_id);
      assert.equal(forecastIds.length, 20);
      assert.ok(!forecastIds.includes("candidate-0"));
      assert.equal(state.outputs.TS_SIGNAL_CANDIDATE_SETTLEMENT.length, missing ? 39 : 40);
      assert.ok(state.outputs.TS_SIGNAL_CANDIDATE_SETTLEMENT.every((item) => forecastIds.includes(item.candidate_forecast_id)));
      assert.deepEqual(candidateSupervision(state, "2026-09-25T20:00:00Z").overdue_settlements, missing ? ["candidate-5:60M"] : []);
      assert.deepEqual(database.prepare("SELECT * FROM output_records ORDER BY sequence").all(), before);
    } finally { store.close(); database.close(); }
  }
});

test("closed-session idle option advice stays archived without permanent daily debt, while trading-day and actionable gaps remain", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-closed-advice-")), file = join(directory, "advice.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  openSnapshotDatabase(file).close();
  const database = new DatabaseSync(file);
  database.prepare("UPDATE option_lifecycle_state SET state_value = '2026-09-01T00:00:00Z' WHERE state_key = 'activated_at'").run();
  const insert = database.prepare("INSERT INTO output_records(record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,?,'SHADOW',?,?,?,?,?)");
  const put = (id, type, at, action) => {
    at = new Date(at).toISOString();
    const raw = JSON.stringify({ source_mode: "LIVE", observed_at: at, signal_id: id, state_id: id, owner_action: action, candidates: [], holdings: [{ holding_id: id, owner_action: action, symbol: "SPY", option_type: "call" }] });
    insert.run(id, type, at, at, raw, raw, "a".repeat(64));
  };
  put("sunday-wait", "OPTION_STRATEGY_SIGNAL", "2026-09-21T01:00:00Z", "WAIT");
  put("sunday-unsupported", "POSITION_COPILOT_STATE", "2026-09-21T01:00:00Z", "NOT_SUPPORTED");
  let store = openSnapshotDatabase(file);
  try {
    let result = store.settleTsForecasts("2026-09-28T20:01:00Z");
    assert.equal(result.optionDuePending, 0);
    assert.equal(result.optionNewlySettled, 0);
    assert.equal(store.getActive().optionLifecycle.pending_count, 0);
    store.close();
    put("friday-wait", "OPTION_STRATEGY_SIGNAL", "2026-09-25T14:00:00Z", "WAIT");
    put("sunday-exit", "POSITION_COPILOT_STATE", "2026-09-21T01:00:00Z", "EXIT");
    const before = database.prepare("SELECT * FROM output_records ORDER BY sequence").all();
    store = openSnapshotDatabase(file);
    result = store.settleTsForecasts("2026-09-28T20:01:00Z");
    assert.equal(result.optionDuePending, 2);
    assert.equal(result.status, "DATA_BLOCKED");
    assert.equal(store.getActive().optionLifecycle.pending_count, 2);
    assert.equal(database.prepare("SELECT count(*) AS n FROM option_advice_settlements").get().n, 0);
    assert.deepEqual(database.prepare("SELECT * FROM output_records ORDER BY sequence").all(), before);
  } finally { store.close(); database.close(); }
});

function runEvent(overrides = {}) {
  return {
    ledger_format: "TRADING_OS_AGENT_RUN_EVENT",
    ledger_version: 1,
    event_id: "ts-run-start",
    agent_id: "TS",
    skill_id: "TS_FORECAST",
    run_id: "cycle-20260811-1300",
    slot_id: "13:00",
    channel: "PRODUCTION",
    version: "ts-output-v2",
    data_cutoff_at: "2026-08-11T12:59:00.000Z",
    event_at: "2026-08-11T13:00:00.000Z",
    status: "STARTED",
    output_status: "NOT_PRODUCED",
    error: null,
    evidence_refs: [],
    website_delivery: "NOT_ATTEMPTED",
    discord_delivery: "NOT_ATTEMPTED",
    ...overrides,
  };
}

function settlementForecast(sample, runId = "20260811T133000Z-aaaaaaaaaa") {
  const output = structuredClone(sample.contracts.TS_OUTPUT[0]);
  output.report_type = "OPENING_FORECAST";
  output.evidence_snapshot.run_id = runId;
  output.evidence_snapshot.market_time = { timezone: "America/Los_Angeles", observed_at: "2026-08-11T13:30:00.000Z", market_date: "2026-08-11", state: "OPEN" };
  output.forecast_window = { horizon: "OPEN_TO_60_MINUTES", start_at: "2026-08-11T13:30:00.000Z", end_at: "2026-08-11T14:30:00.000Z", end_condition: "AT_TIMESTAMP" };
  output.forecast_update = { mode: "NEW", prior_run_id: null, prior_forecast_hash: null, prior_status: "NOT_APPLICABLE", change_summary: "首个可结算自然槽" };
  output.current_pattern = { regime: "TREND_UP", summary: "发布时为上升结构" };
  output.path_bias = "BULLISH";
  output.one_line_forecast = "主路径为温和上行；只按概率记录，不构成交易指令。";
  output.symbol_outlooks.SPY.direction = "BULLISH";
  output.symbol_outlooks.QQQ.direction = "BULLISH";
  output.key_levels = [
    { symbol: "SPY", label: "support", value: 99, basis: "FROZEN_MARKET" },
    { symbol: "SPY", label: "resistance", value: 102, basis: "FROZEN_MARKET" },
    { symbol: "QQQ", label: "support", value: 199, basis: "FROZEN_MARKET" },
    { symbol: "QQQ", label: "resistance", value: 202, basis: "FROZEN_MARKET" },
  ];
  const condition = (symbol, operator, value) => ({ symbol, metric: "LAST_PRICE", operator, value, upper_value: null, confirmation: "ONE_5M_CLOSE" });
  output.scenarios.main = { ...output.scenarios.main, bias: "BULLISH", probability_pct: 60, activation: { logic: "ALL", conditions: [condition("SPY", "AT_OR_ABOVE", 100)] }, sequence: [{ order: 1, label: "SPY 先确认", conditions: [condition("SPY", "AT_OR_ABOVE", 100.1)] }, { order: 2, label: "QQQ 跟随", conditions: [condition("QQQ", "AT_OR_ABOVE", 200.2)] }], invalidation: { logic: "ANY", conditions: [condition("SPY", "BELOW", 90)] } };
  output.scenarios.reverse = { ...output.scenarios.reverse, bias: "BEARISH", probability_pct: 25, activation: { logic: "ALL", conditions: [condition("SPY", "BELOW", 90)] }, sequence: [{ order: 1, label: "反向一", conditions: [condition("SPY", "BELOW", 89)] }, { order: 2, label: "反向二", conditions: [condition("QQQ", "BELOW", 189)] }], invalidation: { logic: "ANY", conditions: [condition("SPY", "ABOVE", 200)] } };
  output.scenarios.extreme = { ...output.scenarios.extreme, bias: "BEARISH", probability_pct: 15, activation: { logic: "ALL", conditions: [condition("SPY", "BELOW", 80)] }, sequence: [{ order: 1, label: "极端一", conditions: [condition("SPY", "BELOW", 79)] }, { order: 2, label: "极端二", conditions: [condition("QQQ", "BELOW", 179)] }], invalidation: { logic: "ANY", conditions: [condition("SPY", "ABOVE", 200)] } };
  output.next_validation = { at: "2026-08-11T14:30:00.000Z", checkpoint: "OPEN_30M", purpose: "结算观察窗口" };
  return output;
}

test("TS Core ownership survives restart and keeps one immutable terminal per official slot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-ts-core-owner-")), file = join(directory, "owner.sqlite"), slot = "live-shadow:20260825T133000Z";
  context.after(() => rm(directory, { recursive: true, force: true }));
  let store = openSnapshotDatabase(file);
  assert.equal(store.claimTsCoreSlot(slot, slot, "runtime:first", "2026-08-25T13:30:00.000Z").claim, "ACQUIRED");
  assert.equal(store.claimTsCoreSlot(slot, slot, "runtime:second", "2026-08-25T13:30:30.000Z").claim, "BUSY");
  assert.equal(store.renewTsCoreSlot(slot, "runtime:first", "2026-08-25T13:31:00.000Z"), true);
  store.close();

  store = openSnapshotDatabase(file);
  assert.equal(store.claimTsCoreSlot(slot, slot, "runtime:second", "2026-08-25T13:33:01.000Z").claim, "ACQUIRED");
  const terminal = store.completeTsCoreSlot(slot, "runtime:second", "NO_TRADE", "forecast-1", `${slot}:TS`, "2026-08-25T13:33:02.000Z");
  assert.deepEqual([terminal.status, terminal.terminal_outcome, terminal.forecast_id, terminal.delivery_record_id], ["TERMINAL", "NO_TRADE", "forecast-1", `${slot}:TS`]);
  assert.equal(store.claimTsCoreSlot(slot, slot, "runtime:third", "2026-08-25T13:40:00.000Z").claim, "TERMINAL");
  assert.throws(() => store.completeTsCoreSlot(slot, "runtime:third", "DELIVERED", "forecast-2", `${slot}:TS-2`, "2026-08-25T13:40:01.000Z"), /terminal identity conflict/);
  store.close();
});

test("informational incidents stay recorded without degrading current health", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-info-health-"));
  const store = openSnapshotDatabase(join(directory, "health.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const state = store.reconcileIncidents([{ fingerprint: "desktop-info", layer: "DESKTOP", code: "CODEX_DESKTOP_EXIT", severity: "INFO", title: "Codex 桌面退出", run_id: null, suggestion: "仅记录", details: {} }], "test", "2026-08-13T05:00:00.000Z");
  assert.equal(state.status, "HEALTHY");
  assert.equal(state.active.length, 1);
  assert.equal(state.active[0].severity, "INFO");
});

test("SQLite keeps raw snapshots, rejects duplicates and survives restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-web-"));
  const file = join(directory, "snapshots.sqlite");
  const raw = await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8");
  context.after(() => rm(directory, { recursive: true, force: true }));

  const first = openSnapshotDatabase(file);
  const imported = first.importRaw(raw, "2026-08-11T00:00:00.000Z");
  assert.equal(imported.payload.snapshot_id, JSON.parse(raw).snapshot_id);
  assert.equal(imported.archiveCount, 1);
  assert.equal(first.getRaw(imported.payload.snapshot_id), raw);
  assert.throws(() => first.importRaw(raw), /已导入.*现有数据未改变/);
  assert.throws(() => first.importRaw("{"), /有效 JSON.*现有数据未改变/);
  assert.equal(first.getActive().payload.snapshot_id, imported.payload.snapshot_id);
  assert.equal(first.getActive().archiveCount, 1);

  const sample = JSON.parse(raw);
  const ts = sample.contracts.TS_OUTPUT[0];
  const tsEnvelope = JSON.stringify({
    gateway_format: "TRADING_OS_LOCAL_OUTPUT",
    gateway_version: 1,
    record_id: "test-ts-normal",
    output_type: "TS_OUTPUT",
    channel: "PRODUCTION",
    observed_at: ts.evidence_snapshot.market_time.observed_at,
    payload: ts,
  });
  assert.equal(first.importOutputRaw(tsEnvelope, "2026-08-11T00:01:00.000Z").duplicate, false);
  assert.equal(first.importOutputRaw(tsEnvelope, "2026-08-11T00:02:00.000Z").duplicate, true);
  assert.equal(first.getActive().outputCount, 1);
  assert.equal(first.getOutputRaw("test-ts-normal"), tsEnvelope);
  assert.throws(() => first.importOutputRaw(JSON.stringify({ ...JSON.parse(tsEnvelope), channel: "SHADOW" })), /必须写入 PRODUCTION/);
  assert.throws(() => first.importOutputRaw(JSON.stringify({ ...JSON.parse(tsEnvelope), payload: { role: "TS" } })), /缺少必填字段/);
  assert.equal(first.getActive().outputCount, 1);

  const committee = (record_id, observed_at, summary) => JSON.stringify({
    gateway_format: "TRADING_OS_LOCAL_OUTPUT",
    gateway_version: 1,
    record_id,
    output_type: "COMMITTEE_OUTPUT",
    channel: "PRODUCTION",
    observed_at,
    payload: { contract_version: "v1", role: "COMMITTEE", flow_state: "unknown", direction: "unknown", confidence: 0, summary, evidence_for: [], evidence_against: [], reversal_signals: [], data_gaps: [] },
  });
  first.importOutputRaw(committee("committee-newer", "2026-08-11T12:00:00.000Z", "newer"));
  first.importOutputRaw(committee("committee-older", "2026-08-11T11:00:00.000Z", "older"));
  assert.equal(first.getActive().outputs.COMMITTEE_OUTPUT.summary, "newer");
  const forecastView = first.getActive("forecast");
  assert.equal(forecastView.outputs.TS_OUTPUT[0].evidence_snapshot.run_id, ts.evidence_snapshot.run_id);
  assert.equal(forecastView.outputs.COMMITTEE_OUTPUT, null);
  assert.deepEqual([forecastView.payload, forecastView.runLedger.runs, forecastView.marketRadar.snapshot], [null, [], null]);
  const approved = {
    contract_version: "v2", component: "APPROVED_CAPABILITY_SNAPSHOT", mode: "SHADOW", actionable: false, generated_at: "2026-08-11T20:01:00.000Z", source: "ROBINHOOD_OFFICIAL_TRADING_MCP",
    fixed_pool: { status: "DATA_BLOCKED", data_grade: "OFFICIAL_READONLY_MULTI_TIMEFRAME_SWING", universe_size: 70, observed_count: 69, missing_symbols: ["XSP"], rows: [{ symbol: "AAPL", status: "MARKET_CLOSED", as_of: "2026-08-11T19:59:59.000Z" }], breadth: { bullish: 1, bearish: 0, range: 0, advance_pct: 100 }, candidates: [], qualification: "MULTI_TIMEFRAME_SWING_RESEARCH", missing_gates: [] },
    owner_watchlist: { status: "NOT_OBSERVED", items: [], reason: "owner input absent" }, real_positions: { status: "NOT_OBSERVED", count: 0, symbols: [], source: "ROBINHOOD_OFFICIAL_TRADING_MCP" }, earnings_center: { status: "NOT_OBSERVED", items: [], limitation: "none" }, event_scan: { status: "NOT_OBSERVED", items: [] }, extended_discovery: { status: "NOT_OBSERVED", ttl_days: 7, max_symbols: 12, symbols: [], reason: "none" }, provenance: [],
  };
  first.recordApprovedCapabilities({ snapshot_id: "market-" + "c".repeat(24), snapshot_hash: "c".repeat(64), approved_capabilities: approved }, "bootstrap:test", "2026-08-11T20:02:00.000Z");
  assert.deepEqual([first.getActive().marketRadar.snapshot.fixed_pool.observed_count, first.getActive().marketRadar.source_record_id], [69, "bootstrap:test"]);
  first.close();

  const restarted = openSnapshotDatabase(file);
  assert.equal(restarted.getActive().payload.snapshot_id, imported.payload.snapshot_id);
  assert.equal(restarted.getRaw(imported.payload.snapshot_id), raw);
  assert.equal(restarted.getActive().outputCount, 3);
  assert.equal(restarted.getActive().outputs.TS_OUTPUT[0].evidence_snapshot.run_id, ts.evidence_snapshot.run_id);
  assert.equal(restarted.getActive().outputs.COMMITTEE_OUTPUT.summary, "newer");
  assert.deepEqual([restarted.getActive().marketRadar.snapshot.fixed_pool.rows[0].status, restarted.getActive().marketRadar.market_snapshot_hash], ["MARKET_CLOSED", "c".repeat(64)]);
  restarted.close();
});

test("formal LIVE TS forecasts are immutable, REPLAY is excluded, and Robinhood bars settle across restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-settlement-"));
  const file = join(directory, "settlement.sqlite");
  const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const live = settlementForecast(sample);
  live.forecast_window.end_at = "2026-08-11T14:25:26.919Z";
  live.next_validation.at = live.forecast_window.end_at;
  const replay = settlementForecast(sample, "20260811T133000Z-bbbbbbbbbb");
  const enhancedObservation = settlementForecast(sample, "20260811T131500Z-cccccccccc");
  const envelope = (output, prefix) => JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `${prefix}:20260811T133000Z:TS`, output_type: "TS_SHADOW_OUTPUT", channel: "SHADOW", observed_at: output.evidence_snapshot.market_time.observed_at, payload: output });
  const first = openSnapshotDatabase(file);
  assert.equal(first.importOutputRaw(envelope(live, "live-shadow"), "2026-08-11T13:31:00.000Z").duplicate, false);
  assert.equal(first.importOutputRaw(envelope(live, "live-shadow"), "2026-08-11T13:32:00.000Z").duplicate, true);
  assert.equal(first.importOutputRaw(envelope(replay, "replay-shadow"), "2026-08-11T13:31:00.000Z").duplicate, false);
  assert.equal(first.importOutputRaw(JSON.stringify({ ...JSON.parse(envelope(enhancedObservation, "live-shadow")), record_id: "live-shadow:20260811T131500Z:TS" }), "2026-08-11T13:31:00.000Z").duplicate, false);
  const changed = structuredClone(live); changed.one_line_forecast = "不得覆盖较早预测";
  assert.throws(() => first.importOutputRaw(JSON.stringify({ ...JSON.parse(envelope(changed, "live-shadow")), record_id: "live-shadow:20260811T133000Z:TS-conflict" })), /较早预测未被覆盖/);
  assert.deepEqual([first.getActive().tsSettlement.official_live_count, first.getActive().tsSettlement.excluded_replay_count, first.getActive().tsSettlement.excluded_non_live_count, first.getActive().tsSettlement.pending_count], [1, 1, 1, 1]);
  assert.equal(first.getActive().tsSettlement.recent.find((item) => item.forecast_run_id === enhancedObservation.evidence_snapshot.run_id).slot, "06:15");
  first.close();

  const legacy = new DatabaseSync(file);
  legacy.prepare("UPDATE ts_forecast_archive SET eligibility = 'OFFICIAL_LIVE', exclusion_reason = NULL, official_slot = '06:20' WHERE forecast_run_id = ?").run(enhancedObservation.evidence_snapshot.run_id);
  legacy.close();

  const evidence = openSnapshotDatabase(file);
  assert.deepEqual([evidence.getActive().tsSettlement.official_live_count, evidence.getActive().tsSettlement.excluded_non_live_count], [1, 1]);
  assert.equal(evidence.recordTsMarketCharts([["SPY", 100], ["QQQ", 200]].map(([symbol, start]) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: 12 }, (_, index) => { const price = start + index * 0.05; return { begins_at: new Date(Date.parse("2026-08-11T13:30:00.000Z") + index * 300_000).toISOString(), open: price, high: price + 0.04, low: price - 0.04, close: price + 0.02, volume: 1000 }; }) })), "2026-08-11T14:31:00.000Z").newlySettled, 1);
  evidence.close();

  const restarted = openSnapshotDatabase(file);
  assert.deepEqual(restarted.settleTsForecasts("2026-08-11T14:31:00.000Z"), { status: "COMPLETED", newlySettled: 0, duePending: 0, errors: [], optionNewlySettled: 0, optionDuePending: 0, optionErrors: [] });
  const state = restarted.getActive("settlements").tsSettlement;
  assert.deepEqual([state.settled_count, state.resolved_count, state.pending_count], [1, 1, 0]);
  assert.deepEqual([state.trusted.status, state.trusted.settled_count, state.legacy.label, state.legacy.settled_count, state.legacy.strict_projection_count], ["INSUFFICIENT_EVIDENCE", 0, "LEGACY_NON_CAUSAL_WINDOW", 1, 1]);
  assert.equal(state.trusted.message, "UNVALIDATED：当前版本样本不足，尚未证明预测优势");
  assert.deepEqual([state.direction_accuracy.SPY.accuracy, state.direction_accuracy.QQQ.accuracy, state.path_accuracy.accuracy], [1, 1, 1]);
  assert.equal(state.mean_brier_score > 0, true);
  const swing = state.recent.find((item) => item.eligibility === "OFFICIAL_LIVE").settlement.swing_observation;
  const formalSettlement = state.recent.find((item) => item.eligibility === "OFFICIAL_LIVE").settlement;
  assert.ok(["PERSISTED", "TRANSITIONED"].includes(formalSettlement.pattern_result.status));
  assert.equal(formalSettlement.amplitude_result.status, "OBSERVED");
  assert.equal(formalSettlement.observation_window.start_at, live.evidence_snapshot.market_time.observed_at);
  assert.equal(typeof formalSettlement.scenario_resolution.reason, "string");
  assert.equal(Object.values(formalSettlement.scenario_results).every((item) => "activated_at" in item && "invalidated_at" in item), true);
  assert.equal(state.tradeability_outcomes.reduce((sum, item) => sum + item.count, 0), 1);
  assert.deepEqual([swing.basis, swing.execution_scope, swing.symbols.SPY.entry_price, swing.symbols.SPY.max_price, swing.symbols.SPY.min_price, swing.symbols.SPY.close_price, swing.symbols.SPY.first_extreme], ["ROBINHOOD_REGULAR_SESSION", "READ_ONLY_NO_ORDER_ACTION", 100, 100.59, 99.96, 100.57, "LOW_FIRST"]);
  assert.deepEqual([swing.symbols.SPY.upside_excursion_pct, swing.symbols.SPY.downside_excursion_pct, swing.symbols.SPY.favorable_excursion_pct, swing.symbols.SPY.adverse_excursion_pct], [.59, -.04, .59, -.04]);
  assert.equal(state.recent.find((item) => item.eligibility === "EXCLUDED_REPLAY").settlement, null);
  restarted.close();

  const again = openSnapshotDatabase(file);
  assert.deepEqual([again.getActive().tsSettlement.settled_count, again.getActive().tsSettlement.archived_count], [1, 3]);
  assert.equal(again.settleTsForecasts("2026-08-11T14:32:00.000Z").newlySettled, 0);
  again.close();
});

test("daily TS Core authority reads the complete day instead of a recent-N projection", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-daily-authority-"));
  const file = join(directory, "daily.sqlite");
  const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  openSnapshotDatabase(file).close();
  const database = new DatabaseSync(file), forecast = settlementForecast(sample);
  const output = database.prepare("INSERT INTO output_records (record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const archive = database.prepare("INSERT INTO ts_forecast_archive (forecast_run_id, source_record_id, source_mode, eligibility, exclusion_reason, published_at, market_date, official_slot, phase, report_type, forecast_hash, forecast_identity_hash, forecast_identity_json, payload_json) VALUES (?, ?, 'LIVE', ?, ?, ?, '2026-08-11', ?, 'INTRADAY_REVISION', 'INTRADAY_UPDATE', ?, NULL, NULL, ?)");
  const occurrences = timelineOccurrencesForPtDate("2026-08-11").filter((item) => item.kind === "TS_FORECAST"), slots = occurrences.map((item) => item.business_slot);
  for (let index = 0; index < 28; index += 1) {
    const official = index % 2 === 0, occurrence = occurrences[Math.floor(index / 2)], slot = occurrence.business_slot, base = Date.parse(occurrence.scheduled_at) + (official ? 0 : 5 * 60_000), compact = new Date(base).toISOString().replace(/[-:]/g, "").replace(".000Z", "Z"), runId = `${compact}-${String(index).padStart(10, "0")}`, recordId = `live-shadow:${compact}:TS-${index}`;
    const payload = structuredClone(forecast); payload.evidence_snapshot.run_id = runId; payload.evidence_snapshot.market_time.observed_at = new Date(base).toISOString();
    output.run(recordId, "TS_SHADOW_OUTPUT", "SHADOW", payload.evidence_snapshot.market_time.observed_at, payload.evidence_snapshot.market_time.observed_at, JSON.stringify(payload), "{}", "a".repeat(64));
    archive.run(runId, recordId, official ? "OFFICIAL_LIVE" : "EXCLUDED_NON_LIVE", official ? null : "NON_OFFICIAL_SLOT", `2026-08-11T${String(13 + Math.floor(index / 12)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`, slot, "b".repeat(64), JSON.stringify(payload));
  }
  for (const [index, slot] of slots.entries()) {
    const checkpoint = { contract_version: "v1", role: "TIMELINE_SCHEDULER", slot_id: `timeline:ts_forecast:20260811:${slot.replace(":", "")}`, kind: "TS_FORECAST", label: "TS 正式槽 Shadow", business_slot: slot, scheduled_at: `2026-08-11T${String(13 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "45" : "30"}:00.000Z`, scheduled_pt: `2026-08-11 ${slot}:00 PT`, trading_day: true, source_files: [], status: "SUCCEEDED", started_at: "2026-08-11T13:30:00.000Z", completed_at: "2026-08-11T13:30:01.000Z", late_seconds: 0, result_ref: null, reason: null };
    output.run(`checkpoint:${checkpoint.slot_id}`, "SCHEDULE_CHECKPOINT", "SYSTEM", checkpoint.completed_at, checkpoint.completed_at, JSON.stringify(checkpoint), "{}", "c".repeat(64));
  }
  database.close();
  const store = openSnapshotDatabase(file), daily = store.getTsCoreDailySummary("2026-08-11", new Date("2026-08-11T13:40:00.000Z"));
  assert.deepEqual([daily.official_slots_expected, daily.official_slots_succeeded, daily.new_forecasts, daily.forecast_ids.length], [14, 14, 14, 14]);
  assert.ok(daily.forecast_ids.some((id) => id.endsWith("0000000000")) && daily.forecast_ids.some((id) => id.endsWith("0000000026")));
  store.close();
});

test("next-session forecasts require a complete regular session and ignore premarket bars", async () => {
  const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
  const output = settlementForecast(sample, "20260812T010000Z-cccccccccc");
  output.report_type = "NEXT_SESSION";
  output.evidence_snapshot.market_time = { timezone: "America/Los_Angeles", observed_at: "2026-08-12T01:00:00.000Z", market_date: "2026-08-11", state: "CLOSED" };
  output.forecast_window = { horizon: "NEXT_REGULAR_SESSION", start_at: "2026-08-12T13:30:00.000Z", end_at: "2026-08-12T20:00:00.000Z", end_condition: "NEXT_REGULAR_SESSION_CLOSE" };
  const bars = (symbol, base, start) => Array.from({ length: 78 }, (_, index) => ({ symbol, begins_at: new Date(Date.parse(start) + index * 300_000).toISOString(), session_date: "2026-08-12", open: base + index * 0.01, high: base + index * 0.01 + 0.02, low: base + index * 0.01 - 0.02, close: base + index * 0.01 + 0.01, volume: 1000, snapshot_hash: "d".repeat(64) }));
  const premarket = { SPY: bars("SPY", 100, "2026-08-12T07:00:00.000Z"), QQQ: bars("QQQ", 200, "2026-08-12T07:00:00.000Z") };
  assert.equal(settleTsForecast(output, premarket, "2026-08-12T20:01:00.000Z"), null);
  const regular = { SPY: bars("SPY", 100, "2026-08-12T13:30:00.000Z"), QQQ: bars("QQQ", 200, "2026-08-12T13:30:00.000Z") };
  assert.equal(settleTsForecast(output, regular, "2026-08-12T20:01:00.000Z")?.observation_window.target_market_dates[0], "2026-08-12");
});

test("weekend forecasts stay pending until five future regular sessions are complete", async () => {
  const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
  const output = settlementForecast(sample, "20260815T010000Z-dddddddddd");
  output.report_type = "WEEKEND_OUTLOOK";
  output.evidence_snapshot.market_time = { timezone: "America/Los_Angeles", observed_at: "2026-08-15T01:00:00.000Z", market_date: "2026-08-14", state: "CLOSED" };
  output.forecast_window = { horizon: "NEXT_FIVE_REGULAR_SESSIONS", start_at: "2026-08-17T13:30:00.000Z", end_at: null, end_condition: "FIFTH_REGULAR_SESSION_CLOSE" };
  const dates = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"], history = { SPY: [], QQQ: [] };
  for (const [symbol, base] of [["SPY", 100], ["QQQ", 200]]) for (const date of dates) history[symbol].push(...Array.from({ length: 78 }, (_, index) => ({ symbol, begins_at: new Date(Date.parse(`${date}T13:30:00.000Z`) + index * 300_000).toISOString(), session_date: date, open: base, high: base + 1, low: base - 1, close: base + .5, volume: 1000, snapshot_hash: "e".repeat(64) })));
  const fourSessions = { SPY: history.SPY.filter((bar) => bar.session_date !== dates.at(-1)), QQQ: history.QQQ.filter((bar) => bar.session_date !== dates.at(-1)) };
  assert.equal(settleTsForecast(output, fourSessions, "2026-08-21T20:01:00.000Z"), null);
  assert.equal(settleTsForecast(output, history, "2026-08-21T20:01:00.000Z")?.observation_window.target_market_dates.length, 5);
});

test("P1 baselines use only bars closed before publication and keep all-WAIT at zero coverage", async () => {
  const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
  const output = settlementForecast(sample, "20260811T140000Z-p1p1p1p1p1");
  output.evidence_snapshot.market_time.market_date = "2026-08-11";
  output.symbol_outlooks.SPY.direction = output.symbol_outlooks.QQQ.direction = "BULLISH";
  const settlement = { observation_window: { end_at: "2026-08-11T15:00:00.000Z" }, actual_scenario: "MAIN", symbols: { SPY: { actual_direction: "BULLISH" }, QQQ: { actual_direction: "BULLISH" } } };
  const bars = (symbol, base) => [0, 1, 2, 6].map((index) => ({ symbol, begins_at: new Date(Date.parse("2026-08-11T13:30:00.000Z") + index * 300_000).toISOString(), session_date: "2026-08-11", open: base + index, high: base + index + 1, low: base + index - 1, close: base + index + .5, volume: 100, snapshot_hash: "a".repeat(64) }));
  const result = evaluateTsProduct([{ output, settlement, received_at: "2026-08-11T14:00:00.000Z" }], { SPY: bars("SPY", 100), QQQ: bars("QQQ", 200) });
  assert.deepEqual(result.baselines.filter((item) => ["LAST_BAR", "THREE_BAR_TREND"].includes(item.baseline)).map((item) => [item.baseline, item.sample_count, item.accuracy]), [["LAST_BAR", 2, 1], ["THREE_BAR_TREND", 2, 1]]);
  assert.deepEqual(result.baselines.find((item) => item.baseline === "ALL_WAIT"), { baseline: "ALL_WAIT", label: "全部WAIT", sample_count: 0, correct_count: 0, accuracy: null, coverage: 0, mcc: null, mean_brier: null });
  assert.deepEqual(result.risk_coverage.at(-1), { qualification: "ALL_FORECASTS", forecast_count: 1, coverage: 1, direction_sample_count: 2, accuracy: 1, risk: 0, mcc: null });
});

test("A1.4 freezes runtime identity and settles only fully causal five-minute bars", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-a1-4-")), file = join(directory, "causal.sqlite");
  const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const forecast = settlementForecast(sample, "20260811T133000Z-a14a14a14a");
  forecast.forecast_window.end_at = "2026-08-11T14:00:30.000Z";
  forecast.next_validation.at = forecast.forecast_window.end_at;
  const envelope = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "live-shadow:20260811T133000Z:TS-a14", output_type: "TS_SHADOW_OUTPUT", channel: "SHADOW", observed_at: forecast.evidence_snapshot.market_time.observed_at, payload: forecast });
  const store = openSnapshotDatabase(file, { runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) } });
  store.importOutputRaw(envelope, "2026-08-11T13:32:00.000Z");
  const replay = structuredClone(forecast); replay.evidence_snapshot.run_id = "20260811T133000Z-b14b14b14b";
  const enhanced = structuredClone(forecast); enhanced.evidence_snapshot.run_id = "20260811T131500Z-c14c14c14c";
  store.importOutputRaw(JSON.stringify({ ...JSON.parse(envelope), record_id: "replay-shadow:20260811T133000Z:TS-a14", payload: replay }), "2026-08-11T13:32:01.000Z");
  store.importOutputRaw(JSON.stringify({ ...JSON.parse(envelope), record_id: "live-shadow:20260811T131500Z:TS-a14", payload: enhanced }), "2026-08-11T13:32:02.000Z");
  assert.deepEqual([store.getActive().tsSettlement.trusted.forecast_count, store.getActive().tsSettlement.trusted.settled_count, store.getActive().tsSettlement.excluded_replay_count, store.getActive().tsSettlement.excluded_non_live_count], [1, 0, 1, 1]);
  const charts = [["SPY", 100], ["QQQ", 200]].map(([symbol, start]) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: 7 }, (_, index) => { const price = start + index * .1; return { begins_at: new Date(Date.parse("2026-08-11T13:30:00.000Z") + index * 300_000).toISOString(), open: price, high: price + .05, low: price - .05, close: price + .02, volume: 1000 }; }) }));
  assert.equal(store.recordTsMarketCharts(charts, "2026-08-11T14:06:00.000Z").newlySettled, 1);
  const state = store.getActive().tsSettlement, result = state.recent.find((item) => item.forecast_run_id === forecast.evidence_snapshot.run_id);
  assert.deepEqual([state.trusted.settled_count, state.legacy.settled_count, result.scoring_contract, result.settlement.contract_version], [1, 0, "TS_FORECAST_SETTLEMENT@2.0.0", "v2"]);
  assert.deepEqual([state.trusted.product_contract, state.trusted.validation.status, state.trusted.validation.independent_trading_days, state.trusted.scenario_weights.status, state.trusted.scenario_weights.forward_calibrated], ["TS_FORECAST_PRODUCT@1.0.0", "UNVALIDATED", 1, "UNCALIBRATED_SCENARIO_WEIGHTS", false]);
  assert.deepEqual([state.trusted.baselines.length, state.trusted.risk_coverage.length, result.scenario_weight_status, result.baselines.SPY.length], [7, 3, "UNCALIBRATED_SCENARIO_WEIGHTS", 7]);
  assert.deepEqual([result.settlement.observation_window.observed_at, result.settlement.observation_window.received_at, result.settlement.observation_window.gateway_delay_ms, result.settlement.observation_window.first_scorable_bar_at, result.settlement.observation_window.end_at, result.settlement.observation_window.bar_count], ["2026-08-11T13:30:00.000Z", "2026-08-11T13:32:00.000Z", 120000, "2026-08-11T13:35:00.000Z", "2026-08-11T14:00:00.000Z", 5]);
  assert.deepEqual([result.forecast_identity.generator_commit, result.forecast_identity.runtime_release_sha256, result.forecast_identity.model_release_commit], ["a".repeat(40), "b".repeat(64), forecast.evidence_snapshot.release_commit]);
  store.close();
  const audit = new DatabaseSync(file, { readOnly: true }), row = audit.prepare("SELECT forecast_identity_hash, forecast_identity_json, published_at FROM ts_forecast_archive WHERE source_record_id = 'live-shadow:20260811T133000Z:TS-a14'").get();
  assert.deepEqual([row.forecast_identity_hash.length, JSON.parse(row.forecast_identity_json).received_at, row.published_at, audit.prepare("SELECT COUNT(*) count FROM ts_forecast_settlements").get().count], [64, "2026-08-11T13:32:00.000Z", "2026-08-11T13:32:00.000Z", 1]);
  audit.close();
  const restarted = openSnapshotDatabase(file, { runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) } });
  assert.deepEqual([restarted.getActive().tsSettlement.trusted.settled_count, restarted.settleTsForecasts("2026-08-11T14:07:00.000Z").newlySettled], [1, 0]);
  restarted.close();
});

test("Manager and review count settled observation days, not Sunday publication dates or repeated slots", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-observation-days-")), file = join(directory, "isolated.sqlite");
  const store = openSnapshotDatabase(file, { runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) } });
  let database;
  context.after(async () => { database?.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
  for (const [stamp, marketDate, reportType] of [["010000", "2026-08-23", "NEXT_SESSION"], ["133000", "2026-08-24", "OPENING_FORECAST"]]) {
    const forecast = settlementForecast(sample, `20260824T${stamp}Z-aaaaaaaaaa`);
    const observed = `2026-08-24T${stamp.slice(0, 2)}:${stamp.slice(2, 4)}:00.000Z`;
    forecast.report_type = reportType;
    forecast.evidence_snapshot.market_time = { timezone: "America/Los_Angeles", observed_at: observed, market_date: marketDate, state: reportType === "NEXT_SESSION" ? "CLOSED" : "OPEN" };
    forecast.forecast_window = reportType === "NEXT_SESSION"
      ? { horizon: "NEXT_REGULAR_SESSION", start_at: "2026-08-24T13:30:00.000Z", end_at: "2026-08-24T20:00:00.000Z", end_condition: "NEXT_REGULAR_SESSION_CLOSE" }
      : { horizon: "OPEN_TO_60_MINUTES", start_at: observed, end_at: "2026-08-24T14:30:00.000Z", end_condition: "AT_TIMESTAMP" };
    forecast.next_validation.at = forecast.forecast_window.end_at;
    store.importOutputRaw(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `live-shadow:20260824T${stamp}Z:TS`, output_type: "TS_SHADOW_OUTPUT", channel: "SHADOW", observed_at: observed, payload: forecast }), new Date(Date.parse(observed) + 60_000).toISOString());
  }
  assert.equal(store.getCodexManagerState().ts_readiness.independent_trading_days, 0, "unsettled forecasts are not observed days");
  const charts = [["SPY", 100], ["QQQ", 200]].map(([symbol, price]) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: 78 }, (_, index) => ({ begins_at: new Date(Date.parse("2026-08-24T13:30:00.000Z") + index * 300_000).toISOString(), open: price, high: price + .1, low: price - .1, close: price, volume: 1000 })) }));
  assert.equal(store.recordTsMarketCharts(charts, "2026-08-24T20:06:00.000Z").newlySettled, 2);
  database = new DatabaseSync(file, { readOnly: true });
  const history = () => JSON.stringify([database.prepare("SELECT * FROM ts_forecast_archive ORDER BY forecast_run_id").all(), database.prepare("SELECT * FROM ts_forecast_settlements ORDER BY forecast_run_id").all()]);
  const before = history(), state = store.getActive("settlements");
  assert.deepEqual([state.codexManager.ts_readiness.independent_trading_days, state.tsSettlement.trusted.validation.independent_trading_days], [1, 1]);
  assert.deepEqual([state.codexManager.ts_readiness.gap_to_30, state.tsSettlement.trusted.validation.gap_to_30], [29, 29]);
  assert.equal(state.tsSettlement.trusted.validation.status, "UNVALIDATED");
  assert.equal(history(), before, "readiness projection must not rewrite forecasts or settlements");
});

test("Owner Trigger Layer appends touch, activation and false-break invalidation without changing the forecast", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-owner-trigger-"));
  const file = join(directory, "trigger.sqlite");
  const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const forecast = settlementForecast(sample, "20260811T133000Z-dddddddddd");
  forecast.tradeability = { status: "WAIT", reason: "等待主路径确认后再复核" };
  const raw = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "live-shadow:20260811T133000Z:TS-trigger", output_type: "TS_SHADOW_OUTPUT", channel: "SHADOW", observed_at: forecast.evidence_snapshot.market_time.observed_at, payload: forecast });
  const store = openSnapshotDatabase(file);
  store.importOutputRaw(raw, "2026-08-11T13:30:01.000Z");
  const bar = (begins_at, close, high = close + .02, low = close - .02) => ({ begins_at, open: close, high, low, close, volume: 1000, session: "REGULAR", trading_date: "2026-08-11" });
  const charts = (spyBars, observedAt) => [
    { source: "ROBINHOOD", symbol: "SPY", interval: "5m", range: "1d", status: "LIVE", as_of: observedAt, current_price: spyBars.at(-1).close, session_dates: ["2026-08-11"], bars: spyBars },
    { source: "ROBINHOOD", symbol: "QQQ", interval: "5m", range: "1d", status: "LIVE", as_of: observedAt, current_price: 200, session_dates: ["2026-08-11"], bars: [bar("2026-08-11T13:30:00.000Z", 200)] },
  ];
  const touch = [bar("2026-08-11T13:30:00.000Z", 99.95, 100.05, 99.9)];
  assert.equal(store.recordTsMarketCharts(charts(touch, "2026-08-11T13:36:00.000Z"), "2026-08-11T13:36:00.000Z").triggerEvents, 2);
  assert.equal(store.getActive().ownerTrigger.current.SPY.new_state, "TRIGGER_CONFIRMING");
  const confirmed = [...touch, bar("2026-08-11T13:35:00.000Z", 100.02)];
  assert.equal(store.recordTsMarketCharts(charts(confirmed, "2026-08-11T13:41:00.000Z"), "2026-08-11T13:41:00.000Z").triggerEvents, 2);
  const active = store.getActive().ownerTrigger.current.SPY;
  assert.deepEqual([active.old_state, active.new_state, active.original_probability_pct, active.is_tradeable, active.owner_action, active.replay], ["TRIGGER_CONFIRMING", "PATH_ACTIVATED", 60, false, "DO_NOT_CHASE", false]);
  assert.equal(active.risk_blockers.includes("等待主路径确认后再复核"), true);
  const reclaimed = [...confirmed, bar("2026-08-11T13:40:00.000Z", 99.9)];
  assert.equal(store.recordTsMarketCharts(charts(reclaimed, "2026-08-11T13:46:00.000Z"), "2026-08-11T13:46:00.000Z").triggerEvents, 2);
  assert.deepEqual([store.getActive().ownerTrigger.current.SPY.new_state, store.getActive().ownerTrigger.current.SPY.invalidation_reason], ["PATH_INVALIDATED", "激活条件被快速收复，按假突破处理"]);
  assert.equal(store.recordTsMarketCharts(charts(reclaimed, "2026-08-11T13:47:00.000Z"), "2026-08-11T13:47:00.000Z").triggerEvents, 0);
  const audit = new DatabaseSync(file, { readOnly: true });
  const before = audit.prepare("SELECT COUNT(*) AS value FROM ts_owner_trigger_events").get().value;
  audit.close();
  assert.equal(before, 6);
  store.close();
  const restarted = openSnapshotDatabase(file);
  assert.deepEqual([restarted.getActive().ownerTrigger.current.SPY.new_state, restarted.getActive().ownerTrigger.recent.length], ["PATH_INVALIDATED", 6]);
  assert.equal(restarted.getActive().outputs.TS_SHADOW_OUTPUT[0].scenarios.main.probability_pct, 60);
  restarted.close();
});

test("Agent Run Ledger rejects bad history and keeps independent delivery truth across restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-ledger-"));
  const file = join(directory, "ledger.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));

  const first = openSnapshotDatabase(file);
  const started = runEvent();
  const originalRaw = JSON.stringify(started, null, 2);
  assert.equal(first.importRunEventRaw(originalRaw).duplicate, false);
  assert.equal(first.importRunEventRaw(JSON.stringify(started)).duplicate, true);
  assert.equal(first.getRunEventRaw(started.event_id), originalRaw);
  assert.equal(first.getActive().runLedger.eventCount, 1);
  const registry = first.getActive().runLedger;
  assert.deepEqual(registry.agents.filter((agent) => agent.kind === "PRIMARY_AGENT").map((agent) => agent.agent_id), ["A1", "A2", "TS", "COMMITTEE", "D", "A3"]);
  assert.equal(registry.skills.find((skill) => skill.skill_id === "A1_EARNINGS_CALENDAR").kind, "EVENT_SOURCE");
  assert.equal(registry.skills.find((skill) => skill.skill_id === "A1_MAJOR_NEWS").kind, "EVENT_SOURCE");
  assert.equal(registry.routes.every((route) => route.source_files.length > 0), true);
  assert.equal(registry.runs.some((run) => run.agent_id === "A2"), false);

  assert.throws(
    () => first.importRunEventRaw(JSON.stringify({ ...started, version: "different-version" })),
    (error) => error.code === "EVENT_ID_CONFLICT",
  );
  assert.throws(
    () => first.importRunEventRaw(JSON.stringify(runEvent({ event_id: "ts-run-old", status: "RUNNING", event_at: "2026-08-11T12:59:59.000Z" }))),
    (error) => error.code === "OUT_OF_ORDER",
  );
  assert.throws(
    () => first.importRunEventRaw(JSON.stringify(runEvent({ event_id: "ts-run-no-result", run_id: "cycle-no-result", status: "SUCCEEDED" }))),
    (error) => error.code === "RESULT_REQUIRED",
  );
  assert.throws(
    () => first.importRunEventRaw(JSON.stringify(runEvent({
      event_id: "ts-run-direct-success",
      status: "SUCCEEDED",
      output_status: "PRODUCED",
      evidence_refs: ["sqlite://outputs/ts-output-1"],
      website_delivery: "DELIVERED",
      discord_delivery: "DELIVERED",
      event_at: "2026-08-11T13:01:00.000Z",
    }))),
    (error) => error.code === "ILLEGAL_TRANSITION",
  );

  first.importRunEventRaw(JSON.stringify(runEvent({ event_id: "ts-run-running", status: "RUNNING", event_at: "2026-08-11T13:01:00.000Z" })));
  first.importRunEventRaw(JSON.stringify(runEvent({
    event_id: "ts-run-site-failed",
    status: "SUCCEEDED",
    output_status: "PRODUCED",
    evidence_refs: ["sqlite://outputs/ts-output-1"],
    website_delivery: "FAILED",
    discord_delivery: "PENDING",
    error: "website output write failed",
    event_at: "2026-08-11T13:02:00.000Z",
  })));
  let current = first.getActive().runLedger.runs.find((run) => run.run_id === started.run_id);
  assert.deepEqual([current.status, current.output_status, current.website_delivery, current.discord_delivery], ["SUCCEEDED", "PRODUCED", "FAILED", "PENDING"]);

  first.importRunEventRaw(JSON.stringify(runEvent({
    event_id: "ts-run-discord-failed",
    status: "SUCCEEDED",
    output_status: "PRODUCED",
    evidence_refs: ["sqlite://outputs/ts-output-1"],
    website_delivery: "DELIVERED",
    discord_delivery: "FAILED",
    error: "Discord delivery failed",
    event_at: "2026-08-11T13:03:00.000Z",
  })));
  current = first.getActive().runLedger.runs.find((run) => run.run_id === started.run_id);
  assert.deepEqual([current.status, current.website_delivery, current.discord_delivery], ["SUCCEEDED", "DELIVERED", "FAILED"]);

  first.importRunEventRaw(JSON.stringify(runEvent({
    event_id: "ts-run-delivered",
    status: "SUCCEEDED",
    output_status: "PRODUCED",
    evidence_refs: ["sqlite://outputs/ts-output-1"],
    website_delivery: "DELIVERED",
    discord_delivery: "DELIVERED",
    event_at: "2026-08-11T13:04:00.000Z",
  })));

  const timeout = runEvent({ event_id: "timeout-start", run_id: "cycle-timeout", slot_id: "13:30", event_at: "2026-08-11T13:30:00.000Z" });
  first.importRunEventRaw(JSON.stringify(timeout));
  first.importRunEventRaw(JSON.stringify({ ...timeout, event_id: "timeout-running", status: "RUNNING", event_at: "2026-08-11T13:31:00.000Z" }));
  first.importRunEventRaw(JSON.stringify({ ...timeout, event_id: "timeout-final", status: "TIMED_OUT", error: "Agent exceeded 120 seconds", event_at: "2026-08-11T13:32:00.000Z" }));

  const interrupted = runEvent({ event_id: "interrupt-start", run_id: "cycle-interrupted", slot_id: "14:00", event_at: "2026-08-11T14:00:00.000Z" });
  first.importRunEventRaw(JSON.stringify(interrupted));
  first.importRunEventRaw(JSON.stringify({ ...interrupted, event_id: "interrupt-running", status: "RUNNING", event_at: "2026-08-11T14:01:00.000Z" }));
  first.close();

  const restarted = openSnapshotDatabase(file);
  assert.equal(restarted.getActive().runLedger.runs.find((run) => run.run_id === "cycle-interrupted").status, "RUNNING");
  restarted.importRunEventRaw(JSON.stringify({ ...interrupted, event_id: "interrupt-timeout", status: "TIMED_OUT", error: "process interrupted before result", event_at: "2026-08-11T14:02:00.000Z" }));
  assert.equal(restarted.getActive().runLedger.runs.find((run) => run.run_id === "cycle-interrupted").status, "TIMED_OUT");
  assert.equal(restarted.getActive().runLedger.runs.find((run) => run.run_id === started.run_id).discord_delivery, "DELIVERED");
  restarted.close();
});

test("schema upgrade preserves existing outputs and ledger events", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-upgrade-"));
  const file = join(directory, "upgrade.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE output_records (sequence INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL UNIQUE, output_type TEXT NOT NULL CHECK (output_type IN ('COMMITTEE_OUTPUT')), channel TEXT NOT NULL CHECK (channel IN ('PRODUCTION', 'SHADOW', 'SYSTEM')), observed_at TEXT NOT NULL, received_at TEXT NOT NULL, payload_json TEXT NOT NULL, raw_json TEXT NOT NULL, raw_sha256 TEXT NOT NULL);
    CREATE TABLE agent_run_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, run_key TEXT NOT NULL, agent_id TEXT NOT NULL, skill_id TEXT NOT NULL, run_id TEXT NOT NULL, slot_id TEXT NOT NULL, channel TEXT NOT NULL CHECK (channel IN ('PRODUCTION', 'SHADOW', 'SYSTEM')), version TEXT NOT NULL, data_cutoff_at TEXT NOT NULL, event_at TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('STARTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'TIMED_OUT')), output_status TEXT NOT NULL CHECK (output_status IN ('NOT_PRODUCED', 'PRODUCED')), error TEXT, evidence_refs_json TEXT NOT NULL, website_delivery TEXT NOT NULL CHECK (website_delivery IN ('NOT_APPLICABLE', 'NOT_ATTEMPTED', 'PENDING', 'DELIVERED', 'FAILED')), discord_delivery TEXT NOT NULL CHECK (discord_delivery IN ('NOT_APPLICABLE', 'NOT_ATTEMPTED', 'PENDING', 'DELIVERED', 'FAILED')), received_at TEXT NOT NULL, raw_json TEXT NOT NULL, canonical_sha256 TEXT NOT NULL);
  `);
  const payload = { contract_version: "v1", role: "COMMITTEE", flow_state: "unknown", direction: "unknown", confidence: 0, summary: "preserved", evidence_for: [], evidence_against: [], reversal_signals: [], data_gaps: [] };
  const envelope = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "old-output", output_type: "COMMITTEE_OUTPUT", channel: "PRODUCTION", observed_at: "2026-08-11T12:00:00.000Z", payload });
  old.prepare("INSERT INTO output_records (record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("old-output", "COMMITTEE_OUTPUT", "PRODUCTION", "2026-08-11T12:00:00.000Z", "2026-08-11T12:00:01.000Z", JSON.stringify(payload), envelope, "a".repeat(64));
  const event = runEvent({ event_id: "old-event" });
  old.prepare("INSERT INTO agent_run_events (event_id, run_key, agent_id, skill_id, run_id, slot_id, channel, version, data_cutoff_at, event_at, status, output_status, error, evidence_refs_json, website_delivery, discord_delivery, received_at, raw_json, canonical_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(event.event_id, [event.agent_id, event.skill_id, event.run_id, event.slot_id].join("|"), event.agent_id, event.skill_id, event.run_id, event.slot_id, event.channel, event.version, event.data_cutoff_at, event.event_at, event.status, event.output_status, event.error, JSON.stringify(event.evidence_refs), event.website_delivery, event.discord_delivery, "2026-08-11T13:00:01.000Z", JSON.stringify(event), "b".repeat(64));
  old.close();

  const upgraded = openSnapshotDatabase(file);
  assert.equal(upgraded.getActive().outputs.COMMITTEE_OUTPUT.summary, "preserved");
  assert.equal(upgraded.getActive().runLedger.runs[0].event_id, "old-event");
  assert.equal(upgraded.getOutputRaw("old-output"), envelope);
  const inspected = new DatabaseSync(file);
  try {
    assert.ok(inspected.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'output_records_instant_projection' AND tbl_name = 'output_records'").get(), "legacy table rebuild must retain the latest-time index on its first startup");
    assert.equal(inspected.prepare("PRAGMA foreign_key_list(owner_position_plan_versions)").get().table, "output_records");
    assert.deepEqual(inspected.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { inspected.close(); }
  const blocked = { ...event, event_id: "old-event-blocked", event_at: "2026-08-11T13:01:00.000Z", status: "DATA_BLOCKED", error: "stale data" };
  upgraded.importRunEventRaw(JSON.stringify(blocked));
  assert.equal(upgraded.getActive().runLedger.runs[0].status, "DATA_BLOCKED");
  upgraded.close();
});

test("external expert cases persist append-only timelines without entering TS Forward statistics", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-external-expert-")), file = join(directory, "observer.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  let store = openSnapshotDatabase(file);
  const created = store.recordExternalExpertEvent({
    event_type: "NEW_SIGNAL", realtime_class: "LIVE", received_at: "2026-08-24T16:01:02.000Z", source_published_at: "2026-08-24T16:00:00.000Z", raw_text: "大哥：SPY 690C 看多",
    expert: { source: "示例来源", symbol: "SPY", direction: "BULLISH", instrument: "CALL", expiration: "2026-08-24", strike: 690 }, owner: { followed: false }, ts: { comparable: true, wait: true, wait_classification: "POSSIBLE_OVERBLOCK", summary: "WAIT，解除条件未显示" },
  }, [{ name: "signal.png", mime: "image/png", bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }]);
  assert.deepEqual([created.case.case_id, created.case.status, created.case.realtime_class], ["TSX-20260824-001", "OPEN", "LIVE"]);
  const update = { case_id: created.case.case_id, event_type: "REDUCE", realtime_class: "LIVE", received_at: "2026-08-24T16:20:00.000Z", raw_text: "减仓一半", expert: { action: "REDUCE" }, owner: { followed: true, action: "HOLD" }, market: { mfe_pct: 35 } };
  assert.equal(store.recordExternalExpertEvent(update).case.status, "PARTIAL_EXIT");
  assert.equal(store.recordExternalExpertEvent(update).duplicate, true);
  const closed = store.recordExternalExpertEvent({ case_id: created.case.case_id, event_type: "EXIT", realtime_class: "LIVE", received_at: "2026-08-24T16:40:00.000Z", raw_text: "全部止盈", expert: { action: "EXIT" }, market: { signal_outcome: "WIN" }, recap: { conclusion: "TS疑似错误WAIT", still_observing: "无" } });
  assert.equal(closed.case.status, "CLOSED");
  assert.throws(() => store.recordExternalExpertEvent({ case_id: created.case.case_id, event_type: "MARKET_UPDATE", status: "OPEN", realtime_class: "DELAYED", received_at: "2026-08-24T17:00:00.000Z", raw_text: "错误重开" }), /终态案例/);
  const offline = store.recordExternalExpertEvent({ event_type: "NEW_SIGNAL", realtime_class: "OFFLINE_RECAP", received_at: "2026-08-25T16:00:00.000Z", raw_text: "关机期间的旧单", expert: { source: "示例来源", symbol: "QQQ", direction: "BEARISH", instrument: "PUT" } });
  assert.equal(offline.case.status, "RECAP_ONLY");
  const before = store.getActive("settlements");
  assert.deepEqual([before.externalExpert.case_count, before.externalExpert.ts_comparable_count, before.tsSettlement.trusted.forecast_count, before.outputCount], [2, 1, 0, 0]);
  const evidenceId = before.externalExpert.cases.find((item) => item.case_id === created.case.case_id).events[0].evidence[0].evidence_id;
  assert.equal(store.getExternalExpertEvidence(evidenceId).bytes.length, 8);
  store.close();

  store = openSnapshotDatabase(file);
  assert.deepEqual([store.getExternalExpertOverview().case_count, store.getExternalExpertOverview().cases[1].status], [2, "CLOSED"]);
  store.close();
  const raw = new DatabaseSync(file);
  assert.throws(() => raw.prepare("UPDATE external_expert_events SET case_status = 'OPEN'").run(), /append-only/);
  raw.close();
});

test("explicit EXT cases are append-only, idempotent, and excluded from TS statistics", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-explicit-external-expert-")), file = join(directory, "observer.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(file), before = store.getActive("settlements");
  const jpeg = Buffer.from([255, 216, 255, 224]);
  const nvda = {
    case_id: "EXT-NVDA-20260828-121722-215P-0904-01", event_type: "NEW_SIGNAL", realtime_class: "DELAYED", original_classification: "LATE",
    received_at: "2026-08-28T19:17:22.208Z", source_published_at: "2026-08-28T18:58:00.000Z", raw_text: "NVDA 2026-09-04 215 Put",
    expert: { source: "外部专家", symbol: "NVDA", direction: "BEARISH", instrument: "PUT", expiration: "2026-09-04", strike: 215, cost_basis: 3.23 },
    owner: { followed: "UNKNOWN" }, market: { screenshot_price: 3.20, bid: 3.15, ask: 3.25, underlying_price: 217.05 }, ts: { comparable: false },
  };
  assert.throws(() => store.recordExternalExpertEvent({ ...nvda, event_type: "MARKET_UPDATE", original_classification: undefined }), /案例不存在/);
  assert.throws(() => store.recordExternalExpertEvent({ ...nvda, realtime_class: "LATE_RECAP" }, [{ name: "nvda-original.jpg", mime: "image/jpeg", bytes: jpeg }]), /original_classification=LATE.*DELAYED/);
  const created = store.recordExternalExpertEvent(nvda, [{ name: "nvda-original.jpg", mime: "image/jpeg", bytes: jpeg }]);
  const duplicate = store.recordExternalExpertEvent(nvda, [{ name: "nvda-original.jpg", mime: "image/jpeg", bytes: jpeg }]);
  assert.deepEqual([created.duplicate, duplicate.duplicate, duplicate.case.events.length, duplicate.case.events[0].evidence.length], [false, true, 1, 1]);
  assert.throws(() => store.recordExternalExpertEvent({ ...nvda, expert: { ...nvda.expert, strike: 220 } }, [{ name: "nvda-original.jpg", mime: "image/jpeg", bytes: jpeg }]), /case_id.*内容不一致/);

  store.recordExternalExpertEvent({
    case_id: "EXT-MSFT-20260828-080843-515C-0828-01", event_type: "NEW_SIGNAL", realtime_class: "LATE_RECAP", original_classification: "RECAP",
    received_at: "2026-08-28T15:08:43.173Z", source_published_at: "2026-08-28T15:07:00.000Z", raw_text: "MSFT 2026-08-28 515 Call",
    expert: { source: "外部专家", symbol: "MSFT", direction: "BULLISH", instrument: "CALL", expiration: "2026-08-28", strike: 515, cost_basis: 0.74 },
    owner: { followed: "UNKNOWN" }, market: { screenshot_price: 1.96, underlying_price: 515.50, screenshot_pnl: 123, screenshot_pnl_pct: 166.22 }, ts: { comparable: false },
  }, [{ name: "msft-original.jpg", mime: "image/jpeg", bytes: Buffer.from([255, 216, 255, 225]) }]);

  const overview = store.getExternalExpertOverview(), after = store.getActive("settlements");
  assert.deepEqual([overview.case_count, overview.original_classifications.LIVE, overview.original_classifications.LATE, overview.original_classifications.RECAP], [2, 0, 1, 1]);
  assert.deepEqual(overview.cases.map((item) => [item.case_id, item.original_classification, item.realtime_class, item.status]), [
    ["EXT-MSFT-20260828-080843-515C-0828-01", "RECAP", "LATE_RECAP", "RECAP_ONLY"],
    ["EXT-NVDA-20260828-121722-215P-0904-01", "LATE", "DELAYED", "OPEN"],
  ]);
  assert.deepEqual([after.tsSettlement.trusted, after.outputCount], [before.tsSettlement.trusted, before.outputCount]);
  assert.equal(overview.ts_comparable_count, 0);
  store.close();
});

test("open external option cases record fresh readonly quotes and expire once", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-external-monitor-")), file = join(directory, "observer.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(file);
  const created = store.recordExternalExpertEvent({ event_type: "NEW_SIGNAL", realtime_class: "LIVE", received_at: "2026-08-31T15:55:00.000Z", raw_text: "NVDA 215 Put", expert: { source: "外部专家", symbol: "NVDA", direction: "BEARISH", instrument: "PUT", expiration: "2026-09-04", strike: 215, cost_basis: 3.2 }, market: { screenshot_price: 3.2 }, ts: { comparable: false } });
  let reads = 0;
  const monitor = createExternalExpertMonitor(store, async (filter) => { reads += 1; assert.deepEqual(filter, { symbol: "NVDA", expiration: "2026-09-04", strike: 215, option_type: "put" }); return { contract_id: "option-1", bid: 3.45, ask: 3.55, mark: 3.5, iv: 0.4, delta: -0.5, gamma: 0.02, theta: -0.1, vega: 0.08, quoted_at: "2026-08-31T15:59:59.000Z", freshness_seconds: 1 }; });
  assert.deepEqual(await monitor.runOnce(new Date("2026-08-31T16:00:00.000Z")), { checked: 1, recorded: 1, expired: 0 });
  assert.deepEqual(await monitor.runOnce(new Date("2026-08-31T16:00:30.000Z")), { checked: 1, recorded: 0, expired: 0 });
  assert.equal(reads, 2);
  assert.deepEqual(await monitor.runOnce(new Date("2026-09-04T20:01:00.000Z")), { checked: 1, recorded: 1, expired: 1 });
  assert.deepEqual(await monitor.runOnce(new Date("2026-09-04T20:02:00.000Z")), { checked: 0, recorded: 0, expired: 0 });
  const item = store.getExternalExpertOverview().cases[0], state = store.getActive("settlements");
  assert.deepEqual([item.case_id, item.status, item.events.length, item.market.mfe_pct, item.market.mae_pct], [created.case.case_id, "EXPIRED", 3, 9.375, 9.375]);
  assert.deepEqual([state.externalExpert.automated_execution, state.externalExpert.ts_comparable_count, state.tsSettlement.trusted.forecast_count, state.outputCount], [false, 0, 0, 0]);
  store.close();
});
