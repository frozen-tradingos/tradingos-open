import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { cleanEnvironment, offlineDoctor, pythonVenvCommand, root, safePaths } from "../tools/public-entry.mjs";
import { assertPublicAutomation, publicModelEnvironment, publicProfile } from "../web/server/public-runtime.ts";
import { withRobinhoodMcp } from "../web/server/robinhood-mcp.ts";

test("default entry has no provider calls and rejects inherited production credentials", () => {
  const env = cleanEnvironment({ CODEX_HOME: "private", OPENAI_API_KEY: "synthetic-secret", TRADING_OS_DATA_ROOT: "private", TRADING_OS_RUNTIME_ROLE: "TIER0", PATH: "synthetic-path" });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.TRADING_OS_RUNTIME_ROLE, undefined);
  assert.equal(env.TRADING_OS_PUBLIC_AUTOMATION, "0");
  assert.equal(env.CODEX_HOME, resolve(root, "web/data/model-codex-home"));
  assert.equal(env.TRADING_OS_DATA_ROOT, resolve(root, "web/data"));
  assert.equal(offlineDoctor().external_requests, 0); safePaths();
});

test("default runtime blocks broker and model before spawning anything", async () => {
  const prior = process.env.TRADING_OS_PUBLIC_AUTOMATION;
  delete process.env.TRADING_OS_PUBLIC_AUTOMATION;
  try {
    assert.throws(assertPublicAutomation, /PUBLIC_AUTOMATION_DISABLED/);
    assert.throws(() => publicModelEnvironment(resolve(root, "web")), /PUBLIC_AUTOMATION_DISABLED/);
    await assert.rejects(withRobinhoodMcp({}, () => assert.fail("must not invoke provider")), /PUBLIC_AUTOMATION_DISABLED/);
  } finally { if (prior === undefined) delete process.env.TRADING_OS_PUBLIC_AUTOMATION; else process.env.TRADING_OS_PUBLIC_AUTOMATION = prior; }
});

test("explicit model environment never inherits global auth or API keys", () => {
  const prior = process.env.TRADING_OS_PUBLIC_AUTOMATION;
  process.env.TRADING_OS_PUBLIC_AUTOMATION = "1";
  try {
    const env = publicModelEnvironment(resolve(root, "web"));
    assert.equal(env.CODEX_HOME, publicProfile(resolve(root, "web"), "model"));
    assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.CODEX_CLI_PATH, undefined);
    assert.equal(env.PATHEXT, process.env.PATHEXT, "Windows PowerShell needs native executable extensions, not file association");
    assert.equal(env.COMSPEC, process.env.COMSPEC);
    assert.notEqual(publicProfile(resolve(root, "web"), "broker"), env.CODEX_HOME);
  } finally { if (prior === undefined) delete process.env.TRADING_OS_PUBLIC_AUTOMATION; else process.env.TRADING_OS_PUBLIC_AUTOMATION = prior; }
});

test("public launch stays loopback, independent and manager-disabled", () => {
  const source = readFileSync(new URL("../web/server/local-owner-server.ts", import.meta.url), "utf8");
  assert.match(source, /const OWNER_PORT = 4160/);
  assert.match(source, /host: "127\.0\.0\.1", port: OWNER_PORT, runtimeRole: "COMBINED", codexManager: false/);
  assert.match(source, /publicAutomationEnabled\(\) && \(runtimeRole/);
  assert.match(source, /port >= 4070 && port <= 4076/);
});

test("broker rejects external profiles and unapproved tools before starting a child", async () => {
  const prior = process.env.TRADING_OS_PUBLIC_AUTOMATION;
  process.env.TRADING_OS_PUBLIC_AUTOMATION = "1";
  try {
    await assert.rejects(withRobinhoodMcp({ projectRoot: resolve(root, "web"), codexHome: resolve(root, "external-profile") }, () => assert.fail()), /External broker profiles/);
    await assert.rejects(withRobinhoodMcp({ projectRoot: resolve(root, "web"), allowlist: ["place_order"] }, () => assert.fail()), /not read-only allowlisted/);
    await assert.rejects(withRobinhoodMcp({ projectRoot: resolve(root, "web"), allowlist: ["get_unknown_data"] }, () => assert.fail()), /not read-only allowlisted/);
  } finally { if (prior === undefined) delete process.env.TRADING_OS_PUBLIC_AUTOMATION; else process.env.TRADING_OS_PUBLIC_AUTOMATION = prior; }
});

test("linked local data is refused without following it", () => {
  const work = resolve(root, "_工作文件"); mkdirSync(work, { recursive: true });
  const directory = mkdtempSync(resolve(work, "entry-link-check-"));
  const target = resolve(directory, "synthetic-target"), link = resolve(directory, "web/data");
  mkdirSync(target); mkdirSync(resolve(directory, "web"));
  try {
    symlinkSync(target, link, "junction");
    assert.throws(() => safePaths(directory), /Linked runtime directories/);
    assert.throws(() => publicProfile(resolve(directory, "web"), "model"), /PUBLIC_PROFILE_LINK_FORBIDDEN/);
  } finally { try { unlinkSync(link); } catch {} rmSync(directory, { recursive: true, force: true }); }
});

test("auth entry and all model/broker subprocesses explicitly use local file credential stores", () => {
  for (const path of ["../tools/public-entry.mjs", "../web/server/robinhood-mcp.ts", "../web/server/stock-plan-review.ts", "../web/server/codex-production-manager.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.ok(source.includes('cli_auth_credentials_store="file"'), path);
    assert.ok(source.includes('mcp_oauth_credentials_store="file"'), path);
  }
});

test("Python discovery verifies 3.13 in priority order before the no-download uv fallback", async (context) => {
  const success = (version, stream = "stdout") => ({ status: 0, stdout: "", stderr: "", [stream]: version });
  const absent = { status: null, error: new Error("synthetic missing executable") };
  const cases = [
    { replies: [success("Python 3.13.7\r\n")], command: "py.exe", prefix: ["-3.13"] },
    { replies: [absent, success("Python 3.13.2\n")], command: "python.exe", prefix: [] },
    { replies: [success("Python 3.12.10"), success("Python 3.14.0"), success("Python 3.13.1", "stderr")], command: "python3", prefix: [] },
    { replies: [{ status: 1, stdout: "Python 3.13.7" }, success("Python 3.130.0"), absent], command: "uv" },
  ];
  for (const scenario of cases) await context.test(scenario.command, (check) => {
    const calls = [];
    const mock = check.mock.method(childProcess, "spawnSync", (command, args, options) => {
      calls.push([command, args]);
      assert.equal(options.env.TRADING_OS_PUBLIC_AUTOMATION, "0");
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      return scenario.replies[calls.length - 1] ?? assert.fail("unexpected executable probe");
    });
    syncBuiltinESMExports();
    try {
      const [command, args] = pythonVenvCommand();
      assert.equal(command, scenario.command);
      assert.deepEqual(calls, [["py.exe", ["-3.13", "--version"]], ["python.exe", ["--version"]], ["python3", ["--version"]]].slice(0, scenario.replies.length));
      assert.deepEqual(args, command === "uv" ? ["venv", "--no-python-downloads", "--seed", "--python", "3.13", resolve(root, ".venv")] : [...scenario.prefix, "-m", "venv", resolve(root, ".venv")]);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  });
});
