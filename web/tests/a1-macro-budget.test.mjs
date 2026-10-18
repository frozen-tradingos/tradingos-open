import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { defaultExecutor, OpeningMarketPending } from "../server/live-shadow-runtime.ts";

const at = "2026-09-04T17:00:00.000Z", flush = () => new Promise(setImmediate);
function enableTiming(context) {
  const previous = process.env.TRADING_OS_RUNTIME_ROLE;
  process.env.TRADING_OS_RUNTIME_ROLE = "TIER0";
  context.after(() => { if (previous === undefined) delete process.env.TRADING_OS_RUNTIME_ROLE; else process.env.TRADING_OS_RUNTIME_ROLE = previous; });
}
function market(age = 0) {
  const asOf = new Date(Date.parse(at) - age * 1_000).toISOString();
  return { generated_at: at, as_of: asOf, status: "LIVE", snapshot_id: "market-before-freeze", snapshot_hash: "before-freeze", freshness_seconds: age,
    capabilities: { quotes: true, intraday_bars: true, daily_bars: true }, market_session: { state: "OPEN" },
    quotes: [{ symbol: "SPY", as_of: asOf, status: "LIVE", freshness_seconds: age }], bars: [{ symbol: "SPY", as_of: asOf, status: "LIVE", freshness_seconds: age }],
    providers: [{ source: "ROBINHOOD", status: "LIVE", as_of: asOf, freshness_seconds: age }], errors: [] };
}
function harness(context, readMarket = async () => market()) {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(at) });
  const dataRoot = mkdtempSync(fileURLToPath(new URL("./a1-macro-fixture-", import.meta.url))), calls = [];
  context.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const execute = defaultExecutor({ dataRoot, v2Root: "unused-test-v2" }, { readMarket, spawnProcess(command, args, options) {
    const child = new EventEmitter();
    child.pid = 40_000 + calls.length;
    child.stderr = new PassThrough();
    child.kill = () => { throw new Error("macro must clean the entire tree, not child.kill"); };
    calls.push({ command, args, options, child });
    return child;
  } });
  const input = { run_id: "test-slot-1", source_mode: "LIVE", RUNTIME_CONTEXT: {}, SLOT_FREEZE_DEADLINE_AT: new Date(Date.parse(at) + 90_000).toISOString() };
  const close = (call, code = 0) => { call.child.emit("exit", code); call.child.emit("close", code); };
  const succeed = (call) => {
    const responsePath = call.args[call.args.indexOf("-ResponsePath") + 1];
    mkdirSync(dirname(responsePath), { recursive: true });
    writeFileSync(responsePath, JSON.stringify({ payload: { status: "LIVE", context_hash: "new-macro", collected_at: at, as_of: at, coverage: { BLS: "LIVE" }, market_context: { status: "LIVE" } }, observedAt: at, dataCutoffAt: at, evidenceRef: "macro-test" }));
    close(call);
  };
  return { execute, input, calls, close, succeed, dataRoot };
}

test("A1 starts macro while market is pending, sharing the original observedAt and input", async (context) => {
  let releaseMarket, marketInput, marketAt;
  const h = harness(context, (observedAt, input) => { marketInput = input; marketAt = observedAt; return new Promise((resolve) => { releaseMarket = resolve; }); });
  const originalInput = JSON.stringify(h.input), result = h.execute("A1", h.input);
  await flush();
  assert.equal(h.calls.length, 1, "macro must start without waiting for market");
  const request = JSON.parse(readFileSync(h.calls[0].args[h.calls[0].args.indexOf("-RequestPath") + 1], "utf8"));
  assert.deepEqual(request.input.MARKET_SNAPSHOT, { generated_at: at });
  assert.equal(marketAt, at);
  assert.equal(marketInput, h.input);
  h.succeed(h.calls[0]); releaseMarket(market());
  assert.equal((await result).payload.official_macro.status, "LIVE");
  assert.equal(JSON.stringify(h.input), originalInput);
});

test("opening A1 retains unpublished attempts until both fresh quotes and a completed regular bar exist", async (context) => {
  let barStart = "2026-09-18T19:55:00.000Z";
  const h = harness(context, async (observedAt) => {
    const end = new Date(Date.parse(barStart) + 300_000).toISOString();
    return { ...market(), generated_at: observedAt, as_of: end,
      quotes: ["SPY", "QQQ"].map((symbol) => ({ symbol, as_of: observedAt, bid: 99, ask: 100, last: 99.5 })),
      bars: ["SPY", "QQQ"].map((symbol) => ({ symbol, as_of: end, values: [{ begins_at: barStart }] })),
      providers: [{ source: "ROBINHOOD", as_of: end }] };
  });
  h.input = { ...h.input, run_id: "live-shadow:20260921T133000Z", slot_id: "live-shadow:20260921T133000Z", RUN_REASON: "早盘固定分析", SLOT_FREEZE_DEADLINE_AT: "2026-09-21T13:40:00.000Z" };
  context.mock.timers.setTime(Date.parse("2026-09-21T13:35:05.000Z"));
  const pending = h.execute("A1", h.input), rejected = assert.rejects(pending, OpeningMarketPending);
  await flush(); h.succeed(h.calls[0]); await rejected;
  const frozenPath = join(h.dataRoot, "evidence", "live-shadow-20260921T133000Z-a1.json");
  const pendingPath = join(h.dataRoot, "evidence", "live-shadow-20260921T133000Z-a1-pending-20260921133505000.json");
  assert.equal(existsSync(frozenPath), false);
  const original = readFileSync(pendingPath, "utf8");
  assert.equal(JSON.parse(original).status, "NOT_PUBLISHED");
  barStart = "2026-09-21T13:30:00.000Z";
  context.mock.timers.setTime(Date.parse("2026-09-21T13:35:35.000Z"));
  const resumed = h.execute("A1", h.input); await flush(); h.succeed(h.calls[1]);
  const frozen = await resumed;
  assert.equal(frozen.downstreamReason, undefined);
  assert.equal(frozen.dataCutoffAt, "2026-09-21T13:35:00.000Z");
  assert.equal(frozen.observedAt, "2026-09-21T13:35:35.000Z");
  assert.equal(readFileSync(pendingPath, "utf8"), original);
  assert.equal(JSON.parse(readFileSync(frozenPath, "utf8")).observed_at, frozen.observedAt);
  assert.notEqual(h.calls[0].args[h.calls[0].args.indexOf("-ResponsePath") + 1], h.calls[1].args[h.calls[1].args.indexOf("-ResponsePath") + 1]);
});

test("healthy 19 second macro completes without timeout or fallback", async (context) => {
  const h = harness(context), result = h.execute("A1", h.input);
  await flush(); context.mock.timers.tick(19_000); await flush();
  assert.equal(h.calls.length, 1, "a normal 19 second macro must not be killed");
  h.succeed(h.calls[0]);
  const frozen = await result;
  assert.equal(frozen.payload.official_macro.status, "LIVE");
  assert.equal(frozen.payload.official_macro.collected_at, at);
  assert.equal(frozen.payload.market_sources.freshness_seconds, 19);
  assert.ok(!frozen.payload.data_gaps.includes("OFFICIAL_MACRO_DEGRADED"));
});

test("A1 timing records phase metadata without changing its input, source, or frozen payload", async (context) => {
  enableTiming(context);
  const source = market(), original = JSON.stringify(source), h = harness(context, async () => source);
  h.input.RUNTIME_CONTEXT = { private_test_marker: "DO_NOT_LOG_ACCOUNT_OR_TOOL_BODY" };
  const inputBefore = JSON.stringify(h.input), result = h.execute("A1", h.input);
  await flush(); h.succeed(h.calls[0]);
  const frozen = await result, path = join(h.dataRoot, "timing", "unidentified.jsonl");
  let raw = "";
  // The business result must not wait for diagnostic storage; inspect that storage independently.
  for (let i = 0; i < 5_000 && !raw.includes('"event":"a1_end"'); i++) {
    await flush(); if (existsSync(path)) raw = readFileSync(path, "utf8");
  }
  const events = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const phase of ["a1_begin", "macro_spawn", "macro_close", "macro_response_read_end", "a1_sources_settled", "a1_commit_deadline_check", "a1_evidence_written", "a1_end"]) {
    assert.ok(events.some((event) => event.event === phase), `missing timing phase ${phase}`);
  }
  assert.ok(events.every((event) => event.pid === process.pid && event.contract === "A1_RUNTIME_TIMING_V1" && Number.isFinite(event.monotonic_ms)));
  assert.ok(!raw.includes("DO_NOT_LOG_ACCOUNT_OR_TOOL_BODY"));
  assert.equal(frozen.payload.status, "HEALTHY");
  assert.equal(frozen.observedAt, at);
  assert.equal(JSON.stringify(source), original);
  assert.equal(JSON.stringify(h.input), inputBefore);
  assert.deepEqual(JSON.parse(readFileSync(join(h.dataRoot, "evidence", "test-slot-1-a1.json"), "utf8")), frozen.payload);
  assert.ok(!JSON.stringify(frozen.payload).includes("A1_RUNTIME_TIMING_V1"));
});

test("unavailable timing storage does not fail or delay an otherwise valid A1", async (context) => {
  enableTiming(context);
  const h = harness(context);
  writeFileSync(join(h.dataRoot, "timing"), "existing file prevents diagnostic directory creation");
  const result = await h.execute("A1", { ...h.input, SLOT_FREEZE_DEADLINE_AT: new Date(Date.parse(at) + 100).toISOString() });
  assert.equal(result.payload.status, "HEALTHY");
  assert.equal(result.observedAt, at);
  assert.equal(h.calls.length, 0);
});

test("ordinary non-Tier0 execution creates no background diagnostic files", async (context) => {
  const previous = process.env.TRADING_OS_RUNTIME_ROLE;
  process.env.TRADING_OS_RUNTIME_ROLE = "WEB";
  context.after(() => { if (previous === undefined) delete process.env.TRADING_OS_RUNTIME_ROLE; else process.env.TRADING_OS_RUNTIME_ROLE = previous; });
  const h = harness(context);
  assert.equal((await h.execute("A1", { ...h.input, SLOT_FREEZE_DEADLINE_AT: new Date(Date.parse(at) + 100).toISOString() })).payload.status, "HEALTHY");
  await flush();
  assert.equal(existsSync(join(h.dataRoot, "timing")), false);
});

test("pending macro waits 30 seconds and both tree-kill and parent close before fallback; late data cannot change frozen A1", async (context) => {
  const h = harness(context), result = h.execute("A1", h.input);
  let finished = false; result.then(() => { finished = true; });
  await flush(); context.mock.timers.tick(29_999); await flush();
  assert.equal(h.calls.length, 1); assert.equal(finished, false);
  context.mock.timers.tick(1); await flush();
  assert.equal(h.calls[1]?.command, "taskkill.exe");
  assert.deepEqual(h.calls[1].args, ["/PID", String(h.calls[0].child.pid), "/T", "/F"]);
  h.close(h.calls[1]); await flush(); assert.equal(finished, false, "taskkill success alone does not prove parent pipes closed");
  h.close(h.calls[0], 1);
  const frozen = await result;
  assert.equal(frozen.payload.status, "HEALTHY");
  assert.equal(frozen.payload.official_macro.status, "DATA_BLOCKED");
  assert.equal(frozen.downstreamReason, undefined);
  assert.ok(frozen.payload.data_gaps.includes("OFFICIAL_MACRO_DEGRADED"));
  assert.equal(frozen.payload.official_macro.collected_at, at);
  const saved = JSON.stringify(frozen), evidencePath = join(h.dataRoot, "evidence", "test-slot-1-a1.json"), evidence = readFileSync(evidencePath, "utf8");
  h.succeed(h.calls[0]); await flush();
  assert.equal(JSON.stringify(frozen), saved); assert.equal(readFileSync(evidencePath, "utf8"), evidence);
  const next = h.execute("A1", { ...h.input, run_id: "test-slot-2" }); await flush(); h.succeed(h.calls[2]);
  assert.equal((await next).payload.official_macro.context_hash, "new-macro");
});

test("macro wait consumes actual core freshness before immutable freeze", async (context) => {
  const source = market(419), original = JSON.stringify(source), h = harness(context, async () => source), result = h.execute("A1", h.input);
  await flush(); context.mock.timers.tick(2_000); h.succeed(h.calls[0]);
  const frozen = await result;
  assert.equal(frozen.payload.market_sources.status, "STALE");
  assert.equal(frozen.payload.market_sources.bars[0].freshness_seconds, 421);
  assert.equal(frozen.downstreamReason, "DATA_BLOCKED");
  assert.notEqual(frozen.payload.market_snapshot_hash, source.snapshot_hash);
  assert.equal(JSON.stringify(source), original);
});

test("macro budget respects remaining slot time and accepts parent close before taskkill close", async (context) => {
  const h = harness(context), result = h.execute("A1", { ...h.input, SLOT_FREEZE_DEADLINE_AT: new Date(Date.parse(at) + 15_000).toISOString() });
  await flush(); context.mock.timers.tick(5_000); await flush();
  assert.equal(h.calls[1]?.command, "taskkill.exe");
  h.close(h.calls[0], 1); await flush(); h.close(h.calls[1]);
  assert.equal((await result).payload.official_macro.status, "DATA_BLOCKED");
});

test("A1 skips starting optional macro when only its cleanup and commit budget remain", async (context) => {
  const h = harness(context);
  const result = await h.execute("A1", { ...h.input, SLOT_FREEZE_DEADLINE_AT: new Date(Date.parse(at) + 5_000).toISOString() });
  assert.equal(h.calls.length, 0);
  assert.equal(result.payload.status, "HEALTHY");
  assert.equal(result.payload.official_macro.status, "DATA_BLOCKED");
  assert.match(result.payload.official_macro.errors.join(";"), /OPTIONAL_BUDGET_EXHAUSTED/);
});

test("macro cleanup and immutable A1 commit fit inside the original slot deadline", async (context) => {
  const h = harness(context), result = h.execute("A1", { ...h.input, SLOT_FREEZE_DEADLINE_AT: new Date(Date.parse(at) + 20_000).toISOString() });
  const completion = result.catch((error) => error);
  try {
    await flush(); context.mock.timers.tick(10_000); await flush();
    assert.equal(h.calls[1]?.command, "taskkill.exe", "optional macro must leave its 5s cleanup grace plus 5s for A1 commit");
    context.mock.timers.tick(4_000); h.close(h.calls[0], 1); h.close(h.calls[1]);
    const frozen = await completion;
    assert.equal(frozen.payload?.status, "HEALTHY");
    assert.equal(frozen.payload.official_macro.status, "DATA_BLOCKED");
    assert.ok(Date.now() < Date.parse(at) + 20_000);
    assert.ok(existsSync(join(h.dataRoot, "evidence", "test-slot-1-a1.json")));
  } finally {
    context.mock.timers.tick(20_000); await flush();
    h.close(h.calls[0], 1); if (h.calls[1]) h.close(h.calls[1]);
    await completion;
  }
});

test("failed tree cleanup cannot freeze an apparently usable fallback", async (context) => {
  const h = harness(context), result = h.execute("A1", h.input), rejection = assert.rejects(result, (error) => error.status === "FAILED" && /PROCESS_TREE_NOT_CLOSED/.test(error.message));
  await flush(); context.mock.timers.tick(30_000); await flush();
  assert.equal(h.calls[1]?.command, "taskkill.exe");
  h.close(h.calls[1], 1); h.close(h.calls[0], 1);
  await rejection;
  assert.equal(existsSync(join(h.dataRoot, "evidence", "test-slot-1-a1.json")), false);
});

test("a natural successful close racing with taskkill not-found is not a live process-tree failure", async (context) => {
  const h = harness(context), result = h.execute("A1", h.input);
  await flush(); context.mock.timers.tick(30_000); await flush();
  h.close(h.calls[0], 0); h.close(h.calls[1], 128);
  const frozen = await result;
  assert.equal(frozen.payload.official_macro.status, "DATA_BLOCKED", "expired work stays degraded, not a renewed successful macro");
  assert.equal(frozen.payload.status, "HEALTHY");
});

for (const [exitCode, killCode] of [[0, 1], [1, 128], [null, 128], [0, null]]) test(`taskkill ${killCode} and parent ${exitCode} do not relax unproven closure`, async (context) => {
  const h = harness(context), rejection = assert.rejects(h.execute("A1", h.input), (error) => error.cause === "PROCESS_TREE_NOT_CLOSED");
  await flush(); context.mock.timers.tick(30_000); await flush();
  h.close(h.calls[0], exitCode); h.close(h.calls[1], killCode); await rejection;
  assert.equal(existsSync(join(h.dataRoot, "evidence", "test-slot-1-a1.json")), false);
});

test("macro process error degrades only that slot and next slot can succeed", async (context) => {
  const h = harness(context), first = h.execute("A1", h.input);
  await flush(); h.calls[0].child.stderr.write("official source unavailable"); h.close(h.calls[0], 78);
  assert.equal((await first).payload.official_macro.status, "DATA_BLOCKED");
  const second = h.execute("A1", { ...h.input, run_id: "test-slot-2" }); await flush(); h.succeed(h.calls[1]);
  assert.equal((await second).payload.official_macro.status, "LIVE");
});

test("unconfirmed parent close fails after cleanup grace and never freezes evidence", async (context) => {
  const h = harness(context), result = h.execute("A1", h.input), rejection = assert.rejects(result, (error) => error.status === "FAILED" && /PROCESS_TREE_NOT_CLOSED/.test(error.message));
  await flush(); context.mock.timers.tick(30_000); await flush(); h.close(h.calls[1]);
  context.mock.timers.tick(5_000); await rejection;
  assert.equal(existsSync(join(h.dataRoot, "evidence", "test-slot-1-a1.json")), false);
  h.close(h.calls[0], 1);
});

test("actual wall-clock completion beyond slot deadline remains TIMED_OUT, never a data-source failure", async (context) => {
  let releaseMarket;
  const h = harness(context, () => new Promise((resolve) => { releaseMarket = resolve; }));
  const result = h.execute("A1", { ...h.input, SLOT_FREEZE_DEADLINE_AT: new Date(Date.parse(at) + 5_000).toISOString() });
  const rejection = assert.rejects(result, (error) => error.status === "TIMED_OUT" && /A1_SLOT_FREEZE_DEADLINE_EXCEEDED/.test(error.message));
  await flush(); assert.equal(h.calls.length, 0); context.mock.timers.tick(5_001); releaseMarket(market());
  await rejection;
  assert.equal(existsSync(join(h.dataRoot, "evidence", "test-slot-1-a1.json")), false);
});

test("a failed market still waits for macro tree cleanup before returning and leaves the next slot usable", async (context) => {
  let failMarket = true;
  const h = harness(context, async () => { if (failMarket) throw new Error("core market unavailable"); return market(); });
  const result = h.execute("A1", h.input), rejection = assert.rejects(result, /core market unavailable/);
  let finished = false; rejection.then(() => { finished = true; });
  await flush(); assert.equal(finished, false); context.mock.timers.tick(30_000); await flush();
  h.close(h.calls[0], 1); h.close(h.calls[1]); await rejection;
  failMarket = false;
  const next = h.execute("A1", { ...h.input, run_id: "test-slot-2" }); await flush(); h.succeed(h.calls[2]);
  assert.equal((await next).payload.official_macro.status, "LIVE");
});

test("macro cleanup failure takes precedence over a simultaneous market rejection", async (context) => {
  const h = harness(context, async () => { throw new Error("core market unavailable"); });
  const rejection = assert.rejects(h.execute("A1", h.input), (error) => error.status === "FAILED" && error.cause === "PROCESS_TREE_NOT_CLOSED");
  await flush(); context.mock.timers.tick(30_000); await flush(); h.close(h.calls[1], 1); h.close(h.calls[0], 1);
  await rejection;
});

for (const component of ["A2", "TS"]) test(`${component} retains its original 360 second timeout`, async (context) => {
  const h = harness(context), result = h.execute(component, h.input);
  assert.equal(h.calls[0].args.includes("-MacroProcessJob"), false, "ordinary steps never change their Job membership");
  const rejection = assert.rejects(result, (error) => error.status === "TIMED_OUT");
  let killed = false;
  h.calls[0].child.kill = () => { killed = true; h.close(h.calls[0], 124); };
  context.mock.timers.tick(359_999); await flush(); assert.equal(killed, false);
  context.mock.timers.tick(1); await rejection;
  assert.equal(killed, true); assert.equal(h.calls.length, 1, "ordinary step does not invoke macro tree cleanup");
});

test("Windows taskkill really closes the isolated parent/child tree and stops later evidence writes", { skip: process.platform !== "win32" }, async (context) => {
  const dataRoot = mkdtempSync(fileURLToPath(new URL("./a1-macro-native-", import.meta.url)));
  const pidPath = join(dataRoot, "fixture-pids.json"), heartbeatPath = join(dataRoot, "fixture-heartbeat.txt");
  let parent, observedAt, result;
  context.after(async () => {
    if (parent && parent.exitCode === null) await new Promise((resolve) => spawn("taskkill.exe", ["/PID", String(parent.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).once("close", resolve));
    await result?.catch(() => {});
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const childCode = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(heartbeatPath)},'ready\\n');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeatPath)},'tick\\n'),50);`;
  const parentCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidPath + ".tmp")},JSON.stringify({parent:process.pid,child:child.pid}));fs.renameSync(${JSON.stringify(pidPath + ".tmp")},${JSON.stringify(pidPath)});setInterval(()=>{},1000);`;
  const execute = defaultExecutor({ dataRoot, v2Root: "unused-test-v2" }, {
    async readMarket(at) {
      observedAt = at;
      const source = market();
      source.generated_at = source.as_of = at;
      for (const row of [...source.quotes, ...source.bars, ...source.providers]) row.as_of = at;
      return source;
    },
    spawnProcess(command, args, options) {
      if (command === "powershell.exe") return parent = spawn(process.execPath, ["-e", parentCode], options);
      assert.equal(command, "taskkill.exe");
      assert.deepEqual(args, ["/PID", String(parent.pid), "/T", "/F"]);
      return spawn(command, args, options);
    },
  });
  const started = Date.now();
  result = execute("A1", { run_id: "native-tree-test", source_mode: "LIVE", RUNTIME_CONTEXT: {} });
  while (Date.now() - started < 10_000 && !(existsSync(pidPath) && existsSync(heartbeatPath) && readFileSync(heartbeatPath, "utf8").length > 0)) await delay(50);
  assert.ok(existsSync(pidPath) && existsSync(heartbeatPath), "fixture must publish parent/child PIDs and first heartbeat within 10 seconds");
  const pids = JSON.parse(readFileSync(pidPath, "utf8"));
  assert.equal(pids.parent, parent.pid);
  assert.ok(Number.isSafeInteger(pids.child) && pids.child > 0 && pids.child !== parent.pid);
  for (const pid of Object.values(pids)) assert.doesNotThrow(() => process.kill(pid, 0), "both isolated fixture processes must be alive before timeout");
  assert.ok(readFileSync(heartbeatPath, "utf8").length > 0, "child must be actively writing before the budget expires");
  const frozen = await result;
  assert.ok(Date.now() - started >= 30_000, "bounded wait must not become zero wait");
  assert.equal(frozen.payload.official_macro.status, "DATA_BLOCKED");
  assert.equal(frozen.payload.official_macro.collected_at, observedAt);
  assert.equal(frozen.payload.status, "HEALTHY");
  for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const stopped = readFileSync(heartbeatPath, "utf8"); await delay(250);
  assert.equal(readFileSync(heartbeatPath, "utf8"), stopped, "killed child cannot append late evidence");
  context.diagnostic(JSON.stringify({ pids, elapsed_ms: Date.now() - started, both_gone: true, evidence_writes_stopped: true }));
});

test("Windows completed synchronous tree is not falsely reported alive when the event loop handles its deadline first", { skip: process.platform !== "win32" }, async (context) => {
  const dataRoot = mkdtempSync(fileURLToPath(new URL("./a1-macro-native-race-", import.meta.url)));
  const pidPath = join(dataRoot, "fixture-pids.json"), heartbeatPath = join(dataRoot, "fixture-heartbeat.txt");
  let parent, result, killExit;
  context.after(async () => {
    if (parent && parent.exitCode === null) await new Promise((resolve) => spawn("taskkill.exe", ["/PID", String(parent.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).once("close", resolve));
    await result?.catch(() => {});
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const childCode = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(heartbeatPath)},'ready\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(heartbeatPath)},'finished\\n'),100);`;
  const execute = defaultExecutor({ dataRoot, v2Root: "unused-test-v2" }, {
    async readMarket(at) {
      const source = market(); source.generated_at = source.as_of = at;
      for (const row of [...source.quotes, ...source.bars, ...source.providers]) row.as_of = at;
      return source;
    },
    spawnProcess(command, args, options) {
      if (command !== "powershell.exe") {
        const killer = spawn(command, args, options); killer.once("close", (code) => { killExit = code; }); return killer;
      }
      const responsePath = args[args.indexOf("-ResponsePath") + 1];
      const parentCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({parent:process.pid,child:child.pid}));child.once('close',code=>{if(code!==0)process.exit(code);fs.writeFileSync(${JSON.stringify(responsePath)},JSON.stringify({payload:{status:'LIVE'},observedAt:new Date().toISOString(),dataCutoffAt:new Date().toISOString(),evidenceRef:'isolated-race'}));});`;
      mkdirSync(dirname(responsePath), { recursive: true });
      return parent = spawn(process.execPath, ["-e", parentCode], options);
    },
  });
  const started = Date.now();
  result = execute("A1", { run_id: "native-completed-race", source_mode: "LIVE", RUNTIME_CONTEXT: {}, SLOT_FREEZE_DEADLINE_AT: new Date(started + 12_000).toISOString() });
  const rejection = assert.rejects(result, (error) => error.status === "TIMED_OUT" && /A1_SLOT_FREEZE_DEADLINE_EXCEEDED/.test(error.message));
  while (!existsSync(pidPath) && Date.now() - started < 2_000) await delay(5);
  assert.ok(existsSync(pidPath));
  // Delay Node callbacks, not the isolated worker: reproduce a completed OS process whose close callback is still queued.
  await new Promise((resolve) => setImmediate(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12_500); resolve(); }));
  const pids = JSON.parse(readFileSync(pidPath, "utf8"));
  for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.match(readFileSync(heartbeatPath, "utf8"), /finished/);
  await rejection;
  assert.equal(killExit, 128, "the already completed process is not a successful taskkill target");
  assert.equal(existsSync(join(dataRoot, "evidence", "native-completed-race-a1.json")), false, "the real slot deadline must still prevent a late freeze");
  context.diagnostic(JSON.stringify({ pids, kill_exit: killExit, both_gone: true, slot_deadline_preserved: true }));
});

function nativeWrapper(context, mode, bootstrap = null, useJob = true) {
  const dataRoot = mkdtempSync(fileURLToPath(new URL("./a1-macro-native-job-", import.meta.url)));
  mkdirSync(join(dataRoot, "responses"));
  const pidPath = join(dataRoot, "fixture-pids.json"), heartbeatPath = join(dataRoot, "fixture-heartbeat.txt");
  let parent, result;
  context.after(async () => {
    const pids = existsSync(pidPath) ? Object.values(JSON.parse(readFileSync(pidPath, "utf8"))) : [];
    for (const pid of [...pids, parent?.pid].filter(Number.isSafeInteger)) {
      try { process.kill(pid, 0); } catch { continue; }
      await new Promise((resolve) => spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).once("close", resolve));
    }
    await result?.catch(() => {});
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const fixturePath = join(dataRoot, "fixture.cjs");
  const childCode = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(heartbeatPath)},'ready\\n');${mode === "normal" ? "setTimeout(()=>{},100)" : `setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeatPath)},'tick\\n'),50)`};`;
  writeFileSync(fixturePath, `const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({worker:process.pid,child:child.pid}));const response=process.argv[process.argv.indexOf('--response')+1];const complete=()=>fs.writeFileSync(response,JSON.stringify({payload:{status:'LIVE',context_hash:'native-job',coverage:{BLS:'LIVE'},market_context:{status:'LIVE'}},observedAt:new Date().toISOString(),dataCutoffAt:new Date().toISOString(),evidenceRef:'isolated-job'}));${mode === "normal" ? "child.once('close',complete);" : mode === "hang" ? "setInterval(()=>{},1000);" : "const ready=setInterval(()=>{if(fs.existsSync(" + JSON.stringify(heartbeatPath) + ")){clearInterval(ready);complete();child.unref();}},5);"}`);
  // Keep the real Job/setup/error handling unchanged; replace only its provider worker with an explicit synthetic process.
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const wrapperSource = readFileSync(fileURLToPath(new URL("../scripts/invoke-live-shadow-step.ps1", import.meta.url)), "utf8");
  const setupLine = /^ {2}\$packageRoot = .+$/m, workerLine = /^ {2}& \$python .+--codex-cli-path \$codex\r?$/m;
  assert.ok(setupLine.test(wrapperSource) && workerLine.test(wrapperSource), "The explicit test seam must match exactly the installed wrapper");
  const testWrapper = wrapperSource.replace(setupLine, `  $packageRoot = ${quote(packageRoot)}`).replace(workerLine, `  & ${quote(process.execPath)} ${quote(fixturePath)} --response $ResponsePath`);
  const jobEnd = wrapperSource.indexOf("  $packageRoot =");
  assert.ok(jobEnd > 0);
  assert.equal(testWrapper.slice(0, jobEnd), wrapperSource.slice(0, jobEnd), "The actual Windows Job block must be byte-identical");
  const wrapperPath = join(dataRoot, "actual-wrapper-synthetic-worker.ps1");
  writeFileSync(wrapperPath, "\ufeff" + testWrapper);
  const environment = { ...process.env, CODEX_CLI_PATH: process.execPath };
  const execute = defaultExecutor({ dataRoot, v2Root: join(packageRoot, "v2-reference") }, {
    async readMarket(at) { const source=market();source.generated_at=source.as_of=at;for(const row of [...source.quotes,...source.bars,...source.providers])row.as_of=at;return source; },
    spawnProcess(command, args, options) {
      if (command !== "powershell.exe") return spawn(command, args, options);
      assert.ok(args.includes("-MacroProcessJob"), "only the actual guarded macro wrapper is tested");
      args = [...args];
      args[args.indexOf("-File") + 1] = wrapperPath;
      if (!useJob) args = args.filter((arg) => arg !== "-MacroProcessJob");
      if (bootstrap) {
        const invoke = `& ${args.slice(args.indexOf("-File") + 1).map((value) => value.startsWith("-") ? value : quote(value)).join(" ")}`;
        const bootstrapPath = join(dataRoot, "bootstrap.ps1");
        writeFileSync(bootstrapPath, `\ufeff${bootstrap}\n${invoke}\nexit $LASTEXITCODE\n`);
        args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bootstrapPath];
      }
      return parent = spawn(command, args, { ...options, env: environment });
    },
  });
  return { dataRoot, pidPath, heartbeatPath, run(input = {}) { return result = execute("A1", { run_id: "native-job-test", source_mode: "LIVE", RUNTIME_CONTEXT: {}, ...input }); }, parent: () => parent };
}

test("Windows uncontained-wrapper counterexample has parent zero and taskkill 128 while detached child still writes", { skip: process.platform !== "win32" }, async (context) => {
  const h = nativeWrapper(context, "detached", null, false);
  assert.equal((await h.run()).payload.official_macro.status, "LIVE");
  const pids = JSON.parse(readFileSync(h.pidPath, "utf8"));
  assert.equal(h.parent().exitCode, 0);
  assert.throws(() => process.kill(h.parent().pid, 0), { code: "ESRCH" });
  const killExit = await new Promise((resolve) => spawn("taskkill.exe", ["/PID", String(h.parent().pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).once("close", resolve));
  assert.equal(killExit, 128);
  assert.doesNotThrow(() => process.kill(pids.child, 0));
  const before = readFileSync(h.heartbeatPath, "utf8"); await delay(150);
  assert.ok(readFileSync(h.heartbeatPath, "utf8").length > before.length);
  context.diagnostic(JSON.stringify({ counterexample_without_job: true, pids, parent_exit: 0, kill_exit: killExit, child_alive_and_writing: true, fixture_cleanup_pending: true }));
});

for (const mode of ["normal", "detached"]) test(`Windows actual macro wrapper ${mode} closes all descendants, including detached ignored pipes`, { skip: process.platform !== "win32" }, async (context) => {
  const h = nativeWrapper(context, mode), frozen = await h.run();
  assert.equal(frozen.payload.official_macro.status, "LIVE", frozen.payload.official_macro.errors?.join(";"));
  assert.equal(h.parent().exitCode, 0);
  const pids = JSON.parse(readFileSync(h.pidPath, "utf8"));
  for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const stopped = readFileSync(h.heartbeatPath, "utf8"); await delay(200);
  assert.equal(readFileSync(h.heartbeatPath, "utf8"), stopped);
  context.diagnostic(JSON.stringify({ mode, pids, wrapper_exit: 0, descendants_gone: true, later_writes_stopped: true }));
});

test("Windows actual macro wrapper timeout closes descendants before the original A1 deadline", { skip: process.platform !== "win32" }, async (context) => {
  const h = nativeWrapper(context, "hang");
  const started = Date.now();
  const result = await h.run({ SLOT_FREEZE_DEADLINE_AT: new Date(started + 20_000).toISOString() });
  assert.equal(result.payload.status, "HEALTHY");
  assert.equal(result.payload.official_macro.status, "DATA_BLOCKED");
  assert.ok(Date.now() < started + 20_000, "cleanup and immutable commit must finish inside the unchanged slot deadline");
  const pids = JSON.parse(readFileSync(h.pidPath, "utf8"));
  for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(existsSync(join(h.dataRoot, "evidence", "native-job-test-a1.json")), true);
  context.diagnostic(JSON.stringify({ pids, descendants_gone: true, elapsed_ms: Date.now() - started, deadline_preserved: true }));
});

test("Windows unavailable macro Job fails closed before starting the synthetic worker", { skip: process.platform !== "win32" }, async (context) => {
  const h = nativeWrapper(context, "normal", "function Add-Type { throw 'isolated Job initialization failure' }");
  await assert.rejects(h.run(), (error) => error.status === "FAILED" && error.cause === "PROCESS_TREE_NOT_CLOSED" && /PROCESS_JOB_UNAVAILABLE/.test(error.message));
  assert.equal(existsSync(h.pidPath), false);
  assert.equal(existsSync(join(h.dataRoot, "evidence", "native-job-test-a1.json")), false);
  context.diagnostic(JSON.stringify({ wrapper_exit: h.parent().exitCode, worker_started: false, fail_closed: true }));
});

test("Windows actual wrapper safely nests inside an existing Job", { skip: process.platform !== "win32" }, async (context) => {
  const bootstrap = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class IsolatedOuterJob {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref uint flags, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  public static void Enable() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null); uint flags = 1;
    if (job == IntPtr.Zero || !SetInformationJobObject(job, 4, ref flags, 4) || !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
[IsolatedOuterJob]::Enable()
Write-Output 'ISOLATED_OUTER_JOB_READY'`;
  const h = nativeWrapper(context, "normal", bootstrap);
  const frozen = await h.run();
  assert.equal(frozen.payload.official_macro.status, "LIVE");
  const pids = JSON.parse(readFileSync(h.pidPath, "utf8"));
  for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  context.diagnostic(JSON.stringify({ existing_job: true, wrapper_exit: h.parent().exitCode, pids, descendants_gone: true }));
});

test("Windows rejected Job assignment is fail-closed rather than silently running without containment", { skip: process.platform !== "win32" }, async (context) => {
  // Inject the Win32 failure a restrictive host or unsupported nested Job can return; never alter the real host's Job.
  const bootstrap = `Add-Type 'public static class MacroProcessJob { public static void Enable() { throw new System.ComponentModel.Win32Exception(5); } }'
function Add-Type { }`;
  const h = nativeWrapper(context, "normal", bootstrap);
  await assert.rejects(h.run(), (error) => error.status === "FAILED" && error.cause === "PROCESS_TREE_NOT_CLOSED" && /PROCESS_JOB_UNAVAILABLE/.test(error.message));
  assert.equal(h.parent().exitCode, 79);
  assert.equal(existsSync(h.pidPath), false);
  assert.equal(existsSync(join(h.dataRoot, "evidence", "native-job-test-a1.json")), false);
  context.diagnostic(JSON.stringify({ assignment_denied_fault_injection: true, wrapper_exit: 79, worker_started: false, fail_closed: true }));
});
