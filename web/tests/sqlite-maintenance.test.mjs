import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const baselineRoot = process.env.SQLITE_MAINTENANCE_BASELINE_ROOT;
const sourceRoot = baselineRoot ? resolve(baselineRoot) : fileURLToPath(new URL("..", import.meta.url));
const { openSnapshotDatabase } = await import(pathToFileURL(join(sourceRoot, "build/local-data-core.ts")));
const at = "2026-09-08T20:00:00.000Z";

function readonly(file, inspect) {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return inspect(database); } finally { database.close(); }
}

// Heartbeat is the one intentional checkDatabase write; all other stored rows must survive maintenance.
function history(file) {
  return readonly(file, (database) => Object.fromEntries(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'self_check_heartbeats' ORDER BY name").all()
    .map(({ name }) => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()])));
}

async function fixture(context, options) {
  const directory = await mkdtemp(join(process.env.SQLITE_MAINTENANCE_TEST_ROOT ?? tmpdir(), "trading-os-maintenance-"));
  const file = join(directory, "source.sqlite"), store = openSnapshotDatabase(file, options);
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const slot = "live-shadow:20260908T193000Z";
  store.claimTsCoreSlot(slot, slot, "isolated-test", "2026-09-08T19:30:00.000Z");
  store.completeTsCoreSlot(slot, "isolated-test", "FAILED", null, null, "2026-09-08T19:32:00.000Z");
  return { directory, file, store };
}

async function timerBeforeCompletion(operation) {
  const timer = new Promise((accept) => setTimeout(() => accept("timer"), 0));
  const maintenance = Promise.resolve().then(operation);
  const first = await Promise.race([timer, maintenance.then(() => "maintenance")]);
  await maintenance; // Even the red baseline must close its resources before fixture cleanup.
  assert.equal(first, "timer", "real SQLite maintenance must yield the main thread before completion");
}

test("SQLite checkDatabase yields to a 0ms timer before real maintenance completes", async (context) => {
  const { file, store } = await fixture(context), before = history(file);
  await timerBeforeCompletion(() => store.checkDatabase(at));
  assert.deepEqual(history(file), before);
  assert.equal(readonly(file, (database) => database.prepare("SELECT checked_at FROM self_check_heartbeats WHERE heartbeat_id = 'latest'").get().checked_at), at);
});

test("SQLite latest check heartbeat cannot move backward when an older check completes last", async (context) => {
  const { file, store } = await fixture(context), before = history(file);
  const newer = "2026-09-08T20:02:00.000Z", older = "2026-09-08T20:01:00.000Z";
  await store.checkDatabase(newer);
  await store.checkDatabase(older);
  assert.equal(readonly(file, (database) => database.prepare("SELECT checked_at FROM self_check_heartbeats WHERE heartbeat_id = 'latest'").get().checked_at), newer);
  assert.deepEqual(history(file), before);
});

test("SQLite backup yields to a 0ms timer before real maintenance completes", async (context) => {
  const { directory, file, store } = await fixture(context), before = history(file);
  await timerBeforeCompletion(() => store.backup(join(directory, "backups"), new Date(at)));
  assert.deepEqual(history(file), before);
});

test("SQLite daily backup is valid and not rewritten; corrupt existing backup is rejected unchanged", async (context) => {
  const { directory, file, store } = await fixture(context), before = history(file), backups = join(directory, "backups");
  const backup = await store.backup(backups, new Date(at));
  assert.equal(backup, join(backups, "trading-os-web-2026-09-08.sqlite"));
  assert.equal(readonly(backup, (database) => database.prepare("PRAGMA quick_check").get().quick_check), "ok");
  assert.deepEqual(readonly(backup, (database) => database.prepare("PRAGMA foreign_key_check").all()), []);
  assert.deepEqual(history(backup), before);
  const old = new Date("2000-01-01T00:00:00.000Z");
  await utimes(backup, old, old);
  const bytes = await readFile(backup), modified = (await stat(backup)).mtimeMs;
  assert.equal(await store.backup(backups, new Date("2026-09-08T23:59:00.000Z")), backup);
  assert.equal((await stat(backup)).mtimeMs, modified);
  assert.deepEqual(await readFile(backup), bytes);

  const damaged = join(backups, "trading-os-web-2026-09-09.sqlite"), corruptBytes = Buffer.from("isolated corrupt backup: do not replace");
  await writeFile(damaged, corruptBytes);
  await assert.rejects(async () => store.backup(backups, new Date("2026-09-09T00:00:00.000Z")));
  assert.deepEqual(await readFile(damaged), corruptBytes);
  assert.deepEqual(history(file), before);
});

test("SQLite concurrent daily backup publication preserves the first published file", { skip: Boolean(baselineRoot) }, async (context) => {
  // Hold only the native publication boundary. Both VACUUMs and all worker validation remain real.
  function job(file, directory, publicationError) {
    const gate = new SharedArrayBuffer(4);
    const worker = new Worker(`
      const fs = require("node:fs");
      const { parentPort, workerData } = require("node:worker_threads");
      for (const name of ["renameSync", "linkSync"]) {
        const native = fs[name];
        fs[name] = (temporary, destination) => {
          parentPort.postMessage({ ready: true, temporary, destination });
          if (Atomics.wait(new Int32Array(workerData.gate), 0, 0, 10000) === "timed-out") throw new Error("publication gate timeout");
          if (workerData.publicationError) throw Object.assign(new Error("isolated publication failure"), { code: workerData.publicationError });
          return native(temporary, destination);
        };
      }
      require("node:module").syncBuiltinESMExports();
      import(workerData.workerUrl).catch((error) => { throw error; });
    `, { eval: true, workerData: { kind: "backup", file, directory, at, gate, publicationError, workerUrl: pathToFileURL(join(sourceRoot, "server/sqlite-maintenance-worker.ts")).href } });
    let readyResolve, readyReject, failure, result, wasReady = false;
    const ready = new Promise((accept, reject) => { readyResolve = accept; readyReject = reject; });
    worker.on("message", (message) => { if (message?.ready) { wasReady = true; readyResolve(message); } else result = message; });
    const done = new Promise((accept) => {
      worker.once("error", (error) => { failure = error; });
      worker.once("exit", (code) => { if (!wasReady) readyReject(failure ?? new Error("worker exited before publication")); accept({ code, result, failure }); });
    });
    return { ready, done, release() { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0); } };
  }
  for (const damaged of [false, true]) await context.test(damaged ? "competing damaged destination is rejected unchanged" : "slower backup cannot replace published bytes or mtime", async (subtest) => {
    const directory = await mkdtemp(join(process.env.SQLITE_MAINTENANCE_TEST_ROOT ?? tmpdir(), "trading-os-publication-"));
    const file = join(directory, "source.sqlite"), backups = join(directory, "backups"), writer = new DatabaseSync(file);
    subtest.after(async () => { writer.close(); await rm(directory, { recursive: true, force: true }); });
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture(revision INTEGER); INSERT INTO fixture VALUES(1)");
    const first = job(file, backups);
    let second;
    try {
      const firstReady = await first.ready;
      writer.exec("UPDATE fixture SET revision=2");
      second = job(file, backups);
      const secondReady = await second.ready;
      assert.notEqual(firstReady.temporary, secondReady.temporary);
      assert.equal(firstReady.destination, secondReady.destination);
      assert.equal(existsSync(firstReady.destination), false);
      second.release();
      const winner = await second.done;
      assert.equal(winner.code, 0, winner.failure?.message);
      assert.equal(readonly(winner.result, (database) => database.prepare("SELECT revision FROM fixture").get().revision), 2);
      if (damaged) await writeFile(winner.result, "isolated corrupt publication: never replace");
      const bytes = await readFile(winner.result), mtime = (await stat(winner.result)).mtimeMs;
      first.release();
      const loser = await first.done;
      assert.equal(loser.code, damaged ? 1 : 0, loser.failure?.message);
      assert.deepEqual(await readFile(winner.result), bytes, "published backup bytes must never be replaced by a slower worker");
      assert.equal((await stat(winner.result)).mtimeMs, mtime);
      assert.deepEqual((await readdir(backups)).filter((name) => name.endsWith(".tmp")), []);
      assert.equal(writer.prepare("SELECT revision FROM fixture").get().revision, 2);
    } finally { first.release(); second?.release(); await first.done; await second?.done; }
  });
  await context.test("non-EEXIST publication failure is propagated and temporary file removed", async (subtest) => {
    const directory = await mkdtemp(join(process.env.SQLITE_MAINTENANCE_TEST_ROOT ?? tmpdir(), "trading-os-publication-"));
    const file = join(directory, "source.sqlite"), backups = join(directory, "backups");
    const source = new DatabaseSync(file); source.exec("CREATE TABLE fixture(revision INTEGER)"); source.close();
    subtest.after(() => rm(directory, { recursive: true, force: true }));
    const failed = job(file, backups, "EACCES");
    try {
      const ready = await failed.ready; failed.release();
      const result = await failed.done;
      assert.equal(result.code, 1);
      assert.equal(result.failure?.code, "EACCES");
      assert.equal(existsSync(ready.destination), false);
      assert.deepEqual(await readdir(backups), []);
    } finally { failed.release(); await failed.done; }
  });
});

test("SQLite worker evidence retains the exact Manager shape and stored history", { skip: Boolean(baselineRoot) }, async (context) => {
  const { runSqliteMaintenance } = await import("../server/sqlite-maintenance.ts");
  const { directory, file, store } = await fixture(context), before = history(file);
  const backup = await store.backup(join(directory, "backups"), new Date(at)), backupStats = await stat(backup);
  const tables = ["output_records", "agent_run_events", "incidents", "ts_forecast_archive", "ts_forecast_settlements", "ts_owner_trigger_events", "ts_intraday_regime_events", "spx_option_watches", "spx_option_watch_events", "owner_action_events", "spx_convexity_opportunities", "spx_convexity_opportunity_events", "codex_manager_events", "external_expert_cases", "external_expert_events", "external_expert_evidence"];
  const expected = {
    database_path: file, size_bytes: (await stat(file)).size, quick_check: "ok", integrity_check: "ok",
    counts: Object.fromEntries(tables.map((table) => [table, before[table].length])),
    latest_backup: { path: backup, size_bytes: backupStats.size, modified_at: backupStats.mtime.toISOString() },
  };
  let evidence;
  await timerBeforeCompletion(async () => { evidence = await runSqliteMaintenance({ kind: "evidence", file, dataRoot: directory }); });
  assert.deepEqual(evidence, expected);
  assert.deepEqual(history(file), before);
});

test("SQLite maintenance rejects missing source without creating it and recovers after worker errors", { skip: Boolean(baselineRoot) }, async (context) => {
  const { runSqliteMaintenance } = await import("../server/sqlite-maintenance.ts");
  const { directory, file } = await fixture(context), before = history(file), missing = join(directory, "missing.sqlite"), backups = join(directory, "missing-source-backups");
  for (const task of [
    { kind: "check", file: missing },
    { kind: "backup", file: missing, directory: backups, at },
    { kind: "evidence", file: missing, dataRoot: directory },
  ]) {
    await assert.rejects(() => runSqliteMaintenance(task));
    assert.equal(existsSync(missing), false);
    assert.equal(existsSync(backups), false);
  }
  await runSqliteMaintenance({ kind: "check", file });
  assert.deepEqual(history(file), before);
});

test("SQLite maintenance on an unlocked database does not queue behind another database's exclusive lock", { skip: Boolean(baselineRoot) }, async (context) => {
  const { runSqliteMaintenance } = await import("../server/sqlite-maintenance.ts");
  const { directory, file } = await fixture(context), lockedFile = join(directory, "locked.sqlite");
  openSnapshotDatabase(lockedFile).close();
  const locker = new DatabaseSync(lockedFile);
  locker.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
  let firstFinished = false, firstError, timeout;
  const pending = runSqliteMaintenance({ kind: "check", file: lockedFile }).then(
    () => { firstFinished = true; }, (error) => { firstFinished = true; firstError = error; },
  );
  const independent = runSqliteMaintenance({ kind: "check", file });
  try {
    await Promise.race([
      independent,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("unrelated maintenance queued behind the locked database")), 5_000); }),
    ]);
    assert.equal(firstFinished, false, "the first database must still be locked when the independent check completes");
  } finally {
    clearTimeout(timeout);
    locker.exec("ROLLBACK");
    locker.close();
    await Promise.all([pending, independent]);
  }
  assert.equal(firstError, undefined);
});

test("SQLite concurrent checks share unfinished work without caching success or failure", async (context) => {
  const { runSqliteMaintenance } = await import("../server/sqlite-maintenance.ts");
  const { directory, file } = await fixture(context), before = history(file);
  for (const target of [file, join(directory, "missing.sqlite")]) {
    const first = runSqliteMaintenance({ kind: "check", file: target });
    assert.equal(runSqliteMaintenance({ kind: "check", file: target }), first);
    if (target === file) await first; else await assert.rejects(first);
    const next = runSqliteMaintenance({ kind: "check", file: target });
    assert.notEqual(next, first, "finished checks must never be reused as current health");
    if (target === file) await next; else await assert.rejects(next);
  }
  assert.deepEqual(history(file), before);
  assert.equal(existsSync(join(directory, "missing.sqlite")), false);
});

test("SQLite in-memory store retains its own check and backup contents; detached memory workers are rejected", { skip: Boolean(baselineRoot) }, async (context) => {
  const { runSqliteMaintenance } = await import("../server/sqlite-maintenance.ts");
  const { directory } = await fixture(context), store = openSnapshotDatabase(":memory:", { investmentProfile: "BLANK" });
  try {
    const slot = "live-shadow:20260908T193000Z";
    store.claimTsCoreSlot(slot, slot, "memory-test", "2026-09-08T19:30:00.000Z");
    store.completeTsCoreSlot(slot, "memory-test", "FAILED", null, null, "2026-09-08T19:32:00.000Z");
    const before = store.getTsCoreSlotOwnership(slot);
    await store.checkDatabase(at);
    assert.deepEqual(store.getTsCoreSlotOwnership(slot), before);
    const backup = await store.backup(join(directory, "memory-backups"), new Date(at));
    assert.equal(readonly(backup, (database) => database.prepare("PRAGMA quick_check").get().quick_check), "ok");
    assert.equal(readonly(backup, (database) => database.prepare("SELECT COUNT(*) AS count FROM ts_core_slot_ownership").get().count), 1);
    assert.equal(readonly(backup, (database) => database.prepare("SELECT checked_at FROM self_check_heartbeats WHERE heartbeat_id = 'latest'").get().checked_at), at);
    await assert.rejects(() => runSqliteMaintenance({ kind: "check", file: ":memory:" }), /Invalid SQLite maintenance task/);
  } finally { store.close(); }
});

function legacyRuntimeContext(store) {
  const state = store.getActive();
  return { investmentKernel: state.investmentKernel, spxConvexity: state.spxConvexity, currentTruth: state.currentTruth, dataSources: state.dataSources, marketIntelligence: state.marketIntelligence, marketRadar: state.marketRadar, tsOutputs: state.outputs.TS_SHADOW_OUTPUT, optionStrategySignals: state.outputs.OPTION_STRATEGY_SIGNAL, positionCopilotStates: state.outputs.POSITION_COPILOT_STATE, ownerPositionPlans: store.getOwnerPositionPlans().plans, optionIvHistory: store.getOptionIvHistory() };
}

test("runtime context preserves all fields without reading discarded UI projections", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const { file, store } = await fixture(context), expected = legacyRuntimeContext(store), before = projectionDatabase(file);
  const prepare = DatabaseSync.prototype.prepare;
  context.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    const statement = prepare.call(this, sql);
    if (/LEFT JOIN ts_forecast_settlements|\$\.official_macro|FROM paper_plan_events|^SELECT record_id FROM stock_manual_plans ORDER BY|FROM owner_position_plan_versions ORDER BY/.test(sql)) {
      for (const method of ["get", "all", "iterate"]) statement[method] = () => { throw new Error(`Runtime read discarded UI evidence: ${sql}`); };
    }
    return statement;
  });
  const reader = openSnapshotDatabase(file, { readOnly: true });
  try { assert.deepEqual(reader.getRuntimeContext(), expected); } finally { reader.close(); }
  assert.deepEqual(projectionDatabase(file), before);
});

for (const kind of ["snapshot", "runtime-context"]) test(`SQLite fresh ${kind} projection yields to heartbeat before real completion`, async (context) => {
  const { file, store } = await fixture(context), before = history(file);
  await timerBeforeCompletion(() => kind === "snapshot"
    ? store.getActiveAsync ? store.getActiveAsync() : store.getActive()
    : store.getRuntimeContextAsync ? store.getRuntimeContextAsync() : legacyRuntimeContext(store));
  assert.deepEqual(history(file), before);
});

function projectionDatabase(file) {
  return readonly(file, (database) => ({
    schema: database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
    tables: Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
      .map(({ name }) => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()])),
  }));
}

test("SQLite readonly projections preserve history, holdings and explicit options and observe later committed writes", { skip: Boolean(baselineRoot) }, async (context) => {
  const options = { investmentProfile: "BLANK", runtimeIdentity: { deployedCommit: "c".repeat(40), runtimeSha256: "d".repeat(64) } };
  const { file, store } = await fixture(context, options), writer = new DatabaseSync(file);
  try {
  const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
  const forecast = sample.contracts.TS_OUTPUT[0];
  // Deliberately old classification: opening a reader must not run startup reconciliation.
  writer.prepare("INSERT INTO ts_forecast_archive (forecast_run_id,source_record_id,source_mode,eligibility,exclusion_reason,published_at,market_date,official_slot,phase,report_type,forecast_hash,payload_json) VALUES (?,?,'REPLAY','EXCLUDED_REPLAY','retain old classification',?,?,'06:30','INITIAL',?,?,?)")
    .run(forecast.evidence_snapshot.run_id, "live-shadow:20260729T133018Z:TS", at, "2026-07-29", forecast.report_type, "a".repeat(64), JSON.stringify(forecast));
  function appendMarket(revision) {
    const observed = new Date(Date.parse(at) + revision * 1000).toISOString();
    const position = { contract_id: `isolated-spxw-${revision}`, symbol: "SPXW", option_type: "call", expiration: "2026-09-18", strike: 7000 + revision };
    const contract = { contract_id: `isolated-spy-${revision}`, expiration: "2026-09-18", strike: 700, option_type: "call", implied_volatility: 0.2 };
    const payload = { source_mode: "LIVE", observed_at: observed, market_sources: { snapshot_id: `isolated-market-${revision}`, market_session: { market_date: "2026-09-08" }, account: { positions: [position] }, quotes: [{ source: "ROBINHOOD", symbol: "SPY", last: 700 + revision }], options: [{ source: "ROBINHOOD", symbol: "SPY", contracts: [contract] }] } };
    writer.prepare("INSERT INTO output_records (record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,'A1_SHADOW_RESULT','SHADOW',?,?,?,?,?)")
      .run(`live-shadow:20260908T193000Z:A1-${revision}`, observed, observed, JSON.stringify(payload), JSON.stringify(payload), "b".repeat(64));
    return { position, contract };
  }
  const firstMarket = appendMarket(1), before = projectionDatabase(file);
  const first = await store.getActiveAsync(), firstContext = await store.getRuntimeContextAsync();
  assert.equal(first.spxwProxy.real_holdings[0].contract_id, firstMarket.position.contract_id);
  assert.equal(firstContext.optionIvHistory.length, 1);
  assert.deepEqual(firstContext.optionIvHistory[0].contracts, [firstMarket.contract]);
  for (const value of [first, firstContext]) {
    assert.equal(value.investmentKernel.profile_mode, "BLANK");
    assert.equal(value.currentTruth.release_id, options.runtimeIdentity.deployedCommit);
    assert.equal(value.currentTruth.runtime_sha256, options.runtimeIdentity.runtimeSha256);
  }
  const source = { source: "ROBINHOOD", status: "LIVE", configured: true, authorization: "VALID", last_success_at: at, as_of: at, freshness_seconds: 0, error: null, checked_at: at, capabilities: {} };
  const reader = openSnapshotDatabase(file, { ...options, readOnly: true });
  try {
    assert.equal(reader.getActive().spxwProxy.real_holdings[0].contract_id, firstMarket.position.contract_id);
    assert.throws(() => reader.recordDataSourceStatus(source), /readonly|read-only/i, "native SQLite must reject a store write on the reader connection");
  } finally { reader.close(); }
  assert.deepEqual(projectionDatabase(file), before, "all rows, stats, schema and old forecast classification must remain exact");

  const nextMarket = appendMarket(2);
  store.recordDataSourceStatus(source);
  const afterWrite = projectionDatabase(file), started = Date.now(), next = await store.getActiveAsync(), nextContext = await store.getRuntimeContextAsync(), ended = Date.now();
  assert.equal(next.spxwProxy.real_holdings[0].contract_id, nextMarket.position.contract_id);
  for (const value of [next, nextContext]) {
    const { freshness_seconds, ...observed } = value.dataSources.find((item) => item.source === "ROBINHOOD");
    const { freshness_seconds: storedAge, ...expected } = source;
    assert.deepEqual(observed, expected);
    assert.ok(freshness_seconds >= Math.max(0, Math.round((started - Date.parse(at)) / 1000)) && freshness_seconds <= Math.max(0, Math.round((ended - Date.parse(at)) / 1000)), "data age must be recomputed from the real query clock, not cached");
    assert.equal(storedAge, 0);
  }
  assert.deepEqual(nextContext.optionIvHistory.map((item) => item.snapshot_id), ["isolated-market-2", "isolated-market-1"]);
  assert.deepEqual(nextContext.optionIvHistory[0].contracts, [nextMarket.contract]);
  assert.deepEqual(projectionDatabase(file), afterWrite);
  } finally { writer.close(); }
});

test("SQLite readonly projection rejects missing and old-schema files without creation or migration", { skip: Boolean(baselineRoot) }, async (context) => {
  const { runSqliteMaintenance } = await import("../server/sqlite-maintenance.ts");
  const { directory } = await fixture(context), missing = join(directory, "absent-parent", "missing.sqlite"), old = join(directory, "old.sqlite");
  const legacy = new DatabaseSync(old);
  legacy.exec("CREATE TABLE snapshots(snapshot_id TEXT); INSERT INTO snapshots VALUES('retain-legacy')");
  legacy.close();
  const before = projectionDatabase(old), options = { investmentProfile: "BLANK", runtimeIdentity: { deployedCommit: "e".repeat(40), runtimeSha256: "f".repeat(64) } };
  for (const file of [missing, old]) {
    assert.throws(() => openSnapshotDatabase(file, { ...options, readOnly: true }));
    for (const kind of ["snapshot", "runtime-context"]) await assert.rejects(() => runSqliteMaintenance({ kind, file, ...options }));
    assert.equal(existsSync(join(directory, "absent-parent")), false);
    assert.deepEqual(projectionDatabase(old), before);
  }
});

test("SQLite schedule supervision cannot mix a concurrent WAL commit into its earlier projection", async (context) => {
  const { file, store } = await fixture(context), slot = "live-shadow:20260908T133000Z", checkedAt = "2026-09-08T13:32:00.000Z", gate = new SharedArrayBuffer(4);
  assert.equal(readonly(file, (database) => database.prepare("PRAGMA journal_mode").get().journal_mode), "wal");
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads"), { DatabaseSync } = require("node:sqlite");
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [workerData.checkedAt])); } static now() { return NativeDate.parse(workerData.checkedAt); } };
    const prepare = DatabaseSync.prototype.prepare;
    let paused = false;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (sql === "SELECT * FROM ts_core_slot_ownership WHERE slot_id = ?") {
        const get = statement.get.bind(statement);
        statement.get = (...args) => {
          if (!paused && args[0] === workerData.slot) {
            paused = true; parentPort.postMessage({ paused: true });
            if (Atomics.wait(new Int32Array(workerData.gate), 0, 0, 10000) === "timed-out") throw new Error("projection gate timeout");
          }
          return get(...args);
        };
      }
      return statement;
    };
    (async () => {
      if (!workerData.baseline) { await import(workerData.workerUrl); return; }
      const { openSnapshotDatabase } = await import(workerData.coreUrl), { scheduleLedgerSupervision } = await import(workerData.managerUrl);
      const reader = openSnapshotDatabase(workerData.file);
      try { parentPort.postMessage(scheduleLedgerSupervision(reader, workerData.checkedAt)); }
      finally { reader.close(); }
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { kind: "schedule-supervision", file, checkedAt, slot, gate, baseline: Boolean(baselineRoot), investmentProfile: "OWNER", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, workerUrl: pathToFileURL(join(sourceRoot, "server/sqlite-maintenance-worker.ts")).href, coreUrl: pathToFileURL(join(sourceRoot, "build/local-data-core.ts")).href, managerUrl: pathToFileURL(join(sourceRoot, "server/codex-production-manager.ts")).href } });
  let signalReady, rejectReady, result, failure, paused = false;
  const ready = new Promise((accept, reject) => { signalReady = accept; rejectReady = reject; });
  worker.on("message", message => { if (message?.paused) { paused = true; signalReady(); } else result = message; });
  const done = new Promise(accept => {
    worker.once("error", error => { failure = error; });
    worker.once("exit", code => { if (!paused) rejectReady(failure ?? new Error("supervision did not reach its actual ownership read")); accept(code); });
  });
  const release = () => { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0); };
  try {
    await ready;
    assert.equal(store.getTsCoreSlotOwnership(slot), null);
    store.claimTsCoreSlot(slot, slot, "concurrent-writer", "2026-09-08T13:30:00.000Z");
    store.completeTsCoreSlot(slot, "concurrent-writer", "FAILED", null, null, "2026-09-08T13:31:00.000Z");
    const committed = projectionDatabase(file);
    assert.equal(store.getTsCoreSlotOwnership(slot).status, "TERMINAL");
    release();
    assert.equal(await done, 0, failure?.stack);
    const observed = result.slots.find(item => item.slot_id === slot);
    assert.equal(observed.ownership_status, "MISSING", "the projection began before the writer committed; later ownership must not leak into that read");
    assert.equal(observed.terminal_outcome, null);
    assert.deepEqual(observed.issues, ["OWNERSHIP_MISSING", "FORECAST_MISSING"]);
    assert.deepEqual(projectionDatabase(file), committed, "the readonly worker must not alter the concurrent writer's committed history");
  } finally { release(); await done; }
});
