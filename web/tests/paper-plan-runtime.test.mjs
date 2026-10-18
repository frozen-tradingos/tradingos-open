import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { utcForPt } from "../app/timeline-schedule.ts";
import { createPaperPlanRuntime } from "../server/paper-plan-runtime.ts";
import { canonicalJson } from "../server/robinhood-mcp.ts";
import { buildPaperPlan, PAPER_DAILY_TARGET, paperChartComparison, paperPlanId, paperTrackingWindow, projectPaperLearning, projectPaperPlans, projectPaperTracking, validatePaperEvent } from "../app/paper-plan.ts";
import { makePaperEvent, openPaperPlanStore } from "../server/paper-plan-store.ts";
import { capturePaperQuoteEvidence, collectPaperCharts } from "../server/paper-quote-evidence.ts";
import { paperCodexQualifiedActive } from "../app/paper-selection.ts";
import { createPaperCodexSelector } from "../server/paper-codex-selection.ts";
import { voidOriginalPaperPlans } from "../scripts/reselect-paper-plans.ts";

const opening = "2026-09-10T14:00:45.000Z", sourceAt = "2026-09-09T20:00:00.000Z", sourceHash = "a".repeat(64);
function evidence(at = opening, symbol = "NVDA") {
  const start=utcForPt(at.slice(0,10), "06:30").getTime(), count=Math.max(0,Math.min(78,Math.floor((Date.parse(at)-start-30_000)/300_000)));
  const bars=Array.from({length:count},(_,i)=>{const values=i===count-2?[150,152,149.5,151.5]:i===count-1?[151.5,153,151,152]:[149,150,148,149.5];const [open,high,low,close]=values;return {begins_at:new Date(start+i*300_000).toISOString(),open,high,low,close,volume:100};});
  const row = {
    contract_version: "stock-plan-v2", entry_rule: "MULTI_TIMEFRAME_BREAK_HOLD_V1", run_id: "paper-check:20260910T133000Z", slot_id: "paper-check:20260910T133000Z", source_mode: "LIVE", mode: "SHADOW", automated_execution: false,
    observed_at: at, received_at: at, source_snapshot_id: "source-fixture", source_snapshot_hash: sourceHash, symbol, instrument_type: "EQUITY", direction: "BULLISH",
    quote: { source: "ROBINHOOD", symbol, status: "LIVE", last: 152, bid: 151.99, ask: 152.01, as_of: at },
    bars: { source: "ROBINHOOD", symbol, interval: "5min", as_of: count ? new Date(start+count*300_000).toISOString() : null, values: bars }, pattern: {source:"A2_CLASSIFY_PATTERN_V1",regime:"TREND_UP",direction:"bullish"},
    contracts: [{ contract_id: `00000000-0000-4000-8000-${String(["NVDA", "AAPL", "TSLA"].indexOf(symbol) + 1).padStart(12, "0")}`, option_type: "call", expiration: "2026-09-18", strike: 150, bid: 1.91, ask: 2, mark: 1.95, volume: 100, open_interest: 500, iv: 0.3, delta: 0.5, gamma: 0.02, theta: -0.1, vega: 0.04, as_of: at, history_bars: 0, history_as_of: null,
      instrument: { chain_id: "22222222-2222-4222-8222-222222222222", chain_symbol: symbol, expiration_date: "2026-09-18", strike_price: 150, type: "call", state: "active", tradability: "tradable", trade_value_multiplier: 100 } }],
    account: { source: "ROBINHOOD", status: "DATA_BLOCKED", as_of: null, freshness_seconds: null, account_count: null, positions: null, orders: null, portfolio_value: null, option_value: null, realized_pnl: null },
    news: { checked_at: sourceAt, status: "DATA_BLOCKED", items: [] }, global_risk: { checked_at: at, critical_blockers: [], new_entry_blockers: [] },
    data_gaps: ["ACCOUNT_NOT_CURRENT", "NEWS_UNAVAILABLE"], setup_gaps: [],
    planning_context: { observed_at: sourceAt, entry_trigger: 151, invalidation_price: 145, target_price: 160, why_watch: ["上一完整交易日上涨结构；仅作规则学习，不是正式入场"],
      timeframes: Object.fromEntries([["daily", "1d"], ["four_hour", "4h"], ["one_hour", "1h"], ["thirty_minute", "30m"]].map(([key, timeframe]) => [key, { timeframe, available: true, pattern: "higher_high_higher_low", state: "breakout_watch", direction: "BULLISH", confidence: 0.7, support: 145, resistance: 151, volume_context: "正常", data_cutoff: key === "daily" ? "2026-09-08T00:00:00.000Z" : "2026-09-09T13:30:00.000Z", limitation: null }])) },
  };
  return { ...row, evidence_id: createHash("sha256").update(canonicalJson(row)).digest("hex") };
}
function snapshot() {
  return { investmentKernel: { profile_mode: "OWNER", execution_mode: "SHADOW", broker_access: "READ_ONLY", automated_execution: false },
    macroEventLearning: { entry_special_days: [] },
    outputs: { A1_SHADOW_RESULT: {source_mode:"LIVE",observed_at:opening,market_sources:{status:"LIVE",generated_at:opening,as_of:opening,quotes:[],bars:[],options:[],account:{positions:[]},market_session:{market_date:"2026-09-10",state:"REGULAR"}}} }, dataSources: [], selfCheck: { active: [] }, marketIntelligence: { events: [], causalChains: [] },
    marketRadar: { source_record_id: "live-shadow:20260909T190000Z:A1", market_snapshot_id: "source-fixture", market_snapshot_hash: sourceHash,
      snapshot: { source: "ROBINHOOD_OFFICIAL_TRADING_MCP", mode: "SHADOW", actionable: false, generated_at: sourceAt, fixed_pool: { candidates: ["NVDA"], rows: [] } } } };
}
function harness(symbols = ["NVDA"]) {
  const events = [], sessions = [], collected = [], quoteCalls = [];
  let at = opening, state = snapshot(), collectRows = () => symbols.map((symbol) => evidence(at, symbol)), readFailure = false, quoteFailure = false, quoteOverride = {};
  let selector = async (input) => ({ version: paperCodexQualifiedActive(at) ? "CODEX_PAPER_SELECTION_V2" : "CODEX_PAPER_SELECTION_V1", kind: "RULE_FALLBACK", market_date: at.slice(0, 10), decision_id: `paper-selection:${at.slice(0, 10)}`, requested_at: at, completed_at: at, reason: "SYNTHETIC_TEST_FALLBACK_NO_MODEL", input_hash: "b".repeat(64), input_snapshot_id: input.id, input_snapshot_hash: input.hash, invocation_id: null, thread_id: null, model: null, cli_version: null, output_hash: null, candidates: [] });
  const rawInstruments = new Map(), rawQuotes = new Map();
  const session = { async call(tool, args) {
    const data = tool === "get_option_instruments" ? { instruments: [...rawInstruments.values()].filter((row) => row.chain_symbol === args.chain_symbol && row.expiration_date === args.expiration_dates) }
      : tool === "get_option_quotes" ? { results: args.instrument_ids.map((id) => ({ quote: rawQuotes.get(id) })) } : { results: [] };
    return { content: [], structuredContent: { data: structuredClone(data) } };
  } };
  async function captureFixture(target, row, quote = row) {
    rawInstruments.set(row.contract_id, { ...row.instrument, id: row.contract_id, underlying_type: "equity" });
    rawQuotes.set(row.contract_id, { instrument_id: row.contract_id, bid_price: String(quote.bid), ask_price: String(quote.ask), mark_price: String(quote.mark), updated_at: quote.quoted_at ?? quote.as_of });
    await target.call("get_option_instruments", { chain_symbol: row.instrument.chain_symbol, expiration_dates: row.expiration });
    await target.call("get_option_quotes", { instrument_ids: [row.contract_id] });
  }
  const store = {
    appendPaperPlanEvent(event) {
      if (events.some((item) => item.event_id === event.event_id)) return { duplicate: true };
      const plan = events.find((item) => item.plan_id === event.plan_id && item.event_type === "CREATED")?.payload.plan ?? null;
      validatePaperEvent(event, plan); events.push(event); return { duplicate: false };
    },
    getPaperPlanEvents: (id) => events.filter((item) => item.plan_id === id),
    getActivePaperPlans: () => events.filter((item) => item.event_type === "CREATED" && !events.some((ended) => ended.plan_id === item.plan_id && ended.event_type === "ENDED"))
      .sort((left, right) => events.findLastIndex((item) => item.plan_id === left.plan_id) - events.findLastIndex((item) => item.plan_id === right.plan_id)).map((item) => item.payload.plan),
  };
  const options = { projectRoot: process.cwd(), dataRoot: join(tmpdir(), "paper-runtime-synthetic-no-writes"), store, now: () => new Date(at), select: (input) => selector(input),
    readCurrent: async () => { if (readFailure) throw Error("fixture failure"); return state; },
    session: async (input, callback) => { sessions.push(input); assert.ok(input.allowlist.every((name) => name.startsWith("get_"))); return callback(session); },
    collect: async (session, input) => { collected.push(input); const values = await collectRows(input); for (const row of values) for (const contract of row.contracts) await captureFixture(session, contract); return values; },
    quote: async (session, filter) => {
      quoteCalls.push(filter); if (quoteFailure) throw Error("fixture quote failure");
      const contract = evidence(at, filter.symbol).contracts[0], quote = { contract_id: contract.contract_id, bid: 2.6, ask: 2.7, mark: 2.65, quoted_at: at, received_at: at, ...quoteOverride };
      contract.expiration = contract.instrument.expiration_date = filter.expiration;
      await captureFixture(session, contract, quote); return quote;
    },
  };
  return { events, sessions, collected, quoteCalls, session, store, options, runtime: createPaperPlanRuntime(options),
    setAt(value) { at = value; }, setState(value) { state = value; }, setCollect(value) { collectRows = value; }, setSelect(value) { selector = value; }, failRead() { readFailure = true; }, failQuote() { quoteFailure = true; }, overrideQuote(value) { quoteOverride = value; } };
}

function riskSnapshot(at) {
  const state = snapshot();
  state.dataSources = [{ source: "FINNHUB", status: "LIVE", authorization: "VALID", checked_at: at, as_of: at, capabilities: { news: true, earnings_calendar: true } }];
  return state;
}
function earningsSnapshot(at, date = "2026-09-10", session = "AMC") {
  const state = riskSnapshot(at);
  state.marketIntelligence.events = [{ event_id: "earnings-current", kind: "EARNINGS", title: "NVDA 财报日历", source: "Finnhub Earnings Calendar", source_url: null, published_at: null,
    scheduled_for: date, fetched_at: "2026-09-09T15:00:00.000Z", affected_symbols: ["NVDA"], event_type: "earnings", earnings_result: { reported: false, session } }];
  state.marketIntelligence.currentEarnings = state.marketIntelligence.events;
  state.marketIntelligence.earningsCalendar = { checked_at: at, response_received_at: at, event_ids: ["earnings-current"] };
  return state;
}

const specialDay = { market_date: "2026-09-10", label: "FOMC 议息日", release_name: "FOMC Meeting Decision", scheduled_at: "2026-09-10T12:00:00Z", time_precision: "DATE_ONLY", confidence: "official_schedule",
  source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", source_record_id: "live-shadow:20260909T200000Z:A1", observed_at: sourceAt, received_at: "2026-09-09T20:00:20Z", as_of: sourceAt };

test("rule fallback freezes isolated night background and later natural MARKs never backfill or alter the first result", async (t) => {
  const sample = JSON.parse(await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8")).contracts.TS_OUTPUT[0];
  for (const mode of ["available", "late", "read failure", "future"]) await t.test(mode, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "paper-night-background-synthetic-")); t.after(() => rm(directory, { recursive: true, force: true }));
    const h = harness(), stamp = "2026-10-01T13:45:45.000Z", later = "2026-10-01T14:00:45.000Z", previous = "2026-09-30T20:00:00Z", state = snapshot();
    state.marketRadar.snapshot.generated_at = previous; h.setState(state); h.setAt(stamp); h.options.dataRoot = directory;
    const symbols = ["SPY", "NVDA", "AAPL"];
    h.setCollect(() => symbols.map((symbol) => {
      const e = evidence(stamp, symbol), c = e.contracts[0]; e.planning_context.observed_at = previous;
      c.expiration = c.instrument.expiration_date = "2026-10-16";
      const body = { ...e }; delete body.evidence_id; return { ...body, evidence_id: createHash("sha256").update(canonicalJson(body)).digest("hex") };
    }));
    const output = JSON.parse(JSON.stringify(sample).replaceAll("2026-07-29", "2026-09-30").replaceAll("20260729", "20260930"));
    output.report_type = "NEXT_SESSION"; output.evidence_snapshot.market_time.observed_at = "2026-09-30T18:00:18-07:00"; output.evidence_snapshot.market_time.state = "CLOSED";
    output.forecast_window = { horizon: "NEXT_REGULAR_SESSION", start_at: output.evidence_snapshot.market_time.observed_at, end_at: null, end_condition: "NEXT_REGULAR_SESSION_CLOSE" };
    output.next_validation.at = "2026-10-01T06:30:00-07:00"; output.symbol_outlooks.SPY.direction = "BEARISH"; output.symbol_outlooks.SPY.summary = "合成原夜盘判断：压力位下等待回落。";
    const raw = JSON.stringify(output), run = "live-shadow:20261001T010000Z", row = { slot_id: run, run_id: run, forecast_id: output.evidence_snapshot.run_id, delivery_record_id: `${run}:TS`, received_at: "2026-10-01T01:00:20Z", delivered_at: "2026-10-01T01:00:30Z", payload_json: raw, forecast_hash: createHash("sha256").update(raw).digest("hex") };
    if (mode === "late") { row.received_at = "2026-10-01T13:59:20Z"; row.delivered_at = "2026-10-01T14:00:30Z"; }
    if (mode === "future") row.delivered_at = "2026-10-01T14:02:00Z";
    const reads = [];
    h.store.getPaperForecastContext = (at, scope) => {
      reads.push([at, scope]); if (scope !== "NEXT_SESSION_BACKGROUND") return [];
      if (mode === "read failure") throw Error("synthetic background archive unavailable");
      return mode === "late" && at === stamp ? [] : [row];
    };
    let calls = 0; h.setSelect(async (input) => { calls++; return { version: "CODEX_PAPER_SELECTION_V2", kind: "RULE_FALLBACK", market_date: "2026-10-01", decision_id: "paper-selection:2026-10-01", requested_at: stamp, completed_at: stamp, reason: "INDEX_RESEARCH_PARTIAL_POOL：synthetic insufficient pool; no model", input_hash: "b".repeat(64), input_snapshot_id: input.id, input_snapshot_hash: input.hash, invocation_id: null, thread_id: null, model: null, cli_version: null, output_hash: null, candidates: [] }; });
    const runtime = createPaperPlanRuntime(h.options), result = await runtime.runOnce(); assert.equal(result.created, 3); assert.equal(calls, 1);
    const origin = h.events.find((event) => event.event_type === "CREATED" && event.payload.plan.symbol === "SPY"), original = JSON.stringify(origin), plan = origin.payload.plan;
    assert.equal(plan.selection_source.kind, "RULE_FALLBACK"); assert.equal(plan.formal_forecast_review.context_status, "MISSING");
    assert.equal(plan.next_session_forecast_review.scope, "NEXT_SESSION_BACKGROUND"); assert.equal(plan.next_session_forecast_review.status, mode === "available" ? "CONFLICT" : "UNAVAILABLE");
    assert.equal(plan.next_session_forecast_review.context_status, mode === "available" ? "AVAILABLE" : mode === "late" ? "MISSING" : "INVALID");
    assert.equal(plan.reference.proof.received_at, stamp); assert.equal(plan.automated_execution, false); assert.equal(plan.stop_loss_pct, -40); assert.equal(plan.take_profit_pct, 30);
    assert.deepEqual(reads.map((r) => r[1]), ["INTRADAY", "NEXT_SESSION_BACKGROUND"], "each scope is independently cached once for all three samples");
    h.setAt(later); h.setCollect(() => []); await runtime.runOnce();
    const mark = h.events.findLast((event) => event.plan_id === plan.plan_id && event.event_type === "MARK"); assert.ok(mark);
    assert.equal(mark.payload.formal_forecast_review.context_status, "MISSING"); assert.equal(mark.payload.next_session_forecast_review.status, ["available", "late"].includes(mode) ? "CONFLICT" : "UNAVAILABLE");
    assert.equal(JSON.stringify(origin), original); assert.equal(h.events.filter((e) => e.event_type === "CREATED").length, 3); assert.equal(calls, 1);
    const first = structuredClone(projectPaperLearning(h.events).recent_results.find((r) => r.plan_id === plan.plan_id));
    h.overrideQuote({ bid: 1, ask: 1.1 }); h.setAt("2026-10-01T14:15:45.000Z"); await runtime.runOnce();
    assert.deepEqual(projectPaperLearning(h.events).recent_results.find((r) => r.plan_id === plan.plan_id), first);
    assert.equal(projectPaperPlans(h.events, "2026-10-01T14:15:45.000Z").plans.find((r) => r.plan.plan_id === plan.plan_id).latest_next_session_forecast_review.scope, "NEXT_SESSION_BACKGROUND");
  });
});

test("one index research slot survives ETF quote rejection, keeps two equities independent and recovers idempotently", async (t) => {
  for (const failure of ["spread", "proof", "real selector with only two equities"]) await t.test(failure, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-index-slot-synthetic-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const h = harness(), stamp = "2026-10-01T13:45:45.000Z", previous = "2026-09-30T20:00:00.000Z", state = snapshot();
  state.marketRadar.snapshot.generated_at = previous; h.setState(state); h.setAt(stamp); h.options.dataRoot = directory;
  const symbols = ["SPY", "QQQ", "NVDA", "AAPL", "TSLA"];
  const make = (symbol, at = stamp, badSpread = false) => {
    const e = evidence(at, symbol), c = e.contracts[0];
    e.planning_context.observed_at = previous;
    for (const frame of Object.values(e.planning_context.timeframes)) frame.data_cutoff = previous;
    c.contract_id = `00000000-0000-4000-8000-${String(symbols.indexOf(symbol) + 1).padStart(12, "0")}`;
    c.expiration = c.instrument.expiration_date = "2026-10-16"; if (badSpread) c.bid = 1;
    const body = { ...e }; delete body.evidence_id; e.evidence_id = createHash("sha256").update(canonicalJson(body)).digest("hex"); return e;
  };
  h.setCollect(() => [make("SPY", stamp, failure !== "proof"), make("NVDA"), make("AAPL"), ...(failure === "real selector with only two equities" ? [] : [make("TSLA")])]);
  let modelCalls = 0;
  if (failure === "real selector with only two equities") {
    state.marketRadar.snapshot.fixed_pool.rows = symbols.map((symbol) => ({ symbol, status: "MARKET_CLOSED", as_of: previous, last: 152, change_pct: 1, timeframes: make(symbol).planning_context.timeframes,
      swing: { direction: "BULLISH", stage: "CONFIRMED", why_watch: ["synthetic archived context"], missing_confirmation: [] } }));
    h.setSelect(createPaperCodexSelector({ projectRoot: process.cwd(), dataRoot: directory, now: h.options.now, invoke: async () => { modelCalls++; throw Error("No model permitted for this insufficient pool"); } }));
  }
  if (failure === "proof") {
    const originalSession = h.options.session;
    h.options.session = (input, callback) => originalSession(input, (session) => callback({ ...session, call: async (tool, args) => {
      const response = await session.call(tool, args);
      if (tool === "get_option_instruments" && args.chain_symbol === "SPY") response.structuredContent.data.instruments = [];
      return response;
    } }));
  }
  const runtime = createPaperPlanRuntime(h.options), first = await runtime.runOnce();
  assert.equal(first.created, 2, "bad index spread must not prevent the two ordinary slots");
  const created = () => h.events.filter((event) => event.event_type === "CREATED").map((event) => event.payload.plan);
  assert.deepEqual(created().map((plan) => [plan.plan_id, plan.symbol]), [["paper-plan:2026-10-01:2", "NVDA"], ["paper-plan:2026-10-01:3", "AAPL"]]);
  assert.ok(h.events.some((event) => event.plan_id === "paper-plan:2026-10-01" && event.event_type === "ATTEMPT" && event.payload.reasons.some((reason) => /价差|SPREAD|QUOTE_PROOF_MISSING/.test(reason))));
  assert.equal(buildPaperPlan([make("TSLA")], stamp, 1, []).plan, null, "a third equity cannot take the reserved slot");
  assert.equal(buildPaperPlan([make("QQQ")], stamp, 2, []).plan, null, "a second ETF cannot take an equity slot");
  const next = "2026-10-01T14:00:45.000Z"; h.setAt(next);
  h.setCollect((input) => { assert.equal(input.paperIndexOnly, true); return [make("QQQ", next)]; });
  assert.equal((await runtime.runOnce()).created, 1);
  const index = created().find((plan) => plan.symbol === "QQQ");
  assert.equal(index.research_cohort, "INDEX_CONDITIONS_V1"); assert.equal(index.selection_source.kind, "RULE_FALLBACK");
  assert.equal(index.stop_loss_pct, -40); assert.equal(index.take_profit_pct, 30); assert.equal(index.holding_intent.max_trading_days, 3);
  assert.ok(index.reference.proof); assert.equal((await runtime.runOnce()).created, 0); assert.equal(created().length, 3);
  const stats = projectPaperLearning(h.events);
  assert.equal(stats.groups.find((group) => group.dimension === "RESEARCH_COHORT" && group.label === "指数方法研究").stats.total, 1);
  assert.equal(stats.groups.find((group) => group.dimension === "RESEARCH_COHORT" && group.label === "原选股研究").stats.total, 2);
  assert.equal(modelCalls, 0);
  assert.ok(h.collected.filter((input) => input.paperPreflight).length <= 3, "remaining single slot cannot loop through an impossible three-symbol preflight");
  });
});

test("failed preflight expansion retains three qualified stocks for the selector but never bypasses pool count or freshness", async (t) => {
  for (const [name, count, delayMs, expected, auditBlocked] of [["three fresh stocks", 3, 30_000, 3], ["only two stocks", 2, 30_000, 0], ["three expired quotes", 3, 121_000, 0], ["audit write failure", 3, 30_000, 0, true]]) await t.test(name, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "paper-preflight-synthetic-")); t.after(() => rm(directory, { recursive: true, force: true }));
    const h = harness(), stamp = "2026-09-22T13:30:45.000Z", previous = "2026-09-21T20:00:00Z", state = snapshot(), symbols = ["NVDA", "AAPL", "TSLA"];
    const failedAt = new Date(Date.parse(stamp) + delayMs).toISOString(), completed = new Date(Date.parse(failedAt) + 20_000).toISOString();
    state.marketRadar.snapshot.generated_at = previous;
    state.marketRadar.snapshot.fixed_pool.rows = symbols.map((symbol) => ({ symbol, status: "MARKET_CLOSED", as_of: previous, last: 152, change_pct: 1,
      timeframes: evidence(stamp, symbol).planning_context.timeframes, swing: { direction: "BULLISH", stage: "CONFIRMED", why_watch: ["Synthetic prior-session structure"], missing_confirmation: [] } }));
    h.setState(state); h.setAt(stamp); h.options.dataRoot = directory;
    const make = (symbol, at) => {
      const e = evidence(at, symbol); e.planning_context.observed_at = previous; e.contracts[0].expiration = e.contracts[0].instrument.expiration_date = "2026-10-02";
      const body = { ...e }; delete body.evidence_id; e.evidence_id = createHash("sha256").update(canonicalJson(body)).digest("hex"); return e;
    };
    let modelCalls = 0;
    h.setSelect(createPaperCodexSelector({ projectRoot: process.cwd(), dataRoot: directory, now: h.options.now, cliVersion: () => "synthetic-cli", invoke: async (request) => {
      modelCalls++; const packet = JSON.parse(request.prompt.split("\n\n").at(-1)); assert.equal(packet.qualified_contracts.length, 3);
      h.setAt(completed);
      return { output: { decision_id: packet.decision_id, candidates: packet.qualified_contracts.map((c) => ({ symbol: c.symbol, direction: c.direction, contract_id: c.contract_id, reason: "Synthetic exact choice after failed expansion", evidence_refs: [`stock:${c.symbol}`, c.evidence_ref] })) },
        threadId: "synthetic-thread", stdout: '{"type":"thread.started","thread_id":"synthetic-thread"}\n', stderr: "", processTreeClosed: true };
    } }));
    h.setCollect(async (input) => {
      if (input.paperPreflight && input.paperCandidateOffset === 0) return symbols.slice(0, count).map((symbol) => make(symbol, stamp));
      if (input.paperPreflight) {
        h.setAt(failedAt);
        if (auditBlocked) { const path = join(directory, "not-a-directory"); await writeFile(path, "synthetic audit write blocker", { flag: "wx" }); h.options.dataRoot = path; }
        throw Error("synthetic provider session failure");
      }
      assert.equal(modelCalls, 1); return input.paperSelectedCandidates.map((c) => make(c.symbol, completed));
    });
    const result = await createPaperPlanRuntime(h.options).runOnce();
    assert.equal(result.created, expected); assert.equal(modelCalls, expected ? 1 : 0);
    assert.deepEqual(h.collected.filter((input) => input.paperPreflight).map((input) => input.paperCandidateOffset), [0, 3], "failed expansion adds no third provider batch");
    const journal = join(directory, "paper-selections/2026-09-22"), names = await readdir(journal);
    const audits = await Promise.all(names.filter((name) => name.startsWith("preflight-")).map(async (name) => JSON.parse(await readFile(join(journal, name), "utf8"))));
    assert.equal(audits.length, auditBlocked ? 1 : 2); assert.equal(audits.filter((audit) => audit.collection_failed).length, auditBlocked ? 0 : 1, "only successfully persisted failure audits permit recovery");
    const origins = h.events.filter((event) => event.event_type === "CREATED");
    if (expected) {
      assert.ok(origins.every(({ payload: { plan } }) => plan.selection_source.kind === "CODEX" && plan.reference.proof.requested_at === completed));
    } else {
      assert.ok(h.events.some((event) => event.event_type === "ATTEMPT" && event.payload.reasons.some((reason) => reason.includes("CODEX_QUALIFIED_POOL_WAIT"))));
      for (const name of ["request.json", "invocation.json", "result.json"]) await assert.rejects(readFile(join(journal, name)), { code: "ENOENT" });
      assert.equal(h.collected.length, 2, "unqualified pools cannot trigger entry collection");
    }
  });
});

test("qualified Codex compares a bounded six-stock pool, preserves the exact OTM choice and immediately refreshes alternatives", async () => {
  const h = harness(), stamp = "2026-09-22T13:30:45.000Z", completed = "2026-09-22T13:32:15.000Z", state = snapshot();
  const symbols = ["NVDA", "AAPL", "TSLA", "META", "MSFT", "ARM"];
  state.marketRadar.snapshot.generated_at = "2026-09-21T20:00:00Z";
  state.macroEventLearning.entry_special_days = [{ ...specialDay, market_date: "2026-09-22", scheduled_at: "2026-09-22T12:00:00Z" }];
  h.setState(state); h.setAt(stamp);
  const id = (symbol) => `00000000-0000-4000-8000-${String(symbols.indexOf(symbol) + 10).padStart(12, "0")}`;
  const make = (symbol, at) => {
    const e = evidence(at, symbol); e.planning_context.observed_at = "2026-09-21T20:00:00Z";
    const c = e.contracts[0]; c.contract_id = id(symbol); c.expiration = c.instrument.expiration_date = "2026-10-02";
    c.strike = c.instrument.strike_price = 153; // Above the 152 spot; the model may prefer this qualified OTM contract.
    const body = { ...e }; delete body.evidence_id; e.evidence_id = createHash("sha256").update(canonicalJson(body)).digest("hex"); return e;
  };
  const source = { version: "CODEX_PAPER_SELECTION_V2", kind: "CODEX", market_date: "2026-09-22", decision_id: "paper-selection:2026-09-22", requested_at: stamp, completed_at: completed, reason: "SYNTHETIC_EXACT_CONTRACT_SELECTION", input_hash: "b".repeat(64), input_snapshot_id: "source-fixture", input_snapshot_hash: sourceHash, invocation_id: "synthetic", thread_id: "synthetic", model: "synthetic", cli_version: "synthetic", output_hash: "c".repeat(64), candidates: symbols.map((symbol) => ({ symbol, direction: "BULLISH", contract_id: id(symbol), reason: "synthetic qualified OTM choice", evidence_refs: [`stock:${symbol}`, `contract:${id(symbol)}`] })) };
  h.setSelect(async (input) => {
    const pool = await input.loadQualifiedContracts();
    assert.equal(new Set(pool.map((row) => row.evidence.symbol)).size, 6);
    assert.equal(h.collected.length, 2, "six different stocks stop the bounded preflight early");
    assert.ok(pool.every((row) => row.proof.quote.instrument_id === row.contract_id));
    h.setAt(completed); return source;
  });
  h.setCollect((input) => {
    if (input.paperPreflight) return symbols.slice(input.paperCandidateOffset, input.paperCandidateOffset + 3).map((symbol) => make(symbol, stamp));
    assert.ok(input.paperSelectedCandidates.every((row) => row.contract_id === id(row.symbol)));
    return input.paperSelectedCandidates.filter((row) => !input.paperExcludedSymbols.includes(row.symbol)).map(({ symbol }) => {
      const e = make(symbol, completed), original = e.contracts[0];
      if (symbol === "AAPL") original.bid = 1.7; // Its refreshed spread now breaches the special-day stop.
      e.contracts.unshift({ ...structuredClone(original), contract_id: `10000000${original.contract_id.slice(8)}`, bid: 1.99 });
      const body = { ...e }; delete body.evidence_id; e.evidence_id = createHash("sha256").update(canonicalJson(body)).digest("hex"); return e;
    });
  });
  assert.equal((await h.runtime.runOnce()).created, 3);
  assert.equal(h.collected.length, 4, "two preflight batches and two fresh exact-choice batches");
  const origins = h.events.filter((event) => event.event_type === "CREATED");
  assert.deepEqual(origins.map((event) => event.payload.plan.symbol), ["NVDA", "TSLA", "META"]);
  for (const { payload: { plan } } of origins) {
    assert.equal(plan.contract.contract_id, id(plan.symbol)); assert.equal(plan.contract.strike, 153);
    assert.equal(plan.selection_source.version, "CODEX_PAPER_SELECTION_V2");
    assert.equal(plan.reference.proof.requested_at, completed); assert.equal(plan.take_profit_pct, 10); assert.equal(plan.stop_loss_pct, -10);
  }
  const swapped = structuredClone(origins[0]), changed = swapped.payload.plan.selection_source.candidates[0];
  changed.contract_id = `20000000${changed.contract_id.slice(8)}`; changed.evidence_refs = [`stock:${changed.symbol}`, `contract:${changed.contract_id}`];
  assert.throws(() => validatePaperEvent(swapped), /精确合约不能替换/);
});

test("an incomplete qualified pool waits without rule creation and rotates its next natural preflight", async () => {
  const h = harness(), state = snapshot(), stamp = "2026-09-22T13:30:45.000Z";
  state.marketRadar.snapshot.generated_at = "2026-09-21T20:00:00Z"; h.setState(state); h.setAt(stamp);
  h.setCollect(() => []);
  h.setSelect(async (input) => {
    assert.deepEqual(await input.loadQualifiedContracts(), []);
    return { version: "CODEX_PAPER_SELECTION_V2", kind: "RULE_FALLBACK", market_date: "2026-09-22", decision_id: "paper-selection:2026-09-22", requested_at: stamp, completed_at: stamp, reason: "CODEX_QUALIFIED_POOL_WAIT: fewer than three symbols", input_hash: "b".repeat(64), input_snapshot_id: input.id, input_snapshot_hash: input.hash, invocation_id: null, thread_id: null, model: null, cli_version: null, output_hash: null, candidates: [] };
  });
  assert.equal((await h.runtime.runOnce()).created, 0);
  assert.deepEqual(h.collected.map((input) => input.paperCandidateOffset), [0, 3, 6]);
  assert.ok(h.collected.every((input) => input.paperPreflight));
  h.setAt("2026-09-22T13:45:45.000Z");
  assert.equal((await createPaperPlanRuntime(h.options).runOnce()).created, 0);
  assert.deepEqual(h.collected.map((input) => input.paperCandidateOffset), [0, 3, 6, 9, 12, 15]);
  assert.ok(!h.events.some((event) => event.event_type === "CREATED"));
});

const qualityAt = "2026-09-25T16:00:00.000Z", qualityPrevious = "2026-09-24T20:00:00Z";
const qualitySymbols = ["NET", "BWXT", "HUBB", "NVDA", "AAPL", "TSLA", "MSFT", "META", "AMD"];
const reselectionRequest = () => ({ request_id: "quality-review", requested_at: "2026-09-25T15:59:00Z", reason: "Synthetic owner authorization to void three originals and reselect", replaces_plan_ids: [1, 2, 3].map((n) => paperPlanId("2026-09-25", n)) });
function qualityEvidence(symbol, at = qualityAt) {
  const e = evidence(at, symbol); e.planning_context.observed_at = qualityPrevious;
  Object.values(e.planning_context.timeframes).forEach((frame) => { frame.data_cutoff = "2026-09-24T13:30:00Z"; });
  e.contracts[0].contract_id = `00000000-0000-4000-8000-${String(qualitySymbols.indexOf(symbol) + 100).padStart(12, "0")}`;
  e.contracts[0].expiration = e.contracts[0].instrument.expiration_date = "2026-10-02";
  const body = { ...e }; delete body.evidence_id; e.evidence_id = createHash("sha256").update(canonicalJson(body)).digest("hex"); return e;
}
async function qualityHarness(t) {
  const h = harness(), directory = await mkdtemp(join(tmpdir(), "paper-quality-runtime-synthetic-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const state = snapshot(); state.marketRadar.snapshot.generated_at = qualityPrevious;
  state.marketRadar.snapshot.fixed_pool.rows = qualitySymbols.map((symbol) => ({ symbol, status: "MARKET_CLOSED", as_of: qualityPrevious, last: 152, change_pct: 1,
    timeframes: qualityEvidence(symbol).planning_context.timeframes, swing: { direction: "BULLISH", stage: "CONFIRMED", why_watch: ["Synthetic prior session"], missing_confirmation: [] } }));
  h.setState(state); h.setAt(qualityAt); h.options.dataRoot = directory;
  return h;
}
function originalQualityEvents(symbols = qualitySymbols.slice(0, 3), at = "2026-09-25T13:30:45.000Z", previous = qualityPrevious) {
  return symbols.map((symbol, index) => {
    const e = qualityEvidence(symbol, at); e.planning_context.observed_at = previous;
    Object.values(e.planning_context.timeframes).forEach((frame) => { frame.data_cutoff = previous; });
    const body = { ...e }; delete body.evidence_id; e.evidence_id = createHash("sha256").update(canonicalJson(body)).digest("hex");
    const c = e.contracts[0], { plan } = buildPaperPlan([e], at, index + 1);
    assert.ok(plan); plan.reference.proof = { requested_at: at, received_at: at, instrument: { id: c.contract_id, ...c.instrument, underlying_type: "equity" }, quote: { instrument_id: c.contract_id, bid_price: c.bid, ask_price: c.ask, mark_price: c.mark, updated_at: at } };
    return makePaperEvent(plan.plan_id, at, "CREATED", { plan });
  });
}

test("new quality permits independent cross-day research, warns about old observations and still excludes today's symbols", async (t) => {
  const h = await qualityHarness(t);
  const prior = [21, 22, 23, 24].flatMap((day) => originalQualityEvents(["NVDA"], `2026-09-${day}T16:00:00.000Z`, `2026-09-${day === 21 ? 18 : day - 1}T20:00:00Z`));
  const today = originalQualityEvents(["AAPL"]);
  [...prior, ...today].forEach((event) => h.store.appendPaperPlanEvent(event));
  h.setCollect((input) => {
    assert.ok(input.paperExcludedSymbols.includes("AAPL")); assert.ok(!input.paperExcludedSymbols.includes("NVDA"));
    return ["AAPL", "NVDA", "TSLA"].map((symbol) => qualityEvidence(symbol));
  });
  const result = await createPaperPlanRuntime(h.options).runOnce(); assert.equal(result.created, 2);
  const fresh = h.events.filter((event) => event.event_type === "CREATED" && event.recorded_at === qualityAt).map((event) => event.payload.plan);
  assert.deepEqual(fresh.map((plan) => plan.symbol), ["NVDA", "TSLA"]);
  const warning = fresh[0].warnings.find((value) => value.includes("本单是独立研究，不是加仓指令")); assert.ok(warning); assert.ok(warning.includes("共 4 笔"));
  assert.equal((warning.match(/paper-plan:/g) ?? []).length, 3); assert.ok(prior.slice(0, 3).every((event) => warning.includes(event.plan_id)));
  assert.deepEqual(h.events.filter((event) => [...prior, ...today].some((old) => old.event_id === event.event_id)), [...prior, ...today]);
});

test("new quality preflight excludes every already-read stock and stays inside three batches", async (t) => {
  const h = await qualityHarness(t), observed = [];
  h.setCollect((input) => {
    assert.equal(input.paperPreflight, true); const symbols = qualitySymbols.filter((symbol) => !input.paperExcludedSymbols.includes(symbol)).slice(input.paperCandidateOffset, input.paperCandidateOffset + 3);
    observed.push(symbols); return symbols.map((symbol) => { const e = qualityEvidence(symbol); e.contracts[0].open_interest = 0; const body = { ...e }; delete body.evidence_id; e.evidence_id = createHash("sha256").update(canonicalJson(body)).digest("hex"); return e; });
  });
  h.setSelect(async (input) => {
    assert.deepEqual(await input.loadQualifiedContracts(), []);
    return { version: "CODEX_PAPER_SELECTION_V2", kind: "RULE_FALLBACK", market_date: "2026-09-25", decision_id: "paper-selection:2026-09-25", requested_at: qualityAt, completed_at: qualityAt, reason: "CODEX_QUALIFIED_POOL_WAIT: synthetic illiquid pool", input_hash: "b".repeat(64), input_snapshot_id: input.id, input_snapshot_hash: input.hash, invocation_id: null, thread_id: null, model: null, cli_version: null, output_hash: null, candidates: [] };
  });
  const result = await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(result.created, 0); assert.equal(h.collected.length, 3); assert.deepEqual(observed.flat(), qualitySymbols); assert.equal(new Set(observed.flat()).size, 9);
  assert.deepEqual(h.collected.map((input) => input.paperCandidateOffset), [0, 0, 0]);
});

test("owner void is atomic and idempotent, rejects non-Owner and preserves original evidence", () => {
  const db = new DatabaseSync(":memory:"), paper = openPaperPlanStore(db), originals = originalQualityEvents(), request = reselectionRequest();
  try {
    originals.slice(0, 2).forEach((event) => paper.append(event));
    assert.throws(() => voidOriginalPaperPlans(db, snapshot(), request, qualityAt), /ORIGINAL_MISSING/);
    assert.ok(request.replaces_plan_ids.every((id) => !paper.eventsForPlan(id).some((event) => event.event_type === "ENDED")));
    paper.append(originals[2]);
    assert.throws(() => voidOriginalPaperPlans(db, { investmentKernel: { ...snapshot().investmentKernel, broker_access: "WRITE" } }, request, qualityAt), /OWNER_READONLY_REQUIRED/);
    const later = "2026-09-25T16:00:01.000Z";
    paper.append(makePaperEvent(originals[2].plan_id, later, "GAP", { reasons: ["Synthetic newer event to force rollback after two inserts"] }));
    assert.throws(() => voidOriginalPaperPlans(db, snapshot(), request, qualityAt), /不能倒序追加/);
    assert.ok(request.replaces_plan_ids.every((id) => !paper.eventsForPlan(id).some((event) => event.event_type === "ENDED")), "a later append failure rolls back the preceding two voids");
    assert.equal(voidOriginalPaperPlans(db, snapshot(), request, later).voided_now.length, 3);
    assert.equal(voidOriginalPaperPlans(db, snapshot(), request, later).voided_now.length, 0);
    assert.deepEqual(request.replaces_plan_ids.map((id) => paper.eventsForPlan(id)[0]), originals);
    assert.throws(() => voidOriginalPaperPlans(db, snapshot(), { ...request, request_id: "different-request" }, later), /ORIGINAL_ALREADY_ENDED/);
  } finally { db.close(); }
});

test("owner reselection requires all originals voided before providers, creates separate exact plans and never tracks or falls back", async (t) => {
  const h = await qualityHarness(t), request = reselectionRequest(), originals = originalQualityEvents(); originals.forEach((event) => h.store.appendPaperPlanEvent(event));
  const options = { ...h.options, ownerReselection: request };
  await assert.rejects(createPaperPlanRuntime(options).runOnce(), /REQUIRES_OWNER_VOID/); assert.equal(h.sessions.length, 0);
  request.replaces_plan_ids.forEach((id) => h.store.appendPaperPlanEvent(makePaperEvent(id, qualityAt, "ENDED", { reason: "OWNER_VOID", ended_at: qualityAt, terminal_value: "UNKNOWN", detail: request.reason, owner_request_ref: request.request_id })));
  h.setCollect((input) => {
    assert.ok(qualitySymbols.slice(0, 3).every((symbol) => input.paperExcludedSymbols.includes(symbol)));
    return (input.paperSelectedCandidates?.map((choice) => choice.symbol) ?? qualitySymbols.filter((symbol) => !input.paperExcludedSymbols.includes(symbol)).slice(input.paperCandidateOffset, input.paperCandidateOffset + 3)).map((symbol) => qualityEvidence(symbol));
  });
  let modelCalls = 0;
  options.select = createPaperCodexSelector({ projectRoot: process.cwd(), dataRoot: options.dataRoot, now: options.now, ownerReselection: request, cliVersion: () => "synthetic", invoke: async (input) => {
    modelCalls++; const packet = JSON.parse(input.prompt.split("\n\n").at(-1));
    return { output: { decision_id: packet.decision_id, candidates: packet.qualified_contracts.slice(0, 3).map((c) => ({ symbol: c.symbol, direction: c.direction, contract_id: c.contract_id, reason: "Synthetic owner reselection", evidence_refs: [`stock:${c.symbol}`, c.evidence_ref] })) }, threadId: "synthetic", stdout: "", stderr: "", processTreeClosed: true };
  } });
  const result = await createPaperPlanRuntime(options).runOnce(); assert.equal(result.created, 3); assert.equal(result.checked, 0); assert.equal(h.quoteCalls.length, 0); assert.equal(modelCalls, 1);
  const newPlans = h.events.filter((event) => event.event_type === "CREATED" && event.payload.plan.owner_reselection);
  assert.deepEqual(newPlans.map((event) => event.plan_id), request.replaces_plan_ids.map((id) => `${id}:reselect:${request.request_id}`));
  assert.ok(newPlans.every((event) => event.payload.plan.selection_source.kind === "CODEX" && event.payload.plan.reference.proof));
  assert.deepEqual(h.events.filter((event) => event.event_type === "CREATED" && !event.payload.plan.owner_reselection), originals);
  assert.equal((await createPaperPlanRuntime(options).runOnce()).created, 0); assert.equal(modelCalls, 1); assert.equal(h.quoteCalls.length, 0);
  const failed = await qualityHarness(t); originals.forEach((event) => failed.store.appendPaperPlanEvent(event));
  request.replaces_plan_ids.forEach((id) => failed.store.appendPaperPlanEvent(makePaperEvent(id, qualityAt, "ENDED", { reason: "OWNER_VOID", ended_at: qualityAt, terminal_value: "UNKNOWN", detail: request.reason, owner_request_ref: request.request_id })));
  assert.equal((await createPaperPlanRuntime({ ...failed.options, ownerReselection: request }).runOnce()).created, 0); assert.equal(failed.collected.length, 0, "owner failure never starts rule fallback collection");
});

test("three Codex primary contracts without alternatives fall back next heartbeat after the only batch is exhausted", async () => {
  const h = harness(), stamp = "2026-09-22T13:30:45.000Z", next = "2026-09-22T13:45:45.000Z", state = snapshot(), symbols = ["NVDA", "AAPL", "TSLA"];
  state.marketRadar.snapshot.generated_at = "2026-09-21T20:00:00Z"; h.setState(state); h.setAt(stamp);
  const source = { version: "CODEX_PAPER_SELECTION_V2", kind: "CODEX", market_date: "2026-09-22", decision_id: "paper-selection:2026-09-22", requested_at: stamp, completed_at: stamp,
    reason: "SYNTHETIC_THREE_PRIMARIES_NO_ALTERNATIVES", input_hash: "b".repeat(64), input_snapshot_id: "source-fixture", input_snapshot_hash: sourceHash, invocation_id: "synthetic", thread_id: "synthetic", model: "synthetic", cli_version: "synthetic", output_hash: "c".repeat(64),
    candidates: symbols.map((symbol) => { const id = evidence(stamp, symbol).contracts[0].contract_id; return { symbol, direction: "BULLISH", contract_id: id, reason: "synthetic exact selection", evidence_refs: [`stock:${symbol}`, `contract:${id}`] }; }) };
  h.setSelect(async () => source);
  h.setCollect((input) => {
    if (input.paperSelectedCandidates) return []; // All three original exact choices lack valid refreshed evidence.
    return symbols.map((symbol) => {
      const e = evidence(next, symbol); e.planning_context.observed_at = "2026-09-21T20:00:00Z"; e.contracts[0].expiration = e.contracts[0].instrument.expiration_date = "2026-10-02";
      const body = { ...e }; delete body.evidence_id; e.evidence_id = createHash("sha256").update(canonicalJson(body)).digest("hex"); return e;
    });
  });
  assert.equal((await h.runtime.runOnce()).created, 0); assert.equal(h.collected.length, 1);
  h.setAt(next);
  assert.equal((await createPaperPlanRuntime(h.options).runOnce()).created, 3, "no nonexistent alternative batch may stall the daily gap");
  assert.equal(h.collected.length, 2); assert.equal(h.collected[1].paperSelectedCandidates, undefined);
  const origins = h.events.filter((event) => event.event_type === "CREATED"); assert.equal(origins.length, 3);
  assert.ok(origins.every(({ payload: { plan } }) => plan.selection_source.kind === "RULE_FALLBACK" && plan.selection_source.reason.startsWith("CODEX_CANDIDATES_EXHAUSTED")));
  assert.equal(source.kind, "CODEX", "the cached model decision remains immutable"); assert.equal(source.candidates.length, 3);
});

test("September 21 synthetic runtime uses Codex direction then fresh quotes without changing frozen swing or old origins", async () => {
  const h = harness(["NVDA", "AAPL", "TSLA"]), stamp = "2026-09-21T13:30:45.000Z", completed = "2026-09-21T13:31:15.000Z", state = snapshot();
  state.marketRadar.snapshot.generated_at = "2026-09-18T20:00:00Z";
  h.setState(state); h.setAt(stamp);
  const source = { version: "CODEX_PAPER_SELECTION_V1", kind: "CODEX", market_date: "2026-09-21", decision_id: "paper-selection:2026-09-21", requested_at: stamp, completed_at: completed, reason: "SYNTHETIC_CODEX_SELECTION", input_hash: "b".repeat(64), input_snapshot_id: "source-fixture", input_snapshot_hash: sourceHash, invocation_id: "synthetic-invocation", thread_id: "synthetic-thread", model: "CLI_DEFAULT_UNREPORTED", cli_version: "synthetic-cli", output_hash: "c".repeat(64), candidates: ["NVDA", "AAPL", "TSLA"].map((symbol) => ({ symbol, direction: "BEARISH", reason: "测试：看跌理由来自Codex，原冻结结构仍看涨", evidence_refs: [`stock:${symbol}`] })) };
  let selections = 0;
  h.setSelect(async () => { selections++; h.setAt(completed); return source; });
  h.setCollect((input) => {
    assert.deepEqual(input.paperSelectedCandidates, source.candidates);
    return source.candidates.map(({ symbol }) => {
      const e = evidence(completed, symbol); e.direction = "BEARISH";
      e.planning_context.observed_at = "2026-09-18T20:00:00Z";
      e.contracts[0].option_type = e.contracts[0].instrument.type = "put";
      e.contracts[0].expiration = e.contracts[0].instrument.expiration_date = "2026-10-02";
      const body = { ...e }; delete body.evidence_id; e.evidence_id = createHash("sha256").update(canonicalJson(body)).digest("hex"); return e;
    });
  });
  assert.equal((await h.runtime.runOnce()).created, 3); assert.equal(selections, 1);
  const origins = h.events.filter((event) => event.event_type === "CREATED");
  for (const { payload: { plan } } of origins) {
    assert.equal(plan.selection_source.kind, "CODEX"); assert.equal(plan.entry_policy.version, "CODEX_PAPER_RESEARCH_V1");
    assert.equal(plan.direction, "BEARISH"); assert.equal(plan.contract.option_type, "put");
    assert.equal(plan.entry_policy.evidence.planning_context.timeframes.daily.direction, "BULLISH");
    assert.deepEqual(plan.levels, { entry: null, invalidation: null, target: null });
    assert.equal(plan.reference.quoted_at, completed); assert.ok(plan.reference.proof);
    assert.equal(plan.stop_loss_pct, -40); assert.equal(plan.take_profit_pct, 30);
  }
  const broken = structuredClone(origins[0]); broken.payload.plan.selection_source.kind = "RULE_FALLBACK";
  assert.throws(() => validatePaperEvent(broken));
  const earlyQuote = structuredClone(origins[0]); earlyQuote.payload.plan.reference.proof.requested_at = stamp;
  assert.throws(() => validatePaperEvent(earlyQuote), /模型完成后/);
  const learning = projectPaperLearning(h.events); assert.equal(learning.groups.find((g) => g.label === "Codex 亲选规则").stats.total, 3);
  await createPaperPlanRuntime(h.options).runOnce(); assert.equal(selections, 1); assert.equal(h.events.filter((e) => e.event_type === "CREATED").length, 3);
});

test("synthetic unavailable Codex uses the original three-stock rule with explicit fallback grouping", async () => {
  const h = harness(["NVDA", "AAPL", "TSLA"]), stamp = "2026-09-21T13:30:45.000Z", state = snapshot();
  state.marketRadar.snapshot.generated_at = "2026-09-18T20:00:00Z"; h.setState(state); h.setAt(stamp);
  h.setCollect((input) => {
    assert.equal(input.paperSelectedCandidates, undefined);
    return ["NVDA", "AAPL", "TSLA"].map((symbol) => { const e = evidence(stamp, symbol); e.planning_context.observed_at = "2026-09-18T20:00:00Z"; e.contracts[0].expiration = e.contracts[0].instrument.expiration_date = "2026-10-02"; const body = { ...e }; delete body.evidence_id; e.evidence_id = createHash("sha256").update(canonicalJson(body)).digest("hex"); return e; });
  });
  assert.equal((await h.runtime.runOnce()).created, 3);
  assert.ok(h.events.filter((e) => e.event_type === "CREATED").every((e) => e.payload.plan.selection_source.kind === "RULE_FALLBACK" && e.payload.plan.entry_policy.version === "BASELINE_PAPER_RESEARCH_V1"));
  const groups = projectPaperLearning(h.events).groups;
  assert.equal(groups.find((g) => g.label === "规则补位").stats.total, 3); assert.ok(!groups.some((g) => g.label === "Codex 亲选规则"));
});

test("Codex primary and alternative batches count their own real collection attempts, not earlier missing-source checks", async () => {
  const h = harness(), initial = "2026-09-21T13:30:45.000Z", current = "2026-09-21T14:00:45.000Z";
  h.setAt(initial); assert.equal((await h.runtime.runOnce()).created, 0);
  h.setAt("2026-09-21T13:45:45.000Z"); assert.equal((await h.runtime.runOnce()).created, 0); assert.equal(h.collected.length, 0);
  const state = snapshot(); state.marketRadar.snapshot.generated_at = "2026-09-18T20:00:00Z"; h.setState(state); h.setAt(current);
  const choices = ["NVDA", "AAPL", "TSLA", "META", "MSFT", "ARM"].map((symbol) => ({ symbol, direction: "BULLISH", reason: "synthetic", evidence_refs: [`stock:${symbol}`] }));
  const source = { version: "CODEX_PAPER_SELECTION_V1", kind: "CODEX", market_date: "2026-09-21", decision_id: "paper-selection:2026-09-21", requested_at: current, completed_at: current, reason: "SYNTHETIC_CODEX_SELECTION", input_hash: "b".repeat(64), input_snapshot_id: "source-fixture", input_snapshot_hash: sourceHash, invocation_id: "synthetic-invocation", thread_id: "synthetic-thread", model: "CLI_DEFAULT_UNREPORTED", cli_version: "synthetic-cli", output_hash: "c".repeat(64), candidates: choices };
  h.setSelect(async () => source); h.setCollect(() => []);
  await h.runtime.runOnce(); assert.deepEqual(h.collected[0].paperSelectedCandidates.map((row) => row.symbol), ["NVDA", "AAPL", "TSLA"]);
  h.setAt("2026-09-21T14:15:45.000Z"); await createPaperPlanRuntime(h.options).runOnce();
  assert.deepEqual(h.collected[1].paperSelectedCandidates.map((row) => row.symbol), ["META", "MSFT", "ARM"]);
  h.setAt("2026-09-21T14:30:45.000Z"); await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(h.collected[2].paperSelectedCandidates, undefined);
  assert.ok(h.events.some((event) => event.event_type === "ATTEMPT" && event.payload.reasons.some((reason) => reason.includes("CODEX_CANDIDATES_EXHAUSTED"))));
});

test("natural PAPER creation freezes current special-day policy while later calendar changes cannot change it", async () => {
  const h = harness(["NVDA", "AAPL", "TSLA"]), state = snapshot();
  state.macroEventLearning.entry_special_days = [specialDay]; h.setState(state);
  assert.equal((await h.runtime.runOnce()).created, 3);
  const origins = structuredClone(h.events.filter((event) => event.event_type === "CREATED"));
  assert.ok(origins.every((event) => event.payload.plan.threshold_policy.version === "SPECIAL_DAY_10_10_V1" && event.payload.plan.take_profit_pct === 10 && event.payload.plan.stop_loss_pct === -10));
  h.setState(snapshot()); h.setCollect(() => []); h.setAt("2026-09-10T14:15:45.000Z"); h.overrideQuote({ bid: 2.2, ask: 2.3 });
  await h.runtime.runOnce(); const first = projectPaperLearning(h.events).recent_results;
  assert.ok(first.every((result) => result.exit_reason === "TAKE_PROFIT" && result.return_pct === 10));
  h.setAt("2026-09-10T14:30:45.000Z"); h.overrideQuote({ bid: 2, ask: 2.1 }); await h.runtime.runOnce();
  assert.deepEqual(projectPaperLearning(h.events).recent_results, first);
  assert.deepEqual(h.events.filter((event) => event.event_type === "CREATED"), origins);
});

test("unclassified calendar blocks new PAPER only and archived display labels cannot substitute for current entry evidence", async () => {
  const blocked = harness(), unknown = snapshot();
  unknown.macroEventLearning = { special_days: [specialDay] }; blocked.setState(unknown);
  assert.equal((await blocked.runtime.runOnce()).created, 0);
  assert.equal(blocked.sessions.length, 0); assert.match(blocked.events[0].payload.reasons.join(";"), /SPECIAL_DAY_CALENDAR_UNAVAILABLE/);
  const h = harness(); await h.runtime.runOnce();
  const original = structuredClone(h.events.find((event) => event.event_type === "CREATED")), collections = h.collected.length;
  h.setAt("2026-09-10T14:15:45.000Z"); h.setState(unknown);
  const result = await h.runtime.runOnce();
  assert.equal(result.created, 0); assert.equal(result.checked, 1); assert.equal(h.collected.length, collections);
  assert.ok(h.events.some((event) => event.event_type === "MARK"), "existing original still receives real quote observations");
  assert.deepEqual(h.events.find((event) => event.event_type === "CREATED"), original);
});

test("date-only calendar placeholders do not manufacture a precise PAPER macro exit", async () => {
  const h = harness(); await h.runtime.runOnce(); const at = "2026-09-10T15:00:00Z", state = riskSnapshot(at);
  state.outputs.A1_SHADOW_RESULT = { source_mode: "LIVE", observed_at: at, official_macro: { status: "LIVE", collected_at: at, as_of: at, context_hash: "b".repeat(64),
    events: [{ release_name: "FOMC Meeting Decision", category: "central_bank", scheduled_at: "2026-09-10T16:00:00Z", time_precision: "DATE_ONLY", source_url: specialDay.source_url }] } };
  h.setAt(at); h.setState(state); h.setCollect(() => []); h.overrideQuote({ bid: 2, ask: 2.1 }); await h.runtime.runOnce();
  assert.equal(h.events.findLast((event) => event.event_type === "MARK").payload.risk_exit, undefined);
});

test("PAPER earnings exits use current calendar membership and the real last trading-session window", async () => {
  for (const [at, date, session, expected] of [
    ["2026-09-10T18:59:00.000Z", "2026-09-10", "AMC", false],
    ["2026-09-10T19:00:00.000Z", "2026-09-10", "AMC", true],
    ["2026-09-10T19:30:00.000Z", "2026-09-11", "BMO", true],
    ["2026-09-11T19:30:00.000Z", "2026-09-14", "BMO", true],
    ["2026-09-10T19:30:00.000Z", "2026-09-11", "UNKNOWN", true],
    ["2026-09-10T15:00:00.000Z", "2026-09-10", "DMH", true],
    ["2026-09-10T15:00:00.000Z", "2026-09-10", "UNKNOWN", true],
    ["2026-09-10T19:30:00.000Z", "2026-09-10", "BMO", false],
    ["2026-09-10T19:30:00.000Z", "2026-09-09", "AMC", false],
    ["2026-09-10T19:30:00.000Z", "2026-09-14", "BMO", false],
  ]) {
    const h = harness(); await h.runtime.runOnce(); const original = structuredClone(h.events.find((event) => event.event_type === "CREATED"));
    h.setAt(at); h.setCollect(() => []); h.setState(earningsSnapshot(at, date, session)); h.overrideQuote({ bid: 2.1, ask: 2.2 });
    await h.runtime.runOnce();
    const mark = h.events.findLast((event) => event.event_type === "MARK"), exit = mark.payload.risk_exit;
    assert.equal(Boolean(exit), expected, `${at}/${date}/${session}`);
    if (expected) {
      assert.equal(exit.reason, "EARNINGS_WINDOW"); assert.equal(exit.scheduled_for, date); assert.equal(exit.session, session);
      assert.equal(exit.source_observed_at, at, "latest calendar receipt, never the old archive fetched_at");
      assert.match(exit.title, /日程预告.*不是确定公布结果/); assert.equal(exit.decision_at, mark.recorded_at);
    }
    assert.deepEqual(h.events.find((event) => event.event_id === original.event_id), original);
    assert.equal(h.store.getActivePaperPlans().length, 1); assert.ok(!h.events.some((event) => event.event_type === "ENDED"));
    assert.equal(h.sessions.at(-1).timeoutMs, 20_000);
    assert.deepEqual(h.sessions.at(-1).allowlist, ["get_option_instruments", "get_option_quotes", "get_option_historicals"]);
  }
  for (const fault of ["missing-membership", "missing-current-earnings", "cancelled", "rescheduled", "membership-time", "stale", "future-source", "missing-calendar-capability", "expired-auth", "reported", "wrong-symbol", "invalid-date", "weekend-date", "quote-before-confirmation"]) {
    const at = "2026-09-10T19:30:00.000Z", h = harness(); await h.runtime.runOnce();
    const state = earningsSnapshot(at), event = state.marketIntelligence.events[0], source = state.dataSources[0];
    if (fault === "missing-membership") delete state.marketIntelligence.earningsCalendar;
    if (fault === "missing-current-earnings") delete state.marketIntelligence.currentEarnings;
    if (fault === "cancelled") state.marketIntelligence.earningsCalendar.event_ids = [];
    if (fault === "rescheduled") state.marketIntelligence.earningsCalendar.event_ids = ["a-different-current-earnings-id"];
    if (fault === "membership-time") state.marketIntelligence.earningsCalendar.checked_at = "2026-09-10T19:29:00.000Z";
    if (fault === "stale") source.checked_at = source.as_of = state.marketIntelligence.earningsCalendar.checked_at = "2026-09-10T18:59:00.000Z";
    if (fault === "future-source") source.checked_at = source.as_of = state.marketIntelligence.earningsCalendar.checked_at = "2026-09-10T19:31:00.000Z";
    if (fault === "missing-calendar-capability") source.capabilities.earnings_calendar = false;
    if (fault === "expired-auth") source.authorization = "EXPIRED";
    if (fault === "reported") event.earnings_result.reported = true;
    if (fault === "wrong-symbol") event.affected_symbols = ["AAPL"];
    if (fault === "invalid-date") event.scheduled_for = "2026-99-10";
    if (fault === "weekend-date") event.scheduled_for = "2026-09-12";
    h.setAt(at); h.setCollect(() => []); h.setState(state); h.overrideQuote({ bid: 2.1, ask: 2.2, ...(fault === "quote-before-confirmation" ? { quoted_at: "2026-09-10T19:29:00.000Z" } : {}) });
    await h.runtime.runOnce(); const last = h.events.at(-1);
    assert.equal(last.event_type, "MARK", fault); assert.equal(last.payload.risk_exit, undefined, fault);
    assert.equal(projectPaperLearning(h.events).recent_results[0].status, "PENDING", fault);
  }
  const early = harness(), earlyOpen = "2026-11-27T14:55:45.000Z", previous = "2026-11-25T21:00:00.000Z", earlyState = snapshot();
  earlyState.marketRadar.snapshot.generated_at = previous;
  earlyState.outputs.A1_SHADOW_RESULT.observed_at=earlyState.outputs.A1_SHADOW_RESULT.market_sources.generated_at=earlyState.outputs.A1_SHADOW_RESULT.market_sources.as_of=earlyOpen;
  early.setAt(earlyOpen); early.setState(earlyState); early.setCollect(() => {
    const value = evidence(earlyOpen); value.planning_context.observed_at = previous;
    value.contracts[0].expiration = value.contracts[0].instrument.expiration_date = "2026-12-04";
    const original = { ...value }; delete original.evidence_id;
    return [{ ...value, evidence_id: createHash("sha256").update(canonicalJson(original)).digest("hex") }];
  });
  assert.equal((await early.runtime.runOnce()).created, 1);
  early.setCollect(() => []); early.overrideQuote({ bid: 2.1, ask: 2.2 });
  for (const [at, expected] of [["2026-11-27T16:59:00.000Z", false], ["2026-11-27T17:00:00.000Z", true]]) {
    early.setAt(at); early.setState(earningsSnapshot(at, "2026-11-27", "AMC")); await early.runtime.runOnce();
    assert.equal(Boolean(early.events.at(-1).payload.risk_exit), expected, "early close uses the last hour before 13:00 ET, not the normal 16:00 ET close");
  }
});

test("official macro and verified event risk exits require current source, valid time and explicit impact scope", async () => {
  const at = "2026-09-10T15:00:00.000Z";
  for (const kind of ["macro", "news"]) for (const fault of ["valid", "stale", "future-source", "unverified", "expired", "outside-window", "wrong-scope", "bad-url", "quote-before-event"]) {
    const h = harness(); await h.runtime.runOnce(); const state = riskSnapshot(at);
    if (kind === "macro") {
      state.outputs.A1_SHADOW_RESULT = { source_mode: "LIVE", observed_at: at, official_macro: { status: "LIVE", collected_at: at, as_of: at, context_hash: "b".repeat(64), events: [
        { release_name: "CPI", category: "inflation", scheduled_at: "2026-09-10T16:00:00.000Z", source_url: "https://www.bls.gov/schedule/", confidence: "official_schedule" },
      ] } };
      const macro = state.outputs.A1_SHADOW_RESULT.official_macro, event = macro.events[0];
      if (fault === "stale") macro.collected_at = macro.as_of = "2026-09-10T14:29:00.000Z";
      if (fault === "future-source") macro.collected_at = macro.as_of = "2026-09-10T15:01:00.000Z";
      if (fault === "unverified") state.outputs.A1_SHADOW_RESULT.source_mode = "REPLAY";
      if (fault === "expired") event.scheduled_at = "2026-09-10T14:59:00.000Z";
      if (fault === "outside-window") event.scheduled_at = "2026-09-10T16:31:00.000Z";
      if (fault === "wrong-scope") event.category = "company_announcement";
      if (fault === "bad-url") event.source_url = "https://bls.gov.example.test/schedule/";
    } else {
      state.marketIntelligence.events = [{ event_id: "verified-event", kind: "NEWS", title: "已核验事件身份", source: "BLS", source_url: "https://www.bls.gov/news.release/", published_at: at, fetched_at: at, event_fingerprint: "event-proof", affected_symbols: ["NVDA"], event_evidence_state: "VERIFIED", importance: "MARKET_MOVING" }];
      state.marketIntelligence.eventResponseReceivedAt = { "verified-event": at };
      state.marketIntelligence.causalChains = [{ event_fingerprint: "event-proof", event_category: "systemic_event", event_evidence_state: "VERIFIED", affected: ["NVDA"], updated_at: at, expires_at: "2026-09-10T21:00:00.000Z", expected_direction: "待验证假设", market_confirmation: "NOT_OBSERVED" }];
      const event = state.marketIntelligence.events[0], chain = state.marketIntelligence.causalChains[0];
      if (fault === "stale") state.dataSources[0].checked_at = state.dataSources[0].as_of = "2026-09-10T14:29:00.000Z";
      if (fault === "future-source") event.published_at = "2026-09-10T15:01:00.000Z";
      if (fault === "unverified") event.event_evidence_state = "PARTIAL";
      if (fault === "expired") chain.expires_at = "2026-09-10T14:59:00.000Z";
      if (fault === "outside-window") chain.updated_at = "2026-09-10T15:01:00.000Z";
      if (fault === "wrong-scope") chain.affected = ["AAPL"];
      if (fault === "bad-url") event.source_url = "http://www.bls.gov/news.release/";
    }
    h.setAt(at); h.setCollect(() => []); h.setState(state); h.overrideQuote({ bid: 2.1, ask: 2.2, ...(fault === "quote-before-event" ? { quoted_at: "2026-09-10T14:59:00.000Z" } : {}) });
    await h.runtime.runOnce(); const mark = h.events.at(-1); assert.equal(mark.event_type, "MARK", `${kind}/${fault}`);
    assert.equal(mark.payload.risk_exit?.reason ?? null, fault === "valid" ? kind === "macro" ? "OFFICIAL_MACRO_WINDOW" : "VERIFIED_MAJOR_EVENT" : null, `${kind}/${fault}`);
    if (kind === "news" && fault === "valid") assert.match(mark.payload.risk_exit.title, /不推断利空方向/);
  }
  for (const category of ["inflation", "systemic_event"]) {
    const h = harness(); await h.runtime.runOnce(); const state = riskSnapshot(at);
    state.marketIntelligence.events = [{ event_id: "global-news", kind: "NEWS", title: "已核验事件", source: "BLS", source_url: "https://www.bls.gov/news.release/", published_at: at, fetched_at: at, event_fingerprint: "global-proof", affected_symbols: [], event_evidence_state: "VERIFIED", importance: "MARKET_MOVING" }];
    state.marketIntelligence.eventResponseReceivedAt = { "global-news": at };
    state.marketIntelligence.causalChains = [{ event_fingerprint: "global-proof", event_category: category, event_evidence_state: "VERIFIED", affected: [], updated_at: at, expires_at: "2026-09-10T21:00:00.000Z" }];
    h.setAt(at); h.setCollect(() => []); h.setState(state); h.overrideQuote({ bid: 2.1, ask: 2.2 }); await h.runtime.runOnce();
    assert.equal(h.events.at(-1).payload.risk_exit?.scope ?? null, category === "inflation" ? "GLOBAL" : null, "an unmapped systemic headline is not automatically global macro risk");
  }
  const h = harness(); await h.runtime.runOnce(); const lastAt = "2026-09-18T19:30:00.000Z", state = riskSnapshot(lastAt);
  state.outputs.A1_SHADOW_RESULT = { source_mode: "LIVE", observed_at: lastAt, official_macro: { status: "LIVE", collected_at: lastAt, as_of: lastAt, context_hash: "b".repeat(64),
    events: [{ release_name: "GDP", category: "growth", scheduled_at: "2026-09-18T20:15:00.000Z", source_url: "https://www.bea.gov/schedule/", confidence: "official_schedule" }] } };
  h.setAt(lastAt); h.setCollect(() => []); h.setState(state); h.overrideQuote({ bid: 2.1, ask: 2.2 }); await h.runtime.runOnce();
  assert.ok(h.events.some((event) => event.event_type === "ENDED" && event.payload.reason === "OBSERVATION_WINDOW"));
  assert.equal(h.quoteCalls.length, 0, "the seven-day observation deadline already ended this original; later news cannot revive it");
});

test("PAPER risk exits require the actual response receipt before the quote, including refreshed calendar membership", async () => {
  const requestAt = "2026-09-10T19:30:00.000Z", receiptAt = "2026-09-10T19:30:10.000Z", decisionAt = "2026-09-10T19:30:12.000Z";
  for (const kind of ["earnings", "news"]) for (const fault of ["valid", "quote-before-response", "missing-response", "future-response", "response-before-request"]) {
    const h = harness(); await h.runtime.runOnce(); const state = earningsSnapshot(requestAt);
    let receipt = state.marketIntelligence.earningsCalendar;
    if (kind === "news") {
      state.marketIntelligence.earningsCalendar = null;
      state.marketIntelligence.events = [{ event_id: "receipt-news", kind: "NEWS", title: "已核验事件", source: "BLS", source_url: "https://www.bls.gov/news.release/", published_at: requestAt, fetched_at: requestAt, event_fingerprint: "receipt-proof", affected_symbols: ["NVDA"], event_evidence_state: "VERIFIED", importance: "MARKET_MOVING" }];
      state.marketIntelligence.causalChains = [{ event_fingerprint: "receipt-proof", event_category: "systemic_event", event_evidence_state: "VERIFIED", affected: ["NVDA"], updated_at: requestAt, expires_at: "2026-09-10T21:00:00.000Z" }];
      receipt = state.marketIntelligence.eventResponseReceivedAt = {};
    }
    receipt[kind === "earnings" ? "response_received_at" : "receipt-news"] = fault === "missing-response" ? null : fault === "future-response" ? "2026-09-10T19:30:13.000Z" : fault === "response-before-request" ? "2026-09-10T19:29:59.000Z" : receiptAt;
    h.setAt(decisionAt); h.setCollect(() => []); h.setState(state);
    h.overrideQuote({ bid: 2.1, ask: 2.2, quoted_at: fault === "quote-before-response" ? "2026-09-10T19:30:05.000Z" : receiptAt });
    await h.runtime.runOnce(); const mark = h.events.at(-1), exit = mark.payload.risk_exit;
    assert.equal(mark.event_type, "MARK", `${kind}/${fault}: keep the valid quote even when risk evidence cannot settle`);
    assert.equal(Boolean(exit), fault === "valid", `${kind}/${fault}`);
    if (exit) { assert.equal(exit.source_observed_at, receiptAt); assert.equal(exit.source_checked_at, receiptAt); assert.equal(exit.decision_at, decisionAt); }
    else assert.equal(projectPaperLearning(h.events).summary.pending, 1);
  }
});

test("first PAPER exit stays frozen while same-day sampling continues, then becomes one daily research attempt", async () => {
  const at = "2026-09-10T19:15:00.000Z";
  for (const first of ["risk", "take-profit", "stop-loss", "quote-gap"]) {
    const h = harness(); await h.runtime.runOnce(); h.setCollect(() => []); h.setAt(at); h.setState(earningsSnapshot(at));
    h.overrideQuote({ bid: first === "take-profit" ? 2.6 : first === "stop-loss" ? 1.2 : 2.1, ask: 2.7, ...(first === "quote-gap" ? { contract_id: "wrong-contract" } : {}) });
    await h.runtime.runOnce();
    if (first === "quote-gap") { assert.equal(h.events.at(-1).event_type, "GAP"); assert.equal(projectPaperLearning(h.events).summary.pending, 1); }
    else assert.equal(h.events.at(-1).payload.risk_exit?.reason ?? null, first === "risk" ? "EARNINGS_WINDOW" : null);
    const initialResult = structuredClone(projectPaperLearning(h.events).recent_results[0]);
    const marks = h.events.filter((event) => event.event_type === "MARK").length;
    h.setAt("2026-09-10T19:30:00.000Z"); h.setState(earningsSnapshot("2026-09-10T19:30:00.000Z")); h.overrideQuote({ bid: 2.2, ask: 2.3 });
    await createPaperPlanRuntime(h.options).runOnce();
    assert.equal(h.events.filter((event) => event.event_type === "MARK").length, marks + 1, "today's settled plan remains in the existing regular sampling queue");
    if (first !== "quote-gap") assert.deepEqual(projectPaperLearning(h.events).recent_results[0], initialResult);
    assert.equal(h.store.getActivePaperPlans().length, 1);
    assert.equal(h.events.filter((event) => event.event_type === "MARK" && event.payload.risk_exit).length, first === "risk" || first === "quote-gap" ? 1 : 0);
    const plan = h.events.find((event) => event.event_type === "CREATED").payload.plan;
    assert.equal(projectPaperTracking(plan, h.events, "2026-09-10T19:45:00Z").stage, "FOCUS");
    assert.equal(projectPaperTracking(plan, h.events, "2026-09-11T14:00:00Z").stage, "RESEARCH");
    assert.equal(projectPaperTracking(plan, h.events, "2026-09-11T19:00:00Z").research_due, true);
    h.setAt("2026-09-18T20:00:00.000Z"); await h.runtime.runOnce();
    assert.equal(h.events.at(-1).event_type, "ENDED"); assert.equal(h.events.at(-1).payload.terminal_value, "UNKNOWN");
  }
});

test("three daily research PAPER plans retain real evidence while account approval and models stay outside the lane", async () => {
  const h = harness(["NVDA", "AAPL", "TSLA"]), result = await h.runtime.runOnce();
  assert.equal(result.created, PAPER_DAILY_TARGET);
  const plan = h.events.find((item) => item.event_type === "CREATED").payload.plan;
  assert.equal(plan.plan_id, paperPlanId("2026-09-10")); assert.equal(plan.reference.ask, 2);
  assert.equal(plan.reference.kind, "SIMULATED_REFERENCE"); assert.equal(plan.source.observed_at, sourceAt);
  assert.equal(plan.executable, false); assert.equal(plan.automated_execution, false); assert.equal(plan.performance, "EXCLUDED");
  assert.match(plan.warnings.join(";"), /ACCOUNT_NOT_CURRENT/);
  assert.match(h.collected[0].run_id, /^paper-check:/); assert.equal(h.collected[0].source_snapshot_hash, sourceHash);
  assert.equal(h.sessions[0].timeoutMs, 30_000); assert.equal(h.collected[0].deadlineMs, 30_000);
  assert.deepEqual(h.sessions[0].allowlist, ["get_equity_quotes", "get_option_chains", "get_option_instruments", "get_option_quotes"]);
  assert.equal(plan.entry_policy.version, "BASELINE_PAPER_RESEARCH_V1");
  assert.equal(h.collected[0].paperResearch, true);
  h.setAt("2026-09-10T14:15:45.000Z");
  await h.runtime.runOnce(); await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(h.collected.length, 1, "restart cannot exceed the completed daily quota");
  const created = h.events.filter((item) => item.event_type === "CREATED");
  assert.equal(created.length, PAPER_DAILY_TARGET);
  assert.deepEqual(created.map((event) => event.plan_id), [1, 2, 3].map((ordinal) => paperPlanId("2026-09-10", ordinal)));
  assert.equal(new Set(created.map((event) => event.payload.plan.symbol)).size, PAPER_DAILY_TARGET);
  assert.equal(h.events.findLast((item) => item.event_type === "MARK").payload.estimated_return_pct, 30);
});

test("a partial daily ticket survives restart while two distinct remaining tickets fill from one bounded collection", async () => {
  const h = harness(); assert.equal((await h.runtime.runOnce()).created, 1);
  const first = structuredClone(h.events.find((event) => event.event_type === "CREATED"));
  assert.deepEqual(h.events.filter((event) => event.event_type === "ATTEMPT").slice(-2).map((event) => event.plan_id), [2, 3].map((ordinal) => paperPlanId("2026-09-10", ordinal)));
  h.setAt("2026-09-10T14:15:45.000Z");
  h.setCollect(() => ["NVDA", "AAPL", "TSLA"].map((symbol) => evidence("2026-09-10T14:15:45.000Z", symbol)));
  assert.equal((await createPaperPlanRuntime(h.options).runOnce()).created, 2);
  assert.deepEqual(h.collected[1].paperExcludedSymbols, ["NVDA"]); assert.equal(h.collected[1].paperCandidateOffset, 3);
  assert.deepEqual(h.events.find((event) => event.event_id === first.event_id), first, "the original ticket is never replaced or repriced");
  const created = h.events.filter((event) => event.event_type === "CREATED");
  assert.deepEqual(created.map((event) => event.payload.plan.symbol), ["NVDA", "AAPL", "TSLA"]);
  assert.deepEqual(created.map((event) => event.plan_id), [1, 2, 3].map((ordinal) => paperPlanId("2026-09-10", ordinal)));
  await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(h.collected.length, 2); assert.equal(h.store.getActivePaperPlans().length, PAPER_DAILY_TARGET);
});

test("next week creates three different examples while the original contract and threshold result survive restart", async () => {
  const h = harness(); await h.runtime.runOnce();
  h.setAt("2026-09-10T14:15:45.000Z"); await h.runtime.runOnce();
  const oldEvents = structuredClone(h.events.filter((event) => event.plan_id === paperPlanId("2026-09-10")));
  const monday = "2026-09-14T14:00:45.000Z", state = snapshot();
  state.marketRadar.snapshot.generated_at = "2026-09-11T20:00:00.000Z";
  state.outputs.A1_SHADOW_RESULT.observed_at=state.outputs.A1_SHADOW_RESULT.market_sources.generated_at=state.outputs.A1_SHADOW_RESULT.market_sources.as_of=monday;
  h.setAt(monday); h.setState(state);
  h.setCollect(() => ["NVDA", "AAPL", "TSLA", "MSFT"].map((symbol) => {
    const row = evidence(monday, symbol);
    row.planning_context.observed_at = state.marketRadar.snapshot.generated_at;
    row.contracts[0].expiration = row.contracts[0].instrument.expiration_date = "2026-09-25";
    const original = { ...row }; delete original.evidence_id;
    return { ...row, evidence_id: createHash("sha256").update(canonicalJson(original)).digest("hex") };
  }));
  const restarted = createPaperPlanRuntime(h.options), result = await restarted.runOnce();
  assert.equal(result.created, 3); assert.equal(result.checked, 0, "the old settled ticket waits for the daily close research window");
  assert.deepEqual(h.collected.at(-1).paperExcludedSymbols, ["NVDA"]);
  assert.deepEqual(h.events.filter((event) => event.event_type === "CREATED" && event.market_date === "2026-09-14").map((event) => event.payload.plan.symbol), ["AAPL", "TSLA", "MSFT"]);
  assert.deepEqual(h.events.filter((event) => oldEvents.some((old) => old.event_id === event.event_id)), oldEvents);
  assert.equal(h.events.findLast((event) => event.plan_id === paperPlanId("2026-09-10")).event_type, "MARK");
  assert.equal((await createPaperPlanRuntime(h.options).runOnce()).created, 0);
});

test("missing or untrusted evidence leaves attempts and can retry later without manufacturing a first plan", async (t) => {
  for (const fault of ["missing-source", "old-source", "replay-source", "bad-hash", "missing-contract", "future-quote", "stale-quote", "snapshot-read"]) await t.test(fault, async () => {
    const h = harness(), state = snapshot();
    if (fault === "missing-source") state.marketRadar.snapshot = null;
    if (fault === "old-source") state.marketRadar.snapshot.generated_at = "2026-09-08T20:00:00.000Z";
    if (fault === "replay-source") state.marketRadar.source_record_id = "replay-shadow:20260909T190000Z:A1";
    h.setState(state);
    if (fault === "snapshot-read") h.failRead();
    if (["bad-hash", "missing-contract", "future-quote", "stale-quote"].includes(fault)) h.setCollect(() => {
      const row = evidence();
      if (fault === "bad-hash") row.evidence_id = "b".repeat(64);
      else {
        if (fault === "missing-contract") row.contracts = [];
        if (fault === "future-quote") row.contracts[0].as_of = "2026-09-10T14:01:00.000Z";
        if (fault === "stale-quote") row.contracts[0].as_of = "2026-09-10T13:55:00.000Z";
        const original = { ...row }; delete original.evidence_id; row.evidence_id = createHash("sha256").update(canonicalJson(original)).digest("hex");
      }
      return [row];
    });
    await h.runtime.runOnce();
    assert.ok(h.events.some((item) => item.event_type === "ATTEMPT"));
    assert.ok(h.events.every((item) => item.event_type !== "CREATED"));
    if (fault === "missing-source") {
      h.setState(snapshot()); h.setAt("2026-09-10T14:15:45.000Z"); await h.runtime.runOnce();
      assert.equal(h.events.filter((item) => item.event_type === "CREATED").length, 1);
    }
  });
});

test("daily PAPER retry offset survives restart, counts attempts once and resets on the next real day", async () => {
  const h = harness(); h.setCollect(() => []);
  assert.equal((await h.runtime.runOnce()).created, 0);
  assert.equal(h.collected[0].paperCandidateOffset, 0);
  assert.equal(h.events.filter((event) => event.event_type === "ATTEMPT").length, 2 * PAPER_DAILY_TARGET, "each missing ticket records the attempt and failure separately");
  h.setAt("2026-09-10T14:15:45.000Z");
  await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(h.collected[1].paperCandidateOffset, 3, "failure reason events do not double-count the candidate offset");
  h.setAt("2026-09-10T14:30:45.000Z"); h.setCollect(() => ["NVDA", "AAPL", "TSLA"].map((symbol) => evidence("2026-09-10T14:30:45.000Z", symbol)));
  assert.equal((await createPaperPlanRuntime(h.options).runOnce()).created, PAPER_DAILY_TARGET);
  assert.equal(h.collected[2].paperCandidateOffset, 6);
  await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(h.collected.length, 3); assert.equal(h.events.filter((event) => event.event_type === "CREATED").length, PAPER_DAILY_TARGET);
  h.setAt("2026-09-11T13:30:45.000Z"); h.setCollect(() => []);
  const state = snapshot(); state.marketRadar.snapshot.generated_at = "2026-09-10T20:00:00.000Z";
  state.outputs.A1_SHADOW_RESULT.observed_at = state.outputs.A1_SHADOW_RESULT.market_sources.generated_at = state.outputs.A1_SHADOW_RESULT.market_sources.as_of = "2026-09-11T13:30:45.000Z"; h.setState(state);
  await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(h.collected[3].paperCandidateOffset, 0, "a new trading date starts at the original priority");
});

test("Owner-only isolation and current-time boundary prevent friend/replay catch-up writes", async () => {
  const h = harness(), state = snapshot(); state.investmentKernel.profile_mode = "BLANK"; h.setState(state);
  assert.equal((await h.runtime.runOnce()).status, "NOT_OWNER"); assert.equal(h.events.length, 0); assert.equal(h.sessions.length, 0);
  h.setState(snapshot());
  assert.equal((await h.runtime.runOnce(new Date("2026-09-09T13:30:45.000Z"))).status, "NOT_CURRENT");
  assert.equal((await h.runtime.runOnce(new Date("2026-09-10T14:01:45.000Z"))).status, "NOT_CURRENT");
  assert.equal(h.events.length, 0);
});

test("a missing snapshot after creation records a gap on the original daily plan without new provider calls", async () => {
  const h = harness(); await h.runtime.runOnce(); h.setAt("2026-09-10T14:15:45.000Z"); h.failRead();
  assert.equal((await h.runtime.runOnce()).status, "SNAPSHOT_UNAVAILABLE");
  assert.equal(h.events.findLast((event) => event.plan_id === paperPlanId("2026-09-10")).event_type, "GAP");
  assert.equal(h.events.filter((event) => event.event_type === "ATTEMPT" && event.payload.reasons[0].startsWith("NO_SNAPSHOT")).length, 2);
  assert.equal(h.sessions.length, 1); assert.equal(h.events.filter((event) => event.event_type === "CREATED").length, 1);
});

test("a new trading day's missing snapshot records old active gaps and new attempts without changing originals", async () => {
  const h = harness(["NVDA", "AAPL", "TSLA"]); await h.runtime.runOnce();
  const original = structuredClone(h.events), oldIds = h.store.getActivePaperPlans().map((plan) => plan.plan_id);
  h.failRead(); h.setAt("2026-09-11T13:00:00.000Z");
  assert.equal((await h.runtime.runOnce()).recorded, 0, "premarket is not a missed regular-session sample");
  h.setAt("2026-09-11T13:30:45.000Z");
  const result = await createPaperPlanRuntime(h.options).runOnce(), added = h.events.slice(original.length);
  assert.equal(result.status, "SNAPSHOT_UNAVAILABLE"); assert.equal(result.recorded, 6);
  assert.deepEqual(added.filter((event) => event.event_type === "GAP").map((event) => event.plan_id), oldIds);
  assert.deepEqual(added.filter((event) => event.event_type === "ATTEMPT").map((event) => event.plan_id), [1, 2, 3].map((ordinal) => paperPlanId("2026-09-11", ordinal)));
  assert.ok(added.every((event) => event.recorded_at === "2026-09-11T13:30:45.000Z" && event.payload.reasons[0].startsWith("NO_SNAPSHOT")));
  assert.equal(h.events.filter((event) => event.event_type === "CREATED").length, 3);
  assert.equal(h.sessions.length, 1); assert.equal(h.quoteCalls.length, 0);
  assert.deepEqual(h.events.slice(0, original.length), original);
  h.setAt("2026-09-11T20:00:00.000Z"); assert.equal((await h.runtime.runOnce()).recorded, 0);
  const plan = h.store.getActivePaperPlans()[0];
  h.store.appendPaperPlanEvent(makePaperEvent(plan.plan_id, plan.expires_at, "ENDED", { reason: "EXPIRATION", ended_at: plan.expires_at, terminal_value: "UNKNOWN" }));
  h.setAt("2026-09-21T13:30:45.000Z"); const before = h.events.length;
  assert.equal((await h.runtime.runOnce()).recorded, 5);
  assert.equal(h.events.slice(before).filter((event) => event.event_type === "ENDED").length, 2, "missing snapshot still permits the guarded local observation deadline, without quotes");
  assert.ok(h.events.slice(before).every((event) => ["ATTEMPT", "ENDED"].includes(event.event_type)), "ended old plans receive no gap or fabricated expiry value");
});

test("missing snapshots cannot bypass the real non-Owner or read-only store guards", async () => {
  const h = harness(); await h.runtime.runOnce(); h.setAt("2026-09-11T13:30:45.000Z"); h.failRead();
  const original = structuredClone(h.events), blank = openSnapshotDatabase(":memory:", { investmentProfile: "BLANK" }), db = new DatabaseSync(":memory:");
  const readonly = openPaperPlanStore(db, { readOnly: true });
  try {
    for (const appendPaperPlanEvent of [blank.appendPaperPlanEvent, readonly.append]) {
      const runtime = createPaperPlanRuntime({ ...h.options, store: { ...h.store, appendPaperPlanEvent } });
      assert.equal((await runtime.runOnce()).recorded, 0);
      assert.deepEqual(h.events, original);
    }
    assert.deepEqual(blank.getPaperPlanEvents(paperPlanId("2026-09-11")), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='paper_plan_events'").get().n, 0);
    assert.equal(h.sessions.length, 1); assert.equal(h.quoteCalls.length, 0);
  } finally { blank.close(); db.close(); }
});

test("an advancing real clock freezes one identical creation timestamp for the plan and its immutable event", async () => {
  const h = harness(); let elapsed = 0;
  h.options.now = () => new Date(Date.parse(opening) + ++elapsed);
  assert.equal((await createPaperPlanRuntime(h.options).runOnce()).created, 1);
  const created = h.events.find((event) => event.event_type === "CREATED");
  assert.ok(elapsed > 3, "clock advanced between validation, collection and publication");
  assert.equal(created.recorded_at, created.payload.plan.created_at);
  assert.equal(created.payload.plan.reference.recorded_at, created.recorded_at);
  const proof = created.payload.plan.reference.proof;
  assert.ok(Date.parse(proof.requested_at) < Date.parse(proof.received_at));
  assert.ok(Date.parse(proof.received_at) < Date.parse(created.recorded_at));
  assert.equal(proof.quote.updated_at, opening, "retain the provider time, never substitute the advancing receipt clock");
});

test("quotes remain exact and fresh; zero bid is an observed bid, never confirmed zero or a closed case", async (t) => {
  for (const fault of ["read-failed", "wrong-contract", "future", "stale", "zero-bid"]) await t.test(fault, async () => {
    const h = harness(); await h.runtime.runOnce(); h.setAt("2026-09-10T14:15:45.000Z");
    if (fault === "read-failed") h.failQuote();
    if (fault === "wrong-contract") h.overrideQuote({ contract_id: "another-contract" });
    if (fault === "future") h.overrideQuote({ quoted_at: "2026-09-10T14:16:00.000Z" });
    if (fault === "stale") h.overrideQuote({ quoted_at: "2026-09-10T14:10:00.000Z" });
    if (fault === "zero-bid") h.overrideQuote({ bid: 0, ask: 0.01, mark: 0 });
    await h.runtime.runOnce();
    assert.equal(h.events.at(-1).event_type, fault === "zero-bid" ? "MARK" : "GAP");
    assert.ok(!h.events.some((item) => item.event_type === "ENDED"));
    assert.equal(h.store.getActivePaperPlans().length, 1);
    assert.equal(h.events.find((item) => item.event_type === "CREATED").payload.plan.reference.ask, 2);
  });
});

test("after an off-PC gap expiry ends at the recorded check, with unknown terminal value and no fabricated quote", async () => {
  const h = harness(); await h.runtime.runOnce(); h.setAt("2026-09-19T01:00:00.000Z");
  const result = await h.runtime.runOnce(), end = h.events.at(-1);
  assert.equal(result.ended, 1); assert.equal(end.event_type, "ENDED"); assert.equal(end.recorded_at, "2026-09-19T01:00:00.000Z");
  assert.equal(end.payload.ended_at, "2026-09-17T14:00:45.000Z"); assert.equal(end.payload.reason, "OBSERVATION_WINDOW"); assert.equal(end.payload.terminal_value, "UNKNOWN");
  assert.equal(h.quoteCalls.length, 0); assert.equal(h.collected.length, 1); assert.equal(h.store.getActivePaperPlans().length, 0);
});

test("overlapping natural callbacks do not collect or create twice", async () => {
  const h = harness(); let release;
  h.setCollect(() => new Promise((resolve) => { release = resolve; }));
  const first = h.runtime.runOnce(); await new Promise(setImmediate);
  assert.equal((await h.runtime.runOnce()).status, "OVERLAP_REJECTED");
  release([evidence()]); await first;
  assert.equal(h.collected.length, 1); assert.equal(h.events.filter((item) => item.event_type === "CREATED").length, 1);
});

test("old plans leave the queue at seven days; today's focus priority and daily research remain bounded and fair", async () => {
  for (const missingSnapshot of [false, true]) {
  const h = harness(["NVDA", "AAPL", "TSLA"]); await h.runtime.runOnce(); h.overrideQuote({ bid: 2.1, ask: 2.2 });
  const originals = h.events.filter((item) => item.event_type === "CREATED").map((item) => item.payload.plan), before = structuredClone(h.events), old = [];
  const dates = ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-08", "2026-09-09"];
  for (let index = 0; index < 31; index++) {
    const day = dates[Math.floor(index / 3)], plan = structuredClone(originals[index % 3]), at = `${day}T13:30:45.000Z`;
    Object.assign(plan, { plan_id: paperPlanId(day, index % 3 + 1), market_date: day, created_at: at });
    Object.assign(plan.reference, { quoted_at: at, recorded_at: at }); delete plan.reference.proof; delete plan.entry_policy; delete plan.entry_confirmation; delete plan.holding_intent; delete plan.next_session_forecast_review; plan.source.observed_at = at;
    h.store.appendPaperPlanEvent(makePaperEvent(plan.plan_id, at, "CREATED", { plan }));
    old.push(plan);
  }
  if (missingSnapshot) h.failRead();
  const observedType = missingSnapshot ? "GAP" : "MARK";
  assert.equal(h.store.getActivePaperPlans().length, 34);
  for (const [round, at] of ["14:15", "14:30", "14:45", "19:00", "19:15", "19:30", "19:45"].entries()) {
    h.setAt(`2026-09-10T${at}:45.000Z`); const start = h.events.length;
    await h.runtime.runOnce();
    const batch = h.events.slice(start).filter((event) => event.event_type === observedType);
    assert.ok(batch.length <= 8);
    assert.ok(originals.every((plan) => batch.some((event) => event.plan_id === plan.plan_id)), "today remains prioritized even after the previous GAP");
    assert.equal(h.store.getActivePaperPlans().length, 10, "24 old plans end without deleting history");
    if (round < 3) assert.equal(batch.length, 7, "research-only plans consume no morning slots");
  }
  for (const plan of old) {
    const own = h.events.filter((event) => event.plan_id === plan.plan_id);
    if (plan.market_date < "2026-09-04") assert.equal(own.filter((event) => event.event_type === "ENDED").length, 1);
    else if (plan.market_date === "2026-09-04") assert.equal(own.filter((event) => event.event_type === observedType).length, 1, "one research attempt per day, including GAP");
    else assert.ok(own.some((event) => event.event_type === observedType), "older focus plans retain fair turns");
  }
  assert.deepEqual(h.events.slice(0, before.length), before, "original prices and first records are unchanged");
  assert.equal(h.collected.length, 1, "existing daily case never reopens broad collection");
  assert.ok(h.quoteCalls.length <= 7 * 8, "the eight-case read ceiling is unchanged");
  if (missingSnapshot) assert.equal(h.quoteCalls.length, 0);
  }
});

test("unused today priority returns capacity and excess same-day records retain fair rotation without exceeding eight", async () => {
  for (const todayCount of [0, 1, 2, 3, 6]) {
    const h = harness(), original = buildPaperPlan([evidence()], opening).plan, today = Array.from({ length: todayCount }, (_, i) => ({ ...original, plan_id: `today-${i}` }));
    let active = [...Array.from({ length: 12 }, (_, i) => ({ ...original, plan_id: `older-${i}`, market_date: "2026-09-09" })), ...today];
    const observed = [], expired = { ...original, plan_id: "expired", expires_at: "2026-09-09T20:00:00Z" };
    h.failRead(); h.options.store = { getActivePaperPlans: () => [expired, ...active], getPaperPlanEvents: () => [{ event_type: "CREATED" }], appendPaperPlanEvent(event) {
      if (event.event_type === "ENDED") return;
      observed.push(event); const plan = active.find((row) => row.plan_id === event.plan_id); active = [...active.filter((row) => row !== plan), plan];
    } };
    const runtime = createPaperPlanRuntime(h.options);
    for (let round = 1; round <= 4; round++) {
      const priority = active.filter((row) => row.market_date === "2026-09-10").slice(0, 3).map((row) => row.plan_id);
      h.setAt(new Date(Date.parse(opening) + round * 900_000).toISOString()); await runtime.runOnce();
      const batch = observed.slice(-8); assert.equal(batch.length, 8); assert.ok(priority.every((id) => batch.some((event) => event.plan_id === id)));
      assert.equal(batch.filter((event) => event.plan_id.startsWith("older-")).length >= 8 - todayCount, true);
    }
    assert.equal(new Set(observed.map((event) => event.plan_id)).size, 12 + todayCount, "no old or excess same-day record is starved");
    assert.ok(observed.every((event) => event.event_type === "GAP" && event.plan_id !== "expired"));
    assert.equal(h.sessions.length, 0);
  }
});

test("three focused plus twelve settled plans fit four existing close-window slots, including failed attempts and restarts", async () => {
  for (const failure of ["none", "quote", "session", "snapshot"]) {
    const h = harness(["NVDA", "AAPL", "TSLA"]); await h.runtime.runOnce(); h.overrideQuote({ bid: 2.1, ask: 2.2 });
    const today = h.store.getActivePaperPlans(), old = [];
    for (const day of ["2026-09-03", "2026-09-04", "2026-09-08", "2026-09-09"]) for (let index = 0; index < 3; index++) {
      const plan = structuredClone(today[index]), created = `${day}T19:30:45.000Z`;
      Object.assign(plan, { plan_id: paperPlanId(day, index + 1), market_date: day, created_at: created });
      Object.assign(plan.reference, { quoted_at: created, recorded_at: created }); delete plan.reference.proof; delete plan.entry_policy; delete plan.entry_confirmation; delete plan.holding_intent; delete plan.next_session_forecast_review; plan.source.observed_at = created;
      h.store.appendPaperPlanEvent(makePaperEvent(plan.plan_id, created, "CREATED", { plan }));
      const stamp = `${day}T19:31:00.000Z`;
      h.store.appendPaperPlanEvent(makePaperEvent(plan.plan_id, stamp, "MARK", { quote: { contract_id: plan.contract.contract_id, symbol: plan.symbol, expiration: plan.contract.expiration, strike: plan.contract.strike, option_type: plan.contract.option_type, source: "ROBINHOOD", bid: 1, ask: 1.1, quoted_at: stamp }, estimated_return_pct: -50 }));
      old.push(plan);
    }
    const originalResults = structuredClone(projectPaperLearning(h.events).recent_results), start = h.events.length;
    if (failure === "quote") h.failQuote();
    if (failure === "snapshot") h.failRead();
    if (failure === "session") h.options.session = async () => { throw Error("synthetic MCP start failure"); };
    h.setAt("2026-09-10T14:15:45.000Z"); await createPaperPlanRuntime(h.options).runOnce();
    assert.ok(h.events.slice(start).every((event) => !old.some((plan) => plan.plan_id === event.plan_id)), "settled plans have no morning reads");
    const closeStart = h.events.length;
    for (const minute of ["00", "15", "30", "45"]) {
      h.setAt(`2026-09-10T19:${minute}:45.000Z`); const from = h.events.length;
      await createPaperPlanRuntime(h.options).runOnce();
      const samples = h.events.slice(from).filter((event) => ["MARK", "GAP"].includes(event.event_type));
      assert.ok(samples.length <= 8, failure); assert.ok(today.every((plan) => samples.some((event) => event.plan_id === plan.plan_id)), failure);
    }
    for (const plan of old) assert.equal(h.events.slice(closeStart).filter((event) => event.plan_id === plan.plan_id && ["MARK", "GAP"].includes(event.event_type)).length, 1, `${failure}/${plan.plan_id}`);
    for (const plan of old) assert.deepEqual(projectPaperLearning(h.events.filter((event) => event.plan_id === plan.plan_id)).recent_results[0], originalResults.find((row) => row.plan_id === plan.plan_id));
    assert.equal(h.collected.length, 1, "no extra candidate or model collection");
  }
});

test("research windows use the early close and archive unknown at deadline even when a quote returns too late", async () => {
  const h = harness(); await h.runtime.runOnce(); const plan = h.store.getActivePaperPlans()[0];
  const early = { ...plan, market_date: "2026-11-23", created_at: "2026-11-23T14:00:00.000Z", expires_at: "2026-12-04T21:00:00.000Z" };
  assert.equal(projectPaperTracking(early, [], "2026-11-27T16:59:59.999Z").research_due, false);
  assert.equal(projectPaperTracking(early, [], "2026-11-27T17:00:45.000Z").research_due, true);
  assert.equal(projectPaperTracking(early, [], "2026-11-27T18:00:45.000Z").research_due, false, "the existing close heartbeat does not loosen REGULAR quote rules");
  const cutoff = paperTrackingWindow(plan).ends_at;
  h.setCollect(() => []); h.setAt("2026-09-17T14:00:44.000Z");
  // An old first-three-day record is research-only at this time, so directly exercise a focus deadline at an earlier real expiry.
  const expires = "2026-09-14T20:00:00.000Z", dated = { ...plan, expires_at: expires, contract: { ...plan.contract, expiration: "2026-09-14" } };
  h.options.store.getActivePaperPlans = () => [dated]; h.options.store.getPaperPlanEvents = () => [];
  const output = []; h.options.store.appendPaperPlanEvent = (event) => output.push(event);
  h.options.quote = async () => { h.setAt(expires); return { contract_id: dated.contract.contract_id, bid: 2.1, ask: 2.2, quoted_at: "2026-09-14T19:59:59.000Z" }; };
  h.setAt("2026-09-14T19:59:59.000Z"); const result = await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(result.ended, 1); assert.equal(output.filter((event) => event.event_type === "MARK").length, 0);
  assert.equal(output.find((event) => event.event_type === "ENDED").payload.reason, "EXPIRATION");
  const db = new DatabaseSync(":memory:"), store = openPaperPlanStore(db);
  try {
    store.append(makePaperEvent(plan.plan_id, plan.created_at, "CREATED", { plan }));
    store.append(makePaperEvent(plan.plan_id, cutoff, "ENDED", { reason: "OBSERVATION_WINDOW", policy: "PAPER_TRACKING_WINDOW_V1", ended_at: cutoff, terminal_value: "UNKNOWN" }));
    assert.equal(store.learning().summary.unknown, 1); assert.equal(store.learning().summary.wins, 0); assert.equal(store.learning().summary.losses, 0);
  } finally { db.close(); }
});

test("quote failures retain bounded allowlisted session diagnostics and distinguish local writes without leaking raw errors", async () => {
  const secret = "Bearer synthetic-secret https://example.invalid/?token=never-log";
  for (const phase of ["MCP_STARTUP", "READ_QUOTE", "APPEND_MARK"]) {
    const h = harness(); await h.runtime.runOnce(); h.setAt("2026-09-10T14:15:45.000Z");
    const session = h.options.session, quote = h.options.quote, append = h.store.appendPaperPlanEvent;
    let timing;
    const emit = () => {
      for (const outcome of ["REMOTE_ERROR", "PROVIDER_ERROR", "TIMEOUT", "PROCESS_ERROR", "PROCESS_EXIT", "SESSION_CLOSED"]) timing({ event: "rpc_end", method: phase === "MCP_STARTUP" ? "thread/start" : "mcpServer/tool/call", ...(phase === "MCP_STARTUP" ? {} : { tool: "get_option_quotes" }), outcome, error: secret, arguments: secret });
      for (const fields of [{ method: secret }, { outcome: secret }, { method: "mcpServer/tool/call", tool: secret }]) timing({ event: "rpc_end", method: "initialize", outcome: "TIMEOUT", ...fields });
    };
    h.options.session = async (input, callback) => { assert.equal(input.timeoutMs, 20_000); timing = input.onTiming; if (phase === "MCP_STARTUP") { emit(); throw Error(secret); } return session(input, callback); };
    h.options.quote = async (...args) => { if (phase === "READ_QUOTE") { emit(); throw Error(secret); } return quote(...args); };
    h.store.appendPaperPlanEvent = (event) => { if (phase === "APPEND_MARK" && event.event_type === "MARK") throw Error(secret); return append(event); };
    const runtime = createPaperPlanRuntime(h.options); await runtime.runOnce();
    const reason = h.events.at(-1).payload.reasons[0];
    assert.equal(h.events.at(-1).event_type, "GAP"); assert.match(reason, new RegExp(`阶段=${phase}`)); assert.doesNotMatch(reason, /synthetic-secret|Bearer|token=|example.invalid/);
    assert.match(reason, /本会话RPC失败摘要=/);
    if (phase === "APPEND_MARK") assert.match(reason, /UNCLASSIFIED/);
    else { assert.equal(reason.split("本会话RPC失败摘要=")[1].split("|").length, 4); assert.doesNotMatch(reason, /REMOTE_ERROR|PROVIDER_ERROR/); assert.match(reason, /TIMEOUT/); }
    h.options.session = session; h.options.quote = quote; h.store.appendPaperPlanEvent = append;
    h.setAt("2026-09-10T14:30:45.000Z"); await runtime.runOnce(); assert.equal(h.events.at(-1).event_type, "MARK", "next natural callback recovers without another creation");
    assert.equal(h.events.filter((event) => event.event_type === "CREATED").length, 1);
  }
});

test("existing natural marks refresh entry conditions from local evidence without provider expansion or rewriting origin", async () => {
  const h = harness(), calls = [];
  h.setCollect(() => { const row = evidence(); row.bars.values = []; row.pattern = null; delete row.evidence_id; return [{ ...row, evidence_id: createHash("sha256").update(canonicalJson(row)).digest("hex") }]; });
  h.options.store.getPaperEntryMarketEvidence = (symbol, at) => {
    calls.push({ symbol, at }); if (at === opening) return null;
    const row = evidence(at, symbol); return { bars: row.bars, pattern: row.pattern, quote: row.quote, received_at: at, source_ref: "stored-A1-A2-fixture" };
  };
  const runtime = createPaperPlanRuntime(h.options); assert.equal((await runtime.runOnce()).created, 1);
  const origin = structuredClone(h.events.find((event) => event.event_type === "CREATED"));
  assert.equal(origin.payload.plan.entry_confirmation.status, "DATA_GAP");
  h.setAt("2026-09-10T14:15:45.000Z"); await runtime.runOnce();
  const latest = h.events.findLast((event) => event.event_type === "MARK");
  assert.equal(latest.payload.entry_confirmation.status, "CONFIRMED");
  assert.equal(latest.payload.entry_confirmation.market_evidence.source_ref, "stored-A1-A2-fixture");
  assert.deepEqual(h.events.find((event) => event.event_type === "CREATED"), origin);
  assert.equal(h.quoteCalls.length, 1); assert.equal(calls.length, 2);
});

test("a timed-out quote session records a gap once and cannot append a late callback after run completion", async () => {
  const h = harness(); await h.runtime.runOnce(); h.setAt("2026-09-10T14:15:45.000Z");
  let release;
  h.options.quote = () => new Promise((resolve) => { release = resolve; });
  h.options.session = async (_input, callback) => { void callback({}).catch(() => {}); await new Promise(setImmediate); throw Error("fixture timeout"); };
  await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(h.events.at(-1).event_type, "GAP"); const count = h.events.length;
  release({ contract_id: evidence().contracts[0].contract_id, bid: 2.6, ask: 2.7, mark: 2.65, quoted_at: "2026-09-10T14:15:45.000Z" });
  await new Promise(setImmediate);
  assert.equal(h.events.length, count, "late quote cannot write outside its completed check");
});

function historyResponse(plans, args, change = () => {}) {
  const results = args.instrument_ids.map((id) => {
    const plan = plans.find((value) => value.contract.contract_id === id);
    return { instrument_id: id, symbol: plan.symbol,
      occ_symbol: `${plan.symbol} ${plan.contract.expiration.slice(2).replaceAll("-", "")}${plan.contract.option_type === "call" ? "C" : "P"}${String(Math.round(plan.contract.strike * 1_000)).padStart(8, "0")}`,
      interval: "5minute", bounds: "regular", bars: [{ begins_at: args.start_time, open_price: "19.750000", high_price: "19.750000", low_price: "19.750000", close_price: "19.750000", session: "reg", interpolated: false }] };
  }).reverse();
  const data = { results }; change(data, args);
  return { content: [], structuredContent: { data } };
}

test("natural PAPER checks persist exact five-minute chart closes and restore entry cache without changing original costs or fixed losses", async () => {
  const h = harness(["NVDA", "AAPL", "TSLA"]); await h.runtime.runOnce();
  const originals = structuredClone(h.events), plans = h.store.getActivePaperPlans(), calls = [];
  h.options.session = async (_input, callback) => callback({ async call(tool, args) {
    if (tool !== "get_option_historicals") return h.session.call(tool, args);
    assert.equal(tool, "get_option_historicals"); calls.push(args); return historyResponse(plans, args);
  } });
  h.overrideQuote({ bid: 1.2, ask: 1.3, mark: 1.25 }); h.setAt("2026-09-10T14:15:45.000Z");
  await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(calls.length, 2); assert.ok(calls.every((args) => args.instrument_ids.length === 3 && Date.parse(args.end_time) - Date.parse(args.start_time) === 300_000));
  for (const event of h.events.filter((event) => event.event_type === "MARK")) {
    assert.equal(event.payload.chart.status, "AVAILABLE");
    assert.equal(event.payload.chart.entry.begins_at, "2026-09-10T14:00:00.000Z");
    assert.equal(event.payload.chart.entry.ends_at, "2026-09-10T14:05:00.000Z");
    assert.equal(event.payload.chart.latest.ends_at, "2026-09-10T14:15:00.000Z");
    assert.equal(event.payload.chart.entry.close, 19.75, "chart close is kept even when OHLC are identical; never authenticate BBO by the range");
    assert.equal(event.payload.quote.mark, 1.25); assert.equal(event.payload.estimated_return_pct, -40);
  }
  const fixed = structuredClone(projectPaperLearning(h.events).recent_results);
  assert.ok(fixed.every((row) => row.status === "LOSS"));
  calls.length = 0; h.setAt("2026-09-10T19:00:45.000Z"); h.overrideQuote({ bid: 3.6, ask: 3.7, mark: 3.65 });
  await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(calls.length, 1, "persisted entry chart is reused after restart; no entry refetch");
  assert.deepEqual(projectPaperLearning(h.events).recent_results, fixed);
  assert.deepEqual(h.events.slice(0, originals.length), originals);
  assert.equal(h.events.at(-1).payload.estimated_return_pct, 80);
  calls.length = 0; h.setAt("2026-09-11T19:00:45.000Z"); h.setCollect(() => []); h.options.session = async (_input, callback) => callback({ call: async (tool, args) => { if (tool !== "get_option_historicals") return h.session.call(tool, args); throw Error("historical provider unavailable"); } });
  await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(h.events.at(-1).event_type, "MARK", "history failure never creates a business quote GAP");
  assert.equal(h.events.at(-1).payload.chart.status, "PARTIAL");
  assert.equal(h.events.at(-1).payload.chart.latest, null);
  assert.equal(h.events.at(-1).payload.chart.latest_issue, "READ_FAILED");
  assert.equal(h.events.at(-1).payload.chart.entry_issue, undefined, "valid cached entry has no failure label");
  assert.deepEqual(projectPaperLearning(h.events).recent_results, fixed);
});

test("chart reconciliation rejects wrong, ambiguous, interpolated or unfinished buckets and rotates unavailable old-entry groups", async () => {
  const h = harness(["NVDA", "AAPL", "TSLA"]); await h.runtime.runOnce();
  const plans = h.store.getActivePaperPlans().map((plan, index) => ({ ...plan, reference: { ...plan.reference, quoted_at: new Date(Date.parse(opening) + index * 300_000).toISOString() } }));
  const now = () => new Date("2026-09-10T14:30:45.000Z");
  for (const fault of ["id", "duplicate-id", "symbol", "occ", "interval", "bounds", "interpolated", "duplicate-bar", "other-bar", "bad-ohlc", "not-found"]) {
    const session = { call: async (_tool, args) => historyResponse(plans, args, (data) => {
      for (const row of data.results) {
        if (fault === "id") row.instrument_id = "wrong-id";
        if (fault === "symbol") row.symbol = "WRONG";
        if (fault === "occ") row.occ_symbol = row.occ_symbol.replace("C", "P");
        if (fault === "interval") row.interval = "minute";
        if (fault === "bounds") row.bounds = "24_5";
        if (fault === "interpolated") row.bars[0].interpolated = true;
        if (fault === "duplicate-bar") row.bars.push({ ...row.bars[0] });
        if (fault === "other-bar") row.bars[0].begins_at = args.end_time;
        if (fault === "bad-ohlc") row.bars[0].low_price = "99";
      }
      if (fault === "duplicate-id") data.results.push(...structuredClone(data.results));
      if (fault === "not-found") data.not_found = [...args.instrument_ids];
    }) };
    const charts = await collectPaperCharts(session, plans, new Map(), 0, now);
    assert.ok([...charts.values()].every((chart) => chart.status === "UNAVAILABLE"), fault);
    assert.ok([...charts.values()].every((chart) => chart.latest_issue === (["id", "other-bar", "not-found"].includes(fault) ? "NOT_FOUND" : "INVALID_BAR")), fault);
    assert.ok([...charts].every(([id, chart]) => paperChartComparison(plans.find((plan) => plan.plan_id === id), chart, now().getTime()) === null), "invalid or absent data never produces a chart return");
  }
  const mixed = await collectPaperCharts({ call: async (_tool, args) => historyResponse(plans, args, (data) => {
    data.results = data.results.filter((row) => row.instrument_id !== plans[2].contract.contract_id);
    const invalid = data.results.find((row) => row.instrument_id === plans[1].contract.contract_id);
    if (invalid) invalid.bars[0].low_price = "99";
  }) }, plans, new Map(), 0, now);
  assert.equal(mixed.get(plans[0].plan_id).status, "AVAILABLE", "one rejected or missing contract must not discard a valid sibling");
  assert.equal(mixed.get(plans[1].plan_id).latest_issue, "INVALID_BAR");
  assert.equal(mixed.get(plans[2].plan_id).latest_issue, "NOT_FOUND");
  const calls = [], entries = new Map(), session = { call: async (_tool, args) => {
    calls.push(args); return historyResponse(plans, args, (data) => { if (args.start_time === "2026-09-10T14:00:00.000Z") data.results = []; });
  } };
  const first = await collectPaperCharts(session, plans, entries, 0, now);
  assert.equal(first.get(plans[0].plan_id).entry, null);
  assert.equal(first.get(plans[0].plan_id).entry_issue, "NOT_FOUND");
  assert.equal(first.get(plans[1].plan_id).entry_issue, "WAIT_ROTATION");
  const second = await collectPaperCharts(session, plans, entries, 1, now);
  assert.equal(second.get(plans[1].plan_id).entry.begins_at, "2026-09-10T14:05:00.000Z", "unavailable first group does not starve the other original buckets");
  assert.ok(calls.every((args) => Date.parse(args.end_time) - Date.parse(args.start_time) === 300_000));
  calls.length = 0;
  const openingCharts = await collectPaperCharts(session, plans, entries, 0, () => new Date("2026-09-10T13:30:59.000Z"));
  assert.equal(calls.length, 0, "no completed regular bar exists yet; do not request an unfinished opening bucket");
  assert.ok([...openingCharts.values()].every((chart) => chart.entry_issue === "NO_COMPLETED_BAR" && chart.latest_issue === "NO_COMPLETED_BAR"));
});

test("PAPER-only quote proof preserves selected raw strings and exact IDs without whole batches or private fields", async () => {
  const h = harness(["NVDA", "AAPL", "TSLA"]); await h.runtime.runOnce();
  const plans = h.store.getActivePaperPlans(), now = () => new Date(opening), raw = plans.map((plan) => ({
    id: plan.contract.contract_id, chain_id: plan.contract.chain_id, chain_symbol: plan.symbol, underlying_type: "equity", expiration_date: plan.contract.expiration, strike_price: "150.0000", type: "call", state: "active", tradability: "tradable", trade_value_multiplier: "100.0000", private_payload: "do-not-copy",
  }));
  const session = { call: async (tool) => ({ content: [], structuredContent: { data: tool === "get_option_instruments" ? { instruments: raw } : { results: raw.map((row, index) => ({ quote: {
    instrument_id: row.id, bid_price: `${1.9 + index}`, ask_price: `${2 + index}`, mark_price: `${1.95 + index}`, updated_at: "2026-09-10T14:00:45.000Z", private_payload: "do-not-copy",
  } })).reverse() } } }) };
  const capture = capturePaperQuoteEvidence(session, now);
  await capture.session.call("get_option_instruments", {}); await capture.session.call("get_option_quotes", { instrument_ids: plans.map((plan) => plan.contract.contract_id) });
  for (const [index, plan] of plans.entries()) {
    const quote = { bid: 1.9 + index, ask: 2 + index, mark: 1.95 + index, quoted_at: opening }, proof = capture.proof(plan, quote, opening);
    assert.equal(proof.instrument.id, plan.contract.contract_id); assert.equal(proof.quote.ask_price, `${2 + index}`);
    assert.equal(proof.quote.updated_at, "2026-09-10T14:00:45.000Z");
    assert.equal(proof.requested_at, opening); assert.equal(proof.received_at, opening);
    assert.ok(!JSON.stringify(proof).includes("private_payload"));
    assert.equal(capture.proof(plan, { ...quote, ask: 999 }, opening), undefined);
  }
  const duplicate = capturePaperQuoteEvidence({ call: async () => ({ content: [], structuredContent: { data: { instruments: [raw[0], raw[0]] } } }) }, now);
  await assert.rejects(duplicate.session.call("get_option_instruments", {}), /DUPLICATE_OR_MISSING_IDENTITY/);
});

test("the natural runtime freezes captured proof on new CREATED and later MARK events without changing formal collector inputs", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(opening) });
  const symbols = ["NVDA", "AAPL", "TSLA"], h = harness(symbols);
  let tracking = false;
  const instruments = symbols.map((symbol) => {
    const c = evidence(opening, symbol).contracts[0];
    return { ...c.instrument, id: c.contract_id, underlying_type: "equity", strike_price: "150.0000", trade_value_multiplier: "100.0000" };
  });
  h.options.session = async (_input, callback) => callback({ call: async (tool, args) => {
    if (tool === "get_option_historicals") return historyResponse(h.store.getActivePaperPlans(), args);
    const data = tool === "get_option_instruments" ? { instruments: instruments.filter((row) => row.chain_symbol === args.chain_symbol) }
      : { results: args.instrument_ids.map((id) => ({ quote: { instrument_id: id, bid_price: tracking ? "2.600000" : "1.910000", ask_price: tracking ? "2.700000" : "2.000000", mark_price: tracking ? "2.650000" : "1.950000", updated_at: new Date().toISOString(), private_payload: "never retained" } })).reverse() };
    return { content: [], structuredContent: { data } };
  } });
  h.options.collect = async (session, input) => {
    assert.equal(input.paperResearch, true);
    const values = symbols.map((symbol) => evidence(opening, symbol));
    for (const value of values) await session.call("get_option_instruments", { chain_symbol: value.symbol, expiration_dates: value.contracts[0].expiration });
    await session.call("get_option_quotes", { instrument_ids: values.map((value) => value.contracts[0].contract_id) });
    return values;
  };
  delete h.options.quote;
  await createPaperPlanRuntime(h.options).runOnce();
  const originals = structuredClone(h.events.filter((event) => event.event_type === "CREATED"));
  assert.equal(originals.length, 3);
  for (const event of originals) {
    assert.equal(event.payload.plan.reference.mark, 1.95);
    assert.equal(event.payload.plan.reference.proof.quote.ask_price, "2.000000");
    assert.equal(event.payload.plan.reference.proof.instrument.id, event.payload.plan.contract.contract_id);
  }
  tracking = true; h.setAt("2026-09-10T14:15:45.000Z"); context.mock.timers.setTime(Date.parse("2026-09-10T14:15:45.000Z"));
  await createPaperPlanRuntime(h.options).runOnce();
  assert.equal(h.events.filter((event) => event.event_type === "MARK").length, 3);
  for (const event of h.events.filter((event) => event.event_type === "MARK")) {
    assert.equal(event.payload.quote.mark, 2.65); assert.equal(event.payload.quote.proof.quote.bid_price, "2.600000");
    assert.equal(event.payload.quote.proof.quote.instrument_id, event.payload.quote.contract_id);
    assert.ok(!JSON.stringify(event).includes("never retained"));
  }
  assert.deepEqual(h.events.filter((event) => event.event_type === "CREATED"), originals);
});

test("new CREATED and MARK writes require matching captured raw proof even with injected collectors; legacy tickets stay unchanged", async () => {
  for (const tracking of [false, true]) for (const fault of ["no-rpcs", "missing-instrument", "symbol", "expiry", "strike", "side", "multiplier", "missing-quotes", "quote-id", "bid", "ask", "mark", "missing-updated-at", "different-updated-at", "future-updated-at"]) {
    const h = harness();
    if (tracking) {
      const { plan } = buildPaperPlan([evidence()], opening, 1);
      assert.equal(plan.reference.proof, undefined, "legacy records remain valid without the new proof");
      h.store.appendPaperPlanEvent(makePaperEvent(plan.plan_id, opening, "CREATED", { plan }));
      h.setAt("2026-09-10T14:15:45.000Z"); h.setCollect(() => []);
    }
    const original = structuredClone(h.events), call = h.session.call, quote = h.options.quote;
    if (fault === "no-rpcs") {
      if (tracking) h.options.quote = async () => ({ contract_id: evidence().contracts[0].contract_id, bid: 2.6, ask: 2.7, mark: 2.65, quoted_at: "2026-09-10T14:15:45.000Z" });
      else h.options.collect = async () => [evidence()];
    } else h.session.call = async (tool, args) => {
      const response = await call(tool, args), data = response.structuredContent.data;
      if (tool === "get_option_instruments") {
        if (fault === "missing-instrument") data.instruments = [];
        for (const row of data.instruments) {
          if (fault === "symbol") row.chain_symbol = "WRONG";
          if (fault === "expiry") row.expiration_date = "2026-09-25";
          if (fault === "strike") row.strike_price = "151.0000";
          if (fault === "side") row.type = "put";
          if (fault === "multiplier") row.trade_value_multiplier = "10";
        }
      } else if (tool === "get_option_quotes") {
        if (fault === "missing-quotes") data.results = [];
        for (const { quote } of data.results) {
          if (fault === "quote-id") quote.instrument_id = "wrong-contract";
          if (["bid", "ask", "mark"].includes(fault)) quote[`${fault}_price`] = "999.000000";
          if (fault === "missing-updated-at") delete quote.updated_at;
          if (fault === "different-updated-at") quote.updated_at = new Date(Date.parse(quote.updated_at) - 1_000).toISOString();
          if (fault === "future-updated-at") quote.updated_at = new Date(Date.parse(quote.updated_at) + 1_000).toISOString();
        }
      }
      return response;
    };
    const result = await createPaperPlanRuntime(h.options).runOnce(), added = h.events.slice(original.length);
    assert.equal(result.created, 0, `${tracking}/${fault}`);
    assert.ok(added.every((event) => !["CREATED", "MARK", "ENDED"].includes(event.event_type)), `${tracking}/${fault}`);
    assert.ok(added.some((event) => event.event_type === (tracking ? "GAP" : "ATTEMPT") && event.payload.reasons.some((reason) => reason.startsWith("QUOTE_PROOF_MISSING"))), `${tracking}/${fault}`);
    assert.deepEqual(h.events.slice(0, original.length), original);
    if (tracking) {
      assert.equal(projectPaperLearning(h.events).summary.pending, 1, "unproven profitable prices cannot settle the legacy ticket");
      h.session.call = call; h.options.quote = quote; h.setAt("2026-09-10T14:30:45.000Z");
      await createPaperPlanRuntime(h.options).runOnce();
      assert.equal(h.events.at(-1).event_type, "MARK"); assert.ok(h.events.at(-1).payload.quote.proof);
      assert.equal(projectPaperLearning(h.events).summary.wins, 1, "the next proven sample can settle the original legacy ticket");
      assert.deepEqual(h.events.slice(0, original.length), original);
    }
  }
});

test("a hanging entry-history RPC reaches the auxiliary ceiling while successful latest history and fresh MARKs survive", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(opening) });
  const h = harness(["NVDA", "AAPL", "TSLA"]); await h.runtime.runOnce();
  h.setAt("2026-09-10T14:15:45.000Z"); context.mock.timers.setTime(Date.parse("2026-09-10T14:15:45.000Z"));
  h.options.now = () => new Date();
  const plans = h.store.getActivePaperPlans(), calls = []; let release;
  h.options.session = async (_input, callback) => callback({ call: (tool, args) => {
    if (tool !== "get_option_historicals") return h.session.call(tool, args);
    assert.equal(tool, "get_option_historicals"); calls.push(args);
    return args.start_time === "2026-09-10T14:00:00.000Z" ? new Promise((resolve) => { release = () => resolve(historyResponse(plans, args)); }) : Promise.resolve(historyResponse(plans, args));
  } });
  const run = createPaperPlanRuntime(h.options).runOnce(); await new Promise(setImmediate);
  assert.equal(calls.length, 2); context.mock.timers.tick(10_000); await run;
  const marks = h.events.filter((event) => event.event_type === "MARK");
  assert.equal(marks.length, 3); assert.equal(h.events.filter((event) => event.event_type === "GAP").length, 0);
  assert.ok(marks.every((event) => event.payload.chart.status === "PARTIAL" && event.payload.chart.latest && event.payload.chart.entry === null));
  assert.ok(marks.every((event) => event.payload.chart.entry_issue === "TIMEOUT" && event.payload.chart.latest_issue === undefined));
  assert.ok(marks.every((event) => Date.parse(event.payload.chart.checked_at) <= Date.parse(event.recorded_at)));
  const frozen = structuredClone(h.events); release(); await new Promise(setImmediate);
  assert.deepEqual(h.events, frozen, "late historical response cannot append or mutate an already written event");
});

test("valid history arriving after five seconds remains usable within the ten-second auxiliary ceiling", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse(opening) });
  const h = harness(); await h.runtime.runOnce();
  const plans = h.store.getActivePaperPlans(); context.mock.timers.setTime(Date.parse("2026-09-10T14:15:45.000Z"));
  let calls = 0;
  const pending = collectPaperCharts({ call: (_tool, args) => { calls++; return new Promise((resolve) => setTimeout(() => resolve(historyResponse(plans, args)), 6_000)); } }, plans, new Map(), 0, () => new Date());
  context.mock.timers.tick(6_000);
  const charts = await pending, chart = charts.get(plans[0].plan_id);
  assert.equal(calls, 2); assert.equal(chart.status, "AVAILABLE");
  assert.equal(chart.entry_issue, undefined); assert.equal(chart.latest_issue, undefined);
  assert.equal(paperChartComparison(plans[0], chart, Date.now()).return_pct, 0);
  for (const invalid of [{ ...chart, latest_issue: "TIMEOUT" }, { ...chart, latest: null, status: "PARTIAL", latest_issue: "unbounded provider text" }]) {
    assert.equal(paperChartComparison(plans[0], invalid, Date.now()), null, "inconsistent or unbounded failure labels cannot validate a chart");
  }
});


test("global formal-entry risks remain warnings while daily research collects real evidence and tracks old plans", async () => {
  for (const fault of ['stale-a1','future-a1','stale-market','future-market','stale-macro','future-macro','market-unavailable','critical','precise-event']) {
    const h=harness(['NVDA']), state=snapshot();
    const a1=state.outputs.A1_SHADOW_RESULT;
    if(fault.endsWith('a1'))a1.observed_at=fault.startsWith('stale')?'2026-09-10T13:30:44.000Z':'2026-09-10T14:01:00.000Z';
    if(fault.endsWith('market'))a1.market_sources.as_of=fault.startsWith('stale')?'2026-09-10T13:30:44.000Z':'2026-09-10T14:01:00.000Z';
    if(fault.includes('macro')||fault==='precise-event')a1.official_macro={status:'LIVE',collected_at:opening,as_of:opening,context_hash:'b'.repeat(64),events:[]};
    if(fault.endsWith('macro'))a1.official_macro.as_of=fault.startsWith('stale')?'2026-09-10T13:30:44.000Z':'2026-09-10T14:01:00.000Z';
    if(fault==='precise-event')a1.official_macro.events=[{release_name:'CPI',category:'inflation',time_precision:'EXACT',scheduled_at:'2026-09-10T15:00:00.000Z',source_url:'https://www.bls.gov/schedule/'}];
    if(fault==='market-unavailable')a1.market_sources.status='DATA_BLOCKED';
    if(fault==='critical')state.selfCheck.active=[{severity:'CRITICAL',title:'clock trust failed'}];
    h.setCollect((input) => {
      const row = evidence(); row.global_risk = input.global_risk; delete row.evidence_id;
      return [{ ...row, evidence_id: createHash("sha256").update(canonicalJson(row)).digest("hex") }];
    });
    h.setState(state);assert.equal((await h.runtime.runOnce()).created,1,fault);assert.equal(h.sessions.length,1,fault);
    const plan=h.events.find(e=>e.event_type==='CREATED').payload.plan;
    assert.match(plan.warnings.join(';'),/核心标的行情|宏观风险|90 分钟|clock trust failed/,fault);
    assert.deepEqual(plan.entry_policy.evidence.global_risk,h.collected[0].global_risk,'warnings retain original risk evidence');
  }
  const h=harness();assert.equal((await h.runtime.runOnce()).created,1,'current own-stock confirmation needs no index A2 or account approval');
  assert.deepEqual(h.collected[0].global_risk.critical_blockers,[]);
  const original=structuredClone(h.events.find(e=>e.event_type==='CREATED'));
  h.setAt('2026-09-10T14:45:45.000Z');const outcome=await h.runtime.runOnce();
  assert.equal(outcome.created,0);assert.equal(outcome.checked,1);assert.equal(h.collected.length,2,'research continues its own real-data reads despite stale index risk');
  assert.ok(h.events.some(e=>e.event_type==='MARK'));assert.deepEqual(h.events.find(e=>e.event_type==='CREATED'),original);
});

test("index and unclassified incidents remain frozen warnings instead of cancelling daily research", async () => {
  const incident = { severity: "CRITICAL", layer: "AGENT", code: "AGENT_UPSTREAM_BLOCKED", title: "index input blocked",
    details: { capability: "AGENT_INPUT", evidence_scope: "FROZEN_SLOT", owner_required: false, agent_ids: ["TS"] } };
  for (const details of [incident.details, undefined]) {
    const h = harness(), state = snapshot();
    state.selfCheck.active = [{ ...structuredClone(incident), details }];
    h.setCollect((input) => {
      const row = evidence(); row.global_risk = input.global_risk; delete row.evidence_id;
      return [{ ...row, evidence_id: createHash("sha256").update(canonicalJson(row)).digest("hex") }];
    });
    const before = structuredClone(state.selfCheck); h.setState(state);
    assert.equal((await h.runtime.runOnce()).created, 1);
    assert.deepEqual(h.collected[0].global_risk.critical_blockers, [incident.title]);
    assert.ok(h.events.find((event) => event.event_type === 'CREATED').payload.plan.warnings.includes(incident.title));
    assert.deepEqual(state.selfCheck, before, "original incident evidence is unchanged");
  }
});

test("event risk is saved on a daily research plan without discarding the candidate or changing old tracking rules", async () => {
  const h=harness(['NVDA','AAPL','TSLA']);h.setState(earningsSnapshot(opening,'2026-09-10','DMH'));
  assert.equal((await h.runtime.runOnce()).created,3);
  assert.deepEqual(h.events.filter(e=>e.event_type==='CREATED').map(e=>e.payload.plan.symbol),['NVDA','AAPL','TSLA']);
  assert.match(h.events.find(e=>e.event_type==='CREATED').payload.plan.warnings.join(';'),/PAPER_EVENT_RISK.*NVDA.*财报/);
  assert.equal(h.collected.length,1);assert.equal(h.sessions.length,1);
  const original=structuredClone(h.events.find(e=>e.event_type==='CREATED'));
  h.setAt('2026-09-10T14:15:45.000Z');h.setState(earningsSnapshot('2026-09-10T14:15:45.000Z','2026-09-10','DMH'));h.overrideQuote({bid:2.1,ask:2.2});
  await h.runtime.runOnce();
  assert.equal(h.events.findLast(e=>e.event_type==='MARK'&&e.plan_id===original.plan_id).payload.risk_exit.reason,'EARNINGS_WINDOW');
  assert.deepEqual(h.events.find(e=>e.event_type==='CREATED'),original);
});
