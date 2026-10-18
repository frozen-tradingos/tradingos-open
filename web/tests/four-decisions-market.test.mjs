import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ownerSnapshotView } from "../server/local-owner-server.ts";
import { buildTsForecastDisplay, resolveTsForecastContext } from "../app/ts-forecast-state.ts";

const at = "2026-09-04T17:00:00.000Z";
const row = (symbol, state = "OBSERVING") => ({ symbol, status: "LIVE", as_of: at, direction: "BULLISH", no_chase: false, swing: { direction: "BULLISH", why_watch: ["已冻结的多周期观察理由"], next_check: "下一自然TS槽", invalidation: "原始失效说明", management: { state, archive_status: "ACTIVE", state_reason: "原始状态理由", entry_trigger: 101, price_invalidation: 98, target_1: 105, next_check: "下一自然TS槽", missing_confirmation: ["期权与事件门禁未完成"] } } });
const radar = { generated_at: at, fixed_pool: { candidates: ["AVGO", "NVDA", "AAPL", "TSLA", "DELL"], rows: [row("AVGO", "HOLDING"), row("NVDA"), row("AAPL"), row("TSLA"), row("DELL"), row("SPY"), row("QQQ")], missing_symbols: [], missing_gates: ["交易门禁未完成"] }, real_positions: { status: "OBSERVED", symbols: ["AVGO"] }, earnings_center: { items: [{ symbol: "TSLA" }] }, event_scan: { items: [] }, provenance: [] };

test("home retains only three existing non-holding candidates, SPY/QQQ and the latest real position check", () => {
  const positionCheck = { slot_id: "position-latest", kind: "POSITION_MONITOR" };
  const state = { payload: null, recentOutputs: [], runLedger: { runs: [] }, selfCheck: { recent: [] }, marketIntelligence: { events: [], causalChains: [] }, scheduler: { groups: [], recent: [] }, marketRadar: { snapshot: structuredClone(radar) }, tsSettlement: { exclusions: [], recent: [] }, optionLifecycle: { recent_settlements: [] }, ownerTrigger: { current: {} }, spxwProxy: { watches: [], real_holdings: [], owner_observations: [] }, externalExpert: { cases: [] }, outputs: { TS_OUTPUT: [], TS_SHADOW_OUTPUT: [], A1_SHADOW_RESULT: null, OPTION_STRATEGY_SIGNAL: [], POSITION_COPILOT_STATE: [], SCHEDULE_CHECKPOINT: [...Array.from({ length: 5 }, (_, i) => ({ slot_id: `guard-${i}`, kind: "CODEX_MANAGER" })), positionCheck, { slot_id: "evening", kind: "EVENING_ANALYSIS" }] } };
  const orders = Array.from({ length: 12 }, (_, i) => ({ order_id: `order-${i}` }));
  state.outputs.A1_SHADOW_RESULT = { market_sources: { bars: [{ symbol: "SPY" }], options: [{ symbol: "SPY" }], account: { positions: [{ symbol: "SPY" }], orders } } };
  const before = JSON.stringify(state), home = ownerSnapshotView(state, "home");
  assert.deepEqual(home.marketRadar.snapshot.fixed_pool.candidates, ["NVDA", "AAPL", "TSLA"]);
  assert.deepEqual(home.marketRadar.snapshot.fixed_pool.rows.map((item) => item.symbol), ["NVDA", "AAPL", "TSLA", "SPY", "QQQ"]);
  assert.equal(home.outputs.SCHEDULE_CHECKPOINT.some((item) => item.slot_id === positionCheck.slot_id), true);
  assert.equal(new Set(home.outputs.SCHEDULE_CHECKPOINT.map((item) => item.slot_id)).size, home.outputs.SCHEDULE_CHECKPOINT.length);
  assert.deepEqual(home.outputs.A1_SHADOW_RESULT.market_sources.account.orders, []);
  const options = ownerSnapshotView(state, "options");
  assert.deepEqual(options.outputs.A1_SHADOW_RESULT.market_sources.account.orders, orders.slice(0, 10));
  assert.deepEqual(options.outputs.A1_SHADOW_RESULT.market_sources.account.positions, []);
  assert.deepEqual(options.outputs.A1_SHADOW_RESULT.market_sources.bars, []);
  assert.deepEqual(options.outputs.A1_SHADOW_RESULT.market_sources.options, []);
  assert.equal(JSON.stringify(state), before);
});

test("observation projection keeps frozen reasons and never promotes stale or incomplete research into a trade", async () => {
  const { ownerObservationRows, ownerObservationDetail } = await import("../app/owner-market-decisions.ts");
  assert.deepEqual(ownerObservationRows(radar).map((item) => item.symbol), ["NVDA", "AAPL", "TSLA"]);
  const invalidated = structuredClone(radar); invalidated.fixed_pool.rows.find((item) => item.symbol === "NVDA").swing.stage = "INVALIDATED";
  assert.deepEqual(ownerObservationRows(invalidated).map((item) => item.symbol), ["AAPL", "TSLA", "DELL"]);
  const source = row("NVDA"), before = JSON.stringify(source);
  const fresh = ownerObservationDetail(source, at);
  assert.equal(fresh.quoteFresh, true); assert.match(fresh.status, /未获交易批准/);
  assert.equal(fresh.reason, "已冻结的多周期观察理由"); assert.equal(fresh.trigger, 101); assert.equal(fresh.invalidation, 98); assert.equal(fresh.target, 105);
  for (const staleAt of ["2026-09-04T17:07:01.000Z", "2026-09-04T16:59:59.000Z"]) assert.equal(ownerObservationDetail(source, staleAt).quoteFresh, false);
  assert.equal(ownerObservationDetail(source, "2026-09-04T17:07:00.000Z").quoteFresh, true);
  assert.equal(ownerObservationDetail(source, at, true).quoteFresh, false);
  const incomplete = structuredClone(source); incomplete.swing.management.entry_trigger = null; incomplete.swing.management.target_1 = null;
  const gaps = ownerObservationDetail(incomplete, at);
  assert.match(gaps.status, /条件未齐/); assert.equal(gaps.trigger, null); assert.equal(gaps.target, null);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(ownerObservationRows(undefined), []);
});

test("market summary only uses the supplied authoritative frozen forecast and preserves counter-evidence", async () => {
  const { ownerMarketDecision } = await import("../app/owner-market-decisions.ts");
  const ts = { one_line_forecast: "SPY偏多，QQQ仍弱", current_pattern: { summary: "指数分化" }, path_bias: "RANGE", symbol_outlooks: { SPY: { direction: "BULLISH", summary: "SPY原始理由" }, QQQ: { direction: "BEARISH", summary: "QQQ原始理由" } }, evidence_snapshot: { run_id: "frozen-only", market_time: { observed_at: at } }, scenarios: { main: { invalidation: { conditions: [{ symbol: "SPY", metric: "LAST_PRICE", operator: "BELOW", value: 98, upper_value: null, confirmation: "ONE_5M_CLOSE" }] } } }, most_likely_mistake: "SPY上涨不能延续", next_validation: { at: "2026-09-04T17:30:00.000Z" } };
  const before = JSON.stringify(ts), decision = ownerMarketDecision(ts);
  assert.equal(decision.summary, ts.one_line_forecast); assert.equal(decision.pattern, "指数分化");
  assert.deepEqual(decision.symbols.map((item) => item.direction), ["BULLISH", "BEARISH"]);
  assert.match(decision.falsifiers, /SPY.*98/); assert.equal(decision.mistake, ts.most_likely_mistake);
  const all = structuredClone(ts); all.scenarios.main.invalidation.logic = "ALL";
  assert.match(ownerMarketDecision(all).falsifiers, /条件同时出现/);
  all.scenarios.main.invalidation.logic = "ANY";
  assert.match(ownerMarketDecision(all).falsifiers, /任一条件出现/);
  assert.equal(decision.forecastId, "frozen-only"); assert.equal(decision.frozenAt, at);
  assert.equal(ownerMarketDecision(null), null); assert.equal(JSON.stringify(ts), before);
});

test("observation reasons translate internal terms without changing the frozen source", async () => {
  const { ownerObservationDetail } = await import("../app/owner-market-decisions.ts");
  const source = row("NVDA");
  source.swing.why_watch = ["日线ascending_triangle，方向BULLISH", "已观察4/4个周期，同向3/4", "SPY vs QQQ；未收录代码UNKNOWN_PATTERN"];
  const before = JSON.stringify(source), detail = ownerObservationDetail(source, at);
  assert.match(detail.reason, /低点逐步抬高.*偏涨/);
  assert.doesNotMatch(detail.reason, /ascending_triangle|BULLISH/);
  assert.match(detail.reason, /SPY vs QQQ；未收录代码UNKNOWN_PATTERN/);
  assert.equal(JSON.stringify(source), before);
  for (const term of ["descending_triangle", "symmetrical_triangle", "higher_high_higher_low", "lower_high_lower_low", "volume_breakout", "breakout", "false_breakout", "BEARISH", "RANGE", "NOT_OBSERVED"]) {
    source.swing.why_watch = [term];
    assert.notEqual(ownerObservationDetail(source, at).reason, term);
  }
});

test("missing analysis never describes a failed regular-session check as normal after-hours absence", async () => {
  const source = await readFile(new URL("../app/MarketRadar.tsx", import.meta.url), "utf8");
  assert.match(source, /analysisDisplay\.isCurrent \? decision.summary : analysisDisplay.status : "当前暂无盘中分析"/);
  assert.equal(source.includes("非交易时段未显示盘中分析，不等于运行失败"), false);
  assert.match(source, /最近自然检查：/);
  assert.match(source, /当前正常交易时段尚无可展示的盘中分析/);
});

test("home retains the last completed intraday analysis independently of a failed current slot", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const declarations = page.split("\n").filter((line) => /^ {2}const (marketDisplay|marketBias|marketBiasText|marketStateText|marketAnalysis) =/.test(line)).join("\n");
  assert.ok(declarations, "home must derive one retained analysis for its heading and full analysis card");
  const project = new Function("buildTsForecastDisplay", "marketForecastContext", "currentTime", `${declarations}; return { marketAnalysis, marketDisplay, marketStateText };`);
  const evaluate = (context, now) => project(buildTsForecastDisplay, context, now);
  const ts = { report_type: "INTRADAY_30_60M", path_bias: "BEARISH", evidence_snapshot: { run_id: "natural-0730", market_time: { market_date: "2026-09-08", observed_at: "2026-09-08T14:30:40.473Z" } }, forecast_window: { start_at: "2026-09-08T14:30:40.473Z", end_at: "2026-09-08T15:30:40.473Z" }, next_validation: { at: "2026-09-08T15:00:40.473Z" } };
  const before = structuredClone(ts), currentTime = Date.parse("2026-09-08T17:06:00Z");
  const context = resolveTsForecastContext([ts], null, currentTime), result = evaluate(context, currentTime);
  assert.equal(result.marketAnalysis.evidence_snapshot.run_id, "natural-0730");
  assert.match(result.marketStateText, /原预测已过期.*仅供复盘/);
  assert.doesNotMatch(result.marketStateText, /偏空/);
  assert.match(result.marketDisplay.windowText, /07:30:40 加州时间 至 .*08:30:40 加州时间/);
  assert.match(page, /MarketDecisionSummary currentTs=\{marketAnalysis\}/);
  assert.doesNotMatch(page, /（本槽分析）/);
  assert.match(page, /currentTruth\.natural_slot\.terminal_state === "FAILED" \? "失败：未形成新分析/);
  assert.match(page, /const currentTs = currentTruth\.forecast_id \? shadowTsOutputs\.find/, "trading qualification keeps its authoritative same-slot forecast");
  assert.deepEqual(ts, before);
  assert.match(evaluate(context, Date.parse("2026-09-08T14:45:00Z")).marketStateText, /偏空.*本次预测/);
  for (const [now, state] of [["2026-09-08T15:00:40.473Z", "REVIEW_DUE"], ["2026-09-08T15:30:40.473Z", "EXPIRED"]]) {
    const display = evaluate(context, Date.parse(now));
    assert.equal(display.marketDisplay.state, state);
    assert.equal(display.marketDisplay.isCurrent, false);
    assert.doesNotMatch(display.marketStateText, /偏空/);
    assert.match(display.marketDisplay.reviewText, /08:00:40.*已到复查时间/);
  }
  const next = { ...ts, report_type: "NEXT_SESSION", evidence_snapshot: { ...ts.evidence_snapshot, market_time: { ...ts.evidence_snapshot.market_time, market_date: "2026-09-04" } } };
  assert.equal(evaluate(resolveTsForecastContext([next], null, currentTime), currentTime).marketAnalysis, null, "next-session analysis stays in its own card");
  assert.equal(evaluate(resolveTsForecastContext([ts], null, "2026-09-09T17:00:00Z"), currentTime).marketAnalysis, null, "previous-day intraday evidence is not silently reused");
  const unknownWindow = { ...ts, forecast_window: { end_at: null } };
  assert.match(evaluate(resolveTsForecastContext([unknownWindow], null, currentTime), currentTime).marketStateText, /未明确/);
  assert.equal(buildTsForecastDisplay({ ...ts, next_validation: { at: "invalid" } }, "CURRENT_LIVE", "2026-09-08T14:45:00Z").state, "UNKNOWN");
  const historical = resolveTsForecastContext([ts], "natural-0730", "2026-09-09T17:00:00Z");
  assert.equal(historical.selected, ts);
  assert.equal(buildTsForecastDisplay(historical.selected, historical.mode, "2026-09-09T17:00:00Z").state, "HISTORICAL");
  assert.equal(buildTsForecastDisplay(ts, "CURRENT_LIVE", "2026-09-08T14:29:00Z").state, "NOT_STARTED");
  assert.equal(buildTsForecastDisplay(null, "NONE", currentTime).state, "NONE");
  for (const report_type of ["NEXT_SESSION", "WEEKEND_OUTLOOK"]) {
    const symbolic = { ...next, report_type, forecast_window: { horizon: report_type === "NEXT_SESSION" ? "NEXT_REGULAR_SESSION" : "NEXT_REGULAR_SESSION_AND_WEEK", start_at: "2026-09-08T13:30:00Z", end_at: null, end_condition: report_type === "NEXT_SESSION" ? "NEXT_REGULAR_SESSION_CLOSE" : "NEXT_FIVE_REGULAR_SESSIONS_CLOSE" }, next_validation: { at: "2026-09-08T13:30:00Z" } };
    symbolic.evidence_snapshot = { ...symbolic.evidence_snapshot, market_time: { market_date: "2026-09-04", observed_at: "2026-09-05T01:00:00Z" } };
    const beforeSymbolic = structuredClone(symbolic);
    for (const [now, state] of [["2026-09-08T03:00:00Z", "NOT_STARTED"], ["2026-09-08T13:30:00Z", "REVIEW_DUE"]]) {
      const preview = evaluate(resolveTsForecastContext([symbolic], null, now), Date.parse(now));
      assert.equal(preview.marketDisplay.state, state);
      assert.equal(preview.marketDisplay.isCurrent, false);
      assert.match(preview.marketStateText, /2026-09-08预判：偏空/);
      assert.match(preview.marketDisplay.windowText, /收盘（原合同未给出精确时间）/);
      assert.doesNotMatch(preview.marketDisplay.windowText, /13:00:00/);
    }
    assert.deepEqual(symbolic, beforeSymbolic);
  }
  assert.deepEqual(ts, before);
});

test("rendered analysis shows the old forecast and current failure together, including regular-session empty state", async () => {
  const React = await import("react"), { renderToStaticMarkup } = await import("react-dom/server"), ts = await import("typescript");
  const { ownerMarketDecision } = await import("../app/owner-market-decisions.ts"), { formatPtDateTime } = await import("../app/market-time.ts");
  const source = await readFile(new URL("../app/MarketRadar.tsx", import.meta.url), "utf8");
  const component = source.slice(source.indexOf("export function MarketDecisionSummary"), source.indexOf("export function OwnerOpportunityShortlist"));
  const { outputText } = ts.transpileModule(component, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  new Function("exports", "React", "ownerMarketDecision", "formatPtDateTime", "directionText", outputText)(exports, React, ownerMarketDecision, formatPtDateTime, { BEARISH: "偏空", RANGE: "震荡" });
  const forecast = { one_line_forecast: "旧分析：先探低再反抽", current_pattern: { summary: "原结构" }, symbol_outlooks: { SPY: { direction: "BEARISH", summary: "原SPY理由" }, QQQ: { direction: "RANGE", summary: "原QQQ理由" } }, scenarios: { main: { invalidation: null } }, evidence_snapshot: { run_id: "natural-0730", market_time: { observed_at: "2026-09-08T14:30:40.473Z" } }, most_likely_mistake: "未反抽", next_validation: { at: "2026-09-08T15:00:40.473Z" } };
  forecast.forecast_window = { start_at: "2026-09-08T14:30:40.473Z", end_at: "2026-09-08T15:30:40.473Z" };
  const props = { currentTs: forecast, nextCheck: "10:30", analysisDisplay: buildTsForecastDisplay(forecast, "CURRENT_LIVE", "2026-09-08T17:00:00Z"), checkStatus: "失败：未形成新分析", checkAt: "2026-09-08T17:00:00Z", regularSession: true };
  const render = (overrides = {}) => renderToStaticMarkup(React.createElement(exports.MarketDecisionSummary, { ...props, ...overrides }));
  const html = render();
  for (const text of ["旧分析：先探低再反抽", "原预测已过期，仅供复盘", "失败：未形成新分析", "07:30:40", "08:30:40", "10:00:00", "natural-0730"]) assert.equal(html.includes(text), true, text);
  assert.match(html, /<strong>原预测已过期，仅供复盘<\/strong>/);
  const empty = render({ currentTs: null });
  assert.equal(empty.includes("当前正常交易时段尚无可展示的盘中分析"), true);
  assert.equal(empty.includes("失败：未形成新分析"), true);
  assert.equal(empty.includes("当前非正常交易时段"), false);
  assert.equal(render({ currentTs: null, regularSession: false }).includes("下一交易日观察在下方单独展示"), true);
});

test("active chart direction rail and structure fallback retain symbol evidence without promoting stale forecasts", async () => {
  const React = await import("react"), { renderToStaticMarkup } = await import("react-dom/server"), typescript = await import("typescript");
  const source = await readFile(new URL("../app/ApprovedBrokerChartPrototype.tsx", import.meta.url), "utf8");
  const rail = source.match(/<section><span>走势判断 ·[\s\S]*?<\/section>\s*<section><span>交易资格 · 下一确认窗口[\s\S]*?<\/section>/)?.[0];
  const fallback = source.match(/<article><span>\{forecastDisplay.isCurrent \? "当前结构"[\s\S]*?<\/article>/)?.[0];
  assert.ok(rail); assert.ok(fallback);
  const component = `export function ForecastEvidence(props) { const { forecastDisplay, forecastTypeLabel, forecastContext, direction, ts, symbol, contextNote, qualification, qualificationReason, trigger, directions } = props; return <>${rail}${fallback}</>; }`;
  const { outputText } = typescript.transpileModule(component, { compilerOptions: { jsx: typescript.JsxEmit.React, module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } });
  const exports = {};
  new Function("exports", "React", outputText)(exports, React);
  const forecast = { path_bias: "BULLISH", one_line_forecast: "下一窗口先探低，再测试上方压力", current_pattern: { summary: "刚完成反弹，仍处于原区间" }, symbol_outlooks: { QQQ: { direction: "BEARISH", summary: "QQQ原始偏跌理由" } }, forecast_window: { start_at: "2026-09-16T14:30:00Z", end_at: "2026-09-16T15:30:00Z" }, next_validation: { at: "2026-09-16T15:00:00Z" } };
  const before = structuredClone(forecast);
  for (const [now, mode, current] of [["2026-09-16T14:45:00Z", "CURRENT_LIVE", true], ["2026-09-16T15:00:00Z", "CURRENT_LIVE", false], ["2026-09-16T15:30:00Z", "CURRENT_LIVE", false], ["2026-09-17T14:45:00Z", "HISTORICAL", false]]) {
    const display = buildTsForecastDisplay(forecast, mode, now);
    const html = renderToStaticMarkup(React.createElement(exports.ForecastEvidence, { forecastDisplay: display, forecastTypeLabel: current ? "当前自然LIVE预测" : display.status, forecastContext: { tradingDate: "2026-09-16" }, direction: "偏跌", ts: forecast, symbol: "QQQ", contextNote: "", qualification: "READY_FOR_D_REVIEW", qualificationReason: "原审批理由", trigger: null, directions: {} }));
    assert.match(html, /07:30:00 加州时间 至 .*08:30:00 加州时间/);
    assert.match(html, /原判断：偏跌/);
    assert.doesNotMatch(html, /偏涨/);
    assert.match(html, /冻结时行情：刚完成反弹，仍处于原区间/);
    assert.equal((html.match(/下一窗口先探低，再测试上方压力/g) ?? []).length, 1, "the original forward statement must be visible separately from the frozen pattern");
    if (current) {
      assert.match(html, /<strong>偏跌<\/strong>/);
      assert.match(html, /<b>未来判断：<\/b>下一窗口先探低，再测试上方压力/);
    }
    else {
      assert.ok(html.includes(`<strong>${display.status}</strong>`));
      assert.match(html, /<b>原预测（仅供参考）：<\/b>下一窗口先探低，再测试上方压力/);
      assert.doesNotMatch(html, /当前自然LIVE预测|未来判断：|<strong>偏跌<\/strong>|<strong>READY_FOR_D_REVIEW<\/strong>|<span>当前结构<\/span>/);
    }
  }
  assert.deepEqual(forecast, before);
});
