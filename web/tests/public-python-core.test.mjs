import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("the real bundled A2, TS contracts, risk and settlement pass offline with no skipped tests", (context) => {
  const root = resolve(import.meta.dirname, "../..");
  const temporary = resolve(root, "_工作文件/python-tests");
  mkdirSync(temporary, { recursive: true });
  const modules = [
    "tests.common.test_public_package", "tests.common.test_config_and_packet", "tests.common.test_agent_input_freshness",
    "tests.a2.test_analysis", "tests.a2.test_pattern_tracker", "tests.a2.test_trend_pullback", "tests.a2.test_macro_results",
    "tests.a2.test_half_hour_forecast", "tests.a2.test_half_hour_validation", "tests.agent_runtime.test_ts_output_v2", "tests.agent_runtime.test_contract_versions",
    "tests.risk.test_rules", "tests.ts.test_calibration", "tests.ts.test_instructions", "tests.ts.test_provenance",
    "tests.ts.test_public", "tests.ts.test_settlement",
  ];
  const program = `import sys,tempfile,unittest,socket,subprocess,urllib.request
from unittest.mock import patch
sys.path.insert(0,${JSON.stringify(resolve(root, "v2-reference"))})
tempfile.tempdir=${JSON.stringify(temporary)}
suite=unittest.defaultTestLoader.loadTestsFromNames(${JSON.stringify(modules)})
with patch.object(socket.socket,'connect',side_effect=AssertionError('Network is forbidden in offline tests')),patch.object(urllib.request,'urlopen',side_effect=AssertionError('Provider calls are forbidden')),patch.object(subprocess,'Popen',side_effect=AssertionError('Model calls are forbidden')):
 result=unittest.TextTestRunner(verbosity=1).run(suite)
assert result.testsRun>=200, result.testsRun
assert not result.skipped, result.skipped
assert result.wasSuccessful()
print('OFFLINE_REAL_CORE_OK tests='+str(result.testsRun))`;
  const python = resolve(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const result = spawnSync(python, ["-I", "-X", "utf8", "-B", "-c", program], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 90_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /OFFLINE_REAL_CORE_OK tests=\d+/);
  context.diagnostic(result.stdout.trim());
});

test("the bundled TS prompt binds genuine synthetic prior slots and event risk without Git or model calls", () => {
  const root = resolve(import.meta.dirname, "../..");
  const script = resolve(root, "web/tests/legacy-prior-context.test.py");
  const program = `import runpy,socket,subprocess,urllib.request
from unittest.mock import patch
with patch.object(socket.socket,'connect',side_effect=AssertionError('Network is forbidden')),patch.object(urllib.request,'urlopen',side_effect=AssertionError('Provider calls are forbidden')),patch.object(subprocess,'Popen',side_effect=AssertionError('Real model calls are forbidden')):
 runpy.run_path(${JSON.stringify(script)},run_name='__main__')`;
  const python = resolve(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const result = spawnSync(python, ["-I", "-X", "utf8", "-B", "-c", program], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /actual TS prompt.*zero model calls/);
});
