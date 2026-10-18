import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startOwnerServer, writeOwnerCredentials } from "../server/local-owner-server.ts";
import { createLiveShadowRuntime, OpeningMarketPending, ShadowRuntimeError, ShadowRuntimeInterrupted } from "../server/live-shadow-runtime.ts";
import { applyFixed70SwingManagement, assertRobinhoodReadonlyTool, collectExternalOptionQuote, collectRobinhoodMarketChart, collectRobinhoodReadonly, robinhoodMarketSession, ROBINHOOD_READONLY_TOOLS } from "../server/robinhood-mcp.ts";
import { parseOutputEnvelope } from "../app/snapshot-import.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { createTimelineScheduler } from "../server/timeline-scheduler.ts";
import { createIncidentGuard } from "../server/incident-guard.ts";
import { createCodexProductionManager } from "../server/codex-production-manager.ts";
import { assessPositionRisks, buildPositionCopilotState } from "../server/position-copilot.ts";
import { timelineOccurrencesForPtDate } from "../app/timeline-schedule.ts";

const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8"));
const tsSample = sample.contracts.TS_OUTPUT[0];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const marketSnapshotHash = "b".repeat(64);
const marketSnapshotId = `market-${marketSnapshotHash.slice(0, 24)}`;
const packagePython = resolve(import.meta.dirname, "../../.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

test("Windows step wrapper preserves Chinese failure text under an ASCII parent environment", { skip: process.platform !== "win32" }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-encoding-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/invoke-live-shadow-step.ps1"), "-RequestPath", join(directory, "missing-request.json"), "-ResponsePath", join(directory, "response.json"), "-V2Root", directory, "-DataRoot", directory], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, CODEX_CLI_PATH: process.execPath, PYTHONIOENCODING: "ascii", UV_OFFLINE: "1" },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /本地运行依赖不存在/);
  assert.doesNotMatch(result.stderr, /\\u[0-9a-f]{4}|\uFFFD/);
  assert.equal(existsSync(join(directory, "response.json")), false);
});

function componentPayload(component, sourceMode, observedAt, dataCutoffAt) {
  const v2Result = component === "A1" ? { health: { state: "HEALTHY" }, providers: { robinhood: { status: "HEALTHY", source: "ROBINHOOD_OFFICIAL_TRADING_MCP" }, tradier: { status: "DISABLED_BACKUP" } }, market_data: { source: "ROBINHOOD", snapshot_id: marketSnapshotId, snapshot_hash: marketSnapshotHash } } : { analysis: { data_gaps: [] }, packet: { run_id: "sanitized" } };
  return {
    contract_version: "v1", component, mode: "SHADOW", actionable: false, source_mode: sourceMode,
    status: "HEALTHY", observed_at: observedAt, data_cutoff_at: dataCutoffAt, freshness_seconds: 1,
    result_hash: hash(v2Result), evidence_ref: `data/live-shadow/evidence/${component.toLowerCase()}.json`, market_snapshot_id: marketSnapshotId, market_snapshot_hash: marketSnapshotHash, data_gaps: [], v2_result: v2Result,
  };
}

function successExecutor(overrides = {}) {
  return async (component, input) => {
    if (overrides[component]) return overrides[component](component, input);
    const observedAt = "2026-07-29T06:30:18-07:00";
    const payload = component === "TS" ? tsSample
      : component === "COMMITTEE" ? { contract_version: "v1", role: "COMMITTEE", flow_state: "unknown", direction: "unknown", confidence: 0, summary: "证据不足", evidence_for: [], evidence_against: ["缺少完整资金流证据"], reversal_signals: [], data_gaps: ["NOT_OBSERVED"] }
      : component === "D" ? { contract_version: "v1", role: "D", action: "NO_TRADE", score: 0, underlying: "NONE", option_side: "none", expiration: "", strike: 0, quantity: 0, max_entry_debit: 0, stop_loss_pct: 0, take_profit_pct: 0, summary: "证据不足，等待下一检查点", entry_conditions: [], invalidation: [], data_gaps: ["NOT_OBSERVED"] }
      : component === "A3_REVIEW" ? { contract_version: "v1", role: "A3_REVIEW", conflict_detected: false, review_required: false, review_target: "NONE", review_question: "", provisional_decision: "NO_TRADE", reason: "缺少正式证据" }
      : component === "A3" ? { contract_version: "v1", role: "A3", decision: "NO_TRADE", score: 0, underlying: "NONE", option_side: "none", expiration: "", strike: 0, quantity: 0, max_entry_debit: 0, stop_loss_pct: 0, take_profit_pct: 0, plain_language: "证据不足，不采取行动。", supporting_evidence: [], conflicts_resolved: [], invalidation: [], data_status: "BLOCKED" }
      : component === "CODEX_GUARD" ? { contract_version: "v1", role: "CODEX_GUARD", status: "HEALTHY", faults: [], restart_recommended: false, owner_message: "Shadow health is deterministic." }
      : componentPayload(component, input.source_mode, observedAt, observedAt);
    return { payload, observedAt, dataCutoffAt: observedAt, evidenceRef: `data/live-shadow/evidence/${component.toLowerCase()}.json` };
  };
}

test("natural runtime freezes explicit Owner intent from stored context without rewriting old copilot output", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-04T16:01:00Z") });
  const directory = await mkdtemp(join(tmpdir(), "owner-intent-runtime-")), store = openSnapshotDatabase(join(directory, "intent.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const sourceAt = "2026-09-04T16:00:00.000Z", at = "2026-09-04T16:15:01.000Z", slot = new Date("2026-09-04T16:15:00Z");
  const position = { account_label: "账户-aaaaaaaaaaaaaaaa", contract_id: "11111111-1111-4111-8111-111111111111", symbol: "SPY", option_type: "call", expiration: "2026-09-18", strike: 100, direction: "long", quantity: 2, average_price: 2, bid: 1.9, ask: 2, mark: 1.95, as_of: sourceAt };
  const account = { source: "ROBINHOOD", status: "LIVE", as_of: sourceAt, positions: [position] };
  const occurrence = timelineOccurrencesForPtDate("2026-09-04").find((item) => item.kind === "POSITION_MONITOR" && item.business_slot === "09:00");
  const check = assessPositionRisks(account, null, sourceAt), sourceId = `checkpoint:${occurrence.slot_id}`;
  const checkpoint = { ...occurrence, contract_version: "v1", role: "TIMELINE_SCHEDULER", status: "SUCCEEDED", started_at: sourceAt, completed_at: sourceAt, late_seconds: 0, result_ref: null, reason: null, position_check: check };
  store.importOutputRaw(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: sourceId, output_type: "SCHEDULE_CHECKPOINT", channel: "SYSTEM", observed_at: sourceAt, payload: checkpoint }), sourceAt);
  const market = { snapshot_id: marketSnapshotId, snapshot_hash: marketSnapshotHash, generated_at: sourceAt, as_of: sourceAt, status: "LIVE", market_session: { state: "REGULAR" }, quotes: [], options: [], news: [], bars: [], account };
  const legacy = buildPositionCopilotState({ runId: "live-shadow:20260904T160000Z", slotId: "live-shadow:20260904T160000Z", sourceMode: "LIVE", market, monitor: null, ts: null, d: null, a3: null, observedAt: sourceAt });
  const oldId = `${legacy.source_run_id}:POSITION_COPILOT_STATE`, oldRaw = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: oldId, output_type: "POSITION_COPILOT_STATE", channel: "SHADOW", observed_at: sourceAt, payload: legacy });
  store.importOutputRaw(oldRaw, sourceAt);
  const intent = { period: "ONE_TO_THREE_TRADING_DAYS", review_on: "2026-09-08", effect: "REVIEW_ONLY" };
  const saved = store.recordOwnerPositionPlan({ request_id: "22222222-2222-4222-8222-222222222222", source_record_id: sourceId, holding_id: check.observations[0].holding_id, original_logic: "Owner明确记录的持仓理由", holding_period: "计划持有1–3交易日", invalidation_text: "只按计划复查，尚无退出判断", target_text: "尚无该计划的目标", holding_intent: intent });
  assert.deepEqual(store.getRuntimeContext().ownerPositionPlans[0].holding_intent, intent);
  context.mock.timers.setTime(Date.parse(at));
  const currentMarket = { ...market, generated_at: at, as_of: at, account: { ...account, as_of: at, positions: [{ ...position, as_of: at }] } };
  let delivered = null, failFirstDelivery = true;
  const runtimeOptions = { origin: "http://127.0.0.1:1", gatewayKey: "unused", dataRoot: join(directory, "runtime"), now: () => new Date(at), runtimeContext: () => store.getRuntimeContext(),
    executeStep: successExecutor({ A1: async (component, input) => ({ payload: { ...componentPayload(component, input.source_mode, at, at), market_sources: currentMarket }, observedAt: at, dataCutoffAt: at, evidenceRef: "data/live-shadow/evidence/test-only-owner-intent.json" }) }),
    importOutputRaw: (raw) => { if (JSON.parse(raw).output_type === "POSITION_COPILOT_STATE") { delivered = raw; if (failFirstDelivery) { failFirstDelivery = false; throw new Error("test-only delivery retry"); } store.importOutputRaw(raw, at); } }, importRunEventRaw: () => {},
  };
  const runtime = createLiveShadowRuntime(runtimeOptions);
  await assert.rejects(runtime.runOnce("LIVE", slot), /test-only delivery retry/);
  const frozen = delivered, newState = parseOutputEnvelope(frozen).payload;
  assert.equal(newState.previous_state_id, legacy.state_id);
  assert.equal(newState.holdings[0].holding_intent.plan_version_id, saved.plan.plan_version_id);
  assert.deepEqual([newState.holdings[0].dte, newState.holdings[0].holding_horizon, newState.holdings[0].owner_action, newState.holdings[0].target_1], [14, "UNCLASSIFIED", "WAIT", null]);
  // Restart/delivery retry must not rebuild the frozen result from a later or empty Owner context.
  const restarted = createLiveShadowRuntime({ ...runtimeOptions, runtimeContext: () => ({ ...store.getRuntimeContext(), ownerPositionPlans: [] }) });
  await restarted.runOnce("LIVE", slot);
  assert.equal(delivered, frozen);
  assert.equal(store.getOutputRaw(`${newState.source_run_id}:POSITION_COPILOT_STATE`), frozen);
  assert.equal(store.getOutputRaw(oldId), oldRaw);
  assert.equal(store.getRuntimeContext().positionCopilotStates.find((state) => state.state_id === legacy.state_id).holdings[0].holding_intent, undefined);
});

test("stock companion starts after core and remains available to FULL, never repeats completed core or replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "stock-core-separation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], published = [];
  const at = new Date("2026-09-09T15:00:01.000Z"), slot = new Date("2026-09-09T15:00:00.000Z");
  const runtime = createLiveShadowRuntime({ origin: "http://127.0.0.1:1", gatewayKey: "unused", dataRoot: directory,
    now: () => at, runtimeContext: () => ({}), executeStep: successExecutor(),
    importOutputRaw: (raw) => published.push(JSON.parse(raw)), importRunEventRaw: () => {},
    runStockPlans: async (input) => { assert.ok(published.some((row) => row.output_type === "TS_SHADOW_OUTPUT")); assert.ok(input.a1 && input.a2); calls.push(input.runId); },
  });
  await runtime.runTsCore("LIVE", slot); assert.deepEqual(calls, ["live-shadow:20260909T150000Z"]);
  await runtime.runTsCore("LIVE", slot); assert.equal(calls.length, 1);
  await runtime.runOnce("LIVE", slot); assert.equal(calls.length, 2);
  assert.equal(published.find((row) => row.output_type === "D_SHADOW_OUTPUT").payload.action, "NO_TRADE");
  await runtime.runOnce("LIVE", slot); assert.equal(calls.length, 2);
  await runtime.runTsCore("REPLAY", slot); assert.equal(calls.length, 2);
  await runtime.runOnce("REPLAY", slot); assert.equal(calls.length, 2);
});

test("index data blocks still start independent stock work without holding Tier 0; absent A1 cannot supply stock evidence", async (t) => {
  for (const fault of ["index-bars", "missing-prior", "missing-a1"]) {
    const directory = await mkdtemp(join(tmpdir(), "stock-index-blocked-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const calls = [], events = [], execute = successExecutor();
    let release;
    const gate = new Promise((resolveWait) => { release = resolveWait; });
    const runtime = createLiveShadowRuntime({ origin: "http://127.0.0.1:1", gatewayKey: "unused", dataRoot: directory,
      now: () => new Date("2026-09-09T13:45:35Z"), runtimeContext: () => ({}),
      executeStep: async (component, input) => {
        if (fault === "missing-a1" && component === "A1" || fault === "missing-prior" && component === "TS") throw new ShadowRuntimeError("DATA_BLOCKED", fault);
        const result = await execute(component, input);
        if (fault === "index-bars" && component === "A1") result.downstreamReason = "DATA_BLOCKED";
        return result;
      },
      importOutputRaw: () => {}, importRunEventRaw: (raw) => events.push(JSON.parse(raw)),
      runStockPlans: async (input) => { calls.push(input); await gate; },
    });
    try {
      const result = await runtime.runTsCore("LIVE", new Date("2026-09-09T13:45:00Z"));
      assert.equal(result.terminalOutcome, "GENUINE_DATA_BLOCKED", fault);
      assert.equal(runtime.running, false, "stock review must not hold the core lease or runtime");
      assert.equal(calls.length, fault === "missing-a1" ? 0 : 1, fault);
      if (fault === "index-bars") assert.equal(calls[0].a2, null);
      assert.ok(events.some((event) => event.agent_id === "TS" && ["SKIPPED", "DATA_BLOCKED"].includes(event.status)));
    } finally { release(); }
  }
});

async function harness(context, port = 0) {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-shadow-"));
  const options = {
    host: "127.0.0.1", port, outDir: resolve("dist"), databasePath: join(directory, "shadow.sqlite"),
    credentialsPath: join(directory, "owner.json"), gatewayKeyPath: join(directory, "gateway.key"), lockPath: join(directory, "owner.pid"), shadowRuntime: false,
  };
  writeOwnerCredentials(options.credentialsPath, "Local-Shadow-Test-Only!");
  let server = await startOwnerServer(options);
  context.after(async () => { await new Promise((resolveWait) => setTimeout(resolveWait, 100)); await server?.close(); await rm(directory, { recursive: true, force: true }); });
  const key = (await readFile(options.gatewayKeyPath, "utf8")).trim();
  return {
    directory, options, key,
    get server() { return server; },
    set server(value) { server = value; },
    runtime(executeStep, data = join(directory, "runtime")) {
      return createLiveShadowRuntime({ origin: server.url, gatewayKey: key, dataRoot: data, executeStep, intervalMs: 3_600_000 });
    },
    async state() {
      const login = await fetch(`${server.url}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", referer: `${server.url}/login` }, body: new URLSearchParams({ username: "owner", password: "Local-Shadow-Test-Only!" }) });
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      return (await fetch(`${server.url}/api/snapshot`, { headers: { cookie } })).json();
    },
  };
}

test("ledger event times retain real elapsed work instead of advancing one millisecond per event", async (context) => {
  const h = await harness(context);
  const execute = successExecutor();
  const runtime = h.runtime(async (component, input) => {
    if (component === "A1") await new Promise((resolve) => setTimeout(resolve, 40));
    return execute(component, input);
  });
  await runtime.runOnce("REPLAY", new Date("2026-08-12T16:00:00Z"));
  const db = new DatabaseSync(h.options.databasePath, { readOnly: true });
  const events = db.prepare("SELECT status, event_at FROM agent_run_events WHERE agent_id = 'A1' ORDER BY event_at").all();
  db.close();
  const started = events.find((row) => row.status === "RUNNING"), completed = events.find((row) => row.status === "SUCCEEDED");
  assert.ok(started && completed);
  assert.ok(Date.parse(completed.event_at) - Date.parse(started.event_at) >= 35);
});

test("Tier 0 freezes Forecast without Web and retries only the immutable failed delivery", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-tier0-direct-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = openSnapshotDatabase(join(directory, "direct.sqlite")), slot = new Date("2026-08-26T15:00:00.000Z"), slotId = "live-shadow:20260826T150000Z";
  let failA1 = true;
  const runtime = createLiveShadowRuntime({
    origin: "http://127.0.0.1:1", gatewayKey: "unused", dataRoot: join(directory, "runtime"), runtimeContext: () => ({}), now: () => new Date("2026-08-26T15:00:01.000Z"), executeStep: successExecutor(),
    importOutputRaw: (raw, receivedAt) => { if (failA1 && JSON.parse(raw).output_type === "A1_SHADOW_RESULT") { failA1 = false; throw new Error("temporary delivery failure"); } store.importOutputRaw(raw, receivedAt, true); },
    importRunEventRaw: (raw, receivedAt) => { store.importRunEventRaw(raw, receivedAt, true); },
    tsCoreOwnership: { ownerId: "direct-runtime", get: (id) => store.getTsCoreSlotOwnership(id), claim: (id, runId, owner, at) => store.claimTsCoreSlot(id, runId, owner, at), renew: (id, owner, at) => store.renewTsCoreSlot(id, owner, at), complete: (id, owner, outcome, forecastId, deliveryRecordId, at) => store.completeTsCoreSlot(id, owner, outcome, forecastId, deliveryRecordId, at) },
  });
  assert.equal((await runtime.runTsCore("LIVE", slot, "Web unavailable")).terminalOutcome, "NO_TRADE");
  assert.equal(store.hasOutput(`${slotId}:A1`), false); assert.equal(store.hasOutput(`${slotId}:TS`), true);
  assert.equal((await runtime.runTsCore("LIVE", slot, "deterministic delivery retry")).terminalOutcome, "NO_TRADE");
  assert.equal(store.hasOutput(`${slotId}:A1`), true);
  const database = new DatabaseSync(store.file, { readOnly: true });
  assert.deepEqual([Number(database.prepare("SELECT COUNT(*) AS n FROM ts_forecast_archive WHERE official_slot = '08:00'").get().n), Number(database.prepare("SELECT COUNT(*) AS n FROM agent_run_events WHERE run_id = ? AND agent_id = 'TS' AND website_delivery = 'DELIVERED'").get(slotId).n)], [1, 1]);
  database.close(); store.close();
});

test("new opening policy waits for actual A1 under cold or bar-only Guard, resumes the same slot and closes stale attempts at deadline", async (context) => {
  for (const scenario of ["cold", "bar-only", "always-stale", "interrupted", "guard-success"]) {
    const directory = await mkdtemp(join(tmpdir(), "opening-contract-"));
    const store = openSnapshotDatabase(join(directory, "opening.sqlite"));
    context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
    let clock = new Date("2026-09-21T13:30:05.000Z"), ready = false;
    const slot = new Date("2026-09-21T13:30:00.000Z"), id = "live-shadow:20260921T133000Z", calls = [];
    if (scenario !== "cold") store.recordDataSourceStatus({ source: "ROBINHOOD", status: "LIVE", configured: true, authorization: "VALID", last_success_at: clock.toISOString(), as_of: clock.toISOString(), freshness_seconds: 0, error: null, checked_at: clock.toISOString(), capabilities: { market_quotes: false, intraday_bars: true } });
    const runtime = createLiveShadowRuntime({
      origin: "http://127.0.0.1:1", gatewayKey: "unused", dataRoot: join(directory, "runtime"), runtimeContext: () => ({}), now: () => clock,
      executeStep: async (component, input) => {
        calls.push(component);
        assert.equal(input.SLOT_FREEZE_DEADLINE_AT, "2026-09-21T13:40:00.000Z");
        assert.equal(input.RUN_REASON, "早盘固定分析", "Guard recovery must retain the owned opening contract");
        if (component === "A1" && scenario === "interrupted") throw new ShadowRuntimeInterrupted("collection stopped before proving source readiness");
        if (component === "A1" && !ready) throw new OpeningMarketPending("test-only://unpublished-regular-bars");
        const observedAt = clock.toISOString();
        const payload = component === "TS" ? structuredClone(tsSample) : componentPayload(component, "LIVE", observedAt, observedAt);
        if (component === "TS") {
          payload.evidence_snapshot = { ...payload.evidence_snapshot, run_id: "20260921T133000Z-aaaaaaaaaa", market_time: { ...payload.evidence_snapshot.market_time, observed_at: observedAt, market_date: "2026-09-21" } };
          payload.forecast_window = { ...payload.forecast_window, start_at: observedAt, end_at: new Date(clock.getTime() + 3_600_000).toISOString() };
        }
        return { payload, observedAt, dataCutoffAt: observedAt, evidenceRef: "test-only://opening-frozen" };
      },
      importOutputRaw: (raw, receivedAt) => { store.importOutputRaw(raw, receivedAt, true); }, importRunEventRaw: (raw, receivedAt) => { store.importRunEventRaw(raw, receivedAt, true); },
      tsCoreOwnership: { ownerId: "opening-test", get: (key) => store.getTsCoreSlotOwnership(key), claim: (key, runId, owner, at) => store.claimTsCoreSlot(key, runId, owner, at), renew: (key, owner, at) => store.renewTsCoreSlot(key, owner, at), complete: (key, owner, outcome, forecastId, deliveryRecordId, at) => store.completeTsCoreSlot(key, owner, outcome, forecastId, deliveryRecordId, at) },
    });
    const scheduler = createTimelineScheduler({ store, now: () => clock, runtimeStartedAt: slot, runTsCore: (at, reason) => runtime.runTsCore("LIVE", at, reason), runShadow: async () => ({ status: "COMPLETED", runId: id }), reserveTsCore: (at) => runtime.reserveTsCore(at), completeReservedTsCore: (at, outcome) => runtime.completeReservedTsCore(at, outcome) });
    await scheduler.runOnce(clock);
    assert.equal(calls.length, 0, "first complete regular bar cannot exist before 06:35");
    assert.equal(store.getTsCoreSlotOwnership(id).status, "LEASED");
    if (scenario === "bar-only") assert.equal((await runtime.runTsCore("LIVE", slot, "Manager deterministic recovery")).status, "IN_PROGRESS");
    clock = new Date("2026-09-21T13:35:05.000Z");
    if (scenario === "interrupted") await assert.rejects(runtime.runTsCore("LIVE", slot, "Manager deterministic recovery"), ShadowRuntimeInterrupted);
    else await scheduler.runOnce(clock);
    assert.ok(calls.length > 0, `${scenario}: Guard's missing quote capability cannot deadlock actual A1 sampling`);
    assert.ok(calls.every((component) => component === "A1"));
    assert.notEqual(store.getTsCoreSlotOwnership(id).status, "TERMINAL");
    assert.equal(store.hasOutput(`${id}:A1`), false);
    assert.equal(store.getRunsForSlot(id).find((run) => run.agent_id === "A1").status, "RUNNING");
    if (scenario === "always-stale" || scenario === "interrupted") {
      const attempts = calls.length;
      clock = new Date("2026-09-21T13:40:05.000Z"); await scheduler.runOnce(clock);
      assert.equal(calls.length, attempts, "deadline never samples later evidence");
      assert.equal(store.getTsCoreSlotOwnership(id).terminal_outcome, scenario === "interrupted" ? "SYSTEM_BLOCKED" : "GENUINE_DATA_BLOCKED");
      assert.equal(store.getRunsForSlot(id).find((run) => run.agent_id === "A1").status, scenario === "interrupted" ? "FAILED" : "DATA_BLOCKED");
      assert.equal(store.hasOutput(`${id}:A1`), false);
    } else {
      ready = true; clock = new Date("2026-09-21T13:35:35.000Z");
      if (scenario === "guard-success") await runtime.runTsCore("LIVE", slot, "Manager deterministic recovery");
      else await scheduler.runOnce(clock);
      assert.equal(store.getTsCoreSlotOwnership(id).terminal_outcome, "NO_TRADE");
      assert.equal(calls.filter((component) => component === "TS").length, 1);
      const frozen = store.getOutputRaw(`${id}:A1`);
      assert.equal(JSON.parse(frozen).observed_at, clock.toISOString());
      if (scenario === "guard-success") {
        clock = new Date("2026-09-21T13:40:05.000Z"); await scheduler.runOnce(clock);
        assert.equal(JSON.parse(store.getOutputRaw("checkpoint:timeline:ts_forecast:20260921:0630")).payload.status, "SUCCEEDED", "a delayed scheduler poll must preserve Guard's genuine completed forecast");
      }
      clock = new Date("2026-09-21T13:41:00.000Z");
      await runtime.runTsCore("LIVE", slot, "terminal slot may only redeliver frozen evidence");
      assert.equal(store.getOutputRaw(`${id}:A1`), frozen);
      assert.equal(calls.filter((component) => component === "TS").length, 1);
    }
  }
});

test("isolated ephemeral control-plane canary keeps Tier 0 persistent and independent under FULL and recovery concurrency", async (context) => {
  const h = await harness(context);
  let store = openSnapshotDatabase(h.options.databasePath);
  let releaseA1, a1Started, tsCalls = 0, llmCalls = 0, clock = new Date("2026-08-26T13:30:30.000Z"), crashOnce = true;
  const a1Gate = new Promise((resolveWait) => { releaseA1 = resolveWait; });
  const started = new Promise((resolveWait) => { a1Started = resolveWait; });
  const executor = successExecutor({
    A1: async (component, input) => {
      if (input.slot_id.endsWith("20260827T133000Z")) throw new ShadowRuntimeError("DATA_BLOCKED", "regular Bar remained stale through the opening deadline");
      if (input.slot_id.endsWith("133000Z")) { a1Started(); await a1Gate; }
      const at = input.slot_id.match(/(\d{8})T(\d{2})(\d{2})00Z$/), observedAt = at ? `${at[1].slice(0, 4)}-${at[1].slice(4, 6)}-${at[1].slice(6, 8)}T${at[2]}:${at[3]}:01.000Z` : "2026-08-25T13:30:01.000Z";
      return { payload: componentPayload(component, input.source_mode, observedAt, observedAt), observedAt, dataCutoffAt: observedAt, evidenceRef: `data/live-shadow/evidence/${input.slot_id}-a1.json` };
    },
    A2: async (component, input) => {
      if (input.slot_id.endsWith("20260828T133000Z") && crashOnce) { crashOnce = false; throw new ShadowRuntimeInterrupted("simulated service stop before terminal"); }
      const observedAt = input.slot_id.endsWith("20260826T133000Z") ? clock.toISOString() : "2026-08-28T13:30:02.000Z";
      return { payload: componentPayload(component, input.source_mode, observedAt, observedAt), observedAt, dataCutoffAt: observedAt, evidenceRef: `data/live-shadow/evidence/${input.slot_id}-a2.json` };
    },
    TS: async (_component, input) => {
      tsCalls += 1;
      const payload = structuredClone(tsSample), compact = String(input.slot_id).split(":").at(-1), observedAt = compact === "20260826T133000Z" ? clock.toISOString() : `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:02.000Z`;
      payload.evidence_snapshot = { ...payload.evidence_snapshot, run_id: `${compact}-aaaaaaaaaa`, market_time: { ...payload.evidence_snapshot.market_time, observed_at: observedAt, market_date: observedAt.slice(0, 10) } };
      payload.forecast_window = { ...payload.forecast_window, start_at: observedAt, end_at: new Date(Date.parse(observedAt) + 60 * 60_000).toISOString() };
      return { payload, observedAt, dataCutoffAt: observedAt, evidenceRef: `data/live-shadow/evidence/${input.slot_id}-ts.json` };
    },
  });
  store.codexManagerUsageSince = () => ({ calls: 999, estimated_cost_usd: 999 });
  const manager = createCodexProductionManager({ store, dataRoot: h.directory, projectRoot: process.cwd(), siteVersion: "canary", runtimeIdentity: { deployedCommit: "a".repeat(40), runtimeSha256: "b".repeat(64) }, invoke: async () => { llmCalls += 1; throw new Error("zero-budget manager must not invoke LLM"); } });
  const ownership = (ownerId) => ({ ownerId, get: (slotId) => store.getTsCoreSlotOwnership(slotId), claim: (slotId, runId, owner, at) => store.claimTsCoreSlot(slotId, runId, owner, at), renew: (slotId, owner, at) => store.renewTsCoreSlot(slotId, owner, at), complete: (slotId, owner, outcome, forecastId, deliveryRecordId, at) => store.completeTsCoreSlot(slotId, owner, outcome, forecastId, deliveryRecordId, at) });
  const runtime = createLiveShadowRuntime({ origin: h.server.url, gatewayKey: h.key, dataRoot: join(h.directory, "canary-runtime"), executeStep: executor, now: () => new Date("2026-08-25T13:30:01.000Z"), tsCoreOwnership: ownership("canary:first") });
  const slot = new Date("2026-08-25T13:30:00.000Z"), natural = runtime.runTsCore("LIVE", slot, "06:30 natural"), full = runtime.runOnce("LIVE", slot, "06:30 FULL"), managerBudget = manager.run("SCHEDULE_EARLY", "4071 zero-budget canary");
  await started;
  const directRecovery = runtime.runTsCore("LIVE", slot, "Manager deterministic recovery");
  releaseA1();
  const [naturalResult, fullResult, recoveryResult, managerResult] = await Promise.all([natural, full, directRecovery, managerBudget]);
  assert.deepEqual([naturalResult.status, fullResult.status, recoveryResult.status, managerResult.status, store.getTsCoreSlotOwnership("live-shadow:20260825T133000Z").terminal_outcome], ["COMPLETED", "SYSTEM_BLOCKED", "IN_PROGRESS", "SKIPPED_BUDGET", "NO_TRADE"]);
  assert.equal((await runtime.runOnce("LIVE", slot, "06:30 FULL retry")).status, "COMPLETED");
  const restarted = createLiveShadowRuntime({ origin: h.server.url, gatewayKey: h.key, dataRoot: join(h.directory, "canary-runtime"), executeStep: executor, now: () => new Date("2026-08-25T13:40:00.000Z"), tsCoreOwnership: ownership("canary:restarted") });
  assert.equal((await restarted.runTsCore("LIVE", slot, "service restart")).terminalOutcome, "NO_TRADE");
  for (const next of ["2026-08-25T13:45:00.000Z", "2026-08-25T14:00:00.000Z"]) assert.equal((await runtime.runTsCore("LIVE", new Date(next), "later natural slot")).status, "COMPLETED");
  const openingRuntime = createLiveShadowRuntime({ origin: h.server.url, gatewayKey: h.key, dataRoot: join(h.directory, "canary-opening"), executeStep: executor, now: () => clock, tsCoreOwnership: ownership("canary:opening") });
  store.recordDataSourceStatus({ source: "ROBINHOOD", status: "STALE", configured: true, authorization: "VALID", last_success_at: "2026-08-26T12:00:00.000Z", as_of: "2026-08-26T12:00:00.000Z", freshness_seconds: 5430, error: null, checked_at: clock.toISOString(), capabilities: { quotes: true, intraday_bars: true } });
  let releaseNatural, naturalQueued;
  const naturalGate = new Promise((resolveWait) => { releaseNatural = resolveWait; });
  const queued = new Promise((resolveWait) => { naturalQueued = resolveWait; });
  let holdNatural = false;
  const scheduler = createTimelineScheduler({ store, now: () => clock, runtimeStartedAt: new Date("2026-08-26T13:30:00.000Z"), runTsCore: async (at, reason) => { if (holdNatural) { naturalQueued(); await naturalGate; } return openingRuntime.runTsCore("LIVE", at, reason); }, runShadow: (at, reason) => openingRuntime.runOnce("LIVE", at, reason), reserveTsCore: (at) => openingRuntime.reserveTsCore(at), completeReservedTsCore: (at, outcome) => openingRuntime.completeReservedTsCore(at, outcome) });
  await scheduler.runOnce(clock);
  const reserved = store.getTsCoreSlotOwnership("live-shadow:20260826T133000Z");
  assert.deepEqual([reserved.status, store.getRunsForSlot("live-shadow:20260826T133000Z").length, (Date.parse(reserved.lease_acquired_at) - Date.parse("2026-08-26T13:30:00.000Z")) / 1_000], ["LEASED", 0, 30]);
  let barAge = 421;
  let recoveryReached;
  const recoveryStarted = new Promise((accept) => { recoveryReached = accept; });
  const guard = createIncidentGuard({ store, siteVersion: "canary", dataRoot: join(h.directory, "canary-guard"), now: () => clock, pageProbe: async () => true, desktopProbe: async () => [], marketProbe: async () => ["SPY", "QQQ"].map((symbol) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", as_of: clock.toISOString(), quote_as_of: clock.toISOString(), bar_as_of: new Date(clock.getTime() - barAge * 1_000).toISOString(), freshness_seconds: 1, quote_freshness_seconds: 1, bar_freshness_seconds: barAge, market_session: { phase: "REGULAR", state: "REGULAR", trading_date: "2026-08-26" }, current_price: 1, bars: [], error: null })), recoverShadow: (at) => { recoveryReached(); return openingRuntime.runTsCore("LIVE", at, "Manager deterministic recovery"); }, shadowRunning: (slotId) => openingRuntime.isRunning(slotId) });
  clock = new Date("2026-08-26T13:32:01.000Z");
  await guard.runOnce();
  assert.equal(store.getCodexManagerEventPayloads("TS_CORE_RECOVERY_ATTEMPTED", "recovery").length, 0);
  assert.ok(store.getSelfCheck().active.some((item) => item.code === "SOURCE_GAP"));
  clock = new Date("2026-08-26T13:33:01.000Z");
  await guard.runOnce();
  assert.equal(store.getCodexManagerEventPayloads("TS_CORE_RECOVERY_ATTEMPTED", "recovery").length, 0);
  barAge = 1;
  store.recordDataSourceStatus({ source: "ROBINHOOD", status: "LIVE", configured: true, authorization: "VALID", last_success_at: "2026-08-26T13:34:55.000Z", as_of: "2026-08-26T13:34:55.000Z", freshness_seconds: 0, error: null, checked_at: "2026-08-26T13:34:55.000Z", capabilities: { quotes: true, intraday_bars: true } });
  clock = new Date("2026-08-26T13:34:55.000Z"); holdNatural = true;
  const naturalRace = scheduler.runOnce(clock);
  await queued;
  const guardRace = guard.runOnce();
  await Promise.race([recoveryStarted, guardRace.then(() => { throw new Error("Guard must reach the actual recovery boundary before the competitor is released"); })]).finally(releaseNatural);
  await Promise.all([naturalRace, guardRace]);
  holdNatural = false; clock = new Date("2026-08-26T13:34:56.000Z");
  await scheduler.runOnce(clock);
  const openingCheckpoint = JSON.parse(store.getOutputRaw("checkpoint:timeline:ts_forecast:20260826:0630")).payload;
  assert.deepEqual([store.getTsCoreSlotOwnership("live-shadow:20260826T133000Z").terminal_outcome, openingCheckpoint.status], ["NO_TRADE", "SUCCEEDED"]);
  assert.equal(store.getCodexManagerEventPayloads("TS_CORE_RECOVERY_ATTEMPTED", "recovery").length, 1);
  const openingForecast = JSON.parse(store.getOutputRaw("live-shadow:20260826T133000Z:TS"));
  assert.ok(Date.parse(openingForecast.observed_at) <= Date.parse("2026-08-26T13:35:00.000Z"));

  const blockedRuntime = createLiveShadowRuntime({ origin: h.server.url, gatewayKey: h.key, dataRoot: join(h.directory, "canary-blocked"), executeStep: executor, now: () => new Date("2026-08-27T13:30:01.000Z"), tsCoreOwnership: ownership("canary:blocked") });
  assert.equal((await blockedRuntime.runTsCore("LIVE", new Date("2026-08-27T13:30:00.000Z"), "06:30 genuine block")).terminalOutcome, "GENUINE_DATA_BLOCKED");
  for (const next of ["2026-08-27T13:45:00.000Z", "2026-08-27T14:00:00.000Z"]) assert.equal((await blockedRuntime.runTsCore("LIVE", new Date(next), "later independent natural slot")).status, "COMPLETED");

  clock = new Date("2026-08-28T13:30:01.000Z");
  const restartRoot = join(h.directory, "canary-interrupted"), interrupted = createLiveShadowRuntime({ origin: h.server.url, gatewayKey: h.key, dataRoot: restartRoot, executeStep: executor, now: () => clock, tsCoreOwnership: ownership("canary:before-stop") });
  await assert.rejects(interrupted.runTsCore("LIVE", new Date("2026-08-28T13:30:00.000Z"), "interrupted natural slot"), ShadowRuntimeInterrupted);
  assert.notEqual(store.getTsCoreSlotOwnership("live-shadow:20260828T133000Z").status, "TERMINAL");
  await h.server.close(); store.close(); h.server = await startOwnerServer({ ...h.options, port: 0 }); store = openSnapshotDatabase(h.options.databasePath);
  clock = new Date("2026-08-28T13:32:02.000Z");
  const reclaimed = createLiveShadowRuntime({ origin: h.server.url, gatewayKey: h.key, dataRoot: restartRoot, executeStep: executor, now: () => clock, tsCoreOwnership: ownership("canary:after-start") });
  assert.equal((await reclaimed.runTsCore("LIVE", new Date("2026-08-28T13:30:00.000Z"), "post-restart reclaim")).terminalOutcome, "NO_TRADE");
  assert.equal(store.getTsCoreSlotOwnership("live-shadow:20260828T133000Z").lease_acquired_at, "2026-08-28T13:30:01.000Z");

  let lateA1Calls = 0;
  const lateRuntime = createLiveShadowRuntime({ origin: h.server.url, gatewayKey: h.key, dataRoot: join(h.directory, "canary-late-recovery"), executeStep: async (...args) => { lateA1Calls += Number(args[0] === "A1"); return executor(...args); }, now: () => clock, tsCoreOwnership: ownership("canary:late") });
  clock = new Date("2026-08-29T13:35:01.000Z");
  assert.equal((await lateRuntime.runTsCore("LIVE", new Date("2026-08-29T13:30:00.000Z"), "late Guard bypass attempt")).terminalOutcome, "SYSTEM_BLOCKED");
  clock = new Date("2026-08-29T14:05:00.000Z");
  assert.equal((await lateRuntime.runTsCore("LIVE", clock, "07:05 Manager bypass attempt")).terminalOutcome, "SYSTEM_BLOCKED");
  assert.equal(lateA1Calls, 0);

  const db = new DatabaseSync(store.file, { readOnly: true });
  const officialRows = db.prepare("SELECT forecast_run_id, forecast_hash, market_date, official_slot FROM ts_forecast_archive WHERE eligibility = 'OFFICIAL_LIVE' ORDER BY published_at").all();
  const duplicateForecasts = db.prepare("SELECT market_date, official_slot, COUNT(*) AS n FROM ts_forecast_archive WHERE eligibility = 'OFFICIAL_LIVE' GROUP BY market_date, official_slot HAVING COUNT(*) > 1").all();
  const duplicateDeliveries = db.prepare("SELECT run_id, agent_id, COUNT(*) AS n FROM agent_run_events WHERE agent_id = 'TS' AND status = 'SUCCEEDED' AND website_delivery = 'DELIVERED' GROUP BY run_id, agent_id HAVING COUNT(*) > 1").all();
  const officialBeforeReplay = Number(db.prepare("SELECT COUNT(*) AS n FROM ts_forecast_archive WHERE eligibility = 'OFFICIAL_LIVE'").get().n), hashBeforeReplay = officialRows.at(-1).forecast_hash;
  assert.equal((await reclaimed.runTsCore("LIVE", new Date("2026-08-28T13:30:00.000Z"), "idempotent post-terminal retry")).terminalOutcome, "NO_TRADE");
  assert.deepEqual([duplicateForecasts.length, duplicateDeliveries.length, Number(db.prepare("SELECT COUNT(*) AS n FROM ts_forecast_archive WHERE eligibility = 'OFFICIAL_LIVE'").get().n), db.prepare("SELECT forecast_hash FROM ts_forecast_archive WHERE forecast_run_id = ?").get(officialRows.at(-1).forecast_run_id).forecast_hash], [0, 0, officialBeforeReplay, hashBeforeReplay]);
  db.close();
  const state = await h.state();
  assert.equal(new Set(officialRows.map((row) => row.forecast_run_id)).size, officialRows.length);
  assert.deepEqual([tsCalls, llmCalls, state.investmentKernel.execution_mode, state.investmentKernel.broker_access, state.investmentKernel.automated_execution, state.outputs.OPTION_STRATEGY_SIGNAL[0].automated_execution], [7, 0, "SHADOW", "READ_ONLY", false, false]);
  store.close();
});

test("replay chain is Shadow-only, idempotent, non-overlapping and persistent", async (context) => {
  const h = await harness(context);
  const runtime = h.runtime(successExecutor());
  const slot = new Date("2026-08-12T17:00:00.000Z");
  assert.equal((await runtime.runOnce("REPLAY", slot)).status, "COMPLETED");
  const first = await h.state();
  assert.equal(first.runLedger.eventCount, 24);
  assert.equal(first.outputCount, 10);
  assert.ok(first.runLedger.runs.filter((run) => run.run_id.startsWith("replay-shadow:")).every((run) => run.channel === "SHADOW" && run.discord_delivery === "NOT_APPLICABLE"));
  assert.equal(first.outputs.A1_SHADOW_RESULT.source_mode, "REPLAY");
  assert.equal(first.outputs.TS_SHADOW_OUTPUT[0].role, "TS");
  assert.equal(first.outputs.COMMITTEE_SHADOW_OUTPUT.role, "COMMITTEE");
  assert.equal(first.outputs.D_SHADOW_OUTPUT.action, "NO_TRADE");
  assert.equal(first.outputs.A3_FINAL_SHADOW.decision, "NO_TRADE");
  assert.equal(first.outputs.OPTION_STRATEGY_SIGNAL[0].owner_action, "WAIT");
  assert.equal(first.outputs.OPTION_STRATEGY_SIGNAL[0].automated_execution, false);
  assert.equal(first.outputs.POSITION_COPILOT_STATE[0].automated_execution, false);
  assert.equal(first.outputs.POSITION_COPILOT_STATE[0].holdings.length, 0);
  assert.equal(first.outputs.TS_OUTPUT.length, 0);

  assert.equal((await runtime.runOnce("REPLAY", slot)).status, "COMPLETED");
  assert.equal((await h.state()).runLedger.eventCount, 24);

  const healthyLive = h.runtime(successExecutor({ A1: async (component, input) => { const at = "2026-08-12T17:15:00.000Z"; return { payload: componentPayload(component, input.source_mode, at, at), observedAt: at, dataCutoffAt: at, evidenceRef: "data/live-shadow/evidence/healthy-live-a1.json" }; } }), join(h.directory, "healthy-live"));
  assert.equal((await healthyLive.runOnce("LIVE", new Date("2026-08-12T17:15:00.000Z"))).status, "COMPLETED");

  const failedLive = h.runtime(successExecutor({ A1: async (component, input) => { const at = "2026-08-12T17:30:00.000Z"; return { payload: componentPayload(component, input.source_mode, at, at), observedAt: at, dataCutoffAt: at, evidenceRef: "data/live-shadow/evidence/failed-live-a1.json" }; }, TS: async () => { throw new ShadowRuntimeError("FAILED", "simulated current TS failure"); } }), join(h.directory, "failed-live"));
  assert.equal((await failedLive.runOnce("LIVE", new Date("2026-08-12T17:30:00.000Z"))).status, "FAILED");
  assert.equal((await failedLive.runOnce("LIVE", new Date("2026-08-12T17:30:00.000Z"))).status, "FAILED");
  const current = await h.state();
  assert.equal(current.outputs.A1_SHADOW_RESULT.source_mode, "LIVE");
  assert.equal(current.outputs.TS_SHADOW_OUTPUT.length, 1);
  assert.equal(current.outputs.COMMITTEE_SHADOW_OUTPUT, null);

  let release;
  const waiting = new Promise((resolveWait) => { release = resolveWait; });
  const overlapRuntime = h.runtime(successExecutor({ A1: async (component, input) => { await waiting; const at = "2026-08-12T17:15:00.000Z"; return { payload: componentPayload(component, input.source_mode, at, at), observedAt: at, dataCutoffAt: at, evidenceRef: "data/live-shadow/evidence/overlap-a1.json" }; } }), join(h.directory, "overlap"));
  const active = overlapRuntime.runOnce("REPLAY", new Date("2026-08-12T17:15:00.000Z"));
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal((await overlapRuntime.runOnce("REPLAY", new Date("2026-08-12T17:15:00.000Z"))).status, "IN_PROGRESS");
  release();
  await active;

  const persisted = await h.state();
  assert.equal(persisted.outputs.A1_SHADOW_RESULT.component, "A1");
  assert.ok(persisted.runLedger.eventCount >= 48);
});

test("stale data and provider 401 become DATA_BLOCKED without downstream guesses", async (context) => {
  const h = await harness(context);
  for (const [minute, message] of [[0, "A1实时数据超过120秒"], [15, "Robinhood MCP 401"]]) {
    const runtime = h.runtime(successExecutor({ A1: async () => { throw new ShadowRuntimeError("DATA_BLOCKED", message); } }), join(h.directory, `blocked-${minute}`));
    assert.equal((await runtime.runOnce("REPLAY", new Date(`2026-08-12T18:${String(minute).padStart(2, "0")}:00.000Z`))).status, "GENUINE_DATA_BLOCKED");
  }
  const state = await h.state();
  for (const runId of ["replay-shadow:20260812T180000Z", "replay-shadow:20260812T181500Z"]) {
    const runs = state.runLedger.runs.filter((run) => run.run_id === runId);
    assert.equal(runs.find((run) => run.agent_id === "A1").status, "DATA_BLOCKED");
    assert.equal(runs.find((run) => run.agent_id === "A2").status, "SKIPPED");
    assert.equal(runs.find((run) => run.agent_id === "TS").status, "SKIPPED");
    assert.equal(runs.find((run) => run.agent_id === "COMMITTEE").status, "SKIPPED");
    assert.equal(runs.find((run) => run.agent_id === "D").status, "SKIPPED");
    assert.ok(runs.filter((run) => run.agent_id === "A3").every((run) => run.status === "SKIPPED"));
    assert.equal(runs.find((run) => run.agent_id === "CODEX_GUARD").status, "SUCCEEDED");
  }
  assert.equal(state.outputs.TS_SHADOW_OUTPUT.length, 0);
});

test("A2 initialization keeps an unknown state without inventing a start time", () => {
  const payload = componentPayload("A2", "LIVE", "2026-08-14T13:45:51.000Z", "2026-08-14T13:40:00.000Z");
  payload.pattern_evidence = { source_mode: "LIVE", data_grade: "NATURAL_LIVE_SLOT", status: "INITIALIZING", as_of: "2026-08-14T13:45:51.000Z", symbols: Object.fromEntries(["SPY", "QQQ"].map((symbol) => [symbol, { current_state: "UNKNOWN", candidate_state: "UNKNOWN", candidate_bars: 0, state_since: null, data_time: "2026-08-14T13:35:00.000Z" }])) };
  assert.equal(parseOutputEnvelope(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "live-shadow:20260814T134500Z:A2", output_type: "A2_SHADOW_RESULT", channel: "SHADOW", observed_at: payload.observed_at, payload })).payload.pattern_evidence.symbols.SPY.state_since, null);
  const parse = () => parseOutputEnvelope(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "live-shadow:20260814T134500Z:A2", output_type: "A2_SHADOW_RESULT", channel: "SHADOW", observed_at: payload.observed_at, payload }));
  const row = payload.pattern_evidence.symbols.SPY;
  for (const status of ["INITIALIZING", "NOT_OBSERVED", "DEGRADED", "INACTIVE"]) {
    payload.pattern_evidence.status = status;
    row.data_time = null;
    assert.equal(parse().payload.pattern_evidence.symbols.SPY.data_time, null, status);
    for (const invalid of ["", "not-a-date", 0, false, undefined]) {
      row.data_time = invalid;
      assert.throws(parse, /data_time/, `${status}: ${String(invalid)}`);
    }
    row.data_time = null;
    for (const [field, observed] of [["current_state", "TREND_UP"], ["candidate_state", "TREND_UP"], ["candidate_bars", 1], ["state_since", "2026-08-14T13:35:00Z"]]) {
      const before = row[field];
      row[field] = observed;
      assert.throws(parse, /data_time/, `${status}: ${field}`);
      row[field] = before;
    }
  }
  payload.pattern_evidence.status = "HEALTHY";
  assert.throws(parse, /data_time/, "healthy evidence requires a real bar time");
  row.data_time = "2026-08-14T13:35:00.000Z";
  assert.equal(parse().payload.pattern_evidence.symbols.SPY.data_time, row.data_time);
});

test("runtime preserves the V2 natural-slot reason through one frozen Shadow cycle", async (context) => {
  const h = await harness(context);
  let observedReason = null;
  const executor = successExecutor({ A1: async (component, input) => {
    observedReason = input.RUN_REASON;
    const at = "2026-08-12T22:00:00.000Z";
    return { payload: componentPayload(component, input.source_mode, at, at), observedAt: at, dataCutoffAt: at, evidenceRef: "data/live-shadow/evidence/reason-a1.json" };
  } });
  assert.equal((await h.runtime(executor).runOnce("REPLAY", new Date("2026-08-13T01:00:00.000Z"), "次日提前分析")).status, "COMPLETED");
  assert.equal(observedReason, "次日提前分析");
});

test("TS Core freezes A1/A2/TS independently and full analysis resumes the same immutable slot", async (context) => {
  const h = await harness(context);
  const runtime = h.runtime(successExecutor());
  const slot = new Date("2026-08-12T18:30:00.000Z");
  assert.equal((await runtime.runTsCore("REPLAY", slot)).status, "COMPLETED");
  let state = await h.state();
  assert.equal(state.runLedger.runs.filter((run) => run.run_id === "replay-shadow:20260812T183000Z").length, 3);
  assert.equal(state.outputs.TS_SHADOW_OUTPUT[0].role, "TS");
  assert.equal(state.outputs.COMMITTEE_SHADOW_OUTPUT, null);
  assert.equal((await runtime.runOnce("REPLAY", slot)).status, "COMPLETED");
  state = await h.state();
  assert.equal(state.runLedger.runs.filter((run) => run.run_id === "replay-shadow:20260812T183000Z").length, 8);
  assert.equal(state.outputs.A3_FINAL_SHADOW.decision, "NO_TRADE");
});

test("a lower-tier old slot cannot own the next TS Core slot", async (context) => {
  const h = await harness(context);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = h.runtime(successExecutor({ A1: async (component, input) => {
    if (input.slot_id.endsWith("183000Z")) await gate;
    const at = input.slot_id.endsWith("183000Z") ? "2026-08-12T18:30:00.000Z" : "2026-08-12T19:00:00.000Z";
    return { payload: componentPayload(component, input.source_mode, at, at), observedAt: at, dataCutoffAt: at, evidenceRef: `data/live-shadow/evidence/${input.slot_id}.json` };
  } }));
  const lowerTier = runtime.runOnce("REPLAY", new Date("2026-08-12T18:30:00.000Z"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await runtime.runTsCore("REPLAY", new Date("2026-08-12T19:00:00.000Z"))).status, "COMPLETED");
  release();
  assert.equal((await lowerTier).status, "COMPLETED");
});

test("Python adapter rejects legacy providers, keeps the completed bar session and normalizes hashes", () => {
  const code = "import hashlib,json,runpy; m=runpy.run_path('scripts/live-shadow-v2.py'); safe=m['node_json_safe']; adapted=m['supplemental_capability_context']({'contract_version':'v2','component':'APPROVED_CAPABILITY_SNAPSHOT','snapshot_hash':'a'*64}); assert adapted['source_contract_version']=='v2' and 'contract_version' not in adapted; sha=lambda value:hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest(); frozen=m['frozen_context']({'whole':1.0,'nested':[2.0]},sha); assert frozen['context_hash']==sha({'whole':1,'nested':[2]}); gate=m['require_robinhood_snapshot']; good={'status':'LIVE','as_of':'2026-08-12T19:55:00.000Z','market_session':{'market_date':'2026-08-13'},'providers':[{'source':'TRADIER','status':'DISABLED_BACKUP'},{'source':'ROBINHOOD','status':'LIVE'}],'quotes':[{'source':'ROBINHOOD'}],'bars':[{'source':'ROBINHOOD'}],'options':[{'source':'ROBINHOOD'}],'account':{'status':'LIVE','positions':[{'symbol':'QQQ','option_type':'call','direction':'long','expiration':'2030-01-18','strike':350,'quantity':2,'average_price':3},{'symbol':'QQQ','option_type':'call','direction':'long','expiration':'2030-01-18','strike':350,'quantity':3,'average_price':4},{'symbol':'AAPL','option_type':'call','direction':'long','expiration':'2030-06-21','strike':180,'quantity':1,'average_price':2}]}}; gate(good); assert m['frozen_bar_session_date'](good)=='2026-08-12'; positions=m['supported_v2_positions'](good); assert len(positions)==1 and positions[0]['quantity']==5 and positions[0]['actual_fill_price']==3.6 and positions[0]['cumulative_cost_usd']==1800; bad={**good,'providers':[{'source':'TRADIER','status':'HEALTHY'}]}; blocked=False;\ntry: gate(bad)\nexcept m['DataBlocked']: blocked=True\nassert blocked; print(json.dumps(safe({'zero':-0.0,'whole':1.0,'fraction':0.25,'nested':[2.0]}),separators=(',',':')))";
  const command = packagePython;
  const args = ["-B", "-c", code];
  const result = spawnSync(command, args, { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { zero: 0, whole: 1, fraction: 0.25, nested: [2] });
});

test("A1 earnings watch removes duplicate contract identities before ranking", () => {
  const code = "import runpy; m=runpy.run_path('scripts/live-shadow-v2.py'); rows=[{'symbol':'PANW','date':'2026-09-01','session':'UNKNOWN'},{'symbol':'DELL','date':'2026-09-01','session':'UNKNOWN'},{'symbol':'PANW','date':'2026-09-01','session':'UNKNOWN'}]; out=m['deduplicate_earnings'](rows); assert out==rows[:2]";
  const command = packagePython;
  const args = ["-B", "-c", code];
  const result = spawnSync(command, args, { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("frozen freshness is decided at collection and does not expire while the same slot is processing", () => {
  const code = "import runpy; m=runpy.run_path('scripts/live-shadow-v2.py'); age=m['frozen_source_age_seconds']; assert age({'source_collected_at':'2026-08-27T17:25:00.000Z','market_clock':{'observed_at':'2026-08-27T17:30:25.969Z'}})==325.969; assert age({'source_collected_at':'2026-08-27T17:25:00.000Z','market_clock':{'observed_at':'2026-08-27T17:32:01.000Z'}})==421";
  const command = packagePython;
  const args = ["-B", "-c", code];
  const result = spawnSync(command, args, { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("official source parsers preserve source grade and replay cannot mutate natural pattern state", () => {
  const code = String.raw`import runpy
from datetime import datetime, UTC
from pathlib import Path
m=runpy.run_path('scripts/live-shadow-v2.py')
assert m['pattern_state_path'](Path('root'),'LIVE').name=='pattern_tracker.json'
assert m['pattern_state_path'](Path('root'),'REPLAY').name=='pattern_tracker-replay.json'
class Client:
 def text(self,url,**kwargs):
  if 'treasury.gov' in url: return '''<feed xmlns="http://www.w3.org/2005/Atom" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices"><entry><content><m:properties><d:NEW_DATE>2026-08-12T00:00:00</d:NEW_DATE><d:BC_2YEAR>4.20</d:BC_2YEAR><d:BC_10YEAR>4.68</d:BC_10YEAR><d:BC_30YEAR>5.24</d:BC_30YEAR></m:properties></content></entry></feed>'''
  if 'eia.gov' in url: return '<table><tr><td>2026 Aug-10 to Aug-14</td><td>83.76</td><td>84.77</td><td></td><td></td><td></td></tr></table>'
  if 'fred.' in url: return '<table><tr><td>Friday September 11, 2026</td></tr></table>'
  if 'federalreserve.' in url: return '>2026 FOMC Meetings<<div class="fomc-meeting__month"><strong>September</strong></div><div class="fomc-meeting__date">15-16*</div>>2025 FOMC Meetings<'
  return '<table><tr><td>Advance Monthly Sales for Retail and Food Services</td><td>August 14, 2026</td><td>8:30 AM</td><td>July 2026</td></tr></table>'
class Collector: client=Client()
sha=lambda value:'a'*64
generated=datetime(2026,8,13,14,tzinfo=UTC); end=datetime(2026,9,27,tzinfo=UTC)
assert len(m['_fred_schedule'](Collector(),generated,end,sha))==3
assert len(m['_fred_schedule'](Collector(),datetime(2026,9,12,1,tzinfo=UTC),end,sha))==3
assert m['_fred_schedule'](Collector(),datetime(2026,9,12,7,tzinfo=UTC),end,sha)==[]
assert m['_fomc_schedule'](Collector(),generated,end,sha)[0]['time_precision']=='DATE_ONLY'
assert len(m['_fomc_schedule'](Collector(),datetime(2026,9,17,1,tzinfo=UTC),end,sha))==1
assert m['_fomc_schedule'](Collector(),datetime(2026,9,17,7,tzinfo=UTC),end,sha)==[]
assert m['_census_schedule'](Collector(),generated,end,sha)[0]['scheduled_at']=='2026-08-14T12:30:00+00:00'
market=m['_official_market_context'](Collector(),'2026-08-13T14:00:00.000Z',sha)
assert market['treasury_yields']['observations'][3]['value']==0.48
assert market['wti']['observations'][0]['value']==84.77
assert market['status']=='LIVE'
assessment={'enhanced_available':['OPTIONS_POSITIONING'],'enhanced_missing':['A2_HISTORICAL_SIMILARITY','MACRO_SCHEDULE','MARKET_MOVING_NEWS','OIL_CONTEXT','OVERNIGHT_FUTURES','RATES_CONTEXT','SECTOR_BREADTH']}
sectors=['XLB','XLC','XLE','XLF','XLI','XLK','XLP','XLRE','XLU','XLV','XLY']
environment={'sector_breadth':{'status':'LIVE','interpretation':'SECTOR_ETF_ADVANCE_DECLINE','instruments':[{'symbol':symbol,'source':'ROBINHOOD','role':'SECTOR','status':'LIVE','change_pct':1} for symbol in sectors]}}
m['apply_frozen_market_evidence']({'evidence_assessment':assessment},{'market_context':market},environment)
assert assessment['enhanced_available']==['OIL_CONTEXT','OPTIONS_POSITIONING','RATES_CONTEXT','SECTOR_BREADTH']
assert set(assessment['enhanced_missing'])=={'A2_HISTORICAL_SIMILARITY','MACRO_SCHEDULE','MARKET_MOVING_NEWS','OVERNIGHT_FUTURES'}
blocked={'treasury_yields':{**market['treasury_yields'],'status':'STALE'},'wti':{**market['wti'],'observations':[]}}
assessment={'enhanced_available':[],'enhanced_missing':['OIL_CONTEXT','RATES_CONTEXT','SECTOR_BREADTH']}
m['apply_frozen_market_evidence']({'evidence_assessment':assessment},{'market_context':blocked},{'sector_breadth':{'status':'DATA_BLOCKED','instruments':[]}})
assert assessment['enhanced_available']==[]
print('ok')`;
  const command = packagePython;
  const args = ["-B", "-c", code];
  const result = spawnSync(command, args, { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ok");
});

test("official macro producer retains released-today GDP PCE and direct BLS schedules for the whole PT date", () => {
  const code = String.raw`import copy,runpy,sys,types
m=runpy.run_path('scripts/live-shadow-v2.py')
release_at='2026-09-30T12:30:00+00:00'
schedule={'release_name':'Consumer Price Index','scheduled_at':release_at,'source_url':'https://www.bls.gov/schedule/news_release/bls.ics','confidence':'official_schedule'}
future={**schedule,'release_name':'Employment Situation','scheduled_at':'2026-10-02T12:30:00+00:00'}
watch={'status':'HEALTHY','events':[future]}; due=[{'schedule':schedule,'expected_period':'2026-08'}]
original=copy.deepcopy((watch,due))
class Client:
 def json(self,origin,path,**kwargs):
  assert origin=='https://apps.bea.gov' and path=='/API/signup/release_dates.json'
  return {name:{'release_dates':['2026-09-29T12:30:00+00:00',release_at,'2026-10-29T12:30:00+00:00','2027-01-01T12:30:00+00:00']} for name in ('Gross Domestic Product','Personal Income and Outlays')}
class Collector:
 def __init__(self,config): self.client=Client()
 def _collect_bls_macro_calendar_snapshot(self,**kwargs): return watch,due
 def _collect_official_news(self): return {'status':'HEALTHY','healthy_feed_count':1,'feeds':[],'items':[]}
service=types.ModuleType('trading_os_v2.a1.service')
service.A1Collector=Collector; service._bls_official_feed_status=lambda value:'HEALTHY'; service._macro_results=lambda *args,**kwargs:[]
sys.modules['trading_os_v2.a1.service']=service
g=m['collect_official_macro_context'].__globals__
def fred_blocked(*args): raise RuntimeError('test-only FRED unavailable')
g['_fred_schedule']=fred_blocked
g['_census_schedule']=lambda *args:[]; g['_fomc_context']=lambda *args:([],[]); g['_bls_observations']=lambda *args:[]
group={'source':'TEST_ONLY','status':'EOD','as_of':release_at,'data_grade':'TEST_ONLY','error':None}
g['_official_market_context']=lambda *args:{'treasury_yields':group,'wti':group}
for at in ('2026-09-30T13:30:00Z','2026-10-01T01:00:00Z'):
 result=m['collect_official_macro_context']({},at,lambda value:'a'*64)
 today=[event for event in result['events'] if event['scheduled_at']==release_at]
 assert {event['release_name'] for event in today}=={'Consumer Price Index','Gross Domestic Product','Personal Income and Outlays'}
 assert all(event['time_precision']=='EXACT' for event in result['events'])
 assert len(result['events'])==6
 assert not any(event['scheduled_at'].startswith(('2026-09-29','2027-01-01')) for event in result['events'])
 assert result['coverage']['inflation']=='DATA_BLOCKED', 'direct BLS facts survive a missing fallback without inventing coverage'
after=m['collect_official_macro_context']({},'2026-10-01T07:00:00Z',lambda value:'a'*64)
assert all(event['scheduled_at']!=release_at for event in after['events'])
assert (watch,due)==original, 'local normalization must not rewrite v2 evidence'
print('ok')`;
  const command = packagePython;
  const args = ["-B", "-c", code];
  const result = spawnSync(command, args, { cwd: resolve("."), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ok");
});

test("FOMC official statement is reduced to a reviewable policy result", () => {
  const code = String.raw`import runpy
from datetime import datetime, UTC
m=runpy.run_path('scripts/live-shadow-v2.py')
class Client:
 def text(self,url,**kwargs):
  if 'pressreleases' in url: return '<p>The Committee decided to maintain the target range for the federal funds rate at 3-1/2 to 3-3/4 percent.</p>'
  return '>2026 FOMC Meetings<<div class="fomc-meeting__month"><strong>September</strong></div><div class="fomc-meeting__date">15-16*</div>>2025 FOMC Meetings<'
class Collector: client=Client()
events,results=m['_fomc_context'](Collector(),datetime(2026,9,16,20,tzinfo=UTC),datetime(2026,10,31,tzinfo=UTC),lambda value:'a'*64)
assert events[0]['release_name']=='FOMC Meeting Decision'
assert results[0]['decision']=='HOLD' and results[0]['status']=='VERIFIED'
assert results[0]['source_url'].endswith('monetary20260916a.htm')
print('ok')`;
  const command = packagePython;
  const args = ["-B", "-c", code];
  const result = spawnSync(command, args, { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ok");
});

const localV2Reference = resolve(import.meta.dirname, "../../v2-reference");

test("A2 checks frozen position quotes at inspection time without renewing or rewriting source evidence", () => {
  const code = `import hashlib,json,runpy,sys,tempfile
from datetime import datetime, UTC, timedelta
from pathlib import Path
m=runpy.run_path('scripts/live-shadow-v2.py')
v2=Path(${JSON.stringify(localV2Reference)})
sys.path.insert(0,str(v2))
start=datetime(2026,9,8,14,30,tzinfo=UTC)
stamp=lambda seconds:(start+timedelta(seconds=seconds)).isoformat()
class Clock(datetime):
 @classmethod
 def now(cls,tz=None): return start+timedelta(seconds=40)
class ProbeComplete(Exception): pass
g=m['run_step'].__globals__
g['datetime']=Clock
g['verified_official_macro']=lambda *args:{}
g['generic_market_to_v2']=lambda snapshot,*args:{'positions':m['supported_v2_positions'](snapshot)}
real_monitor=m['frozen_position_monitor']
Path('data/live-shadow').mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(dir='data/live-shadow') as folder:
 for label,quote_at,account_at,healthy in [('collected after start',24,0,True),('exactly120',-80,0,True),('stale quote',-80.001,0,False),('future quote',40.001,0,False),('stale account',24,-80.001,False),('future account',24,40.001,False)]:
  row={'contract_id':'spy-call','symbol':'SPY','option_type':'call','expiration':'2026-09-11','strike':100,'direction':'long','quantity':2,'average_price':2,'bid':2.4,'ask':2.45,'mark':2.425,'as_of':stamp(quote_at)}
  snapshot={'status':'LIVE','generated_at':stamp(0),'market_session':{'state':'REGULAR'},'account':{'source':'ROBINHOOD','status':'LIVE','as_of':stamp(account_at),'positions':[row]}}
  request={'component':'A2','input':{'source_mode':'LIVE','run_id':'live-shadow:20260908T143000Z','A1':{'market_sources':snapshot}}}
  before=hashlib.sha256(json.dumps(request,sort_keys=True).encode()).hexdigest()
  def inspect(frozen,positions,root,checked_at,orchestrator):
   result,gaps=real_monitor(frozen,positions,root,checked_at,orchestrator)
   actual=bool(result and result['positions'][0]['quote_status']=='HEALTHY')
   assert actual==healthy, f'{label}: checked_at={checked_at}, result={result}, gaps={gaps}'
   assert checked_at==stamp(40), f'{label}: inspection incorrectly used capture start {checked_at}'
   if healthy:
    assert not gaps and result['positions'][0]['source_quote_at']==stamp(quote_at)
    assert result['positions'][0]['exit_return_pct']==20
   raise ProbeComplete()
  g['frozen_position_monitor']=inspect
  try: m['run_step'](request,v2,Path(folder)/label.replace(' ','-'))
  except ProbeComplete: pass
  else: raise AssertionError('A2 did not invoke the frozen position monitor')
  assert hashlib.sha256(json.dumps(request,sort_keys=True).encode()).hexdigest()==before, 'source evidence changed'
print('ok')`;
  const command = packagePython;
  const args = ["-B", "-c", code];
  const result = spawnSync(command, args, { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ok");
});

test("V2 position monitor consumes frozen holdings and never closes them from untrusted account evidence", () => {
  const code = `import hashlib,json,runpy,sys,tempfile
from pathlib import Path
m=runpy.run_path('scripts/live-shadow-v2.py')
v2=Path(${JSON.stringify(localV2Reference)})
sys.path.insert(0,str(v2))
Path('data/live-shadow').mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(dir='data/live-shadow') as folder:
 root=Path(folder)
 _,_,orchestrator,_=m['configure'](v2,root)
 at='2026-08-13T16:00:00+00:00'
 row={'contract_id':'spy-call','symbol':'SPY','option_type':'call','expiration':'2026-08-14','strike':100,'direction':'long','quantity':2,'average_price':2,'bid':2.4,'ask':2.45,'mark':2.425,'as_of':at}
 account={'source':'ROBINHOOD','status':'LIVE','as_of':at,'positions':[row]}
 snapshot={'generated_at':at,'market_session':{'state':'REGULAR'},'account':account}
 positions=m['supported_v2_positions'](snapshot)
 monitor,gaps=m['frozen_position_monitor'](snapshot,positions,root,at,orchestrator)
 assert gaps==[] and monitor['status']=='HEALTHY' and monitor['positions'][0]['quote_status']=='HEALTHY'
 assert monitor['positions'][0]['exit_return_pct']==20 and monitor['pending_events'][0]['event_type']=='PLAN_REQUIRED'
 stale={**snapshot,'account':{**account,'positions':[{**row,'as_of':'2026-08-13T15:57:00+00:00'}]}}
 blocked,stale_gaps=m['frozen_position_monitor'](stale,positions,root,at,orchestrator)
 assert blocked is None and stale_gaps
 positions_path=root/'v2-runtime/a1/confirmed_positions.json'
 hashes=lambda:{str(path.relative_to(root)):hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob('*') if path.is_file()}
 before=hashes()
 invalid_accounts=[
  ('nonlive',{**account,'status':'DATA_BLOCKED','positions':[]}),
  ('missing account',None),
  ('missing source',{key:value for key,value in account.items() if key!='source'}),
  ('wrong source',{**account,'source':'TRADIER'}),
  ('missing positions',{key:value for key,value in account.items() if key!='positions'}),
  ('null positions',{**account,'positions':None}),
  ('nonlist positions',{**account,'positions':{}}),
  ('stale account',{**account,'as_of':'2026-08-13T15:58:00.999+00:00'}),
  ('future account',{**account,'as_of':'2026-08-13T16:00:01.001+00:00'}),
  ('missing time',{**account,'as_of':None}),
  ('invalid time',{**account,'as_of':'invalid'}),
  ('naive time',{**account,'as_of':'2026-08-13T16:00:00'}),
  ('incomplete instrument',{**account,'positions':[{**row,'strike':None,'option_type':None}]}),
  ('unknown row',{**account,'positions':[None]}),
  ('unknown direction',{**account,'positions':[{**row,'direction':'unknown'}]}),
 ]+[(f'missing holding {field}',{**account,'positions':[{**row,field:None}]}) for field in ('symbol','direction','option_type','expiration','strike','quantity','average_price')]
 for label,invalid_account in invalid_accounts:
  invalid={**snapshot,'account':invalid_account}
  blocked,account_gaps=m['frozen_position_monitor'](invalid,m['supported_v2_positions'](invalid),root,'2026-08-13T16:00:01+00:00',orchestrator)
  statuses=[item['status'] for item in json.loads(positions_path.read_text())['positions']]
  assert hashes()==before, f'{label} changed frozen files; holding statuses={statuses}'
  assert blocked is None and account_gaps and statuses==['OPEN'], label
 for invalid_checked_at in ('invalid','2026-08-13T16:00:00'):
  blocked,account_gaps=m['frozen_position_monitor'](snapshot,positions,root,invalid_checked_at,orchestrator)
  assert blocked is None and account_gaps and hashes()==before
 unsupported={**snapshot,'account':{**account,'positions':[row,{**row,'symbol':'NOK','option_type':None,'strike':None},{**row,'direction':'short','option_type':None,'strike':None}]}}
 supported=m['supported_v2_positions'](unsupported)
 monitor,gaps=m['frozen_position_monitor'](unsupported,supported,root,at,orchestrator)
 assert gaps==[] and len(monitor['positions'])==1 and supported[0]['quantity']==2
 empty={**snapshot,'account':{**account,'as_of':'2026-08-13T15:58:01+00:00','positions':[]}}
 monitor,gaps=m['frozen_position_monitor'](empty,m['supported_v2_positions'](empty),root,'2026-08-13T16:00:01+00:00',orchestrator)
 assert gaps==[] and monitor['status']=='IDLE' and monitor['positions']==[]
 assert [item['status'] for item in json.loads(positions_path.read_text())['positions']]==['CLOSED']
 assert hashes()!=before
print('ok')`;
  const command = packagePython;
  const args = ["-B", "-c", code];
  const result = spawnSync(command, args, { cwd: resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ok");
});

test("Robinhood official MCP is exact-read-only and projects live data without account numbers", async () => {
  const observedAt = "2026-08-12T17:00:00.000Z";
  const response = (data) => ({ structuredContent: { data }, content: [] });
  const instruments = ["SPY", "QQQ"].flatMap((symbol) => ["call", "put"].map((type) => ({ id: `${symbol}-${type}`, chain_symbol: symbol, type, expiration_date: "2026-08-12", strike_price: symbol === "SPY" ? "500.0000" : "400.0000" })));
  const weekdayBars = (count, hour) => {
    const dates = [], cursor = new Date("2026-08-12T00:00:00.000Z");
    while (dates.length < count) { if (![0, 6].includes(cursor.getUTCDay())) dates.unshift(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), hour)).toISOString()); cursor.setUTCDate(cursor.getUTCDate() - 1); }
    return dates;
  };
  const historicalBars = (args) => {
    if (args.interval === "day") {
      const count = args.symbols.length === 2 ? 21 : 22;
      return weekdayBars(count, 20).map((begins_at, index) => ({ begins_at, open_price: `${480 + index}`, high_price: `${482 + index}`, low_price: `${479 + index}`, close_price: `${481 + index}`, volume: `${1000 + index * 100}` }));
    }
    if (["4hour", "hour", "30minute"].includes(args.interval)) return weekdayBars(21, 13).map((begins_at, index) => ({ begins_at, open_price: `${480 + index}`, high_price: `${482 + index}`, low_price: `${479 + index}`, close_price: `${481 + index}`, volume: `${1000 + index * 100}` }));
    return [{ begins_at: "2026-08-12T16:55:00.000Z", open_price: "499", high_price: "501", low_price: "498", close_price: "500", volume: "1000" }];
  };
  const session = {
    async listTools() { return {}; },
    async call(tool, args) {
      if (tool === "get_equity_quotes") return response({ results: args.symbols.map((symbol, index) => ({ quote: { symbol, last_trade_price: `${500 + index}`, bid_price: `${499.99 + index}`, ask_price: `${500.01 + index}`, previous_close: `${499 + index}`, venue_last_trade_time: "2026-08-12T16:59:59.000Z", last_non_reg_trade_price: ["SPY", "QQQ"].includes(symbol) ? `${499.5 + index}` : null, venue_last_non_reg_trade_time: ["SPY", "QQQ"].includes(symbol) ? "2026-08-12T12:00:00.000Z" : null } })) });
      if (tool === "get_equity_historicals") return response({ results: args.symbols.map((symbol) => ({ symbol, bars: historicalBars(args) })) });
      if (tool === "get_option_chains") return response({ chains: [{ symbol: args.underlying_symbol, expiration_dates: ["2026-08-12"] }] });
      if (tool === "get_option_instruments") return response({ instruments: args.ids ? instruments.filter((item) => args.ids.includes(item.id)) : instruments.filter((item) => item.chain_symbol === args.chain_symbol) });
      if (tool === "get_option_quotes") return response({ results: args.instrument_ids.map((id) => ({ quote: { instrument_id: id, bid_price: "1", ask_price: "1.1", mark_price: "1.05", implied_volatility: "0.2", delta: "0.5", gamma: "0.02", theta: "-0.1", vega: "0.08", updated_at: "2026-08-12T16:59:59.000Z" } })) });
      if (tool === "get_option_historicals") return response({ results: args.instrument_ids.map((id) => ({ instrument_id: id, bars: [{ begins_at: "2026-08-12T16:30:00.000Z" }] })) });
      if (tool === "get_accounts") return response({ accounts: [{ account_number: "TEST-ACCOUNT-A", rhs_account_number: "TEST-RHS-A" }] });
      if (tool === "get_option_positions") return response({ positions: [{ option_id: "SPY-call", chain_symbol: "SPY", type: "long", quantity: "2", average_price: "80", expiration_date: "2026-08-12", opened_at: "2026-08-12T15:00:00.000Z" }] });
      if (tool === "get_option_orders") return response({ orders: [{ chain_symbol: "SPY", state: "filled", direction: "debit", quantity: "2", price: "0.8", premium: "160", created_at: "2026-08-12T15:00:00.000Z" }] });
      if (tool === "get_portfolio") return response({ total_value: "1000", options_value: "210" });
      if (tool === "get_realized_pnl") return response({ total_returns: "12.5", account_number: "TEST-RHS-A" });
      throw new Error(`unexpected ${tool}`);
    },
  };
  const projection = await collectRobinhoodReadonly(session, observedAt, {
    events: [
      { event_id: "news-1", event_fingerprint: "fingerprint-1", kind: "NEWS", title: "Verified market shock", source: "Reuters", source_url: null, published_at: observedAt, scheduled_for: null, fetched_at: observedAt, affected_symbols: ["XYZ"], industry: null, event_type: "market_shock", novelty: "NEW", importance: "MARKET_MOVING", event_evidence_state: "VERIFIED" },
      { event_id: "earnings-1", event_fingerprint: "earnings-1", kind: "EARNINGS", title: "NVDA earnings", source: "Finnhub", source_url: null, published_at: null, scheduled_for: "2026-08-13T20:00:00.000Z", fetched_at: observedAt, affected_symbols: ["NVDA"], industry: null, event_type: "earnings", novelty: "NEW", importance: "SCHEDULED", event_evidence_state: "UNVERIFIED" },
      { event_id: "earnings-result-1", event_fingerprint: null, kind: "EARNINGS", title: "AAPL 财报结果", source: "Finnhub Earnings Calendar", source_url: null, published_at: null, scheduled_for: "2026-08-11", fetched_at: observedAt, affected_symbols: ["AAPL"], industry: null, event_type: "earnings_result", novelty: "NEW", importance: "SCHEDULED", event_evidence_state: "VERIFIED", earnings_result: { session: "AMC", eps_actual: 2.1, eps_estimate: 2, revenue_actual: 1050, revenue_estimate: 1000, reported: true } },
    ],
    causalChains: [{ chain_id: "chain-1", event_fingerprint: "fingerprint-1", event_category: "market_shock", what_happened: "verified event identity", affected: ["XYZ"], mechanism: "待验证假设", expected_direction: "待验证假设", expected_duration: "待验证假设", supporting_evidence: [], opposing_evidence: [], market_confirmation: "NOT_OBSERVED", confidence: null, invalidation_condition: "待验证假设", expires_at: "2026-08-20T00:00:00.000Z", evidence_state: "待验证假设", event_evidence_state: "VERIFIED", updated_at: observedAt }],
  });
  assert.equal(projection.mode, "SHADOW");
  assert.deepEqual(projection.providers.map((item) => [item.source, item.status]), [["TRADIER", "DISABLED_BACKUP"], ["ROBINHOOD", "LIVE"]]);
  assert.ok(projection.quotes.every((item) => item.source === "ROBINHOOD" && item.status === "LIVE" && item.as_of && item.freshness_seconds === 1));
  assert.ok(projection.bars.every((item) => item.interval === "5min" && item.bar_count === 1 && item.daily_bar_count === 21 && item.as_of === observedAt && item.freshness_seconds === 0));
  assert.ok(projection.options.every((item) => item.bbo_count === 2 && item.iv_count === 2 && item.greeks_count === 2 && item.contracts[0].history_bars === 1));
  assert.equal(projection.account.positions.length, 1);
  assert.equal(projection.account.positions[0].average_price, 0.8);
  assert.equal(projection.account.positions[0].contract_id, "SPY-call");
  assert.equal(projection.account.positions[0].bid, 1);
  assert.equal(projection.account.positions[0].delta, 0.5);
  assert.equal(projection.account.orders.length, 1);
  assert.equal(projection.account.realized_pnl, 12.5);
  assert.equal(projection.market_environment.futures.status, "NOT_SUPPORTED");
  assert.equal(projection.market_environment.rates.instruments.length, 2);
  assert.equal(projection.market_environment.oil.instruments[0].symbol, "USO");
  assert.equal(projection.market_environment.sector_breadth.instruments.length, 11);
  assert.equal(projection.market_environment.sector_breadth.advance_pct, 100);
  assert.equal(projection.market_environment.extended_hours.status, "OBSERVED");
  assert.equal(projection.market_environment.extended_hours.data_grade, "OFFICIAL_READONLY_24_5_OHLCV");
  assert.deepEqual(projection.market_environment.extended_hours.coverage, { official_ohlcv: 90, local_sampled_quote: 0, recent_eod: 0, not_supported: 0, read_failed: 0 });
  assert.deepEqual(projection.market_environment.extended_hours.risk_boundary, { confidence: "LOW", can_override_regular_regime: false, can_generate_option_order: false, requires_regular_open_confirmation: true });
  assert.equal(projection.approved_capabilities.fixed_pool.observed_count, 90);
  assert.equal(projection.approved_capabilities.fixed_pool.universe_size, 90);
  assert.equal(projection.approved_capabilities.fixed_pool.data_grade, "OFFICIAL_READONLY_MULTI_TIMEFRAME_SWING");
  assert.deepEqual(Object.values(projection.approved_capabilities.fixed_pool.rows[0].timeframes).map((item) => item.available), [true, true, true, true]);
  assert.equal(projection.approved_capabilities.fixed_pool.rows[0].swing.observed_timeframes, 4);
  assert.equal(projection.approved_capabilities.fixed_pool.rows[0].swing.stage, "CONFIRMED");
  assert.equal(projection.approved_capabilities.fixed_pool.candidates.length, 5);
  const firstAapl = projection.approved_capabilities.fixed_pool.rows.find((item) => item.symbol === "AAPL");
  const firstSpy = projection.approved_capabilities.fixed_pool.rows.find((item) => item.symbol === "SPY");
  assert.equal(firstAapl.swing.management.state, "DISCOVERED");
  assert.equal(firstAapl.swing.management.primary_timeframe, "1d");
  assert.equal(firstAapl.swing.management.relative_strength.basis, "20_COMPLETED_DAILY_BARS");
  assert.equal(firstSpy.swing.management.state, "HOLDING");
  const blockedAccountSnapshot = structuredClone(projection.approved_capabilities);
  blockedAccountSnapshot.generated_at = "2026-08-12T17:15:00.000Z";
  blockedAccountSnapshot.real_positions = { ...blockedAccountSnapshot.real_positions, status: "DATA_BLOCKED", count: null, symbols: [] };
  const blockedAccount = applyFixed70SwingManagement(blockedAccountSnapshot, projection.approved_capabilities, projection.market_environment);
  assert.equal(blockedAccount.fixed_pool.rows.find((item) => item.symbol === "SPY").swing.management.state, "HOLDING");
  const duplicate = applyFixed70SwingManagement(projection.approved_capabilities, projection.approved_capabilities, projection.market_environment);
  assert.equal(duplicate.fixed_pool.rows.find((item) => item.symbol === "AAPL").swing.management.state, "DISCOVERED");
  assert.equal(duplicate.fixed_pool.rows.find((item) => item.symbol === "AAPL").swing.management.review_count, 1);
  const nextSnapshot = structuredClone(projection.approved_capabilities);
  nextSnapshot.generated_at = "2026-08-12T17:30:00.000Z";
  const reviewed = applyFixed70SwingManagement(nextSnapshot, projection.approved_capabilities, projection.market_environment);
  assert.equal(reviewed.fixed_pool.rows.find((item) => item.symbol === "AAPL").swing.management.state, "WAITING_CONFIRMATION");
  assert.equal(reviewed.fixed_pool.rows.find((item) => item.symbol === "AAPL").swing.management.review_count, 2);
  const eventDrivenSnapshot = structuredClone(nextSnapshot);
  eventDrivenSnapshot.event_scan.items = [
    { event_id: "tesla-event", title: "Tesla product event", source: "Reuters", published_at: observedAt, importance: "NOT_VERIFIED", affected_symbols: ["TSLA"], evidence_state: "UNVERIFIED", impact_mapping: ["TSLA"] },
    { event_id: "dell-event", title: "Dell earnings reaction", source: "Reuters", published_at: observedAt, importance: "NOT_VERIFIED", affected_symbols: ["DELL"], evidence_state: "UNVERIFIED", impact_mapping: ["DELL"] },
  ];
  for (const [symbol, change, relativeReturn] of [["TSLA", 6.2, 12], ["DELL", 3.5, 10]]) {
    const row = eventDrivenSnapshot.fixed_pool.rows.find((item) => item.symbol === symbol);
    row.change_pct = change;
    row.volume_context = "放量";
    row.timeframes.daily.return_pct = relativeReturn;
  }
  const eventRanked = applyFixed70SwingManagement(eventDrivenSnapshot, projection.approved_capabilities, projection.market_environment);
  assert.deepEqual(eventRanked.fixed_pool.candidates.slice(0, 4).sort(), ["AAPL", "DELL", "SPY", "TSLA"]);
  const noisySnapshot = structuredClone(reviewed);
  noisySnapshot.generated_at = "2026-08-12T18:00:00.000Z";
  const noisyAapl = noisySnapshot.fixed_pool.rows.find((item) => item.symbol === "AAPL");
  noisyAapl.timeframes.one_hour.direction = "BEARISH";
  noisyAapl.timeframes.thirty_minute.direction = "BEARISH";
  noisyAapl.swing.stage = "EARLY_WATCH";
  const weakened = applyFixed70SwingManagement(noisySnapshot, reviewed, projection.market_environment);
  assert.equal(weakened.fixed_pool.rows.find((item) => item.symbol === "AAPL").swing.management.state, "WEAKENING");
  assert.equal(weakened.fixed_pool.rows.find((item) => item.symbol === "AAPL").swing.management.primary_timeframe, "1d");
  const expiredSnapshot = structuredClone(reviewed);
  const timeStop = reviewed.fixed_pool.rows.find((item) => item.symbol === "AAPL").swing.management.time_invalidation_date;
  expiredSnapshot.generated_at = `${timeStop}T17:00:00.000Z`;
  const settled = applyFixed70SwingManagement(expiredSnapshot, reviewed, projection.market_environment);
  assert.equal(settled.fixed_pool.rows.find((item) => item.symbol === "AAPL").swing.management.state, "SETTLED");
  assert.equal(settled.fixed_pool.rows.find((item) => item.symbol === "AAPL").swing.management.archive_status, "ARCHIVED");
  const blockedBeforeExpiry = structuredClone(nextSnapshot);
  blockedBeforeExpiry.fixed_pool.rows.find((item) => item.symbol === "AAPL").status = "DATA_BLOCKED";
  const retained = applyFixed70SwingManagement(blockedBeforeExpiry, projection.approved_capabilities, projection.market_environment);
  assert.equal(retained.fixed_pool.rows.find((item) => item.symbol === "AAPL").swing.management.state, "DISCOVERED", "blocked observations do not upgrade an unexpired opportunity");
  for (const accountStatus of ["OBSERVED", "DATA_BLOCKED"]) for (const holdingDataStatus of ["LIVE", "DATA_BLOCKED"]) {
    const blockedExpiry = structuredClone(expiredSnapshot);
    blockedExpiry.fixed_pool.rows.find((item) => item.symbol === "AAPL").status = "DATA_BLOCKED";
    blockedExpiry.fixed_pool.rows.find((item) => item.symbol === "SPY").status = holdingDataStatus;
    if (accountStatus === "DATA_BLOCKED") blockedExpiry.real_positions = { ...blockedExpiry.real_positions, status: "DATA_BLOCKED", count: null, symbols: [] };
    const expiredBlocked = applyFixed70SwingManagement(blockedExpiry, reviewed, projection.market_environment);
    const archived = expiredBlocked.fixed_pool.rows.find((item) => item.symbol === "AAPL").swing.management;
    assert.equal(archived.state, "SETTLED", "the ten-session deadline still expires when structure reads remain blocked");
    assert.equal(archived.archive_status, "ARCHIVED");
    assert.equal(archived.lifecycle_id, firstAapl.swing.management.lifecycle_id);
    assert.equal(archived.first_seen_at, firstAapl.swing.management.first_seen_at);
    assert.match(archived.settlement_reason, /波段时间失效/);
    assert.ok(!expiredBlocked.fixed_pool.candidates.includes("AAPL"));
    const keptHolding = expiredBlocked.fixed_pool.rows.find((item) => item.symbol === "SPY").swing.management;
    assert.equal(keptHolding.state, "HOLDING", "actual holdings and prior holdings with blocked account data cannot expire");
    assert.equal(keptHolding.archive_status, "ACTIVE");
    assert.equal(keptHolding.settlement_reason, null);
    if (accountStatus === "DATA_BLOCKED") assert.match(keptHolding.state_reason, /不推断离场/);
  }
  assert.deepEqual(projection.approved_capabilities.extended_discovery.symbols, ["XYZ"]);
  assert.ok(projection.approved_capabilities.earnings_center.items.some((item) => item.symbol === "NVDA"));
  assert.equal(projection.approved_capabilities.earnings_center.items.find((item) => item.symbol === "AAPL").result_status, "REPORTED_WAITING_REACTION");
  assert.equal(projection.approved_capabilities.owner_watchlist.status, "NOT_OBSERVED");
  assert.deepEqual(projection.approved_capabilities.owner_watchlist.items, []);
  assert.equal(projection.approved_capabilities.real_positions.count, 1);
  assert.equal(parseOutputEnvelope(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "live-shadow:20260812T170000Z:A1", output_type: "A1_SHADOW_RESULT", channel: "SHADOW", observed_at: observedAt, payload: { ...componentPayload("A1", "LIVE", observedAt, observedAt), market_sources: projection } })).payload.market_sources.approved_capabilities.fixed_pool.observed_count, 90);
  const afterClose = await collectRobinhoodReadonly(session, "2026-08-12T22:00:00.000Z", { events: [{ event_id: "earnings-result-1", event_fingerprint: null, kind: "EARNINGS", title: "AAPL 财报结果", source: "Finnhub Earnings Calendar", source_url: null, published_at: null, scheduled_for: "2026-08-11", fetched_at: observedAt, affected_symbols: ["AAPL"], industry: null, event_type: "earnings_result", novelty: "NEW", importance: "SCHEDULED", event_evidence_state: "VERIFIED", earnings_result: { session: "AMC", eps_actual: 2.1, eps_estimate: 2, revenue_actual: 1050, revenue_estimate: 1000, reported: true } }], causalChains: [] });
  assert.equal(afterClose.approved_capabilities.earnings_center.items[0].result_status, "IMPACT_OBSERVED");
  const midnightDaily = await collectRobinhoodReadonly({ ...session, async call(tool, args) {
    if (tool === "get_equity_historicals" && args.interval === "day") return response({ results: args.symbols.map((symbol) => ({ symbol, bars: historicalBars(args).map((bar) => ({ ...bar, begins_at: `${bar.begins_at.slice(0, 10)}T00:00:00.000Z` })) })) });
    return session.call(tool, args);
  } }, "2026-08-13T17:00:00.000Z", { events: [{ event_id: "earnings-result-midnight", event_fingerprint: null, kind: "EARNINGS", title: "AAPL 财报结果", source: "Finnhub Earnings Calendar", source_url: null, published_at: null, scheduled_for: "2026-08-11", fetched_at: observedAt, affected_symbols: ["AAPL"], industry: null, event_type: "earnings", novelty: "NEW", importance: "SCHEDULED", event_evidence_state: "VERIFIED", earnings_result: { session: "AMC", eps_actual: null, eps_estimate: 2, revenue_actual: null, revenue_estimate: 1000, reported: false } }], causalChains: [] });
  assert.equal(midnightDaily.approved_capabilities.earnings_center.items[0].result_status, "IMPACT_OBSERVED");
  assert.deepEqual(midnightDaily.approved_capabilities.earnings_center.items[0].reaction, { status: "OBSERVED", from_session: "2026-08-11", to_session: "2026-08-12", return_pct: 0.2, source: "ROBINHOOD_OFFICIAL_TRADING_MCP" });
  const oneMinute = await collectRobinhoodMarketChart(session, "SPY", "1m", observedAt);
  assert.equal(oneMinute.interval, "1m");
  assert.equal(oneMinute.status, "LIVE");
  assert.equal(oneMinute.current_price, 500);
  const fifteenMinute = await collectRobinhoodMarketChart(session, "QQQ", "15m", observedAt);
  assert.equal(fifteenMinute.interval, "15m");
  assert.equal(fifteenMinute.bars.length, 1);
  assert.equal(fifteenMinute.source, "ROBINHOOD");
  const staleAfterHours = await collectRobinhoodMarketChart(session, "SPY", "5m", "2026-08-12T22:00:00.000Z");
  assert.deepEqual([staleAfterHours.status, staleAfterHours.market_session.phase, staleAfterHours.session_bounds], ["STALE", "AFTER_HOURS", "OFFICIAL_24_5"]);
  const liveAfterHours = await collectRobinhoodMarketChart({ ...session, async call(tool, args) { return tool === "get_equity_historicals" ? response({ results: [{ symbol: args.symbols[0], bars: [{ begins_at: "2026-08-12T21:55:00.000Z", open_price: "500", high_price: "501", low_price: "499", close_price: "500.5", volume: "1000" }] }] }) : session.call(tool, args); } }, "SPY", "5m", "2026-08-12T22:00:00.000Z");
  assert.deepEqual([liveAfterHours.status, liveAfterHours.market_session.phase, liveAfterHours.bars[0].session], ["LIVE", "AFTER_HOURS", "AFTER_HOURS"]);
  const eodFallback = await collectRobinhoodMarketChart({ ...session, async call(tool, args) {
    if (tool === "get_equity_quotes") return response({ results: [{ quote: { symbol: args.symbols[0], last_trade_price: "500", venue_last_trade_time: "2026-08-14T19:55:00.000Z" } }] });
    if (tool === "get_equity_historicals") return response({ results: [{ symbol: args.symbols[0], bars: args.bounds === "24_5" ? [] : [{ begins_at: "2026-08-14T19:55:00.000Z", open_price: "499", high_price: "501", low_price: "498", close_price: "500", volume: "1000" }] }] });
    return session.call(tool, args);
  } }, "SPY", "5m", "2026-08-15T18:00:00.000Z");
  assert.deepEqual([eodFallback.status, eodFallback.data_grade, eodFallback.session_bounds], ["MARKET_CLOSED", "RECENT_OFFICIAL_EOD", "REGULAR_ONLY_EOD_FALLBACK"]);
  assert.equal(robinhoodMarketSession("2026-07-03T16:00:00.000Z").state, "CLOSED");
  assert.equal(robinhoodMarketSession("2026-11-27T17:59:00.000Z").state, "REGULAR");
  assert.equal(robinhoodMarketSession("2026-11-27T18:00:00.000Z").state, "CLOSED");
  assert.equal((await collectRobinhoodMarketChart(session, "SPY", "5m", "2026-08-12T17:20:00.000Z")).status, "STALE");
  const blockedChart = await collectRobinhoodMarketChart({ ...session, async call(tool, args) { return tool === "get_equity_historicals" ? response({ results: [{ symbol: args.symbols[0], bars: [] }] }) : session.call(tool, args); } }, "SPY", "5m", observedAt);
  assert.equal(blockedChart.status, "DATA_BLOCKED");
  assert.equal(blockedChart.bars.length, 0);
  const withoutMp = await collectRobinhoodReadonly({ ...session, async call(tool, args) {
    const result = await session.call(tool, args), values = result.structuredContent?.data?.results;
    if (tool === "get_equity_quotes" && Array.isArray(values)) result.structuredContent.data.results = values.filter((item) => item.quote?.symbol !== "MP");
    if (tool === "get_equity_historicals" && Array.isArray(values)) for (const item of values) if (item.symbol === "MP") item.bars = [];
    return result;
  } }, observedAt);
  assert.deepEqual(withoutMp.market_environment.extended_hours.coverage, { official_ohlcv: 89, local_sampled_quote: 0, recent_eod: 0, not_supported: 0, read_failed: 1 });
  assert.equal(withoutMp.market_environment.extended_hours.instruments.find((item) => item.symbol === "MP").capability, "READ_FAILED");
  assert.equal(withoutMp.market_environment.extended_hours.status, "OBSERVED");
  const persisted = JSON.stringify(projection);
  assert.doesNotMatch(persisted, /TEST-ACCOUNT-A|TEST-RHS-A|account_number/);
  assert.equal((await collectRobinhoodReadonly(session, "2026-08-12T22:00:00.000Z")).status, "MARKET_CLOSED");
  assert.equal((await collectRobinhoodReadonly(session, "2026-08-12T17:20:00.000Z")).status, "STALE");
  const missingGreeks = await collectRobinhoodReadonly({
    ...session,
    async call(tool, args) {
      const result = await session.call(tool, args);
      if (tool === "get_option_quotes") for (const item of result.structuredContent.data.results) item.quote.delta = null;
      return result;
    },
  }, observedAt);
  assert.equal(missingGreeks.status, "LIVE");
  assert.ok(missingGreeks.options.every((item) => item.status === "DATA_BLOCKED"));
  assert.equal(missingGreeks.capabilities.option_greeks, false);
  const staleOptions = await collectRobinhoodReadonly({
    ...session,
    async call(tool, args) {
      const result = await session.call(tool, args);
      if (tool === "get_option_quotes") for (const item of result.structuredContent.data.results) item.quote.updated_at = "2026-08-12T16:00:00.000Z";
      return result;
    },
  }, observedAt);
  assert.equal(staleOptions.status, "LIVE");
  assert.ok(staleOptions.options.every((item) => item.status === "STALE"));
  assert.equal((await collectRobinhoodReadonly({
    ...session,
    async call(tool, args) {
      const result = await session.call(tool, args);
      if (tool === "get_option_quotes") for (const item of result.structuredContent.data.results) item.quote.delta = null;
      return result;
    },
  }, "2026-08-12T22:00:00.000Z")).status, "MARKET_CLOSED");
  for (const tool of ROBINHOOD_READONLY_TOOLS) assert.equal(assertRobinhoodReadonlyTool(tool), tool);
  for (const tool of ["review_option_order", "place_option_order", "cancel_option_order", "exercise_option", "update_watchlist", "create_scan"]) assert.throws(() => assertRobinhoodReadonlyTool(tool), /not read-only allowlisted/);
});

test("external option quote lookup keeps the exact contract and rejects stale quotes", async () => {
  const calls = [];
  const session = { listTools: async () => ({}), call: async (tool, args) => {
    calls.push([tool, args]);
    if (tool === "get_option_instruments") return { content: [], structuredContent: { data: { instruments: [{ id: "exact-option", chain_symbol: "NVDA", expiration_date: "2026-09-04", strike_price: "215.0000", type: "put" }] } } };
    return { content: [], structuredContent: { data: { results: [{ quote: { instrument_id: "exact-option", bid_price: "3.45", ask_price: "3.55", mark_price: "3.50", implied_volatility: "0.4", delta: "-0.5", gamma: "0.02", theta: "-0.1", vega: "0.08", updated_at: "2026-08-31T15:59:59.000Z" } }] } } };
  } };
  const filter = { symbol: "NVDA", expiration: "2026-09-04", strike: 215, option_type: "put" };
  assert.equal((await collectExternalOptionQuote(session, filter, "2026-08-31T16:00:00.000Z")).contract_id, "exact-option");
  assert.deepEqual(calls.map(([tool]) => tool), ["get_option_instruments", "get_option_quotes"]);
  assert.equal(await collectExternalOptionQuote(session, filter, "2026-08-31T16:08:00.000Z"), null);
});

test("timeout and process crash are recorded and an interrupted cycle resumes", async (context) => {
  const h = await harness(context);
  const timeoutRuntime = h.runtime(successExecutor({ TS: async () => { throw new ShadowRuntimeError("TIMED_OUT", "TS exceeded 300 seconds"); } }), join(h.directory, "timeout"));
  await timeoutRuntime.runOnce("REPLAY", new Date("2026-08-12T19:00:00.000Z"));
  let state = await h.state();
  assert.equal(state.runLedger.runs.find((run) => run.run_id === "replay-shadow:20260812T190000Z" && run.agent_id === "TS").status, "TIMED_OUT");

  let crashed = false;
  const crashRoot = join(h.directory, "crash");
  const crashRuntime = h.runtime(successExecutor({ A2: async () => { crashed = true; throw new ShadowRuntimeInterrupted("simulated process termination"); } }), crashRoot);
  await assert.rejects(crashRuntime.runOnce("REPLAY", new Date("2026-08-12T19:15:00.000Z")), ShadowRuntimeInterrupted);
  assert.equal(crashed, true);
  state = await h.state();
  assert.equal(state.runLedger.runs.find((run) => run.run_id === "replay-shadow:20260812T191500Z" && run.agent_id === "A2").status, "RUNNING");

  const resumed = h.runtime(successExecutor(), crashRoot);
  assert.equal((await resumed.runOnce("REPLAY", new Date("2026-08-12T19:15:00.000Z"))).status, "COMPLETED");
  state = await h.state();
  assert.equal(state.runLedger.runs.find((run) => run.run_id === "replay-shadow:20260812T191500Z" && run.agent_id === "A2").status, "SUCCEEDED");
  assert.equal(state.runLedger.runs.find((run) => run.run_id === "replay-shadow:20260812T191500Z" && run.agent_id === "TS").status, "SUCCEEDED");
});

test("Python wrapper uses only package-local model and Python paths without installing production services", async () => {
  const invoke = await readFile(new URL("../scripts/invoke-live-shadow-step.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(invoke, /TRADIER|FINNHUB|CredentialsPath|uv run|New-ScheduledTask/);
  assert.match(invoke, /if \(\$env:CODEX_CLI_PATH -and \(Test-Path/);
  assert.match(invoke, /\.venv\\Scripts\\python\.exe/);
  assert.match(invoke, /& \$python -I -X utf8 -B/);
  assert.match(invoke, /web\\data\\model-codex-home/);
  assert.match(invoke, /TRADING_OS_V2_RUNTIME_ROOT/);
  assert.match(invoke, /--codex-cli-path \$codex/);
  assert.match(await readFile(new URL("../scripts/live-shadow-v2.py", import.meta.url), "utf8"), /os\.environ\["CODEX_CLI_PATH"\] = str\(args\.codex_cli_path\.resolve\(\)\)/);
});
