import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import { resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { collectRobinhoodReadonly, robinhoodResponseBody, withRobinhoodMcp } from "../server/robinhood-mcp.ts";

const secret = "NEVER_PERSIST_ACCOUNT_OR_BEARER_VALUE";
function fakeTransport(context, mode = "ok") {
  const children = [];
  const priorAutomation = process.env.TRADING_OS_PUBLIC_AUTOMATION;
  process.env.TRADING_OS_PUBLIC_AUTOMATION = "1";
  // The transport is fake on every host; CI must not need a Windows CLI package.
  const readdir = fs.readdirSync;
  context.mock.method(fs, "readdirSync", (path, options) => path === resolve("node_modules", ".pnpm")
    ? [{ name: "@openai+codex@fixture-win32-x64", isDirectory: () => true }]
    : readdir(path, options));
  context.mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter();
    child.pid = 4321; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killCount = 0;
    child.kill = () => { child.killCount += 1; child.stdout.end(); child.stderr.end(); return true; };
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const request = JSON.parse(String(chunk));
      if (request.id) queueMicrotask(() => {
        if (request.method === "mcpServer/tool/call" && mode === "timeout") return;
        if (request.method === "mcpServer/tool/call" && mode === "exit") { child.emit("exit", 1); return; }
        const body = request.method === "thread/start" ? { thread: { id: secret } } : request.method === "mcpServer/tool/call" ? { content: [{ type: "text", text: JSON.stringify({ marker: secret }) }], ...(mode === "provider_error" ? { isError: true } : {}) } : {};
        const response = request.method === "mcpServer/tool/call" && mode === "error" ? { id: request.id, error: { message: "EXPECTED_RPC_ERROR" } } : { id: request.id, result: body };
        child.stdout.write(`${JSON.stringify(response)}\n`);
      });
      done();
    } });
    children.push(child); return child;
  });
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll(); syncBuiltinESMExports();
    if (priorAutomation === undefined) delete process.env.TRADING_OS_PUBLIC_AUTOMATION;
    else process.env.TRADING_OS_PUBLIC_AUTOMATION = priorAutomation;
  });
  return children;
}

test("MCP timing includes spawn, initialization, request identity and body parsing without private values", async (context) => {
  const children = fakeTransport(context), events = [];
  const result = await withRobinhoodMcp({ timeoutMs: 50, onTiming: (event) => events.push(event) }, async (session) => robinhoodResponseBody(await session.call("get_equity_quotes", { account: secret })));
  assert.equal(result.marker, secret); assert.equal(children[0].killCount, 1);
  assert.ok(events.some((event) => event.event === "spawn" && event.spawn_pid === 4321));
  for (const method of ["initialize", "thread/start", "mcpServer/tool/call"]) {
    const begin = events.find((event) => event.event === "rpc_begin" && event.method === method), end = events.find((event) => event.event === "rpc_end" && event.request_id === begin?.request_id);
    assert.ok(begin && end, method); assert.equal(end.outcome, "SUCCESS"); assert.ok(end.duration_ms >= 0);
  }
  const end = events.find((event) => event.event === "rpc_end" && event.tool === "get_equity_quotes");
  assert.ok(end.text_code_units > 0);
  assert.ok(events.some((event) => event.event === "rpc_line_parse_end" && event.request_id === end.request_id));
  assert.ok(!JSON.stringify(events).includes(secret));
});

for (const mode of ["error", "provider_error", "timeout", "exit"]) test(`MCP timing hook failure cannot change ${mode} rejection or cleanup`, async (context) => {
  const children = fakeTransport(context, mode), events = [];
  const expected = mode === "error" ? /EXPECTED_RPC_ERROR/ : mode === "provider_error" ? /returned an error/ : mode === "timeout" ? /timed out/ : /exited 1/;
  for (const onTiming of [undefined, (event) => events.push(event), () => { throw new Error(secret); }]) {
    await assert.rejects(withRobinhoodMcp({ timeoutMs: 10, onTiming }, (session) => session.call("get_equity_quotes", {})), expected);
    assert.equal(children.at(-1).killCount, 1);
  }
  assert.equal(events.find((event) => event.event === "rpc_end" && event.tool === "get_equity_quotes").outcome, { error: "REMOTE_ERROR", provider_error: "PROVIDER_ERROR", timeout: "TIMEOUT", exit: "PROCESS_EXIT" }[mode]);
  assert.ok(!JSON.stringify(events).includes(secret));
});

test("collector timing cannot change output, hash, freshness or budget and records nominal versus actual expiry", async (context) => {
  const observedAt = "2026-09-08T19:00:00.000Z";
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(observedAt) });
  const response = { content: [], structuredContent: { data: { results: [], accounts: [], chains: [] } } }, session = { async call() { return response; } };
  const deadline = new Date(Date.parse(observedAt) + 90_000).toISOString(), events = [];
  const base = await collectRobinhoodReadonly(session, observedAt, undefined, undefined, deadline);
  for (const onTiming of [(event) => events.push(event), () => { throw new Error(secret); }]) {
    assert.deepEqual(await collectRobinhoodReadonly(session, observedAt, undefined, undefined, deadline, onTiming), base);
  }
  for (const event of ["core_begin", "core_end", "core_parse_begin", "core_parse_end", "enhancement_budget_begin", "enhancement_budget_completed", "snapshot_hash_begin", "snapshot_hash_end", "freshness_begin", "freshness_end"]) assert.ok(events.some((item) => item.event === event), event);
  const budget = events.find((event) => event.event === "enhancement_budget_begin");
  assert.equal(budget.budget_ms, 60_000); assert.equal(budget.deadline_at, "2026-09-08T19:01:00.000Z");
  const stalledEvents = [];
  const stalled = collectRobinhoodReadonly({ async call(tool, args) {
    if (tool.startsWith("get_equity_") && args.symbols.join(",") === "SPY,QQQ") return response;
    return new Promise(() => {});
  } }, observedAt, undefined, undefined, deadline, (event) => stalledEvents.push(event));
  await new Promise(setImmediate); context.mock.timers.tick(60_100); await stalled;
  const expired = stalledEvents.find((event) => event.event === "enhancement_budget_actual_expired");
  assert.ok(expired); assert.equal(expired.deadline_at, "2026-09-08T19:01:00.000Z");
  assert.equal(expired.at, "2026-09-08T19:01:00.100Z", "actual delayed callback time must not be replaced with its nominal deadline");
  assert.ok(!JSON.stringify(stalledEvents).includes(secret));
});
