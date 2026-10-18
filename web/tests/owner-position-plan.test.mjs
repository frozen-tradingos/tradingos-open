import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { assessPositionRisks } from "../server/position-copilot.ts";
import { timelineOccurrencesForPtDate } from "../app/timeline-schedule.ts";
import { canonicalJson, collectRobinhoodReadonly } from "../server/robinhood-mcp.ts";
import { projectStockConditionalPlans, projectStockManualPlans } from "../app/stock-manual-plan.ts";
import { startOwnerServer, writeOwnerCredentials } from "../server/local-owner-server.ts";
import { normalizeOwnerHoldingIntent, normalizeOwnerPositionPlanInput, ownerPositionCards, projectOwnerHoldingIntent, projectOwnerRiskRanges } from "../app/owner-position-plan.ts";

const position = { account_label: "账户-aaaaaaaaaaaaaaaa", contract_id: "11111111-1111-4111-8111-111111111111", symbol: "SPY", option_type: "call", expiration: "2026-09-18", strike: 100, direction: "long", quantity: 2, average_price: 2, bid: 1.9, ask: 2, as_of: "2026-09-04T16:00:00.000Z" };
function fixture(context) {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-06T03:00:00.000Z") });
  const directory = mkdtempSync(fileURLToPath(new URL("./owner-position-fixture-", import.meta.url))), file = join(directory, "plans.sqlite");
  const store = openSnapshotDatabase(file), db = new DatabaseSync(file);
  context.after(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, db, file };
}
function checkpoint(store, minute = "09:00", positions = [position], overrides = {}) {
  const occurrence = timelineOccurrencesForPtDate("2026-09-04").find((item) => item.kind === "POSITION_MONITOR" && item.business_slot === minute);
  const at = occurrence.scheduled_at, account = { source: "ROBINHOOD", status: "LIVE", as_of: at, positions: positions.map((row) => ({ ...row, as_of: at })) };
  const payload = { ...occurrence, contract_version: "v1", role: "TIMELINE_SCHEDULER", status: "SUCCEEDED", started_at: at, completed_at: at, late_seconds: 0, result_ref: null, reason: null, position_check: assessPositionRisks(account, null, at), ...overrides };
  const record_id = `checkpoint:${occurrence.slot_id}`;
  store.importOutputRaw(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id, output_type: "SCHEDULE_CHECKPOINT", channel: "SYSTEM", observed_at: at, payload }), at);
  return { record_id, check: payload.position_check };
}
function input(source, request_id = "22222222-2222-4222-8222-222222222222") {
  return { request_id, source_record_id: source.record_id, holding_id: source.check.observations[0].holding_id, original_logic: "Owner补充：原来根据长周期研究持有", holding_period: "预计持有至下次财报后重新评估", invalidation_text: "原研究的业务假设不成立时重新核查", target_text: "目标尚未核验，不作为自动止盈条件" };
}

const ownerRiskRange = { basis: "OPTION_COST_RETURN", review_loss_pct: 30, upper_loss_pct: 50, effect: "REVIEW_ONLY" };
const holdingIntent = { period: "ONE_TO_THREE_TRADING_DAYS", review_on: "2026-09-08", effect: "REVIEW_ONLY" };

test("holding cards combine exact identities without hiding risk when plans fail or positions change", () => {
  const now = Date.parse(position.as_of);
  const check = assessPositionRisks({ source: "ROBINHOOD", status: "LIVE", as_of: position.as_of, positions: [position, { ...position, strike: 101, contract_id: "22222222-2222-4222-8222-222222222222" }] }, null, position.as_of);
  const cp = { kind: "POSITION_MONITOR", position_check: check };
  const empty = { holdings: [], plans: [], history: [], risk_reviews: [] };
  const withoutPlans = ownerPositionCards(empty, cp, now);
  assert.equal(withoutPlans.rows.length, 2, "different contracts on the same symbol stay separate even when plan API failed");
  assert.equal(withoutPlans.current, true);
  assert.ok(withoutPlans.rows.every((row) => row.observation.risks.includes("PLAN_NOT_BOUND") && !row.archive));
  const holding = { ...check.observations[0], source_record_id: "real-archive" };
  const plan = { holding_id: holding.holding_id, position: holding, binding_status: "MATCHED_LATEST_ARCHIVED", plan_version_id: "p1" };
  const overview = { ...empty, holdings: [holding], plans: [plan] };
  const original = structuredClone(overview);
  assert.equal(ownerPositionCards(overview, cp, now).rows.length, 2);
  assert.equal(ownerPositionCards(overview, cp, now).rows[0].matches, true);
  const changed = structuredClone(cp); changed.position_check.observations[0].quantity = 1;
  assert.equal(ownerPositionCards(overview, changed, now).rows[0].matches, false, "partial exit cannot reuse original identity");
  assert.equal(ownerPositionCards(overview, changed, now).rows[0].archive, undefined, "no form may write against a mismatched archive");
  const newerArchive = { ...overview, holdings: [{ ...holding, quantity: 1, source_checked_at: new Date(now + 60_000).toISOString() }] };
  const conflicting = ownerPositionCards(newerArchive, cp, now + 70_000);
  assert.equal(conflicting.rows[0].holding.quantity, 1, "a newer archive cannot be hidden behind a still-fresh older checkpoint");
  assert.equal(conflicting.current, false); assert.match(conflicting.title, /待重新核验/);
  assert.equal(conflicting.rows[0].matches, false);
  const duplicate = structuredClone(cp); duplicate.position_check.observations.push(duplicate.position_check.observations[0]);
  const duplicated = ownerPositionCards(overview, duplicate, now);
  assert.equal(duplicated.current, false);
  assert.ok(duplicated.rows[0].observation.risks.includes("PLAN_NOT_BOUND"), "ambiguous identities still show historical risk rather than hiding it");
  assert.equal(duplicated.rows[0].archive, undefined);
  const stale = ownerPositionCards(overview, cp, now + 121_000);
  assert.equal(stale.current, false);
  const noCheck = ownerPositionCards(overview, null, now);
  assert.equal(noCheck.rows.length, 1); assert.equal(noCheck.rows[0].observation, undefined);
  assert.deepEqual(overview, original);
});

test("Owner holding intent is explicit, appended and delivered to runtime without rewriting old plans", (context) => {
  const { store, db, file } = fixture(context), source = checkpoint(store);
  const legacy = store.recordOwnerPositionPlan({ ...input(source), holding_period: "1–3天，这段文字不能被解析为结构化意图" });
  const original = db.prepare("SELECT payload_json, payload_sha256 FROM owner_position_plan_versions WHERE request_id = ?").get(legacy.plan.request_id);
  const saved = store.recordOwnerPositionPlan({ ...input(source, "33333333-3333-4333-8333-333333333333"), holding_intent: holdingIntent });
  assert.deepEqual(saved.plan.holding_intent, holdingIntent);
  assert.equal(store.recordOwnerPositionPlan({ ...input(source, "33333333-3333-4333-8333-333333333333"), holding_intent: holdingIntent }).duplicate, true);
  assert.equal(legacy.plan.holding_intent, undefined);
  assert.deepEqual(store.getRuntimeContext().ownerPositionPlans[0].holding_intent, holdingIntent);
  const holding = store.getOwnerPositionPlans().holdings[0], now = Date.now();
  assert.equal(projectOwnerHoldingIntent(legacy.plan, holding, now).status, "UNKNOWN");
  assert.equal(projectOwnerHoldingIntent(saved.plan, holding, now).status, "PLANNED_REVIEW");
  assert.equal(projectOwnerHoldingIntent(saved.plan, holding, Date.parse("2026-09-08T07:00:00Z")).status, "REVIEW_DUE");
  for (const altered of [{ ...holding, quantity: 1 }, { ...holding, average_cost: 2.1 }, { ...holding, holding_id: `holding-${"b".repeat(24)}` }]) assert.equal(projectOwnerHoldingIntent(saved.plan, altered, now).status, "UNKNOWN");
  assert.equal(projectOwnerHoldingIntent({ ...saved.plan, recorded_at: new Date(now + 1).toISOString() }, holding, now).status, "UNKNOWN");
  assert.equal(projectOwnerHoldingIntent({ ...saved.plan, binding_status: "POSITION_CHANGED" }, holding, now).status, "UNKNOWN");
  assert.deepEqual(db.prepare("SELECT payload_json, payload_sha256 FROM owner_position_plan_versions WHERE request_id = ?").get(legacy.plan.request_id), original);
  const reopened = openSnapshotDatabase(file);
  try { assert.deepEqual(reopened.getOwnerPositionPlans().plans[0].holding_intent, holdingIntent); } finally { reopened.close(); }
  for (const value of [null, "1–3天", {}, { ...holdingIntent, effect: "AUTO_EXIT" }, { ...holdingIntent, review_on: "2026-09-07" }, { ...holdingIntent, review_on: "2026-02-30" }, { ...holdingIntent, guessed_from_dte: 30 }]) assert.throws(() => normalizeOwnerHoldingIntent(value), /holding_intent/);
});

// Synthetic immutable history only: a published plan is not an execution or a natural acceptance.
function stockSource(db, change = () => {}, receivedAt = "2026-09-04T15:59:40.000Z") {
  const at = "2026-09-04T15:59:40.000Z", run = "live-shadow:20260904T153000Z", symbol = "NVDA";
  const contract = { contract_id: position.contract_id, option_type: "call", expiration: position.expiration, strike: position.strike, bid: 2, ask: 2.05, mark: 2.025, volume: 100, open_interest: 200, iv: 0.3, delta: 0.5, gamma: 0.03, theta: -0.05, vega: 0.04, as_of: at, history_bars: 0, history_as_of: null,
    instrument: { chain_id: "synthetic-nvda-chain", chain_symbol: symbol, expiration_date: position.expiration, strike_price: position.strike, type: "call", state: "active", tradability: "tradable", trade_value_multiplier: 100 } };
  const evidence = { contract_version: "stock-plan-v2", evidence_id: "a".repeat(64), run_id: run, slot_id: run, source_mode: "LIVE", mode: "SHADOW", automated_execution: false, observed_at: at, received_at: at, source_snapshot_id: "synthetic-a1", source_snapshot_hash: "b".repeat(64), symbol, instrument_type: "EQUITY", direction: "BULLISH",
    quote: { source: "ROBINHOOD", symbol, status: "LIVE", last: 107.2, bid: 107.19, ask: 107.21, as_of: at }, bars: { source: "ROBINHOOD", symbol, interval: "5min", as_of: at, values: [] }, pattern: null, contracts: [contract],
    account: { source: "ROBINHOOD", status: "LIVE", as_of: at, freshness_seconds: 0, account_count: 1, positions: [], orders: null, portfolio_value: null, option_value: null, realized_pnl: null },
    news: { checked_at: at, status: "LIVE", items: [] }, global_risk: { checked_at: at, critical_blockers: [], new_entry_blockers: [] }, data_gaps: [], setup_gaps: ["Synthetic pending entry confirmation"],
    planning_context: { observed_at: at, entry_trigger: 106.5, invalidation_price: 100.5, target_price: 112, why_watch: ["Synthetic frozen context"], timeframes: Object.fromEntries([["daily", "1d"], ["four_hour", "4h"], ["one_hour", "1h"], ["thirty_minute", "30m"]].map(([key, timeframe]) => [key, { timeframe, available: true, pattern: "Synthetic", state: "OBSERVED", direction: "BULLISH", confidence: 0.7, support: 100.5, resistance: 112, volume_context: "正常", data_cutoff: at, limitation: null }])) } };
  const terms = { contract_version: "stock-plan-v2", evidence_id: evidence.evidence_id, observed_at: at, action: "CONDITIONAL_PLAN", symbol, contract_id: contract.contract_id, option_type: contract.option_type, expiration: contract.expiration, strike: contract.strike, quantity: 1, max_entry_debit: 220, stop_loss_pct: -30, take_profit_pct: 50, score: 9, entry_conditions: ["Wait for real confirmation"], invalidation: ["Frozen support fails"], target_price: 112, reasons: ["Synthetic independent review"], entry_trigger_price: 106.5, invalidation_price: 100.5, holding_period: "Recheck with new evidence", contract_selection_reason: "Synthetic real-contract fixture" };
  const output = { contract_version: "stock-plan-v2", component: "STOCK_MANUAL_PLAN", mode: "SHADOW", source_mode: "LIVE", automated_execution: false, run_id: run, slot_id: run, observed_at: at, evidence, decisions: [ { ...terms, role: "D", decision_id: "synthetic-d", invocation_id: "synthetic-d-call" }, { ...terms, role: "A3", decision_id: "synthetic-a3", invocation_id: "synthetic-a3-call" } ], status: "CONDITIONAL", blocked_reasons: [] };
  change(output);
  const facts = { ...output.evidence }; delete facts.evidence_id;
  output.evidence.evidence_id = createHash("sha256").update(canonicalJson(facts)).digest("hex");
  output.decisions.forEach((decision) => { decision.evidence_id = output.evidence.evidence_id; });
  const record_id = `${output.run_id}:STOCK:${output.evidence.symbol}`, raw = JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id, output_type: "STOCK_MANUAL_PLAN", channel: "SHADOW", observed_at: output.observed_at, payload: output }), hash = createHash("sha256").update(raw).digest("hex");
  db.prepare("INSERT INTO stock_manual_plans (record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, 'STOCK_MANUAL_PLAN', 'SHADOW', ?, ?, ?, ?, ?)").run(record_id, output.observed_at, receivedAt, JSON.stringify(output), raw, hash);
  return { record_id, output, raw, hash };
}

function approveStockSource(output) {
  output.status = "APPROVED"; output.decisions.forEach((row) => { row.action = "MANUAL_BUY"; });
  output.evidence.setup_gaps = [];
  output.evidence.pattern = { source: "A2_CLASSIFY_PATTERN_V1", regime: "TREND_UP", direction: "bullish" };
  const values = Array.from({ length: 24 }, (_, index) => { const base = 100 + Math.floor(index / 3) * 0.8; return { begins_at: new Date(Date.parse("2026-09-04T13:55:00Z") + index * 300_000).toISOString(), open: base + 0.1, high: base + 0.9, low: base, close: base + 0.6, volume: 100 }; });
  values[9].low = 100.5;
  values[22] = { ...values[22], open: 106.1, high: 107.2, low: 106, close: 107 };
  values[23] = { ...values[23], open: 107, high: 107.4, low: 106.6, close: 107.1 };
  Object.assign(output.evidence.bars, { as_of: "2026-09-04T15:55:00Z", values });
  output.evidence.news.items = [{ id: "synthetic-news", headline: "Synthetic official release", url: "https://example.com/fixture", source: "OFFICIAL_COMPANY", published_at: "2026-09-04T15:00:00Z", expires_at: "2026-09-04T17:00:00Z", verified: true, market_moving: false, symbols: ["NVDA"] }];
}

test("Owner stock plan source links exact historical plans without approving a fill or reviving an old entry", (context) => {
  const { store, db, file } = fixture(context), stock = stockSource(db), source = checkpoint(store, "09:00", [{ ...position, symbol: "NVDA" }]);
  assert.equal(projectStockConditionalPlans([stock.output], Date.parse(stock.output.observed_at)).plans.length, 1);
  const request = { ...input(source), stock_plan_source_id: stock.record_id }, saved = store.recordOwnerPositionPlan(request);
  assert.equal(saved.plan.stock_plan_source_id, stock.record_id);
  assert.equal(saved.plan.stock_plan_source.relation, "OWNER_STATED_SOURCE_ONLY");
  assert.equal(saved.plan.stock_plan_source.execution, "NOT_VERIFIED");
  assert.equal(saved.plan.stock_plan_source.status, "CONDITIONAL");
  assert.equal(saved.plan.stock_plan_source.raw_sha256, stock.hash);
  assert.match(saved.plan.stock_plan_source.plan_id, /^stock-conditional:/);
  assert.equal(saved.plan.position.average_cost, 2, "the holding cost is not replaced with the old plan Ask 2.05");
  assert.equal(saved.plan.position.quantity, 2, "association is not a claim that both held contracts filled from a one-contract plan");
  const choices = store.getOwnerPositionPlans().stock_plan_sources;
  assert.equal(choices.length, 1); assert.equal(choices[0].holding_id, request.holding_id); assert.equal(choices[0].record_id, stock.record_id);
  assert.equal(choices[0].status, "CONDITIONAL"); assert.equal(choices[0].option_type, "call"); assert.equal(choices[0].expiration, position.expiration);
  assert.equal(source.check.observations[0].plan_status, "PLAN_NOT_BOUND");
  assert.equal(projectStockManualPlans([stock.output], Date.now()).plans.length, 0);
  assert.equal(store.getOutputRaw(stock.record_id), stock.raw);
  assert.equal(store.recordOwnerPositionPlan(request).duplicate, true);
  assert.throws(() => store.recordOwnerPositionPlan({ ...request, stock_plan_source_id: stock.record_id.replace("NVDA", "AAPL") }), /冲突/);
  const reopened = openSnapshotDatabase(file);
  try { assert.deepEqual(reopened.getOwnerPositionPlans().plans[0].stock_plan_source, saved.plan.stock_plan_source); } finally { reopened.close(); }
  checkpoint(store, "09:01", [{ ...position, symbol: "NVDA", quantity: 1 }]);
  assert.equal(store.getOwnerPositionPlans().plans[0].binding_status, "POSITION_CHANGED");
  assert.equal(store.getOwnerPositionPlans().plans[0].stock_plan_source.raw_sha256, stock.hash, "history remains identifiable after partial exit; no automatic rebinding");
});

test("Owner stock plan source rejects unknown fields, non-exact identifiers, missing or mismatched source plans", (context) => {
  const { store, db } = fixture(context), stock = stockSource(db), source = checkpoint(store), request = input(source);
  for (const value of [null, false, {}, [], "NVDA", "stock-manual:guessed", "replay:20260904T153000Z:STOCK:NVDA"]) assert.throws(() => normalizeOwnerPositionPlanInput({ ...request, stock_plan_source_id: value }), /stock_plan_source_id/);
  assert.deepEqual(normalizeOwnerPositionPlanInput({ ...request, stock_plan_source_id: "  " }), normalizeOwnerPositionPlanInput(request));
  assert.throws(() => store.recordOwnerPositionPlan({ ...request, stock_plan_source: { status: "APPROVED" } }), /字段/);
  assert.throws(() => store.recordOwnerPositionPlan({ ...request, stock_plan_source_id: stock.record_id.replace("NVDA", "AAPL") }), /来源/);
  assert.throws(() => store.recordOwnerPositionPlan({ ...request, stock_plan_source_id: stock.record_id }), /合约|方向/);
  for (const [index, override] of [{ symbol: "NVDA", option_type: "put" }, { symbol: "NVDA", contract_id: "22222222-2222-4222-8222-222222222222" }, { symbol: "NVDA", strike: 101 }, { symbol: "NVDA", expiration: "2026-09-25" }, { symbol: "NVDA", direction: "short" }].entries()) {
    const current = checkpoint(store, `09:0${index + 1}`, [{ ...position, ...override }]);
    assert.throws(() => store.recordOwnerPositionPlan({ ...input(current), stock_plan_source_id: stock.record_id }), /合约|方向/);
  }
  assert.equal(store.getOwnerPositionPlans().history.length, 0);
  assert.deepEqual(store.getOwnerPositionPlans().stock_plan_sources, []);
});

test("Owner stock plan source preserves an old approved source as history and versions an explicitly cleared association", (context) => {
  const { store, db } = fixture(context), stock = stockSource(db, approveStockSource), source = checkpoint(store, "09:00", [{ ...position, symbol: "NVDA" }]);
  assert.equal(projectStockManualPlans([stock.output], Date.parse(stock.output.observed_at)).plans.length, 1);
  assert.equal(projectStockManualPlans([stock.output], Date.now()).plans.length, 0);
  const first = store.recordOwnerPositionPlan({ ...input(source), stock_plan_source_id: stock.record_id });
  assert.equal(first.plan.stock_plan_source.status, "APPROVED"); assert.match(first.plan.stock_plan_source.plan_id, /^stock-manual:/);
  assert.equal(first.plan.source_mode, "OWNER_STATED"); assert.equal(first.plan.stock_plan_source.execution, "NOT_VERIFIED");
  const next = store.recordOwnerPositionPlan({ ...input(source, "33333333-3333-4333-8333-333333333333"), stock_plan_source_id: "" });
  assert.equal(next.plan.supersedes_plan_version_id, first.plan.plan_version_id);
  assert.equal(Object.hasOwn(next.plan, "stock_plan_source_id"), false); assert.equal(Object.hasOwn(next.plan, "stock_plan_source"), false);
  assert.equal(store.getOwnerPositionPlans(first.plan.request_id).plans[0].stock_plan_source.raw_sha256, stock.hash);
});

test("Owner stock plan source rejects corrupted immutable raw hashes and mismatched record identities", (context) => {
  const { store, db } = fixture(context), stock = stockSource(db), source = checkpoint(store, "09:00", [{ ...position, symbol: "NVDA" }]);
  for (const [symbol, hash] of [["AAPL", "c".repeat(64)], ["TSLA", stock.hash]]) {
    const id = stock.record_id.replace("NVDA", symbol);
    db.prepare("INSERT INTO stock_manual_plans (record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) SELECT ?, output_type, channel, observed_at, received_at, payload_json, raw_json, ? FROM stock_manual_plans WHERE record_id = ?").run(id, hash, stock.record_id);
    assert.throws(() => store.recordOwnerPositionPlan({ ...input(source), stock_plan_source_id: id }), /来源/);
  }
  assert.equal(store.getOwnerPositionPlans().history.length, 0);
});

test("Owner stock plan source dropdown stays bounded and newest-first while exact older references remain verifiable", (context) => {
  const { store, db } = fixture(context), rows = [];
  for (let index = 0; index < 21; index++) {
    const published = new Date(Date.parse("2026-09-04T15:59:40Z") + index * 1_000).toISOString();
    rows.push(stockSource(db, (output) => {
      output.observed_at = published;
      output.run_id = output.slot_id = output.evidence.run_id = output.evidence.slot_id = `live-shadow:20260904T15${String(index).padStart(2, "0")}00Z`;
    }, published));
  }
  assert.deepEqual(store.getOwnerPositionPlans().stock_plan_sources, [], "no source is offered without a real archived holding");
  const source = checkpoint(store, "09:00", [{ ...position, symbol: "NVDA" }]), choices = store.getOwnerPositionPlans().stock_plan_sources;
  assert.equal(choices.length, 20);
  assert.deepEqual(choices.map((row) => row.record_id), rows.slice(1).reverse().map((row) => row.record_id));
  assert.equal(store.recordOwnerPositionPlan({ ...input(source), stock_plan_source_id: rows[0].record_id }).plan.stock_plan_source.raw_sha256, rows[0].hash);
});

test("Owner stock plan source rejects late publication and outputs that never formed a real plan", async (context) => {
  for (const [name, change, receivedAt] of [
    ["late archive", () => {}, "2026-09-04T16:00:31.000Z"],
    ["before publication", () => {}, "2026-09-04T15:59:39.000Z"],
    ["refusal", (output) => { output.status = "NO_TRADE"; }],
    ["missing independent review", (output) => { output.decisions.pop(); }],
    ["wrong reviewed contract", (output) => { output.decisions[1].contract_id = "wrong-contract"; }],
    ["unsafe source", (output) => { output.automated_execution = true; }],
  ]) await context.test(name, (child) => {
    const { store, db } = fixture(child), stock = stockSource(db, change, receivedAt), source = checkpoint(store, "09:00", [{ ...position, symbol: "NVDA" }]);
    assert.throws(() => store.recordOwnerPositionPlan({ ...input(source), stock_plan_source_id: stock.record_id }), /来源|时间/);
    assert.equal(store.getOwnerPositionPlans().history.length, 0);
    assert.deepEqual(store.getOwnerPositionPlans().stock_plan_sources, []);
    assert.equal(store.getOutputRaw(stock.record_id), stock.raw);
  });
});

test("Owner form submits explicit numerical review ranges instead of silently retaining text-only plans", async () => {
  const React = await import("react"), ts = await import("typescript"), { renderToStaticMarkup } = await import("react-dom/server");
  const source = await readFile(process.env.OWNER_PLAN_FORM_SOURCE ?? new URL("../app/OwnerPositionPlans.tsx", import.meta.url), "utf8");
  const component = `export ${source.slice(source.indexOf("function PlanForm("), source.indexOf("export function OwnerRiskRangeStatus("))}`;
  const { outputText } = ts.transpileModule(component, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const fields = ["original_logic", "holding_period", "invalidation_text", "target_text"].map((key) => [key, key]);
  const bodyData = { original_logic: "合成测试：依据公开价格结构登记观察，不代表实际持仓", holding_period: "合成测试：下一次预定复核时重新评估", invalidation_text: "合成历史文字仅触发人工复核，绝不是自动卖出阈值", target_text: "合成测试：等待独立确认，不自动生成获利目标", review_loss_pct: "30", upper_loss_pct: "50" };
  const posts = [], messages = [], savedLists = [];
  const saved = { plan_version_id: "new-version", payload_sha256: "a".repeat(64) }, list = { plans: [saved], history: [] };
  const exports = {};
  new Function("exports", "React", "useState", "useRef", "fields", "FormData", "clientRequestId", "readPlans", "fetch", "normalizeOwnerPositionPlanInput", outputText)(
    exports, React, (value) => [value, (next) => messages.push(next)], (value) => ({ current: value }), fields,
    class { get(key) { return bodyData[key] ?? null; } }, () => "22222222-2222-4222-8222-222222222222", async () => list,
    async (_url, options) => { const body = JSON.parse(options.body); normalizeOwnerPositionPlanInput(body); posts.push(body); return { status: 201, ok: true, json: async () => ({ plan: saved }) }; },
    normalizeOwnerPositionPlanInput,
  );
  const form = exports.PlanForm({ holdingId: "holding-aaaaaaaaaaaaaaaaaaaaaaaa", sourceId: "checkpoint:timeline:position_monitor:20260909:1022", onSaved: (value) => savedLists.push(value) });
  const html = renderToStaticMarkup(form);
  assert.match(html, /type="number"[^>]*name="review_loss_pct"/);
  assert.match(html, /type="number"[^>]*name="upper_loss_pct"/);
  await form.props.onSubmit({ preventDefault() {}, currentTarget: {} });
  assert.deepEqual(posts[0].owner_risk_range, ownerRiskRange);
  assert.equal(savedLists.length, 1, "saving still requires independent readback");
  bodyData.upper_loss_pct = "20";
  await form.props.onSubmit({ preventDefault() {}, currentTarget: {} });
  assert.equal(posts.length, 1, "invalid or half-filled ranges must not be sent");
  bodyData.review_loss_pct = ""; bodyData.upper_loss_pct = "";
  await form.props.onSubmit({ preventDefault() {}, currentTarget: {} });
  assert.equal(posts.length, 2);
  assert.equal(Object.hasOwn(posts[1], "owner_risk_range"), false, "blank inputs do not parse a risk policy out of prose");
  assert.equal(Object.hasOwn(posts[1], "holding_intent"), false);
  assert.match(html, /name="holding_intent_period"/); assert.match(html, /name="holding_review_on"/);
  bodyData.holding_intent_period = "ONE_TO_THREE_TRADING_DAYS"; bodyData.holding_review_on = "2026-09-08";
  await form.props.onSubmit({ preventDefault() {}, currentTarget: {} });
  assert.deepEqual(posts[2].holding_intent, holdingIntent);
});

test("Owner loss-range review uses fresh bid evidence without inventing a stop or approving a sale", (context) => {
  const { store, db } = fixture(context), source = checkpoint(store), original = store.getOutputRaw(source.record_id);
  context.mock.timers.setTime(Date.parse(source.check.checked_at));
  const saved = store.recordOwnerPositionPlan({ ...input(source), owner_risk_range: ownerRiskRange });
  assert.deepEqual(saved.plan.owner_risk_range, ownerRiskRange);
  assert.equal(store.getOwnerPositionPlans().risk_reviews[0].status, "BELOW_REVIEW_RANGE");
  for (const [minute, bid, status] of [["09:01", 1.4, "REVIEW_RANGE_REACHED"], ["09:02", 1, "LOSS_RANGE_EXCEEDED"], ["09:03", 0.7, "LOSS_RANGE_EXCEEDED"]]) {
    const latest = checkpoint(store, minute, [{ ...position, bid }]);
    context.mock.timers.setTime(Date.parse(latest.check.checked_at));
    const before = store.getOutputRaw(latest.record_id), review = store.getOwnerPositionPlans().risk_reviews[0];
    assert.equal(review.status, status);
    assert.equal(review.effect, "REVIEW_ONLY");
    assert.equal(review.automated_execution, false);
    assert.equal(review.source_record_id, latest.record_id);
    assert.equal(latest.check.observations[0].plan_status, "PLAN_NOT_BOUND");
    assert.equal(latest.check.observations[0].stop_loss_pct, null);
    assert.equal(store.getOutputRaw(latest.record_id), before, "a read never changes the frozen check or its approval");
  }
  assert.equal(store.getOutputRaw(source.record_id), original);
  assert.equal(db.prepare("SELECT count(*) n FROM owner_position_plan_versions").get().n, 1);
});

test("Owner loss-range input accepts only an explicit finite increasing review range, with legacy text preserved", (context) => {
  const { store } = fixture(context), source = checkpoint(store), request = input(source);
  for (const range of [null, false, [], "30-50", { ...ownerRiskRange, effect: "SELL" }, { ...ownerRiskRange, basis: "MARK_RETURN" }, { ...ownerRiskRange, stop_loss_pct: -30 },
    { ...ownerRiskRange, review_loss_pct: "30" }, { ...ownerRiskRange, review_loss_pct: NaN }, { ...ownerRiskRange, upper_loss_pct: Infinity }, { ...ownerRiskRange, review_loss_pct: 0 },
    { ...ownerRiskRange, review_loss_pct: -30 }, { ...ownerRiskRange, review_loss_pct: 50 }, { ...ownerRiskRange, review_loss_pct: 60 }, { ...ownerRiskRange, upper_loss_pct: 101 }]) {
    assert.throws(() => normalizeOwnerPositionPlanInput({ ...request, owner_risk_range: range }), /owner_risk_range/);
  }
  const saved = store.recordOwnerPositionPlan({ ...request, invalidation_text: "合成历史文字仅触发人工复核，绝不是自动卖出阈值" });
  assert.equal(saved.plan.owner_risk_range, undefined, "do not infer an executable threshold by parsing historical text");
  assert.deepEqual(store.getOwnerPositionPlans().risk_reviews, []);
});

test("superseded Owner request readback preserves its receipt but never revives its old risk range", (context) => {
  const { store } = fixture(context), source = checkpoint(store, "09:00", [{ ...position, symbol: "NOK", bid: 1.5 }]);
  context.mock.timers.setTime(Date.parse(source.check.checked_at));
  const original = store.getOutputRaw(source.record_id);
  const first = store.recordOwnerPositionPlan({ ...input(source), owner_risk_range: ownerRiskRange });
  const second = store.recordOwnerPositionPlan({ ...input(source, "33333333-3333-4333-8333-333333333333"), owner_risk_range: { ...ownerRiskRange, review_loss_pct: 10, upper_loss_pct: 20 } });
  const current = store.getOwnerPositionPlans(), readback = store.getOwnerPositionPlans(first.plan.request_id);
  assert.equal(current.risk_reviews[0].status, "LOSS_RANGE_EXCEEDED");
  assert.equal(current.risk_reviews[0].plan_version_id, second.plan.plan_version_id);
  assert.equal(readback.plans[0].plan_version_id, first.plan.plan_version_id);
  assert.deepEqual(readback.plans[0].owner_risk_range, ownerRiskRange, "historical receipt stays unchanged");
  assert.deepEqual(readback.risk_reviews, current.risk_reviews, "current review always uses latest Owner ranges, even on old request readback");
  assert.equal(current.history.length, 2);
  assert.equal(store.getOutputRaw(source.record_id), original);
});

test("Owner loss-range review rejects old, future, missing, failed or mismatched evidence without changing the 120-second boundary", (context) => {
  const { store } = fixture(context), source = checkpoint(store, "09:00", [{ ...position, bid: 1 }]);
  const at = Date.parse(source.check.checked_at);
  context.mock.timers.setTime(at);
  const { plan } = store.recordOwnerPositionPlan({ ...input(source), owner_risk_range: ownerRiskRange });
  const captured = JSON.parse(store.getOutputRaw(source.record_id)).payload;
  const status = (value, now = at) => projectOwnerRiskRanges([plan], value, now)[0];
  assert.equal(status(captured, at + 120_000).status, "LOSS_RANGE_EXCEEDED");
  assert.equal(status(captured).valid_until, new Date(at + 120_000).toISOString());
  for (const now of [at - 1, at + 120_001, NaN, Infinity]) {
    const review = status(captured, now);
    assert.equal(review.status, "NOT_CURRENT"); assert.equal(review.exit_return_pct, null);
  }
  const changes = [
    (value) => { value.status = "DATA_BLOCKED"; },
    (value) => { value.position_check.checks_completed = false; },
    (value) => { value.position_check.account_status = "STALE"; },
    (value) => { value.position_check.account_as_of = new Date(at + 1).toISOString(); },
    (value) => { value.position_check.account_as_of = new Date(at - 120_001).toISOString(); },
    (value) => { value.position_check.observations[0].quote_as_of = new Date(at + 1).toISOString(); },
    (value) => { value.position_check.observations[0].quote_as_of = new Date(at - 120_001).toISOString(); },
    (value) => { value.position_check.observations[0].quote_as_of = null; },
    (value) => { value.position_check.observations[0].quote_status = "UNAVAILABLE"; },
    (value) => { value.position_check.observations[0].bid = null; },
    (value) => { value.position_check.observations[0].bid = 0; },
    (value) => { value.position_check.observations[0].ask = 0.5; },
  ];
  for (const change of changes) {
    const changed = structuredClone(captured); change(changed);
    const review = status(changed);
    assert.equal(review.status, "NOT_CURRENT", change.toString()); assert.equal(review.exit_return_pct, null); assert.equal(review.valid_until, null);
  }
  for (const [field, value] of [["holding_id", "holding-ffffffffffffffffffffffff"], ["contract_id", "22222222-2222-4222-8222-222222222222"], ["quantity", 3], ["average_cost", 3], ["direction", "short"]]) {
    const changed = structuredClone(captured); changed.position_check.observations[0][field] = value;
    assert.equal(status(changed).status, "POSITION_CHANGED", field);
  }
  const duplicate = structuredClone(captured); duplicate.position_check.observations.push({ ...duplicate.position_check.observations[0] });
  assert.equal(status(duplicate).status, "POSITION_CHANGED");
  assert.equal(status(null).status, "NOT_CURRENT");
  assert.equal(projectOwnerRiskRanges([{ ...plan, recorded_at: new Date(at + 1).toISOString() }], captured, at)[0].status, "NOT_CURRENT");
});

test("Owner loss-range readback does not fall back past a failed minute or resurrect a plan after account change or exit/reentry", (context) => {
  const { store } = fixture(context), source = checkpoint(store, "09:00", [{ ...position, bid: 1 }]);
  context.mock.timers.setTime(Date.parse(source.check.checked_at));
  store.recordOwnerPositionPlan({ ...input(source), owner_risk_range: ownerRiskRange });
  const failed = checkpoint(store, "09:01", [{ ...position, bid: 1 }], { status: "DATA_BLOCKED", position_check: undefined });
  context.mock.timers.setTime(Date.parse("2026-09-04T16:01:00Z"));
  const review = store.getOwnerPositionPlans().risk_reviews[0];
  assert.equal(review.status, "NOT_CURRENT"); assert.equal(review.source_record_id, failed.record_id);
  const other = checkpoint(store, "09:02", [{ ...position, bid: 1, account_label: "账户-bbbbbbbbbbbbbbbb" }]);
  context.mock.timers.setTime(Date.parse(other.check.checked_at));
  assert.equal(store.getOwnerPositionPlans().risk_reviews[0].status, "POSITION_CHANGED");
  checkpoint(store, "09:03", []);
  const reentry = checkpoint(store, "09:04", [{ ...position, bid: 1 }]);
  context.mock.timers.setTime(Date.parse(reentry.check.checked_at));
  assert.equal(store.getOwnerPositionPlans().risk_reviews[0].status, "POSITION_CHANGED");
});

test("Owner loss-range website waits for its clock, expires quotes locally and never labels a reminder as a sell plan", async () => {
  const React = await import("react"), { renderToStaticMarkup } = await import("react-dom/server"), ts = await import("typescript");
  const { formatPtDateTime } = await import("../app/market-time.ts");
  const source = await readFile(new URL("../app/OwnerPositionPlans.tsx", import.meta.url), "utf8");
  const component = source.slice(source.indexOf("export function OwnerRiskRangeStatus"), source.indexOf("export function OwnerPositionPlans"));
  const { outputText } = ts.transpileModule(component, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  new Function("exports", "React", "formatPtDateTime", outputText)(exports, React, formatPtDateTime);
  const now = Date.parse("2026-09-08T17:00:00Z"), review = { ...ownerRiskRange, status: "LOSS_RANGE_EXCEEDED", exit_return_pct: -55, checked_at: new Date(now).toISOString(), valid_until: new Date(now + 120_000).toISOString() };
  const render = (currentTime, value = review) => renderToStaticMarkup(React.createElement(exports.OwnerRiskRangeStatus, { review: value, currentTime }));
  assert.match(render(now), /达到或超出你所说的50%/);
  assert.match(render(now), /-55.00%/);
  assert.match(render(now), /不是止损审批或卖单/);
  for (const currentTime of [now - 1, now + 120_001]) {
    assert.match(render(currentTime), /不沿用旧风险结论/);
    assert.doesNotMatch(render(currentTime), /-55.00%|达到或超出/);
  }
  assert.match(render(now, { ...review, status: "POSITION_CHANGED" }), /旧范围不能自动沿用/);
  const effect = source.match(/if \(!Number\.isFinite\(expiry\)\) return;([\s\S]*?)\n {2}\}, \[expiry\]\);/)?.[1];
  assert.ok(effect);
  let clock = now;
  const timers = [], updates = [], listeners = [], win = { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return 1; }, clearTimeout() {}, addEventListener: (name) => listeners.push(name), removeEventListener() {} };
  new Function("expiry", "setExpiredAt", "Date", "window", "document", effect)(now + 500, (at) => updates.push(at), { now: () => clock }, win, win);
  assert.equal(timers[0].delay, 501, "local expiry must not wait for the next website request");
  clock = now + 501; timers[0].callback();
  assert.deepEqual(updates, [clock]); assert.deepEqual(listeners, ["focus", "visibilitychange"]);
  const readEffect = source.match(/const minute = Math\.floor\(currentTime \/ 60_000\);\s*useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[minute\]\);/)?.[1];
  assert.ok(readEffect);
  const requests = [], lists = [], errors = [], list = { plans: [], holdings: [] };
  const load = new Function("minute", "readPlans", "setList", "setError", readEffect);
  const read = (signal) => { requests.push(signal); return Promise.resolve(list); };
  for (const minute of [0, -1, NaN, Infinity]) assert.equal(load(minute, read, (value) => lists.push(value), (value) => errors.push(value)), undefined);
  assert.equal(requests.length, 0, "the hydration clock must not issue a first GET that the real clock immediately repeats");
  const stop = load(Math.floor(now / 60_000), read, (value) => lists.push(value), (value) => errors.push(value));
  await Promise.resolve();
  assert.equal(requests.length, 1); assert.deepEqual(lists, [list]); assert.deepEqual(errors, [null]);
  stop(); assert.equal(requests[0].aborted, true);
  const stopNext = load(Math.floor(now / 60_000) + 1, read, () => {}, () => {});
  assert.equal(requests.length, 2, "the next real minute still refreshes archived plans");
  stopNext();
});

async function a1(store, minute = "00", positions = [position], sourceMode = "LIVE", accountStatus = "LIVE", accountAgeSeconds = 0) {
  const at = `2026-09-04T16:${minute}:00.000Z`;
  const market = await collectRobinhoodReadonly({ async call() { return { content: [{ type: "text", text: "{}" }] }; } }, at);
  market.account = { source: "ROBINHOOD", status: accountStatus, as_of: new Date(Date.parse(at) - accountAgeSeconds * 1_000).toISOString(), freshness_seconds: accountAgeSeconds, account_count: 1, portfolio_value: null, option_value: null, realized_pnl: null, orders: null, positions: positions.map((row) => ({ mark: null, iv: null, delta: null, gamma: null, theta: null, vega: null, open_interest: null, volume: null, ...row, as_of: at })) };
  const record_id = `${sourceMode === "LIVE" ? "live-shadow" : "replay"}:20260904T16${minute}00Z:A1`;
  const payload = { contract_version: "v1", component: "A1", mode: "SHADOW", actionable: false, source_mode: sourceMode, status: "BLOCKED", observed_at: at, data_cutoff_at: at, freshness_seconds: 0, result_hash: "a".repeat(64), evidence_ref: "synthetic/evidence", market_snapshot_id: market.snapshot_id, market_snapshot_hash: market.snapshot_hash, data_gaps: [], v2_result: {}, market_sources: market };
  store.importOutputRaw(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id, output_type: "A1_SHADOW_RESULT", channel: "SHADOW", observed_at: at, payload }), at);
  return { record_id, check: assessPositionRisks(market.account, null, at) };
}

test("Owner plans append immutable versions, survive reopen and never rewrite frozen evidence or approvals", (context) => {
  const { store, db, file } = fixture(context), source = checkpoint(store), request = input(source);
  const before = store.getOutputRaw(source.record_id);
  const first = store.recordOwnerPositionPlan(request);
  assert.equal(first.duplicate, false);
  assert.equal(first.plan.source_mode, "OWNER_STATED");
  assert.equal(first.plan.recorded_at, "2026-09-06T03:00:00.000Z");
  assert.equal(first.plan.evidence_status, "ARCHIVED_ONLY_NOT_CURRENT");
  assert.equal(first.plan.binding_status, "MATCHED_LATEST_ARCHIVED");
  assert.equal(store.recordOwnerPositionPlan({ ...request }).duplicate, true);
  assert.throws(() => store.recordOwnerPositionPlan({ ...request, original_logic: "same request cannot change its facts" }), /冲突/);
  const second = store.recordOwnerPositionPlan({ ...request, request_id: "33333333-3333-4333-8333-333333333333", original_logic: "Owner第二版补充，保留第一版记录" });
  assert.notEqual(second.plan.plan_version_id, first.plan.plan_version_id);
  assert.equal(second.plan.supersedes_plan_version_id, first.plan.plan_version_id);
  assert.equal(store.getOwnerPositionPlans().history.length, 2);
  assert.equal(store.getOutputRaw(source.record_id), before);
  assert.throws(() => db.exec("UPDATE owner_position_plan_versions SET payload_json = '{}'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM owner_position_plan_versions"), /append-only/);
  const reopened = openSnapshotDatabase(file);
  try { assert.equal(reopened.getOwnerPositionPlans(request.request_id).plans[0].payload_sha256, first.plan.payload_sha256); } finally { reopened.close(); }
});

test("changed quantity, account or observed exit/reentry cannot silently reuse an earlier Owner plan", (context) => {
  const { store } = fixture(context), first = checkpoint(store), request = input(first);
  store.recordOwnerPositionPlan(request);
  checkpoint(store, "09:01", [{ ...position, quantity: 1 }]);
  assert.equal(store.getOwnerPositionPlans().plans[0].binding_status, "POSITION_CHANGED");
  assert.throws(() => store.recordOwnerPositionPlan({ ...request, request_id: "44444444-4444-4444-8444-444444444444" }), /最新/);
  checkpoint(store, "09:02", []);
  assert.equal(store.getOwnerPositionPlans().plans[0].binding_status, "POSITION_NOT_IN_LATEST");
  checkpoint(store, "09:03", [position]);
  assert.equal(store.getOwnerPositionPlans().plans[0].binding_status, "POSITION_CHANGED", "same contract reentry does not resurrect the old version");
  const otherAccount = checkpoint(store, "09:04", [{ ...position, account_label: "账户-bbbbbbbbbbbbbbbb" }]);
  assert.equal(store.getOwnerPositionPlans().plans[0].binding_status, "POSITION_NOT_IN_LATEST");
  assert.throws(() => store.recordOwnerPositionPlan({ ...input(otherAccount), holding_id: request.holding_id }), /持仓/);
});

test("runtime latest Owner plans match UI order and binding through multiple holdings, exit and reentry", (context) => {
  const { store, db } = fixture(context);
  const same = () => { const plans = store.getOwnerPositionPlans().plans; assert.deepEqual(store.getRuntimeContext().ownerPositionPlans, plans); return plans; };
  assert.deepEqual(same(), []);
  const other = { ...position, contract_id: "88888888-8888-4888-8888-888888888888", symbol: "QQQ", strike: 200 };
  const source = checkpoint(store, "09:00", [position, other]), first = store.recordOwnerPositionPlan(input(source));
  const second = store.recordOwnerPositionPlan({ ...input(source, "33333333-3333-4333-8333-333333333333"), holding_id: source.check.observations[1].holding_id });
  const revised = store.recordOwnerPositionPlan(input(source, "44444444-4444-4444-8444-444444444444"));
  assert.deepEqual(same().map((plan) => plan.plan_version_id), [revised.plan.plan_version_id, second.plan.plan_version_id]);
  assert.equal(same().some((plan) => plan.plan_version_id === first.plan.plan_version_id), false);
  const raw = db.prepare("SELECT * FROM owner_position_plan_versions ORDER BY sequence").all();
  checkpoint(store, "09:01", [other]);
  assert.deepEqual(same().map((plan) => plan.binding_status), ["POSITION_NOT_IN_LATEST", "MATCHED_LATEST_ARCHIVED"]);
  checkpoint(store, "09:02", [position, { ...other, quantity: 1 }]);
  assert.deepEqual(same().map((plan) => plan.binding_status), ["POSITION_CHANGED", "POSITION_CHANGED"]);
  checkpoint(store, "09:03", []);
  assert.deepEqual(same().map((plan) => plan.binding_status), ["POSITION_NOT_IN_LATEST", "POSITION_NOT_IN_LATEST"]);
  assert.deepEqual(db.prepare("SELECT * FROM owner_position_plan_versions ORDER BY sequence").all(), raw);
});

test("a form can retain its real source across later identical minutes, but any intervening change rejects it even after restoration", (context) => {
  const { store } = fixture(context), source = checkpoint(store), request = input(source);
  checkpoint(store, "09:01", [position]);
  const saved = store.recordOwnerPositionPlan(request);
  assert.equal(saved.plan.source_record_id, source.record_id, "the server must not silently replace the referenced archive");
  assert.equal(saved.plan.source_checked_at, source.check.checked_at);
  assert.equal(saved.plan.recorded_at, "2026-09-06T03:00:00.000Z");
  checkpoint(store, "09:02", [{ ...position, quantity: 1 }]);
  checkpoint(store, "09:03", [position]);
  assert.throws(() => store.recordOwnerPositionPlan({ ...request, request_id: "55555555-5555-4555-8555-555555555555" }), /最新|变化|连续/);
  assert.equal(store.getOwnerPositionPlans().history.length, 1);
});

test("Owner input cannot forge source identity, receipt time, approval or a missing holding", (context) => {
  const { store } = fixture(context), source = checkpoint(store), request = input(source);
  for (const extra of [{ recorded_at: "2020-01-01T00:00:00Z" }, { stop_loss_pct: -10 }, { source_mode: "LIVE" }, { account_label: "账户-bbbbbbbbbbbbbbbb" }]) assert.throws(() => store.recordOwnerPositionPlan({ ...request, ...extra }), /字段/);
  for (const original_logic of ["", " ", "x".repeat(2001)]) assert.throws(() => store.recordOwnerPositionPlan({ ...request, original_logic }), /original_logic/);
  assert.throws(() => store.recordOwnerPositionPlan({ ...request, source_record_id: "replay:fake" }), /source_record/);
  assert.throws(() => store.recordOwnerPositionPlan({ ...request, holding_id: "holding-ffffffffffffffffffffffff" }), /持仓/);
  assert.equal(store.getOwnerPositionPlans().history.length, 0);
});

test("real archived A1 holdings can be recorded before any minute samples, while later A1 changes and minute checks invalidate them", async (context) => {
  const { store } = fixture(context);
  const source = await a1(store), request = input(source), before = store.getOutputRaw(source.record_id);
  assert.equal(store.getOwnerPositionPlans().holdings[0].holding_id, request.holding_id);
  assert.equal(store.getOwnerPositionPlans().holdings[0].evidence_status, "ARCHIVED_ONLY_NOT_CURRENT");
  const first = store.recordOwnerPositionPlan(request);
  assert.equal(first.plan.binding_status, "MATCHED_LATEST_ARCHIVED");
  assert.equal(store.getOutputRaw(source.record_id), before);
  await a1(store, "01", [{ ...position, average_price: 3 }]);
  assert.equal(store.getOwnerPositionPlans().plans[0].binding_status, "POSITION_CHANGED");
  assert.equal(store.recordOwnerPositionPlan(request).plan.payload_sha256, first.plan.payload_sha256, "retry preserves the saved version after source changes");
  await a1(store, "02", []);
  assert.equal(store.getOwnerPositionPlans().plans[0].binding_status, "POSITION_NOT_IN_LATEST");
  await a1(store, "03", [position]);
  assert.equal(store.getOwnerPositionPlans().plans[0].binding_status, "POSITION_CHANGED");
  checkpoint(store, "09:04", []);
  assert.equal(store.getOwnerPositionPlans().plans[0].binding_status, "POSITION_NOT_IN_LATEST");
  assert.equal(store.getOwnerPositionPlans().holdings.length, 0);
});

test("replay, failed, future and stale-at-capture account archives cannot manufacture real holdings", async (context) => {
  const { store } = fixture(context);
  await a1(store, "00", [position], "REPLAY");
  await a1(store, "01", [position], "LIVE", "DATA_BLOCKED");
  await a1(store, "02", [position], "LIVE", "LIVE", 121);
  assert.deepEqual(store.getOwnerPositionPlans().holdings, []);
  const source = await a1(store, "03");
  context.mock.timers.setTime(Date.parse("2026-09-04T16:01:00.000Z"));
  assert.deepEqual(store.getOwnerPositionPlans().holdings, []);
  context.mock.timers.setTime(Date.parse("2026-09-06T03:00:00.000Z"));
  assert.equal(store.getOwnerPositionPlans().holdings.length, 1, "archive is usable as history, never current evidence");
  assert.equal(store.recordOwnerPositionPlan(input(source)).plan.historical_knowledge_status, "RECORDED_AFTER_OBSERVATION");
});

test("Owner HTTP intake requires authentication and same origin, then confirms persisted id/hash through request_id readback", async (context) => {
  const { store, file } = fixture(context), source = await a1(store), request = input(source), directory = dirname(file);
  const options = { host: "127.0.0.1", port: 0, outDir: resolve("dist"), shadowRuntime: false, incidentGuard: false, codexManager: false, runtimeRole: "WEB", snapshotWorker: false,
    databasePath: file, credentialsPath: join(directory, "owner.json"), gatewayKeyPath: join(directory, "gateway.key"), lockPath: join(directory, "owner.pid"), trustedHomeAccessPath: join(directory, "trusted-home.json") };
  writeOwnerCredentials(options.credentialsPath, "Owner-Plan-Isolated-Test-Only!");
  writeFileSync(options.trustedHomeAccessPath, JSON.stringify({ version: 1, enabled: false, trusted_cidrs: [] }));
  const running = await startOwnerServer(options), endpoint = `${running.url}/api/owner-position-plans`;
  try {
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { origin: running.url }, body: JSON.stringify(request) })).status, 401);
    const login = await fetch(`${running.url}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: running.url }, body: new URLSearchParams({ username: "owner", password: "Owner-Plan-Isolated-Test-Only!" }) });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0], headers = { cookie, origin: running.url, "content-type": "application/json" };
    assert.equal((await fetch(endpoint, { method: "POST", headers: { ...headers, origin: "https://external.invalid" }, body: JSON.stringify(request) })).status, 403);
    assert.equal((await fetch(endpoint, { method: "DELETE", headers })).status, 405);
    assert.equal((await fetch(endpoint, { method: "POST", headers, body: "{" })).status, 400);
    assert.equal((await fetch(endpoint, { method: "POST", headers, body: "[]" })).status, 400);
    const post = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(request) }), saved = await post.json();
    assert.equal(post.status, 201); assert.equal(saved.duplicate, false);
    const read = await fetch(`${endpoint}?request_id=${request.request_id}`, { headers: { cookie } }), confirmed = await read.json();
    assert.equal(read.status, 200); assert.equal(read.headers.get("cache-control"), "no-store");
    assert.equal(confirmed.plans[0].plan_version_id, saved.plan.plan_version_id);
    assert.equal(confirmed.plans[0].payload_sha256, saved.plan.payload_sha256);
    const retry = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(request) });
    assert.equal(retry.status, 200); assert.equal((await retry.json()).duplicate, true);
    assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...request, original_logic: "different retry" }) })).status, 409);
    assert.equal((await fetch(`${endpoint}?request_id=invalid`, { headers: { cookie } })).status, 400);
    assert.equal(store.getOwnerPositionPlans().history.length, 1);
  } finally { await running.close(); }
});
