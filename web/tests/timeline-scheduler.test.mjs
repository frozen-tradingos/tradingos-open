import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildCodexManagerReview } from "../app/codex-manager.ts";
import { eligibleForFaultStatistics, eligibleForSuccessStatistics, operationalEvidenceMode, schedulerState, timelineGraceSeconds, timelineOccurrencesForPtDate } from "../app/timeline-schedule.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { createTimelineScheduler } from "../server/timeline-scheduler.ts";

function liveSource(at) {
  return { source: "ROBINHOOD", status: "LIVE", configured: true, authorization: "VALID", last_success_at: at, as_of: at, freshness_seconds: 0, error: null, checked_at: at, capabilities: { quotes: true } };
}

function closedSource(at) { return { ...liveSource(at), status: "MARKET_CLOSED" }; }

test("V2 PT schedule keeps full slots, holidays, early closes and DST", () => {
  const regular = timelineOccurrencesForPtDate("2026-08-12");
  assert.equal(regular.filter((item) => item.kind === "POSITION_MONITOR").length, 391);
  assert.equal(regular.filter((item) => item.kind === "A1_HEARTBEAT").length, 27);
  assert.equal(regular.filter((item) => item.kind === "LOCAL_GUARD").length, 79);
  assert.equal(regular.filter((item) => item.kind === "CODEX_GUARD").length, 79);
  assert.deepEqual(regular.filter((item) => item.kind === "TS_FORECAST").map((item) => item.business_slot), ["06:30", "06:45", "07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30"]);
  assert.deepEqual(regular.filter((item) => item.kind === "FULL_ANALYSIS").map((item) => item.business_slot), ["06:30", "06:45", "07:00", "09:30", "11:30"]);
  assert.deepEqual(regular.filter((item) => item.scheduled_at === "2026-08-12T16:30:00.000Z").slice(0, 2).map((item) => item.kind), ["TS_FORECAST", "FULL_ANALYSIS"]);
  assert.deepEqual(regular.filter((item) => item.kind === "CODEX_MANAGER").map((item) => item.business_slot), ["06:20", "07:05", "09:35", "13:55"]);
  assert.equal(timelineOccurrencesForPtDate("2026-12-25").length, 1);
  assert.equal(timelineOccurrencesForPtDate("2027-12-31").length, 1);
  assert.equal(timelineOccurrencesForPtDate("2026-08-16").length, 4);
  const early = timelineOccurrencesForPtDate("2026-11-27");
  assert.equal(early.filter((item) => item.kind === "POSITION_MONITOR").length, 211);
  assert.equal(early.find((item) => item.kind === "HISTORY_ARCHIVE").business_slot, "10:15");
  assert.equal(regular.find((item) => item.kind === "TS_FORECAST").scheduled_at, "2026-08-12T13:30:00.000Z");
  assert.equal(timelineOccurrencesForPtDate("2026-01-15").find((item) => item.kind === "TS_FORECAST").scheduled_at, "2026-01-15T14:30:00.000Z");
  for (const [date, seconds] of [["2026-09-18", 300], ["2026-09-21", 600], ["2026-11-30", 600]]) assert.equal(timelineGraceSeconds(timelineOccurrencesForPtDate(date).find((item) => item.kind === "TS_FORECAST" && item.business_slot === "06:30")), seconds, "opening policy changes future slots only, preserving historical deadlines through DST");
});

test("Tier 0 uses the TS-only runner before same-time full analysis", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-tier0-first-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  store.recordDataSourceStatus(liveSource("2026-08-12T16:30:01.000Z"));
  const calls = [];
  const scheduler = createTimelineScheduler({
    store,
    runTsCore: async (_at, reason) => { calls.push(`TS:${reason}`); return { status: "COMPLETED", runId: "live-shadow:20260812T163000Z" }; },
    runShadow: async (_at, reason) => { calls.push(`FULL:${reason}`); return { status: "COMPLETED", runId: "live-shadow:20260812T163000Z" }; },
    runtimeStartedAt: new Date("2026-08-12T16:30:00.000Z"),
  });
  await scheduler.runOnce(new Date("2026-08-12T16:30:01.000Z"));
  assert.deepEqual(calls.slice(0, 2), ["TS:4070 Live Shadow", "FULL:4070 Live Shadow"]);
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "TS_FORECAST" && item.business_slot === "09:30").terminal_outcome, "DELIVERED");
  store.close();
});

test("A1 heartbeat invokes the isolated external observer without changing its checkpoint", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-external-heartbeat-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  store.recordDataSourceStatus(liveSource("2026-08-12T13:30:46.000Z"));
  const calls = [];
  await createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED" }), monitorExternalExperts: async (at) => { calls.push(at.toISOString()); }, runtimeStartedAt: new Date("2026-08-12T13:30:00.000Z") }).runOnce(new Date("2026-08-12T13:30:46.000Z"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(calls, ["2026-08-12T13:30:46.000Z"]);
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "A1_HEARTBEAT" && item.business_slot === "06:30").status, "SUCCEEDED");
  store.close();
});

test("pending research observers do not overlap or block checkpoints, and graceful stop waits through success or failure", async () => {
  for (const fails of [false, true]) {
    const store = openSnapshotDatabase(":memory:"); let at = new Date("2026-10-01T13:30:46.000Z"), calls = 0, settle;
    const pending = new Promise((resolve, reject) => { settle = () => fails ? reject(new Error("synthetic observer failure")) : resolve(); });
    const scheduler = createTimelineScheduler({ store, now: () => at, runtimeStartedAt: at, runShadow: async () => ({ status: "COMPLETED" }),
      monitorExternalExperts: () => { calls++; return calls === 1 ? pending : Promise.resolve(); } });
    try {
      await scheduler.runOnce(at);
      assert.equal(calls, 1); assert.equal(scheduler.running, true);
      at = new Date("2026-10-01T13:45:46.000Z"); await scheduler.runOnce(at);
      assert.equal(calls, 1, "another heartbeat cannot overlap the pending observer");
      for (const slot of ["0630", "0645"]) assert.ok(store.hasOutput(`checkpoint:timeline:a1_heartbeat:20261001:${slot}`), "the observer does not hold natural checkpoints");
      let stopped = false; const stopping = scheduler.stop().then(() => { stopped = true; });
      await new Promise(setImmediate); assert.equal(stopped, false);
      settle(); await stopping; assert.equal(stopped, true); assert.equal(scheduler.running, false);
      at = new Date("2026-10-01T14:00:46.000Z"); await scheduler.runOnce(at);
      assert.equal(calls, 2, "a completed or rejected observer releases the next natural slot");
    } finally { settle(); await scheduler.stop(); store.close(); }
  }
});

test("Manager rejects a 421-second Robinhood snapshot under the shared freshness contract", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-freshness-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite")), at = new Date("2026-08-12T14:07:01.000Z");
  store.recordDataSourceStatus(liveSource("2026-08-12T14:00:00.000Z"));
  assert.equal(buildCodexManagerReview(store.getActive(), at, "EARLY").issues.some((issue) => issue.code === "MANAGER_DATA_NOT_READY"), true);
  store.close();
});

test("department rechecks complete only after their own natural run is delivered", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-recheck-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  for (const target of ["TS", "D", "COMMITTEE", "A3", "PLATFORM"]) {
    const request = { request_id: `department-recheck:${target}`, target, reason: "复核", requested_at: "2026-08-12T14:20:00.000Z", eligibility: "NEXT_NATURAL_SLOT_ONLY" };
    store.recordCodexManagerEvent({ event_id: `${request.request_id}:requested`, manager_run_id: request.request_id, event_type: "DEPARTMENT_RECHECK_REQUESTED", recorded_at: request.requested_at, payload: { contract_version: "CODEX_PRODUCTION_MANAGER_ACTIVE_V1", request } });
  }
  const runId = (at) => `live-shadow:${at.toISOString().replace(/[-:]/g, "").replace(".000Z", "Z")}`;
  function recordDepartment(agent, at, status = "SUCCEEDED", delivery = "DELIVERED", skill = agent === "A3" ? "A3_FINAL_LIVE_SHADOW" : `${agent}_LIVE_SHADOW`) {
    const id = runId(at);
    for (const [index, step] of (status === "SKIPPED" ? [status] : ["STARTED", "RUNNING", ...(status === "RUNNING" ? [] : [status])]).entries()) {
      const eventAt = new Date(at.getTime() + index + 1).toISOString(), succeeded = step === "SUCCEEDED";
      store.importRunEventRaw(JSON.stringify({ ledger_format: "TRADING_OS_AGENT_RUN_EVENT", ledger_version: 1, event_id: `${id}:${skill}:${step}`, agent_id: agent, skill_id: skill, run_id: id, slot_id: id, channel: "SHADOW", version: "test-v1", data_cutoff_at: at.toISOString(), event_at: eventAt, status: step, output_status: succeeded ? "PRODUCED" : "NOT_PRODUCED", error: step === "SKIPPED" ? "upstream blocked" : step === "FAILED" ? "department failed" : succeeded && delivery === "FAILED" ? "delivery failed" : null, evidence_refs: succeeded ? [`sqlite://output_records/${id}:${agent}`] : [], website_delivery: succeeded ? delivery : "NOT_ATTEMPTED", discord_delivery: "NOT_APPLICABLE" }), eventAt);
    }
  }
  let fullCalls = 0;
  const options = { store, runTsCore: async (at) => { recordDepartment("TS", at); return { status: "COMPLETED", runId: runId(at) }; }, runShadow: async (at) => {
    fullCalls += 1;
    recordDepartment("D", at, fullCalls === 1 ? "RUNNING" : "SUCCEEDED");
    recordDepartment("COMMITTEE", at, fullCalls === 1 ? "SKIPPED" : "SUCCEEDED");
    recordDepartment("A3", at, "SUCCEEDED", "DELIVERED", "A3_REVIEW_LIVE_SHADOW");
    recordDepartment("A3", at, fullCalls === 1 ? "FAILED" : "SUCCEEDED", fullCalls === 2 ? "FAILED" : "DELIVERED");
    return { status: fullCalls < 3 ? "FAILED" : "COMPLETED", runId: runId(at) };
  } };
  const completed = () => store.getCodexManagerEventPayloads("DEPARTMENT_RECHECK_COMPLETED", "completion");
  const scheduler = createTimelineScheduler({ ...options, runtimeStartedAt: new Date("2026-08-12T14:30:00.000Z") });
  await scheduler.runOnce(new Date("2026-08-12T14:30:01.000Z"));
  assert.equal(fullCalls, 0);
  assert.deepEqual(completed().map((item) => item.target), ["TS"]);
  assert.equal(completed()[0].natural_slot_id, "timeline:ts_forecast:20260812:0730");
  await scheduler.runOnce(new Date("2026-08-12T14:30:02.000Z"));
  assert.equal(completed().length, 1);
  for (const at of ["2026-08-12T16:30:00.000Z", "2026-08-12T18:30:00.000Z", "2026-08-13T01:00:00.000Z"]) {
    await createTimelineScheduler({ ...options, runtimeStartedAt: new Date(at) }).runOnce(new Date(Date.parse(at) + 1_000));
    assert.deepEqual(completed().map((item) => item.target).sort(), fullCalls === 1 ? ["TS"] : fullCalls === 2 ? ["COMMITTEE", "D", "TS"] : ["A3", "COMMITTEE", "D", "TS"]);
    assert.ok(completed().every((item) => item.status === "COMPLETED"));
  }
  assert.ok(completed().filter((item) => ["D", "COMMITTEE"].includes(item.target)).every((item) => item.natural_slot_id === "timeline:full_analysis:20260812:1130" && item.run_id === "live-shadow:20260812T183000Z"));
  assert.equal(completed().find((item) => item.target === "A3").run_id, "live-shadow:20260813T010000Z");
  store.close();
});

test("department rechecks reconcile existing successful runs without executing them again", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-reconcile-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite")), at = new Date("2026-08-12T16:30:00.000Z"), runId = "live-shadow:20260812T163000Z";
  const request = { request_id: "department-recheck:existing-A3", target: "A3", reason: "复核", requested_at: "2026-08-12T16:20:00.000Z", eligibility: "NEXT_NATURAL_SLOT_ONLY" };
  store.recordCodexManagerEvent({ event_id: `${request.request_id}:requested`, manager_run_id: request.request_id, event_type: "DEPARTMENT_RECHECK_REQUESTED", recorded_at: request.requested_at, payload: { contract_version: "CODEX_PRODUCTION_MANAGER_ACTIVE_V1", request } });
  for (const agent of ["A1", "A2", "TS", "COMMITTEE", "D", "A3", "CODEX_GUARD"]) {
    for (const [index, status] of ["STARTED", "RUNNING", "SUCCEEDED"].entries()) {
      const eventAt = new Date(at.getTime() + index + 1).toISOString(), succeeded = status === "SUCCEEDED";
      store.importRunEventRaw(JSON.stringify({ ledger_format: "TRADING_OS_AGENT_RUN_EVENT", ledger_version: 1, event_id: `${runId}:${agent}:${status}`, agent_id: agent, skill_id: agent === "A3" ? "A3_FINAL_LIVE_SHADOW" : `${agent}_LIVE_SHADOW`, run_id: runId, slot_id: runId, channel: "SHADOW", version: "test-v1", data_cutoff_at: at.toISOString(), event_at: eventAt, status, output_status: succeeded ? "PRODUCED" : "NOT_PRODUCED", error: null, evidence_refs: succeeded ? [`sqlite://output_records/${runId}:${agent}`] : [], website_delivery: succeeded ? "DELIVERED" : "NOT_ATTEMPTED", discord_delivery: "NOT_APPLICABLE" }), eventAt);
    }
  }
  const beforeRuns = store.getRunsForSlot(runId);
  const scheduler = createTimelineScheduler({ store, runTsCore: async () => assert.fail("existing TS must not rerun"), runShadow: async () => assert.fail("existing FULL must not rerun"), runtimeStartedAt: at });
  await scheduler.runOnce(new Date(at.getTime() + 4_000));
  await scheduler.runOnce(new Date(at.getTime() + 5_000));
  const completions = store.getCodexManagerEventPayloads("DEPARTMENT_RECHECK_COMPLETED", "completion");
  assert.equal(completions.length, 1);
  assert.equal(completions[0].target, "A3");
  assert.equal(completions[0].status, "COMPLETED");
  assert.equal(completions[0].run_id, runId);
  assert.deepEqual(store.getRunsForSlot(runId), beforeRuns);
  store.close();
});

test("Codex manager records one deployment audit in the existing gateway and ledger", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-codex-manager-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  const realManager = [];
  const scheduler = createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED" }), runCodexManager: (trigger, detail) => realManager.push({ trigger, detail }) });
  const at = new Date("2026-08-12T22:00:00.000Z");
  const first = await scheduler.runDeploymentReview(at);
  const second = await scheduler.runDeploymentReview(at);
  assert.equal(first.slot_id, second.slot_id);
  assert.equal(first.manager_review.role, "CODEX_MANAGER");
  assert.equal(first.manager_review.review_type, "POST_DEPLOY");
  assert.equal(first.manager_review.prediction_review.summary, "本轮不是收盘复盘；当天预测由收盘结算单独评价。");
  assert.equal(first.manager_review.company_working, false);
  assert.ok(first.manager_review.owner_todos.length === 0 || first.manager_review.owner_todos.every((item) => typeof item === "string"));
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.filter((item) => item.manager_review).length, 1);
  assert.equal(store.getRunsForSlot(first.slot_id).find((run) => run.agent_id === "CODEX_MANAGER").website_delivery, "DELIVERED");
  assert.equal(realManager[0].trigger, "POST_DEPLOY");
  assert.match(realManager[0].detail, /DETERMINISTIC_MANAGER_REVIEW/);
  store.close();
});

test("Codex manager never treats replay evidence as the current live company slot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-codex-manager-replay-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  const state = store.getActive();
  state.runLedger.runs = [{ channel: "SHADOW", slot_id: "replay-shadow:20260812T140000Z", run_id: "replay-shadow:20260812T140000Z", agent_id: "TS", status: "SUCCEEDED", output_status: "PRODUCED", website_delivery: "DELIVERED" }];
  const review = buildCodexManagerReview(state, new Date("2026-08-12T22:00:00.000Z"), "POST_DEPLOY");
  assert.equal(review.checks.find((item) => item.area === "WEBSITE").status, "PASS");
  assert.ok(!review.issues.some((item) => item.code === "MANAGER_WEBSITE_MISMATCH"));
  store.close();
});

test("Codex manager degrades enhanced macro evidence without misreporting the core market as blocked", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-codex-manager-macro-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  const state = store.getActive();
  const at = "2026-08-12T22:00:00.000Z";
  state.dataSources = [closedSource("2026-08-12T20:00:00.000Z"), { source: "FINNHUB", status: "LIVE", configured: true, authorization: "VALID", last_success_at: at, as_of: at, freshness_seconds: 0, error: null, checked_at: at, capabilities: { news: true } }];
  state.outputs.A1_SHADOW_RESULT = { official_macro: { status: "DEGRADED" } };
  const review = buildCodexManagerReview(state, new Date(at), "POST_DEPLOY");
  assert.equal(review.checks.find((item) => item.area === "DATA").status, "WARNING");
  assert.ok(review.issues.some((item) => item.code === "MANAGER_MACRO_DEGRADED"));
  assert.ok(!review.issues.some((item) => item.code === "MANAGER_DATA_NOT_READY"));
  store.close();
});

test("Codex manager keeps valid partially degraded Finnhub evidence out of the critical Owner queue", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-codex-manager-news-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  const state = store.getActive(), at = "2026-08-12T22:00:00.000Z";
  state.dataSources = [closedSource("2026-08-12T20:00:00.000Z"), { source: "FINNHUB", status: "DEGRADED", configured: true, authorization: "VALID", last_success_at: at, as_of: at, freshness_seconds: 0, error: "新闻超时；财报日历可用", checked_at: at, capabilities: { news: false, earnings_calendar: true, earnings_results: true } }];
  state.selfCheck = { status: "HEALTHY", checked_at: at, last_backup_at: at, active: [], recent: [] };
  const review = buildCodexManagerReview(state, new Date(at), "POST_DEPLOY");
  assert.equal(review.checks.find((item) => item.area === "DATA").status, "WARNING");
  assert.equal(review.status, "DEGRADED");
  assert.equal(review.tomorrow, "CONTINUE_WITH_CAUTION");
  assert.ok(review.issues.some((item) => item.code === "MANAGER_NEWS_DEGRADED" && item.severity === "WARNING"));
  assert.ok(!review.issues.some((item) => item.code === "MANAGER_DATA_NOT_READY"));
  assert.equal(review.owner_todos.length, 0);
  store.close();
});

test("Codex manager never turns an enhanced-news outage into a core-market block", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-codex-manager-news-blocked-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  const state = store.getActive(), at = "2026-08-12T22:00:00.000Z";
  state.dataSources = [closedSource("2026-08-12T20:00:00.000Z"), { source: "FINNHUB", status: "DATA_BLOCKED", configured: true, authorization: "VALID", last_success_at: null, as_of: null, freshness_seconds: null, error: "news unavailable", checked_at: at, capabilities: { news: false } }];
  state.selfCheck = { status: "HEALTHY", checked_at: at, last_backup_at: at, active: [], recent: [] };
  const review = buildCodexManagerReview(state, new Date(at), "POST_DEPLOY");
  assert.equal(review.checks.find((item) => item.area === "DATA").status, "WARNING");
  assert.ok(review.issues.some((item) => item.code === "MANAGER_NEWS_DEGRADED"));
  assert.ok(!review.issues.some((item) => item.code === "MANAGER_DATA_NOT_READY"));
  store.close();
});

test("Codex manager accepts complete official coverage while preserving the strict V2 BLS connector status", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-codex-manager-official-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  const state = store.getActive(), at = "2026-08-12T22:00:00.000Z";
  state.dataSources = [closedSource("2026-08-12T20:00:00.000Z"), { source: "FINNHUB", status: "LIVE", configured: true, authorization: "VALID", last_success_at: at, as_of: at, freshness_seconds: 0, error: null, checked_at: at, capabilities: { news: true } }];
  state.outputs.A1_SHADOW_RESULT = { official_macro: { status: "DEGRADED", coverage: { inflation: "LIVE", employment: "LIVE", central_bank: "LIVE", growth: "LIVE", released_values: "LIVE" }, market_context: { status: "LIVE" } }, market_sources: { market_environment: { rates: { status: "MARKET_CLOSED" }, oil: { status: "MARKET_CLOSED" }, sector_breadth: { status: "MARKET_CLOSED" } } } };
  state.outputs.A2_SHADOW_RESULT = { pattern_evidence: { source_mode: "LIVE", data_grade: "NATURAL_LIVE_SLOT", status: "HEALTHY" } };
  const review = buildCodexManagerReview(state, new Date(at), "POST_DEPLOY");
  assert.equal(review.checks.find((item) => item.area === "DATA").status, "PASS");
  assert.ok(!review.issues.some((item) => ["MANAGER_MACRO_DEGRADED", "MANAGER_MARKET_ENVIRONMENT_DEGRADED", "MANAGER_PATTERN_EVIDENCE_ACCUMULATING"].includes(item.code)));
  store.close();
});

test("Codex manager uses the existing same-slot Shadow recovery once and records the action", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-codex-manager-recovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  const reasons = [];
  const scheduler = createTimelineScheduler({ store, runShadow: async (_at, reason) => { reasons.push(reason); return { status: "DATA_BLOCKED" }; } });
  await scheduler.runOnce(new Date("2026-08-12T14:05:00.000Z"));
  const checkpoint = store.getActive().outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "CODEX_MANAGER");
  assert.deepEqual(reasons, ["开盘30分钟验证", "Codex 经理安全恢复"]);
  assert.match(checkpoint.manager_review.actions_taken[0], /同槽 Shadow 防重恢复：DATA_BLOCKED/);
  assert.equal(checkpoint.manager_review.status, "BLOCKED");
  assert.equal(checkpoint.manager_review.owner_todos.length, 0);
  assert.equal(checkpoint.manager_review.tomorrow, "CONTINUE_WITH_CAUTION");
  store.close();
});

test("current health excludes bootstrap history but preserves genuine current misses", () => {
  const slots = timelineOccurrencesForPtDate("2026-08-12").filter((item) => item.kind === "POSITION_MONITOR");
  const checkpoint = (slot, completedAt) => ({ ...slot, contract_version: "v1", role: "TIMELINE_SCHEDULER", status: "MISSED", started_at: null, completed_at: completedAt, late_seconds: Math.floor((Date.parse(completedAt) - Date.parse(slot.scheduled_at)) / 1_000), result_ref: null, reason: "MISSED" });
  const historical = checkpoint(slots[0], "2026-08-12T15:00:00.000Z");
  const current = checkpoint(slots.find((item) => item.business_slot === "09:00"), "2026-08-12T16:01:00.000Z");
  const state = schedulerState([current, historical], new Date("2026-08-12T20:00:00.000Z"), "2026-08-12T15:00:00.000Z");
  assert.equal(state.today.missed, 1);
  assert.equal(state.health_window.missed, 1);
  assert.equal(state.health_window.historical_missed, 1);
  assert.equal(state.health_window.initialization_missed, 1);
  assert.ok(state.today.expected < timelineOccurrencesForPtDate("2026-08-12").length);
  assert.deepEqual(state.recent.map((item) => item.slot_id), [current.slot_id]);
});

test("first startup archives expired slots without manufacturing MISSED while later misses still alert", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-bootstrap-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  const scheduler = createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED" }) });
  assert.equal((await scheduler.runOnce(new Date("2026-08-12T13:31:00.000Z"))).processed, 4);
  assert.equal(store.getActive().scheduler.health_window.missed, 0);
  assert.equal(store.getActive().scheduler.health_window.initialization_missed, 0);
  await scheduler.runOnce(new Date("2026-08-12T14:00:00.000Z"));
  const missed = store.getActive().outputs.SCHEDULE_CHECKPOINT.find((item) => item.status === "MISSED");
  assert.ok(missed);
  assert.deepEqual(store.getRunsForSlot(missed.slot_id).map((run) => [run.status, run.output_status, run.website_delivery]), [["SKIPPED", "NOT_PRODUCED", "NOT_ATTEMPTED"]]);
  store.close();
});

test("scheduler records gateway and ledger once, persists restart, and never backfills missed evidence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-"));
  const file = join(directory, "scheduler.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  let shadowCalls = 0;
  const store = openSnapshotDatabase(file);
  store.recordDataSourceStatus(liveSource("2026-08-12T13:31:00.000Z"));
  const scheduler = createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED", runId: `shadow-${++shadowCalls}` }) });
  const first = await scheduler.runOnce(new Date("2026-08-12T13:31:00.000Z"));
  assert.equal(first.status, "COMPLETED");
  assert.equal(first.processed, 4);
  assert.equal(shadowCalls, 2);
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.length, 4);
  assert.equal(store.getRunsForSlot("timeline:ts_forecast:20260812:0630")[0].website_delivery, "DELIVERED");
  assert.equal((await scheduler.runOnce(new Date("2026-08-12T13:31:00.000Z"))).processed, 0);
  store.close();

  const restarted = openSnapshotDatabase(file);
  assert.equal(restarted.getActive().outputs.SCHEDULE_CHECKPOINT.length, 4);
  restarted.recordDataSourceStatus(liveSource("2026-08-12T14:00:00.000Z"));
  const later = createTimelineScheduler({ store: restarted, runShadow: async () => ({ status: "COMPLETED" }) });
  assert.ok((await later.runOnce(new Date("2026-08-12T14:00:00.000Z"))).processed > 0);
  assert.equal(restarted.getOutputRaw("checkpoint:timeline:position_monitor:20260812:0631"), null);
  assert.ok(restarted.getOutputRaw("checkpoint:timeline:ts_forecast:20260812:0700"));
  restarted.close();
});

test("overnight restart never catches up slots from before this process", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-restart-"));
  const file = join(directory, "scheduler.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  let store = openSnapshotDatabase(file);
  await createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED" }) }).runOnce(new Date("2026-08-13T13:31:00.000Z"));
  const before = store.getActive().outputCount;
  store.close();
  store = openSnapshotDatabase(file);
  const reboot = createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED" }), runtimeStartedAt: new Date("2026-08-21T02:20:00.000Z") });
  assert.equal((await reboot.runOnce(new Date("2026-08-21T02:20:00.000Z"))).processed, 0);
  assert.equal(store.getActive().outputCount, before);
  assert.ok(!store.getActive().outputs.SCHEDULE_CHECKPOINT.some((item) => item.scheduled_pt.startsWith("2026-08-20")));
  store.close();
});

test("Owner shutdown annotation preserves raw evidence but removes it from natural statistics", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-planned-shutdown-"));
  const file = join(directory, "scheduler.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(file);
  store.recordDataSourceStatus(liveSource("2026-08-12T13:31:00.000Z"));
  const scheduler = createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED", runId: "shadow-planned" }) });
  await scheduler.runOnce(new Date("2026-08-12T13:31:00.000Z"));
  const rawCheckpoints = store.getActive().outputs.SCHEDULE_CHECKPOINT;
  const rawEventCount = store.getActive().runLedger.eventCount;
  const input = { kind: "PLANNED_OWNER_SHUTDOWN", started_at: "2026-08-12T13:29:00.000Z", ended_at: "2026-08-12T13:32:00.000Z", recorded_at: "2026-08-12T14:00:00.000Z", actor: "OWNER", note: "Owner 主动关机窗口，事后确认不计自然运行。" };
  const first = store.recordOperationalAnnotation(input);
  const second = store.recordOperationalAnnotation({ ...input, recorded_at: "2026-08-12T14:01:00.000Z" });
  assert.throws(() => store.recordOperationalAnnotation({ ...input, actor: "SYSTEM" }), /Owner/);
  assert.throws(() => store.recordOperationalAnnotation({ ...input, kind: "STARTUP_RECOVERY" }), /系统/);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.annotation.recorded_at, first.annotation.recorded_at);
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.length, rawCheckpoints.length);
  assert.equal(store.getActive().runLedger.eventCount, rawEventCount);
  assert.equal(store.getActive().runLedger.runs.length, 0);
  const state = schedulerState(rawCheckpoints, new Date("2026-08-12T13:31:00.000Z"), "2026-08-12T13:29:00.000Z", store.listOperationalAnnotations());
  assert.equal(state.today.completed, 0);
  assert.equal(state.recent.length, 0);
  store.close();

  const database = new DatabaseSync(file);
  assert.throws(() => database.exec("UPDATE operational_annotations SET note = 'changed'"), /append-only/);
  assert.throws(() => database.exec("DELETE FROM operational_annotations"), /append-only/);
  database.close();
});

test("natural, planned, unexpected, startup and replay evidence stay distinct", () => {
  const item = { slot_id: "timeline:ts_forecast:20260812:0630", scheduled_at: "2026-08-12T13:30:00.000Z" };
  const planned = [{ contract_version: "v1", annotation_id: "planned", kind: "PLANNED_OWNER_SHUTDOWN", started_at: "2026-08-12T13:00:00.000Z", ended_at: "2026-08-12T14:00:00.000Z", recorded_at: "2026-08-12T15:00:00.000Z", actor: "OWNER", note: "planned", canonical_sha256: "planned" }];
  const unexpected = [{ ...planned[0], annotation_id: "unexpected", kind: "UNPLANNED_INTERRUPTION", canonical_sha256: "unexpected" }];
  assert.equal(operationalEvidenceMode(item), "NATURAL");
  assert.equal(operationalEvidenceMode(item, planned), "PLANNED_OWNER_SHUTDOWN");
  assert.equal(eligibleForSuccessStatistics(item, planned), false);
  assert.equal(eligibleForFaultStatistics(item, planned), false);
  assert.equal(eligibleForSuccessStatistics(item, unexpected), false);
  assert.equal(eligibleForFaultStatistics(item, unexpected), true);
  assert.equal(operationalEvidenceMode({ ...item, scheduled_at: "2026-08-12T15:00:00.000Z" }, planned), "NATURAL");
  assert.equal(operationalEvidenceMode({ ...item, slot_id: "codex-manager:deploy:legacy" }), "STARTUP_RECOVERY");
  assert.equal(operationalEvidenceMode({ ...item, slot_id: "replay-shadow:legacy" }), "MANUAL_REPLAY");
});

test("scheduler defers stale natural analysis until data recovers inside its grace window", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-overlap-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  store.recordDataSourceStatus(closedSource("2026-08-21T20:00:00.000Z"));
  let shadowCalls = 0;
  const scheduler = createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED", runId: `shadow-${++shadowCalls}` }), runtimeStartedAt: new Date("2026-08-24T13:30:00.000Z") });
  await scheduler.runOnce(new Date("2026-08-24T13:31:00.000Z"));
  assert.equal(shadowCalls, 0);
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.some((item) => ["TS_FORECAST", "FULL_ANALYSIS"].includes(item.kind)), false);
  store.recordDataSourceStatus(liveSource("2026-08-24T13:35:00.000Z"));
  await scheduler.runOnce(new Date("2026-08-24T13:35:00.000Z"));
  assert.equal(shadowCalls, 2);
  const recovered = store.getActive().outputs.SCHEDULE_CHECKPOINT.filter((item) => ["TS_FORECAST", "FULL_ANALYSIS"].includes(item.kind));
  assert.equal(recovered.every((item) => item.status === "SUCCEEDED" && item.started_at === "2026-08-24T13:35:00.000Z" && item.late_seconds === 300), true);
  store.close();
});

test("scheduler finalizes an exhausted opening recovery window as data blocked", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-opening-blocked-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  store.recordDataSourceStatus(liveSource("2026-08-12T12:00:00.000Z"));
  let shadowCalls = 0;
  const scheduler = createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED", runId: `shadow-${++shadowCalls}` }), runtimeStartedAt: new Date("2026-08-12T13:30:00.000Z") });
  await scheduler.runOnce(new Date("2026-08-12T13:31:00.000Z"));
  store.close();
  const restarted = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  const resumed = createTimelineScheduler({ store: restarted, runShadow: async () => ({ status: "COMPLETED", runId: `shadow-${++shadowCalls}` }), runtimeStartedAt: new Date("2026-08-12T13:35:30.000Z") });
  await resumed.runOnce(new Date("2026-08-12T13:35:30.000Z"));
  await resumed.runOnce(new Date("2026-08-12T13:40:30.000Z"));
  const opening = restarted.getActive().outputs.SCHEDULE_CHECKPOINT.filter((item) => ["TS_FORECAST", "FULL_ANALYSIS"].includes(item.kind) && item.business_slot === "06:30");
  assert.equal(opening.length, 2);
  assert.deepEqual(opening.map((item) => [item.kind, item.status, item.late_seconds]), [["FULL_ANALYSIS", "DATA_BLOCKED", 630], ["TS_FORECAST", "DATA_BLOCKED", 330]]);
  assert.equal(shadowCalls, 0);
  restarted.close();
});

test("scheduler refuses to build an opening forecast from a post-deadline poll", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-opening-jitter-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  store.recordDataSourceStatus(closedSource("2026-08-21T20:00:00.000Z"));
  let shadowCalls = 0;
  const scheduler = createTimelineScheduler({ store, runShadow: async () => { if (++shadowCalls === 1) store.recordDataSourceStatus(liveSource("2026-08-24T13:35:06.000Z")); return { status: "COMPLETED", runId: `shadow-${shadowCalls}` }; }, runtimeStartedAt: new Date("2026-08-24T13:30:00.000Z") });
  await scheduler.runOnce(new Date("2026-08-24T13:31:00.000Z"));
  store.recordDataSourceStatus(liveSource("2026-08-24T13:34:55.000Z"));
  await scheduler.runOnce(new Date("2026-08-24T13:35:05.000Z"));
  const opening = ["ts_forecast", "full_analysis"].map((kind) => JSON.parse(store.getOutputRaw(`checkpoint:timeline:${kind}:20260824:0630`)).payload);
  assert.equal(opening.every((item) => item.status === "FAILED" && item.started_at === "2026-08-24T13:35:05.000Z" && item.late_seconds === 305), true, JSON.stringify(opening));
  assert.match(opening.find((item) => item.kind === "TS_FORECAST").reason, /禁止使用截止后证据/);
  assert.match(opening.find((item) => item.kind === "FULL_ANALYSIS").reason, /FULL不重跑或改写/);
  assert.equal(opening.find((item) => item.kind === "TS_FORECAST").terminal_outcome, "SYSTEM_BLOCKED");
  assert.equal(shadowCalls, 0);
  store.close();
});

test("scheduler never finalizes a persisted opening wait after its poll window", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-opening-expired-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "scheduler.sqlite");
  let store = openSnapshotDatabase(file);
  store.recordDataSourceStatus(closedSource("2026-08-21T20:00:00.000Z"));
  await createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED" }), runtimeStartedAt: new Date("2026-08-24T13:30:00.000Z") }).runOnce(new Date("2026-08-24T13:31:00.000Z"));
  store.close();
  store = openSnapshotDatabase(file);
  await createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED" }), runtimeStartedAt: new Date("2026-08-24T14:00:00.000Z") }).runOnce(new Date("2026-08-24T14:00:00.000Z"));
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.some((item) => ["TS_FORECAST", "FULL_ANALYSIS"].includes(item.kind) && item.business_slot === "06:30"), false);
  store.close();
});

test("scheduler records an opening wait as missed after event-loop expiry", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-opening-late-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  store.recordDataSourceStatus(closedSource("2026-08-21T20:00:00.000Z"));
  const scheduler = createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED" }), runtimeStartedAt: new Date("2026-08-24T13:30:00.000Z") });
  await scheduler.runOnce(new Date("2026-08-24T13:31:00.000Z"));
  await new Promise((resolve) => setImmediate(resolve));
  await scheduler.runOnce(new Date("2026-08-24T14:00:00.000Z"));
  const opening = ["ts_forecast", "full_analysis"].map((kind) => JSON.parse(store.getOutputRaw(`checkpoint:timeline:${kind}:20260824:0630`)).payload);
  assert.equal(opening.length, 2);
  assert.equal(opening.every((item) => item.status === "MISSED" && item.started_at === null), true);
  store.close();
});

test("scheduler rejects overlapping manual audits", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-overlap-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  store.recordDataSourceStatus(liveSource("2026-08-12T13:31:00.000Z"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createTimelineScheduler({ store, runShadow: async () => { await gate; return { status: "DATA_BLOCKED" }; } });
  const active = scheduler.runOnce(new Date("2026-08-12T13:31:00.000Z"));
  assert.deepEqual(await scheduler.runOnce(new Date("2026-08-12T13:31:00.000Z")), { status: "OVERLAP_REJECTED", processed: 0 });
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  release();
  await Promise.all([active, stopping]);
  assert.equal(stopped, true);
  const heartbeat = store.getActive().outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "A1_HEARTBEAT");
  assert.equal(heartbeat.status, "SUCCEEDED");
  store.close();
});

test("scheduled Shadow work does not block minute checkpoints", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-detached-shadow-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  let current = new Date("2026-08-12T13:30:10.000Z"), release;
  store.recordDataSourceStatus(liveSource(current.toISOString()));
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createTimelineScheduler({ store, now: () => current, intervalMs: 5, runtimeStartedAt: current, monitorPositions: async () => ({ checked_at: current.toISOString(), account_status: "LIVE", account_as_of: current.toISOString(), checks_completed: true, status: "CHECKED", automated_execution: false, observations: [], data_gaps: [] }), runShadow: async () => { await gate; return { status: "COMPLETED", runId: "shadow-detached" }; } });
  await scheduler.runOnce(current, true);
  current = new Date("2026-08-12T13:31:00.000Z");
  store.recordDataSourceStatus(liveSource(current.toISOString()));
  await scheduler.runOnce(current, true);
  const checkpoints = store.getActive().outputs.SCHEDULE_CHECKPOINT;
  assert.equal(checkpoints.some((item) => item.kind === "POSITION_MONITOR" && item.business_slot === "06:30" && item.status === "SUCCEEDED"), true);
  assert.equal(checkpoints.some((item) => item.kind === "A1_HEARTBEAT" && item.business_slot === "06:30" && item.status === "SUCCEEDED"), true);
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(stopped, true);
  store.close();
});

for (const failed of [false, true]) test(`slow maintenance preserves opening and 06:45 dispatch, then records ${failed ? "failure" : "success"}`, async () => {
  const store = openSnapshotDatabase(":memory:");
  let current = new Date("2026-10-01T13:33:31.000Z"), release, reject, checks = 0;
  const maintenance = new Promise((accept, fail) => { release = accept; reject = fail; });
  store.checkDatabase = () => { checks++; return maintenance; };
  store.getActiveAsync = async () => { throw new Error("background dispatch must not rebuild the full owner snapshot"); };
  const forecasts = [], paperTicks = [];
  const scheduler = createTimelineScheduler({ store, now: () => current, runtimeStartedAt: current,
    runTsCore: async (at) => { forecasts.push(at.toISOString()); return { status: "COMPLETED" }; },
    runShadow: async () => ({ status: "COMPLETED" }),
    monitorExternalExperts: async (at) => { paperTicks.push(at.toISOString()); },
  });
  const poll = async () => {
    store.recordDataSourceStatus(liveSource(current.toISOString()));
    let timer;
    try { return await Promise.race([scheduler.runOnce(current, true), new Promise((_, fail) => { timer = setTimeout(() => fail(new Error("maintenance held natural dispatch")), 1000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    assert.equal((await poll()).status, "COMPLETED");
    assert.equal(checks, 1);
    current = new Date("2026-10-01T13:35:01.000Z");
    await poll();
    current = new Date("2026-10-01T13:45:46.000Z");
    await poll();
    await new Promise((accept) => setImmediate(accept));
    assert.ok(forecasts.includes("2026-10-01T13:30:00.000Z"));
    assert.ok(forecasts.includes("2026-10-01T13:45:00.000Z"));
    assert.ok(paperTicks.includes(current.toISOString()), "the existing A1 heartbeat/PAPER callback must still dispatch");
    assert.equal(checks, 1, "later guard slots must not start overlapping full scans");
    const checkpointId = "checkpoint:timeline:local_guard:20261001:0633";
    assert.equal(store.getOutputRaw(checkpointId), null, "unfinished maintenance is not marked successful");
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await new Promise((accept) => setImmediate(accept));
    assert.equal(stopped, false, "stop must retain the unfinished maintenance task");
    if (failed) reject(new Error("synthetic maintenance failure")); else release();
    await stopping;
    const checkpoint = JSON.parse(store.getOutputRaw(checkpointId)).payload;
    assert.equal(checkpoint.status, failed ? "FAILED" : "SUCCEEDED");
    if (failed) assert.match(checkpoint.reason, /synthetic maintenance failure/);
    assert.equal(scheduler.running, false);
  } finally { release(); await scheduler.stop(); store.close(); }
});

test("dependent checkpoints wait for detached Shadow completion", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-shadow-dependent-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  let current = new Date("2026-08-25T01:00:01.000Z"), release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createTimelineScheduler({ store, now: () => current, intervalMs: 5, runtimeStartedAt: current, runShadow: async () => { await gate; return { status: "COMPLETED", runId: "live-shadow:20260825T010000Z" }; } });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  current = new Date("2026-08-25T01:11:01.000Z");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.some((item) => item.kind === "EVENING_LOCAL_GUARD"), false);
  release();
  await scheduler.stop();
  assert.equal(store.getActive("forecast").outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "EVENING_ANALYSIS")?.status, "SUCCEEDED");
  current = new Date("2026-08-25T01:11:30.000Z");
  await scheduler.runOnce(current);
  const guard = store.getActive().outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "EVENING_LOCAL_GUARD");
  assert.equal(guard?.status, "SUCCEEDED");
  await scheduler.stop();
  store.close();
});

test("daily review waits for detached evening Shadow completion", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-daily-dependent-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  let current = new Date("2026-08-25T01:00:01.000Z"), release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createTimelineScheduler({ store, now: () => current, intervalMs: 5, runtimeStartedAt: current, runShadow: async () => { await gate; return { status: "COMPLETED", runId: "live-shadow:20260825T010000Z" }; } });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  current = new Date("2026-08-25T01:20:01.000Z");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.some((item) => item.kind === "DAILY_REVIEW"), false);
  release();
  await scheduler.stop();
  current = new Date("2026-08-25T01:20:30.000Z");
  await scheduler.runOnce(current);
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.some((item) => item.kind === "DAILY_REVIEW"), true);
  store.close();
});

test("13:50 settlement checkpoint runs the SQLite settlement executor", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-settlement-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  const scheduler = createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED" }) });
  await scheduler.runOnce(new Date("2026-08-12T20:50:30.000Z"));
  const checkpoint = store.getActive().outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "TS_SETTLEMENT");
  assert.equal(checkpoint.status, "SUCCEEDED");
  assert.match(checkpoint.reason, /自动结算完成/);
  assert.equal(checkpoint.result_ref, "sqlite://ts_forecast_settlements");
  store.close();
});

test("Codex manager reviews immutable LIVE settlements instead of replay or the latest quote", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-codex-manager-settlement-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "manager.sqlite"));
  const state = store.getActive();
  state.tsSettlement.recent = [{
    forecast_run_id: "live-shadow:forecast-1", published_at: "2026-08-12T13:30:00.000Z", market_date: "2026-08-12", slot: "06:30", phase: "INITIAL", report_type: "OPENING_FORECAST", source_mode: "LIVE", eligibility: "OFFICIAL_LIVE", one_line_forecast: "test", path_bias: "BULLISH",
    settlement: { status: "RESOLVED", symbols: { SPY: { direction_correct: true }, QQQ: { direction_correct: true } } },
  }];
  const review = buildCodexManagerReview(state, new Date("2026-08-12T22:00:00.000Z"), "DAILY_CLOSE");
  assert.equal(review.prediction_review.status, "CONFIRMED");
  assert.match(review.prediction_review.summary, /初始判断06:30：已结算/);
  assert.match(review.prediction_review.summary, /样本 1/);
  store.close();
});

test("scheduler treats valid EOD as closed, preserves exact V2 reasons and never invents live data", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-eod-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  store.recordDataSourceStatus(closedSource("2026-08-12T20:00:31.000Z"));
  const reasons = [];
  const scheduler = createTimelineScheduler({ store, runShadow: async (_at, reason) => { reasons.push(reason); return { status: "COMPLETED", runId: `shadow-${reasons.length}` }; } });
  await scheduler.runOnce(new Date("2026-08-12T20:00:31.000Z"));
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "POSITION_MONITOR").status, "SKIPPED_MARKET_CLOSED");
  await scheduler.runOnce(new Date("2026-08-13T01:00:01.000Z"));
  assert.deepEqual(reasons, ["次日提前分析"]);
  store.close();
});

test("real-position checks respect regular and early closing times without weekend provider reads", async () => {
  for (const [stamp, expected] of [
    ["2026-10-01T19:59:31.000Z", "SUCCEEDED"],
    ["2026-10-01T20:00:31.000Z", "SKIPPED_MARKET_CLOSED"],
    ["2026-11-27T17:59:31.000Z", "SUCCEEDED"],
    ["2026-11-27T18:00:31.000Z", "SKIPPED_MARKET_CLOSED"],
    ["2026-10-03T19:59:31.000Z", null],
  ]) {
    const store = openSnapshotDatabase(":memory:"), at = new Date(stamp), calls = [];
    try {
      const scheduler = createTimelineScheduler({ store, now: () => at, runtimeStartedAt: at, runShadow: async () => ({ status: "COMPLETED" }),
        monitorPositions: async (checkedAt) => { calls.push(checkedAt.toISOString()); return { checked_at: stamp, account_status: "LIVE", account_as_of: stamp, checks_completed: true, status: "CHECKED", automated_execution: false, observations: [], data_gaps: [] }; } });
      await scheduler.runOnce(at);
      const checks = store.getActive().outputs.SCHEDULE_CHECKPOINT.filter((item) => item.kind === "POSITION_MONITOR");
      assert.equal(calls.length > 0, expected === "SUCCEEDED", stamp);
      if (expected === null) assert.equal(checks.length, 0, "weekends have no position slots or provider reads");
      else { assert.ok(checks.length > 0, stamp); assert.ok(checks.every((item) => item.status === expected), stamp); }
    } finally { store.close(); }
  }
});

test("final live quote at the closing boundary is a normal market close, not a data outage", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-scheduler-close-boundary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "scheduler.sqlite"));
  store.recordDataSourceStatus(liveSource("2026-08-12T19:55:00.000Z"));
  const scheduler = createTimelineScheduler({ store, runShadow: async () => ({ status: "COMPLETED" }) });
  await scheduler.runOnce(new Date("2026-08-12T20:00:46.000Z"));
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "A1_HEARTBEAT" && item.business_slot === "13:00").status, "SKIPPED_MARKET_CLOSED");
  store.close();
});
