import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CODEX_PRODUCTION_MANAGER_CONTRACT, codexManagerCommandReceipt, codexManagerOnlineStatus } from "../app/codex-production-manager.ts";
const baselineRoot = process.env.SQLITE_MAINTENANCE_BASELINE_ROOT;
const { openSnapshotDatabase } = await import(baselineRoot ? pathToFileURL(join(baselineRoot, "build/local-data-core.ts")) : new URL("../build/local-data-core.ts", import.meta.url));
const { candidateSupervision, createCodexProductionManager, scheduleLedgerSupervision } = await import(baselineRoot ? pathToFileURL(join(baselineRoot, "server/codex-production-manager.ts")) : new URL("../server/codex-production-manager.ts", import.meta.url));
import { ROBINHOOD_READONLY_TOOLS } from "../server/robinhood-mcp.ts";
import { runStartupRecovery } from "../server/startup-recovery.ts";
import { cleanEnvironment } from "../../tools/public-entry.mjs";
import { publicModelEnvironment } from "../server/public-runtime.ts";
import { collect as collectDistributableFiles } from "../../tools/release-package.mjs";

test("Manager incident count uses current lifecycle roots and preserves historical and informational rows", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-incident-count-")), store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const base = { run_id: null, suggestion: "test evidence", details: {} };
  const findings = [
    { ...base, fingerprint: "old-manager", layer: "MANAGER", code: "CODEX_MANAGER_REVIEW", severity: "WARNING", title: "Old review" },
    { ...base, fingerprint: "info", layer: "MAINTENANCE", code: "MAINTENANCE_RETENTION_CLEANUP", severity: "INFO", title: "Cleanup completed" },
    { ...base, fingerprint: "website", layer: "SERVICE", code: "WEBSITE_DOWN", severity: "CRITICAL", title: "Website unavailable", details: { root_cause_id: "one-website-root" } },
    { ...base, fingerprint: "same-website", layer: "SERVICE", code: "WEBSITE_UNREACHABLE", severity: "CRITICAL", title: "Same website root", details: { root_cause_id: "one-website-root" } },
    { ...base, fingerprint: "data", layer: "DATA", code: "TEST_DATA_FAILED", severity: "WARNING", title: "Data unavailable" },
  ];
  store.reconcileIncidents(findings, "test");
  assert.equal(store.getSelfCheck().active.length, 5);
  assert.equal(store.getCodexManagerState().active_incidents, 2);
  const snapshot = store.getActive();
  assert.equal(snapshot.codexManager.active_incidents, snapshot.currentTruth.issues.current_unresolved);
  store.reconcileIncidents([], "test");
  assert.equal(store.getCodexManagerState().active_incidents, 0);
  assert.equal(store.getSelfCheck().active[0].fingerprint, "old-manager", "historical record is not rewritten or deleted");
  assert.equal(store.getSelfCheck().recent.length, 5);
});

test("Manager daily and full snapshots keep complaint ledger counts separate from current incident roots", async (context) => {
  for (const trigger of ["SCHEDULE_INTRADAY", "SCHEDULE_WEEKLY_REVIEW"]) await context.test(trigger, async () => {
    const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-queue-")), store = openSnapshotDatabase(join(directory, "manager.sqlite"));
    for (const status of ["NEW", "INVESTIGATING", "PENDING_OWNER_APPROVAL", "SHADOW_FIXED", "CLOSED"]) {
      const item = store.createComplaint({ problem: status, category: "OTHER", severity: "LOW", page: "/", screenshot: null }, "test");
      store.recordComplaint(item.complaint_id, status, "隔离测试状态");
    }
    store.reconcileIncidents([{ fingerprint: "orphan-review", layer: "MANAGER", code: "CODEX_MANAGER_REVIEW", severity: "WARNING", title: "保留经理复核", run_id: null, suggestion: "原始记录保持", details: {} }], "test");
    const before = store.listComplaints();
    let snapshot;
    const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "test", runtimeSha256: "test" }, invoke: async ({ managerRunId, prompt }) => {
      snapshot = JSON.parse(prompt);
      return { threadId: "queue-test", agentVersion: "test", stderr: "", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }, decision: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "HEALTHY", manager_conclusion: "隔离口径检查完成", executive_summary: [], findings: [], recheck_requests: [], requested_actions: [], evidence_limits: [], next_manager_focus: "自然运行" } };
    } });
    try {
      assert.equal((await manager.run(trigger)).status, "SUCCEEDED");
      const full = trigger === "SCHEDULE_WEEKLY_REVIEW", truth = snapshot.tool_results.read_current_truth;
      const evidence = full ? snapshot.tool_results.read_incidents_and_complaints : snapshot.tool_results.read_current_incidents_and_open_complaints;
      assert.deepEqual([truth.issues.current_unresolved, truth.owner_queue.count_scope, truth.owner_queue.current_open_complaints, truth.owner_queue.historical_complaints, truth.owner_queue.pending_owner_approval], [0, "ALL_RECORDED_COMPLAINTS", 4, 6, 1]);
      assert.deepEqual(evidence.owner_queue, { open_complaints: 4, pending_approval: 1, total_complaints: 6, closed_complaints: 2 });
      assert.deepEqual([evidence.incident_scope, evidence.current_issue_authority, evidence.complaint_scope], ["RAW_INCIDENT_RECORDS_INCLUDING_HISTORICAL", "read_current_truth.issues.lifecycle", full ? "ALL_RECORDED_COMPLAINTS_RECENT_20" : "ALL_RECORDED_OPEN_COMPLAINTS"]);
      assert.equal((full ? evidence.active : evidence.incidents)[0].status, "ACTIVE");
      assert.equal(truth.issues.lifecycle[0].status, "HISTORICAL");
      assert.deepEqual(evidence.complaints.map(item => item.status).sort(), full ? ["CLOSED", "INVESTIGATING", "NEW", "NEW", "PENDING_OWNER_APPROVAL", "SHADOW_FIXED"] : ["INVESTIGATING", "NEW", "NEW", "PENDING_OWNER_APPROVAL"]);
      assert.deepEqual(store.listComplaints(), before, "Manager evidence projection must not rewrite the ledger or its history");
    } finally {
      await manager.stop(); store.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  });
});

test("Manager slow netstat yields to heartbeats and preserves failure evidence", async (context) => {
  for (const trigger of ["SCHEDULE_INTRADAY", "SCHEDULE_WEEKLY_REVIEW"]) for (const fail of [false, true]) await context.test(`${trigger}:${fail ? "failure" : "success"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-netstat-")), store = openSnapshotDatabase(join(directory, "manager.sqlite"));
    const originalExec = childProcess.execFile, originalSync = childProcess.execFileSync;
    let heartbeat = false, heartbeatAtCompletion = false, requests = 0, snapshot;
    const finding = { fingerprint: "NETSTAT_PENDING_INCIDENT", layer: "RUNTIME", code: "NETSTAT_PENDING_INCIDENT", severity: "CRITICAL", title: "进程检查期间新发现", run_id: null, suggestion: "读取最新故障", details: { evidence_scope: "CURRENT_SLOT" } };
    const script = `setTimeout(() => { ${fail ? "process.stderr.write('CANARY_NETSTAT_FAILED'); process.exitCode = 1;" : "process.stdout.write('  TCP  0.0.0.0:4070  0.0.0.0:0  LISTENING  12345\\n');"} }, 50);`;
    const requested = (file, args, options) => {
      assert.equal(file, "netstat.exe"); assert.deepEqual(args, ["-ano", "-p", "tcp"]);
      assert.deepEqual(options, { encoding: "utf8", windowsHide: true, timeout: 10_000 }); requests++;
      setImmediate(() => { store.reconcileIncidents([finding], "test"); heartbeat = true; });
    };
    childProcess.execFile = (file, args, options, callback) => {
      requested(file, args, options);
      return originalExec(process.execPath, ["-e", script], options, (error, stdout, stderr) => { heartbeatAtCompletion = heartbeat; callback(error, stdout, stderr); });
    };
    childProcess.execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => childProcess.execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
    childProcess.execFileSync = (file, args, options) => {
      requested(file, args, options);
      try { return originalSync(process.execPath, ["-e", script], options); } finally { heartbeatAtCompletion = heartbeat; }
    };
    syncBuiltinESMExports();
    const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "test", runtimeSha256: "test" }, invoke: async ({ managerRunId, prompt }) => {
      snapshot = JSON.parse(prompt);
      return { threadId: "netstat-test", agentVersion: "test", stderr: "", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }, decision: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "HEALTHY", manager_conclusion: "确定性检查完成", executive_summary: [], findings: [], recheck_requests: [], requested_actions: [], evidence_limits: [], next_manager_focus: "自然运行" } };
    } });
    try {
      assert.equal((await manager.run(trigger)).status, "SUCCEEDED");
      assert.equal(requests, 1);
      const full = trigger === "SCHEDULE_WEEKLY_REVIEW", single = full ? snapshot.tool_results.verify_single_instance : snapshot.tool_results.read_runtime_anomalies.single_instance;
      assert.deepEqual([single.listener_count, single.pids, single.status], fail ? [null, [], "NOT_OBSERVED"] : [1, ["12345"], "PASS"]);
      if (fail) assert.match(single.error, /CANARY_NETSTAT_FAILED/);
      assert.equal(heartbeatAtCompletion, true, "A queued heartbeat must run while the real child process is pending, before its completion");
      const incidents = full ? snapshot.tool_results.read_incidents_and_complaints.active : snapshot.tool_results.read_current_incidents_and_open_complaints.incidents;
      assert.ok(incidents.some((item) => item.fingerprint === finding.fingerprint), "Read current state after asynchronous netstat, not before it");
    } finally {
      await manager.stop(); await new Promise((resolve) => setImmediate(resolve));
      childProcess.execFile = originalExec; childProcess.execFileSync = originalSync; syncBuiltinESMExports();
      store.close(); await rm(directory, { recursive: true, force: true });
    }
  });
});

test("Manager database evidence yields before model invocation and preserves daily and full evidence", async (context) => {
  for (const trigger of ["SCHEDULE_INTRADAY", "SCHEDULE_WEEKLY_REVIEW"]) await context.test(trigger, async () => {
    const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-async-evidence-"));
    const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
    const previousRole = process.env.TRADING_OS_RUNTIME_ROLE;
    process.env.TRADING_OS_RUNTIME_ROLE = "TIER0";
    let timerFired = false, timerAt = null, calls = 0, snapshot;
    const pendingFinding = { fingerprint: "MANAGER_PENDING_SQLITE_STATE_CHANGE", layer: "RUNTIME", code: "PENDING_SQLITE_STATE_CHANGE", severity: "CRITICAL", title: "隔离检查期间新发现", run_id: "isolated:pending-sqlite", suggestion: "读取检查后的当前状态", details: { evidence_scope: "CURRENT_SLOT" } };
    const timer = setTimeout(() => { store.reconcileIncidents([pendingFinding], "test"); timerFired = true; timerAt = Date.now(); }, 0);
    const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "test", runtimeSha256: "test" }, invoke: async ({ managerRunId, prompt }) => {
      calls++;
      assert.equal(timerFired, true, "SQLite gathering must yield the main thread before the model starts");
      snapshot = JSON.parse(prompt);
      return { threadId: "isolated-async-evidence", agentVersion: "test", stderr: "", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 }, decision: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "HEALTHY", manager_conclusion: "确定性检查完成", executive_summary: [], findings: [], recheck_requests: [], requested_actions: [], evidence_limits: [], next_manager_focus: "自然运行" } };
    } });
    try {
      const pending = manager.run(trigger);
      assert.equal(calls, 0, "Manager must return control while SQLite evidence is pending");
      assert.equal((await pending).status, "SUCCEEDED");
      assert.equal(calls, 1);
      const full = trigger === "SCHEDULE_WEEKLY_REVIEW";
      const db = full ? snapshot.tool_results.verify_database_integrity : snapshot.tool_results.read_runtime_anomalies.database;
      assert.deepEqual([db.quick_check, db.integrity_check], ["ok", "ok"]);
      const backup = full ? snapshot.tool_results.read_database_and_backup_status.latest_backup : db.latest_backup;
      assert.equal(backup, null);
      const incidents = full ? snapshot.tool_results.read_incidents_and_complaints.active : snapshot.tool_results.read_current_incidents_and_open_complaints.incidents;
      assert.ok(incidents.some((item) => item.fingerprint === pendingFinding.fingerprint), "Frozen Manager snapshot must include real incidents recorded while SQLite maintenance was pending");
      if (full) {
        assert.equal(Object.keys(snapshot.tool_results.read_database_and_backup_status.counts).length, 16);
        assert.equal(snapshot.tool_results.read_database_and_backup_status.counts.output_records, 0);
      }
      assert.equal(store.getActive().outputCount, 0);
      let rows = [];
      for (let attempt = 0; attempt < 100 && !rows.some((row) => row.phase === "snapshot.record" && row.boundary === "END"); attempt++) {
        try { rows = (await readFile(join(directory, "logs", `codex-manager-timing-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line)); } catch { /* Best-effort timing sink flushes asynchronously. */ }
        if (!rows.some((row) => row.phase === "snapshot.record" && row.boundary === "END")) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      for (const phase of ["databaseEvidence", full ? "tools.full" : "tools.daily"]) {
        const pair = rows.filter((row) => row.phase === phase);
        assert.deepEqual(pair.map((row) => row.boundary), ["BEGIN", "END"]);
        assert.ok(Date.parse(pair[1].wall_at) >= timerAt, `${phase} END must describe Promise completion, not dispatch`);
      }
    } finally {
      clearTimeout(timer); await manager.stop(); store.close();
      if (previousRole === undefined) delete process.env.TRADING_OS_RUNTIME_ROLE; else process.env.TRADING_OS_RUNTIME_ROLE = previousRole;
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  });
});

function startupStore() {
  const events = [];
  return {
    events,
    getLatestCodexManagerEvent: (type) => events.findLast((item) => item.event_type === type)?.payload ?? null,
    recordCodexManagerEvent: (event) => { if (!events.some((item) => item.event_id === event.event_id)) events.push(event); },
  };
}

function startupRun(status, completedAt, error = null) {
  return { manager_run_id: `manager-${completedAt}`, trigger: "STARTUP_RECOVERY", requested_at: completedAt, completed_at: completedAt, status, snapshot_id: null, snapshot_sha256: null, model: "test", agent_version: "test", thread_id: null, duration_ms: 1, usage: null, decision: null, error, tools: [], snapshot_level: "DAILY_DELTA", input_bytes: 0, checkpoint_id: null };
}

test("candidate supervision starts with the current trading day's first official intraday slot", () => {
  const official = { evidence_snapshot: { run_id: "official-prior-day" }, symbol_outlooks: { SPY: { direction: "RANGE" }, QQQ: { direction: "RANGE" } } };
  const state = { scheduler: { today: { date: "2026-08-26" } }, outputs: { TS_SIGNAL_CANDIDATE: [], TS_SIGNAL_CANDIDATE_SETTLEMENT: [], TS_SHADOW_OUTPUT: [official] }, tsSettlement: { recent: [{ market_date: "2026-08-25", eligibility: "OFFICIAL_LIVE", report_type: "INTRADAY_30_60M", forecast_run_id: "official-prior-day" }] } };
  assert.deepEqual(candidateSupervision(state, "2026-08-26T07:30:00.000Z").findings, []);
  state.tsSettlement.recent[0].market_date = "2026-08-26";
  assert.deepEqual(candidateSupervision(state, "2026-08-26T13:31:30.000Z").findings, ["LATEST_INTRADAY_CANDIDATE_MISSING"]);
});

test("candidate supervision tracks 30M and 60M settlement deadlines independently", () => {
  const official = { evidence_snapshot: { run_id: "official-current" }, symbol_outlooks: { SPY: { direction: "RANGE" }, QQQ: { direction: "RANGE" } } };
  const candidate = { candidate_forecast_id: "ts-candidate-aaaaaaaaaaaaaaaaaaaaaaaa", official_forecast_run_id: "official-current", contracts: ["SPY", "QQQ"].flatMap((symbol) => ["30M", "60M"].map((horizon) => ({ contract_id: `${symbol}-${horizon}`, symbol, horizon, expires_at: horizon === "30M" ? "2026-08-26T14:00:00.000Z" : "2026-08-26T14:30:00.000Z", data_freshness: { status: "LIVE" }, forecast_layer: { direction: "RANGE" } }))) };
  const state = { scheduler: { today: { date: "2026-08-26" } }, outputs: { TS_SIGNAL_CANDIDATE: [candidate], TS_SIGNAL_CANDIDATE_SETTLEMENT: [], TS_SHADOW_OUTPUT: [official] }, tsSettlement: { recent: [{ market_date: "2026-08-26", eligibility: "OFFICIAL_LIVE", report_type: "INTRADAY_30_60M", forecast_run_id: "official-current" }] } };
  assert.deepEqual(candidateSupervision(state, "2026-08-26T14:00:00.000Z").overdue_settlements, [`${candidate.candidate_forecast_id}:30M`]);
  state.outputs.TS_SIGNAL_CANDIDATE_SETTLEMENT.push({ contract_version: "TS_SIGNAL_CANDIDATE_SETTLEMENT_V2", candidate_forecast_id: candidate.candidate_forecast_id, horizon: "30M" });
  assert.deepEqual(candidateSupervision(state, "2026-08-26T14:00:00.000Z").overdue_settlements, []);
  assert.deepEqual(candidateSupervision(state, "2026-08-26T14:30:00.000Z").overdue_settlements, [`${candidate.candidate_forecast_id}:60M`]);
});

test("deterministic manager supervises due formal slots from the schedule ledger before a Forecast exists", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-schedule-ledger-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "schedule.sqlite"));
  const getActive = store.getActive; store.getActive = () => { const state = getActive(); return { ...state, currentTruth: null, scheduler: { ...state.scheduler, today: { ...state.scheduler.today, date: "2026-08-26" } } }; };
  const missing = scheduleLedgerSupervision(store, "2026-08-26T13:32:00.000Z").slots.find((item) => item.slot_id === "live-shadow:20260826T133000Z");
  assert.ok(missing); assert.deepEqual(missing.issues, ["OWNERSHIP_MISSING", "FORECAST_MISSING"]);
  store.claimTsCoreSlot(missing.slot_id, missing.run_id, "manager-test", "2026-08-26T13:31:31.000Z");
  store.completeTsCoreSlot(missing.slot_id, "manager-test", "SYSTEM_BLOCKED", null, null, "2026-08-26T13:31:32.000Z");
  const blocked = scheduleLedgerSupervision(store, "2026-08-26T13:32:00.000Z").slots.find((item) => item.slot_id === missing.slot_id);
  assert.deepEqual(blocked.issues, ["OWNERSHIP_LATE", "SYSTEM_BLOCKED", "FORECAST_MISSING"]);
  store.close();
});

test("schedule supervision links slot output identity to the frozen forecast_id", () => {
  const slotId = "live-shadow:20260826T133000Z", forecastId = "20260826T133000Z-aaaaaaaaaa", candidateId = "ts-candidate-aaaaaaaaaaaaaaaaaaaaaaaa";
  const contracts = ["SPY", "QQQ"].flatMap((symbol) => ["30M", "60M"].map((horizon) => ({ symbol, horizon, expires_at: "2026-08-26T15:00:00.000Z" })));
  const store = {
    getActive: () => ({ scheduler: { today: { date: "2026-08-26" } }, outputs: { TS_SHADOW_OUTPUT: [{ evidence_snapshot: { run_id: forecastId } }], TS_SIGNAL_CANDIDATE: [{ source_run_id: slotId, official_forecast_run_id: forecastId, candidate_forecast_id: candidateId, contracts }], TS_SIGNAL_CANDIDATE_SETTLEMENT: [] } }),
    getTsCoreSlotOwnership: (id) => id === slotId ? { status: "TERMINAL", lease_acquired_at: "2026-08-26T13:30:30.000Z", terminal_outcome: "NO_TRADE", forecast_id: forecastId } : null,
    getRunsForSlot: (id) => id === slotId ? [{ agent_id: "TS", website_delivery: "DELIVERED" }] : [],
    hasOutput: (id) => id === `${slotId}:TS`,
  };
  const slot = scheduleLedgerSupervision(store, "2026-08-26T13:32:00.000Z").slots.find((item) => item.slot_id === slotId);
  assert.deepEqual([slot.forecast_id, slot.forecast_exists, slot.issues], [forecastId, true, []]);
});

test("overnight schedule supervision moves the prior trading day out of current incidents", () => {
  const store = { getActive: () => ({ currentTruth: { trading_date: "2026-08-27" }, scheduler: { today: { date: "2026-08-26" } }, outputs: { TS_SHADOW_OUTPUT: [], TS_SIGNAL_CANDIDATE: [], TS_SIGNAL_CANDIDATE_SETTLEMENT: [] } }), getTsCoreSlotOwnership: () => null, getRunsForSlot: () => [], hasOutput: () => false };
  assert.deepEqual(scheduleLedgerSupervision(store, "2026-08-27T06:32:00.000Z").slots, []);
});

test("cold startup recovery is idempotent, bounded and isolated from service restarts", async () => {
  const store = startupStore(), boot = "2026-08-23T20:00:00.000Z";
  let calls = 0;
  const ready = await runStartupRecovery({ store, windowsBootAt: boot, supervisorStartedAt: "2026-08-23T20:00:05.000Z", serviceReadyAt: "2026-08-23T20:00:20.000Z", startReason: "WINDOWS_STARTUP", now: () => new Date("2026-08-23T20:00:30.000Z"), runManager: async () => { calls += 1; return startupRun("SUCCEEDED", "2026-08-23T20:00:40.000Z"); } });
  assert.deepEqual([ready.status, ready.target_met, ready.service_recovery_ms, ready.manager_recovery_ms, calls], ["READY", true, 20_000, 40_000, 1]);
  const duplicate = await runStartupRecovery({ store, windowsBootAt: boot, supervisorStartedAt: boot, serviceReadyAt: boot, startReason: "WINDOWS_STARTUP", runManager: async () => { calls += 1; return startupRun("SUCCEEDED", boot); } });
  assert.equal(duplicate.boot_id, ready.boot_id); assert.equal(calls, 1);
  const service = await runStartupRecovery({ store: startupStore(), windowsBootAt: boot, supervisorStartedAt: boot, serviceReadyAt: boot, startReason: "SERVICE_RESTART", runManager: async () => { throw new Error("must not run"); } });
  assert.deepEqual([service.status, service.codex_manager_status, service.target_met], ["READY", "NOT_REQUIRED", null]);

  const offlineStore = startupStore(); calls = 0; let recoveryClock = Date.parse("2026-08-23T20:00:30.000Z");
  const offline = await runStartupRecovery({ store: offlineStore, windowsBootAt: boot, supervisorStartedAt: boot, serviceReadyAt: boot, startReason: "WINDOWS_STARTUP", retryDelaysMs: [0, 0], wait: async (delay) => { recoveryClock += delay; }, now: () => new Date(recoveryClock), runManager: async () => { calls += 1; recoveryClock += 1_000; return startupRun("FAILED", new Date(recoveryClock).toISOString(), "Codex offline"); } });
  assert.deepEqual([offline.status, offline.codex_manager_status, offline.retry_count, offline.target_met, offline.owner_required, calls], ["OFFLINE_DEGRADED", "OFFLINE", 3, false, false, 3]);
  assert.equal(offlineStore.events.filter((item) => item.event_type === "STARTUP_RECOVERY_STATE").length, 4);

  const resumedStore = startupStore(); calls = 0;
  await assert.rejects(runStartupRecovery({ store: resumedStore, windowsBootAt: boot, supervisorStartedAt: boot, serviceReadyAt: boot, startReason: "WINDOWS_STARTUP", retryDelaysMs: [1], now: () => new Date("2026-08-23T20:00:30.000Z"), wait: async () => { throw new Error("simulated service restart"); }, runManager: async () => { calls += 1; return startupRun("FAILED", boot, "offline"); } }), /simulated service restart/);
  const resumed = await runStartupRecovery({ store: resumedStore, windowsBootAt: boot, supervisorStartedAt: boot, serviceReadyAt: boot, startReason: "SERVICE_RESTART", retryDelaysMs: [1], now: () => new Date("2026-08-23T20:00:40.000Z"), runManager: async () => { calls += 1; return startupRun("SUCCEEDED", "2026-08-23T20:00:40.000Z"); } });
  assert.deepEqual([resumed.status, resumed.start_reason, resumed.retry_count, calls], ["READY", "WINDOWS_STARTUP", 2, 2]);

  const completedStore = startupStore(), completed = startupRun("SUCCEEDED", "2026-08-23T20:00:40.000Z");
  completedStore.recordCodexManagerEvent({ event_id: "manager-completed:run", manager_run_id: completed.manager_run_id, event_type: "RUN_COMPLETED", recorded_at: completed.completed_at, payload: { run_summary: completed } });
  const recovered = await runStartupRecovery({ store: completedStore, windowsBootAt: boot, supervisorStartedAt: boot, serviceReadyAt: boot, startReason: "WINDOWS_STARTUP", runManager: async () => { throw new Error("completed model call must not repeat"); } });
  assert.deepEqual([recovered.status, recovered.manager_run_id], ["READY", completed.manager_run_id]);

  const deadline = await runStartupRecovery({ store: startupStore(), windowsBootAt: boot, supervisorStartedAt: boot, serviceReadyAt: "2026-08-23T20:05:01.000Z", startReason: "WINDOWS_STARTUP", now: () => new Date("2026-08-23T20:05:01.000Z"), runManager: async () => { throw new Error("deadline must not call model"); } });
  assert.deepEqual([deadline.status, deadline.target_met, deadline.retry_count], ["OFFLINE_DEGRADED", false, 0]);
  const blocked = await runStartupRecovery({ store: startupStore(), windowsBootAt: boot, supervisorStartedAt: boot, serviceReadyAt: boot, startReason: "WINDOWS_STARTUP", databaseStatus: "BLOCKED", runManager: async () => { throw new Error("blocked core must not call model"); } });
  assert.deepEqual([blocked.status, blocked.database_status, blocked.owner_required], ["BLOCKED", "BLOCKED", true]);
});

test("cold startup resumes after a service restart against the real append-only SQLite ledger", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-startup-resume-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "startup.sqlite")), boot = "2026-08-23T20:00:00.000Z";
  await assert.rejects(runStartupRecovery({ store, windowsBootAt: boot, supervisorStartedAt: boot, serviceReadyAt: boot, startReason: "WINDOWS_STARTUP", retryDelaysMs: [1], now: () => new Date("2026-08-23T20:00:30.000Z"), wait: async () => { throw new Error("service restarted"); }, runManager: async () => startupRun("FAILED", "2026-08-23T20:00:10.000Z", "offline") }), /service restarted/);
  const resumed = await runStartupRecovery({ store, windowsBootAt: boot, supervisorStartedAt: "2026-08-23T20:00:20.000Z", serviceReadyAt: "2026-08-23T20:00:25.000Z", startReason: "SERVICE_RESTART", retryDelaysMs: [1], now: () => new Date("2026-08-23T20:00:30.000Z"), runManager: async () => startupRun("SUCCEEDED", "2026-08-23T20:00:40.000Z") });
  assert.deepEqual([resumed.status, resumed.start_reason, resumed.retry_count], ["READY", "WINDOWS_STARTUP", 2]);
  assert.equal(store.getCodexManagerEventPayloads("STARTUP_RECOVERY_STATE", "startup_recovery").filter((item) => item.status === "RECOVERING").length, 1);
  store.close();
});

test("real manager contract freezes one snapshot, resumes, audits tools and never touches business ledgers", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-real-manager-")), file = join(directory, "manager.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(file), before = store.getActive();
  await mkdir(join(directory, "backups"));
  await writeFile(join(directory, "backups", "pre-manager.sqlite"), "backup");
  let clock = Date.parse("2026-08-24T13:00:00.000Z"), resumes = [], prompts = [];
  const invoke = async ({ managerRunId, resumeThreadId, prompt }) => {
    resumes.push(resumeThreadId);
    prompts.push(JSON.parse(prompt));
    clock += 1_234;
    return {
      threadId: "real-thread-1", agentVersion: "codex-cli 0.147.0", stderr: "",
      usage: { input_tokens: 2_000, cached_input_tokens: 500, output_tokens: 200, reasoning_output_tokens: 100 },
      decision: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "DEGRADED", manager_conclusion: "确定性系统可继续；存在一项数据不足。", executive_summary: ["快照完整"], findings: [{ code: "TS_SAMPLE_GAP", classification: "DATA_INSUFFICIENT", priority: "RESEARCH", title: "可信TS样本不足", evidence_refs: ["read_ts_evidence_readiness"], evidence: "当前v2结算样本不足", impact: "不能评价当前TS", recommendation: "继续自然积累", codex_can_complete: false, shadow_or_forward_required: true, owner_required: false }], recheck_requests: [{ department: "TS", reason: "继续自然积累" }], requested_actions: [{ action: "REQUEST_DEPARTMENT_RECHECK", target: "TS", reason: "继续自然积累", evidence_refs: ["read_ts_evidence_readiness"] }], evidence_limits: ["未运行外部写操作"], next_manager_focus: "下一自然槽身份" },
    };
  };
  let rechecks = 0;
  const options = { store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, now: () => new Date(clock), invoke, requestDepartmentRecheck: async () => { rechecks += 1; return { status: "QUEUED_FOR_NEXT_NATURAL_SLOT" }; } };
  const manager = createCodexProductionManager(options), first = await manager.run("OWNER_MANUAL", "test audit");
  assert.equal(first.status, "SUCCEEDED");
  assert.equal(first.agent_version, "codex-cli 0.147.0");
  assert.equal(first.decision.findings[0].classification, "DATA_INSUFFICIENT");
  assert.ok(first.tools.includes("read_runtime_anomalies"));
  assert.ok(first.tools.includes("read_external_expert_observer"));
  assert.equal(first.snapshot_level, "DAILY_DELTA");
  assert.ok(first.input_bytes < 30_000);
  store.reconcileIncidents([], "test");
  assert.deepEqual([manager.state.online_status, manager.state.mode, manager.state.broker_write_tools, manager.state.broker_write_calls, manager.state.automated_execution], ["ONLINE", "NON_TRADING_PRODUCTION_MANAGER_ACTIVE", 0, 0, false]);
  assert.equal(manager.state.recent_operations[0].action, "REQUEST_DEPARTMENT_RECHECK");
  const firstOperationId = manager.state.recent_operations[0].operation_id;
  assert.deepEqual(manager.state.ts_readiness.error_labels, { correct_wait: null, wrong_wait: null, false_activation: null, stale_direction: null });
  assert.deepEqual(resumes, [null]);
  assert.deepEqual([store.getActive().outputCount, store.getActive().runLedger.eventCount], [before.outputCount, before.runLedger.eventCount]);
  assert.equal(rechecks, 1);

  clock += 10 * 60_000;
  const restarted = createCodexProductionManager(options), second = await restarted.run("SCHEDULE_PREMARKET");
  assert.equal(second.status, "SUCCEEDED");
  assert.deepEqual(resumes, [null, "real-thread-1"]);
  clock += 10 * 60_000;
  const weekly = await restarted.run("SCHEDULE_WEEKLY_REVIEW");
  assert.equal(weekly.snapshot_level, "FULL_AUDIT");
  assert.ok(weekly.input_bytes > first.input_bytes);
  assert.equal(rechecks, 3);
  const duplicate = await restarted.executeAction({ manager_run_id: first.manager_run_id, action: "REQUEST_DEPARTMENT_RECHECK", target: "TS", reason: "继续自然积累", evidence_refs: ["read_ts_evidence_readiness"] });
  assert.equal(duplicate.operation_id, firstOperationId);
  await assert.rejects(() => restarted.executeAction({ manager_run_id: first.manager_run_id, action: "RUN_READONLY_DATA_PROBE", target: "place_order", reason: "禁止", evidence_refs: ["test"] }), /FINNHUB或ROBINHOOD/);
  assert.throws(() => restarted.recordPrivilegedOperation({ operation_id: "deploy:test", idempotency_key: "test", action: "DEPLOY_4070", risk: "RELEASE", status: "SUCCEEDED", actor: "CODEX", target: "4070", summary: "test", incident_id: null, started_at: new Date(clock).toISOString(), completed_at: new Date(clock).toISOString(), commit: "a".repeat(40), pr: 1, rollback_ref: null, evidence_refs: ["candidate:" + "a".repeat(40)] }), /确定性闸门/);
  store.close();

  const audit = new DatabaseSync(file);
  assert.ok(audit.prepare("SELECT COUNT(*) n FROM codex_manager_events").get().n >= 20);
  assert.equal(audit.prepare("SELECT COUNT(*) n FROM output_records").get().n, before.outputCount);
  assert.equal(audit.prepare("SELECT COUNT(*) n FROM agent_run_events").get().n, before.runLedger.eventCount);
  assert.throws(() => audit.prepare("UPDATE codex_manager_events SET event_type='ALTERED'").run(), /append-only/);
  assert.throws(() => audit.prepare("DELETE FROM codex_manager_events").run(), /append-only/);
  audit.close();
});

test("manager failure is isolated and Robinhood has no write-capable tool", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-offline-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, invoke: async () => { throw new Error("Codex offline"); } });
  assert.equal((await manager.run("OWNER_MANUAL")).status, "FAILED");
  assert.equal(manager.state.online_status, "OFFLINE");
  assert.ok(ROBINHOOD_READONLY_TOOLS.every((tool) => tool.startsWith("get_")));
  assert.equal(JSON.stringify(ROBINHOOD_READONLY_TOOLS).match(/place|submit|cancel|replace|exercise/gi), null);
  const distributableFiles = await collectDistributableFiles();
  for (const name of ["record-codex-manager-action.ts", "run-codex-manager.ts"]) assert.equal(distributableFiles.includes(`web/scripts/${name}`), false);
  const environment = cleanEnvironment({ CODEX_HOME: "unrelated-model-profile", TRADING_OS_PUBLIC_AUTOMATION: "1", OPENAI_API_KEY: "synthetic-not-a-key" });
  assert.equal(environment.TRADING_OS_PUBLIC_AUTOMATION, "0");
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.notEqual(environment.CODEX_HOME, "unrelated-model-profile");
  const previous = process.env.TRADING_OS_PUBLIC_AUTOMATION;
  delete process.env.TRADING_OS_PUBLIC_AUTOMATION;
  try { assert.throws(() => publicModelEnvironment(process.cwd()), /PUBLIC_AUTOMATION_DISABLED/); }
  finally { if (previous !== undefined) process.env.TRADING_OS_PUBLIC_AUTOMATION = previous; }
  const server = await readFile(new URL("../server/local-owner-server.ts", import.meta.url), "utf8");
  assert.match(server, /projectRoot, host: "127\.0\.0\.1", port: OWNER_PORT, runtimeRole: "COMBINED", codexManager: false/);
  store.close();
});

test("budget exhaustion still completes deterministic checks and exposes a five-state command receipt", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-budget-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  store.codexManagerUsageSince = () => ({ calls: 999, estimated_cost_usd: 999 });
  store.reconcileIncidents([], "test");
  const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, invoke: async () => { throw new Error("model must not run after budget exhaustion"); } });
  const run = await manager.run("OWNER_MANUAL");
  assert.equal(run.status, "SKIPPED_BUDGET");
  assert.ok(run.snapshot_id);
  assert.ok(run.tools.includes("read_current_truth"));
  assert.match(run.error, /解释层不可用.*确定性经理检查、自动恢复与Incident继续运行/);
  assert.equal(store.getCodexManagerState().online_status, "ONLINE");
  assert.deepEqual(codexManagerCommandReceipt(run).status, "SUCCEEDED");
  store.close();
});

test("manager availability follows fresh deterministic guard evidence, not explanation or action outcomes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-guard-status-"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const at = Date.parse("2026-09-05T22:00:00.000Z");
  context.mock.timers.enable({ apis: ["Date"], now: at });
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  assert.equal(store.getCodexManagerState().online_status, "NOT_RUN");
  await store.checkDatabase();
  assert.equal(store.getCodexManagerState().online_status, "NOT_RUN", "a SQLite ping alone does not prove the full deterministic guard ran");
  const succeeded = startupRun("SUCCEEDED", new Date(at).toISOString());
  store.recordCodexManagerEvent({ event_id: "synthetic-success", manager_run_id: succeeded.manager_run_id, event_type: "RUN_COMPLETED", recorded_at: succeeded.completed_at, payload: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, run_summary: succeeded } });
  assert.equal(store.getCodexManagerState().online_status, "OFFLINE", "model success cannot substitute for missing deterministic evidence");
  store.reconcileIncidents([], "test");
  assert.equal(store.getCodexManagerState().online_status, "ONLINE");
  const checkedAt = store.getSelfCheck().checked_at;
  const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, invoke: async ({ managerRunId }) => ({
    threadId: "synthetic-manager", agentVersion: "test", stderr: "", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    decision: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "HEALTHY", manager_conclusion: "测试解释", executive_summary: [], findings: [], recheck_requests: [], requested_actions: [{ action: "RUN_READONLY_DATA_PROBE", target: "place_order", reason: "测试权限边界", evidence_refs: ["synthetic"] }], evidence_limits: [], next_manager_focus: "自然检查" },
  }) });
  const rejected = await manager.run("OWNER_MANUAL");
  assert.equal(rejected.status, "SUCCEEDED");
  assert.match(rejected.error, /1项动作.*拒绝/);
  assert.equal(manager.state.recent_operations[0].status, "GATE_BLOCKED");
  assert.match(manager.state.recent_operations[0].summary, /FINNHUB或ROBINHOOD/);
  assert.equal(manager.state.online_status, "ONLINE", "a rejected model action does not stop the deterministic guard");
  assert.equal(manager.state.deterministic_checked_at, checkedAt);
  store.codexManagerUsageSince = () => ({ calls: 999, estimated_cost_usd: 999 });
  assert.equal((await manager.run("SCHEDULE_INTRADAY")).status, "SKIPPED_BUDGET");
  assert.equal(manager.state.online_status, "ONLINE");
  const cached = manager.state;
  context.mock.timers.setTime(at + 180_000);
  assert.equal(manager.state.online_status, "ONLINE");
  context.mock.timers.setTime(at + 180_001);
  assert.equal(manager.state.online_status, "OFFLINE", "a budget-skipped model run cannot renew stale guard evidence");
  assert.equal(codexManagerOnlineStatus(cached.deterministic_checked_at, Boolean(cached.latest_run)), "OFFLINE", "the page rechecks cached ONLINE at its current render time");
  assert.equal(codexManagerOnlineStatus("invalid", true), "OFFLINE");
  assert.deepEqual(manager.state.recent_runs, cached.recent_runs, "availability never rewrites model history");
  await store.checkDatabase();
  assert.equal(manager.state.online_status, "OFFLINE");
  store.reconcileIncidents([], "test", new Date(at + 181_000).toISOString());
  assert.equal(manager.state.online_status, "OFFLINE", "future guard evidence is not fresh");
  store.reconcileIncidents([], "test");
  assert.equal(manager.state.online_status, "ONLINE");
  assert.deepEqual([manager.state.broker_write_tools, manager.state.broker_write_calls, manager.state.automated_execution], [0, 0, false]);
});

test("manual manager command returns a durable queued identity and deduplicates clicks", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-command-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, invoke: async () => { throw new Error("Codex offline"); } });
  const first = manager.queue("OWNER_MANUAL"), duplicate = manager.queue("OWNER_MANUAL");
  assert.deepEqual([first.status, first.manager_run_id, duplicate.manager_run_id, manager.state.latest_run.status], ["QUEUED", duplicate.manager_run_id, first.manager_run_id, "QUEUED"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await manager.stop();
  assert.deepEqual([manager.state.latest_run.manager_run_id, manager.state.latest_run.status], [first.manager_run_id, "FAILED"]);
  assert.match(manager.state.latest_run.error, /Codex offline/);
  store.close();
});

test("a queued manager command is resumed after a process restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-queue-resume-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite")), common = { store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) } };
  const firstManager = createCodexProductionManager({ ...common, invoke: async () => { throw new Error("must not start before shutdown"); } });
  const queued = firstManager.queue("OWNER_MANUAL", "original owner context", false);
  await firstManager.stop();
  assert.equal(store.getCodexManagerState().latest_run.status, "QUEUED");
  const persisted = store.getLatestCodexManagerEvent("RUN_QUEUED");
  assert.deepEqual([persisted.command_id, persisted.owner_context, persisted.resume], [queued.manager_run_id, "original owner context", false]);
  let resumedPrompt;
  const resumed = createCodexProductionManager({ ...common, invoke: async ({ prompt }) => { resumedPrompt = JSON.parse(prompt); throw new Error("resumed offline"); } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await resumed.stop();
  assert.deepEqual([resumed.state.latest_run.manager_run_id, resumed.state.latest_run.status], [queued.manager_run_id, "FAILED"]);
  assert.match(resumed.state.latest_run.error, /resumed offline/);
  assert.equal(resumedPrompt.tool_results.read_runtime_anomalies.owner_context, "original owner context");
  store.close();
});

test("a queued manager command resumes the preceding successful thread", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-thread-resume-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite")), common = { store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) } };
  const decision = (managerRunId) => ({ contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "HEALTHY", manager_conclusion: "完成", executive_summary: [], findings: [], recheck_requests: [], requested_actions: [], evidence_limits: [], next_manager_focus: "自然运行" });
  const first = createCodexProductionManager({ ...common, invoke: async ({ managerRunId }) => ({ threadId: "prior-thread", agentVersion: "codex-cli test", stderr: "", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 }, decision: decision(managerRunId) }) });
  await first.run("SCHEDULE_PREMARKET");
  const queued = first.queue("OWNER_MANUAL", "resume this", true);
  await first.stop();
  let resumeThreadId = null;
  const resumed = createCodexProductionManager({ ...common, invoke: async ({ managerRunId, resumeThreadId: value }) => { resumeThreadId = value; return { threadId: "resumed-thread", agentVersion: "codex-cli test", stderr: "", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 }, decision: decision(managerRunId) }; } });
  await resumed.stop();
  assert.deepEqual([resumed.state.latest_run.manager_run_id, resumed.state.latest_run.status, resumeThreadId], [queued.manager_run_id, "SUCCEEDED", "prior-thread"]);
  store.close();
});

test("manager shutdown waits for its active audit", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-shutdown-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  let releaseInvoke;
  const invokeReleased = new Promise((resolve) => { releaseInvoke = resolve; });
  let markStarted;
  const invokeStarted = new Promise((resolve) => { markStarted = resolve; });
  const manager = createCodexProductionManager({
    store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test",
    runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) },
    invoke: async ({ managerRunId }) => {
      markStarted();
      await invokeReleased;
      return { threadId: "shutdown-test", agentVersion: "codex-cli test", stderr: "", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 }, decision: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "HEALTHY", manager_conclusion: "完成", executive_summary: [], findings: [], recheck_requests: [], requested_actions: [], evidence_limits: [], next_manager_focus: "自然运行" } };
    },
  });
  const run = manager.run("OWNER_MANUAL");
  await invokeStarted;
  let stopped = false;
  const stopping = manager.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseInvoke();
  assert.equal((await run).status, "SUCCEEDED");
  await stopping;
  assert.equal(stopped, true);
  store.close();

  const failedStore = openSnapshotDatabase(join(directory, "failed-manager.sqlite"));
  failedStore.codexManagerUsageSince = () => { throw new Error("startup read failed"); };
  const failedManager = createCodexProductionManager({ store: failedStore, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) } });
  const failedRun = failedManager.run("OWNER_MANUAL");
  await failedManager.stop();
  await assert.rejects(failedRun, /startup read failed/);
  failedStore.close();
});

test("a RUNNING manager command is resumed automatically after a process restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-stale-running-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite")), requestedAt = "2026-08-24T13:00:00.000Z";
  const stale = { ...startupRun("FAILED", requestedAt), manager_run_id: "codex-manager:stale-running", requested_at: requestedAt, completed_at: null, status: "RUNNING" };
  store.recordCodexManagerEvent({ event_id: "codex-manager:stale-running:requested", manager_run_id: stale.manager_run_id, event_type: "RUN_REQUESTED", recorded_at: requestedAt, payload: { run_summary: stale } });
  let calls = 0;
  const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, now: () => new Date("2026-08-24T13:01:00.000Z"), invoke: async ({ managerRunId }) => { calls += 1; return { threadId: "startup-retry", agentVersion: "codex-cli test", stderr: "", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 }, decision: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "HEALTHY", manager_conclusion: "冷启动审计完成。", executive_summary: ["确定性系统正常"], findings: [], recheck_requests: [], requested_actions: [], evidence_limits: [], next_manager_focus: "下一自然槽" } }; } });
  const competingStartup = await manager.run("SCHEDULE_PREMARKET");
  await manager.stop();
  assert.deepEqual([competingStartup.manager_run_id, manager.state.latest_run.manager_run_id, manager.state.latest_run.status, calls], [stale.manager_run_id, stale.manager_run_id, "SUCCEEDED", 1]);
  store.close();
});

test("daily manager can request one separate full audit without recursive context growth", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-full-audit-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite")); let calls = 0;
  const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, invoke: async ({ managerRunId, prompt }) => { calls += 1; const full = JSON.parse(prompt).snapshot_level === "FULL_AUDIT"; return { threadId: `thread-${calls}`, agentVersion: "codex-cli test", stderr: "", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 }, decision: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "HEALTHY", manager_conclusion: full ? "完整审计已完成。" : "需要一次完整审计。", executive_summary: [full ? "证据完整" : "请求详细证据"], findings: [], recheck_requests: [], requested_actions: full ? [] : [{ action: "REQUEST_FULL_AUDIT", target: "FULL_AUDIT", reason: "关键事实需要详细证据", evidence_refs: ["read_evidence_on_demand"] }], evidence_limits: [], next_manager_focus: "自然运行" } }; } });
  await manager.run("OWNER_MANUAL");
  for (let index = 0; index < 500 && calls < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  await manager.stop(); // The second invocation can precede its durable completion; assert after the real lifecycle drains.
  assert.equal(calls, 2); assert.equal(manager.state.latest_run.snapshot_level, "FULL_AUDIT");
  store.close();
});

async function criticalManager(context) {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-critical-"));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite")), prompts = [], managers = [];
  const result = (managerRunId) => ({ threadId: "isolated-critical-review", agentVersion: "test", stderr: "", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 }, decision: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "DEGRADED", manager_conclusion: "只读分析完成，不代表故障已维修。", executive_summary: [], findings: [], recheck_requests: [], requested_actions: [], evidence_limits: [], next_manager_focus: "受控维护" } });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const create = (holdFirst = false, failFirst = false, targetStore = store) => {
    const manager = createCodexProductionManager({ store: targetStore, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, invoke: async ({ managerRunId, prompt }) => { prompts.push(JSON.parse(prompt)); if (holdFirst && prompts.length === 1) await held; if (failFirst && prompts.length === 1) throw new Error("isolated model failure"); return result(managerRunId); } });
    managers.push(manager); return manager;
  };
  const finding = (fingerprint, scope = "CURRENT_SLOT") => ({ fingerprint, layer: "RUNTIME", code: "TEST_CRITICAL", severity: "CRITICAL", title: fingerprint, run_id: `isolated:${fingerprint}`, suggestion: "隔离只读复核", details: { evidence_scope: scope } });
  const roots = [finding("CRITICAL_ROOT_A"), finding("CRITICAL_ROOT_B")];
  store.reconcileIncidents(roots, "test");
  const escalation = (...findings) => JSON.stringify({ source: "INCIDENT_GUARD", checked_at: new Date().toISOString(), findings });
  const receipts = () => store.getCodexManagerEventPayloads("INCIDENT_ESCALATION_RECEIPT", "receipt");
  const wait = async (ready) => { for (let i = 0; i < 100 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(ready(), "bounded deferred audit must finish"); };
  context.after(async () => { release(); for (const manager of managers) await manager.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, create, roots, escalation, receipts, prompts, release, wait };
}

test("critical escalation persists two busy roots, deduplicates one root and records their actual full-audit receipt", async (context) => {
  const f = await criticalManager(context), manager = f.create(true), before = f.store.getActive();
  const busy = manager.run("OWNER_MANUAL");
  void manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  manager.queue("INCIDENT_ESCALATION", f.escalation(f.roots[1]));
  void manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  const requested = f.store.getCodexManagerEventPayloads("INCIDENT_ESCALATION_REQUESTED", "request");
  assert.equal(requested.length, 2, "busy requests must be durable before the current model finishes");
  f.release(); await busy;
  await f.wait(() => f.receipts().filter((row) => row.status === "ANALYZED").length === 2);
  assert.equal(f.prompts.length, 2);
  const audit = f.prompts[1];
  assert.equal(audit.snapshot_level, "FULL_AUDIT");
  for (const request of requested) {
    assert.ok(JSON.stringify(audit).includes(request.incident_id));
    assert.ok(JSON.stringify(audit).includes(request.fingerprint));
    const receipt = f.receipts().find((row) => row.request_id === request.request_id);
    assert.equal(receipt.manager_run_id, audit.manager_run_id);
    assert.equal(receipt.maintenance_completed, false);
  }
  await manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  assert.equal(f.prompts.length, 2, "already analyzed root does not request another audit");
  assert.deepEqual([f.store.getActive().outputCount, f.store.getActive().runLedger.eventCount], [before.outputCount, before.runLedger.eventCount]);
});

test("critical escalation keeps zero-remaining-budget roots pending without a retry loop and resumes them after restart", async (context) => {
  const f = await criticalManager(context), manager = f.create(true), busy = manager.run("OWNER_MANUAL");
  void manager.run("INCIDENT_ESCALATION", f.escalation(...f.roots));
  const usage = f.store.codexManagerUsageSince;
  f.store.codexManagerUsageSince = () => ({ calls: 999, estimated_cost_usd: 999 });
  f.release(); await busy;
  await f.wait(() => f.receipts().filter((row) => row.status === "SKIPPED_BUDGET").length === 2);
  const count = f.store.codexManagerEventCount;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.store.codexManagerEventCount, count, "exhausted budget cannot create an immediate retry storm");
  assert.equal(f.prompts.length, 1);
  assert.ok(f.receipts().every((row) => !row.maintenance_completed && row.status !== "ANALYZED"));
  await manager.stop();
  f.store.codexManagerUsageSince = usage;
  f.create();
  await f.wait(() => f.receipts().filter((row) => row.status === "ANALYZED").length === 2);
  assert.equal(f.prompts.length, 2);
});

test("critical escalation does not analyze roots already resolved or historical when the busy run ends", async (context) => {
  const f = await criticalManager(context), manager = f.create(true), busy = manager.run("OWNER_MANUAL");
  void manager.run("INCIDENT_ESCALATION", f.escalation(...f.roots));
  f.store.reconcileIncidents([{ ...f.roots[1], details: { evidence_scope: "HISTORICAL" } }], "test");
  f.release(); await busy;
  await f.wait(() => f.receipts().filter((row) => row.status === "NO_LONGER_CURRENT").length === 2);
  await manager.run("INCIDENT_ESCALATION", f.escalation(...f.roots));
  assert.equal(f.prompts.length, 1);
  assert.ok(f.receipts().every((row) => !row.maintenance_completed && row.status !== "ANALYZED"));
});

test("critical escalation model failure remains pending until a later existing manager call", async (context) => {
  const f = await criticalManager(context), manager = f.create(false, true);
  await manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  assert.equal(f.receipts()[0].status, "FAILED");
  assert.equal(f.receipts()[0].maintenance_completed, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.prompts.length, 1, "model failures do not hot-loop retries");
  await manager.run("OWNER_MANUAL");
  assert.equal(f.prompts.length, 2);
  assert.equal(f.receipts().filter((row) => row.status === "ANALYZED").length, 1);
});

test("critical escalation survives shutdown before its pending full audit begins", async (context) => {
  const f = await criticalManager(context), manager = f.create(true), busy = manager.run("OWNER_MANUAL");
  void manager.run("INCIDENT_ESCALATION", f.escalation(...f.roots));
  const stopping = manager.stop(); f.release(); await busy; await stopping;
  assert.equal(f.receipts().length, 0);
  f.create();
  await f.wait(() => f.receipts().filter((row) => row.status === "ANALYZED").length === 2);
  assert.equal(f.prompts.length, 2);
});

test("critical escalation arriving during a full audit bypasses trigger-only dedup but never duplicates an in-flight root", async (context) => {
  const f = await criticalManager(context), manager = f.create(true);
  const busy = manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  manager.queue("INCIDENT_ESCALATION", f.escalation(...f.roots));
  f.release(); await busy;
  await f.wait(() => f.receipts().filter((row) => row.status === "ANALYZED").length === 2);
  assert.equal(f.prompts.length, 2);
  assert.deepEqual(f.prompts.map((prompt) => prompt.tool_results.read_incidents_and_complaints.escalations.map((row) => row.fingerprint)), [[f.roots[0].fingerprint], [f.roots[1].fingerprint]]);
});

test("critical escalation keeps an unresolved root pending when its affected run changes", async (context) => {
  const f = await criticalManager(context), manager = f.create(true), busy = manager.run("OWNER_MANUAL");
  void manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  const latest = { ...f.roots[0], run_id: "isolated:next-run-same-unresolved-root" };
  f.store.reconcileIncidents([latest], "test");
  f.release(); await busy;
  await f.wait(() => f.receipts().some((row) => row.status === "ANALYZED"));
  assert.equal(f.prompts.length, 2);
  assert.equal(f.receipts().some((row) => row.status === "NO_LONGER_CURRENT"), false);
  const audit = f.prompts[1].tool_results.read_incidents_and_complaints;
  assert.equal(audit.escalations[0].run_id, f.roots[0].run_id, "first requested run stays immutable");
  assert.equal(audit.active.find((row) => row.fingerprint === latest.fingerprint).run_id, latest.run_id);
  await manager.run("INCIDENT_ESCALATION", f.escalation(latest));
  assert.equal(f.prompts.length, 2, "same unresolved fault does not duplicate on a later guard callback");
});

test("critical escalation dedup does not suppress a later real reopening of the same incident", async (context) => {
  const f = await criticalManager(context), manager = f.create();
  await manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  f.store.reconcileIncidents([], "test");
  f.store.reconcileIncidents(f.roots, "test");
  await manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  assert.equal(f.prompts.length, 2, "resolved/reopened incident is a new episode, not an already analyzed root");
  assert.equal(new Set(f.receipts().map((row) => row.request_id)).size, 2);
});

test("critical escalation resolves an old busy episode but still analyzes its newly reopened episode", async (context) => {
  const f = await criticalManager(context), manager = f.create(true), busy = manager.run("OWNER_MANUAL");
  void manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  f.store.reconcileIncidents([], "test");
  f.store.reconcileIncidents(f.roots, "test");
  void manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  f.release(); await busy;
  await f.wait(() => f.receipts().length === 2);
  assert.deepEqual(f.receipts().map((row) => row.status).sort(), ["ANALYZED", "NO_LONGER_CURRENT"]);
  assert.equal(f.prompts.length, 2);
  assert.equal(f.prompts[1].tool_results.read_incidents_and_complaints.escalations.length, 1);
});

test("critical escalation receipts preserve the real latest run and model budget accounting", async (context) => {
  const f = await criticalManager(context), manager = f.create();
  const run = await manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  const state = f.store.getCodexManagerState();
  assert.equal(state.latest_run?.manager_run_id, run.manager_run_id);
  assert.equal(state.recent_runs.length, 1);
  assert.equal(f.store.codexManagerUsageSince("1970-01-01T00:00:00Z").calls, 1);
  assert.ok(f.store.codexManagerUsageSince("1970-01-01T00:00:00Z").estimated_cost_usd > 0);
});

test("critical escalation restarts after a MODEL_STARTED crash with a new attempt and preserves the interrupted run", async (context) => {
  const f = await criticalManager(context), manager = f.create(true);
  const busy = manager.run("INCIDENT_ESCALATION", f.escalation(f.roots[0]));
  await f.wait(() => f.prompts.length === 1);
  const originalId = f.prompts[0].manager_run_id;
  assert.ok(f.store.getLatestCodexManagerRunEvent(originalId, "MODEL_STARTED"));
  const copiedFile = join(dirname(f.store.file), "crash-at-model-start.sqlite"), readonly = new DatabaseSync(f.store.file, { readOnly: true });
  try { await backup(readonly, copiedFile); } finally { readonly.close(); }
  f.release(); await busy; await manager.stop();
  const recoveredStore = openSnapshotDatabase(copiedFile), recovered = f.create(false, false, recoveredStore);
  try {
    await f.wait(() => recoveredStore.getCodexManagerEventPayloads("INCIDENT_ESCALATION_RECEIPT", "receipt").some((row) => row.status === "ANALYZED"));
    const state = recoveredStore.getCodexManagerState();
    assert.equal(f.prompts.length, 2);
    assert.notEqual(state.latest_run.manager_run_id, originalId);
    assert.equal(state.latest_run.status, "SUCCEEDED");
    assert.equal(state.recent_runs.find((row) => row.manager_run_id === originalId).status, "FAILED");
    assert.match(state.recent_runs.find((row) => row.manager_run_id === originalId).error, /中断/);
    assert.equal(recoveredStore.codexManagerUsageSince("1970-01-01T00:00:00Z").calls, 2);
  } finally { await recovered.stop(); recoveredStore.close(); }
});

test("critical escalation pending history beyond recent-100 survives restart without hiding the active manager", async (context) => {
  const f = await criticalManager(context), roots = Array.from({ length: 106 }, (_, index) => ({ ...f.roots[0], fingerprint: `PERSISTENT_CRITICAL_${index}`, run_id: `isolated:root-${index}` }));
  f.store.reconcileIncidents(roots, "test");
  const manager = f.create(true), busy = manager.run("OWNER_MANUAL");
  await f.wait(() => f.prompts.length === 1);
  const originalId = f.prompts[0].manager_run_id;
  void manager.run("INCIDENT_ESCALATION", f.escalation(...roots));
  assert.equal(f.store.getCodexManagerState().latest_run?.manager_run_id, originalId);
  const stopping = manager.stop(); f.release(); await busy; await stopping;
  const recovered = f.create();
  await f.wait(() => f.prompts.length === 2 && !recovered.running);
  assert.equal(f.prompts[1].tool_results.read_incidents_and_complaints.escalations.length, 106, "pending authority cannot be a recent-100 projection");
  assert.equal(f.store.getCodexManagerState().recent_runs.length, 2);
  assert.equal(f.store.getCodexManagerState().latest_run.manager_run_id, f.prompts[1].manager_run_id);
  assert.equal(f.store.codexManagerUsageSince("1970-01-01T00:00:00Z").calls, 2);
  assert.deepEqual(f.store.getPendingCodexIncidentEscalations(), []);
});

test("model action rejections preserve deterministic incidents and continue safe actions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-rejected-actions-")), store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  context.after(async () => { await manager.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  store.reconcileIncidents([{ fingerprint: "GTH_BAR_CONTINUITY_BROKEN", layer: "DATA", code: "GTH_BAR_CONTINUITY_BROKEN", severity: "CRITICAL", title: "跨日K线检查", run_id: "guard:test", suggestion: "核验日期窗口", details: {} }], "test");
  const original = store.getSelfCheck().recent.find((item) => item.fingerprint === "GTH_BAR_CONTINUITY_BROKEN"), probes = [], rechecks = [];
  const action = (kind, target) => ({ action: kind, target, reason: "隔离边界测试", evidence_refs: ["synthetic:guard"] });
  const actions = [action("UPDATE_INCIDENT", original.incident_id), action("CLOSE_INCIDENT", original.fingerprint), action("RUN_READONLY_DATA_PROBE", "GTH_BAR_CONTINUITY_BROKEN"), action("place_order", "ACCOUNT"), null, { ...action("RUN_READONLY_DATA_PROBE", "ROBINHOOD"), evidence_refs: [] }, action("RUN_READONLY_DATA_PROBE", "ROBINHOOD"), action("REQUEST_DEPARTMENT_RECHECK", "PLATFORM")];
  const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, runReadonlyProbe: async (target) => { probes.push(target); return { status: "LIVE" }; }, requestDepartmentRecheck: async (target) => { rechecks.push(target); return { status: "QUEUED_FOR_NEXT_NATURAL_SLOT" }; }, invoke: async ({ managerRunId }) => ({ threadId: "synthetic-rejected-actions", agentVersion: "test", stderr: "", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }, decision: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "DEGRADED", manager_conclusion: "只读分析完成", executive_summary: [], findings: [], recheck_requests: [], requested_actions: actions, evidence_limits: [], next_manager_focus: "自然检查" } }) });
  const run = await manager.run("OWNER_MANUAL");
  assert.equal(run.status, "SUCCEEDED", "analysis completes independently of rejected model actions");
  assert.match(run.error, /6项动作.*拒绝/);
  assert.deepEqual(run.decision.requested_actions, actions, "retain the model's original requests, including invalid ones");
  assert.deepEqual(probes, ["ROBINHOOD"]);
  assert.deepEqual(rechecks, ["PLATFORM"]);
  assert.deepEqual(store.getSelfCheck().recent.find((item) => item.incident_id === original.incident_id), original);
  const operations = manager.state.recent_operations;
  assert.equal(operations.filter((item) => item.status === "GATE_BLOCKED").length, 3);
  assert.equal(operations.filter((item) => item.status === "SUCCEEDED").length, 2);
  const rejected = store.getCodexManagerEventPayloads("ACTION_REJECTED", "action");
  assert.equal(store.getCodexManagerEventPayloads("ACTION_REJECTED", "error").length, 6);
  assert.equal(rejected.length, 5, "the field projection omits the retained null request");
  assert.ok(rejected.some((item) => item?.action === "place_order"));
  assert.ok(rejected.some((item) => item?.target === original.incident_id));
  assert.ok(run.checkpoint_id);
  assert.deepEqual([manager.state.broker_write_tools, manager.state.broker_write_calls, manager.state.automated_execution], [0, 0, false]);
});

test("manager action execution and rejection-audit failures remain run failures", async (context) => {
  for (const failure of ["probe", "audit"]) await context.test(failure, async (child) => {
    const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-action-failure-")), store = openSnapshotDatabase(join(directory, "manager.sqlite"));
    child.after(async () => { await manager.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
    const recorded = store.recordCodexManagerEvent.bind(store);
    if (failure === "audit") store.recordCodexManagerEvent = (input) => { if (input.event_type === "ACTION_REJECTED") throw new Error("audit storage unavailable"); return recorded(input); };
    let probes = 0, rechecks = 0;
    const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, runReadonlyProbe: async () => { probes++; throw new Error("temporary provider failure"); }, requestDepartmentRecheck: async () => { rechecks++; return {}; }, invoke: async ({ managerRunId }) => ({ threadId: "synthetic-action-failure", agentVersion: "test", stderr: "", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }, decision: { contract_version: CODEX_PRODUCTION_MANAGER_CONTRACT, manager_run_id: managerRunId, status: "HEALTHY", manager_conclusion: "只读分析完成", executive_summary: [], findings: [], recheck_requests: [], requested_actions: [{ action: "RUN_READONLY_DATA_PROBE", target: "invalid", reason: "应拒绝", evidence_refs: ["synthetic"] }, { action: "RUN_READONLY_DATA_PROBE", target: "ROBINHOOD", reason: "执行失败仍须报告", evidence_refs: ["synthetic"] }, { action: "REQUEST_DEPARTMENT_RECHECK", target: "PLATFORM", reason: "失败后不继续", evidence_refs: ["synthetic"] }], evidence_limits: [], next_manager_focus: "自然检查" } }) });
    const run = await manager.run("OWNER_MANUAL");
    assert.equal(run.status, "FAILED");
    assert.match(run.error, failure === "probe" ? /temporary provider failure/ : /audit storage unavailable/);
    assert.equal(probes, failure === "probe" ? 1 : 0);
    assert.equal(rechecks, 0);
    if (failure === "probe") assert.ok(manager.state.recent_operations.some((item) => item.target === "ROBINHOOD" && item.status === "FAILED"));
  });
});

test("controlled manager actions are idempotent, attributed and release-gated", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-actions-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  let probes = 0, failProbe = true, rechecks = 0;
  const manager = createCodexProductionManager({ store, dataRoot: directory, projectRoot: process.cwd(), siteVersion: "test", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, runReadonlyProbe: async (target) => { probes += 1; if (target === "ROBINHOOD" && failProbe) { failProbe = false; throw new Error("temporary"); } return { target, status: "LIVE" }; }, requestDepartmentRecheck: async () => { rechecks += 1; return { status: "QUEUED_FOR_NEXT_NATURAL_SLOT" }; } });
  const input = { manager_run_id: "manager:test-actions", action: "RUN_READONLY_DATA_PROBE", target: "FINNHUB", reason: "生产服务凭据作用域探针", evidence_refs: ["service:finnhub"], idempotency_key: "finnhub-once" };
  const first = await manager.executeAction(input), duplicate = await manager.executeAction(input);
  assert.equal(first.operation_id, duplicate.operation_id);
  assert.equal(probes, 1);
  await assert.rejects(manager.executeAction({ manager_run_id: "manager:test-actions", action: "RUN_READONLY_DATA_PROBE", target: "ROBINHOOD", reason: "临时失败后允许同输入重试", evidence_refs: ["service:robinhood"] }), /temporary/);
  const retry = await manager.executeAction({ manager_run_id: "manager:test-actions", action: "RUN_READONLY_DATA_PROBE", target: "ROBINHOOD", reason: "临时失败后允许同输入重试", evidence_refs: ["service:robinhood"] });
  assert.equal(retry.status, "SUCCEEDED");
  assert.equal(probes, 3);
  const periodicProbe = { action: "RUN_READONLY_DATA_PROBE", target: "FINNHUB", reason: "每槽重新验证", evidence_refs: ["service:finnhub"] };
  await manager.executeAction({ manager_run_id: "manager:slot-a", ...periodicProbe }); await manager.executeAction({ manager_run_id: "manager:slot-b", ...periodicProbe }); assert.equal(probes, 5);
  const openInput = { manager_run_id: "manager:test-actions", action: "OPEN_INCIDENT", target: "manager.test-design-gap", reason: "真实设计改进", evidence_refs: ["audit:test"] }, closeInput = { manager_run_id: "manager:test-actions", action: "CLOSE_INCIDENT", target: "manager.test-design-gap", reason: "验证通过", evidence_refs: ["gate:test"] };
  const opened = await manager.executeAction(openInput);
  assert.ok(opened.incident_id);
  store.reconcileIncidents([{ fingerprint: "service.critical-test", layer: "SERVICE", code: "SERVICE_DOWN", severity: "CRITICAL", title: "确定性服务故障", run_id: "guard:test", suggestion: "等待监督器恢复", details: {} }], "test", "2026-08-24T13:01:00.000Z");
  assert.equal(store.getActive().selfCheck.active.some((item) => item.fingerprint === "manager.test-design-gap"), true);
  for (const action of ["OPEN_INCIDENT", "UPDATE_INCIDENT", "CLOSE_INCIDENT"]) await assert.rejects(manager.executeAction({ manager_run_id: "manager:test-actions", action, target: "service.critical-test", reason: "经理不得降级确定性故障", evidence_refs: ["guard:test"] }), /不得修改确定性Incident/);
  const deterministic = store.getActive().selfCheck.active.find((item) => item.fingerprint === "service.critical-test");
  assert.deepEqual({ layer: deterministic.layer, code: deterministic.code, severity: deterministic.severity, status: deterministic.status }, { layer: "SERVICE", code: "SERVICE_DOWN", severity: "CRITICAL", status: "ACTIVE" });
  const firstClose = await manager.executeAction(closeInput), reopened = await manager.executeAction(openInput), secondClose = await manager.executeAction(closeInput);
  assert.notEqual(reopened.operation_id, opened.operation_id);
  assert.notEqual(secondClose.operation_id, firstClose.operation_id);
  assert.equal(store.getActive().selfCheck.active.some((item) => item.fingerprint === "manager.test-design-gap"), false);
  const recheckInput = { manager_run_id: "manager:test-actions", action: "REQUEST_DEPARTMENT_RECHECK", target: "TS", reason: "下一自然槽复核", evidence_refs: ["audit:test"] };
  await manager.executeAction(recheckInput); await manager.executeAction(recheckInput); assert.equal(rechecks, 1);
  const candidate = "c".repeat(40), deployed = "d".repeat(40), pr = 115, rollback = join(directory, "backups", "pre-manager.sqlite"), common = { risk: "LOW_RISK", status: "SUCCEEDED", actor: "CODEX", target: "A3.1b", incident_id: opened.incident_id, started_at: "2026-08-24T13:00:00.000Z", completed_at: "2026-08-24T13:05:00.000Z", commit: candidate, pr, rollback_ref: null };
  await mkdir(join(directory, "backups")); await writeFile(rollback, "backup");
  const operation = (id, action, evidence_refs, overrides = {}) => manager.recordPrivilegedOperation({ ...common, operation_id: id, idempotency_key: id, action, summary: action, evidence_refs, ...overrides });
  operation("runbook:create-pr", "CREATE_PR", ["pr:115"]);
  operation("runbook:tests", "RUN_TESTS", ["gate:tests-pass"]);
  operation("runbook:review", "INDEPENDENT_REVIEW", ["review:APPROVED:independent-reviewer"]);
  operation("runbook:backup", "CREATE_SQLITE_BACKUP", [`sha256:${createHash("sha256").update("backup").digest("hex")}`], { commit: null, pr: null, rollback_ref: rollback });
  operation("runbook:canary", "CANARY_4071", ["canary:pass"]);
  const release = operation("release:test-pass", "DEPLOY_4070", [`candidate:${candidate}`], { risk: "RELEASE", commit: deployed, rollback_ref: rollback });
  assert.throws(() => manager.recordRecoveryAttribution({ attribution_id: "attribution:missing-operation", incident_id: null, classification: "DESIGN_IMPROVEMENT", first_detected_at: "2026-08-23T00:56:02.970Z", root_cause: "test", action: "test", actor: "CODEX", operation_id: "missing:operation", commit: deployed, pr, verified_at: "2026-08-24T13:05:00.000Z", result: "IMPROVED", closed: true, evidence_refs: ["gate:test"] }), /匹配的成功动作/);
  manager.recordRecoveryAttribution({ attribution_id: "attribution:test-pass", incident_id: opened.incident_id, classification: "DESIGN_IMPROVEMENT", first_detected_at: "2026-08-23T00:56:02.970Z", root_cause: "经理快照过大", action: "分层快照", actor: "CODEX", operation_id: release.operation_id, commit: release.commit, pr: release.pr, verified_at: "2026-08-24T13:05:00.000Z", result: "IMPROVED", closed: true, evidence_refs: ["review:independent-pass", "gate:tests-pass"] });
  assert.equal(manager.state.recovery_attributions[0].result, "IMPROVED");
  assert.equal(manager.state.current_task, null);
  assert.equal(manager.state.operation_permissions.controlled_runbook.includes("DEPLOY_4070"), true);
  assert.equal(JSON.stringify(manager.state.operation_permissions).match(/ORDER|EXERCISE|CANCEL/gi), null);
  store.close();
});
