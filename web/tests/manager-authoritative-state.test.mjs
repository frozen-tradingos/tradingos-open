import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexManagerReview } from "../app/codex-manager.ts";
import { buildCurrentTruth } from "../app/current-truth.ts";
import { runStartupRecovery } from "../server/startup-recovery.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";

const monday = "2026-09-08T01:20:00.000Z", tuesday = "2026-09-08T13:32:00.000Z";
const source = (at, overrides = {}) => ({ source: "ROBINHOOD", configured: true, authorization: "VALID", status: "LIVE", as_of: at, checked_at: at, last_success_at: at, freshness_seconds: 0, error: null, capabilities: { market_quotes: true, intraday_bars: true }, ...overrides });
const run = (agent_id, at, slot = "live-shadow:20260908T133000Z") => ({ agent_id, channel: "SHADOW", run_id: slot, slot_id: slot, data_cutoff_at: at, event_at: at, received_at: at, status: "SUCCEEDED", output_status: "PRODUCED", website_delivery: "DELIVERED", evidence_refs: [] });
const incident = (id, overrides = {}) => ({ incident_id: id, fingerprint: id, layer: "DATA", code: "SOURCE_GAP", title: id, suggestion: "自动复查", severity: "WARNING", status: "ACTIVE", details: { owner_required: false }, ...overrides });
function state(at = tuesday) {
  return { runLedger: { runs: [] }, selfCheck: { active: [], recent: [], checked_at: at, last_backup_at: at }, dataSources: [source(at)], ownerQueue: { open_complaints: 0, pending_approval: 0, total_complaints: 0 }, scheduler: { recent: [], next_run: null }, outputs: { TS_SHADOW_OUTPUT: [], OPTION_STRATEGY_SIGNAL: [] }, marketRadar: { snapshot: null }, tsSettlement: { recent: [], pending_count: 0 }, optionLifecycle: { recent_settlements: [], pending_count: 0 } };
}
function tier0(at = tuesday, slot = "live-shadow:20260908T133000Z") {
  const s = state(at), forecastId = "frozen-forecast";
  s.runLedger.runs = ["A1", "A2", "TS"].map(agent => run(agent, at, slot));
  s.outputs.TS_SHADOW_OUTPUT = [{ report_type: "INTRADAY_30_60M", evidence_snapshot: { run_id: forecastId, market_time: { market_date: at.slice(0, 10), observed_at: at } } }];
  s.currentTruth = buildCurrentTruth({ ...s, tsCoreOwnership: { slot_id: slot, run_id: slot, status: "TERMINAL", terminal_outcome: "NO_TRADE", forecast_id: forecastId, delivery_record_id: `${slot}:TS`, lease_acquired_at: at, updated_at: at }, tsCoreDeliveryExists: true }, at);
  return s;
}
const area = (review, name) => review.checks.find(item => item.area === name);

test("Manager accepts the actual Tier 0 contract without demanding four unassigned departments", () => {
  const s = tier0(), review = buildCodexManagerReview(s, new Date(tuesday), "EARLY");
  assert.equal(area(review, "AGENTS").status, "PASS");
  assert.equal(area(review, "ALIGNMENT").status, "EXPECTED");
  assert.equal(review.issues.some(item => item.code === "MANAGER_AGENT_CHAIN_INCOMPLETE"), false);
  assert.match(area(review, "AGENTS").summary, /A1.*A2.*TS/);
});

test("later stale Bars block current data without reopening the completed Tier 0 slot", () => {
  const s = tier0(), frozen = structuredClone(s.currentTruth.natural_slot);
  s.dataSources = [source(tuesday, { status: "STALE", capabilities: { market_quotes: true, intraday_bars: false } })];
  const review = buildCodexManagerReview(s, new Date("2026-09-08T13:40:00.000Z"), "EARLY");
  assert.equal(area(review, "DATA").status, "BLOCKED");
  assert.equal(area(review, "AGENTS").status, "PASS");
  assert.deepEqual(s.currentTruth.natural_slot, frozen);
});

test("Sunday attendance follows the actual slot while Friday data retains its freshness limits", () => {
  const at = "2026-09-14T01:20:00.000Z", slot = "live-shadow:20260914T010000Z", friday = "2026-09-11T19:59:59.900Z";
  const s = tier0("2026-09-14T01:01:00.000Z", slot);
  s.runLedger.runs = ["A1", "A2", "TS", "COMMITTEE", "D", "A3", "CODEX_GUARD"].map(agent => ({ ...run(agent, "2026-09-14T01:01:00.000Z", slot), data_cutoff_at: agent === "A1" ? "2026-09-14T01:00:00.000Z" : friday }));
  s.dataSources = [source(friday, { status: "STALE" })];
  const before = structuredClone(s), review = buildCodexManagerReview(s, new Date(at), "DAILY_CLOSE");
  assert.equal(area(review, "AGENTS").status, "PASS");
  assert.equal(area(review, "DATA").status, "BLOCKED");
  assert.equal(review.issues.some(item => item.code === "MANAGER_AGENT_CHAIN_INCOMPLETE"), false);
  assert.deepEqual(s, before, "attendance checks never rewrite original evidence");
  for (const change of [
    run => { run.status = "FAILED"; },
    run => { run.status = "DATA_BLOCKED"; },
    run => { run.slot_id = "live-shadow:20260911T193000Z"; },
  ]) {
    const invalid = structuredClone(s);
    change(invalid.runLedger.runs.find(item => item.agent_id === "TS"));
    assert.equal(area(buildCodexManagerReview(invalid, new Date(at), "DAILY_CLOSE"), "AGENTS").status, "BLOCKED");
  }
  s.currentTruth.natural_slot = { ...s.currentTruth.natural_slot, slot_id: null, frozen_at: null, terminal_at: null };
  assert.equal(area(buildCodexManagerReview(s, new Date(at), "DAILY_CLOSE"), "AGENTS").status, "PASS", "fallback uses today's event time, not Friday's market cutoff");
  s.runLedger.runs.forEach(item => { item.event_at = "2026-09-14T01:20:01.000Z"; });
  assert.equal(area(buildCodexManagerReview(s, new Date(at), "DAILY_CLOSE"), "AGENTS").status, "PASS", "a refreshed snapshot includes recovery completed after the caller started its review");
});

test("holiday daily review accepts fresh overnight Bars and does not inherit Sunday's failed slot", () => {
  const s = tier0("2026-09-07T01:01:00.000Z", "live-shadow:20260907T010000Z");
  s.runLedger.runs[0].status = "FAILED";
  s.currentTruth.natural_slot.status = "BLOCKED";
  s.currentTruth.natural_slot.terminal_state = "FAILED";
  s.outputs.TS_SHADOW_OUTPUT = [];
  s.selfCheck.checked_at = monday;
  s.dataSources = [source(monday, { status: "DEGRADED", capabilities: { market_quotes: false, intraday_bars: true }, error: "EXPECTED_PROVIDER_SESSION_LIMIT" })];
  const before = structuredClone(s), review = buildCodexManagerReview(s, new Date(monday), "DAILY_CLOSE");
  assert.notEqual(area(review, "DATA").status, "BLOCKED");
  assert.equal(area(review, "AGENTS").status, "EXPECTED");
  assert.equal(review.prediction_review.status, "NOT_DUE");
  assert.match(review.prediction_review.summary, /休市/);
  assert.equal(review.company_working, true);
  assert.deepEqual(s, before, "old failure and frozen history remain unchanged");
});

test("expected overnight limitation never bypasses the 420-second Bar freshness contract", () => {
  const s = state(monday);
  s.dataSources = [source("2026-09-08T01:12:59.000Z", { status: "DEGRADED", capabilities: { market_quotes: false, intraday_bars: true } })];
  assert.equal(area(buildCodexManagerReview(s, new Date(monday), "DAILY_CLOSE"), "DATA").status, "BLOCKED");
});

test("an actual failed observation on a holiday stays a failure", () => {
  const at = "2026-09-08T01:01:00.000Z", slot = "live-shadow:20260908T010000Z", s = tier0(at, slot);
  s.runLedger.runs[0].status = "FAILED";
  s.currentTruth.natural_slot.status = "BLOCKED";
  s.currentTruth.natural_slot.terminal_state = "FAILED";
  s.outputs.TS_SHADOW_OUTPUT = [];
  s.selfCheck.checked_at = monday;
  s.dataSources = [source(monday)];
  const review = buildCodexManagerReview(s, new Date(monday), "DAILY_CLOSE");
  assert.equal(area(review, "AGENTS").status, "BLOCKED");
  assert.equal(review.company_working, false);
});

test("Manager uses current root incidents, excluding historical reviews and expected source limits", () => {
  const s = state(monday);
  s.selfCheck.active = [incident("old-review", { layer: "MANAGER", code: "CODEX_MANAGER_REVIEW" }), incident("night-limit", { details: { expected_provider_session_limit: true, owner_required: false } })];
  s.ownerQueue.open_complaints = 11;
  const review = buildCodexManagerReview(s, new Date(monday), "DAILY_CLOSE");
  assert.equal(area(review, "WORK_QUEUE").status, "PASS");
  assert.match(area(review, "WORK_QUEUE").summary, /0 个当前故障，投诉台账未关闭 11 个/);
  assert.deepEqual(review.owner_todos, []);
  s.selfCheck.active.push(incident("root-a", { details: { root_cause_id: "shared-root", owner_required: true } }), incident("root-b", { details: { root_cause_id: "shared-root", owner_required: true } }));
  const actionable = buildCodexManagerReview(s, new Date(monday), "DAILY_CLOSE");
  assert.match(area(actionable, "WORK_QUEUE").summary, /1 个当前故障，投诉台账未关闭 11 个/);
  assert.equal(area(actionable, "WORK_QUEUE").status, "BLOCKED");
  assert.equal(actionable.owner_todos.length, 1);
  s.selfCheck.active = [];
  s.ownerQueue.pending_approval = 1;
  const pending = buildCodexManagerReview(s, new Date(monday), "DAILY_CLOSE");
  assert.equal(area(pending, "WORK_QUEUE").status, "BLOCKED");
  assert.deepEqual(pending.owner_todos, ["1 项等待老板批准"]);
});

function startupStore() {
  const events = [];
  return { events, getLatestCodexManagerEvent: type => events.findLast(item => item.event_type === type)?.payload ?? null, getLatestCodexManagerRunEvent: (id, type) => events.findLast(item => item.manager_run_id === id && item.event_type === type)?.payload ?? null, recordCodexManagerEvent: event => events.push(event) };
}
const boot = "2026-09-07T20:35:15.500Z", completed = "2026-09-07T20:36:40.807Z";
const startupSummary = { manager_run_id: "startup-test", trigger: "STARTUP_RECOVERY", requested_at: "2026-09-07T20:36:34.903Z", completed_at: completed, status: "SKIPPED_BUDGET", snapshot_id: "startup-snapshot", error: "解释层未执行", tools: ["schedule_ledger_supervision"] };
const startupOptions = store => ({ store, windowsBootAt: boot, supervisorStartedAt: "2026-09-07T20:35:40.196Z", serviceReadyAt: "2026-09-07T20:36:34.112Z", startReason: "WINDOWS_STARTUP", now: () => new Date(completed) });

test("cold start accepts completed deterministic checks without calling a budget-skipped LLM offline", async () => {
  const store = startupStore();
  const result = await runStartupRecovery({ ...startupOptions(store), runManager: async () => { store.recordCodexManagerEvent({ manager_run_id: startupSummary.manager_run_id, event_type: "RUN_SKIPPED_BUDGET", payload: { run_summary: startupSummary, deterministic_checks_completed: true } }); return startupSummary; } });
  assert.deepEqual([result.status, result.codex_manager_status, result.target_met, result.manager_recovery_ms], ["READY", "SUCCEEDED", true, 85307]);
  assert.equal(store.getLatestCodexManagerEvent("RUN_SKIPPED_BUDGET").run_summary.status, "SKIPPED_BUDGET");
  const again = await runStartupRecovery({ ...startupOptions(store), runManager: async () => { throw new Error("must not repeat"); } });
  assert.equal(again.manager_run_id, startupSummary.manager_run_id);
});

test("budget skipping alone or another run's completed checks cannot certify a cold start", async () => {
  for (const evidence of [null, { run_summary: { ...startupSummary, manager_run_id: "another-run" }, deterministic_checks_completed: true }, { run_summary: startupSummary, deterministic_checks_completed: false }]) {
    const store = startupStore();
    if (evidence) store.recordCodexManagerEvent({ manager_run_id: evidence.run_summary.manager_run_id, event_type: "RUN_SKIPPED_BUDGET", payload: evidence });
    const result = await runStartupRecovery({ ...startupOptions(store), runManager: async () => startupSummary });
    assert.equal(result.status, "OFFLINE_DEGRADED");
    assert.equal(result.target_met, false);
  }
});

test("future market timestamps never qualify as fresh regular or overnight data", () => {
  for (const [at, type, overrides] of [[tuesday, "EARLY", {}], [monday, "DAILY_CLOSE", { status: "DEGRADED", capabilities: { market_quotes: false, intraday_bars: true } }]]) {
    const s = state(at);
    s.dataSources = [source(new Date(Date.parse(at) + 3600000).toISOString(), overrides)];
    assert.equal(area(buildCodexManagerReview(s, new Date(at), type), "DATA").status, "BLOCKED");
  }
});

test("a claimed authoritative slot without run events never falls back to the preceding completed slot", () => {
  const s = tier0();
  s.currentTruth.current_time = "2026-09-08T13:48:00.000Z";
  s.currentTruth.natural_slot = { ...s.currentTruth.natural_slot, slot_id: "live-shadow:20260908T134500Z", status: "RUNNING", terminal_state: null, terminal_at: null, frozen_at: null };
  const review = buildCodexManagerReview(s, new Date("2026-09-08T13:48:00.000Z"), "EARLY");
  assert.equal(area(review, "AGENTS").status, "BLOCKED");
  assert.match(area(review, "AGENTS").summary, /缺席：A1、A2、TS；/);
  assert.doesNotMatch(area(review, "AGENTS").summary, /COMMITTEE|CODEX_GUARD/);
});

const oldStartupState = { contract_version: "STARTUP_RECOVERY_V1", boot_id: "startup-recovery:87fad9d71a5f6eca0a069073", start_reason: "WINDOWS_STARTUP", status: "OFFLINE_DEGRADED", windows_boot_at: boot, supervisor_started_at: "2026-09-07T20:35:40.196Z", service_ready_at: "2026-09-07T20:36:34.112Z", service_recovery_ms: 78612, database_status: "READY", scheduler_status: "READY", codex_manager_status: "OFFLINE", manager_run_id: startupSummary.manager_run_id, manager_completed_at: completed, manager_recovery_ms: 85307, retry_count: 1, next_retry_at: null, target_seconds: 300, target_met: false, owner_required: false, recorded_at: completed };

test("same-boot recovery projects completed checks without altering the original cold-boot times or events", async () => {
  const store = startupStore(), original = structuredClone(oldStartupState);
  store.recordCodexManagerEvent({ event_type: "STARTUP_RECOVERY_STATE", payload: { startup_recovery: original } });
  store.recordCodexManagerEvent({ manager_run_id: startupSummary.manager_run_id, event_type: "RUN_SKIPPED_BUDGET", payload: { run_summary: startupSummary, deterministic_checks_completed: true } });
  store.recordCodexManagerEvent({ manager_run_id: "later-daily", event_type: "RUN_SKIPPED_BUDGET", payload: { run_summary: { ...startupSummary, manager_run_id: "later-daily", trigger: "SCHEDULE_DAILY_REVIEW" }, deterministic_checks_completed: true } });
  const before = structuredClone(store.events);
  const recovered = await runStartupRecovery({ ...startupOptions(store), startReason: "SERVICE_RESTART", supervisorStartedAt: "2026-09-08T03:00:00.000Z", serviceReadyAt: "2026-09-08T03:00:30.000Z", runManager: async () => { throw new Error("completed cold boot must not rerun"); } });
  assert.deepEqual([recovered.status, recovered.target_met, recovered.manager_run_id, recovered.manager_recovery_ms], ["READY", true, startupSummary.manager_run_id, 85307]);
  assert.deepEqual(store.events.slice(0, before.length), before, "original offline and budget records stay immutable");
  assert.deepEqual([recovered.supervisor_started_at, recovered.service_ready_at, recovered.service_recovery_ms, recovered.recorded_at], [original.supervisor_started_at, original.service_ready_at, original.service_recovery_ms, original.recorded_at]);
  assert.equal(store.events.length, before.length);
});

test("SQLite read projection fixes an archived budget-only offline label without appending or rewriting evidence", async context => {
  const directory = await mkdtemp(join(tmpdir(), "manager-startup-projection-"));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  store.recordCodexManagerEvent({ event_id: "boot-state", manager_run_id: oldStartupState.boot_id, event_type: "STARTUP_RECOVERY_STATE", recorded_at: completed, payload: { startup_recovery: oldStartupState } });
  store.recordCodexManagerEvent({ event_id: "boot-manager", manager_run_id: startupSummary.manager_run_id, event_type: "RUN_SKIPPED_BUDGET", recorded_at: completed, payload: { run_summary: startupSummary, deterministic_checks_completed: true } });
  const before = [store.getCodexManagerEvent("boot-state"), store.getCodexManagerEvent("boot-manager")], count = store.codexManagerEventCount;
  assert.equal(store.getCodexManagerState().startup_recovery.status, "READY");
  assert.equal(store.getCodexManagerState().startup_recovery.service_recovery_ms, 78612);
  assert.equal(store.codexManagerEventCount, count);
  assert.deepEqual([store.getCodexManagerEvent("boot-state"), store.getCodexManagerEvent("boot-manager")], before);
});
