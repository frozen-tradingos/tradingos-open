import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectStockConditionalPlans, projectStockManualPlans, stockOptionGaps, stockPlanAnalysisGaps, stockPlanEvidenceGaps, stockPlanStructure, validateStockManualPlanOutput, validateStockPlanDecision, validateStockPlanEvidence } from "../app/stock-manual-plan.ts";
import { projectOwnerManualPlans } from "../app/owner-manual-plan.ts";
import { parseOutputEnvelope } from "../app/snapshot-import.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { canonicalJson } from "../server/robinhood-mcp.ts";
import { createStockManualRuntime } from "../server/stock-manual-runtime.ts";

// Synthetic control-flow evidence only; never a real approval, forecast, natural slot or trade.
const at = "2026-09-09T16:30:40.000Z", now = Date.parse(at), run = "live-shadow:20260909T160000Z";
const iso = (offset) => new Date(now + offset).toISOString();
function fixture(direction = "BULLISH") {
  const start = Date.parse("2026-09-09T14:30:00.000Z");
  const values = Array.from({ length: 24 }, (_, index) => {
    const base = 100 + Math.floor(index / 3) * 0.8;
    return { begins_at: new Date(start + index * 300_000).toISOString(), open: base + 0.1, high: base + 0.9, low: base, close: base + 0.6, volume: 100 };
  });
  values[9].low = 100.5; // A confirmed prior 15m pivot, not a guessed support.
  values[22] = { ...values[22], open: 106.1, high: 107.2, low: 106, close: 107 };
  values[23] = { ...values[23], open: 107, high: 107.4, low: 106.6, close: 107.1 };
  const side = direction === "BULLISH" ? "call" : "put";
  if (side === "put") for (const row of values) { const { open, high, low, close } = row; Object.assign(row, { open: 220 - open, high: 220 - low, low: 220 - high, close: 220 - close }); }
  const last = side === "call" ? 107.2 : 112.8;
  const contract = { contract_id: "fixture-nvda-call-id", option_type: side, expiration: "2026-09-11", strike: 110, bid: 2, ask: 2.05, mark: 2.025, volume: 100, open_interest: 200, iv: 0.3, delta: side === "call" ? 0.5 : -0.5, gamma: 0.03, theta: -0.05, vega: 0.04, as_of: at, history_bars: 0, history_as_of: null,
    instrument: { chain_id: "nvda-official-chain", chain_symbol: "NVDA", expiration_date: "2026-09-11", strike_price: 110, type: side, state: "active", tradability: "tradable", trade_value_multiplier: 100 } };
  const evidence = { contract_version: "stock-plan-v1", evidence_id: "a".repeat(64), run_id: run, slot_id: run, source_mode: "LIVE", mode: "SHADOW", automated_execution: false, observed_at: iso(-2_000), received_at: at, source_snapshot_id: "fixture-a1", source_snapshot_hash: "b".repeat(64), symbol: "NVDA", instrument_type: "EQUITY", direction,
    quote: { source: "ROBINHOOD", symbol: "NVDA", status: "LIVE", last, bid: last - 0.01, ask: last + 0.01, as_of: at }, bars: { source: "ROBINHOOD", symbol: "NVDA", interval: "5min", as_of: "2026-09-09T16:30:00.000Z", values }, pattern: { source: "A2_CLASSIFY_PATTERN_V1", regime: side === "call" ? "TREND_UP" : "TREND_DOWN", direction: side === "call" ? "bullish" : "bearish" }, contracts: [contract],
    account: { source: "ROBINHOOD", status: "LIVE", as_of: at, freshness_seconds: 0, account_count: 1, positions: [], orders: null, portfolio_value: null, option_value: null, realized_pnl: null },
    news: { checked_at: at, status: "LIVE", items: [{ id: "fixture-official-news", headline: "Synthetic official company release for contract testing", url: "https://example.com/fixture", source: "OFFICIAL_COMPANY", published_at: iso(-3_600_000), expires_at: iso(3_600_000), verified: true, market_moving: false, symbols: ["NVDA"] }] }, global_risk: { checked_at: at, critical_blockers: [], new_entry_blockers: [] }, data_gaps: [] };
  const terms = { contract_version: "stock-plan-v1", evidence_id: evidence.evidence_id, observed_at: at, action: "MANUAL_BUY", symbol: "NVDA", contract_id: contract.contract_id, option_type: side, expiration: contract.expiration, strike: contract.strike, quantity: 1, max_entry_debit: 220, stop_loss_pct: -30, take_profit_pct: 50, score: 9, entry_conditions: ["Owner checks the current quoted condition"], invalidation: ["The stock loses the frozen support"], target_price: side === "call" ? 112 : 108, reasons: ["Independent synthetic decision"] };
  return { contract_version: "stock-plan-v1", component: "STOCK_MANUAL_PLAN", mode: "SHADOW", source_mode: "LIVE", automated_execution: false, run_id: run, slot_id: run, observed_at: at, evidence, decisions: [{ ...terms, role: "D", decision_id: "fixture-d", invocation_id: "fixture-d-call" }, { ...terms, role: "A3", decision_id: "fixture-a3", invocation_id: "fixture-a3-call" }], status: "APPROVED", blocked_reasons: [] };
}
function position(id = "held-one", extra = {}) {
  return { account_label: "账户-aaaaaaaaaaaaaaaa", contract_id: id, symbol: "AAPL", option_type: "call", expiration: "2026-09-11", strike: 100, direction: "long", quantity: 1, average_price: 1, bid: 1, ask: 1.02, mark: 1.01, iv: 0.3, delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.1, open_interest: 100, volume: 20, as_of: at, ...extra };
}
function seal(output) {
  const evidence = { ...output.evidence }; delete evidence.evidence_id;
  output.evidence.evidence_id = createHash("sha256").update(canonicalJson(evidence)).digest("hex");
  output.decisions.forEach((decision) => { decision.evidence_id = output.evidence.evidence_id; });
  return output;
}
const envelope = (output) => JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `${output.run_id}:STOCK:${output.evidence.symbol}`, output_type: "STOCK_MANUAL_PLAN", channel: "SHADOW", observed_at: output.observed_at, payload: output });

function conditionalFixture(direction = "BULLISH", days = 40) {
  const output = fixture(direction), e = output.evidence, bullish = direction === "BULLISH";
  output.contract_version = e.contract_version = "stock-plan-v2";
  output.status = "CONDITIONAL";
  e.planning_context = { observed_at: e.observed_at, entry_trigger: bullish ? 106.5 : 113.5, invalidation_price: bullish ? 100.5 : 119.5, target_price: bullish ? 112 : 108,
    why_watch: ["Synthetic frozen multi-timeframe context"], timeframes: Object.fromEntries([["daily", "1d"], ["four_hour", "4h"], ["one_hour", "1h"], ["thirty_minute", "30m"]].map(([key, timeframe]) => [key, {
      timeframe, available: true, pattern: "Synthetic structure", state: "OBSERVED", direction, confidence: 0.7, support: 100.5, resistance: 119.5, volume_context: "正常", data_cutoff: e.observed_at, limitation: null }])) };
  e.bars.values = e.bars.values.slice(-3); e.pattern = null;
  e.news.items.forEach((item) => { item.verified = false; }); e.setup_gaps = ["当前盘型和入场保持条件未形成"];
  const contract = e.contracts[0], expiration = new Date(Date.parse("2026-09-09") + days * 86_400_000).toISOString().slice(0, 10);
  contract.expiration = contract.instrument.expiration_date = expiration;
  for (const row of output.decisions) Object.assign(row, { contract_version: "stock-plan-v2", action: "CONDITIONAL_PLAN", expiration,
    entry_trigger_price: e.planning_context.entry_trigger, invalidation_price: e.planning_context.invalidation_price,
    holding_period: "跟随条件变化复查，不保证持有到期", contract_selection_reason: "来自提供的真实期限样本；比较价差、成本和到期风险后选择，不是全链最优承诺" });
  return seal(output);
}

function earlyFixture(direction = "BULLISH") {
  const earlyAt = "2026-09-09T13:55:30.000Z", shift = Date.parse(earlyAt) - now;
  const output = JSON.parse(JSON.stringify(conditionalFixture(direction, 2)).replace(/2026-09-09T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (stamp) => new Date(Date.parse(stamp) + shift).toISOString()));
  const e = output.evidence, bullish = direction === "BULLISH", context = e.planning_context;
  output.run_id = output.slot_id = e.run_id = e.slot_id = "live-shadow:20260909T134500Z";
  output.status = "APPROVED"; output.decisions.forEach((row) => { row.action = "MANUAL_BUY"; });
  e.entry_rule = "MULTI_TIMEFRAME_BREAK_HOLD_V1"; e.setup_gaps = [];
  e.pattern = fixture(direction).evidence.pattern; e.news.items[0].verified = true;
  e.bars.values = [[103.1, 104, 103, 103.8], [103.8, 105, 103.7, 104.8], [104.8, 106.5, 104.5, 106], [106.1, 107.2, 106, 107], [107, 107.4, 106.6, 107.1]].map(([open, high, low, close], index) => ({
    begins_at: new Date(Date.parse("2026-09-09T13:30:00.000Z") + index * 300_000).toISOString(),
    ...(bullish ? { open, high, low, close } : { open: 220 - open, high: 220 - low, low: 220 - high, close: 220 - close }), volume: 100,
  }));
  e.bars.as_of = "2026-09-09T13:55:00.000Z";
  for (const [key, cutoff] of Object.entries({ daily: "2026-09-08T00:00:00.000Z", four_hour: "2026-09-08T13:30:00.000Z", one_hour: "2026-09-08T19:00:00.000Z", thirty_minute: "2026-09-08T19:30:00.000Z" })) context.timeframes[key].data_cutoff = cutoff;
  context.timeframes.four_hour[bullish ? "resistance" : "support"] = context.entry_trigger;
  return seal(output);
}

test("shared contract quality rejects nonpositive IV and preserves valid positive IV", () => {
  for (const output of [fixture(), conditionalFixture()]) {
    const e = output.evidence, contract = e.contracts[0];
    for (const iv of [0.0001, contract.iv]) assert.deepEqual(stockOptionGaps(e, { ...contract, iv }, now), []);
    for (const iv of [0, -0.3]) assert.match(stockOptionGaps(e, { ...contract, iv }, now).join(), /Greeks未核验/);
  }
});

test("explicit v2 early rule confirms Call and Put after five complete opening bars without changing legacy entry", () => {
  for (const direction of ["BULLISH", "BEARISH"]) {
    const output = earlyFixture(direction), e = output.evidence, earlyNow = Date.parse(output.observed_at), before = JSON.stringify(output);
    assert.equal(validateStockPlanEvidence(e), e);
    assert.deepEqual(stockPlanEvidenceGaps(e, earlyNow), []);
    const result = projectStockManualPlans([output], earlyNow);
    assert.equal(result.plans.length, 1); assert.deepEqual(result.blocked_reasons, []);
    assert.equal(result.progress[0].structure_confirmed, true);
    assert.equal(result.progress[0].break_level, e.planning_context.entry_trigger);
    assert.equal(result.plans[0].automated_execution, false); assert.equal(result.plans[0].owner_confirmation_required, true);
    assert.equal(JSON.stringify(output), before);
    delete e.entry_rule;
    assert.equal(stockPlanStructure(e).eligible, false, "unmarked v2 retains the original 18-bar rule");
    assert.equal(projectStockManualPlans([output], earlyNow).plans.length, 0);
    const legacy = fixture(direction).evidence; legacy.entry_rule = "MULTI_TIMEFRAME_BREAK_HOLD_V1";
    assert.throws(() => validateStockPlanEvidence(legacy), /legacy-fields/);
    e.entry_rule = "UNREVIEWED_EARLY_RULE";
    assert.throws(() => validateStockPlanEvidence(e), /entry-rule/);
  }
});

test("v2 early confirmation rejects incomplete, future, overnight, gap-only, opposed and retrospectively derived structure", () => {
  const cases = [
    (e) => { e.bars.values.shift(); },
    (e) => { e.bars.values[1].begins_at = e.bars.values[0].begins_at; },
    (e) => { e.bars.values[0].begins_at = "2026-09-08T13:30:00.000Z"; },
    (e) => { e.bars.values[0].begins_at = "2026-09-09T13:25:00.000Z"; },
    (e) => { e.bars.values[4].begins_at = "2026-09-09T13:55:00.000Z"; },
    (e) => { e.received_at = "2026-09-09T13:55:29.999Z"; },
    (e) => { e.bars.as_of = e.received_at; },
    (e) => { e.bars.values[1].volume = -1; },
    (e) => { e.bars.values[1].high = 1; },
    (e) => { e.pattern = null; },
    (e) => { e.pattern.regime = "UNKNOWN"; },
    (e) => { e.pattern.regime = "WIDE_CHOP"; },
    (e) => { e.pattern.regime = e.direction === "BULLISH" ? "TREND_DOWN" : "TREND_UP"; },
    (e) => { e.pattern.direction = e.direction === "BULLISH" ? "bearish" : "bullish"; },
    (e) => { e.planning_context = null; },
    (e) => { e.planning_context.entry_trigger = null; },
    (e) => { e.planning_context.timeframes.one_hour.direction = e.direction === "BULLISH" ? "BEARISH" : "BULLISH"; },
    (e) => { e.planning_context.timeframes.thirty_minute.available = false; },
    (e) => { e.planning_context.timeframes.daily.data_cutoff = "2026-09-09T00:00:00.000Z"; },
    (e) => { e.planning_context.timeframes.one_hour.data_cutoff = "2026-09-09T13:30:00.000Z"; },
    (e) => { e.planning_context.timeframes.four_hour.data_cutoff = "2026-09-09T09:50:00.000Z"; },
    (e) => { e.planning_context.timeframes.four_hour[e.direction === "BULLISH" ? "resistance" : "support"] += 0.1; },
    (e) => { const bar = e.bars.values[3]; bar.open = e.direction === "BULLISH" ? 107 : 113; },
    (e) => { const bar = e.bars.values[4]; bar[e.direction === "BULLISH" ? "low" : "high"] = e.direction === "BULLISH" ? 106 : 114; },
    (e) => { const bar = e.bars.values[2]; bar[e.direction === "BULLISH" ? "high" : "low"] = e.direction === "BULLISH" ? 106.6 : 113.4; },
  ];
  for (const direction of ["BULLISH", "BEARISH"]) for (const mutate of cases) {
    const output = earlyFixture(direction); mutate(output.evidence); seal(output);
    const result = projectStockManualPlans([output], Date.parse(output.observed_at));
    assert.equal(result.plans.length, 0, `${direction}: ${mutate}`); assert.ok(result.blocked_reasons.length);
  }
});

test("v2 early evidence still needs fresh sources, verified news, exact money limits and two independent approvals", () => {
  const cases = [
    (o) => { o.evidence.quote.as_of = "2026-09-09T13:48:29.000Z"; },
    (o) => { o.evidence.account.as_of = "2026-09-09T13:53:29.000Z"; },
    (o) => { o.evidence.news.items[0].verified = false; },
    (o) => { o.evidence.news.items[0].expires_at = o.observed_at; },
    (o) => { o.evidence.global_risk.new_entry_blockers = ["EXISTING_GLOBAL_BLOCK"]; },
    (o) => { o.evidence.data_gaps = ["SOURCE_NOT_VERIFIED"]; },
    (o) => { o.evidence.setup_gaps = ["UNRESOLVED_SETUP_GAP"]; },
    (o) => { o.evidence.contracts[0].ask = 3; },
    (o) => { o.evidence.contracts[0].delta = null; },
    (o) => { o.evidence.account.positions = [position("a"), position("b"), position("c")]; },
    (o) => { o.decisions[1].max_entry_debit = 1001; },
    (o) => { o.decisions[1].quantity = 2; },
    (o) => { o.decisions[1].score = 8; },
    (o) => { o.decisions[1].stop_loss_pct = -51; },
    (o) => { o.decisions[1].take_profit_pct = 71; },
    (o) => { o.decisions.pop(); },
    (o) => { o.decisions[1].action = "NO_TRADE"; },
    (o) => { o.decisions[1].invocation_id = o.decisions[0].invocation_id; },
    (o) => { o.decisions[1].contract_id = "OTHER_CONTRACT"; },
    (o) => { o.decisions[1].entry_trigger_price += 0.1; },
  ];
  for (const mutate of cases) {
    const output = earlyFixture(); mutate(output); seal(output);
    assert.equal(projectStockManualPlans([output], Date.parse(output.observed_at)).plans.length, 0, String(mutate));
  }
});

test("v2 separates complete independently reviewed pre-plans from entry approval without fixing a holding horizon", () => {
  for (const direction of ["BULLISH", "BEARISH"]) for (const days of [0, 7, 10, 22, 40, 75, 100]) {
    const output = conditionalFixture(direction, days), before = JSON.stringify(output);
    assert.deepEqual(stockPlanAnalysisGaps(output.evidence, now), []);
    assert.ok(stockPlanEvidenceGaps(output.evidence, now).length > 0);
    assert.equal(projectStockManualPlans([output], now).plans.length, 0);
    const result = projectStockConditionalPlans([output], now);
    assert.deepEqual(result.blocked_reasons, []);
    assert.equal(result.plans.length, 1);
    const plan = result.plans[0];
    assert.equal(plan.stage, "WAITING_TRIGGER"); assert.equal(plan.quantity, 1);
    assert.equal(plan.reference_price, 2.05); assert.equal(plan.max_debit_usd, 220);
    assert.equal(plan.entry_trigger_price, output.evidence.planning_context.entry_trigger);
    assert.equal(plan.invalidation_price, output.evidence.planning_context.invalidation_price);
    assert.equal(plan.target_price, output.evidence.planning_context.target_price);
    assert.equal(plan.expiration, output.evidence.contracts[0].expiration);
    assert.equal(plan.holding_period, output.decisions[1].holding_period);
    assert.equal(plan.automated_execution, false); assert.equal(plan.owner_confirmation_required, true);
    assert.match(plan.pending_conditions.join(";"), /新证据重新复核/);
    assert.match(plan.pending_conditions.join(";"), /已核验.*新闻/);
    const expired = projectStockConditionalPlans([output], now + 120_000).plans[0];
    assert.equal(expired.stage, "EXPIRED"); assert.equal(expired.source_ref, plan.source_ref);
    assert.equal(expired.observed_at, plan.observed_at); assert.equal(JSON.stringify(output), before);
    assert.deepEqual(parseOutputEnvelope(envelope(output)).payload, output);
  }
});

test("v2 pre-plans cannot bypass real contracts, account limits, source integrity or independent review", () => {
  const cases = [
    (o) => { o.decisions.pop(); }, (o) => { o.decisions[1].action = "NO_TRADE"; },
    (o) => { o.decisions[1].invocation_id = o.decisions[0].invocation_id; },
    (o) => { o.decisions[1].entry_trigger_price += 1; }, (o) => { o.decisions[1].invalidation_price += 1; },
    (o) => { o.decisions[1].target_price += 1; }, (o) => { o.decisions[1].holding_period = ""; },
    (o) => { o.decisions[1].contract_selection_reason = ""; }, (o) => { o.decisions[1].contract_id = "invented"; },
    (o) => { o.decisions[1].max_entry_debit = 200; }, (o) => { o.decisions[1].quantity = 2; },
    (o) => { o.decisions[1].stop_loss_pct = -100; }, (o) => { o.decisions[1].take_profit_pct = 200; },
    (o) => { o.evidence.contracts = []; }, (o) => { o.evidence.contracts[0].instrument.chain_symbol = "AAPL"; },
    (o) => { o.evidence.contracts[0].instrument.trade_value_multiplier = 10; },
    (o) => { o.evidence.contracts[0].ask = 4; }, (o) => { o.evidence.contracts[0].delta = null; },
    (o) => { o.evidence.contracts[0].as_of = iso(-421_000); }, (o) => { o.evidence.contracts[0].as_of = iso(1); },
    (o) => { o.evidence.quote.as_of = iso(-421_000); }, (o) => { o.evidence.account.as_of = iso(-121_000); },
    (o) => { o.evidence.account.positions = null; }, (o) => { o.evidence.account.positions = [position("1"), position("2"), position("3")]; },
    (o) => { o.evidence.account.positions = [position(o.evidence.contracts[0].contract_id, { symbol: "NVDA", strike: 110, expiration: o.evidence.contracts[0].expiration, average_price: 9 })]; },
    (o) => { o.evidence.data_gaps = ["真实来源读取失败"]; }, (o) => { o.evidence.news.status = "DATA_BLOCKED"; },
    (o) => { o.evidence.global_risk.new_entry_blockers = ["GLOBAL_HARD_BLOCK"]; },
    (o) => { o.evidence.planning_context = null; }, (o) => { o.evidence.planning_context.entry_trigger = null; },
    (o) => { o.evidence.planning_context.observed_at = iso(-421_000); },
    (o) => { o.evidence.planning_context.timeframes.daily.data_cutoff = iso(1); },
    (o) => { o.evidence.bars.values[0].high = 1; }, (o) => { o.evidence.bars.values[0].volume = -1; },
    (o) => { o.evidence.bars.values[0].begins_at = iso(1); },
  ];
  for (const mutate of cases) {
    const output = conditionalFixture(); mutate(output);
    assert.equal(projectStockConditionalPlans([output], now).plans.length, 0, String(mutate));
    assert.equal(projectStockManualPlans([output], now).plans.length, 0, String(mutate));
  }
  assert.equal(projectStockConditionalPlans([conditionalFixture()], now - 1).plans.length, 0);
  assert.equal(projectStockConditionalPlans([fixture()], now).plans.length, 0, "legacy output cannot become a pre-plan");
});

test("v2 needs a new approved output to become an entry, and a new refusal removes the old pre-plan", () => {
  const old = conditionalFixture(), approved = conditionalFixture();
  approved.status = "APPROVED"; approved.decisions.forEach((row) => { row.action = "MANUAL_BUY"; });
  assert.equal(projectStockManualPlans([approved], now).plans.length, 0, "changing a label cannot substitute for entry evidence");
  const full = fixture();
  approved.evidence.bars = full.evidence.bars; approved.evidence.pattern = full.evidence.pattern;
  approved.evidence.news = full.evidence.news; approved.evidence.setup_gaps = []; seal(approved);
  assert.equal(projectStockManualPlans([approved], now).plans.length, 1, "v2 authentic longer expiry is allowed only after unchanged full entry gates");
  assert.equal(projectStockConditionalPlans([approved], now).plans.length, 0);
  const refused = structuredClone(old); refused.observed_at = iso(1_000); refused.status = "NO_TRADE"; refused.decisions[1].action = "NO_TRADE";
  assert.equal(projectStockConditionalPlans([old, refused], now + 1_000).plans.length, 0);
  refused.run_id = refused.slot_id = refused.evidence.run_id = refused.evidence.slot_id = "live-shadow:20260909T163000Z";
  assert.equal(projectStockConditionalPlans([old, refused], now + 1_000).plans.length, 0);
});

test("v2 pre-plan expires with its planning context and cannot wait after its invalidation price was reached", () => {
  const oldContext = conditionalFixture();
  oldContext.evidence.planning_context.observed_at = iso(-400_000);
  Object.values(oldContext.evidence.planning_context.timeframes).forEach((frame) => { frame.data_cutoff = iso(-400_000); });
  assert.equal(projectStockConditionalPlans([oldContext], now).plans[0].valid_until, iso(20_000));
  assert.equal(projectStockConditionalPlans([oldContext], now + 19_999).plans[0].stage, "WAITING_TRIGGER");
  assert.equal(projectStockConditionalPlans([oldContext], now + 20_000).plans[0].stage, "EXPIRED");
  for (const direction of ["BULLISH", "BEARISH"]) for (const move of [0, 1]) {
    const output = conditionalFixture(direction), e = output.evidence;
    e.quote.last = e.planning_context.invalidation_price + (direction === "BULLISH" ? -move : move);
    e.quote.bid = e.quote.last - 0.01; e.quote.ask = e.quote.last + 0.01;
    assert.match(stockPlanAnalysisGaps(e, now).join(";"), /现价已达到原观察失效/);
    assert.equal(projectStockConditionalPlans([output], now).plans.length, 0);
  }
});

test("v2 conditional source references and expiry survive home/options views; current failures invalidate without rewriting", async () => {
  const { ownerSnapshotView } = await import("../server/local-owner-server.ts");
  const store = openSnapshotDatabase(":memory:", { investmentProfile: "BLANK" });
  try {
    const snapshot = store.getActive(); snapshot.outputs.STOCK_MANUAL_PLAN = [conditionalFixture()];
    const original = JSON.stringify(snapshot), expected = projectOwnerManualPlans(snapshot, now);
    assert.equal(expected.plans.length, 0); assert.equal(expected.conditional_plans.length, 1);
    for (const view of ["home", "options"]) assert.deepEqual(projectOwnerManualPlans(ownerSnapshotView(snapshot, view), now).conditional_plans, expected.conditional_plans);
    assert.equal(JSON.stringify(snapshot), original);
    snapshot.dataSources = [{ source: "ROBINHOOD", authorization: "EXPIRED", checked_at: at }];
    const revoked = projectOwnerManualPlans(snapshot, now).conditional_plans[0];
    assert.equal(revoked.stage, "EXPIRED"); assert.equal(revoked.source_ref, expected.conditional_plans[0].source_ref);
    assert.match(revoked.pending_conditions.join(";"), /最新授权未通过/);
  } finally { store.close(); }
});

test("blocked stock candidates retain a readable condition-to-review path without manufacturing an approval", () => {
  const output = fixture(); output.status = "DATA_BLOCKED"; output.decisions = [];
  output.evidence.news.items[0].verified = false;
  const before = JSON.stringify(output), result = projectStockManualPlans([output], now);
  assert.equal(result.plans.length, 0);
  assert.equal(result.progress.length, 1);
  const row = result.progress[0];
  assert.equal(row.stage, "WAITING"); assert.equal(row.symbol, "NVDA");
  assert.equal(row.direction, "BULLISH"); assert.equal(row.executable, false);
  assert.equal(row.break_level, stockPlanStructure(output.evidence).break_level);
  assert.equal(row.invalidation_price, stockPlanStructure(output.evidence).invalidation_price);
  assert.equal(row.news[0].verified, false); assert.equal(row.review_count, 0);
  assert.match(row.reasons.join(";"), /已核验.*新闻/);
  assert.equal(row.quote_current, true); assert.equal(row.quote_as_of, at);
  const expired = projectStockManualPlans([output], now + 421_000).progress[0];
  assert.equal(expired.stage, "EXPIRED"); assert.equal(expired.quote_current, false);
  assert.equal(expired.observed_at, at); assert.equal(expired.news[0].verified, false);
  assert.equal(JSON.stringify(output), before);
});

test("stock progress preserves refusal, isolates latest batch, and never re-labels expired or malformed evidence", () => {
  const old = fixture(), refusal = fixture("BEARISH");
  refusal.observed_at = iso(1_000); refusal.status = "NO_TRADE";
  refusal.decisions[1].action = "NO_TRADE";
  assert.equal(projectStockManualPlans([old, refusal], now + 1_000).progress[0].stage, "DECLINED");
  const approved = projectStockManualPlans([old], now);
  assert.equal(approved.progress[0].stage, "OWNER_REVIEW");
  assert.equal(approved.progress[0].executable, false, "even an approved manual plan is not an order");
  assert.equal(projectStockManualPlans([old], now + 120_001).progress[0].stage, "WAITING", "a stale account cannot leave the owner-ready label on screen");
  assert.equal(projectStockManualPlans([old], Date.parse("2026-09-09T20:00:00Z")).progress[0].stage, "EXPIRED");
  old.evidence.automated_execution = true;
  assert.deepEqual(projectStockManualPlans([old], now).progress, []);
});

test("home and options expose the same latest progress and the next natural core stock check", async () => {
  const { ownerSnapshotView } = await import("../server/local-owner-server.ts");
  const store = openSnapshotDatabase(":memory:", { investmentProfile: "BLANK" });
  try {
    const snapshot = store.getActive(), output = fixture();
    output.status = "DATA_BLOCKED"; output.decisions = []; output.evidence.news.items[0].verified = false;
    snapshot.outputs.STOCK_MANUAL_PLAN = [output];
    const before = JSON.stringify(snapshot), result = projectOwnerManualPlans(snapshot, now);
    assert.equal(result.next_stock_check, "2026-09-09T17:00:00.000Z", "stocks now run independently after the next natural TS attempt");
    assert.equal(result.progress.length, 1); assert.equal(result.plans.length, 0);
    for (const view of ["home", "options"]) {
      const compact = projectOwnerManualPlans(ownerSnapshotView(snapshot, view), now);
      assert.deepEqual(compact.progress, result.progress);
      assert.equal(compact.next_stock_check, result.next_stock_check);
    }
    assert.equal(JSON.stringify(snapshot), before);
  } finally { store.close(); }
});

test("a newer news authorization failure revokes readiness without rewriting the independent stock quote observation", () => {
  const output = fixture(), snapshot = { outputs: { SCHEDULE_CHECKPOINT: [], OPTION_STRATEGY_SIGNAL: [], STOCK_MANUAL_PLAN: [output] },
    dataSources: [{ source: "FINNHUB", authorization: "EXPIRED", checked_at: iso(1_000) }], selfCheck: { active: [] } };
  const result = projectOwnerManualPlans(snapshot, now + 1_000);
  assert.equal(result.plans.length, 0); assert.equal(result.progress[0].stage, "WAITING");
  assert.equal(result.progress[0].quote_current, true);
  assert.match(result.progress[0].reasons.join(";"), /FINNHUB最新授权/);
});

test("same-time current failures revoke readiness and later failures retain explicit refusal", () => {
  for (const failure of [
    { dataSources: [{ source: "ROBINHOOD", authorization: "EXPIRED", checked_at: at }] },
    { dataSources: [{ source: "FINNHUB", authorization: "EXPIRED", checked_at: at }] },
    { selfCheck: { active: [{ code: "UTC_STORAGE_MISALIGNED", status: "ACTIVE", last_seen_at: at, title: "Synthetic current trust failure", details: {} }] } },
    { outputs: { SCHEDULE_CHECKPOINT: [{ kind: "POSITION_MONITOR", slot_id: "timeline:position_monitor:fixture", status: "FAILED", completed_at: at }] } },
  ]) {
    const output = fixture(), snapshot = { dataSources: [], selfCheck: { active: [] }, ...failure,
      outputs: { SCHEDULE_CHECKPOINT: [], ...failure.outputs, OPTION_STRATEGY_SIGNAL: [], STOCK_MANUAL_PLAN: [output] } };
    const result = projectOwnerManualPlans(snapshot, now);
    assert.equal(result.plans.length, 0, JSON.stringify(failure));
    assert.equal(result.progress[0].stage, "WAITING");
    output.status = "NO_TRADE"; output.decisions[1].action = "NO_TRADE";
    assert.equal(projectOwnerManualPlans(snapshot, now + 1_000).progress[0].stage, "DECLINED");
  }
});

test("real shape stock Call and Put can project one manual plan; no automatic order or mutation", () => {
  for (const direction of ["BULLISH", "BEARISH"]) {
    const output = fixture(direction), before = JSON.stringify(output);
    assert.equal(validateStockManualPlanOutput(output), output);
    assert.deepEqual(stockPlanEvidenceGaps(output.evidence, now), []);
    assert.equal(stockPlanStructure(output.evidence).eligible, true);
    const result = projectStockManualPlans([output], now);
    assert.deepEqual(result.blocked_reasons, []);
    assert.equal(result.plans.length, 1);
    const plan = result.plans[0];
    assert.equal(plan.symbol, "NVDA"); assert.equal(plan.side, "BUY_TO_OPEN"); assert.equal(plan.quantity, 1);
    assert.equal(plan.option_type, direction === "BULLISH" ? "call" : "put");
    assert.equal(plan.reference_price, 2.05); assert.equal(plan.max_debit_usd, 220);
    assert.equal(plan.automated_execution, false); assert.equal(plan.owner_confirmation_required, true);
    assert.equal(plan.trigger_state, "OWNER_CHECK_REQUIRED"); assert.equal(plan.valid_until, iso(120_000));
    assert.equal(JSON.stringify(output), before);
    assert.equal(projectStockManualPlans([output], now + 120_001).plans.length, 0);
  }
});

test("strict versioned boundary rejects index, replay, unmasked identities, extras and malformed scalars", () => {
  const cases = [
    (x) => { x.contract_version = "v1"; }, (x) => { x.mode = "LIVE"; }, (x) => { x.source_mode = "REPLAY"; },
    (x) => { x.automated_execution = true; }, (x) => { x.symbol = "SPY"; }, (x) => { x.symbol = "QQQ"; }, (x) => { x.symbol = "XSP"; },
    (x) => { x.instrument_type = "ETF"; }, (x) => { x.extra = true; }, (x) => { x.quote.last = "107.2"; },
    (x) => { x.evidence_id = "not-a-hash"; }, (x) => { x.received_at = "2026-09-09"; },
    (x) => { x.account.positions = [position("held", { account_label: "account-123456" })]; },
    (x) => { x.account.orders = [{ order_id: "private" }]; }, (x) => { x.news.items[0].url = "file:///secret"; },
    (x) => { delete x.pattern; }, (x) => { x.pattern.source = "GUESSED"; }, (x) => { x.pattern.regime = "MIXED"; },
    (x) => { x.pattern.direction = "BULLISH"; }, (x) => { x.pattern.extra = true; },
    (x) => { delete x.news.items[0].expires_at; }, (x) => { x.news.items[0].expires_at = "tomorrow"; },
  ];
  for (const mutate of cases) { const output = fixture(); mutate(output.evidence); assert.throws(() => validateStockPlanEvidence(output.evidence)); assert.equal(projectStockManualPlans([output], now).plans.length, 0); }
  const invalid = fixture().decisions[0]; invalid.score = "9"; assert.throws(() => validateStockPlanDecision(invalid));
  assert.equal(projectStockManualPlans([], now).plans.length, 0);
});

test("no approval, role replay, evidence/contract mismatch, blocked health and stale source never become a plan", () => {
  const cases = [
    (x) => { x.decisions = []; }, (x) => { x.decisions.pop(); }, (x) => { x.decisions[1].role = "D"; },
    (x) => { x.decisions[1].action = "NO_TRADE"; }, (x) => { x.status = "NO_TRADE"; },
    (x) => { x.decisions[1].evidence_id = "c".repeat(64); }, (x) => { x.decisions[1].invocation_id = x.decisions[0].invocation_id; },
    (x) => { x.decisions[1].contract_id = "other-contract"; }, (x) => { x.decisions[1].expiration = "2026-09-10"; },
    (x) => { x.decisions[1].observed_at = iso(-10_000); }, (x) => { x.observed_at = iso(1_000); },
    (x) => { x.evidence.quote.as_of = iso(-421_000); }, (x) => { x.evidence.quote.as_of = iso(1_000); },
    (x) => { x.evidence.account.as_of = iso(-121_000); }, (x) => { x.evidence.account.positions = null; },
    (x) => { x.evidence.global_risk.critical_blockers = ["SOURCE_IDENTITY_BROKEN"]; },
    (x) => { x.evidence.global_risk.new_entry_blockers = ["GLOBAL_NEW_ENTRY_BLOCK"]; },
    (x) => { x.evidence.news.items[0].verified = false; }, (x) => { x.evidence.news.status = "DATA_BLOCKED"; },
    (x) => { x.evidence.data_gaps = ["Missing official stock evidence"]; },
    (x) => { x.evidence.contracts[0].instrument.trade_value_multiplier = null; }, (x) => { x.evidence.contracts[0].instrument.trade_value_multiplier = 150; },
    (x) => { x.evidence.contracts[0].instrument.chain_symbol = "AAPL"; }, (x) => { x.evidence.contracts[0].instrument.tradability = "untradable"; },
  ];
  for (const mutate of cases) { const output = fixture(); mutate(output); const result = projectStockManualPlans([output], now); assert.equal(result.plans.length, 0, mutate.toString()); assert.ok(result.blocked_reasons.length); }
});

test("existing numeric entry gates stay closed outside exact limits", () => {
  const cases = [
    (x) => { x.decisions[0].score = 8; }, (x) => { x.decisions[1].score = 9.5; },
    (x) => { x.decisions.forEach((d) => { d.quantity = 2; }); }, (x) => { x.decisions[1].max_entry_debit = 1001; },
    (x) => { x.decisions[1].max_entry_debit = 200; }, (x) => { x.decisions[0].stop_loss_pct = -29; },
    (x) => { x.decisions[0].stop_loss_pct = -51; }, (x) => { x.decisions[0].take_profit_pct = 29; }, (x) => { x.decisions[1].take_profit_pct = 71; },
    (x) => { x.evidence.contracts[0].bid = 1.8; }, (x) => { x.evidence.contracts[0].ask = 2.11; },
    (x) => { x.evidence.contracts[0].open_interest = 0; }, (x) => { x.evidence.contracts[0].delta = null; },
    (x) => { x.decisions[0].entry_conditions = []; }, (x) => { x.decisions[1].invalidation = []; }, (x) => { x.decisions[1].target_price = 105; },
    (x) => { const expiration = "2026-10-02"; x.decisions.forEach((d) => { d.expiration = expiration; }); x.evidence.contracts[0].expiration = expiration; x.evidence.contracts[0].instrument.expiration_date = expiration; },
    (x) => { x.evidence.account.positions = [position("a"), position("b"), position("c")]; },
    (x) => { x.evidence.account.positions = [position("fixture-nvda-call-id", { symbol: "NVDA", strike: 110, quantity: 4, average_price: 2 })]; },
    (x) => { x.evidence.account.positions = [position("a", { quantity: null })]; },
  ];
  for (const mutate of cases) { const output = fixture(); mutate(output); assert.equal(projectStockManualPlans([output], now).plans.length, 0, mutate.toString()); }
});

test("structure requires complete own-stock 15m/30m bars, confirmed pivot and 5m next-bar hold", () => {
  const cases = [
    (x) => { x.evidence.bars.values = x.evidence.bars.values.slice(-12); },
    (x) => { x.evidence.bars.values[5].begins_at = x.evidence.bars.values[4].begins_at; },
    (x) => { x.evidence.bars.values[23].low = 106; },
    (x) => { x.evidence.bars.values[22].open = 107; },
    (x) => { x.evidence.bars.values[9].low = 102.4; },
    (x) => { x.evidence.bars.values[6].high = 110; },
    (x) => { x.evidence.bars.values[23].begins_at = iso(-300_000); },
    (x) => { x.evidence.bars.as_of = at; },
  ];
  for (const mutate of cases) { const output = fixture(); mutate(output); assert.equal(projectStockManualPlans([output], now).plans.length, 0, mutate.toString()); }
});

test("original A2 wide-chop classification vetoes superficially aligned higher-timeframe structure", () => {
  const output = fixture();
  for (let i = 12; i <= 20; i++) {
    const close = i % 2 === 0 ? 106.7 : 103.6;
    Object.assign(output.evidence.bars.values[i], { open: close, close, high: close + 0.1, low: close - 0.1 });
  }
  output.evidence.pattern = { source: "A2_CLASSIFY_PATTERN_V1", regime: "WIDE_CHOP", direction: "bullish" };
  assert.equal(stockPlanStructure(output.evidence).eligible, false);
  assert.equal(projectStockManualPlans([output], now).plans.length, 0);
});

test("original A2 missing, unknown and fixed opposite regimes fail closed without treating transition traits as hard directions", () => {
  for (const direction of ["BULLISH", "BEARISH"]) {
    const opposite = direction === "BULLISH" ? ["TREND_DOWN", "V_REVERSAL_DOWN", "FALSE_BREAKOUT"] : ["TREND_UP", "V_REVERSAL_UP", "FALSE_BREAKDOWN"];
    for (const regime of [null, "UNKNOWN", ...opposite]) {
      const output = fixture(direction);
      output.evidence.pattern = regime === null ? null : { source: "A2_CLASSIFY_PATTERN_V1", regime, direction: direction.toLowerCase() };
      assert.equal(validateStockPlanEvidence(output.evidence), output.evidence);
      assert.equal(stockPlanStructure(output.evidence).eligible, false, `${direction}/${regime}`);
      assert.equal(projectStockManualPlans([output], now).plans.length, 0);
    }
    for (const regime of ["TRANSITION", "NARROW_RANGE"]) {
      const output = fixture(direction);
      output.evidence.pattern = { source: "A2_CLASSIFY_PATTERN_V1", regime, direction: direction === "BULLISH" ? "bearish" : "bullish" };
      assert.equal(stockPlanStructure(output.evidence).eligible, true);
      assert.equal(projectStockManualPlans([output], now).plans.length, 1);
    }
  }
});

test("verified news must retain its original unexpired deadline at the actual projection time", () => {
  for (const expiry of [null, iso(-1), at]) {
    const output = fixture(); output.evidence.news.items[0].expires_at = expiry;
    assert.equal(validateStockPlanEvidence(output.evidence), output.evidence);
    assert.equal(projectStockManualPlans([output], now).plans.length, 0);
  }
  const output = fixture(); output.evidence.news.items[0].expires_at = iso(500);
  assert.equal(projectStockManualPlans([output], now).plans.length, 1);
  assert.equal(projectStockManualPlans([output], now).plans[0].valid_until, iso(500), "the plan cannot claim validity beyond its supporting news deadline");
  assert.equal(projectStockManualPlans([output], now + 1_000).plans.length, 0, "expiry is checked against now, not the earlier received_at");
});

test("after 10:30 retains the news exception and never trades after the normal session", () => {
  const output = fixture(), shift = 90 * 60_000;
  const shifted = JSON.parse(JSON.stringify(output).replace(/2026-09-09T(?:\d{2}):(?:\d{2}):(?:\d{2})\.\d{3}Z/g, (stamp) => new Date(Date.parse(stamp) + shift).toISOString()));
  assert.equal(projectStockManualPlans([shifted], now + shift).plans.length, 0);
  shifted.evidence.news.items[0].market_moving = true;
  assert.equal(projectStockManualPlans([shifted], now + shift).plans.length, 1);
  const expiry = shifted.evidence.news.items[0].expires_at;
  shifted.evidence.news.items[0].expires_at = new Date(now + shift).toISOString();
  assert.equal(projectStockManualPlans([shifted], now + shift).plans.length, 0, "expired major news cannot unlock the after-10:30 exception");
  shifted.evidence.news.items[0].expires_at = expiry;
  shifted.evidence.news.items[0].published_at = "2026-09-08T18:00:00.000Z";
  assert.equal(projectStockManualPlans([shifted], now + shift).plans.length, 0);
  assert.equal(projectStockManualPlans([output], Date.parse("2026-09-09T20:00:00.000Z")).plans.length, 0);
});

test("a plan without same-day major news cannot advertise validity beyond 10:30 PT", () => {
  const original = fixture(), shift = 59 * 60_000;
  const output = JSON.parse(JSON.stringify(original).replace(/2026-09-09T(?:\d{2}):(?:\d{2}):(?:\d{2})\.\d{3}Z/g, (stamp) => new Date(Date.parse(stamp) + shift).toISOString()));
  output.evidence.bars.as_of = new Date(Date.parse(original.evidence.bars.as_of) + 55 * 60_000).toISOString();
  output.evidence.bars.values.forEach((bar, i) => { bar.begins_at = new Date(Date.parse(original.evidence.bars.values[i].begins_at) + 55 * 60_000).toISOString(); });
  const result = projectStockManualPlans([output], now + shift);
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].valid_until, "2026-09-09T17:30:00.000Z");
  assert.equal(projectStockManualPlans([output], Date.parse(result.plans[0].valid_until)).plans.length, 0);
  output.evidence.news.items[0].market_moving = true;
  assert.equal(projectStockManualPlans([output], now + shift).plans[0].valid_until, new Date(now + shift + 120_000).toISOString(), "the original verified-major-news exception is retained");
});

test("multiple stock plans share the remaining portfolio capacity; newest refusal supersedes old approvals", () => {
  const variant = (symbol, identity) => {
    const output = fixture();
    output.evidence.symbol = output.evidence.quote.symbol = output.evidence.bars.symbol = symbol;
    output.evidence.evidence_id = identity.repeat(64);
    output.evidence.contracts[0].instrument.chain_symbol = symbol;
    output.evidence.contracts[0].contract_id = `fixture-${symbol}`;
    output.evidence.news.items[0].symbols = [symbol];
    output.evidence.account.positions = [position("already-one"), position("already-two")];
    for (const d of output.decisions) { d.symbol = symbol; d.evidence_id = output.evidence.evidence_id; d.contract_id = output.evidence.contracts[0].contract_id; d.decision_id += symbol; }
    return output;
  };
  const nvda = variant("NVDA", "a"), amd = variant("AMD", "b"), aapl = variant("AAPL", "c");
  const result = projectStockManualPlans([nvda, amd, aapl], now);
  assert.equal(result.plans.length, 1);
  assert.match(result.blocked_reasons.join(";"), /合计不能超过/);
  const refusal = structuredClone(nvda); refusal.observed_at = iso(1_000); refusal.status = "NO_TRADE"; refusal.decisions[1].action = "NO_TRADE";
  assert.equal(projectStockManualPlans([nvda, refusal], now + 1_000).plans.length, 0, "array order cannot resurrect an older approval");
  refusal.run_id = refusal.slot_id = refusal.evidence.run_id = refusal.evidence.slot_id = "live-shadow:20260909T163000Z";
  assert.equal(projectStockManualPlans([amd, refusal], now + 1_000).plans.length, 0, "a new batch cannot reuse an old other-stock approval");
});

test("stock path does not convert index fallback into an index approval", async () => {
  const output = fixture();
  const snapshot = { outputs: { SCHEDULE_CHECKPOINT: [], OPTION_STRATEGY_SIGNAL: [], STOCK_MANUAL_PLAN: [output] } };
  const result = projectOwnerManualPlans(snapshot, now);
  assert.equal(result.plans.filter((plan) => plan.symbol === "NVDA").length, 1);
  assert.equal(result.plans.filter((plan) => ["SPY", "QQQ"].includes(plan.symbol)).length, 0);
  assert.match(result.blocked_reasons.join(";"), /D\/A3/);
  const source = await readFile(new URL("../server/option-strategy.ts", import.meta.url), "utf8");
  assert.match(source, /for \(const symbol of \["SPY", "QQQ"\] as const\)/);
});

test("new global trust failures revoke a stock card without turning index rejection into a stock veto", () => {
  const output = fixture(), snapshot = { outputs: { SCHEDULE_CHECKPOINT: [], OPTION_STRATEGY_SIGNAL: [], STOCK_MANUAL_PLAN: [output] }, dataSources: [], selfCheck: { active: [] } };
  const count = () => projectOwnerManualPlans(snapshot, now + 1_000).plans.length;
  assert.equal(count(), 1);
  snapshot.dataSources = [{ source: "ROBINHOOD", checked_at: iso(1_000), authorization: "EXPIRED" }];
  assert.equal(count(), 0);
  snapshot.dataSources[0].checked_at = iso(-1_000); assert.equal(count(), 1, "older auth failure cannot cancel a newer verified collection");
  snapshot.dataSources = [{ source: "ROBINHOOD", checked_at: iso(1_000), authorization: "NOT_VERIFIED", status: "DATA_BLOCKED", error: "SPY quote unavailable" }];
  assert.equal(count(), 1, "index-derived NOT_VERIFIED is not proof that independently collected stock data lost authorization");
  snapshot.dataSources[0].authorization = "NOT_CONFIGURED"; assert.equal(count(), 0);
  snapshot.dataSources = [];
  for (const code of ["SQLITE_READ_WRITE_FAILED", "UTC_STORAGE_MISALIGNED", "DEPLOYMENT_VERSION_UNKNOWN", "DEPLOYMENT_VERSION_DRIFT"]) {
    snapshot.selfCheck.active = [{ code, status: "ACTIVE", last_seen_at: iso(1_000), title: "Synthetic global failure", details: {} }];
    assert.equal(count(), 0);
    snapshot.selfCheck.active[0].details.evidence_scope = "HISTORICAL"; assert.equal(count(), 1);
  }
  snapshot.selfCheck.active = [{ code: "TS_CORE_SLOT_INCOMPLETE", status: "ACTIVE", last_seen_at: iso(1_000), title: "Index-only failure", details: {} }];
  assert.equal(count(), 1);
  snapshot.outputs.SCHEDULE_CHECKPOINT = [{ kind: "POSITION_MONITOR", slot_id: "timeline:position_monitor:fixture", status: "FAILED", completed_at: iso(1_000) }];
  assert.equal(count(), 0);
});

test("publication rereads current trust once and cannot publish approval after an auth failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "stock-publish-recheck-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = fixture(), currentRun = "live-shadow:20260909T163000Z";
  output.run_id = output.slot_id = output.evidence.run_id = output.evidence.slot_id = currentRun; seal(output);
  const input = { runId: currentRun, slotId: currentRun, a1: { observed_at: at, market_sources: { snapshot_id: "fixture-a1", snapshot_hash: "b".repeat(64), status: "LIVE", quotes: [], bars: [], options: [], account: { positions: [] }, market_session: { market_date: "2026-09-09", state: "REGULAR" }, approved_capabilities: { fixed_pool: { candidates: [] } } } }, a2: {}, context: {} };
  const published = []; let reads = 0;
  const runtime = createStockManualRuntime({ projectRoot: directory, dataRoot: directory, activatedAt: new Date("2026-09-09T16:29:00Z"), now: () => new Date(iso(1_000)),
    session: async (_options, fn) => fn({}), collect: async () => [output.evidence],
    review: async () => ({ status: "REVIEWED", d: output.decisions[0], a3: output.decisions[1], reason: "Completed independent synthetic reviews" }),
    readCurrent: async () => { reads++; return { dataSources: [{ source: "FINNHUB", authorization: "EXPIRED", checked_at: iso(1_000) }], selfCheck: { active: [] }, outputs: { SCHEDULE_CHECKPOINT: [] } }; },
    publish: (raw) => published.push(JSON.parse(raw)),
  });
  await runtime(input);
  assert.equal(reads, 1); assert.equal(published.length, 1); assert.equal(published[0].payload.status, "DATA_BLOCKED");
  assert.match(published[0].payload.blocked_reasons.join(";"), /FINNHUB最新授权/);
});

test("stock storage accepts only the local producer with exact evidence and same-slot A1 anchor; history is untouched", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "stock-storage-")), file = join(directory, "fixture.sqlite");
  const store = openSnapshotDatabase(file), db = new DatabaseSync(file);
  t.after(async () => { db.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const output = seal(fixture()), raw = envelope(output), e = output.evidence;
  const anchorPayload = { observed_at: at, market_sources: { snapshot_id: e.source_snapshot_id, snapshot_hash: e.source_snapshot_hash } };
  const anchor = JSON.stringify({ payload: anchorPayload });
  db.prepare("INSERT INTO output_records (record_id,output_type,channel,observed_at,received_at,payload_json,raw_json,raw_sha256) VALUES (?,?,?,?,?,?,?,?)")
    .run(`${run}:A1`, "A1_SHADOW_RESULT", "SHADOW", at, at, JSON.stringify(anchorPayload), anchor, createHash("sha256").update(anchor).digest("hex"));
  const histories = ["output_records", "snapshots", "ts_forecast_archive", "ts_forecast_settlements", "option_advice_settlements", "approved_capability_snapshots", "complaint_history"];
  const counts = () => histories.map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]);
  const before = counts(), stockCount = () => db.prepare("SELECT COUNT(*) AS n FROM stock_manual_plans").get().n;
  assert.deepEqual(parseOutputEnvelope(raw).payload, output);
  assert.throws(() => store.importOutputRaw(raw), { code: "NOT_SUPPORTED" });
  assert.equal(stockCount(), 0); assert.deepEqual(counts(), before);
  assert.equal(store.importOutputRaw(raw, at, true, true).duplicate, false);
  assert.equal(stockCount(), 1);
  assert.deepEqual(store.getActive().outputs.STOCK_MANUAL_PLAN, [output]);
  assert.equal(store.getOutputRaw(`${run}:A1`), anchor);
  assert.equal(store.importOutputRaw(raw, at, true, true).duplicate, true);
  const badId = structuredClone(output); badId.evidence.evidence_id = "c".repeat(64); badId.decisions.forEach((decision) => { decision.evidence_id = badId.evidence.evidence_id; });
  assert.throws(() => store.importOutputRaw(envelope(badId), at, true, true), { code: "INVALID_FORMAT" });
  const wrongAnchor = structuredClone(output); wrongAnchor.evidence.source_snapshot_hash = "d".repeat(64); seal(wrongAnchor);
  assert.throws(() => store.importOutputRaw(envelope(wrongAnchor), at, true, true), { code: "INVALID_FORMAT" });
  assert.equal(stockCount(), 1); assert.deepEqual(counts(), before);
  assert.equal(store.getOutputRaw(`${run}:A1`), anchor);
  assert.equal(store.getOutputRaw(`${run}:STOCK:NVDA`), raw);
});

test("real companion success reason stays informational; one failed review does not block other stock plans or repeat collection", async (t) => {
  for (const symbols of [["NVDA"], ["NVDA", "AMD", "AAPL"]]) {
    const directory = await mkdtemp(join(tmpdir(), "stock-approved-runtime-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const currentRun = "live-shadow:20260909T163000Z";
    const outputs = symbols.map((symbol) => {
      const output = JSON.parse(JSON.stringify(fixture()).replaceAll("NVDA", symbol));
      output.run_id = output.slot_id = output.evidence.run_id = output.evidence.slot_id = currentRun;
      output.evidence.contracts[0].contract_id = `fixture-${symbol}`;
      output.decisions.forEach((decision) => { decision.contract_id = `fixture-${symbol}`; decision.decision_id += symbol; decision.invocation_id += symbol; });
      return seal(output);
    });
    const input = { runId: currentRun, slotId: currentRun, a1: { observed_at: at, market_sources: { snapshot_id: "fixture-a1", snapshot_hash: "b".repeat(64), status: "LIVE", quotes: [], bars: [], options: [], account: { positions: [] }, market_session: { market_date: "2026-09-09", state: "REGULAR" }, approved_capabilities: { fixed_pool: { candidates: [] } } } }, a2: {}, context: {} };
    const published = []; let collects = 0, reviews = 0;
    const runtime = createStockManualRuntime({ projectRoot: directory, dataRoot: directory, activatedAt: new Date("2026-09-09T16:29:00Z"), now: () => new Date(at),
      session: async (options, fn) => { assert.ok(options.allowlist.every((tool) => tool.startsWith("get_"))); return fn({}); },
      collect: async () => { collects++; return outputs.map((output) => output.evidence); },
      review: async ({ evidence }) => {
        reviews++; if (evidence.symbol === "AMD") throw new Error("Synthetic independent reviewer failure");
        const output = outputs.find((row) => row.evidence.symbol === evidence.symbol);
        return { status: "REVIEWED", d: output.decisions[0], a3: output.decisions[1], evidence_id: evidence.evidence_id, archive_ref: "fixture-review", reason: "独立 D 与 A3 审阅完成，仍须通过当前报价和账户的确定性门禁" };
      }, publish: (raw) => published.push(raw),
    });
    await runtime(input);
    const results = published.map((raw) => parseOutputEnvelope(raw).payload);
    const approved = results.filter((output) => output.status === "APPROVED");
    assert.deepEqual(approved.map((output) => output.evidence.symbol), symbols.filter((symbol) => symbol !== "AMD"));
    approved.forEach((output) => assert.deepEqual(output.blocked_reasons, []));
    const blocked = results.filter((output) => output.status === "DATA_BLOCKED");
    assert.equal(blocked.length, symbols.includes("AMD") ? 1 : 0);
    if (blocked.length) assert.match(blocked[0].blocked_reasons.join(";"), /独立复核失败/);
    const snapshot = { outputs: { SCHEDULE_CHECKPOINT: [], OPTION_STRATEGY_SIGNAL: [], STOCK_MANUAL_PLAN: results } };
    assert.deepEqual(projectOwnerManualPlans(snapshot, now).plans.map((plan) => plan.symbol), symbols.filter((symbol) => symbol !== "AMD"));
    await runtime(input);
    assert.equal(collects, 1); assert.equal(reviews, symbols.length); assert.equal(published.length, symbols.length * 2);
  }
});
