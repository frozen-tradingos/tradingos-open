import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildCurrentTruth } from "../app/current-truth.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { scheduleLedgerSupervision } from "../server/codex-production-manager.ts";

const eventAt = "2026-08-27T18:32:00.000Z";
const slotId = "live-shadow:20260827T183000Z";
const forecastId = "20260827T183140Z-97453b906b";
const run = (agent_id) => ({ ledger_format: "TRADING_OS_AGENT_RUN_EVENT", ledger_version: 1, event_id: `${agent_id}-terminal`, agent_id, skill_id: agent_id, run_id: slotId, slot_id: slotId, channel: "SHADOW", version: "v1", data_cutoff_at: eventAt, event_at: eventAt, status: "SUCCEEDED", output_status: "PRODUCED", error: null, evidence_refs: ["natural"], website_delivery: "DELIVERED", discord_delivery: "NOT_APPLICABLE", received_at: eventAt });
const source = (overrides = {}) => ({ source: "ROBINHOOD", status: "LIVE", configured: true, authorization: "VALID", last_success_at: eventAt, as_of: eventAt, freshness_seconds: 0, error: null, checked_at: eventAt, capabilities: { market_quotes: true, intraday_bars: true }, ...overrides });
const incident = (id, details = {}) => ({ incident_id: id, fingerprint: id, layer: "SCHEDULER", code: "TS_CORE_SLOT_INCOMPLETE", severity: "CRITICAL", status: "ACTIVE", title: "正式槽异常", first_detected_at: eventAt, last_seen_at: eventAt, resolved_at: null, run_id: slotId, suggestion: "自动复查", occurrences: 1, complaint_id: `complaint-${id}`, details: { affected_modules: ["TS Core"], owner_required: false, ...details } });
const base = {
  runLedger: { agents: [], skills: [], routes: [], eventCount: 3, runs: [run("A1"), run("A2"), run("TS")] },
  selfCheck: { status: "HEALTHY", checked_at: eventAt, last_backup_at: null, active: [], recent: [] },
  dataSources: [source()],
  spxwProxy: { mode: "SPY_SPXW_PROXY", spx_spot_status: "DATA_BLOCKED", analysis_basis: "SPY", reference_index: "SPX", product: "SPX_SPXW_OPTIONS", watches: [], real_holdings: [], owner_observations: [] },
  ownerQueue: { open_complaints: 0, pending_approval: 0, total_complaints: 8, closed_complaints: 8 },
  outputs: { TS_SHADOW_OUTPUT: [{ report_type: "INTRADAY_30_60M", evidence_snapshot: { run_id: forecastId, release_commit: "a".repeat(40), market_time: { market_date: "2026-08-27", observed_at: eventAt } } }] },
  tsCoreOwnership: { slot_id: slotId, run_id: slotId, lease_acquired_at: "2026-08-27T18:30:10.274Z", status: "TERMINAL", terminal_outcome: "NO_TRADE", forecast_id: forecastId, delivery_record_id: `${slotId}:TS`, updated_at: "2026-08-27T18:32:58.745Z" },
  tsCoreDeliveryExists: true,
};

test("Tier 0 ownership is terminal with A1/A2/TS only and later Bar staleness cannot reopen it", () => {
  const completed = buildCurrentTruth(base, "2026-08-27T18:33:00.000Z");
  assert.deepEqual([completed.natural_slot.contract, completed.natural_slot.required_departments, completed.natural_slot.status, completed.natural_slot.terminal_state, completed.active_slot_id, completed.delivery_status], ["TS_CORE_TIER0", ["A1", "A2", "TS"], "SUCCEEDED", "NO_TRADE", null, "DELIVERED"]);
  const stale = buildCurrentTruth({ ...base, dataSources: [source({ status: "STALE", capabilities: { market_quotes: true, intraday_bars: false } })] }, "2026-08-27T18:40:00.000Z");
  assert.deepEqual([stale.natural_slot.status, stale.natural_slot.terminal_state, stale.market_data_health.classification, stale.market_data_health.quote_health, stale.market_data_health.bar_health, stale.next_slot_qualification.status], ["SUCCEEDED", "NO_TRADE", "SOURCE_GAP", "STALE", "STALE", "BLOCKED"]);
});

test("old capability flags cannot keep a stalled source live or the current session healthy", () => {
  for (const status of ["LIVE", "STALE", "DEGRADED"]) {
    const truth = buildCurrentTruth({ ...base, dataSources: [source({ status, capabilities: { market_quotes: false, intraday_bars: true } })] }, "2026-08-27T18:53:00.000Z");
    assert.deepEqual([truth.market_data_health.bar_health, truth.next_slot_qualification.status, truth.health_status], ["STALE", "BLOCKED", "DEGRADED"]);
    assert.equal(truth.natural_slot.terminal_state, "NO_TRADE");
  }
  const freshQuote = buildCurrentTruth({ ...base, dataSources: [source({ status: "STALE", checked_at: "2026-08-27T18:53:00.000Z", capabilities: { market_quotes: true, intraday_bars: false } })] }, "2026-08-27T18:53:00.000Z");
  assert.equal(freshQuote.market_data_health.quote_health, "LIVE");
  const boundary = buildCurrentTruth({ ...base, dataSources: [source({ status: "DEGRADED", capabilities: { market_quotes: false, intraday_bars: true } })] }, "2026-08-27T18:39:00.000Z");
  assert.equal(boundary.market_data_health.bar_health, "LIVE");
  for (const changes of [
    { checked_at: "2026-08-28T04:00:00Z" },
    { capabilities: { market_quotes: false, intraday_bars: false } },
    { as_of: "2026-08-28T06:00:00Z" },
    { checked_at: "2026-08-28T06:00:00Z" },
  ]) {
    const overnight = buildCurrentTruth({ ...base, dataSources: [source({ status: "STALE", as_of: "2026-08-28T05:45:00Z", checked_at: "2026-08-28T05:49:00Z", capabilities: { market_quotes: false, intraday_bars: true }, ...changes })] }, "2026-08-28T05:49:00Z");
    assert.equal(overnight.market_data_health.bar_health, "STALE");
    assert.equal(overnight.next_slot_qualification.status, "BLOCKED");
  }
});

test("a formerly live source blocks the next slot after 420 seconds", () => {
  const stale = buildCurrentTruth({ ...base, dataSources: [source({ as_of: eventAt, checked_at: eventAt })] }, "2026-08-27T18:39:01.000Z");
  assert.deepEqual([stale.data_sources[0].status, stale.market_data_health.classification, stale.market_data_health.bar_health, stale.next_slot_qualification.status], ["STALE", "SOURCE_GAP", "STALE", "BLOCKED"]);
});

test("a valid market close waits without hiding the frozen slot or weakening the open-market freshness gate", () => {
  const closed = buildCurrentTruth({ ...base, dataSources: [source({ status: "MARKET_CLOSED", as_of: "2026-08-28T20:00:00.000Z", checked_at: "2026-08-29T03:20:00.000Z", capabilities: { market_quotes: false, intraday_bars: false } })] }, "2026-08-29T03:20:00.000Z");
  assert.deepEqual([closed.natural_slot.status, closed.natural_slot.terminal_state, closed.market_data_health.classification, closed.market_data_health.quote_health, closed.market_data_health.bar_health, closed.next_slot_qualification.status], ["SUCCEEDED", "NO_TRADE", "MARKET_CLOSED", "MARKET_CLOSED", "MARKET_CLOSED", "WAITING"]);
  assert.match(closed.next_slot_qualification.reason, /不算运行故障/);
});

test("historical failures stay visible without becoming current Owner work and one root stays one issue", () => {
  const current = incident("current-a", { root_cause_id: "same-root" }), duplicate = incident("current-b", { root_cause_id: "same-root", affected_modules: ["Owner Delivery"], owner_required: true }), historical = incident("old-failure", { evidence_scope: "HISTORICAL" });
  const truth = buildCurrentTruth({ ...base, selfCheck: { ...base.selfCheck, active: [current, duplicate, historical], recent: [] } }, "2026-08-27T18:33:00.000Z");
  assert.deepEqual([truth.issues.current_unresolved, truth.issues.lifecycle.filter((item) => item.status === "HISTORICAL").length, truth.issues.lifecycle.find((item) => item.root_cause_id === "same-root").affected_components.sort(), truth.owner_action_required], [1, 1, ["Owner Delivery", "TS Core"], true]);
});

test("a Manager chain with an unavailable root remains historical", () => {
  const parent = { ...incident("manager-parent"), fingerprint: "missing-root", layer: "MANAGER", code: "CODEX_MANAGER_REVIEW" };
  const child = { ...incident("manager-child"), fingerprint: parent.incident_id, layer: "MANAGER", code: "CODEX_MANAGER_REVIEW" };
  const truth = buildCurrentTruth({ ...base, selfCheck: { ...base.selfCheck, active: [child, parent], recent: [] } }, "2026-08-27T18:33:00.000Z");
  assert.deepEqual([truth.issues.current_unresolved, truth.issues.lifecycle.map((item) => item.status)], [0, ["HISTORICAL", "HISTORICAL"]]);
});

test("ownership delivery identity is not delivery proof", () => {
  const failedRun = { ...run("TS"), website_delivery: "FAILED" };
  const truth = buildCurrentTruth({ ...base, runLedger: { ...base.runLedger, runs: [run("A1"), run("A2"), failedRun] }, tsCoreDeliveryExists: false }, "2026-08-27T18:33:00.000Z");
  assert.deepEqual([truth.delivery_status, truth.natural_slot.statistical_eligibility], ["FAILED", "NOT_FINAL"]);
});

test("a prior trading date ownership cannot project its forecast as current", () => {
  const truth = buildCurrentTruth(base, "2026-08-28T00:30:00.000Z");
  assert.equal(truth.trading_date, "2026-08-28");
  assert.equal(truth.forecast_id, null);
  assert.deepEqual([truth.natural_slot.frozen_at, truth.natural_slot.recorded_at, truth.departments.slice(0, 3).map((item) => item.status), truth.natural_slot.statistical_eligibility], [eventAt, eventAt, ["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"], "ELIGIBLE_NATURAL_EVIDENCE"]);
});

test("an ownership can only project its exact forecast identity", () => {
  const truth = buildCurrentTruth({ ...base, tsCoreOwnership: { ...base.tsCoreOwnership, forecast_id: "different-forecast" } }, "2026-08-27T18:33:00.000Z");
  assert.deepEqual([truth.forecast_id, truth.delivery_status, truth.natural_slot.statistical_eligibility], [null, "DELIVERED", "NOT_FINAL"]);
});

test("a current leased ownership is projected before the first run event", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "current-truth-lease-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "truth.sqlite")), now = new Date(), compact = now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z"), currentSlotId = `live-shadow:${compact}`;
  store.claimTsCoreSlot(currentSlotId, currentSlotId, "test-owner", now.toISOString());
  const truth = store.getActive().currentTruth;
  assert.deepEqual([truth.natural_slot.slot_id, truth.natural_slot.contract, truth.slot_status, truth.active_slot_id], [currentSlotId, "TS_CORE_TIER0", "RUNNING", currentSlotId]);
  store.close();
});

test("a terminal ownership without a run event is still the latest formal slot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "current-truth-terminal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "truth.sqlite")), now = new Date(), compact = now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z"), currentSlotId = `live-shadow:${compact}`;
  store.claimTsCoreSlot(currentSlotId, currentSlotId, "test-owner", now.toISOString());
  store.completeTsCoreSlot(currentSlotId, "test-owner", "SYSTEM_BLOCKED", null, null, new Date(now.getTime() + 1_000).toISOString());
  const truth = store.getActive().currentTruth;
  assert.deepEqual([truth.natural_slot.slot_id, truth.natural_slot.contract, truth.natural_slot.status, truth.natural_slot.terminal_state], [currentSlotId, "TS_CORE_TIER0", "BLOCKED", "SYSTEM_BLOCKED"]);
  store.close();
});

test("an expired ownership from a prior day cannot become the current active slot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "current-truth-old-lease-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "truth.sqlite")), oldSlotId = "live-shadow:20260826T200000Z";
  store.claimTsCoreSlot(oldSlotId, oldSlotId, "test-owner", "2026-08-26T20:00:00.000Z");
  const truth = store.getActive().currentTruth;
  assert.deepEqual([truth.natural_slot.slot_id, truth.slot_status, truth.active_slot_id], [null, "NOT_OBSERVED", null]);
  store.close();
});

test("an expired ownership from the current day cannot remain active", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-27T19:00:00.000Z") });
  const directory = await mkdtemp(join(tmpdir(), "current-truth-expired-lease-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "truth.sqlite")), claimedAt = new Date(Date.now() - 10 * 60_000), compact = claimedAt.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z"), currentSlotId = `live-shadow:${compact}`;
  store.claimTsCoreSlot(currentSlotId, currentSlotId, "test-owner", claimedAt.toISOString(), 120);
  const truth = store.getActive().currentTruth;
  assert.deepEqual([truth.natural_slot.slot_id, truth.slot_status, truth.active_slot_id], [null, "NOT_OBSERVED", null]);
  store.close();
});

test("an expired ownership with Run Ledger evidence cannot return through the slot fallback", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-27T19:00:00.000Z") });
  const directory = await mkdtemp(join(tmpdir(), "current-truth-expired-run-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "truth.sqlite")), claimedAt = new Date(Date.now() - 10 * 60_000), compact = claimedAt.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/, "Z"), currentSlotId = `live-shadow:${compact}`;
  store.claimTsCoreSlot(currentSlotId, currentSlotId, "test-owner", claimedAt.toISOString(), 120);
  const event = { ledger_format: "TRADING_OS_AGENT_RUN_EVENT", ledger_version: 1, agent_id: "TS", skill_id: "TS_LIVE_SHADOW", run_id: currentSlotId, slot_id: currentSlotId, channel: "SHADOW", version: "4070-live-shadow-v1", data_cutoff_at: claimedAt.toISOString(), output_status: "NOT_PRODUCED", evidence_refs: [], website_delivery: "NOT_ATTEMPTED", discord_delivery: "NOT_APPLICABLE" };
  store.importRunEventRaw(JSON.stringify({ ...event, event_id: `${currentSlotId}:TS:STARTED`, event_at: claimedAt.toISOString(), status: "STARTED", error: null }));
  store.importRunEventRaw(JSON.stringify({ ...event, event_id: `${currentSlotId}:TS:FAILED`, event_at: new Date(claimedAt.getTime() + 1_000).toISOString(), status: "FAILED", error: "stopped" }));
  const truth = store.getActive().currentTruth;
  assert.deepEqual([truth.natural_slot.slot_id, truth.slot_status, truth.active_slot_id], [currentSlotId, "BLOCKED", null]);
  store.close();
});

test("an aged slot failure remains historical instead of becoming SHADOW_FIXED", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "current-truth-historical-incident-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "truth.sqlite")), fingerprint = "TS_CORE_SLOT:expired:FORECAST_MISSING";
  const finding = { fingerprint, layer: "SCHEDULER", code: "TS_CORE_SLOT_INCOMPLETE", severity: "CRITICAL", title: "正式 TS 槽未完成权威生产链", run_id: "live-shadow:expired", suggestion: "保留历史", details: { evidence_scope: "CURRENT_SLOT", owner_required: false } };
  store.reconcileIncidents([finding], "test", "2026-08-27T18:32:00.000Z");
  store.reconcileIncidents([{ ...finding, details: { ...finding.details, evidence_scope: "HISTORICAL", lifecycle_status: "HISTORICAL" } }], "test", "2026-08-27T18:40:00.000Z");
  store.reconcileIncidents([], "test", "2026-08-27T18:41:00.000Z");
  const state = store.getSelfCheck(), archived = state.recent.find((item) => item.fingerprint === fingerprint), complaint = store.listComplaints().find((item) => item.complaint_id === archived.complaint_id);
  assert.deepEqual([state.active.length, archived.status, archived.details.evidence_scope, complaint.status, store.getActive().ownerQueue.open_complaints], [0, "RESOLVED", "HISTORICAL", "CLOSED", 0]);
  store.close();
});

test("malformed retained incident JSON cannot stop later reconciliation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "current-truth-malformed-incident-")), file = join(directory, "truth.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const finding = { fingerprint: "malformed", layer: "SERVICE", code: "TEST", severity: "WARNING", title: "保留损坏记录", run_id: null, suggestion: "继续自检", details: {} };
  let store = openSnapshotDatabase(file);
  store.reconcileIncidents([finding], "test");
  store.close();
  const database = new DatabaseSync(file);
  database.prepare("UPDATE incidents SET raw_json = '{' WHERE fingerprint = 'malformed'").run();
  database.close();
  store = openSnapshotDatabase(file);
  assert.doesNotThrow(() => store.reconcileIncidents([], "test"));
  assert.equal(store.getSelfCheck().active.length, 0);
  assert.doesNotThrow(() => store.reconcileIncidents([finding], "test"));
  assert.equal(store.getSelfCheck().active.length, 1);
  store.close();
  for (const raw of ["{}", '{"details":null}']) {
    const malformed = new DatabaseSync(file);
    malformed.prepare("UPDATE incidents SET raw_json = ? WHERE fingerprint = 'malformed'").run(raw);
    malformed.close();
    store = openSnapshotDatabase(file);
    assert.doesNotThrow(() => store.reconcileIncidents([finding], "test"));
    store.close();
  }
});

test("a resolved incident mentioning history remains recovered", () => {
  const resolved = { ...incident("resolved-history-text"), layer: "API", status: "RESOLVED", resolved_at: eventAt, suggestion: "旧预测只保留历史展示" };
  const truth = buildCurrentTruth({ ...base, selfCheck: { ...base.selfCheck, active: [], recent: [resolved] } }, "2026-08-27T18:33:00.000Z");
  assert.equal(truth.issues.lifecycle[0].status, "RECOVERED");
});

test("schedule ledger keeps expired failures as history and only current recovery work degrades Manager", () => {
  const store = { getActive: () => ({ currentTruth: { trading_date: "2026-08-27" }, scheduler: { today: { date: "2026-08-27" } }, outputs: { TS_SHADOW_OUTPUT: [], TS_SIGNAL_CANDIDATE: [], TS_SIGNAL_CANDIDATE_SETTLEMENT: [] } }), getTsCoreSlotOwnership: () => null, getRunsForSlot: () => [], hasOutput: () => false };
  const current = scheduleLedgerSupervision(store, "2026-08-27T13:32:00.000Z"), currentSlot = current.slots.find((item) => item.slot_id === "live-shadow:20260827T133000Z");
  assert.deepEqual([current.status, currentSlot.lifecycle, currentSlot.actionable, currentSlot.current_issues], ["DEGRADED", "CURRENT", true, ["OWNERSHIP_MISSING", "FORECAST_MISSING"]]);
  const later = scheduleLedgerSupervision(store, "2026-08-27T18:00:00.000Z"), oldSlot = later.slots.find((item) => item.slot_id === "live-shadow:20260827T133000Z");
  assert.deepEqual([oldSlot.lifecycle, oldSlot.actionable, oldSlot.current_issues, later.status], ["HISTORICAL", false, [], "PASS"]);
});

test("LLM budget status is not labeled as Codex or deterministic Manager offline", async () => {
  const sourceText = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(sourceText, /Codex离线降级/);
  assert.match(sourceText, /SKIPPED_BUDGET · 仅解释跳过/);
  assert.match(sourceText, /确定性Manager运行中/);
  const surface = sourceText.match(/const systemSurfaceStatus = (.*);/)?.[1];
  assert.ok(surface);
  const evaluate = new Function("ownerSystemBlocked", "ownerAttentionRequired", "systemStatus", "healthOverview", `return ${surface};`);
  assert.equal(evaluate(false, false, "DEGRADED", { current: [], selfCheckStatus: "HEALTHY" }), "HEALTHY", "an isolated model budget limitation is not Manager offline");
  assert.equal(evaluate(false, false, "DEGRADED", { current: [], selfCheckStatus: "NOT_VERIFIED" }), "NOT_VERIFIED", "unknown guard health cannot be colored healthy");
  assert.equal(evaluate(false, false, "DEGRADED", { current: [{}], selfCheckStatus: "HEALTHY" }), "DEGRADED", "automatic recovery does not hide an actual incident");
});

test("schedule incidents preserve per-slot evidence while sharing one projected root", async () => {
  const sourceText = await readFile(new URL("../server/incident-guard.ts", import.meta.url), "utf8");
  assert.match(sourceText, /TS_CORE_SLOT:\$\{slot\.slot_id\}:\$\{slot\.current_issues\[0\]\}/);
  assert.match(sourceText, /root_cause_id:\s*`TS_CORE_SLOT:\$\{slot\.current_issues\[0\]\}`/);
  assert.match(sourceText, /lifecycle_status:\s*"HISTORICAL"/);
});
