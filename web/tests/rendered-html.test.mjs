import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { forecastFanGeometry, sessionVwapSeries, tsChartOverlay } from "../app/market-chart.ts";
import { APPROVED_STOCKS, WATCH_SECTORS, approvedUniverse, parseOutputEnvelope, parseSnapshot } from "../app/snapshot-import.ts";
import { approvedPoolCoverage, capabilityRetentionAudit } from "../app/capability-retention.ts";
import { buildCodexManagerReview } from "../app/codex-manager.ts";
import { buildTsForecastState, resolveTsForecastContext } from "../app/ts-forecast-state.ts";
import { buildHealthOverview } from "../app/health-overview.ts";
import { formatEtDateTime, formatPtDateTime, isNyseRegularSession, ptDateKey } from "../app/market-time.ts";
import { isHoldingAdviceCurrent, selectTodayAction } from "../app/today-action.ts";
import { clientRequestId } from "../app/client-request-id.ts";
import { buildNextSessionObservation } from "../app/next-session-observation.ts";
import { buildMacroEventLearning } from "../app/macro-event-learning.ts";
import { ownerSnapshotView } from "../server/local-owner-server.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { paperReportingDay } from "../app/paper-plan.ts";
import { spxOwnerObservationLifecycle } from "../app/spx-observation-lifecycle.ts";

test("personal workspace reuses the approved neutral theme without changing data or navigation", async () => {
  const css = await readFile(new URL("../app/workspace.css", import.meta.url), "utf8");
  assert.match(css, /--canvas: #0d0f0e;[\s\S]*?--panel: #151815;[\s\S]*?--text: #f4f5f0;/);
  assert.match(css, /\.workspace-primary a\[aria-current="page"\]::after[^}]*height: 2px/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*--owner-copy-size: \.8125rem; --workspace-title: 1\.25rem/);
  assert.match(css, /\.workspace-shell > main[^}]*max-width: none/);
  assert.match(css, /\.workspace-shell \.settlements-stack[^}]*align-items: start/);
  assert.match(css, /\.workspace-shell \.detail-sheet[^}]*overflow: auto/);
  assert.match(css, /button:not\(\.detail-sheet-trigger, \.split-handle, \.forecast-boundary, \.chart-price-drag\)[^}]*min-height: 44px/);
  assert.match(css, /prefers-reduced-motion: reduce[^\n]*animation: none/);
  assert.doesNotMatch(css, /@import|url\(https?:|\.workspace-refresh-error[^}]*display:\s*none/);
});

test("SPX current levels expire on the page clock and remain in collapsed history", async () => {
  const source = await readFile(new URL("../app/ApprovedBrokerChartPrototype.tsx", import.meta.url), "utf8");
  const declarations = ["activeOwnerObservations", "closedOwnerObservations"].map((name) => source.match(new RegExp(`  const ${name} = .*;`))?.[0]).join("\n");
  const history = source.split("\n").find((line) => line.includes('[{ title: "当前有效人工观察"'));
  const ts = await import("typescript"), React = await import("react"), { renderToStaticMarkup } = await import("react-dom/server");
  const { outputText } = ts.transpileModule(`export function View({proxy, clockNow}) { ${declarations} return <>${history}</>; }`, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  new Function("exports", "React", "spxOwnerObservationLifecycle", "fmtPrice", "safeDate", outputText)(exports, React, spxOwnerObservationLifecycle, new Intl.NumberFormat("en-US"), (value) => value);
  const proxy = { owner_observations: [
    { observation_id: "old-range", kind: "SUPPORT", low: 7695, high: 7710, observed_at: "2026-08-18T15:46:00Z", valid_until: "2026-08-19T15:46:00Z" },
    { observation_id: "current", kind: "LEVEL", low: 7700, high: 7700, observed_at: "2026-09-14T13:30:00Z", valid_until: "2026-09-14T14:00:00Z" },
  ] }, original = structuredClone(proxy);
  const render = (at) => renderToStaticMarkup(React.createElement(exports.View, { proxy, clockNow: Date.parse(at) }));
  const before = render("2026-09-14T13:59:59Z"), after = render("2026-09-14T14:00:00Z");
  assert.match(before, /当前有效人工观察（1）/);
  assert.doesNotMatch(after, /<summary>当前有效人工观察/);
  assert.match(after, /已过期及非当前人工观察（2）/);
  assert.match(after, /7,695.*7,710/);
  assert.doesNotMatch(after, /<details[^>]*\bopen/);
  assert.doesNotMatch(source, /proxy\??\.owner_observations\[0\]/);
  assert.match(source, /activeOwnerObservations\[0\]/);
  assert.match(source, /当前优先关注 SPY \/ QQQ/);
  assert.deepEqual(proxy, original);
});

test("owner pages keep technical evidence closed without hiding risk or removing the chart", async () => {
  const read = (name) => readFile(new URL(`../app/${name}`, import.meta.url), "utf8");
  const [page, holdings, plans, chart] = await Promise.all([read("page.tsx"), read("OptionsPositionPanel.tsx"), read("OwnerPositionPlans.tsx"), read("ApprovedBrokerChartPrototype.tsx")]);
  assert.doesNotMatch(page, /open=\{item.status === "OPEN"/);
  assert.match(page, /<DetailSheet[^>]*label=\{`查看原始消息与逐次采样[\s\S]*?item.case_id[\s\S]*?item.events.map/);
  assert.match(page, /<DetailSheet[^>]*label="查看统计口径与技术证据"[\s\S]*?trusted.validation.status/);
  assert.match(holdings, /<summary>查看这笔订单的成交与技术证据<\/summary>[\s\S]*?order.evidence.order_id/);
  assert.equal((holdings.match(/className="workspace-column"/g) ?? []).length, 2, "holdings columns size independently");
  assert.ok(holdings.indexOf("<OwnerPositionPlans") < holdings.indexOf("<OwnerManualPlans"), "combined current risks and original plans come first on mobile");
  assert.match(holdings, /<OwnerPositionPlans[^>]*positionCheck=\{positionCheck\}/);
  assert.match(holdings, /label="查看冻结持仓分析与历史依据"/);
  assert.match(plans, /<OwnerRiskRangeStatus[\s\S]*?<DetailSheet[^>]*label="查看我当时的持仓计划"[\s\S]*?<dl>/);
  assert.match(chart, /<DetailSheet title="触发条件与依据" label="查看触发条件与依据">[\s\S]*?owner-trigger-grid/);
  assert.match(chart, /<DetailSheet title="合约与观察证据" label="查看合约与观察证据">[\s\S]*?proxy-facts/);
  assert.equal((chart.match(/id="chart-host"/g) ?? []).length, 1);
  assert.doesNotMatch(chart, /className="owner-disclosure"[^>]*onToggle/);
  const nextSession = await read("NextSessionObservationCard.tsx");
  assert.match(nextSession, /<summary>查看次日判断与更新依据<\/summary>[\s\S]*?observation.forecast_id/);
  assert.ok(nextSession.indexOf("是否需要你操作") < nextSession.indexOf('<details className="owner-disclosure">'));
});

test("holding risk stays visible while only its general explanation is collapsed", async () => {
  const [source, ts, React, { renderToStaticMarkup }] = await Promise.all([
    readFile(new URL("../app/OwnerPositionPlans.tsx", import.meta.url), "utf8"), import("typescript"), import("react"), import("react-dom/server"),
  ]);
  const riskComponent = source.slice(source.indexOf("export function OwnerRiskRangeStatus"), source.indexOf("export function OwnerPositionPlans"));
  const { outputText } = ts.transpileModule(riskComponent, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } });
  const component = {};
  new Function("exports", "React", "formatPtDateTime", outputText)(component, React, formatPtDateTime);
  const now = Date.parse("2026-09-21T17:00:00Z");
  const review = { status: "LOSS_RANGE_EXCEEDED", review_loss_pct: 30, upper_loss_pct: 50, exit_return_pct: -55, checked_at: new Date(now).toISOString(), valid_until: new Date(now + 60_000).toISOString() };
  for (const [value, at, expected] of [[review, now, /达到或超出.*50%.*-55.00%/], [review, now + 60_001, /当前报价未核验或已过期/], [{ ...review, status: "POSITION_CHANGED" }, now, /持仓身份已变化/]]) {
    const html = renderToStaticMarkup(React.createElement(component.OwnerRiskRangeStatus, { review: value, currentTime: at }));
    const visible = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
    assert.match(visible, expected);
    assert.doesNotMatch(visible, /你确认的范围/);
    assert.match(html, /<summary>复核区间与风险说明<\/summary>/);
    assert.doesNotMatch(html, /<details[^>]*\bopen/);
    if (at === now && value.status === "LOSS_RANGE_EXCEEDED") assert.match(visible, /报价核验有效至/);
    else assert.doesNotMatch(visible, /-55.00%/);
  }
});

test("home action headline respects an independently approved stock plan when index is NO_TRADE", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const declarations = ["tradeResult", "actionResult", "ownerResult"].map((name) => page.match(new RegExp(`  const ${name} = .*;`))?.[0]).join("\n");
  const evaluate = new Function("manualBuySymbols", "qualified", "marketIsClosed", "qualifiedSymbols", "ownerAttentionRequired", `${declarations}; return { tradeResult, actionResult, ownerResult };`);
  const stock = evaluate("NVDA", false, false, "", false);
  assert.match(stock.tradeResult, /待你确认的买入计划/);
  assert.match(stock.actionResult, /NVDA/);
  assert.match(stock.ownerResult, /由你决定/);
  assert.match(evaluate("", false, false, "", false).tradeResult, /暂不开新仓/);
  assert.match(evaluate("", false, true, "", false).actionResult, /等待下一次检查/);
});

test("Owner manual plans share one home/options projection and never present website notes as approval", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const options = await readFile(new URL("../app/OptionsPositionPanel.tsx", import.meta.url), "utf8");
  const plans = await readFile(new URL("../app/OwnerManualPlans.tsx", import.meta.url), "utf8");
  const notes = await readFile(new URL("../app/OwnerPositionPlans.tsx", import.meta.url), "utf8");
  assert.match(page, /projectOwnerManualPlans\(importState, currentTime\)/);
  assert.match(page, /manualPlans\.plans\.length/);
  assert.doesNotMatch(page, /<OwnerManualPlans|<OwnerPositionPlans/);
  assert.match(page, /href="\/options">查看持仓与原计划/);
  assert.match(options, /OwnerManualPlans result=\{manualPlans\}/);
  assert.match(plans, /不是已触发/);
  assert.match(plans, /第一目标/);
  assert.match(plans, /预计持有时段/);
  assert.match(plans, /系统不会下单/);
  assert.match(plans, /个股条件计划进度/);
  assert.match(plans, /看涨 Call 方向备选/);
  assert.match(plans, /看跌 Put 方向备选/);
  assert.match(plans, /价格碰到不等于可以买/);
  assert.match(plans, /result\.next_stock_check/);
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const planStyle = styles.match(/\.owner-manual-plans \{([^}]+)\}/)?.[1] ?? "";
  assert.match(planStyle, /min-width: 0/);
  assert.match(planStyle, /overflow-wrap: anywhere/);
  const { transpileModule } = await import("typescript");
  const reason = new Function("reason", transpileModule(plans.match(/function reasonText\(reason: string\) \{([\s\S]*?)\n\}/)[1], { compilerOptions: { target: 99 } }).outputText);
  for (const code of ["NO_0_15_DTE_EXPIRATION", "DUPLICATE_OPTION_IDENTITY", "MU：OPTION_CHAIN_IDENTITY_OR_QUOTES_UNAVAILABLE"]) assert.match(reason(code), /资料未完整取得/);
  assert.match(reason("EQUITY_BARS_INSUFFICIENT_FOR_SETUP"), /只能先列条件预案/);
  assert.doesNotMatch(reason("EQUITY_BARS_INSUFFICIENT_FOR_SETUP"), /资料未完整取得/);
  assert.match(plans, /result\.blocked_reasons\.map\(reasonText\)/);
  assert.match(notes, /clientRequestId\(\)/);
  assert.match(notes, /pending\.current\?\.fingerprint === fingerprint/);
  assert.match(notes, /const list = await readPlans\(\)/);
  assert.match(notes, /plan_version_id === result\.plan!\.plan_version_id && row\.payload_sha256/);
  assert.match(notes, /不是事前预测或交易批准/);
  assert.match(options, /className=\{currentBuyPlan \? "options-card actionable"/);
  assert.doesNotMatch(options, /当前最优候选| · 已批准候选/);
  assert.match(notes, /response.status === 409[\s\S]*?不要继续重复提交旧依据/);
  const timerEffect = page.match(/if \(!Number\.isFinite\(planDeadline\)\) return;([\s\S]*?)\n {2}\}, \[planDeadline\]\);/)?.[1];
  assert.ok(timerEffect);
  const times = [], timers = [], listeners = [], now = 120_000;
  const win = { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return 1; }, clearTimeout: () => {}, addEventListener: (name) => listeners.push(name), removeEventListener: () => {} };
  new Function("planDeadline", "setCurrentTime", "Date", "window", "document", timerEffect)(now + 500, (time) => times.push(time), { now: () => now }, win, win);
  assert.equal(timers[0].delay, 501, "expire at the original source deadline, not after the next network refresh");
  timers[0].callback(); assert.deepEqual(times, [now]);
  assert.deepEqual(listeners, ["focus", "visibilitychange"]);
  const deadlineLine = page.match(/ {2}const planDeadline = (.*);/)[1];
  const getDeadline = new Function("manualPlans", `return ${deadlineLine}`);
  assert.equal(getDeadline({ plans: [], conditional_plans: [{ valid_until: new Date(now + 500).toISOString(), stage: "WAITING_TRIGGER" }] }), now + 500);
  assert.equal(getDeadline({ plans: [], conditional_plans: [{ valid_until: new Date(now - 1).toISOString(), stage: "EXPIRED" }] }), Infinity, "expired references cannot create an immediate timer loop");
});

test("holding source selection is optional, preserves a saved source and never claims execution", async () => {
  const [{ transpileModule, JsxEmit, ModuleKind, ScriptTarget }, jsx, react, { renderToStaticMarkup }] = await Promise.all([import("typescript"), import("react/jsx-runtime"), import("react"), import("react-dom/server")]);
  const source = await readFile(new URL("../app/OwnerPositionPlans.tsx", import.meta.url), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  const component = {};
  new Function("exports", "require", `${compiled}\nexports.PlanForm = PlanForm;`)(component, (name) => {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react") return react;
    if (name === "./market-time") return { formatPtDateTime };
    if (name === "./client-request-id") return { clientRequestId };
    if (name === "./owner-position-plan" || name === "./today-action" || name === "../server/option-horizon" || name === "./DetailSheet" || name === "./CompanyEvidence") return {};
    throw Error(`Unexpected component dependency: ${name}`);
  });
  const props = { holdingId: "actual-holding", sourceId: "archived-account", onSaved: () => {}, stockSources: [
    { holding_id: "actual-holding", record_id: "published-source", symbol: "NVDA", expiration: "2026-09-18", strike: 200, option_type: "call", status: "CONDITIONAL", published_at: "2026-09-09T16:30:00.000Z" },
  ] };
  const fresh = renderToStaticMarkup(jsx.jsx(component.PlanForm, props));
  assert.match(fresh, /<select name="stock_plan_source_id"/);
  assert.match(fresh, /<option value="" selected="">/);
  assert.match(fresh, /当时仅条件预案/);
  assert.match(fresh, /不代表按计划价格成交/);
  assert.doesNotMatch(fresh, /value="published-source" selected/);
  const saved = renderToStaticMarkup(jsx.jsx(component.PlanForm, { ...props, plan: { stock_plan_source: { record_id: "older-source" } } }));
  assert.match(saved, /value="older-source" selected="">保留已记录的来源（不重新批准）/);
  assert.match(source, /stockSources=\{\(list\.stock_plan_sources \?\? \[\]\)\.filter\(\(source\) => source\.holding_id === row\.holding_id\)\}/);
  assert.match(source, /stockSourceId \? \{ stock_plan_source_id: stockSourceId \} : \{\}/);
});

test("conditional option cards retain contract and risk in compact mode without claiming approval or live expired prices", async () => {
  const [{ transpileModule, JsxEmit, ModuleKind, ScriptTarget }, jsx, { renderToStaticMarkup }] = await Promise.all([import("typescript"), import("react/jsx-runtime"), import("react-dom/server")]);
  const source = await readFile(new URL("../app/OwnerManualPlans.tsx", import.meta.url), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  const component = {};
  new Function("exports", "require", compiled)(component, (name) => {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "./market-time") return { formatPtDateTime };
    throw Error(`Unexpected component dependency: ${name}`);
  });
  const proposal = {
    plan_id: "conditional-test", symbol: "NVDA", contract_id: "readonly-contract", option_type: "call", expiration: "2026-09-18", strike: 200, quantity: 1,
    max_debit_usd: 125, reference_price: 1.15, entry_trigger_price: 201, invalidation_price: 198, target_price: 205, stop_loss_pct: -30, take_profit_pct: 30,
    holding_period: "根据原分析等待下一次检查", contract_selection_reason: "仅从本次实际取得的合约比较，不代表全市场最优",
    reasons: ["已有同标的走势依据"], entry_conditions: ["突破后下一根完整K线站稳"], invalidation: ["股票跌破失效价即放弃"], pending_conditions: ["还要新报价与独立复核"],
    observed_at: "2026-09-09T16:30:00.000Z", valid_until: "2026-09-09T16:32:00.000Z", source_ref: "frozen-evidence", approval_ref: "NOT_APPROVED",
    automated_execution: false, owner_confirmation_required: true, stage: "WAITING_TRIGGER",
  };
  for (const compact of [false, true]) for (const stage of ["WAITING_TRIGGER", "EXPIRED"]) for (const option_type of ["call", "put"]) {
    const result = { plans: [], conditional_plans: [{ ...proposal, stage, option_type }], progress: [], blocked_reasons: ["尚无交易批准"], next_stock_check: null };
    const html = renderToStaticMarkup(jsx.jsx(component.OwnerManualPlans, { result, compact }));
    const card = html.match(/<article[^>]*data-plan-stage="(?:WAITING_TRIGGER|EXPIRED)"[^>]*>[\s\S]*?<\/article>/)?.[0];
    assert.ok(card, `${compact ? "compact" : "full"} ${stage} must render a separate conditional card`);
    assert.match(card, /事前条件计划/);
    assert.match(card, /还要新报价与独立复核/);
    for (const text of ["NVDA", "2026-09-18", "200", option_type === "call" ? "Call" : "Put", option_type === "call" ? "向上突破" : "向下跌破", "1张", "$1.25", "$125.00", "$201.00", "$198.00", "$205.00", "-30%", "30%", "不能保证止损成交", "新证据", "独立复核"]) assert.ok(card.includes(text), `missing ${text}`);
    assert.match(card, /<details><summary>为什么选这张合约/);
    assert.match(card, /frozen-evidence/);
    assert.doesNotMatch(card, /可考虑人工买入开仓|原批准数量|已触发|actionable|<button|<input/);
    assert.match(html, /当前没有通过全部检查的买卖计划/);
    assert.equal(result.plans.length, 0, "a proposal is not added to approved plans");
    if (stage === "EXPIRED") {
      assert.match(card, /已过期，只供复盘/);
      assert.match(card, /旧限价与旧报价不能用于当前操作/);
      assert.doesNotMatch(card, /本次期权参考价/);
    } else {
      assert.match(card, /等待条件，暂不执行/);
      assert.match(card, /本次期权参考价/);
    }
  }
  const empty = { plans: [], conditional_plans: [], progress: [], blocked_reasons: [], next_stock_check: null };
  assert.doesNotMatch(renderToStaticMarkup(jsx.jsx(component.OwnerManualPlans, { result: empty })), /data-plan-stage/);
  const approved = { ...proposal, plan_id: "approved-test", side: "BUY_TO_OPEN", first_target: "原股票目标", trigger: "原批准条件", trigger_state: "OWNER_CHECK_REQUIRED" };
  const mixed = renderToStaticMarkup(jsx.jsx(component.OwnerManualPlans, { result: { ...empty, conditional_plans: [proposal], plans: [approved] } }));
  assert.ok(mixed.indexOf('data-plan-stage="WAITING_TRIGGER"') < mixed.indexOf("可考虑人工买入开仓"));
  assert.equal(mixed.match(/原批准数量/g)?.length, 1, "conditional cards do not inflate approved-plan labels");
  const sameProgress = { evidence_id: proposal.source_ref, news: [{ id: "unverified-news", url: "https://example.com/source", headline: "Synthetic source", source: "EXAMPLE", published_at: proposal.observed_at, verified: false }] };
  const complete = renderToStaticMarkup(jsx.jsx(component.OwnerManualPlans, { result: { ...empty, conditional_plans: [proposal], progress: [sameProgress] } }));
  assert.doesNotMatch(complete, /aria-label="个股条件计划进度"/, "do not show a conflicting second trigger card for the same evidence");
  assert.match(complete, /https:\/\/example.com\/source/); assert.match(complete, /未核验或已过期/);
});

test("review labels distinguish corrected baseline, untouched legacy paths and quote estimates", async () => {
  const options = await readFile(new URL("../app/OptionsPositionPanel.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(options, /path_scoring_version === "FIRST_TERMINAL_V2"/);
  assert.match(options, /旧路径算法 · 原结果保留未更正/);
  assert.match(options, /期权报价估算变化（非真实成交）/);
  assert.match(options, /item\.observation_window\.start_at/);
  assert.match(options, /旧观察时段未更正/);
  assert.match(options, /不是整个持有期的评价/);
  assert.doesNotMatch(options, /期权实际收益/);
  assert.match(page, /发布时已经收到的结算.*更正计算/);
  assert.match(page, /历史预测和结算没有重写/);
  assert.match(page, /reviewSummary\.evidence\.nodes\.map/);
  assert.match(page, /reviewSummary\.evidence\.gaps\.map/);
});

test("client request IDs keep cryptographic UUIDs on insecure LAN HTTP", () => {
  const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
  const fallback = clientRequestId({ randomUUID: undefined, getRandomValues(target) { target.set(bytes); return target; } });
  assert.equal(fallback, "00010203-0405-4607-8809-0a0b0c0d0e0f");
  assert.equal(clientRequestId({ randomUUID: () => "11111111-1111-4111-8111-111111111111", getRandomValues() { throw new Error("unused"); } }), "11111111-1111-4111-8111-111111111111");
  assert.equal(clientRequestId(null), null);
});

test("cached Manager evidence ages even while the existing snapshot request is stuck", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const refreshStart = source.match(/const refresh = \(\) => \{([\s\S]*?)void fetchActiveSnapshot\(page\)/)?.[1];
  assert.ok(refreshStart);
  const updates = [];
  const runExistingTick = new Function("refreshing", "setCurrentTime", "Date", refreshStart);
  runExistingTick(true, (time) => updates.push(time), { now: () => 180_001 });
  assert.deepEqual(updates, [180_001], "age must advance before the in-flight request guard, independently of network success");
});

test("stale Manager command polling stops instead of repeating 404 or 503", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /response\.status === 404[\s\S]{0,240}localStorage\.removeItem\("trading-os-manager-command:v1"\)/);
  assert.match(source, /const failed = \(error: unknown\) => \{ window\.clearInterval\(timer\)/);
});

test("expired position advice stays historical until a new natural full-analysis slot", () => {
  const holding = { next_check_at: "2026-08-26T19:00:28.009Z" };
  const state = { source_mode: "LIVE", observed_at: "2026-08-26T18:30:28.009Z", holdings: [holding] };
  assert.equal(isHoldingAdviceCurrent(state, holding, "2026-08-28", Date.parse("2026-08-28T15:00:00.000Z")), false);
  const current = { ...state, observed_at: "2026-08-28T15:00:00.000Z" }, currentHolding = { next_check_at: "2026-08-28T16:00:00.000Z" };
  assert.equal(isHoldingAdviceCurrent(current, currentHolding, "2026-08-28", Date.parse("2026-08-28T15:30:00.000Z")), true);
  assert.equal(isHoldingAdviceCurrent(current, currentHolding, "2026-08-28", Date.parse("2026-08-28T16:00:01.000Z")), false);
  assert.equal(isHoldingAdviceCurrent({ ...state, observed_at: "2026-08-28T05:00:00.000Z" }, { next_check_at: "2026-08-28T13:30:00.000Z" }, "2026-08-28", Date.parse("2026-08-28T06:00:00.000Z")), true);
});

test("next-session card separates pending, real output, and failed 18:00 states", () => {
  const base = { outputs: [], checkpoints: [], incidents: [], tradingDate: "2026-08-28" };
  const loading = buildNextSessionObservation({ ...base, tradingDate: "1970-01-01", at: 0 });
  assert.deepEqual([loading.phase, loading.status, loading.target_date], ["PENDING", "正在读取后台结果", "正在读取"]);
  const pending = buildNextSessionObservation({ ...base, at: "2026-08-28T20:00:00.000Z" });
  assert.deepEqual([pending.phase, pending.status, pending.direction, pending.target_date, pending.reason], ["PENDING", "计划正常", "等待18:00形成", "2026-08-31", "18:00按合同自然冻结；形成前不拿盘中结论冒充次日预测"]);
  const output = { report_type: "WEEKEND_OUTLOOK", path_bias: "BEARISH", one_line_forecast: "周末前偏空，但仍需下周一自然确认。", evidence_assessment: { core_status: "READY" }, evidence_snapshot: { run_id: "20260829T010000Z-0123456789", market_time: { observed_at: "2026-08-29T01:00:18.000Z", market_date: "2026-08-28" } } };
  const ready = buildNextSessionObservation({ ...base, outputs: [output], at: "2026-08-29T01:01:00.000Z" });
  assert.deepEqual([ready.phase, ready.direction, ready.forecast_id, ready.reason], ["READY", "偏空", output.evidence_snapshot.run_id, output.one_line_forecast]);
  const afterEtMidnight = buildNextSessionObservation({ ...base, tradingDate: "2026-08-29", outputs: [output], at: "2026-08-29T04:30:00.000Z" });
  assert.deepEqual([afterEtMidnight.phase, afterEtMidnight.target_date, afterEtMidnight.forecast_id], ["READY", "2026-08-31", output.evidence_snapshot.run_id]);
  const nextDayPending = buildNextSessionObservation({ ...base, tradingDate: "2026-08-31", outputs: [output], at: "2026-08-31T20:00:00.000Z" });
  assert.deepEqual(nextDayPending.last_completed, { target_date: "2026-08-31", direction: "偏空", formed_at: output.evidence_snapshot.market_time.observed_at, forecast_id: output.evidence_snapshot.run_id });
  const closedContext = resolveTsForecastContext([output], null, "2026-08-29T04:30:00.000Z");
  assert.deepEqual([closedContext.mode, closedContext.tradingDate, closedContext.selected?.evidence_snapshot.run_id], ["NEXT_SESSION", "2026-08-31", output.evidence_snapshot.run_id]);
  const failed = buildNextSessionObservation({ ...base, checkpoints: [{ kind: "EVENING_ANALYSIS", scheduled_pt: "2026-08-28 18:00 PT", completed_at: "2026-08-29T01:11:00.000Z", result_ref: null, status: "DATA_BLOCKED", reason: "真实数据不可用" }], at: "2026-08-29T01:11:31.000Z" });
  assert.deepEqual([failed.phase, failed.status, failed.reason, failed.owner_action], ["FAILED", "没有形成", "真实数据不可用", "不需要Owner操作"]);
});

test("Owner overview projects upcoming official events into the special and next-session cards", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /upcomingSpecialEvents/);
  assert.match(source, /const officialMacro = latestA1Shadow\?\.official_macro/);
  assert.match(source, /Employment Situation.*非农就业报告/);
  assert.match(source, /次日关键事件/);
  assert.match(source, /先看我们的判断/);
  assert.match(source, /当前公式推演：/);
  assert.match(source, /原资料不等于原判断/);
  assert.match(source, /这是练习预测，只用于事后复盘/);
  assert.match(source, /为什么这么猜？什么情况算猜错？/);
  assert.match(source, /我们看了什么/);
  assert.match(source, /查看未来事件日历/);
  assert.match(source, /查看当前个股事件复盘/);
});

test("macro learning preserves source material without inventing a frozen prediction score", () => {
  const events = [
    { event_id: "nfp", release_name: "Employment Situation", scheduled_at: "2026-09-04T12:00:00.000Z", source_url: "https://www.bls.gov/", confidence: "official" },
    { event_id: "fomc", release_name: "FOMC Meeting Decision", scheduled_at: "2026-09-16T12:00:00.000Z", source_url: "https://www.federalreserve.gov/", confidence: "official" },
  ];
  const macro = (payroll, results = []) => ({
    contract_version: "v1", component: "OFFICIAL_MACRO_CONTEXT", mode: "SHADOW", status: "LIVE", collected_at: "2026-09-04T01:00:00.000Z", as_of: "2026-09-04T01:00:00.000Z", context_hash: "a".repeat(64),
    providers: { BLS: { schedule_status: "LIVE", results_status: "LIVE", as_of: "2026-09-04T01:00:00.000Z", error: null }, BEA: { schedule_status: "LIVE", results_status: "NOT_OBSERVED", as_of: "2026-09-04T01:00:00.000Z", error: null } }, events, results, bls_macro_watch: {}, bls_official_news: {}, official_items: [], errors: [],
    observations: [
      { series_id: "NONFARM_PAYROLL_CHANGE", value: payroll }, { series_id: "LNS14000000", value: 4.1, previous_value: 4.2 },
      { series_id: "CPI_MOM_PCT", value: 0.0737 }, { series_id: "PPI_FINAL_DEMAND_MOM_PCT", value: -0.0993 },
    ], market_context: { treasury_yields: { observations: [{ metric: "TREASURY_2Y", value: 4.39 }] }, wti: { observations: [{ metric: "WTI_CUSHING_SPOT", value: 91.48 }] } },
  });
  const evening = { record_id: "live-shadow:20260904T010000Z:A1", observed_at: "2026-09-04T01:02:00.000Z", role: "EVENING", official_macro: macro(-23), quotes: [], sector_advance_pct: 72.7 };
  const result = { status: "VERIFIED", release_name: "Employment Situation", scheduled_at: events[0].scheduled_at, metrics: [{ name: "PAYROLL_EMPLOYMENT_CHANGE", value: 125000 }] };
  const latest = { record_id: "live-shadow:20260904T200000Z:A1", observed_at: "2026-09-04T20:00:00.000Z", role: "LATEST", official_macro: macro(125, [result]), quotes: [{ symbol: "SPY", last: 780, previous_close: 773, as_of: "2026-09-04T20:00:00.000Z" }, { symbol: "QQQ", last: 720, previous_close: 718, as_of: "2026-09-04T20:00:00.000Z" }], sector_advance_pct: 80 };
  const studies = buildMacroEventLearning([latest, evening], "2026-09-04T20:00:00.000Z").studies;
  const nfp = studies.find((item) => item.release_name === "Employment Situation"), fomc = studies.find((item) => item.release_name === "FOMC Meeting Decision");
  assert.deepEqual([nfp.stage, nfp.source_record_id, nfp.call.label, nfp.call.probability_pct, nfp.review.verdict], ["RECONSTRUCTED_RESEARCH", evening.record_id, "本月新增工作岗位会比上月多", 65, "INCONCLUSIVE"]);
  assert.deepEqual(nfp.evidence, ["上月工作岗位减少 23,000 个", "上月失业率 4.10%（再前一个月 4.20%）", "保存资料时，上涨行业占比 72.70%"]);
  assert.match(nfp.review.summary, /125,000.*原判断未独立冻结/);
  assert.equal(nfp.frozen_at, null);
  assert.deepEqual([fomc.stage, fomc.call.label, fomc.call.probability_pct], ["PREVIEW", "维持当前利率，不加息", 50]);
});

test("compact Owner views retain the records their summary cards consume", () => {
  const position = { source_mode: "LIVE", observed_at: "2026-08-29T01:00:11.603Z", holdings: [{ symbol: "SPY" }] };
  const openCase = { case_id: "EXT-NVDA-20260828-121722-215P-0904-01", status: "OPEN" };
  const recapCase = { case_id: "EXT-MSFT-20260828-080843-515C-0828-01", status: "RECAP_ONLY" };
  const evening = { slot_id: "evening:2026-09-03", kind: "EVENING_ANALYSIS", scheduled_pt: "2026-09-03 18:00 PT", completed_at: "2026-09-04T01:00:10.000Z" };
  const state = {
    payload: null, recentOutputs: [], runLedger: { runs: [] }, selfCheck: { recent: [] },
    marketIntelligence: { events: [], causalChains: [] }, scheduler: { groups: [], recent: [] },
    marketRadar: { snapshot: {
      fixed_pool: { candidates: ["AVGO"], rows: [{ symbol: "AVGO" }], missing_symbols: Array.from({ length: 69 }, (_, index) => `M${index}`) },
      earnings_center: { items: [{ symbol: "AVGO", result_status: "REPORTED_WAITING_REACTION" }] },
      event_scan: { items: [] }, provenance: [{ capability: "fixed70" }],
    }, source_record_id: "radar:1", market_snapshot_id: "snapshot:1", market_snapshot_hash: "a".repeat(64), archived_at: "2026-09-03T19:30:52.478Z" },
    tsSettlement: { exclusions: [], recent: [], review_evidence: { forecast_run_id: "review-case" } }, optionLifecycle: { recent_settlements: [] },
    ownerTrigger: { current: { SPY: null, QQQ: null }, recent: [] }, spxwProxy: { watches: [], real_holdings: [], owner_observations: [] },
    externalExpert: { cases: [openCase, recapCase] },
    outputs: { TS_OUTPUT: [], TS_SHADOW_OUTPUT: [], A1_SHADOW_RESULT: null, A2_SHADOW_RESULT: null, CODEX_GUARD_SHADOW: null, COMMITTEE_SHADOW_OUTPUT: null, D_SHADOW_OUTPUT: null, A3_REVIEW_SHADOW: null, A3_FINAL_SHADOW: null, SCHEDULE_CHECKPOINT: [...Array.from({ length: 5 }, (_, index) => ({ slot_id: `recent:${index}`, kind: "CODEX_MANAGER", scheduled_pt: `2026-09-03 1${index}:00 PT`, completed_at: `2026-09-03T2${index}:00:00.000Z` })), evening], OPTION_STRATEGY_SIGNAL: [], POSITION_COPILOT_STATE: [position] },
  };
  const home = ownerSnapshotView(state, "home");
  assert.deepEqual(home.externalExpert.cases.map((item) => item.case_id), [openCase.case_id]);
  assert.deepEqual(home.marketRadar.snapshot.fixed_pool.candidates, ["AVGO"]);
  assert.deepEqual(home.marketRadar.snapshot.fixed_pool.missing_symbols, []);
  assert.equal(home.marketRadar.snapshot.provenance.length, 0);
  assert.equal(home.outputs.SCHEDULE_CHECKPOINT.some((item) => item.kind === "EVENING_ANALYSIS"), true);
  assert.equal(ownerSnapshotView(state, "issues").outputs.POSITION_COPILOT_STATE[0], position);
  assert.equal(home.tsSettlement.review_evidence.forecast_run_id, "review-case");
  assert.equal(ownerSnapshotView(state, "options").tsSettlement.review_evidence, null);
  assert.equal(ownerSnapshotView(state, "forecast").tsSettlement.review_evidence, null);
});

test("recent Manager checks survive compact views and monitor traffic without rewriting frozen failures", async (context) => {
  const store = openSnapshotDatabase(":memory:");
  context.after(() => store.close());
  const state = store.getActive();
  const manager = { slot_id: "manager:20260914:0705", kind: "CODEX_MANAGER", completed_at: "2026-09-14T14:05:18.000Z", manager_review: { checked_at: "2026-09-14T14:05:17.819Z", review_type: "EARLY", status: "BLOCKED" } };
  const sunday = { ...manager, slot_id: "manager:20260913:1820", completed_at: "2026-09-14T01:20:09.000Z", manager_review: { ...manager.manager_review, checked_at: "2026-09-14T01:20:01.367Z", review_type: "DAILY_CLOSE", status: "BLOCKED" } };
  state.scheduler.recent = Array.from({ length: 20 }, (_, index) => ({ slot_id: `monitor:${index}`, kind: "POSITION_MONITOR", completed_at: "2026-09-14T16:00:00.000Z" }));
  state.outputs.SCHEDULE_CHECKPOINT = [...state.scheduler.recent, manager, sunday];
  const before = structuredClone(state);
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const declarations = ["latestManagerCheckpoint", "managerReview", "managerReviewCurrent"].map((name) => source.match(new RegExp(`  const ${name} = .*;`))?.[0]).join("\n");
  const card = source.split("\n").find((line) => line.includes('<article><span>{managerReviewCurrent ? "Codex 当前公司检查"'));
  assert.ok(card);
  const ts = await import("typescript"), React = await import("react"), { renderToStaticMarkup } = await import("react-dom/server");
  const { outputText } = ts.transpileModule(`export function View({importState, currentTime}) { ${declarations} return managerReview ? <>${card}</> : null; }`, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  new Function("exports", "React", "displayText", "formatPtDateTime", outputText)(exports, React, (value) => value, formatPtDateTime);
  const renderCheck = (value, at) => renderToStaticMarkup(React.createElement(exports.View, { importState: value, currentTime: Date.parse(at) }));
  for (const view of ["home", "company", "health", "issues"]) {
    const projected = ownerSnapshotView(state, view);
    assert.equal(projected.outputs.SCHEDULE_CHECKPOINT.filter((item) => item.slot_id === manager.slot_id).length, 1, view);
    assert.equal(projected.scheduler.recent.some((item) => item.manager_review), false, "do not enlarge the recent scheduler window");
    const historical = renderCheck(projected, "2026-09-14T16:00:00.000Z");
    assert.match(historical, /Codex 最近冻结检查（历史）/);
    assert.match(historical, /不覆盖当前实时健康/);
    assert.match(historical, /data-status="BLOCKED"/);
    assert.ok(historical.includes(formatPtDateTime(manager.manager_review.checked_at)), view);
    assert.match(renderCheck(projected, "2026-09-14T14:15:00.000Z"), /Codex 当前公司检查/);
  }
  assert.deepEqual(state, before, "projection and page rendering leave the retained check evidence untouched");
  state.outputs.SCHEDULE_CHECKPOINT = [manager, ...state.scheduler.recent];
  assert.equal(ownerSnapshotView(state, "health").outputs.SCHEDULE_CHECKPOINT.filter((item) => item.slot_id === manager.slot_id).length, 1, "already-retained checks are not duplicated");
  state.outputs.SCHEDULE_CHECKPOINT = [];
  state.scheduler.recent = [manager];
  assert.match(renderCheck(state, "2026-09-14T14:15:00.000Z"), /Codex 当前公司检查/, "legacy snapshots retain the recent-check fallback");
  state.outputs.SCHEDULE_CHECKPOINT = before.outputs.SCHEDULE_CHECKPOINT;
  state.scheduler.recent = before.scheduler.recent;
  for (const view of ["forecast", "options", "settlements"]) assert.equal(ownerSnapshotView(state, view).outputs.SCHEDULE_CHECKPOINT.some((item) => item.manager_review), false, view);
  assert.deepEqual(state, before, "original Sunday and current check status remain immutable");
});

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("freezes the V2 projection without pretending to contain runtime evidence", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../app/v2-sanitized-frozen-snapshot.json", import.meta.url), "utf8"));
  assert.equal(snapshot.meta.source_commit, "f1b99765d5dd26e70b42969070b34ca68a5d8bb0");
  assert.equal(snapshot.meta.runtime_evidence_included, false);
  assert.equal(snapshot.meta.production_directory_read, false);
  assert.equal(snapshot.formal_forecast_slots.length, 14);
  assert.deepEqual(snapshot.relationship.independent_roles, ["TS", "COMMITTEE"]);
  assert.deepEqual(snapshot.relationship.delivery_join_keys, ["delivery_key", "run_id", "packet_hash"]);
  assert.ok(snapshot.system_health.every((item) => item.runtime_state === null));
  assert.match(snapshot.system_health[1].expected, /actionable=false.*status=INACTIVE/);
  assert.equal(snapshot.ts_projection.runtime_values.scenario_probabilities, null);
  assert.equal(snapshot.acceptance_requirements.find((item) => item.label === "TS 正式预测").expected, 14);
});

test("renders distinct owner pages and the isolated approved forecast shell", async () => {
  const paths = ["/", "/forecast", "/options", "/company", "/health", "/settlements", "/issues"];
  const pages = Object.fromEntries(await Promise.all(paths.map(async (path) => {
    const response = await render(path);
    assert.equal(response.status, 200);
    return [path, await response.text()];
  })));
  for (const html of Object.values(pages)) {
    for (const marker of ["最近正式槽 / 冻结终态", "当前实时数据", "下一槽资格"]) assert.match(html, new RegExp(marker));
    assert.doesNotMatch(html, /Codex离线降级/);
  }
  const home = pages["/"];
  assert.match(home, /正在读取下一自然检查时间/);
  assert.doesNotMatch(home, /下一次自然检查[^<]{0,60}(?:1969|1970)/);
  for (const html of Object.values(pages)) {
    const primary = html.match(/<nav class="workspace-primary"[^>]*>(.*?)<\/nav>/)?.[1];
    assert.ok(primary, "every page uses the same four-link navigation");
    assert.deepEqual([...primary.matchAll(/<a [^>]*>(.*?)<\/a>/g)].map((match) => match[1].replace(/<[^>]+>/g, "")), ["总览", "市场", "持仓", "研究与复盘"]);
    assert.equal((primary.match(/<svg aria-hidden="true"/g) ?? []).length, 4, "decorative icons keep all four text labels accessible");
  }
  for (const href of ["/forecast", "/options", "/company", "/health", "/settlements", "/issues"]) assert.match(home, new RegExp(`href="${href}"`));
  for (const marker of ["今日总览", "当前能不能开新仓", "正在读取交易结论", "优先观察", "研究与跟踪", "市场判断 · 注意目标日", "当前动作", "Quote 和 Bar", "下一次自然检查", "下一交易日初步观察", "特别事件", "真实持仓待办", "当前观察案例", "你的待办", "查看技术证据"]) assert.match(home, new RegExp(marker));
  const order = ['aria-label="当前状态"', 'id="today-paper"', 'id="current-holdings"', 'aria-label="优先观察"', 'id="tracking-heading"'].map((marker) => home.indexOf(marker));
  assert.ok(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1])), "home must show today's paper before real holdings, then observations and research");
  assert.equal(home.match(/id="today-paper"/g)?.length, 1);
  assert.match(home, /<details class="overview-evidence"><summary><span>查看市场判断与系统待办<\/span><\/summary>/);
  assert.doesNotMatch(home, /id="research-paper"|买卖计划与事前预案|为什么这么猜/);
  assert.match(home, /href="\/settlements#research-paper"/);
  assert.match(home, /href="\/company#market-events"/);
  assert.match(home, /不把未知当作正常/);
  for (const marker of ["today-overview", "today-decision", "today-control-grid", "overview-evidence"]) assert.match(home, new RegExp(marker));
  assert.doesNotMatch(home, /today-action-card/);
  assert.doesNotMatch(home, /owner-console-compact/);
  assert.doesNotMatch(home, /owner-console-strip/);
  assert.doesNotMatch(home, /ts-core-owner-card/);
  assert.doesNotMatch(home, /page-subnav/);
  for (const marker of ["TS 预测驾驶舱", "信号状态机与收盘复盘", "公司时间线", "系统健康与管控中心", "当时怎么判断，后来实际怎么走", "老板投诉箱"]) assert.doesNotMatch(home, new RegExp(marker));

  const forecast = pages["/forecast"];
  for (const marker of ["基础行情与 TS 图层", "下一交易日初步观察", "TS专业看盘", "返回 Trading OS 主站", "Owner Trigger Layer", "当前预测", "本时段尚无正式预测", "预测增强研究", "原概率", "不自动下单", "基础K线", "TS图层", "历史70 / 预测30", "历史60 / 预测40", "历史50 / 预测50", "预测专注", "现在 · TS发布", "决策栏", "专注看盘", "Shadow · 严格只读"]) assert.match(forecast, new RegExp(marker));
  for (const marker of ["SPY → SPXW Proxy Mode", "分析基准：", "SPY代理结构", "SPX现货数据：", "不可用", "券商只读报价", "观测变化（不是真实收益）", "手动查询不会改选 Strike", "source_mode=OWNER_OBSERVED", "Shadow · 不执行交易"]) assert.match(forecast, new RegExp(marker));
  for (const marker of ["SPX期权凸性机会账本", "Owner本金适配", "Ask/Bid可执行证据", "观察变化不进入账户P/L"]) assert.match(forecast, new RegExp(marker));
  for (const forbidden of ["SPX实时价格", "SPX 5分钟K线", "SPX成交量", "SPX VWAP", "SPX自动跌破"]) assert.doesNotMatch(forecast, new RegExp(forbidden));
  assert.match(forecast, /approved-cockpit prototype-shell/);
  assert.match(forecast, /id="chart-host"/);
  assert.match(forecast, /id="shared-fan"/);
  assert.equal(forecast.match(/id="chart-host"/g)?.length, 1);
  assert.match(forecast, /id="symbol-select"/);
  assert.match(forecast, /id="interval-select"/);
  assert.match(forecast, /id="range-select"/);
  assert.match(forecast, /mobile-workbench-bar/);
  assert.match(forecast, /打开 Trading OS 导航/);
  assert.match(forecast, /Trading OS 七个主页面/);
  assert.match(forecast, /单指左右拖动，双指缩放；进入专注看盘后可自由操作图表。/);
  for (const href of ["/", "/forecast", "/options", "/company", "/health", "/settlements", "/issues"]) assert.match(forecast, new RegExp(`href="${href}"`));
  assert.doesNotMatch(forecast, /4071|SAMPLE|固定样本|原型价格/);
  assert.doesNotMatch(forecast, /forecast-chart-workspace|page-subnav|TS 专业看盘|老板投诉箱/);
  const approvedShellSource = await readFile(new URL("../app/ApprovedBrokerChartPrototype.tsx", import.meta.url), "utf8");
  const approvedShellCss = await readFile(new URL("../app/approved-broker-chart.css", import.meta.url), "utf8");
  const ownerServerSource = await readFile(new URL("../server/local-owner-server.ts", import.meta.url), "utf8");
  assert.match(approvedShellSource, /AbortSignal\.timeout\(10_000\)/);
  assert.match(approvedShellSource, /"x-trading-os-caller": "forecast_client"/);
  assert.match(approvedShellSource, /NO_CONTRACT_SELECTED/);
  assert.match(approvedShellSource, /Robinhood App观察列表不会自动同步/);
  assert.match(approvedShellSource, /resolveTsForecastContext/);
  for (const marker of ["预测证据", "NOT_STARTED", "盘中下一观察窗口（30—60分钟）", "NextSessionObservationCard", "交易资格 · 下一确认窗口", "CONTRACT_FOUND_QUOTE_STALE", "报价不可用仍可建立本地观察", "observation_id"]) assert.match(approvedShellSource, new RegExp(marker));
  assert.doesNotMatch(approvedShellSource, /Forecast Layer · 次日预测/);
  assert.doesNotMatch(approvedShellSource, /情景证据成熟度/);
  assert.doesNotMatch(approvedShellSource, /setSpxMessage\(error instanceof Error \? error\.message/);
  assert.match(approvedShellSource, /没有可用的EOD回退数据/);
  assert.match(approvedShellSource, /kineticScroll: \{ mouse: true, touch: false \}/);
  assert.match(approvedShellSource, /vertTouchDrag: immersive/);
  assert.match(approvedShellCss, /#chart-host \{[^}]*touch-action: pan-y pinch-zoom/);
  assert.match(approvedShellCss, /data-immersive="true"[^}]*#chart-host[^}]*touch-action: none/);
  assert.match(approvedShellCss, /mobile-workbench-bar[^}]*z-index: 100/);
  assert.match(approvedShellCss, /mobile-workbench-bar[^}]*position: fixed/);
  assert.match(approvedShellCss, /mobile-site-menu > summary[^}]*min-height: 44px/);
  assert.match(approvedShellCss, /@media \(max-width: 700px\)[\s\S]*\.proxy-grid \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(ownerServerSource, /本机访问入口/);
  assert.match(ownerServerSource, /http:\/\/127\.0\.0\.1:4160/);
  assert.match(ownerServerSource, /此版本仅允许本机访问，不开放家庭网络或公网/);
  assert.doesNotMatch(ownerServerSource, /https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/);
  assert.match(ownerServerSource, /SCHEDULE_CHECKPOINT: state\.outputs\.SCHEDULE_CHECKPOINT\.filter\(\(item\) => item\.kind === "EVENING_ANALYSIS"\)\.slice\(0, 1\)/);
  const homeSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const todayActionSource = await readFile(new URL("../app/TodayActionCard.tsx", import.meta.url), "utf8");
  assert.match(homeSource, /forecast_id/);
  assert.match(homeSource, /fetchActiveSnapshot\(page\)/);
  for (const marker of ["market-evidence-details", "settlement-recent-details", "capability-audit-details"]) assert.match(homeSource, new RegExp(marker));
  assert.match(todayActionSource, /周五冻结的策略与持仓只作历史参考/);

  const options = pages["/options"];
  for (const marker of ["真实持仓、原计划与当前风险", "本槽期权策略比较过程", "Long Call", "0–1 DTE", "2–7 DTE", "14–60 DTE", "90\\+ DTE", "老板先看反方证据", "信号状态机与收盘复盘", "只展示真实发生过的变化", "NO TRADE 是合法结果", "独立评审组意见", "D 给老板的统一结论", "A3 跟踪事项与待办", "Robinhood 官方只读数据"]) assert.match(options, new RegExp(marker));
  assert.doesNotMatch(options, /TS 预测驾驶舱|公司时间线/);
  for (const marker of ["unified-review", "department-details", "查看合约门禁、路径与候选明细", "查看历史记录与结算"]) assert.match(options, new RegExp(marker));
  assert.match(options, /<dialog class="detail-sheet"/);
  assert.doesNotMatch(options, /<dialog[^>]*\bopen/);

  const company = pages["/company"].replace(/<!--.*?-->/g, "");
  for (const marker of ["固定池、事件、财报与临时发现", "搜索标的", "全部90", "70只股票", "20只ETF", "稀土与关键矿产", "油气、油服与中游", "日线", "4小时", "1小时", "30分钟", "为什么值得关注", "当前限制", "等待首次官方归档", "等待下一自然槽的官方 24_5 能力清单", "System A · 技术结构", "System B · 事件等级", "财报机会与公布后验证", "公司时间线", "早中晚和收工巡检", "初始化漏跑", "加州时间", "完整通过还要求连续 3 个有效交易日"]) assert.match(company, new RegExp(marker));
  assert.match(company, /planned-timeline/);
  assert.match(company, /company-capability-details/);
  assert.match(company, /company-patrol-details/);
  assert.match(company, /company-key-timeline/);
  assert.match(company, /company-technical-log/);
  assert.match(company, /展开完整时间线、WAIT \/ NO_TRADE 与技术状态/);
  assert.doesNotMatch(company, /TS 预测驾驶舱|老板投诉箱/);

  const health = pages["/health"];
  for (const marker of ["系统健康与管控中心", "开机与恢复", "五分钟目标", "待真实冷启动", "当前总状态", "正常情况，不算故障", "当前问题", "已恢复与历史问题", "网站服务", "SQLite 数据库", "Gateway 与账本", "页面与 K 线 API", "Finnhub 新闻与财报"]) assert.match(health, new RegExp(marker));
  assert.match(health, /health-domain-details/);
  assert.ok(health.indexOf("health-counts") > health.indexOf("系统健康与管控中心"));

  const settlements = pages["/settlements"];
  assert.match(settlements, /id="research-paper"/);
  assert.match(settlements, /完整期权模拟单与跟踪/);
  assert.match(company, /id="market-events"/);
  assert.match(company, /id="owner-opportunities"/);
  for (const marker of ["运营完整性与预测准确率分开看", "UNVALIDATED", "独立自然Forward交易日", "场景权重", "后验多数类别占比", "预测交付率", "到期结算覆盖率", "SPY<!-- --> 研究层全预测方向", "尚未证明预测优势", "LEGACY_NON_CAUSAL_WINDOW", "三分类 Brier", "正式结果与影子验证", "不可做绩效对比"]) assert.match(settlements, new RegExp(marker));
  assert.match(settlements, /settlement-comparison-details/);
  assert.doesNotMatch(settlements, /TS 预测驾驶舱|老板投诉箱/);

  const issues = pages["/issues"];
  for (const marker of ["导入数据快照", "下载脱敏样本", "老板投诉箱", "本地数据库持久保存", "严重程度", "截图（可选", "旧能力保留状态", "已保留并自然运行", "存在但未接入网站", "存在但未接当前冻结链", "尚未实现", "明确退役", "观察池", "TS 中短期波段记分卡", "上线前剩余证据与已知边界"]) assert.match(issues, new RegExp(marker));
  assert.doesNotMatch(issues, /TS 预测驾驶舱|公司时间线/);
  assert.match(issues, /capability-audit-details/);

  for (const path of ["/options", "/company", "/health", "/settlements", "/issues"]) {
    assert.match(pages[path], /owner-console-compact/);
    assert.match(pages[path], /老板完整当前结论/);
  }

  for (const [path, html] of Object.entries(pages)) {
    if (path === "/forecast") continue;
    assert.match(html, /显示大小/);
    for (const marker of ["当前实时", "本槽冻结证据", "最近成功 TS 槽", "今天历史故障", "下一有效检查"]) assert.match(html, new RegExp(marker));
    assert.match(html, /当前数据口径/);
    assert.match(html, /历史 \/ REPLAY/);
    assert.match(html, /Shadow · 只读观察 · 不自动下单/);
    assert.doesNotMatch(html, /V2 参考版本 · 提交/);
    const activePath = path === "/company" ? "/forecast" : path;
    assert.match(html, new RegExp(`href="${activePath}"[^>]*aria-current="page"|aria-current="page"[^>]*href="${activePath}"`));
    assert.doesNotMatch(html, /0\.18%|42 ms|72%|\+16/);
  }
});

test("watch universe renders the frozen version and filters new sectors as stocks", async () => {
  const [{ transpileModule, JsxEmit, ModuleKind, ScriptTarget }, jsx, react, { renderToStaticMarkup }, decisions] = await Promise.all([import("typescript"), import("react/jsx-runtime"), import("react"), import("react-dom/server"), import("../app/owner-market-decisions.ts")]);
  const source = await readFile(new URL("../app/MarketRadar.tsx", import.meta.url), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  const component = {};
  let stateIndex = 0, group = "ALL";
  new Function("exports", "require", compiled)(component, (name) => {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react") return { ...react, useState: (initial) => react.useState(stateIndex++ === 1 ? group : initial) };
    if (name === "./market-time") return { formatPtDateTime };
    if (name === "./snapshot-import") return { APPROVED_STOCKS, WATCH_SECTORS, approvedUniverse };
    if (name === "./owner-market-decisions") return decisions;
    throw Error(`Unexpected component dependency: ${name}`);
  });
  const snapshot = (version) => ({ contract_version: version, generated_at: "2026-09-14T14:30:00.000Z", fixed_pool: { candidates: [], rows: [], missing_symbols: [...approvedUniverse(version)] }, earnings_center: { items: [] }, event_scan: { items: [] } });
  const renderRadar = (value, filter = "ALL") => { stateIndex = 0; group = filter; return renderToStaticMarkup(jsx.jsx(component.MarketRadar, { snapshot: value, nextCheck: "下一自然检查" })); };
  const listed = (html) => [...html.match(/<nav class="radar-symbols"[\s\S]*?<\/nav>/)[0].matchAll(/<b>([^<]+)<\/b>/g)].map((match) => match[1]);
  const legacy = snapshot("v2"), current = snapshot("v3"), before = structuredClone([legacy, current]);
  const oldHtml = renderRadar(legacy), newHtml = renderRadar(current), emptyHtml = renderRadar(undefined);
  assert.deepEqual(listed(oldHtml), approvedUniverse("v2"));
  assert.match(oldHtml, /全部70.*50只股票.*20只ETF/);
  assert.match(oldHtml, /当前展示旧70快照/);
  assert.doesNotMatch(oldHtml, /<b>(?:MP|USAR|XOP)<\/b>|稀土与关键矿产/);
  for (const html of [newHtml, emptyHtml]) {
    assert.deepEqual(listed(html), approvedUniverse("v3"));
    assert.match(html, /全部90.*70只股票.*20只ETF/);
    assert.match(html, /<b>MP<\/b><small>股票<\/small>/);
    assert.match(html, /<b>USAR<\/b><small>股票<\/small>/);
    assert.match(html, /<b>XOP<\/b><small>ETF<\/small>/);
    assert.doesNotMatch(html, /<b>XSP<\/b>/);
  }
  assert.match(emptyHtml, /当前计划观察90个标的.*等待首次官方归档/);
  assert.deepEqual(listed(renderRadar(current, "STOCK")), approvedUniverse().filter((symbol) => APPROVED_STOCKS.includes(symbol)));
  assert.equal(listed(renderRadar(current, "ETF")).length, 20);
  assert.deepEqual(listed(renderRadar(current, WATCH_SECTORS[0].label)), [...WATCH_SECTORS[0].symbols]);
  assert.deepEqual([legacy, current], before, "rendering must not migrate frozen snapshots");
});

test("watch universe coverage keeps the legacy XSP exception out of new Manager and retention results", () => {
  const at = "2026-09-14T14:30:00.000Z";
  const state = { runLedger: { runs: [] }, selfCheck: { active: [], recent: [], checked_at: at, last_backup_at: at }, dataSources: [], ownerQueue: { open_complaints: 0, pending_approval: 0, total_complaints: 0 }, scheduler: { recent: [], next_run: null }, outputs: { TS_SHADOW_OUTPUT: [], OPTION_STRATEGY_SIGNAL: [], POSITION_COPILOT_STATE: [] }, marketRadar: { snapshot: null }, marketIntelligence: { causalChains: [] }, tsSettlement: { recent: [], pending_count: 0 }, optionLifecycle: { recent_settlements: [], pending_count: 0 } };
  const cases = [["v2", ["XSP"], true], ["v2", ["AAPL"], false], ["v3", [], true], ["v3", ["MP"], false], ["v3", ["XSP"], false], ["v3", approvedUniverse().slice(69), false]];
  for (const [version, missing, complete] of cases) {
    const size = approvedUniverse(version).length;
    const approved = { contract_version: version, fixed_pool: { universe_size: size, observed_count: size - missing.length, missing_symbols: missing, rows: [], data_grade: "OFFICIAL_READONLY_MULTI_TIMEFRAME_SWING", qualification: "MULTI_TIMEFRAME_SWING_RESEARCH" }, owner_watchlist: { status: "NOT_OBSERVED", items: [] }, earnings_center: { items: [] }, event_scan: { items: [] }, extended_discovery: { symbols: [] } };
    state.outputs.A1_SHADOW_RESULT = { market_sources: { approved_capabilities: approved } };
    const original = structuredClone(approved);
    assert.deepEqual(approvedPoolCoverage(approved), { size, complete });
    const review = buildCodexManagerReview(state, new Date(at), "POST_DEPLOY");
    assert.equal(review.issues.some((item) => item.code === "MANAGER_FIXED70_COVERAGE_DEGRADED"), !complete, `${version} ${missing}`);
    assert.ok(review.checks.some((item) => item.summary.includes(`${size - missing.length}/${size}`)));
    const retention = capabilityRetentionAudit(state).find((item) => item.name === "观察池机会雷达");
    assert.equal(retention.status, complete ? "PRESERVED_LIVE" : "FREEZE_GAP");
    assert.match(retention.current_evidence, new RegExp(`${size - missing.length}/${size}`));
    assert.deepEqual(approved, original);
  }
  assert.deepEqual(approvedPoolCoverage(undefined), { size: 90, complete: false });
});

test("capability retention requires observed statuses before claiming preserved capability", () => {
  const state = {
    runLedger: { runs: [{ slot_id: "live-shadow:20260927T140000Z", agent_id: "A2", channel: "SHADOW", status: "SUCCEEDED", output_status: "PRODUCED", website_delivery: "DELIVERED" }] },
    outputs: { POSITION_COPILOT_STATE: [], A2_SHADOW_RESULT: {}, A1_SHADOW_RESULT: null },
    marketIntelligence: { causalChains: [] }, tsSettlement: { recent: [], official_live_count: 0 },
  };
  const names = ["财报中心", "持仓监控与持仓副驾驶", "中短期波段与回撤门禁"];
  const a1 = { market_sources: { approved_capabilities: { fixed_pool: { qualification: "MULTI_TIMEFRAME_SWING_RESEARCH" }, owner_watchlist: { status: "NOT_OBSERVED", items: [] }, earnings_center: { items: [] }, event_scan: { items: [] }, extended_discovery: { symbols: [] } } } };
  const statuses = () => names.map((name) => capabilityRetentionAudit(state).find((row) => row.name === name).status);
  assert.deepEqual(statuses(), ["FREEZE_GAP", "FREEZE_GAP", "FREEZE_GAP"]);
  for (const status of [undefined, null, "", "NOT_OBSERVED", "UNRECOGNIZED", ["HEALTHY"], {}]) {
    state.outputs.A2_SHADOW_RESULT.capability_summary = { earnings_watch: { status }, position_monitor: { status }, system_a: { trend_pullback_status: status } };
    assert.deepEqual(statuses(), ["FREEZE_GAP", "FREEZE_GAP", "FREEZE_GAP"], String(status));
    state.outputs.A1_SHADOW_RESULT = a1;
    assert.deepEqual(statuses(), ["PRESERVED_LIVE", "FREEZE_GAP", "FREEZE_GAP"], `${String(status)} with approved pool`);
    state.outputs.A1_SHADOW_RESULT = null;
  }
  for (const status of ["HEALTHY", "DEGRADED", "INACTIVE"]) {
    state.outputs.A2_SHADOW_RESULT.capability_summary = { earnings_watch: { status }, position_monitor: { status }, system_a: { trend_pullback_status: status } };
    assert.deepEqual(statuses(), [status === "INACTIVE" ? "FREEZE_GAP" : "PRESERVED_LIVE", "WEBSITE_GAP", "FREEZE_GAP"]);
    state.outputs.A1_SHADOW_RESULT = a1;
    assert.deepEqual(statuses(), ["PRESERVED_LIVE", "WEBSITE_GAP", status === "HEALTHY" ? "PRESERVED_LIVE" : "FREEZE_GAP"]);
    state.outputs.A1_SHADOW_RESULT = null;
  }
  state.outputs.POSITION_COPILOT_STATE.push({ source_mode: "LIVE", holdings: [], observed_at: "2026-09-27T14:00:00Z" });
  state.outputs.A1_SHADOW_RESULT = a1;
  state.outputs.A2_SHADOW_RESULT.capability_summary = {};
  assert.deepEqual(statuses(), ["PRESERVED_LIVE", "PRESERVED_LIVE", "FREEZE_GAP"]);
});

test("workspace shortlist stays a summary and retains expired-data and approval boundaries", async () => {
  const [{ transpileModule, JsxEmit, ModuleKind, ScriptTarget }, jsx, react, { renderToStaticMarkup }, decisions] = await Promise.all([import("typescript"), import("react/jsx-runtime"), import("react"), import("react-dom/server"), import("../app/owner-market-decisions.ts")]);
  const source = await readFile(new URL("../app/MarketRadar.tsx", import.meta.url), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  const component = {};
  new Function("exports", "require", compiled)(component, (name) => {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react") return react;
    if (name === "./market-time") return { formatPtDateTime };
    if (name === "./snapshot-import") return { APPROVED_STOCKS, WATCH_SECTORS, approvedUniverse };
    if (name === "./owner-market-decisions") return decisions;
    throw Error(`Unexpected component dependency: ${name}`);
  });
  const at = "2026-09-11T18:00:00.000Z";
  const row = { symbol: "SPY", as_of: at, status: "LIVE", direction: "BULLISH", swing: { direction: "BULLISH", stage: "EARLY_WATCH", why_watch: ["原冻结依据"], management: { entry_trigger: 110, price_invalidation: 100, target_1: 120 } } };
  const state = { generated_at: at, fixed_pool: { candidates: ["SPY"], rows: [row] }, real_positions: { status: "OBSERVED", symbols: [] } };
  const original = structuredClone(state);
  const render = (props = {}) => renderToStaticMarkup(jsx.jsx(component.OwnerOpportunityShortlist, { snapshot: state, at, nextCheck: "下一自然检查", compact: true, ...props }));
  assert.match(render(), /条件观察，未获交易批准/);
  assert.match(render(), /<table class="workspace-watchlist">/);
  assert.equal(render().match(/scope="col"/g)?.length, 3);
  assert.match(render(), /<th scope="row">SPY<\/th>/);
  assert.match(render(), /原观察方向/);
  assert.ok(render().includes(`观察冻结于 ${formatPtDateTime(at)}`));
  assert.match(render({ currentReadFailed: true }), /最近采集失败/);
  assert.match(render({ at: "2026-09-11T18:07:00.000Z" }), /条件观察，未获交易批准/);
  assert.match(render({ at: "2026-09-11T18:07:01.000Z" }), /报价超过7分钟/);
  for (const [patch, message] of [
    [{ status: "MARKET_CLOSED" }, /收盘参考/],
    [{ status: "STALE" }, /报价已过期/],
    [{ status: "DATA_BLOCKED" }, /报价证据不全/],
    [{ as_of: null }, /报价时间缺失或无效/],
    [{ as_of: "not-a-time" }, /报价时间缺失或无效/],
    [{ as_of: "2026-09-11T18:00:01.000Z" }, /报价时间异常/],
  ]) assert.match(render({ snapshot: { ...state, fixed_pool: { ...state.fixed_pool, rows: [{ ...row, ...patch }] } } }), message);
  assert.match(render({ snapshot: undefined }), /尚未取得冻结观察/);
  const failedEmpty = render({ snapshot: { ...state, fixed_pool: { ...state.fixed_pool, candidates: [] } }, currentReadFailed: true });
  assert.match(failedEmpty, /本次观察读取失败/);
  assert.doesNotMatch(failedEmpty, /本次检查没有符合条件/);
  assert.match(render(), /href="\/company#owner-opportunities"/);
  assert.doesNotMatch(render(), /110|100|120|data-plan-stage/);
  assert.match(render(), /原冻结依据/);
  const detailState = { ...state, event_scan: { items: [] }, earnings_center: { items: [] } };
  detailState.fixed_pool = { ...state.fixed_pool, rows: [{ ...row, swing: { ...row.swing, management: { ...row.swing.management, next_check: "旧的复查约定" } } }] };
  const detailHtml = render({ snapshot: detailState, compact: false, nextCheck: "2026/09/14 06:20" });
  assert.match(detailHtml, /下一次自然检查：2026\/09\/14 06:20/);
  assert.match(detailHtml, /原观察约定：旧的复查约定/);
  assert.doesNotMatch(detailHtml, /下一检查：旧的复查约定/);
  assert.deepEqual(state, original);
});

test("research paper reads fail independently and leave the frozen review state untouched", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const body = source.match(/if \(page !== "settlements"\) return;([\s\S]*?)\n {2}\}, \[page\]\);/)?.[1];
  assert.ok(body);
  const updates = [], timers = [], win = { setInterval: (tick) => { timers.push(tick); return 1; }, clearInterval: () => {} };
  const initialize = new Function("fetchActiveSnapshot", "setResearchPaper", "window", body);
  let paper = {};
  const cleanup = initialize(async () => { throw Error("paper read unavailable"); }, (value) => { paper = typeof value === "function" ? value(paper) : value; updates.push(paper); }, win);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(updates[0].error, /不是最新状态/);
  assert.equal(updates[0].overview, undefined, "failed first read cannot invent a ticket count");
  const previous = { plans: [{ id: "previously-read" }] };
  paper = { overview: previous };
  timers[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(paper.overview, previous, "a failed refresh preserves the last read without blanking the page");
  assert.match(paper.error, /更新失败.*上次读取内容.*不是最新状态/);
  assert.doesNotMatch(body, /setImportState/, "the independent paper request cannot replace the main research view");
  cleanup();
});

test("home paper counts use today's California date including weekends and holidays", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const navExpression = page.match(/href="#today-paper"><span>模拟练习<\/span><strong>\{(.+?)\}<\/strong>/)?.[1];
  assert.ok(navExpression);
  const navTitle = new Function("isNyseRegularSession", "paperDay", "todayPaperCount", "PAPER_DAILY_TARGET", `return ${navExpression.replaceAll("paperDay!", "paperDay")};`);
  for (const date of ["2026-09-27", "2026-09-07"]) assert.equal(navTitle(isNyseRegularSession, { date, label: "今日" }, 0, 3), "今日休市 · 无建单任务");
  assert.equal(navTitle(isNyseRegularSession, { date: "2026-09-28", label: "今日" }, 0, 3), "今日 0/3 张");
  assert.equal(navTitle(isNyseRegularSession, null, null, 3), "读取中，数量未知");
  const declarations = ["paperDay", "todayPaperCount"].map((name) => page.match(new RegExp(`  const ${name} = .*;`))?.[0]).join("\n");
  const evaluate = new Function("paperReportingDay", "ptDateKey", "importState", "currentTime", `${declarations}; return { day: paperDay, count: todayPaperCount };`);
  const state = { paperPlans: { plans: ["2026-09-04", "2026-09-11", "2026-09-11", "2026-09-11"].map((market_date) => ({ plan: { market_date } })) } };
  const original = structuredClone(state);
  for (const [at, date, label, count] of [
    ["2026-09-12T03:59:00Z", "2026-09-11", "今日", 3],
    ["2026-09-12T04:00:00Z", "2026-09-11", "今日", 3],
    ["2026-09-12T06:33:00Z", "2026-09-11", "今日", 3],
    ["2026-09-12T12:00:00Z", "2026-09-12", "今日", 0],
    ["2026-09-14T06:30:00Z", "2026-09-13", "今日", 0],
    ["2026-09-14T12:00:00Z", "2026-09-14", "今日", 0],
    ["2026-09-07T16:00:00Z", "2026-09-07", "今日", 0],
  ]) assert.deepEqual(evaluate(paperReportingDay, ptDateKey, state, Date.parse(at)), { day: { date, label }, count }, at);
  assert.equal(evaluate(paperReportingDay, ptDateKey, {}, Date.parse("2026-09-12T04:00:00Z")).count, null);
  for (const at of [0, NaN, Infinity, -1, 8.64e15 + 1]) assert.deepEqual(evaluate(paperReportingDay, ptDateKey, state, at), { day: null, count: null });
  assert.match(page, /paperDay!\.label \+ " " \+ todayPaperCount/);
  assert.deepEqual(state, original);
});

test("today action prioritizes risk management and never revives a closed-market entry", () => {
  const candidate = { candidate_id: "candidate", symbol: "SPY", strategy_type: "LONG_CALL" };
  const strategy = { owner_action: "EXECUTABLE", selected_candidate_id: "candidate", candidates: [candidate] };
  const positions = { holdings: [{ holding_id: "hold", owner_action: "HOLD" }, { holding_id: "exit", owner_action: "EXIT" }] };
  assert.equal(selectTodayAction(strategy, positions).action, "EXIT");
  assert.equal(selectTodayAction(strategy, { holdings: [] }).action, "EXECUTABLE");
  assert.equal(selectTodayAction(strategy, { holdings: [] }, false).action, "WAIT");
  assert.equal(selectTodayAction({ owner_action: "OBSERVE", candidates: [] }, { holdings: [] }).action, "OBSERVE");
});

test("expired Owner sessions leave no stale dashboard and touch layouts keep usable targets", async () => {
  const snapshotSource = await readFile(new URL("../app/snapshot-import.ts", import.meta.url), "utf8");
  const chartSource = await readFile(new URL("../app/LiveMarketChart.tsx", import.meta.url), "utf8");
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(snapshotSource, /response\.status === 401/);
  assert.match(snapshotSource, /\/login\?return_to=/);
  assert.doesNotMatch(css, /zoom:/);
  assert.match(css, /--owner-body-size: 17px/);
  assert.match(css, /html\[data-owner-font="small"\].*--owner-body-size: 16px/);
  assert.match(css, /html\[data-owner-font="large"\].*--owner-body-size: 18px/);
  assert.match(css, /\.page-subnav a, \.layer-controls button, \.view-controls button, \.topbar button \{ min-height: 44px; \}/);
  assert.match(css, /\.today-action-card > footer a .*min-height: 44px/);
  assert.match(css, /\.app-shell main details:not\(\[open\]\) > :not\(summary\) \{ display: none !important; \}/);
  assert.match(css, /\.owner-console-strip \{[^}]*grid-template-columns: repeat\(4/);
  assert.match(css, /\.owner-console-compact > summary \{[^}]*grid-template-columns:/);
  assert.match(pageSource, /marketIsClosed \? "NO TRADE"/);
  assert.match(pageSource, /TradingOsLegacyApp key=\{page\}/);
  assert.doesNotMatch(pageSource, /currentTime \|\| Date\.now\(\)/);
  assert.match(pageSource, /最后有效倾向：/);
  assert.match(pageSource, /自动观察中 · 无需Owner处理/);
  assert.match(chartSource, /visibleBeforeRefresh/);
  assert.match(chartSource, /setVisibleLogicalRange\(visibleBeforeRefresh\)/);
  assert.match(chartSource, /manualViewRef/);
  assert.match(chartSource, /priceScale\("right"\)\.getVisibleRange/);
  assert.match(chartSource, /setVisibleRange\(priceBeforeRefresh\)/);
  assert.match(chartSource, /autoscaleInfoProvider: \(\) => null/);
  assert.match(chartSource, /setSplitRatio/);
  assert.match(chartSource, /setPointerCapture/);
  assert.match(chartSource, /priceDragRef/);
  assert.match(chartSource, /className="chart-height-slider"/);
  assert.match(chartSource, /onInput=.*applyChartHeight/);
  assert.match(chartSource, /subscribeSizeChange/);
  assert.match(chartSource, /--chart-height/);
  assert.match(chartSource, /Number\(end\) - 29/);
  assert.match(chartSource, /data-focus=/);
  assert.match(chartSource, /data-rail=/);
  assert.doesNotMatch(chartSource, /BaselineSeries|baseValue: \{ type: "price"/);
  assert.match(chartSource, /forecastFanGeometry/);
  assert.match(chartSource, /time: Number\(anchorBar\.time\)/);
  assert.match(chartSource, /shared-uncertainty-fan/);
  assert.match(chartSource, /forecast-fan-overlay/);
  assert.match(chartSource, /forecast-local-zoom/);
  assert.match(chartSource, /价格未改变/);
  assert.match(chartSource, /data-price=\{point\.value\}/);
  assert.match(chartSource, /forecast-path-labels/);
  assert.match(chartSource, /概率走廊/);
  assert.match(chartSource, /延长时段报价/);
  assert.match(chartSource, /System A结构/);
  assert.match(chartSource, /CSS fallback covers browsers without element fullscreen/);
  assert.match(css, /\.forecast-chart-workspace\[data-fullscreen="true"\].*position: fixed/);
  assert.match(css, /\.forecast-chart-workspace\[data-focus="true"\].*position: fixed/);
  assert.match(css, /\.forecast-chart-workspace\[data-rail="false"\].*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.chart-canvas .*touch-action: none/);
  assert.match(css, /\.forecast-boundary .*cursor: col-resize/);
  assert.match(css, /\.chart-price-drag .*cursor: ns-resize/);
  assert.match(css, /\.chart-height-slider input .*cursor: ew-resize/);
  assert.match(css, /height: var\(--chart-height/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\[data-focus="true"\][\s\S]*\.chart-toolbar .*overflow-x: auto/);
  assert.match(css, /\[data-focus="true"\][\s\S]*\.chart-frame \{ height: var\(--chart-height, calc\(100dvh - 150px\)/);
  assert.match(pageSource, /"NEXT_SESSION", "WEEKEND_OUTLOOK"/);
  assert.match(pageSource, /"次日初步预测"/);
  assert.doesNotMatch(pageSource, /latestShadowTs \? "当前自然槽"/);
});

test("health presentation separates stale evidence from incidents and uses only scheduled future times", async () => {
  const at = Date.parse("2026-09-27T21:00:00.000Z");
  const historical = { incident_id: "old-manager", layer: "MANAGER", severity: "WARNING", status: "ACTIVE", title: "Old review", details: {} };
  const state = {
    outputCount: 1, outputs: {}, runLedger: { runs: [], eventCount: 1 },
    selfCheck: { status: "DEGRADED", checked_at: new Date(at - 40_000).toISOString(), last_backup_at: new Date(at - 40_000).toISOString(), active: [historical], recent: [historical] },
    dataSources: [{ source: "ROBINHOOD", status: "MARKET_CLOSED", authorization: "VALID" }],
    scheduler: { next_run: { label: "开盘前检查", scheduled_at: "2026-09-28T13:20:00.000Z" }, today: { expected: 0 }, recent: [], health_window: { missed: 0, failed: 0, blocked: 0 } },
    currentTruth: { trading_date: "2026-09-27", issues: { lifecycle: [{ incident_id: historical.incident_id, status: "HISTORICAL" }] }, market_data_health: { classification: "MARKET_CLOSED" }, natural_slot: { slot_id: null } },
  };
  const original = JSON.stringify(state), current = buildHealthOverview(state, at);
  assert.equal(current.selfCheckStatus, "HEALTHY", "raw historical warnings do not become current incidents");
  assert.equal(current.current.length, 0);
  assert.equal(current.nextCheckAt, null, "a completed self-check is not a schedule for another check");
  assert.equal(current.nextScheduledRun.scheduled_at, state.scheduler.next_run.scheduled_at);
  const checkDomains = (view, tone) => {
    for (const id of ["website", "database", "page", "maintenance"]) assert.equal(view.domains.find((domain) => domain.id === id).tone, tone, `${id} uses current complete-check evidence`);
  };
  checkDomains(current, "GOOD");
  assert.equal(JSON.stringify(state), original, "source history is unchanged");
  const stale = buildHealthOverview(state, at + 181_000);
  assert.equal(stale.selfCheckStatus, "NOT_VERIFIED");
  assert.equal(stale.current.length, 0);
  checkDomains(stale, "WARNING");
  assert.match(stale.currentSummary, /网站服务（待核验）.*自动维护（待核验）/);
  assert.doesNotMatch(stale.currentSummary, /未恢复|当前有故障/);
  state.selfCheck.checked_at = new Date(at + 5_000).toISOString();
  const future = buildHealthOverview(state, at);
  assert.equal(future.selfCheckStatus, "NOT_VERIFIED", "future timestamps cannot verify current health");
  checkDomains(future, "WARNING");
  state.selfCheck.checked_at = new Date(at).toISOString();
  for (const backup of [null, "invalid", new Date(at + 5_000).toISOString()]) {
    state.selfCheck.last_backup_at = backup;
    assert.equal(buildHealthOverview(state, at).domains.find((domain) => domain.id === "database").tone, "WARNING", "missing, invalid or future backup timestamps cannot verify recovery evidence");
  }
  state.selfCheck.last_backup_at = new Date(at - 40_000).toISOString();
  const fault = { ...historical, incident_id: "service-fault", layer: "SERVICE", severity: "CRITICAL", title: "Website unavailable", details: { next_check_at: new Date(at - 1).toISOString() } };
  state.selfCheck.active.push(fault);
  state.currentTruth.issues.lifecycle.push({ incident_id: fault.incident_id, status: "ACTIVE_BLOCKING" });
  const failed = buildHealthOverview(state, at);
  assert.equal(failed.selfCheckStatus, "CRITICAL");
  assert.equal(failed.current.length, 1);
  assert.equal(failed.current[0].next_check_at, null, "a passed incident retry is not displayed as upcoming");
  fault.details.next_check_at = new Date(at + 60_000).toISOString();
  assert.equal(buildHealthOverview(state, at).nextCheckAt, fault.details.next_check_at);
  state.scheduler.next_run.scheduled_at = new Date(at - 1).toISOString();
  assert.equal(buildHealthOverview(state, at).nextScheduledRun, null);
  for (const [layer, id] of [["DATABASE", "database"], ["API", "page"]]) {
    const domainFault = { ...fault, incident_id: `${id}-fault`, layer };
    state.selfCheck.active.push(domainFault);
    state.currentTruth.issues.lifecycle.push({ incident_id: domainFault.incident_id, status: "ACTIVE_BLOCKING" });
    assert.equal(buildHealthOverview(state, at + 181_000).domains.find((domain) => domain.id === id).tone, "CRITICAL", "actual incidents remain visible even when complete-check evidence has expired");
  }
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.equal((page.match(/healthOverview\.currentSummary/g) ?? []).length, 2, "both health summaries share the same meaning");
  assert.match(page, /下一项计划任务[\s\S]*healthOverview\.nextScheduledRun/);
  assert.doesNotMatch(page, /data-status=\{importState\.selfCheck\.status\}/);
  const declarations = ["ownerAttentionRequired", "ownerSystemBlocked", "systemSurfaceStatus", "ownerSystemStatus", "systemResult", "ownerResult"].map((name) => {
    const declaration = page.match(new RegExp(`  const ${name} = [\\s\\S]*?;`))?.[0];
    assert.ok(declaration, `${name} comes from the actual page`);
    return declaration;
  }).join("\n");
  const present = new Function("currentTruth", "healthOverview", "manualBuySymbols", `const systemStatus = healthOverview.overall; ${declarations} return { ownerAttentionRequired, systemSurfaceStatus, ownerSystemStatus, systemResult, ownerResult };`);
  const truth = { health_status: "HEALTHY", active_slot_id: null, natural_slot: { status: "MARKET_CLOSED" }, issues: { owner_action_required: false, automatic_recovery: false }, owner_queue: { pending_owner_approval: 0 } };
  const freshPage = present(truth, current, "");
  assert.equal(freshPage.systemSurfaceStatus, "HEALTHY");
  assert.equal(freshPage.systemResult, "正常", "fresh market-close evidence does not become a fault");
  for (const unverified of [stale, future]) {
    const view = present(truth, unverified, "");
    assert.equal(view.systemSurfaceStatus, "NOT_VERIFIED");
    assert.equal(view.systemResult, "当前待核验");
    assert.match(view.ownerSystemStatus, /当前待核验/);
    assert.equal(view.ownerAttentionRequired, false, "unknown health does not create an Owner task");
    assert.equal(view.ownerResult, "无需你操作");
  }
  const blocked = present({ ...truth, health_status: "BLOCKED" }, { ...stale, overall: "CRITICAL", status: "当前有故障" }, "");
  assert.equal(blocked.systemSurfaceStatus, "CRITICAL");
  assert.equal(blocked.systemResult, "异常", "a real block takes precedence over stale evidence");
  assert.equal(blocked.ownerSystemStatus, "当前有故障");
  const ownerRequired = present({ ...truth, owner_queue: { pending_owner_approval: 1 } }, stale, "");
  assert.equal(ownerRequired.ownerAttentionRequired, true);
  assert.equal(ownerRequired.systemResult, "需要关注");
  assert.equal(ownerRequired.ownerResult, "系统需要你处理");
  const recovering = present({ ...truth, issues: { ...truth.issues, automatic_recovery: true } }, { ...current, current: [historical], overall: "DEGRADED", status: "需要关注", selfCheckStatus: "DEGRADED" }, "");
  assert.equal(recovering.systemSurfaceStatus, "DEGRADED", "an active automatic-recovery issue is not healthy");
  assert.equal(recovering.ownerAttentionRequired, false);
  assert.match(recovering.ownerSystemStatus, /自动观察中/);
  const researchDebt = present(truth, { ...current, overall: "DEGRADED", status: "需要关注" }, "");
  assert.equal(researchDebt.systemSurfaceStatus, "HEALTHY", "isolated research or provider limits without active incidents do not become a global failure");
  assert.equal(researchDebt.systemResult, "正常");
});

test("a new user's successful blank snapshot is unconnected, not endless loading or a claimed broker feed", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const declarations = ["hasRuntimeData", "marketSourceConfigured", "quoteBarResult"].map((name) => {
    const declaration = page.match(new RegExp(`  const ${name} = [\\s\\S]*?;`))?.[0];
    assert.ok(declaration, `${name} is tested from the actual page`); return declaration;
  }).join("\n");
  const present = new Function("snapshotUpdatedAt", "importState", "marketSources", "currentTruth", "marketIsClosed", `${declarations} return { hasRuntimeData, quoteBarResult };`);
  const blank = { outputCount: 0, runLedger: { eventCount: 0 }, dataSources: [{ source: "ROBINHOOD", configured: false }, { source: "TRADIER", configured: false }, { source: "FINNHUB", configured: true }] };
  const truth = { market_data_health: { quote_health: "NOT_VERIFIED", bar_health: "NOT_VERIFIED" } };
  assert.equal(present(null, blank, null, truth, false).hasRuntimeData, false, "the initial request may still be loading");
  assert.deepEqual(present(1, blank, null, truth, false), { hasRuntimeData: true, quoteBarResult: "Quote / Bar 未连接" });
  const configured = { ...blank, dataSources: [{ source: "TRADIER", configured: true }] };
  assert.equal(present(1, configured, null, truth, false).quoteBarResult, "Quote / Bar 未验证");
  assert.equal(present(1, configured, {}, { market_data_health: { quote_health: "LIVE", bar_health: "LIVE" } }, false).quoteBarResult, "Quote / Bar 正常");
  assert.match(page, /setSnapshotUpdatedAt\(restored.snapshotGeneratedAt \? Date.parse\(restored.snapshotGeneratedAt\) : Date.now\(\)\)/);
  const chart = await readFile(new URL("../app/ApprovedBrokerChartPrototype.tsx", import.meta.url), "utf8");
  const label = chart.match(/ {2}const marketSourceLabel = .*;/)?.[0]; assert.ok(label);
  const sourceLabel = new Function("activeData", `${label} return marketSourceLabel;`);
  assert.equal(sourceLabel(null), "未连接"); assert.equal(sourceLabel({ source: "NOT_CONFIGURED" }), "未连接");
  assert.equal(sourceLabel({ source: "TRADIER" }), "TRADIER"); assert.equal(sourceLabel({ source: "ROBINHOOD" }), "ROBINHOOD");
  assert.match(chart, /source: "ROBINHOOD" \| "TRADIER" \| "NOT_CONFIGURED"/);
  assert.match(chart, /chart-brand[^>]*>\{symbol\} · \{marketSourceLabel\}/);
  const research = page.match(/<section className="panel priority-section" id="event-observation">[\s\S]*?<\/section>/)?.[0];
  assert.ok(research); assert.match(research, /事件资料核验/); assert.match(research, /未接通，不计入当前预测/); assert.match(research, /查看资料状态/);
  assert.doesNotMatch(research, /本期4个事件|5条修订|2026-09-27|2026年9月27日/);
});

test("uses one health meaning for normal close, history and real failures", () => {
  const incident = (overrides = {}) => ({ incident_id: "incident-1", fingerprint: "test", layer: "DESKTOP", code: "CODEX_DESKTOP_EXIT", severity: "INFO", status: "ACTIVE", title: "桌面程序退出", first_detected_at: "2026-08-13T05:00:00.000Z", last_seen_at: "2026-08-13T05:00:00.000Z", resolved_at: null, run_id: null, suggestion: "仅记录", occurrences: 1, complaint_id: "complaint-1", ...overrides });
  const state = {
    payload: null, archiveCount: 0, outputCount: 2, recentOutputs: [],
    outputs: {}, ownerQueue: { open_complaints: 0, pending_approval: 0 }, marketIntelligence: { eventCount: 0, events: [], causalChains: [] },
    runLedger: { agents: [], skills: [], routes: [], eventCount: 3, runs: [] },
    selfCheck: { status: "HEALTHY", checked_at: "2026-08-13T05:00:30.000Z", last_backup_at: "2026-08-13T05:00:00.000Z", active: [incident()], recent: [incident({ status: "RESOLVED", resolved_at: "2026-08-13T04:00:00.000Z" })] },
    dataSources: [{ source: "ROBINHOOD", status: "MARKET_CLOSED", configured: true, authorization: "VALID", last_success_at: "2026-08-13T05:00:00.000Z", as_of: "2026-08-12T20:00:00.000Z", freshness_seconds: 32400, error: null, checked_at: "2026-08-13T05:00:00.000Z", capabilities: {} }],
    scheduler: { timezone: "America/Los_Angeles", checked_at: "2026-08-13T05:00:30.000Z", next_run: null, today: { date: "2026-08-12", expected: 0, completed: 0, missed: 0, failed: 0, blocked: 0, pending: 0 }, health_window: { dates: ["2026-08-12"], completed: 1, missed: 0, failed: 0, blocked: 43, historical_missed: 594, initialization_missed: 594 }, groups: [], recent: [{ slot_id: "old", kind: "TS_FORECAST", label: "旧槽", business_slot: "12:30", scheduled_at: "2026-08-12T19:30:00.000Z", scheduled_pt: "2026-08-12 12:30:00 PT", trading_day: true, source_files: [], contract_version: "v1", role: "TIMELINE_SCHEDULER", status: "DATA_BLOCKED", started_at: null, completed_at: "2026-08-12T19:31:00.000Z", late_seconds: 60, result_ref: null, reason: "old" }] },
  };
  const closed = buildHealthOverview(state, Date.parse("2026-08-13T05:01:00.000Z"));
  assert.equal(closed.overall, "HEALTHY");
  assert.equal(closed.domains.find((item) => item.id === "market").status, "正常收盘");
  assert.equal(closed.current.length, 0);
  assert.equal(closed.history.length, 1);
  assert.ok(closed.normalNotes.some((item) => item.includes("594") && item.includes("不计入当前健康")));
  assert.ok(closed.normalNotes.some((item) => item.includes("43") && item.includes("审计记录")));

  state.scheduler.recent[0] = { ...state.scheduler.recent[0], slot_id: "new", status: "MISSED", completed_at: "2026-08-13T05:00:45.000Z" };
  assert.notEqual(buildHealthOverview(state, Date.parse("2026-08-13T05:01:00.000Z")).domains.find((item) => item.id === "scheduler").status, "运行异常");
  state.scheduler.recent[0] = { ...state.scheduler.recent[0], scheduled_at: "2026-08-13T05:00:00.000Z" };
  assert.equal(buildHealthOverview(state, Date.parse("2026-08-13T05:01:00.000Z")).overall, "CRITICAL");
  state.scheduler.recent = [
    { ...state.scheduler.recent[0], slot_id: "recovered", status: "SUCCEEDED", business_slot: "12:31", completed_at: "2026-08-13T05:01:15.000Z" },
    state.scheduler.recent[0],
  ];
  const recovered = buildHealthOverview(state, Date.parse("2026-08-13T05:01:30.000Z"));
  assert.notEqual(recovered.domains.find((item) => item.id === "scheduler").status, "运行异常");
  assert.ok(recovered.normalNotes.some((item) => item.includes("确认恢复")));
  state.scheduler.recent = [];

  state.dataSources[0] = { ...state.dataSources[0], status: "DATA_BLOCKED", authorization: "EXPIRED", error: "401" };
  assert.equal(buildHealthOverview(state, Date.parse("2026-08-13T05:01:00.000Z")).overall, "CRITICAL");
  state.selfCheck.active = [incident({ layer: "DATA", code: "NEWS_SOURCE_DEGRADED", severity: "WARNING", title: "新闻中断" })];
  state.dataSources[0] = { ...state.dataSources[0], status: "MARKET_CLOSED", authorization: "VALID", error: null };
  const newsWarning = buildHealthOverview(state, Date.parse("2026-08-13T05:01:00.000Z"));
  assert.equal(newsWarning.overall, "DEGRADED");
  assert.equal(newsWarning.domains.find((item) => item.id === "market").status, "正常收盘");

  state.dataSources.push({ source: "FINNHUB", status: "DATA_BLOCKED", configured: true, authorization: "NOT_VERIFIED", last_success_at: "2026-08-13T04:50:00.000Z", as_of: "2026-08-13T04:50:00.000Z", freshness_seconds: 660, error: "official endpoint unavailable", checked_at: "2026-08-13T05:00:30.000Z", capabilities: {} });
  const partialSource = buildHealthOverview(state, Date.parse("2026-08-13T05:01:00.000Z"));
  assert.equal(partialSource.domains.find((item) => item.id === "news").status, "能力降级");
  assert.equal(partialSource.domains.find((item) => item.id === "market").status, "正常收盘");

  state.selfCheck.active = [incident({ layer: "AGENT", code: "AGENT_UPSTREAM_BLOCKED", severity: "CRITICAL", title: "A2 已运行但被上游阻断", details: { fault_origin: "UPSTREAM_DATA", capability: "AGENT_INPUT", affected_modules: ["A2", "TS"], owner_required: false } })];
  const upstream = buildHealthOverview(state, Date.parse("2026-08-13T05:01:00.000Z"));
  assert.notEqual(upstream.domains.find((item) => item.id === "agents").status, "故障");
  assert.equal(upstream.current[0].fault_origin, "UPSTREAM_DATA");

  state.selfCheck.active = [];
  state.outputs = {
    A1_SHADOW_RESULT: { source_mode: "LIVE", market_sources: { options: [{ status: "MARKET_CLOSED", contract_count: 10 }, { status: "MARKET_CLOSED", contract_count: 20 }], account: { status: "LIVE", account_count: 1 } } },
    POSITION_COPILOT_STATE: [{ source_mode: "LIVE", observed_at: "2026-08-13T05:00:00.000Z", holdings: [{ quote_status: "UNAVAILABLE", next_check_at: "2026-08-13T06:30:00.000Z" }] }],
  };
  const separated = buildHealthOverview(state, Date.parse("2026-08-13T05:01:00.000Z"));
  assert.equal(separated.domains.find((item) => item.id === "options").status, "冻结已留证");
  assert.equal(separated.domains.find((item) => item.id === "account").status, "只读正常");
  assert.equal(separated.domains.find((item) => item.id === "holding").status, "报价异常");
  assert.equal(separated.overall, "DEGRADED");

  state.selfCheck.active = [incident({ layer: "MAINTENANCE", code: "WEBSITE_HEALTH_HANG", severity: "CRITICAL", title: "网站无响应", details: { detected: "健康接口连续失败", automatic_action: "已安全重启网站", owner_required: false, owner_action: "无需处理", forecast_impact: "短暂中断", history_impact: "SQLite 未改变" } })];
  const maintenance = buildHealthOverview(state, Date.parse("2026-08-13T05:01:00.000Z"));
  assert.equal(maintenance.domains.find((item) => item.id === "maintenance").status, "故障");
  assert.equal(maintenance.current[0].system_action, "已安全重启网站");
  assert.equal(maintenance.current[0].owner_required, false);
  assert.equal(maintenance.current[0].history_impact, "SQLite 未改变");
});

test("owner timestamps name the business timezone without browser-specific GMT text", () => {
  assert.equal(formatPtDateTime("2026-08-13T19:50:00.000Z"), "2026/08/13 12:50:00 加州时间");
  assert.equal(formatEtDateTime("2026-08-13T19:50:00.000Z"), "2026/08/13 15:50:00 美东时间");
});

test("derives only contract-backed TS overlays and session VWAP", async () => {
  const raw = await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8");
  const ts = parseSnapshot(raw).contracts.TS_OUTPUT[0];
  const bars = [
    { begins_at: "2026-08-11T13:30:00.000Z", open: 99, high: 101, low: 99, close: 100, volume: 100 },
    { begins_at: "2026-08-11T13:35:00.000Z", open: 100, high: 103, low: 101, close: 102, volume: 300 },
  ];
  assert.equal(sessionVwapSeries(bars).at(-1).value, 101.5);
  const overlay = tsChartOverlay(ts, "SPY");
  assert.equal(overlay.levels.find((item) => item.kind === "support"), undefined);
  assert.equal(overlay.levels.find((item) => item.kind === "resistance"), undefined);
  assert.equal(overlay.levels.find((item) => item.kind === "invalidation").value, 102);
  assert.equal(overlay.levels.find((item) => item.kind === "target").value, 100);
  assert.deepEqual(overlay.paths.map((item) => item.name), ["main", "extreme"]);
  const anchored = tsChartOverlay(ts, "SPY", { time: Date.parse(ts.forecast_window.start_at) / 1_000, value: 99.5 });
  assert.deepEqual(anchored.paths.map((item) => item.name), ["main", "reverse", "extreme"]);
  assert.equal(anchored.paths[0].points[0].time, Date.parse(ts.forecast_window.start_at) / 1_000);
  assert.equal(anchored.paths[0].points[0].value, 99.5);
  assert.deepEqual(anchored.paths[0].nodes.map((item) => item.label), ["条件节点1", "条件节点2"]);
  assert.equal(formatEtDateTime(anchored.paths[0].nodes.at(-1).time * 1_000), "2026/07/29 10:30:18 美东时间");
  assert.deepEqual(anchored.paths[0].lower, []);
  assert.deepEqual(anchored.paths[0].upper, []);
  assert.deepEqual(anchored.paths[1].lower, []);
  assert.deepEqual(anchored.paths[1].upper, []);
  assert.deepEqual(anchored.paths[2].lower, []);
  assert.deepEqual(anchored.paths[2].upper, []);
  const fan = forecastFanGeometry(anchored.paths);
  assert.equal(fan.sharedUpper[0].value, 99.5);
  assert.equal(fan.sharedLower[0].value, 99.5);
  const sharedSplit = (name) => fan.displayPaths[name][0];
  assert.deepEqual(sharedSplit("main"), sharedSplit("reverse"));
  assert.deepEqual(sharedSplit("main"), sharedSplit("extreme"));
  assert.deepEqual(fan.trunk, [fan.anchor, sharedSplit("main")]);
  for (const path of anchored.paths) assert.equal(fan.displayPaths[path.name].at(-1).value, path.points.at(-1).value);
  const realPrices = anchored.paths.flatMap((path) => [...path.points, ...path.upper, ...path.lower].map((point) => point.value));
  assert.deepEqual(fan.priceExtent, { low: Math.min(...realPrices), high: Math.max(...realPrices) });
  const late = structuredClone(ts);
  late.forecast_window.start_at = "2026-07-29T15:00:00-04:00";
  late.forecast_window.end_at = "2026-07-29T16:00:00-04:00";
  assert.deepEqual(tsChartOverlay(late, "SPY", { time: Date.parse(late.forecast_window.start_at) / 1_000, value: 99.5 }).paths[0].nodes.map((item) => item.label), ["条件节点1", "条件节点2"]);
  const nextSession = structuredClone(ts);
  nextSession.evidence_snapshot.market_time.market_date = "2026-07-28";
  nextSession.forecast_window = { ...nextSession.forecast_window, start_at: "2026-07-29T09:30:00-04:00", end_at: "2026-07-29T16:00:00-04:00" };
  assert.equal(tsChartOverlay(nextSession, "SPY", { time: Date.parse(nextSession.forecast_window.start_at) / 1_000, value: 99.5 }).paths.length, 3);
});

test("organizes immutable TS slots into current, prior and next-session owner state", async () => {
  const raw = await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8");
  const base = parseSnapshot(raw).contracts.TS_OUTPUT[0];
  const prior = structuredClone(base);
  const current = structuredClone(base);
  current.report_type = "INTRADAY_30_60M";
  current.evidence_snapshot.market_time.observed_at = "2026-07-29T07:00:00-07:00";
  current.forecast_update = { mode: "CHECK", prior_run_id: prior.evidence_snapshot.run_id, prior_forecast_hash: prior.evidence_snapshot.packet_hash, prior_status: "PARTIAL", change_summary: "主路径概率提高，方向保持震荡。" };
  current.scenarios.main.probability_pct = 55;
  current.scenarios.reverse.probability_pct = 25;
  const tomorrow = structuredClone(base);
  tomorrow.report_type = "NEXT_SESSION";
  tomorrow.evidence_snapshot.market_time.observed_at = "2026-07-29T18:00:00-07:00";
  tomorrow.symbol_outlooks.SPY.direction = "BEARISH";
  const state = buildTsForecastState([tomorrow, current, prior], "SPY");
  assert.equal(state.today.report_type, "INTRADAY_30_60M");
  assert.equal(state.previous.report_type, "OPENING_FORECAST");
  assert.equal(state.direction, "震荡");
  assert.equal(state.main.probability_pct, 55);
  assert.equal(state.bullish.name, "reverse");
  assert.equal(state.bearish.name, "extreme");
  assert.deepEqual(state.changes, ["main +5 个百分点", "reverse -5 个百分点"]);
  assert.equal(state.tomorrowDirection, "偏跌");
  assert.ok(state.tomorrowActivation.length > 0);
  assert.ok(state.tomorrowActivation.some((item) => item.includes("当前价")));
  assert.equal(buildTsForecastState([], "QQQ").direction, "NOT_OBSERVED");
});

test("resolves one stable forecast identity across RTH, GTH, history and missing deep links", async () => {
  const raw = await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8");
  const base = parseSnapshot(raw).contracts.TS_OUTPUT[0];
  const current = structuredClone(base), next = structuredClone(base), historical = structuredClone(base);
  current.report_type = "INTRADAY_30_60M"; current.evidence_snapshot.run_id = "current-20260818"; current.evidence_snapshot.market_time.market_date = "2026-08-18";
  next.report_type = "NEXT_SESSION"; next.evidence_snapshot.run_id = "next-20260818"; next.evidence_snapshot.market_time.market_date = "2026-08-17";
  historical.report_type = "INTRADAY_30_60M"; historical.evidence_snapshot.run_id = "historical-20260817"; historical.evidence_snapshot.market_time.market_date = "2026-08-17";
  const outputs = [historical, current, next];
  assert.deepEqual([resolveTsForecastContext(outputs, null, "2026-08-18T01:00:00.000Z").mode, resolveTsForecastContext(outputs, null, "2026-08-18T01:00:00.000Z").selected.evidence_snapshot.run_id], ["NEXT_SESSION", "next-20260818"]);
  assert.deepEqual([resolveTsForecastContext(outputs, null, "2026-08-18T14:00:00.000Z").mode, resolveTsForecastContext(outputs, null, "2026-08-18T14:00:00.000Z").selected.evidence_snapshot.run_id], ["CURRENT_LIVE", "current-20260818"]);
  assert.equal(resolveTsForecastContext(outputs, "historical-20260817", "2026-08-18T14:00:00.000Z").mode, "HISTORICAL");
  const missing = resolveTsForecastContext(outputs, "missing", "2026-08-18T14:00:00.000Z");
  assert.deepEqual([missing.mode, missing.selected], ["MISSING", null]);
  assert.match(missing.consistencyError, /未改开其他预测/);
});

test("validates the sanitized V2 snapshot contract", async () => {
  const raw = await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8");
  const parsed = parseSnapshot(raw);
  assert.equal(parsed.contracts.TS_OUTPUT.length, 1);
  assert.equal(parsed.contracts.TS_OUTPUT[0].scenarios.main.probability_pct, 50);
  assert.equal(parsed.contracts.A2_HALF_HOUR_FORECAST.status, "INACTIVE");
  assert.equal(parsed.contracts.ACCEPTANCE, null);

  const wrongVersion = JSON.stringify({ ...parsed, snapshot_version: 2 });
  assert.throws(() => parseSnapshot(wrongVersion), /只支持版本 1/);
  assert.throws(() => parseSnapshot("{"), /有效 JSON/);
});

test("accepts only contract-backed local output types and fixed channels", async () => {
  const raw = await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8");
  const sample = parseSnapshot(raw);
  const marketSnapshotHash = "b".repeat(64);
  const marketSnapshotId = `market-${marketSnapshotHash.slice(0, 24)}`;
  const shadowComponent = (component) => ({ contract_version: "v1", component, mode: "SHADOW", actionable: false, source_mode: "REPLAY", status: "HEALTHY", observed_at: "2026-08-11T12:00:00.000Z", data_cutoff_at: "2026-08-11T12:00:00.000Z", freshness_seconds: 0, result_hash: "a".repeat(64), evidence_ref: `data/live-shadow/${component}.json`, market_snapshot_id: marketSnapshotId, market_snapshot_hash: marketSnapshotHash, data_gaps: [], v2_result: {} });
  const environmentQuote = (symbol, role) => ({ symbol, role, instrument: "ETF_PROXY", source: "ROBINHOOD", status: "LIVE", as_of: "2026-08-11T12:00:00.000Z", freshness_seconds: 0, last: 100, previous_close: 99, change_pct: 1.01 });
  const rates = ["TLT", "SHY"].map((symbol) => environmentQuote(symbol, "RATES_PROXY")), oil = [environmentQuote("USO", "OIL_PROXY")], sectors = ["XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY"].map((symbol) => environmentQuote(symbol, "SECTOR"));
  const marketSources = {
    contract_name: "TRADING_OS_MARKET_DATA", contract_version: "v1", mode: "SHADOW", snapshot_id: marketSnapshotId, snapshot_hash: marketSnapshotHash, status: "LIVE", generated_at: "2026-08-11T12:00:00.000Z", as_of: "2026-08-11T12:00:00.000Z", freshness_seconds: 0,
    market_session: { state: "REGULAR", timezone: "America/New_York", observed_at: "2026-08-11T12:00:00.000Z", market_date: "2026-08-11", source: "DERIVED_US_EQUITY_HOURS" },
    market_environment: { contract_version: "v1", component: "MARKET_ENVIRONMENT", mode: "SHADOW", status: "LIVE", as_of: "2026-08-11T12:00:00.000Z", futures: { status: "NOT_SUPPORTED", source: null, as_of: null, error: "official tool unavailable" }, rates: { status: "LIVE", interpretation: "ETF_PROXY_NOT_YIELD", instruments: rates }, oil: { status: "LIVE", interpretation: "ETF_PROXY_NOT_SPOT_OR_FUTURES", instruments: oil }, sector_breadth: { status: "LIVE", interpretation: "SECTOR_ETF_ADVANCE_DECLINE", advancing: 11, declining: 0, unchanged: 0, advance_pct: 100, instruments: sectors }, extended_hours: { status: "OBSERVED", source: "ROBINHOOD_OFFICIAL_TRADING_MCP", as_of: "2026-08-11T11:55:00.000Z", data_grade: "OFFICIAL_READONLY_EXTENDED_HOURS", error: null, instruments: ["SPY", "QQQ"].map((symbol) => ({ symbol, session: "PREMARKET", status: "OBSERVED", as_of: "2026-08-11T11:55:00.000Z", price: 500, previous_close: 499, change_pct: 0.2 })) }, capabilities: { futures: false, rates_proxy: true, oil_proxy: true, sector_breadth: true, extended_hours: true }, data_gaps: ["OVERNIGHT_FUTURES_NOT_SUPPORTED_BY_OFFICIAL_ROBINHOOD_MCP"] },
    capabilities: { quotes: true, intraday_bars: true, daily_bars: true, option_chain: true, option_bbo: true, option_iv: true, option_greeks: true }, errors: [],
    providers: [{ source: "TRADIER", status: "DISABLED_BACKUP", as_of: null, freshness_seconds: null, error: "disabled" }, { source: "ROBINHOOD", status: "LIVE", as_of: "2026-08-11T12:00:00.000Z", freshness_seconds: 0, error: null }],
    quotes: ["SPY", "QQQ"].map((symbol) => ({ source: "ROBINHOOD", symbol, status: "LIVE", as_of: "2026-08-11T12:00:00.000Z", freshness_seconds: 0, last: 500, bid: 499.99, ask: 500.01, previous_close: 499 })),
    bars: ["SPY", "QQQ"].map((symbol) => ({ source: "ROBINHOOD", symbol, interval: "5min", status: "LIVE", as_of: "2026-08-11T11:55:00.000Z", freshness_seconds: 300, bar_count: 1, daily_bar_count: 1, latest: { open: 499, high: 501, low: 498, close: 500, volume: 1000 }, values: [{ begins_at: "2026-08-11T11:55:00.000Z", open: 499, high: 501, low: 498, close: 500, volume: 1000 }], daily: [{ begins_at: "2026-08-10T00:00:00.000Z", open: 499, high: 501, low: 498, close: 500, volume: 1000 }] })),
    options: ["SPY", "QQQ"].map((symbol) => ({ source: "ROBINHOOD", symbol, status: "LIVE", as_of: "2026-08-11T12:00:00.000Z", freshness_seconds: 0, expiration_count: 2, expirations: ["2026-08-11", "2026-08-13"], nearest_expiration: "2026-08-11", contract_count: 1, bbo_count: 1, iv_count: 1, greeks_count: 1, contracts: [{ contract_id: `${symbol}-call`, option_type: "call", expiration: "2026-08-11", strike: 500, bid: 1, ask: 1.1, mark: 1.05, volume: 10, open_interest: 20, iv: 0.2, delta: 0.5, gamma: 0.02, theta: -0.1, vega: 0.08, as_of: "2026-08-11T12:00:00.000Z", history_bars: 10, history_as_of: "2026-08-11T11:30:00.000Z" }] })),
    account: { source: "ROBINHOOD", status: "LIVE", as_of: "2026-08-11T12:00:00.000Z", freshness_seconds: 0, account_count: 1, positions: [], orders: [], portfolio_value: 1000, option_value: 0, realized_pnl: 0 }, discrepancies: [],
  };
  const officialMacro = {
    contract_version: "v1", component: "OFFICIAL_MACRO_CONTEXT", mode: "SHADOW", status: "LIVE", collected_at: "2026-08-11T12:00:00.000Z", as_of: "2026-08-11T12:00:00.000Z", context_hash: "c".repeat(64),
    providers: { BLS: { schedule_status: "LIVE", results_status: "LIVE", as_of: "2026-08-11T12:00:00.000Z", error: null }, BEA: { schedule_status: "LIVE", results_status: "NOT_OBSERVED", as_of: "2026-08-11T12:00:00.000Z", error: null } },
    events: [{ event_id: "d".repeat(64), release_name: "Gross Domestic Product", scheduled_at: "2026-08-12T12:30:00.000Z", source_url: "https://apps.bea.gov/API/signup/release_dates.json", confidence: "official_schedule" }], results: [], policy_results: [], bls_macro_watch: {}, bls_official_news: {}, official_items: [], errors: [],
    supplemental_sources: [{ source: "U.S. TREASURY", role: "OFFICIAL_TREASURY_YIELDS", status: "LIVE", as_of: "2026-08-11T00:00:00.000Z", data_grade: "ISSUING_AGENCY_OFFICIAL_EOD", error: null }],
    observations: [{ series_id: "CPI_MOM_PCT", label: "CPI month-over-month", value: 0.2, previous_value: null, unit: "PERCENT", reference_period: "2026-07", retrieved_at: "2026-08-11T12:00:00.000Z", source_url: "https://api.bls.gov/publicAPI/v2/timeseries/data/", data_grade: "DERIVED_FROM_ISSUING_AGENCY_OFFICIAL" }],
    coverage: { inflation: "LIVE", employment: "LIVE", central_bank: "LIVE", growth: "LIVE", released_values: "LIVE" },
    market_context: { contract_version: "v1", component: "OFFICIAL_MARKET_CONTEXT", mode: "SHADOW", status: "LIVE", collected_at: "2026-08-11T12:00:00.000Z", context_hash: "e".repeat(64), treasury_yields: { status: "EOD", source: "U.S. TREASURY", as_of: "2026-08-11T00:00:00.000Z", data_grade: "ISSUING_AGENCY_OFFICIAL_EOD", observations: [{ metric: "TREASURY_10Y", value: 4.68, unit: "PERCENT", as_of: "2026-08-11T00:00:00.000Z", retrieved_at: "2026-08-11T12:00:00.000Z", source_url: "https://home.treasury.gov/", data_grade: "ISSUING_AGENCY_OFFICIAL_EOD" }], error: null }, wti: { status: "EOD", source: "EIA", as_of: "2026-08-11T00:00:00.000Z", data_grade: "ISSUING_AGENCY_OFFICIAL_EOD", observations: [{ metric: "WTI_CUSHING_SPOT", value: 84.77, unit: "USD_PER_BARREL", as_of: "2026-08-11T00:00:00.000Z", retrieved_at: "2026-08-11T12:00:00.000Z", source_url: "https://www.eia.gov/", data_grade: "ISSUING_AGENCY_OFFICIAL_EOD" }], error: null } },
  };
  const fixtures = [
    ["TS_OUTPUT", "PRODUCTION", sample.contracts.TS_OUTPUT[0]],
    ["A1_SHADOW_RESULT", "SHADOW", { ...shadowComponent("A1"), market_sources: marketSources, official_macro: officialMacro }],
    ["A2_SHADOW_RESULT", "SHADOW", { ...shadowComponent("A2"), pattern_evidence: { source_mode: "LIVE", data_grade: "NATURAL_LIVE_SLOT", status: "HEALTHY", as_of: "2026-08-11T12:00:00.000Z", symbols: Object.fromEntries(["SPY", "QQQ"].map((symbol) => [symbol, { current_state: "TREND_UP", candidate_state: "UNKNOWN", candidate_bars: 0, state_since: "2026-08-11T11:00:00.000Z", data_time: "2026-08-11T11:55:00.000Z" }])) } }],
    ["TS_SHADOW_OUTPUT", "SHADOW", sample.contracts.TS_OUTPUT[0]],
    ["CODEX_GUARD_SHADOW", "SHADOW", { contract_version: "v1", role: "CODEX_GUARD", status: "HEALTHY", faults: [], restart_recommended: false, owner_message: "" }],
    ["A2_HALF_HOUR_FORECAST", "SHADOW", sample.contracts.A2_HALF_HOUR_FORECAST],
    ["COMMITTEE_OUTPUT", "PRODUCTION", { contract_version: "v1", role: "COMMITTEE", flow_state: "unknown", direction: "unknown", confidence: 0, summary: "", evidence_for: [], evidence_against: [], reversal_signals: [], data_gaps: [] }],
    ["D_OUTPUT", "PRODUCTION", { contract_version: "v1", role: "D", action: "NO_TRADE", score: 0, underlying: "NONE", option_side: "none", expiration: "", strike: 0, quantity: 0, max_entry_debit: 0, stop_loss_pct: 0, take_profit_pct: 0, summary: "", entry_conditions: [], invalidation: [], data_gaps: [] }],
    ["A3_REVIEW", "PRODUCTION", { contract_version: "v1", role: "A3_REVIEW", conflict_detected: false, review_required: false, review_target: "NONE", review_question: "", provisional_decision: "NO_TRADE", reason: "" }],
    ["A3_FINAL", "PRODUCTION", { contract_version: "v1", role: "A3", decision: "NO_TRADE", score: 0, underlying: "NONE", option_side: "none", expiration: "", strike: 0, quantity: 0, max_entry_debit: 0, stop_loss_pct: 0, take_profit_pct: 0, plain_language: "", supporting_evidence: [], conflicts_resolved: [], invalidation: [], data_status: "BLOCKED" }],
    ["CODEX_GUARD", "SYSTEM", { contract_version: "v1", role: "CODEX_GUARD", status: "HEALTHY", faults: [], restart_recommended: false, owner_message: "" }],
    ["DELIVERY_RECONCILIATION", "SYSTEM", { contract_version: "v1", status: "COMPLETED", reconciled_position_event_ids: [], suppressed_stale_position_event_ids: [], failures: [] }],
  ];
  for (const [index, [output_type, channel, payload]] of fixtures.entries()) {
    const observed_at = output_type === "TS_OUTPUT" || output_type === "TS_SHADOW_OUTPUT" ? payload.evidence_snapshot.market_time.observed_at : "2026-08-11T12:00:00.000Z";
    const parsed = parseOutputEnvelope(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: `contract-${index}`, output_type, channel, observed_at, payload }));
    assert.equal(parsed.output_type, output_type);
    assert.equal(parsed.channel, channel);
  }
  assert.throws(() => parseOutputEnvelope(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "bad-shadow", output_type: "A2_HALF_HOUR_FORECAST", channel: "PRODUCTION", observed_at: "2026-08-11T12:00:00.000Z", payload: sample.contracts.A2_HALF_HOUR_FORECAST })), /必须写入 SHADOW/);
  assert.throws(() => parseOutputEnvelope(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "bad-source", output_type: "A1_SHADOW_RESULT", channel: "SHADOW", observed_at: "2026-08-11T12:00:00.000Z", payload: { ...shadowComponent("A1"), market_sources: { ...marketSources, providers: [{ ...marketSources.providers[0], source: "UNKNOWN" }] } } })), /只支持 TRADIER \/ ROBINHOOD/);
  assert.throws(() => parseOutputEnvelope(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "bad-environment", output_type: "A1_SHADOW_RESULT", channel: "SHADOW", observed_at: "2026-08-11T12:00:00.000Z", payload: { ...shadowComponent("A1"), market_sources: { ...marketSources, market_environment: { ...marketSources.market_environment, rates: { ...marketSources.market_environment.rates, instruments: [environmentQuote("SPY", "RATES_PROXY"), environmentQuote("SHY", "RATES_PROXY")] } } } } })), /环境标的必须符合固定只读合同/);
  assert.throws(() => parseOutputEnvelope(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "bad-macro", output_type: "A1_SHADOW_RESULT", channel: "SHADOW", observed_at: "2026-08-11T12:00:00.000Z", payload: { ...shadowComponent("A1"), official_macro: { ...officialMacro, status: "HEALTHY" } } })), /只支持 LIVE \/ DEGRADED \/ DATA_BLOCKED/);
});
