import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createStockManualRuntime } from "../server/stock-manual-runtime.ts";
import { reviewStockPlan } from "../server/stock-plan-review.ts";
import { canonicalJson } from "../server/robinhood-mcp.ts";

test("stock companion uses fresh bounded read-only lane once; empty/failed results are not approvals", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "stock-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const at = new Date("2026-09-09T15:00:35Z"), published = [], tools = [];
  let collects = 0, reviews = 0;
  const input = { runId: "live-shadow:20260909T150000Z", slotId: "live-shadow:20260909T150000Z",
    a1: { observed_at: at.toISOString(), market_sources: { snapshot_id: "market-test", snapshot_hash: "a".repeat(64), status: "STALE", quotes: [], bars: [], options: [], account: { positions: [] }, market_session: { market_date: "2026-09-09", state: "REGULAR" }, approved_capabilities: { fixed_pool: { candidates: [] } } } }, a2: null, context: {} };
  input.a1.official_macro = { events: [{ category: "inflation", release_name: "Synthetic major event", scheduled_at: "2026-09-09T15:30:00Z" }] };
  const runtime = createStockManualRuntime({ projectRoot: directory, dataRoot: directory, activatedAt: new Date("2026-09-09T14:59:00Z"), now: () => at,
    publish: (raw) => published.push(raw), collect: async (_session, input) => {
      collects++; assert.deepEqual(input.global_risk.critical_blockers, [], "index data gaps do not veto independently collected stock evidence");
      assert.equal(input.global_risk.new_entry_blockers.length, 1, "global major-event entry block remains enforced"); return [];
    }, review: async () => { reviews++; throw new Error("Must not call model for absent evidence"); },
    session: async (options, fn) => { tools.push(...options.allowlist); assert.equal(options.timeoutMs, 30_000); return fn({}); },
  });
  await Promise.all([runtime(input), runtime(input)]); await runtime(input);
  assert.equal(collects, 1); assert.equal(reviews, 0); assert.equal(published.length, 0);
  assert.ok(tools.every((tool) => tool.startsWith("get_")));
  const journal = JSON.parse(await readFile(join(directory, "stock-manual-plans", "live-shadow-20260909T150000Z", "result.json"), "utf8"));
  assert.equal(journal.outcome, "NO_CANDIDATE"); assert.deepEqual(journal.envelopes, []);
  await runtime({ ...input, runId: "replay-shadow:20260909T150000Z", slotId: "replay-shadow:20260909T150000Z" });
  await runtime({ ...input, runId: "live-shadow:20260909T143000Z", slotId: "live-shadow:20260909T143000Z" });
  assert.equal(collects, 1, "no pre-deployment backfill or replay");
});

test("stock news uses the existing unexpired verified chain, not the archived event label", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "stock-news-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const at = new Date("2026-09-09T18:30:35Z"); let news;
  const event = { kind: "NEWS", source_url: "https://example.com/test", published_at: "2026-09-09T12:00:00Z", event_evidence_state: "VERIFIED", importance: "MARKET_MOVING", title: "Synthetic news expiry regression", source: "OFFICIAL", affected_symbols: ["NVDA"] };
  const input = { runId: "live-shadow:20260909T183000Z", slotId: "live-shadow:20260909T183000Z",
    a1: { observed_at: at.toISOString(), market_sources: { snapshot_id: "market-test", snapshot_hash: "a".repeat(64), status: "LIVE", quotes: [], bars: [], options: [], account: { positions: [] }, market_session: { market_date: "2026-09-09", state: "REGULAR" }, approved_capabilities: { fixed_pool: { candidates: [] } } } }, a2: {},
    context: { dataSources: [{ source: "FINNHUB", status: "LIVE", authorization: "VALID", checked_at: at.toISOString() }], marketIntelligence: {
      events: ["expired", "valid", "missing", "unverified"].map((id) => ({ ...event, event_id: id, event_fingerprint: id })),
      causalChains: [{ event_fingerprint: "expired", event_evidence_state: "VERIFIED", expires_at: "2026-09-09T18:00:00Z" }, { event_fingerprint: "valid", event_evidence_state: "VERIFIED", expires_at: "2026-09-09T19:00:00Z" }, { event_fingerprint: "unverified", event_evidence_state: "PARTIAL", expires_at: "2026-09-09T19:00:00Z" }],
    } },
  };
  const runtime = createStockManualRuntime({ projectRoot: directory, dataRoot: directory, activatedAt: new Date(at.getTime() - 60_000), now: () => at,
    publish: () => assert.fail("No synthetic approval"), collect: async (_session, input) => { news = input.news; return []; }, session: async (_options, fn) => fn({}),
  });
  await runtime(input);
  assert.equal(news.status, "LIVE");
  assert.deepEqual(news.items.map(({ id, verified, market_moving }) => [id, verified, market_moving]), [["expired", false, false], ["valid", true, true], ["missing", false, false], ["unverified", false, false]]);
  assert.equal(news.items[0].expires_at, null); assert.equal(news.items[1].expires_at, "2026-09-09T19:00:00Z");
});

const planAt = "2026-09-09T14:00:35.000Z", planRun = "live-shadow:20260909T140000Z";
function earlyEvidence() {
  const bars = Array.from({ length: 3 }, (_, index) => ({ begins_at: new Date(Date.parse("2026-09-09T13:45:00Z") + index * 300_000).toISOString(), open: 349, high: 350, low: 348, close: 349.5, volume: 100 }));
  return {
    contract_version: "stock-plan-v2", run_id: planRun, slot_id: planRun, source_mode: "LIVE", mode: "SHADOW", automated_execution: false,
    observed_at: planAt, received_at: planAt, source_snapshot_id: "fixture-early-plan", source_snapshot_hash: "a".repeat(64), symbol: "TSLA", instrument_type: "EQUITY", direction: "BULLISH",
    quote: { source: "ROBINHOOD", symbol: "TSLA", status: "LIVE", last: 350, bid: 349.99, ask: 350.01, as_of: planAt },
    bars: { source: "ROBINHOOD", symbol: "TSLA", interval: "5min", as_of: "2026-09-09T14:00:00Z", values: bars }, pattern: null,
    contracts: [{ contract_id: "tsla-350-call", option_type: "call", expiration: "2026-10-16", strike: 350, bid: 1.95, ask: 2, mark: 1.975, volume: 100, open_interest: 200, iv: 0.3, delta: 0.5, gamma: 0.03, theta: -0.05, vega: 0.04, as_of: planAt, history_bars: 0, history_as_of: null,
      instrument: { chain_id: "tsla-chain", chain_symbol: "TSLA", expiration_date: "2026-10-16", strike_price: 350, type: "call", state: "active", tradability: "tradable", trade_value_multiplier: 100 } }],
    account: { source: "ROBINHOOD", status: "LIVE", as_of: planAt, freshness_seconds: 0, account_count: 1, positions: [], orders: null, portfolio_value: 10000, option_value: 0, realized_pnl: 0 },
    news: { checked_at: planAt, status: "LIVE", items: [{ id: "unverified-fixture", headline: "合成未核验消息，不能当成催化已确认", url: "https://example.com/fixture", source: "FIXTURE", published_at: "2026-09-09T13:00:00Z", expires_at: null, verified: false, market_moving: false, symbols: ["TSLA"] }] },
    global_risk: { checked_at: planAt, critical_blockers: [], new_entry_blockers: [] }, data_gaps: [], setup_gaps: ["STOCK_PATTERN_CLASSIFICATION_UNAVAILABLE", "EQUITY_BARS_STALE_OR_INSUFFICIENT"],
    planning_context: { observed_at: planAt, entry_trigger: 351, invalidation_price: 345, target_price: 360, why_watch: ["多周期候选，只等待确认，不代表开仓"],
      timeframes: Object.fromEntries([["daily", "1d"], ["four_hour", "4h"], ["one_hour", "1h"], ["thirty_minute", "30m"]].map(([name, timeframe]) => [name, { timeframe, available: true, pattern: "higher_high_higher_low", state: "breakout_watch", direction: "BULLISH", confidence: 0.8, support: 345, resistance: 351, volume_context: "正常", data_cutoff: planAt, limitation: null }])) },
  };
}
function earlyDecision(role, evidenceId) {
  return { contract_version: "stock-plan-v2", role, evidence_id: evidenceId, action: "CONDITIONAL_PLAN", symbol: "TSLA", contract_id: "tsla-350-call", option_type: "call", expiration: "2026-10-16", strike: 350, quantity: 1, max_entry_debit: 200, stop_loss_pct: -30, take_profit_pct: 50, score: 9,
    entry_trigger_price: 351, invalidation_price: 345, target_price: 360, entry_conditions: ["突破351后完整K线确认，并复核原盘型与新闻门槛"], invalidation: ["跌破345、报价过期或账户风险变化"], holding_period: "按价格失效和止盈止损退出，不预设持有到期", contract_selection_reason: "真实链中该合约预算200美元，期限留给条件确认；没有假设必须末日或波段", reasons: ["合成真实调用边界测试，新闻未核验，不是买入批准"] };
}
async function runEarly(t, fault = "") {
  const directory = await mkdtemp(join(tmpdir(), "stock-conditional-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = earlyEvidence(), published = [], calls = []; let elapsed = 0;
  if (fault.startsWith("early-entry")) {
    value.entry_rule = "MULTI_TIMEFRAME_BREAK_HOLD_V1";
    value.setup_gaps = [];
    value.pattern = { source: "A2_CLASSIFY_PATTERN_V1", regime: "TREND_UP", direction: "bullish" };
    value.bars.values = Array.from({ length: 6 }, (_, index) => ({ begins_at: new Date(Date.parse("2026-09-09T13:30:00Z") + index * 300_000).toISOString(), open: 349, high: 350, low: 348, close: 349.5, volume: 100 }));
    Object.assign(value.bars.values[4], { open: 350, high: 352.4, low: 350, close: 352 });
    Object.assign(value.bars.values[5], { open: 352, high: 352.6, low: 351.1, close: 352.5 });
    Object.assign(value.quote, { last: 352.5, bid: 352.49, ask: 352.51 });
    for (const frame of Object.values(value.planning_context.timeframes)) frame.data_cutoff = "2026-09-08T13:30:00.000Z";
    Object.assign(value.news.items[0], { verified: true, expires_at: "2026-09-09T16:00:00.000Z" });
  }
  if (fault === "stale-quote") value.quote.as_of = "2026-09-09T13:50:00Z";
  if (fault === "missing-contract") value.contracts = [];
  if (fault === "missing-context") value.planning_context = null;
  if (["post-contract-expired", "post-selected-expired"].includes(fault)) value.contracts[0].as_of = new Date(Date.parse(planAt) - 410_000).toISOString();
  if (fault === "post-selected-expired") value.contracts.push({ ...structuredClone(value.contracts[0]), contract_id: "different-fresh-contract", as_of: planAt });
  const ev = { ...value, evidence_id: createHash("sha256").update(canonicalJson(value)).digest("hex") };
  const now = () => new Date(Date.parse(planAt) + elapsed);
  const runtime = createStockManualRuntime({ projectRoot: process.cwd(), dataRoot: directory, activatedAt: new Date("2026-09-09T13:59:00Z"), now,
    publish: (raw) => published.push(JSON.parse(raw)), collect: async () => [ev], session: async (_options, fn) => fn({}),
    readCurrent: async () => {
      if (fault === "post-review-expired") elapsed = 121_000;
      if (["post-contract-expired", "post-selected-expired"].includes(fault)) elapsed = 11_000;
      return { dataSources: fault === "current-auth" ? [{ source: "ROBINHOOD", authorization: "EXPIRED", checked_at: planAt }] : [], selfCheck: { active: [] }, outputs: { SCHEDULE_CHECKPOINT: [] } };
    },
    review: async (options) => reviewStockPlan({ ...options, now, invoke: async (input) => {
      calls.push(input.role);
      if (fault === "single-review" && input.role === "A3") throw Error("STOCK_REVIEW_TIMED_OUT");
      const output = earlyDecision(input.role, ev.evidence_id);
      if (fault.startsWith("early-entry")) output.action = "MANUAL_BUY";
      if (fault === "early-entry-slow-review" && input.role === "A3") elapsed = 121_000;
      if (fault === "refused" && input.role === "A3") output.action = "NO_TRADE";
      return { output, threadId: `isolated-${input.role}`, stdout: "", stderr: "", processTreeClosed: true };
    } }),
  });
  const input = { runId: planRun, slotId: planRun,
    a1: { observed_at: planAt, market_sources: { snapshot_id: "market-test", snapshot_hash: "a".repeat(64), status: "LIVE", quotes: [], bars: [], options: [], account: { positions: [] }, market_session: { market_date: "2026-09-09", state: "REGULAR" }, approved_capabilities: { fixed_pool: { candidates: [] } } } }, a2: {}, context: {} };
  await runtime(input);
  return { runtime, input, ev, published, calls, directory };
}

test("three early bars and untriggered conditions produce a complete independent conditional plan, never a buy approval", async (t) => {
  const result = await runEarly(t);
  assert.deepEqual(result.calls, ["D", "A3"]);
  assert.equal(result.published.length, 1);
  const output = result.published[0].payload;
  assert.equal(output.contract_version, "stock-plan-v2"); assert.equal(output.status, "CONDITIONAL");
  assert.equal(output.evidence.bars.values.length, 3); assert.equal(output.evidence.news.items[0].verified, false);
  assert.equal(output.decisions.length, 2); assert.equal(output.decisions[1].contract_id, "tsla-350-call");
  assert.equal(output.decisions[1].entry_trigger_price, 351); assert.equal(output.decisions[1].invalidation_price, 345); assert.equal(output.decisions[1].target_price, 360);
  assert.equal(output.decisions[1].stop_loss_pct, -30); assert.equal(output.decisions[1].take_profit_pct, 50);
  assert.ok(output.decisions[1].holding_period); assert.ok(output.decisions[1].contract_selection_reason);
  const original = canonicalJson(output);
  await result.runtime(result.input);
  assert.deepEqual(result.calls, ["D", "A3"], "same immutable FULL does not re-review");
  assert.equal(canonicalJson(result.published[1].payload), original);
});

test("early completed-bar proof passes both independent reviews at the existing 07:00 FULL, but cannot outlive the account evidence", async (t) => {
  const approved = await runEarly(t, "early-entry");
  assert.deepEqual(approved.calls, ["D", "A3"]);
  assert.equal(approved.published.length, 1);
  assert.equal(approved.published[0].payload.status, "APPROVED");
  assert.equal(approved.published[0].payload.evidence.bars.values.length, 6, "no 90-minute wait on the explicitly versioned proof");
  assert.equal(approved.published[0].record_id, `${planRun}:STOCK:TSLA`, "reuse the real FULL identity, never manufacture an A1");
  assert.equal(approved.published[0].payload.automated_execution, false);
  const expired = await runEarly(t, "early-entry-slow-review");
  assert.deepEqual(expired.calls, ["D", "A3"]);
  assert.notEqual(expired.published[0].payload.status, "APPROVED", "slow reviews cannot renew evidence timestamps");
});

test("conditional runtime blocks incomplete data, single/refused reviews and current authorization failure", async (t) => {
  for (const fault of ["stale-quote", "missing-contract", "missing-context", "single-review", "refused", "current-auth", "post-review-expired", "post-contract-expired", "post-selected-expired"]) await t.test(fault, async (st) => {
    const result = await runEarly(st, fault), output = result.published[0].payload;
    assert.ok(!["APPROVED", "CONDITIONAL"].includes(output.status));
    if (["stale-quote", "missing-contract", "missing-context"].includes(fault)) { assert.deepEqual(result.calls, []); assert.equal(output.decisions.length, 0); }
    if (fault === "single-review") { assert.deepEqual(result.calls, ["D", "A3"]); assert.equal(output.decisions.length, 1); }
    if (fault === "current-auth") assert.match(output.blocked_reasons.join("；"), /最新授权/);
  });
});
