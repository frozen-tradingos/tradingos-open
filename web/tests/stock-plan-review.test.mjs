import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalJson } from "../server/robinhood-mcp.ts";
import { createStockReviewInvoker, reviewStockPlan, stockReviewThreadId } from "../server/stock-plan-review.ts";
import { stockPlanEvidenceGaps } from "../app/stock-manual-plan.ts";

const hash = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const observed = "2026-09-09T16:00:00.000Z";
test("disabled-host startup diagnostic is not tool use; unexpected errors and tools still reject", () => {
  const diagnostic = { type: "item.completed", item: { type: "error", message: "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`." } };
  const events = [{ type: "thread.started", thread_id: "isolated-thread" }, diagnostic, { type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text: "{}" } }, { type: "turn.completed" }];
  const encode = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");
  assert.equal(stockReviewThreadId(encode(events)), "isolated-thread");
  for (const item of [{ type: "error", message: "different error" }, { type: "command_execution" }, { type: "mcp_tool_call" }]) {
    const changed = structuredClone(events); changed[1].item = item;
    assert.throws(() => stockReviewThreadId(encode(changed)), /UNEXPECTED_TOOL_USE/);
  }
  assert.throws(() => stockReviewThreadId(encode([...events.slice(0, 3), diagnostic, ...events.slice(3)])), /UNEXPECTED_TOOL_USE/);
  assert.throws(() => stockReviewThreadId(encode(events.slice(0, -1))), /EVIDENCE_INCOMPLETE/);
});
function evidence() {
  const value = {
    contract_version: "stock-plan-v1", run_id: "live-shadow:20260909T160000Z", slot_id: "live-shadow:20260909T160000Z", source_mode: "LIVE", mode: "SHADOW", automated_execution: false,
    observed_at: observed, received_at: observed, source_snapshot_id: "source-test", source_snapshot_hash: "a".repeat(64), symbol: "TSLA", instrument_type: "EQUITY", direction: "BULLISH",
    quote: { source: "ROBINHOOD", symbol: "TSLA", status: "LIVE", last: 350, bid: 349.99, ask: 350.01, as_of: observed },
    bars: { source: "ROBINHOOD", symbol: "TSLA", interval: "5min", as_of: observed, values: [] }, pattern: null, contracts: [],
    account: { source: "ROBINHOOD", status: "LIVE", as_of: observed, freshness_seconds: 0, account_count: 1, positions: [], orders: null, portfolio_value: 10000, option_value: 0, realized_pnl: 0 },
    news: { checked_at: observed, status: "LIVE", items: [] }, global_risk: { checked_at: observed, critical_blockers: [], new_entry_blockers: [] }, data_gaps: [],
  };
  return { ...value, evidence_id: hash(value) };
}
function decision(role, evidenceId, changes = {}) {
  return { contract_version: "stock-plan-v1", role, evidence_id: evidenceId, action: "MANUAL_BUY", symbol: "TSLA", contract_id: "tsla-350-call", option_type: "call", expiration: "2026-09-11", strike: 350, quantity: 1, max_entry_debit: 200, stop_loss_pct: -30, take_profit_pct: 30, score: 9, entry_conditions: ["突破后下一根完成线守住"], invalidation: ["失守突破点"], target_price: 355, reasons: ["隔离测试审阅输出，不是生产批准"], ...changes };
}
async function setup(t) {
  const workRoot = resolve("../_工作文件/test-stock-review");
  await mkdir(workRoot, { recursive: true });
  const dataRoot = await mkdtemp(join(workRoot, "synthetic-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  return { projectRoot: resolve("."), dataRoot, evidence: evidence(), now: () => new Date(observed) };
}
const execution = (input, output, changes = {}) => ({ output, threadId: `test-thread-${input.role}`, stdout: "", stderr: "", processTreeClosed: true, ...changes });

function planningEvidence() {
  const value = evidence();
  delete value.evidence_id;
  value.contract_version = "stock-plan-v2";
  value.planning_context = { observed_at: observed, entry_trigger: 351, invalidation_price: 345, target_price: 360, why_watch: ["合成多周期背景，尚待突破"],
    timeframes: Object.fromEntries([["daily", "1d"], ["four_hour", "4h"], ["one_hour", "1h"], ["thirty_minute", "30m"]].map(([name, timeframe]) => [name, { timeframe, available: true, pattern: "higher_high_higher_low", state: "breakout_watch", direction: "BULLISH", confidence: 0.8, support: 345, resistance: 351, volume_context: "正常", data_cutoff: observed, limitation: null }])) };
  value.setup_gaps = ["尚未形成完整开仓盘型"];
  value.contracts = [{ contract_id: "tsla-350-call", option_type: "call", expiration: "2026-10-16", strike: 350, bid: 1.95, ask: 2, mark: 1.975, volume: 100, open_interest: 200, iv: 0.3, delta: 0.5, gamma: 0.03, theta: -0.05, vega: 0.04, as_of: observed, history_bars: 0, history_as_of: null,
    instrument: { chain_id: "tsla-chain", chain_symbol: "TSLA", expiration_date: "2026-10-16", strike_price: 350, type: "call", state: "active", tradability: "tradable", trade_value_multiplier: 100 } }];
  return { ...value, evidence_id: hash(value) };
}
function conditionalDecision(role, evidenceId, changes = {}) {
  return decision(role, evidenceId, { contract_version: "stock-plan-v2", action: "CONDITIONAL_PLAN", expiration: "2026-10-16", entry_trigger_price: 351, invalidation_price: 345, target_price: 360, holding_period: "条件失效或触及原止盈止损时复查，不承诺持有到期", contract_selection_reason: "仅选择证据中这份真实合约，报价符合预算且保留等待条件的时间", ...changes });
}

test("v2 conditional plans receive independent D and A3 review with exact frozen levels and a separate schema", async (t) => {
  const options = await setup(t), ev = planningEvidence(), calls = [];
  const result = await reviewStockPlan({ ...options, evidence: ev, invoke: async (input) => {
    calls.push(input);
    assert.equal(input.schemaPath, resolve("contracts/v2/stock-plan-decision.schema.json"));
    assert.match(input.prompt, /CONDITIONAL_PLAN/); assert.match(input.prompt, /ENTRY_GAPS/);
    assert.match(input.prompt, /unverified news/i); assert.ok(input.prompt.includes(canonicalJson(ev)));
    assert.doesNotMatch(input.prompt, /DTE 0–15/);
    return execution(input, conditionalDecision(input.role, ev.evidence_id));
  } });
  assert.equal(result.status, "REVIEWED"); assert.deepEqual(calls.map((row) => row.role), ["D", "A3"]);
  assert.notEqual(result.d.invocation_id, result.a3.invocation_id);
  assert.equal(result.d.action, "CONDITIONAL_PLAN"); assert.equal(result.a3.action, "CONDITIONAL_PLAN");
  assert.equal(result.a3.entry_trigger_price, ev.planning_context.entry_trigger);
  assert.deepEqual(JSON.parse(await readFile(join(result.archive_ref, "evidence.json"), "utf8")), ev);
  const schema = JSON.parse(await readFile(calls[0].schemaPath, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.action.enum, ["CONDITIONAL_PLAN", "MANUAL_BUY", "NO_TRADE"]);
  for (const key of ["entry_trigger_price", "invalidation_price", "holding_period", "contract_selection_reason"]) assert.ok(schema.required.includes(key));
});

test("review prompts select the explicit early multi-timeframe rule and preserve the unmarked 18-bar rule", async (t) => {
  for (const early of [true, false]) await t.test(early ? "explicit early rule" : "unmarked legacy rule", async (st) => {
    const options = await setup(st), ev = planningEvidence(), calls = [];
    if (early) ev.entry_rule = "MULTI_TIMEFRAME_BREAK_HOLD_V1";
    const payload = { ...ev }; delete payload.evidence_id; ev.evidence_id = hash(payload);
    const result = await reviewStockPlan({ ...options, evidence: ev, invoke: async (input) => {
      calls.push(input.role);
      assert.equal(input.timeoutMs, 45_000);
      assert.match(input.prompt, early ? /at least 5 completed 5m bars/ : /at least 18 completed 5m bars/);
      assert.doesNotMatch(input.prompt, early ? /at least 18 completed 5m bars/ : /at least 5 completed 5m bars/);
      if (early) {
        assert.match(input.prompt, /all four completed.*same direction/);
        assert.match(input.prompt, /four-hour.*before.*breakout bar/);
        assert.match(input.prompt, /last three.*fixed.*break.*hold/);
      }
      assert.match(input.prompt, /UNKNOWN.*WIDE_CHOP.*block/);
      return execution(input, conditionalDecision(input.role, ev.evidence_id));
    } });
    assert.equal(result.status, "REVIEWED", result.reason);
    assert.deepEqual(calls, ["D", "A3"]);
    assert.notEqual(result.d.invocation_id, result.a3.invocation_id);
  });
});

test("v2 reviewers cannot invent prices, switch action/contract, bypass entry gaps or manufacture a second review", async (t) => {
  for (const fault of ["trigger", "invalidation", "target", "action", "contract", "version", "manual-before-trigger", "missing-context", "missing-field", "second-timeout", "second-refusal", "first-refusal"]) await t.test(fault, async (st) => {
    const options = await setup(st), ev = planningEvidence(); let calls = 0;
    if (fault === "missing-context") { ev.planning_context = null; const payload = { ...ev }; delete payload.evidence_id; ev.evidence_id = hash(payload); }
    const result = await reviewStockPlan({ ...options, evidence: ev, invoke: async (input) => {
      calls++;
      if (fault === "second-timeout" && input.role === "A3") throw Error("STOCK_REVIEW_TIMED_OUT");
      const out = conditionalDecision(input.role, ev.evidence_id);
      if (fault === "trigger") out.entry_trigger_price++;
      if (fault === "invalidation") out.invalidation_price--;
      if (fault === "target") out.target_price++;
      if (fault === "action" && input.role === "A3" || fault === "manual-before-trigger") out.action = "MANUAL_BUY";
      if (fault === "contract" && input.role === "A3") out.contract_id = "not-the-d-contract";
      if (fault === "version") out.contract_version = "stock-plan-v1";
      if (fault === "missing-field") delete out.holding_period;
      if (fault === "first-refusal" || fault === "second-refusal" && input.role === "A3") out.action = "NO_TRADE";
      return execution(input, out);
    } });
    assert.equal(result.status, "NO_TRADE");
    if (fault === "first-refusal") { assert.equal(calls, 1); assert.equal(result.a3, null); }
    if (fault === "second-timeout") { assert.equal(calls, 2); assert.equal(result.a3, null); }
  });
});

test("v2 permits a genuinely confirmed manual plan and a bearish conditional plan without assuming a holding horizon", async (t) => {
  for (const side of ["confirmed-call", "conditional-put"]) await t.test(side, async (st) => {
    const options = await setup(st), value = planningEvidence(); delete value.evidence_id;
    const at = "2026-09-09T16:00:35.000Z";
    value.received_at = at;
    if (side === "confirmed-call") {
      value.setup_gaps = [];
      const start = Date.parse("2026-09-09T14:00:00Z");
      value.bars.values = Array.from({ length: 24 }, (_, index) => {
        const base = 344 + Math.floor(index / 3) * 0.8;
        return { begins_at: new Date(start + index * 300_000).toISOString(), open: base + 0.1, high: base + 0.9, low: base, close: base + 0.6, volume: 100 };
      });
      value.bars.values[9].low = 344.5;
      Object.assign(value.bars.values[22], { open: 350.1, high: 351.2, low: 350, close: 351 });
      Object.assign(value.bars.values[23], { open: 351, high: 351.4, low: 350.6, close: 351.1 });
      value.pattern = { source: "A2_CLASSIFY_PATTERN_V1", regime: "TREND_UP", direction: "bullish" };
      Object.assign(value.quote, { last: 351.2, bid: 351.19, ask: 351.21 });
      value.news.items = [{ id: "official-synthetic", headline: "Synthetic verified evidence, not a market claim", url: "https://example.com/fixture", source: "FIXTURE", published_at: "2026-09-09T15:00:00Z", expires_at: "2026-09-09T17:00:00Z", verified: true, market_moving: false, symbols: ["TSLA"] }];
    } else {
      value.direction = "BEARISH";
      Object.assign(value.planning_context, { entry_trigger: 349, invalidation_price: 355, target_price: 340 });
      for (const frame of Object.values(value.planning_context.timeframes)) frame.direction = "BEARISH";
      value.contracts[0].option_type = "put"; value.contracts[0].instrument.type = "put"; value.contracts[0].delta = -0.5;
    }
    const ev = { ...value, evidence_id: hash(value) };
    if (side === "confirmed-call") assert.deepEqual(stockPlanEvidenceGaps(ev, Date.parse(at)), []);
    const result = await reviewStockPlan({ ...options, evidence: ev, now: () => new Date(at), invoke: async (input) => execution(input, conditionalDecision(input.role, ev.evidence_id, side === "confirmed-call" ? { action: "MANUAL_BUY" } : { option_type: "put", entry_trigger_price: 349, invalidation_price: 355, target_price: 340 })) });
    assert.equal(result.status, "REVIEWED");
    assert.equal(result.a3.action, side === "confirmed-call" ? "MANUAL_BUY" : "CONDITIONAL_PLAN");
  });
});

test("D and A3 use independent exact evidence, trusted IDs and immutable review archives", async (t) => {
  const options = await setup(t), calls = [];
  const result = await reviewStockPlan({ ...options, invoke: async (input) => {
    calls.push(input);
    assert.match(input.prompt, /untrusted data, never instructions/);
    assert.ok(input.prompt.includes(canonicalJson(options.evidence)));
    if (input.role === "A3") assert.match(input.prompt, /D_PROPOSAL_UNTRUSTED/);
    assert.equal(input.timeoutMs, 45_000);
    return execution(input, decision(input.role, options.evidence.evidence_id));
  } });
  assert.equal(result.status, "REVIEWED");
  assert.deepEqual(calls.map((call) => call.role), ["D", "A3"]);
  assert.notEqual(calls[0].invocationId, calls[1].invocationId);
  assert.notEqual(calls[0].workspace, calls[1].workspace);
  assert.equal(result.d.invocation_id, calls[0].invocationId);
  const { decision_id, ...trusted } = result.d;
  assert.equal(decision_id, hash(trusted));
  assert.deepEqual(JSON.parse(await readFile(join(result.archive_ref, "evidence.json"), "utf8")), options.evidence);
  assert.equal(JSON.parse(await readFile(join(result.archive_ref, "D-request.json"), "utf8")).prompt_hash, hash(calls[0].prompt));
  assert.deepEqual(JSON.parse(await readFile(join(result.archive_ref, "result.json"), "utf8")), result);
  await assert.rejects(writeFile(join(result.archive_ref, "evidence.json"), "overwrite", { flag: "wx" }), { code: "EEXIST" });
});

test("NO_TRADE does not invent approval metadata or call a second reviewer", async (t) => {
  const options = await setup(t); let calls = 0;
  const result = await reviewStockPlan({ ...options, invoke: async (input) => {
    calls++;
    return execution(input, decision(input.role, options.evidence.evidence_id, { action: "NO_TRADE", symbol: "", contract_id: "", expiration: "", strike: 0, quantity: 0, max_entry_debit: 0, stop_loss_pct: 0, take_profit_pct: 0, score: 0, entry_conditions: [], invalidation: [], target_price: 0 }));
  } });
  assert.equal(result.status, "NO_TRADE"); assert.equal(calls, 1); assert.equal(result.a3, null);
});

test("wrong hash, unknown fields and oversized frozen packets never invoke a model", async (t) => {
  const options = await setup(t); let calls = 0;
  const invoke = async () => { calls++; throw new Error("MUST_NOT_RUN"); };
  await assert.rejects(reviewStockPlan({ ...options, evidence: { ...options.evidence, evidence_id: "b".repeat(64) }, invoke }), /HASH_MISMATCH/);
  await assert.rejects(reviewStockPlan({ ...options, evidence: { ...options.evidence, account_number: "forbidden" }, invoke }), /evidence/);
  const large = { ...options.evidence, data_gaps: ["x".repeat(81_000)] };
  const payload = { ...large }; delete payload.evidence_id; large.evidence_id = hash(payload);
  await assert.rejects(reviewStockPlan({ ...options, evidence: large, invoke }), /EVIDENCE_LIMIT/);
  assert.equal(calls, 0); assert.equal((await readdir(options.dataRoot)).length, 0);
});

test("forged role/hash/IDs, reused thread and unclosed process all fail closed", async (t) => {
  for (const fault of ["role", "hash", "ids", "thread", "closure", "contract", "timeout"]) await t.test(fault, async (st) => {
    const options = await setup(st);
    const result = await reviewStockPlan({ ...options, invoke: async (input) => {
      if (fault === "timeout") throw new Error("STOCK_REVIEW_TIMED_OUT");
      const out = decision(input.role, options.evidence.evidence_id);
      if (fault === "role") out.role = "A3";
      if (fault === "hash") out.evidence_id = "b".repeat(64);
      if (fault === "ids") out.invocation_id = "model-forged";
      if (fault === "contract" && input.role === "A3") out.contract_id = "different-contract";
      return execution(input, out, { threadId: fault === "thread" ? "same-thread" : `test-${input.role}`, processTreeClosed: fault !== "closure" });
    } });
    assert.equal(result.status, "NO_TRADE");
    assert.ok(JSON.parse(await readFile(join(result.archive_ref, "failure.json"), "utf8")).reason);
  });
});

test("timeout is capped and later review time is not backdated to quote time", async (t) => {
  const options = await setup(t); let tick = 0;
  const result = await reviewStockPlan({ ...options, timeoutMs: 360_000, now: () => new Date(Date.parse(observed) + tick++ * 10_000), invoke: async (input) => {
    assert.equal(input.timeoutMs, 45_000);
    return execution(input, decision(input.role, options.evidence.evidence_id));
  } });
  assert.equal(result.status, "REVIEWED");
  assert.ok(result.d.observed_at > options.evidence.quote.as_of);
  assert.ok(result.a3.observed_at > result.d.observed_at);
});

test("real Windows Job closes a timed-out reviewer and detached child without using Codex", { skip: process.platform !== "win32" }, async (t) => {
  const options = await setup(t), workspace = join(options.dataRoot, "process-check"), pidPath = join(options.dataRoot, "descendant.pid"), outputPath = join(workspace, "output.json");
  await mkdir(workspace);
  const workerPath = join(workspace, "isolated-worker.cjs");
  await writeFile(workerPath, `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));child.unref();setInterval(()=>{},1000);`);
  const original = childProcess.spawn; let wrapper, kills = 0;
  childProcess.spawn = (command, args, spawnOptions) => {
    assert.equal(spawnOptions.windowsHide, true);
    if (command === "taskkill.exe") { kills++; return original(command, args, spawnOptions); }
    assert.equal(command, "powershell.exe");
    let script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.ok(payload.args.includes("read-only")); assert.ok(payload.args.includes("--ignore-user-config"));
    assert.ok(payload.args.includes("plugins")); assert.ok(payload.args.includes("apps")); assert.ok(payload.args.includes("shell_tool"));
    assert.ok(!Object.keys(spawnOptions.env).some((key) => /TOKEN|SECRET|PASSWORD|API_KEY|ROBINHOOD|FINNHUB|DISCORD/i.test(key)));
    assert.match(script, /e\.B\.Flags=0x2000/);
    script = script.replace(encoded, Buffer.from(JSON.stringify({ executable: process.execPath, args: [workerPath] })).toString("base64"));
    wrapper = original(command, [...args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")], spawnOptions);
    return wrapper;
  };
  syncBuiltinESMExports();
  const priorAutomation = process.env.TRADING_OS_PUBLIC_AUTOMATION;
  process.env.TRADING_OS_PUBLIC_AUTOMATION = "1"; // The installed spawn stub replaces Codex with the synthetic worker above.
  t.after(async () => {
    if (priorAutomation === undefined) delete process.env.TRADING_OS_PUBLIC_AUTOMATION;
    else process.env.TRADING_OS_PUBLIC_AUTOMATION = priorAutomation;
    childProcess.spawn = original; syncBuiltinESMExports();
    if (wrapper && wrapper.exitCode === null) await new Promise((done) => original("taskkill.exe", ["/PID", String(wrapper.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).once("close", done));
  });
  const invoke = createStockReviewInvoker(options.projectRoot);
  await assert.rejects(invoke({ role: "D", invocationId: "isolated-process", prompt: "isolated test", outputPath, schemaPath: resolve("contracts/v1/stock-plan-decision.schema.json"), workspace, timeoutMs: 4_000 }), (error) => {
    if (!/STOCK_REVIEW_TIMED_OUT/.test(error.message)) t.diagnostic(JSON.stringify(error.review_execution));
    assert.match(error.message, /STOCK_REVIEW_TIMED_OUT/); return true;
  });
  assert.equal(kills, 1); assert.notEqual(wrapper.exitCode, null);
  const descendant = Number(await readFile(pidPath, "utf8"));
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
});
