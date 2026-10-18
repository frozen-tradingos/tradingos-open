import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { createTimelineScheduler } from "../server/timeline-scheduler.ts";
import { assessPositionRisks } from "../server/position-copilot.ts";

const at = new Date("2026-09-04T16:29:01Z");
const source = { source: "ROBINHOOD", status: "LIVE", configured: true, authorization: "VALID", last_success_at: at.toISOString(), as_of: at.toISOString(), freshness_seconds: 0, error: null, checked_at: at.toISOString(), capabilities: { quotes: true } };
async function database(context) {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-real-risk-"));
  const store = openSnapshotDatabase(join(directory, "state.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  store.recordDataSourceStatus(source);
  return store;
}
const risk = () => assessPositionRisks({ source: "ROBINHOOD", status: "LIVE", as_of: at.toISOString(), freshness_seconds: 0, account_count: 1, positions: [], orders: null, portfolio_value: null, option_value: null, realized_pnl: null }, null, at.toISOString());

test("latest LIVE plan lookup excludes a newer replay instead of substituting its thresholds", async (context) => {
  const store = await database(context), db = new DatabaseSync(store.file);
  for (const [mode, time] of [["LIVE", "2026-09-04T16:00:00Z"], ["REPLAY", "2026-09-04T16:01:00Z"]]) {
    const payload = JSON.stringify({ source_mode: mode });
    db.prepare("INSERT INTO output_records (record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,?,?,?,?,?,?,?)").run(`${mode}:A2`, "A2_SHADOW_RESULT", "SHADOW", time, time, payload, JSON.stringify({ record_id: `${mode}:A2`, payload: JSON.parse(payload) }), "a".repeat(64));
  }
  db.close();
  assert.equal(JSON.parse(store.getLatestOutputRaw("A2_SHADOW_RESULT")).payload.source_mode, "REPLAY");
  assert.equal(JSON.parse(store.getLatestOutputRaw("A2_SHADOW_RESULT", "LIVE")).payload.source_mode, "LIVE");
});

test("minute success requires a real risk executor, not healthy quote connectivity", async (context) => {
  const store = await database(context);
  await createTimelineScheduler({ store, runtimeStartedAt: at, runShadow: async () => ({ status: "COMPLETED" }) }).runOnce(at);
  const checkpoint = store.getActive().outputs.SCHEDULE_CHECKPOINT.find((row) => row.kind === "POSITION_MONITOR");
  assert.equal(checkpoint.status, "FAILED");
  assert.match(checkpoint.reason, /检查器未接入/);
});

test("real risk checks persist once, reload independently and never enter forecasting inventory", async (context) => {
  const store = await database(context);
  let calls = 0;
  const options = { store, runtimeStartedAt: at, runShadow: async () => ({ status: "COMPLETED" }), monitorPositions: async () => { calls++; return risk(); } };
  await createTimelineScheduler(options).runOnce(at);
  await createTimelineScheduler(options).runOnce(at);
  assert.equal(calls, 1);
  const checkpoint = JSON.parse(store.getLatestOutputRaw("SCHEDULE_CHECKPOINT")).payload;
  assert.equal(checkpoint.position_check.checks_completed, true);
  assert.equal(checkpoint.position_check.automated_execution, false);
  assert.match(checkpoint.reason, /未发送手机通知/);
  assert.equal(store.getActive().outputs.TS_SHADOW_OUTPUT.length, 0);
  assert.equal(store.getActive().outputs.POSITION_COPILOT_STATE.length, 0);
  const changed = { ...checkpoint, position_check: { ...checkpoint.position_check, checks_completed: false } };
  assert.throws(() => store.importOutputRaw(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "invalid:risk:record", output_type: "SCHEDULE_CHECKPOINT", channel: "SYSTEM", observed_at: checkpoint.completed_at, payload: changed })), /未执行持仓检查不得成功/);
});

test("a slow positions read cannot block the next Tier 0 ownership callback", async (context) => {
  const store = await database(context);
  let release, checks = 0, cores = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createTimelineScheduler({ store, runtimeStartedAt: at, runShadow: async () => ({ status: "COMPLETED" }), runTsCore: async () => { cores++; return { status: "COMPLETED" }; }, monitorPositions: async () => { checks++; await gate; return risk(); } });
  await scheduler.runOnce(at, true);
  await scheduler.runOnce(new Date("2026-09-04T16:30:01Z"), true);
  assert.equal(cores, 1);
  assert.equal(checks, 1);
  release();
  await scheduler.stop();
  assert.equal(store.getActive().outputs.SCHEDULE_CHECKPOINT.filter((row) => row.kind === "POSITION_MONITOR").length, 1);
});
