import assert from "node:assert/strict";
process.env.TRADING_OS_RUNTIME_ROLE = "TIER0";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { openSnapshotDatabase } from "../build/local-data-core.ts";

// No child/provider call is permitted in this offline regression.
const originalSpawn = childProcess.spawn, originalExec = childProcess.execFileSync;
childProcess.spawn = () => { throw new Error("PROVIDER_MUST_NOT_RUN"); };
childProcess.execFileSync = () => "TCP 127.0.0.1:4070 0.0.0.0:0 LISTENING 1";
syncBuiltinESMExports();
const { createIncidentGuard } = await import("../server/incident-guard.ts");
const { createCodexProductionManager } = await import("../server/codex-production-manager.ts");
test.after(() => { childProcess.spawn = originalSpawn; childProcess.execFileSync = originalExec; syncBuiltinESMExports(); });
const secret = "PRIVATE_ACCOUNT_TOKEN_NOT_FOR_TIMING";
const at = new Date("2026-09-06T05:00:00.000Z");
const root = resolve(process.env.TRADING_OS_TRACE_TEST_ROOT ?? tmpdir());
mkdirSync(root, { recursive: true });
function fixture(context) {
  const directory = mkdtempSync(join(root, "maintenance-timing-"));
  const store = openSnapshotDatabase(join(directory, "isolated.sqlite"));
  context.after(() => store.close());
  return { directory, store };
}
async function records(directory, prefix, finalPhase) {
  let rows = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    try { rows = readdirSync(join(directory, "logs")).filter((name) => name.startsWith(prefix)).flatMap((name) => readFileSync(join(directory, "logs", name), "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))).filter((row) => row.event === "stage_timing"); } catch { /* The asynchronous diagnostic sink may not have created its file yet. */ }
    if (rows.some((row) => row.phase === finalPhase && row.boundary === "END")) return rows;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return rows;
}
function phasePair(rows, phase) {
  const pair = rows.filter((row) => row.phase === phase);
  assert.deepEqual(pair.map((row) => row.boundary), ["BEGIN", "END"], `Missing phase ${phase}`);
  assert.ok(pair.every((row) => row.pid === process.pid && Number.isFinite(Date.parse(row.wall_at)) && typeof row.run_id === "string" && Number.isFinite(row.elapsed_ms) && row.elapsed_ms >= 0));
  for (const row of pair) assert.deepEqual(Object.keys(row).sort(), ["boundary", "elapsed_ms", "event", "phase", "pid", "run_id", "wall_at"], "Only scalar timing metadata may be logged");
  assert.ok(pair[1].elapsed_ms >= pair[0].elapsed_ms);
}
const guardOptions = (store, directory) => ({ store, dataRoot: directory, siteVersion: "offline-trace", now: () => at, pageProbe: async () => true, desktopProbe: async () => [], marketProbe: async () => ({ source: "ROBINHOOD", symbol: "SPY", interval: "5m", status: "MARKET_CLOSED", market_session: "CLOSED", as_of: at.toISOString(), freshness_seconds: 0, bars: [], error: null }) });

test("Guard records paired redacted phases including failed synchronous checks without changing findings", async (context) => {
  const { store, directory } = fixture(context);
  store.checkDatabase = () => { throw new Error(secret); };
  const result = await createIncidentGuard(guardOptions(store, directory)).runOnce();
  assert.ok(result.findings.some((item) => item.code === "SQLITE_READ_WRITE_FAILED"));
  const rows = await records(directory, "incident-guard-", "reconcileIncidents");
  for (const phase of ["checkDatabase", "checkUtcStorage", "backup", "marketProbe.dispatch", "marketProbe", "getActive.truth", "getActive.state", "reconcileIncidents"]) phasePair(rows, phase);
  assert.ok(!JSON.stringify(rows).includes(secret));
});

test("Guard asynchronous phase timing ends after the awaited snapshot completes", async (context) => {
  const { store, directory } = fixture(context);
  store.getActiveAsync = async () => { await new Promise((accept) => setTimeout(accept, 30)); return store.getActive(); };
  await createIncidentGuard(guardOptions(store, directory)).runOnce();
  const rows = await records(directory, "incident-guard-", "reconcileIncidents");
  for (const phase of ["getActive.truth", "getActive.state"]) {
    phasePair(rows, phase);
    assert.ok(rows.find((row) => row.phase === phase && row.boundary === "END").elapsed_ms >= 25, "Promise creation is not phase completion");
  }
});

test("Manager traces daily and full synchronous gathering and hash phases even when LLM budget is skipped", async (context) => {
  for (const trigger of ["SCHEDULE_INTRADAY", "SCHEDULE_WEEKLY_REVIEW"]) {
    const { store, directory } = fixture(context);
    store.codexManagerUsageSince = () => ({ calls: 999, estimated_cost_usd: 999 });
    const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "offline-trace", runtimeIdentity: { deployedCommit: "trace-only", runtimeSha256: "trace-only" }, now: () => at, invoke: async () => { throw new Error("LLM_MUST_NOT_RUN"); } });
    const result = await manager.run(trigger, secret);
    assert.equal(result.status, "SKIPPED_BUDGET");
    const rows = await records(directory, "codex-manager-timing-", "snapshot.record");
    for (const phase of ["runRequested.record", trigger === "SCHEDULE_WEEKLY_REVIEW" ? "tools.full" : "tools.daily", "getActive", "databaseEvidence", "netstat", "snapshot.stringify", "snapshot.hash", "tools.record", "snapshot.record"]) phasePair(rows, phase);
    if (trigger !== "SCHEDULE_WEEKLY_REVIEW") phasePair(rows, "getManagerState");
    assert.ok(rows.every((row) => row.run_id === result.manager_run_id));
    assert.ok(!JSON.stringify(rows).includes(secret));
    assert.equal(store.getActive().outputCount, 0, "Trace must not create business output");
  }
});

test("Timing append failures do not change Guard or Manager outcomes", async (context) => {
  const append = fsPromises.appendFile;
  let failedWrites = 0;
  fsPromises.appendFile = async (...args) => {
    if (String(args[1]).includes('"event":"stage_timing"')) { failedWrites++; throw Object.assign(new Error(secret), { code: "EIO" }); }
    return append(...args);
  };
  syncBuiltinESMExports();
  context.after(() => { fsPromises.appendFile = append; syncBuiltinESMExports(); });
  const { store, directory } = fixture(context);
  const guardResult = await createIncidentGuard(guardOptions(store, directory)).runOnce();
  assert.ok(!guardResult.findings.some((item) => item.details?.error === secret));
  store.codexManagerUsageSince = () => ({ calls: 999, estimated_cost_usd: 999 });
  const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "offline-trace", runtimeIdentity: { deployedCommit: "trace-only", runtimeSha256: "trace-only" }, now: () => at, invoke: async () => { throw new Error("LLM_MUST_NOT_RUN"); } });
  assert.equal((await manager.run("SCHEDULE_INTRADAY", secret)).status, "SKIPPED_BUDGET");
  for (let attempt = 0; failedWrites < 40 && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(failedWrites >= 40, "Actual asynchronous write failures were exercised without changing the results");
});

test("New phase logging never performs synchronous IO or waits for a blocked asynchronous append", async (context) => {
  const appendSync = fs.appendFileSync, append = fsPromises.appendFile;
  let syncWrites = 0, asyncWrites = 0, release;
  const held = new Promise((resolve) => { release = resolve; });
  fs.appendFileSync = (...args) => { if (String(args[1]).includes('"event":"stage_timing"')) syncWrites++; return appendSync(...args); };
  fsPromises.appendFile = async (...args) => { if (String(args[1]).includes('"event":"stage_timing"')) { asyncWrites++; await held; } return append(...args); };
  syncBuiltinESMExports();
  context.after(() => { release(); fs.appendFileSync = appendSync; fsPromises.appendFile = append; syncBuiltinESMExports(); });
  const { store, directory } = fixture(context);
  const guard = createIncidentGuard(guardOptions(store, directory));
  await guard.runOnce();
  for (let attempt = 0; !asyncWrites && attempt < 50; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(asyncWrites > 0, "The append must already be held before stop");
  await Promise.race([guard.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error("Guard.stop must not await diagnostic IO")), 250))]);
  store.codexManagerUsageSince = () => ({ calls: 999, estimated_cost_usd: 999 });
  const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "offline-trace", runtimeIdentity: { deployedCommit: "trace-only", runtimeSha256: "trace-only" }, now: () => at, invoke: async () => { throw new Error("LLM_MUST_NOT_RUN"); } });
  assert.equal((await manager.run("SCHEDULE_INTRADAY", secret)).status, "SKIPPED_BUDGET");
  assert.equal(syncWrites, 0, "Diagnostic disk latency must not block the Tier0 event loop");
  for (let attempt = 0; !asyncWrites && attempt < 50; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(asyncWrites > 0, "An unfinished async write must not prevent the business result above");
});
