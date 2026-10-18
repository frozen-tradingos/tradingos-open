import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transpileModule, JsxEmit, ModuleKind, ScriptTarget } from "typescript";
import * as jsx from "react/jsx-runtime";
import * as react from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as marketTime from "../app/market-time.ts";
import * as paperPlan from "../app/paper-plan.ts";

test("company evidence renders archived dates, figures, limitations and errors without claiming growth or changing inputs", async () => {
  const component = {}, source = await readFile(new URL("../app/CompanyEvidence.tsx", import.meta.url), "utf8");
  let states = [], requests = 0;
  const hooks = { ...react, useState: () => [states.shift(), () => {}], useRef: () => ({ current: false }) };
  new Function("exports", "require", "fetch", transpileModule(source, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText)(component, (name) => {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react") return hooks;
    if (name === "./market-time") return marketTime;
    throw Error(`Unexpected company dependency: ${name}`);
  }, () => { requests++; throw Error("rendering must not fetch company evidence"); });
  const render = (result, error = null, loading = false) => {
    states = [result, error, loading];
    return renderToStaticMarkup(jsx.jsx(component.CompanyEvidence, { symbol: "NVDA" }));
  };
  const sourceUrl = "https://example.test/nvidia-fixture";
  const result = {
    report: { symbol: "NVDA", checked_at: "2026-09-29T19:10:00Z",
      news: [{ evidence_ref: "news:1", title: "NVIDIA fixture <script>alert(1)</script>", source: "Fixture Wire", url: sourceUrl, published_at: "2026-09-29T18:00:00Z", received_at: "2026-09-29T18:02:00Z" },
        { evidence_ref: "news:2", title: "NVIDIA untrusted URL", source: "Fixture", url: "javascript:alert(1)", published_at: "2026-09-29T18:00:00Z", received_at: "2026-09-29T18:02:00Z" },
        { evidence_ref: "news:3", title: "NVIDIA credential URL", source: "Fixture", url: "https://user:secret@example.test/story", published_at: "2026-09-29T18:00:00Z", received_at: "2026-09-29T18:02:00Z" }],
      earnings: [{ evidence_ref: "earnings:1", date: "2026-09-28", reported: true, session: "AMC", eps_actual: 1.25, eps_estimate: 1.2, revenue_actual: 1250000.5, revenue_estimate: 1200000, fetched_at: "2026-09-29T17:00:00Z" },
        { evidence_ref: "earnings:2", date: "2026-10-28", reported: false, session: "UNKNOWN", eps_actual: null, eps_estimate: null, revenue_actual: null, revenue_estimate: null, fetched_at: "2026-09-29T17:00:00Z" }],
      limitations: ["缺少债务口径，不估算", "不同财期不直接比较"] },
    events: [{ id: "event-1", title: "Fixture event", url: "/research/event-disclosure", time: "2026-10-01" }],
  };
  const original = structuredClone(result), html = render(result);
  for (const text of ["系统已有归档", "这是本次复查资料，不代表建单时已知", "1,250,000.5", "2026-09-28 · 已归档财报结果", "2026-10-28 · 计划财报", "实际 1.25 / 预期 1.2", "实际 未披露 / 预期 未披露", "时段未核实", "币种及财期未独立核实", "归档接收", "Fixture Wire", "缺少债务口径，不估算", "标题提及，影响未核实", marketTime.formatPtDateTime(result.report.news[0].published_at), marketTime.formatPtDateTime(result.report.news[0].received_at)]) assert.ok(html.includes(text), text);
  assert.ok(html.includes(`href="${sourceUrl}"`));
  assert.match(html, /href="\/research\/event-disclosure"/);
  assert.doesNotMatch(html, /href="(?:javascript:|https:\/\/user:)|<script>|同比增长|环比增长|基本面完好/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.deepEqual(result, original);
  const missing = render({ ...result, report: { ...result.report, news: [], earnings: [] }, events: [] });
  for (const text of ["不等于没有消息", "不能据此认定没有财报或活动", "尚无已登记的公司事件观察"]) assert.ok(missing.includes(text), text);
  assert.match(render(null, "本次读取超时，现有单子继续按原规则运行。"), /role="alert"[^>]*>本次读取超时/);
  assert.match(render(null, null, true), /disabled=""[^>]*>正在整理已有资料/);
  assert.equal(requests, 0, "initial, result and error rendering never collects data or changes a plan");
});

test("paper UI labels reference prices, gaps and expiry without claiming approval or a fill", async () => {
  const source = await readFile(new URL("../app/PaperPlans.tsx", import.meta.url), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  const detailSource = await readFile(new URL("../app/DetailSheet.tsx", import.meta.url), "utf8");
  const detail = {};
  new Function("exports", "require", transpileModule(detailSource, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText)(detail, (name) => {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react") return react;
    throw Error(`Unexpected detail dependency: ${name}`);
  });
  const component = {};
  const company = {};
  new Function("exports", "require", transpileModule(await readFile(new URL("../app/CompanyEvidence.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText)(company, (name) => {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react") return react;
    if (name === "./market-time") return marketTime;
    throw Error(`Unexpected company dependency: ${name}`);
  });
  new Function("exports", "require", compiled)(component, (name) => {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "./market-time") return marketTime;
    if (name === "./paper-plan") return paperPlan;
    if (name === "./DetailSheet") return detail;
    if (name === "./CompanyEvidence") return company;
    throw Error(`Unexpected dependency: ${name}`);
  });
  const stamp = "2026-09-14T13:45:00.000Z";
  const plan = { plan_id: "paper-plan:2026-09-14", market_date: "2026-09-14", created_at: stamp, expires_at: "2026-09-18T20:00:00.000Z", symbol: "NVDA", direction: "BULLISH", contract: { expiration: "2026-09-18", strike: 110.5, option_type: "call", contract_id: "exact-original-contract", multiplier: 100 }, reference: { ask: 30.7, bid: 29.7, quantity: 1, quoted_at: "2026-09-14T13:44:45.000Z" }, why_watch: ["原始判断"], levels: { entry: 111, invalidation: null, target: 115 }, warnings: ["未获批准"], source: { observed_at: stamp, evidence_id: "original-evidence" }, stop_loss_pct: -40, take_profit_pct: 30 };
  const row = { plan, status: "DATA_GAP", estimated_return_pct: -100, highest_observed_return_pct: 40, lowest_observed_return_pct: -100, stop_observed: true, take_profit_observed: true, last_checked_at: stamp, latest_quote: { bid: 0, ask: 0.1, quoted_at: stamp }, reasons: ["本次报价缺失"] };
  const original = structuredClone(row);
  const render = (rows, compact = false, currentTime = Date.parse(stamp), learning, todayOnly = false, specialDays) => renderToStaticMarkup(jsx.jsx(component.PaperPlans, { overview: rows === undefined ? undefined : { plans: rows, learning }, currentTime, compact, todayOnly, specialDays }));
  const card = (html) => html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/)[1];
  const visible = (html) => card(html).split("<dialog", 1)[0];
  const printedTime = (stamp) => marketTime.formatPtDateTime(stamp).replace(/^\d{4}\//, "").replace(" 加州时间", " PT");
  const html = render([row]);
  const confirmation = { version: "PAPER_ENTRY_CONDITIONS_V1", assessed_at: stamp, status: "CONFIRMED", levels: { entry: 111, invalidation: 108, target: 115 }, checks: [{ condition: "TRIGGER", status: "PASS", detail: "已完成K线确认", evidence_at: stamp }] };
  const checked = { ...row, status: "OBSERVING", plan: { ...plan, entry_confirmation: { ...confirmation, status: "NOT_CONFIRMED" } }, latest_entry_confirmation: confirmation };
  const checkedOriginal = structuredClone(checked), checkedHtml = render([checked]);
  assert.match(visible(checkedHtml), /入场条件已满足/);
  assert.doesNotMatch(visible(checkedHtml), /入场条件逐项核验|已完成K线确认/);
  assert.match(card(checkedHtml), /建单时：入场条件未满足/);
  assert.match(card(checkedHtml), /模拟建单与入场确认分开，原止盈止损继续生效/);
  assert.match(visible(render([checked], false, Date.parse(stamp) + 121_000)), /需新行情复核/);
  assert.doesNotMatch(visible(render([checked], false, Date.parse(stamp) + 121_000)), /入场条件已满足/);
  assert.deepEqual(checked, checkedOriginal);
  const oldQuote = { ...checked, latest_entry_confirmation: { ...confirmation, checks: [{ condition: "QUOTE", status: "PASS", detail: "采样时尚新鲜", evidence_at: new Date(Date.parse(stamp) - 119_000).toISOString() }] } };
  assert.match(visible(render([oldQuote], false, Date.parse(stamp) + 2000)), /需新行情复核/);
  const conflicting = { ...checked, latest_formal_forecast_review: { status: "CONFLICT", context_status: "AVAILABLE", assessed_at: stamp, source: { forecast_window: { start_at: stamp, end_at: "2026-09-14T14:45:00Z" }, next_validation_at: "2026-09-14T14:00:00Z", delivered_at: stamp } } };
  assert.match(visible(render([conflicting])), /短线方向与计划相反/);
  assert.match(card(render([conflicting])), /未记录正式预测对照，不回填为当时已知/);
  assert.doesNotMatch(visible(render([conflicting], false, Date.parse("2026-09-14T14:00:00Z"))), /短线方向与计划相反/);
  assert.match(card(render([conflicting], false, Date.parse("2026-09-14T14:00:00Z"))), /该对照已过期/);
  const bridgeStamp = "2026-10-13T14:00:00Z", bridgeNow = Date.parse(bridgeStamp);
  const nextSession = { assessed_at: bridgeStamp, scope: "NEXT_SESSION_BACKGROUND", status: "CONFLICT", context_status: "AVAILABLE", forecast_direction: "BEARISH", summary: "次日先测试昨日低点；反向上涨需共同确认", evidence_ref: "formal-ts:next-session-fixture:SPY",
    source: { forecast_id: "next-session-fixture", source_record_id: "live-shadow:20261013T010000Z:TS", forecast_hash: "a".repeat(64), observed_at: "2026-10-13T01:00:15Z", received_at: "2026-10-13T01:01:51Z", delivered_at: "2026-10-13T01:01:51Z", forecast_window: { horizon: "NEXT_REGULAR_SESSION", start_at: "2026-10-13T01:00:15Z", end_at: null, end_condition: "NEXT_REGULAR_SESSION_CLOSE" }, next_validation_at: "2026-10-13T13:30:00Z" } };
  const shortReview = { ...nextSession, scope: undefined, status: "ALIGNED", forecast_direction: "BULLISH", summary: "短线修复，需SPY共同突破确认", evidence_ref: "formal-ts:opening-fixture:SPY", source: { ...nextSession.source, forecast_id: "opening-fixture", observed_at: "2026-10-13T13:45:00Z", received_at: "2026-10-13T13:47:00Z", delivered_at: "2026-10-13T13:47:00Z", forecast_window: { horizon: "NEXT_30_TO_60_MINUTES", start_at: "2026-10-13T13:45:00Z", end_at: "2026-10-13T14:45:00Z", end_condition: "AT_TIMESTAMP" }, next_validation_at: "2026-10-13T14:30:00Z" } };
  const unconfirmed = { ...confirmation, assessed_at: bridgeStamp, status: "NOT_CONFIRMED", checks: [{ condition: "TRIGGER", status: "FAIL", detail: "SPY尚未达到冻结触发价", evidence_at: bridgeStamp }] };
  const bridge = { ...row, status: "OBSERVING", plan: { ...plan, symbol: "SPY", market_date: "2026-10-13", created_at: bridgeStamp, expires_at: "2026-10-16T20:00:00Z", contract: { ...plan.contract, strike: 780, expiration: "2026-10-16" }, source: { ...plan.source, observed_at: bridgeStamp }, reference: { ...plan.reference, quoted_at: bridgeStamp }, holding_intent: { min_trading_days: 1, max_trading_days: 3, time_exit: "REVIEW_ONLY" }, research_cohort: "INDEX_CONDITIONS_V1", selection_source: { kind: "RULE_FALLBACK", completed_at: bridgeStamp, reason: "Codex容量不足；沿用冻结多周期偏多研究依据" }, why_watch: ["原1–3天多周期偏多判断"], next_session_forecast_review: nextSession, formal_forecast_review: shortReview, entry_confirmation: unconfirmed }, latest_quote: { bid: 34, ask: 34.1, quoted_at: bridgeStamp }, latest_entry_confirmation: unconfirmed, last_checked_at: bridgeStamp };
  const bridgeSaved = structuredClone(bridge);
  for (const [compact, todayOnly] of [[false, false], [true, false], [false, true]]) {
    const bridgeHtml = render([bridge], compact, bridgeNow, undefined, todayOnly), bridgeVisible = visible(bridgeHtml);
    assert.match(bridgeVisible, /aria-label="模拟单观察状态"[^>]*>建单前晚偏空 · 原方向 Call · <b>仅模拟观察 · 入场条件未满足/);
    assert.match(bridgeVisible, /\+10.7%/);
    assert.doesNotMatch(bridgeVisible, /入场条件已满足|前晚方向与原单相反|Codex容量不足/, "floating gains do not promote an unconfirmed fallback; reasons stay in details");
    assert.match(bridgeHtml, /建单时前晚背景[\s\S]*前晚方向与原单相反[\s\S]*原预测 偏空/);
    assert.match(bridgeHtml, /建单时短线对照[\s\S]*短线方向与计划一致[\s\S]*原预测 偏多/);
    for (const phrase of ["Codex容量不足", "原1–3天多周期偏多判断", "原模拟计划看1–3个交易日", "不同期限可能方向相反", "新行情确认尚未完成时继续观察", "外部专家仅参考，不是标准答案", "下一常规交易日收盘", "触发价 · 未通过", "SPY尚未达到冻结触发价"]) assert.ok(bridgeHtml.includes(phrase), phrase);
    assert.doesNotMatch(bridgeVisible, /买入许可|建议买入|可以开Call/);
  }
  assert.deepEqual(bridge, bridgeSaved, "forecast comparison cannot change original direction, costs or selection evidence");
  for (const [status, label] of [["INVALIDATED", "原条件已失效"], ["CONFLICT", "方向证据冲突"], ["DATA_GAP", "入场证据不全"]]) {
    const sample = { ...bridge, latest_entry_confirmation: { ...unconfirmed, status } };
    assert.match(visible(render([sample], false, bridgeNow)), new RegExp(`仅观察 · ${label}`));
    assert.doesNotMatch(visible(render([sample], false, bridgeNow)), /入场条件已满足/);
  }
  const staleBridge = { ...bridge, latest_entry_confirmation: { ...unconfirmed, status: "CONFIRMED" } };
  assert.match(visible(render([staleBridge], false, bridgeNow + 121_000)), /仅观察 · 需新行情复核/);
  assert.doesNotMatch(visible(render([staleBridge], false, bridgeNow + 121_000)), /入场条件已满足/);
  const gapBridge = { ...staleBridge, status: "DATA_GAP" };
  assert.match(visible(render([gapBridge], false, bridgeNow)), /仅观察 · 入场证据不全/);
  assert.doesNotMatch(visible(render([gapBridge], false, bridgeNow)), /入场条件已满足/);
  const conflictBridge = { ...staleBridge, latest_formal_forecast_review: { ...shortReview, status: "CONFLICT", forecast_direction: "BEARISH" } };
  assert.match(visible(render([conflictBridge], false, bridgeNow)), /仅观察 · 短线方向与计划相反/);
  assert.doesNotMatch(visible(render([conflictBridge], false, bridgeNow)), /入场条件已满足/);
  const laterStamp = "2026-10-13T14:01:00Z";
  const oldBridge = { ...bridge, plan: { ...bridge.plan, next_session_forecast_review: undefined, formal_forecast_review: undefined }, latest_next_session_forecast_review: { ...nextSession, assessed_at: laterStamp }, latest_formal_forecast_review: { ...shortReview, assessed_at: laterStamp } };
  const oldBridgeSaved = structuredClone(oldBridge), laterHtml = render([oldBridge], false, Date.parse(laterStamp));
  assert.match(visible(laterHtml), /后续复查背景偏空 · 原方向 Call/);
  assert.doesNotMatch(visible(laterHtml), /建单前晚偏空/, "MARK background is explicitly a later review");
  assert.match(laterHtml, /建单时前晚背景<\/dt><dd>建单时未保存前晚背景，不用后来的复查回填/);
  assert.match(laterHtml, /建单时短线对照<\/dt><dd>未记录正式预测对照，不回填为当时已知/);
  assert.match(laterHtml, /最新自然复查 · 前晚背景[\s\S]*前晚方向与原单相反/);
  assert.match(laterHtml, /最新自然复查 · 短线[\s\S]*短线方向与计划一致/);
  assert.ok(laterHtml.includes(printedTime(laterStamp)), "later MARK evidence exposes its own time");
  assert.deepEqual(oldBridge, oldBridgeSaved, "later observations never masquerade as frozen entry input");
  const rangeBridge = { ...oldBridge, latest_next_session_forecast_review: { ...oldBridge.latest_next_session_forecast_review, status: "RANGE", forecast_direction: "RANGE" } };
  assert.match(visible(render([rangeBridge], false, Date.parse(laterStamp))), /后续复查背景震荡/);
  for (const staleTime of ["2026-10-13T20:00:00Z", "2026-10-14T14:01:00Z"]) {
    const oldDayHtml = render([rangeBridge], false, Date.parse(staleTime));
    assert.doesNotMatch(visible(oldDayHtml), /后续复查背景震荡/);
    assert.match(oldDayHtml, /最新自然复查 · 前晚背景[\s\S]*前晚判断为震荡[\s\S]*该背景当前不可用（未到时段或已过期），仅保留复查记录/);
    assert.ok(oldDayHtml.includes(printedTime(laterStamp)));
  }
  for (const background of [{ ...oldBridge.latest_next_session_forecast_review, assessed_at: "2026-10-13T14:02:00Z" }, { ...oldBridge.latest_next_session_forecast_review, source: { ...nextSession.source, forecast_window: { ...nextSession.source.forecast_window, end_at: laterStamp } } }]) {
    assert.doesNotMatch(visible(render([{ ...oldBridge, latest_next_session_forecast_review: background }], false, Date.parse(laterStamp))), /后续复查背景偏空/, "future or ended review windows are not current card background");
  }
  assert.match(visible(render([bridge], false, Date.parse("2026-10-14T14:01:00Z"))), /建单前晚偏空/, "frozen entry background remains a labelled historical fact");
  const escaped = render([{ ...bridge, plan: { ...bridge.plan, next_session_forecast_review: { ...nextSession, summary: "<script>external()</script>" } } }], false, bridgeNow);
  assert.match(escaped, /&lt;script&gt;external\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(escaped, /<script>external/);
  assert.match(card(html), /查看公司消息与财报/);
  assert.doesNotMatch(visible(html), /查看公司消息与财报/, "company research stays inside existing details");
  const selected = { ...row, plan: { ...plan, selection_source: { kind: "CODEX", completed_at: stamp, reason: "当日相对强势" } } };
  const fallback = { ...row, plan: { ...plan, selection_source: { kind: "RULE_FALLBACK", completed_at: stamp, reason: "选股超时，沿用原规则补位" } } };
  const qualified = { ...selected, plan: { ...selected.plan, levels: { entry: null, invalidation: null, target: null }, selection_source: { ...selected.plan.selection_source, version: "CODEX_PAPER_SELECTION_V2" } } };
  const originalReviewRows = structuredClone([row, selected, fallback, qualified]);
  for (const reviewRow of [row, selected, fallback, qualified]) {
    const reviewHtml = render([reviewRow]);
    assert.doesNotMatch(visible(reviewHtml), /跟单前复查|一张不能分批|冻结股票价位/, "keep the owner card compact");
    for (const phrase of ["选股依据 · 建单时记录", "原始判断", "通用复查提示，不是原单新增信号", "一张不能分批卖出留尾仓", "不能只为赚回上一笔亏损"]) assert.ok(card(reviewHtml).includes(phrase), phrase);
  }
  assert.deepEqual([row, selected, fallback, qualified], originalReviewRows, "review hints must not backfill original plans or levels");
  assert.match(card(render([qualified])), /Codex 选择精确合约，系统复核建单报价/);
  assert.match(card(render([qualified])), /原单未冻结可用价位/);
  assert.doesNotMatch(card(render([qualified])), /\$111\.00|\$115\.00|合约由系统按真实报价筛选/);
  for (const compact of [false, true]) {
    const pickedCard = visible(render([selected], compact));
    assert.match(pickedCard, /Codex 亲选股票与方向/);
    assert.match(card(render([selected], compact)), /合约由系统按真实报价筛选/);
    assert.ok(pickedCard.includes(printedTime(stamp)));
    const fallbackCard = visible(render([fallback], compact));
    assert.match(fallbackCard, /规则补位 · 非 Codex 亲选/);
    assert.match(card(render([fallback], compact)), /选股超时，沿用原规则补位/);
    assert.doesNotMatch(fallbackCard, /Codex 亲选股票与方向/);
  }
  assert.doesNotMatch(visible(html), /Codex 亲选股票与方向|规则补位/);
  const historyRow = { ...bridge, plan: { ...bridge.plan, market_date: "2026-09-09", owner_reselection: { requested_at: stamp } } };
  const historyOriginal = structuredClone(historyRow), historyHtml = render([historyRow]), historyCard = card(historyHtml);
  for (const text of ["按你的要求重新观察", "独立新记录，未替换旧单", "方向与价位由系统独立研究", "外部专家仅参考，不是标准答案", "原建单日期：2026-09-09"]) {
    assert.ok(historyCard.slice(historyCard.indexOf("<dialog")).includes(text), `${text} remains in the key-details drawer`);
    assert.ok(!visible(historyHtml).includes(text), `${text} does not add another default card paragraph`);
  }
  assert.doesNotMatch(historyCard, /<dialog[^>]*\bopen(?:=|\s|>)/);
  assert.match(visible(historyHtml), /class="paper-ticket-meta"[\s\S]*到期日[\s\S]*规则补位 · 非 Codex 亲选/);
  assert.deepEqual(historyRow, historyOriginal, "presentation changes never rewrite archived evidence");
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/, "research records must not expand themselves");
  assert.match(card(html), /aria-haspopup="dialog"[^>]*>关键详情[\s\S]*?<dialog[^>]*>[\s\S]*?<summary>原始记录<\/summary>[\s\S]*?exact-original-contract/);
  assert.doesNotMatch(html, /<dialog[^>]*\bopen(?:=|\s|>)/, "long details are closed until requested");
  assert.doesNotMatch(visible(html), /原始判断|exact-original-contract|RB 时间线涨跌|RB 止损限价卖单/);
  assert.match(html, /class="paper-plan-grid"/, "tickets share a responsive grid instead of an expanding prose column");
  for (const phrase of ["不是买入批准", "不会自动下单", "exact-original-contract", "原始判断", "最多8笔", "所有未结束旧单及最近10张原单", "距到期7–30天且报价有效", "跨日可以重新独立研究"]) assert.ok(html.includes(phrase), phrase);
  for (const field of ["NVDA · $110.5 Call", "到期日", "建单 Bid / Ask", "Bid $29.70", "Ask $30.70", "最新采样 Bid / Ask", "Bid $0.00", "Ask $0.10", "-100.0%", "最新 Bid 对建单 Ask", "固定规则结果", "本轮报价缺口", "显示上次有效采样", printedTime(stamp), printedTime(plan.reference.quoted_at)]) assert.ok(visible(html).includes(field), `${field} must be before the card's first details`);
  for (const compact of [false, true]) {
    const top = card(render([row], compact)).split('class="paper-ticket-note"', 1)[0];
    assert.match(top, /NVDA · \$110\.5 Call[\s\S]*?建单 Bid \/ Ask[\s\S]*?Ask \$30\.70[\s\S]*?最新采样 Bid \/ Ask[\s\S]*?Ask \$0\.10[\s\S]*?<p class="paper-ticket-expiration"><span>到期日<\/span><time dateTime="2026-09-18">2026-09-18<\/time><\/p>/, "name, quoted premiums and full expiration date precede secondary notes in every card");
    assert.equal((top.match(/<time /g) ?? []).length, 1, "expiration has one prominent location");
  }
  assert.match(card(html), /1张 · 参考成本 \$3070.00（Ask）/);
  assert.match(card(html), /\$111.00 \/ — \/ \$115.00/);
  assert.match(visible(html), /止盈参考价（\+30%）[\s\S]*?\$39.91/);
  assert.match(visible(html), /止损参考价（-40%）[\s\S]*?\$18.42/);
  assert.match(visible(html), /美元\/股期权/);
  for (const [ask, takeProfit, stopLoss] of [[14.15, "18.40", "8.49"], [0.15, "0.20", "0.09"], [7.9, "10.27", "4.74"]]) {
    const prices = visible(render([{ ...row, plan: { ...plan, reference: { ...plan.reference, ask } } }]));
    assert.ok(prices.includes(`$${takeProfit}`)); assert.ok(prices.includes(`$${stopLoss}`));
  }
  const home = (rows, time = Date.parse(stamp)) => render(rows, false, time, undefined, true);
  assert.match(visible(render([{ ...row, plan: { ...plan, reference: { ...plan.reference, ask: 0.15, bid: 0.09 } } }])), /建单价差已达到止损幅度/);
  assert.doesNotMatch(visible(html), /建单价差已达到止损幅度/);
  const yesterday = { ...row, plan: { ...plan, plan_id: "yesterday", market_date: "2026-09-11", symbol: "OLD" } };
  const homeHtml = home([yesterday, row]);
  assert.match(homeHtml, /今日 1\/3 张/);
  assert.match(homeHtml, /<details[^>]*\bopen=""/);
  assert.match(homeHtml, /NVDA ·/); assert.doesNotMatch(homeHtml, /OLD ·|旧单归档|本轮胜率/);
  assert.match(homeHtml, /RB 时间线涨跌/);
  assert.match(homeHtml, /href="\/settlements#research-paper"/);
  for (const pending of [render(undefined), render(undefined, true), home(undefined)]) {
    assert.match(pending, /模拟单记录尚未读取，数量和结果暂未知/);
    assert.equal((pending.match(/role="status"/g) ?? []).length, 1);
    assert.doesNotMatch(pending, /0\/3|今日数量尚未确认|规则结果：未确认|归档尚未读取|<article|<dialog/, "one unavailable state must not fabricate empty counts or scatter unknown results");
  }
  for (const [time, label] of [["2026-09-12T07:00:00Z", /今日休市 · 无建单任务/], ["2026-09-14T07:00:00Z", /今日 0\/3 张/]]) {
    const emptyDay = home([yesterday], Date.parse(time));
    assert.match(emptyDay, label); assert.doesNotMatch(emptyDay, /<article|最近交易日/);
    assert.doesNotMatch(emptyDay, /今日建单与最新采样|<details|<dialog/, "empty today groups do not display an empty disclosure");
    assert.match(emptyDay, /查看全部模拟单与历史跟踪记录/);
  }
  assert.match(home([yesterday], Date.parse("2026-09-12T06:59:59Z")), /OLD ·/, "today uses California midnight, not UTC midnight");
  assert.match(home([row], NaN), /今日数量尚未确认/);
  assert.doesNotMatch(home([row], NaN), /今日建单与最新采样|<details|<dialog/, "unknown dates do not create an empty today disclosure");
  const attempt = { market_date: plan.market_date, event_type: "ATTEMPT", recorded_at: stamp, payload: { reasons: ["QUOTE_GAP：等待真实报价"] } };
  const attemptOriginal = structuredClone(attempt);
  const emptyAttempt = renderToStaticMarkup(jsx.jsx(component.PaperPlans, { overview: { plans: [], latest_attempt: attempt }, currentTime: Date.parse(stamp), todayOnly: true }));
  assert.match(emptyAttempt, /今天还没有建立模拟单/);
  assert.match(emptyAttempt, /role="status">最近建单检查：等待真实报价/);
  assert.doesNotMatch(emptyAttempt, /今日建单与最新采样|<details|<dialog/);
  assert.deepEqual(attempt, attemptOriginal);
  const voided = { ...row, status: "VOIDED", owner_void: { ended_at: stamp, detail: "报价价差过大", owner_request_ref: "owner-message:quality" } };
  const voidedHome = home([voided]);
  for (const phrase of ["今日 0/3 张", "另有 1 张", "已作废 · 停止跟踪", "报价价差过大", "作废前最后采样", "尚无重新观察的新单", "不代表成交退出"]) assert.ok(voidedHome.includes(phrase),phrase);
  assert.match(voidedHome, /<details[^>]*\bopen=""[^>]*><summary>今日建单与最新采样/, "voided tickets remain visible because the record group is not empty");
  assert.doesNotMatch(card(voidedHome),/继续观察|今日继续跟踪，不改结算/);
  const missingCharts = card(render([{ ...row, chart: { entry: null, latest: null, checked_at: stamp, status: "UNAVAILABLE", entry_issue: "WAIT_ROTATION", latest_issue: "TIMEOUT" } }]));
  assert.match(missingCharts, /建单图点：等待轮次检查。最新图点：读取超时。/);
  assert.match(missingCharts, /待核对/);
  const entryLine = (reference, contract = plan.contract) => render([{ ...row, plan: { ...plan, contract, reference: { ...plan.reference, ...reference } } }]).match(/<dt>建单价差 \/ 即时价差损耗<\/dt><dd>(.*?)<\/dd>/)[1];
  assert.match(entryLine({}), /3.3% \/ \$100.00/);
  assert.match(entryLine({ bid: 5.5, ask: 7 }), /21.4% \/ \$150.00/);
  assert.match(entryLine({ bid: 0, ask: 7 }), /100.0% \/ \$700.00/);
  assert.match(entryLine({ bid: 7, ask: 7 }), /0.0% \/ \$0.00/);
  assert.match(entryLine({ bid: 1, ask: 1.1, quantity: 2 }, { ...plan.contract, multiplier: 50 }), /\$10.00/);
  for (const reference of [{ bid: undefined }, { bid: null }, { bid: NaN }, { bid: Infinity }, { bid: -1 }, { bid: 31 }, { ask: undefined }, { ask: null }, { ask: 0 }, { ask: Infinity }]) {
    const line = entryLine(reference);
    assert.equal(line, "未知");
    assert.doesNotMatch(line, /NaN|Infinity/);
  }
  const gapLater = render([{ ...row, last_checked_at: "2026-09-14T14:45:00.000Z" }], false, Date.parse(stamp) + 3_600_000);
  assert.ok(visible(gapLater).includes(printedTime(stamp)), "a later GAP check does not relabel the retained quote timestamp");
  assert.match(visible(gapLater), /60分钟前/);
  assert.doesNotMatch(visible(gapLater), new RegExp(printedTime("2026-09-14T14:45:00.000Z")));
  const noQuote = visible(render([{ ...row, latest_quote: null, estimated_return_pct: null }]));
  assert.match(noQuote, /尚无有效后续报价/); assert.doesNotMatch(noQuote, /-100.0%|Bid \$0.00/);
  assert.match(visible(html), /-100.0%/, "a real zero bid is different from no quote");
  for (const invalid of [{ bid: null }, { bid: NaN }, { bid: Infinity }, { bid: -1 }, { bid: 1, ask: 0.5 }, { ask: 0 }, { ask: null }, { ask: Infinity }, { quoted_at: "invalid-time" }]) {
    const invalidHtml = render([{ ...row, latest_quote: { ...row.latest_quote, ...invalid } }]);
    assert.match(visible(invalidHtml), /尚无有效后续报价/); assert.doesNotMatch(invalidHtml, /NaN|Infinity/);
    assert.doesNotMatch(visible(invalidHtml), /-100.0%/);
  }
  for (const invalid of [undefined, null, 0, -1, NaN, Infinity]) {
    for (const badRow of [
      { ...row, plan: { ...plan, reference: { ...plan.reference, quantity: invalid } } },
      { ...row, plan: { ...plan, contract: { ...plan.contract, multiplier: invalid } } },
    ]) {
      const invalidHtml = render([badRow]);
      assert.doesNotMatch(invalidHtml, /NaN|Infinity/); assert.match(invalidHtml, /参考成本 —/);
      assert.match(invalidHtml, /建单价差 \/ 即时价差损耗<\/dt><dd>未知/);
    }
  }
  const put = render([{ ...row, plan: { ...plan, symbol: "PWR", contract: { ...plan.contract, option_type: "put", strike: 660 }, reference: { ...plan.reference, quantity: 2, ask: 61.9 } } }]);
  assert.match(visible(put), /PWR · \$660 Put/); assert.match(visible(put), /Ask \$61.90/);
  assert.match(card(put), /2张 · 参考成本 \$12380.00（Ask）/);
  for (const pending of [0, NaN, Infinity, -1, 8.64e15 + 1].map((time) => render([], false, time))) {
    assert.match(pending, /读取中，今日数量未知/);
    assert.doesNotMatch(pending, /0\/3|今天还没有建立模拟首单/);
  }
  assert.doesNotMatch(html, /今天还没有建立模拟首单/);
  assert.match(render([{ ...row, status: "EXPIRED" }]), /已到期/);
  assert.match(render([]), /今天还没有建立模拟首单/);
  assert.match(render([]), /今日已建立 0\/3 张/);
  assert.match(html, /今日已建立 1\/3 张/);
  const fridayRows = ["NVDA", "AAPL", "TSLA"].map((symbol, index) => ({ ...row, plan: { ...plan, symbol, plan_id: `paper-plan:2026-09-11${index ? `:${index + 1}` : ""}`, market_date: "2026-09-11" } }));
  const frozenFriday = structuredClone(fridayRows);
  for (const time of ["2026-09-12T03:59:00Z", "2026-09-12T04:00:00Z", "2026-09-12T06:33:00Z"]) assert.match(render(fridayRows, false, Date.parse(time)), /今日 3\/3 张/);
  for (const time of ["2026-09-12T12:00:00Z", "2026-09-14T06:30:00Z"]) {
    const weekend = render(fridayRows, false, Date.parse(time));
    assert.match(weekend, /最近交易日 2026-09-11 3\/3 张/);
    assert.doesNotMatch(weekend, /今日 3\/3|今天已建立|今天还没有建立/);
    const weekendHome = render(fridayRows, false, Date.parse(time), undefined, true);
    assert.match(weekendHome, /今日休市 · 无建单任务/);
    assert.match(weekendHome, /每个交易日仍以 3 张为目标/);
    assert.doesNotMatch(weekendHome, /今日 0\/3|今天还没有建立模拟单/);
  }
  assert.match(render(fridayRows, false, Date.parse("2026-09-14T12:00:00Z")), /今日 0\/3 张/);
  assert.match(render(fridayRows, false, Date.parse("2026-09-14T12:00:00Z"), undefined, true), /今日 0\/3 张/, "trading-day target remains unchanged");
  const holidayRows = fridayRows.map((item) => ({ ...item, plan: { ...item.plan, market_date: "2026-09-04" } }));
  assert.match(render(holidayRows, false, Date.parse("2026-09-07T16:00:00Z")), /最近交易日 2026-09-04 3\/3 张/);
  assert.match(render(holidayRows, false, Date.parse("2026-09-07T16:00:00Z"), undefined, true), /今日休市 · 无建单任务/);
  assert.match(render([], false, Date.parse("2026-09-07T16:00:00Z")), /下一交易日独立检查，不补造旧单/);
  assert.deepEqual(fridayRows, frozenFriday, "reporting-day selection never changes original plan dates or prices");
  assert.match(render([row, { ...row, plan: { ...plan, plan_id: `${plan.plan_id}:2`, symbol: "AAPL" } }, { ...row, plan: { ...plan, plan_id: `${plan.plan_id}:3`, symbol: "TSLA" } }]), /今日已达到每日目标/);
  assert.match(render([row], true), /href="\/settlements#research-paper"/);
  assert.match(html, /本轮模拟胜率统计读取中，结果未确认/);
  assert.doesNotMatch(html, /模拟规则观察胜率：0/);
  const emptyStats = { total: 0, wins: 0, losses: 0, pending: 0, unknown: 0, resolved_days: 0, win_rate_pct: null, average_return_pct: null, profit_factor: null, gap_count: 0, average_entry_spread_pct: null };
  const pendingResult = { plan_id: plan.plan_id, status: "PENDING", event_id: null, recorded_at: null, quoted_at: null, bid: null, return_pct: null, pnl: null, gap_before_result: false };
  const learning = { rule: "FIRST_OBSERVED_30_OR_MINUS_40_V1", summary: { ...emptyStats, total: 4, wins: 1, losses: 1, pending: 1, unknown: 1, resolved_days: 2, win_rate_pct: 50, average_return_pct: -5, profit_factor: 0.8, gap_count: 1, average_entry_spread_pct: 9.2 }, groups: [
    { dimension: "DIRECTION", label: "看涨 Call", stats: { ...emptyStats, total: 2, wins: 1, pending: 1, win_rate_pct: 100, average_return_pct: 40, gap_count: 1 } },
    { dimension: "DIRECTION", label: "看跌 Put", stats: { ...emptyStats, total: 2, losses: 1, unknown: 1, win_rate_pct: 0, average_return_pct: -50 } },
    { dimension: "ENTRY_SPREAD", label: "入场价差 >5%–10%", stats: { ...emptyStats, total: 4, wins: 1, losses: 1, pending: 1, unknown: 1, win_rate_pct: 50 } },
    { dimension: "DTE", label: "建单距到期 ≤30天", stats: { ...emptyStats, total: 4, wins: 1, losses: 1, pending: 1, unknown: 1, win_rate_pct: 50 } },
  ], recent_results: [{ ...pendingResult, status: "WIN", event_id: "first-winning-mark", recorded_at: stamp, quoted_at: plan.reference.quoted_at, bid: 42.98, return_pct: 40, pnl: 1228, gap_before_result: true }] };
  learning.current_round = { start_date: paperPlan.PAPER_RESEARCH_START_DATE, summary: learning.summary, groups: learning.groups };
  const originalLearning = structuredClone(learning);
  const dailyRows = ["MSFT", "DELL", "AAPL", "MSFT", "DELL"].map((symbol, index) => {
    const date = index < 3 ? "2026-09-14" : "2026-09-09", ordinal = index < 3 ? index + 1 : index - 2;
    return { ...row, plan: { ...plan, symbol, market_date: date, plan_id: `paper-plan:${date}${ordinal > 1 ? `:${ordinal}` : ""}` } };
  });
  const dailyLearning = { ...learning, summary: { ...emptyStats, total: 5, wins: 1, losses: 2, pending: 2 }, groups: [], recent_results: dailyRows.map(({ plan }, index) => ({ ...pendingResult, plan_id: plan.plan_id, status: ["WIN", "PENDING", "PENDING", "LOSS", "LOSS"][index], return_pct: index === 0 ? 40 : index >= 3 ? -50 : null, pnl: index === 0 ? 100 : index >= 3 ? -100 : null })) };
  dailyLearning.current_round = { start_date: paperPlan.PAPER_RESEARCH_START_DATE, summary: { ...emptyStats, total: 3, wins: 1, pending: 2, win_rate_pct: 100 }, groups: [{ dimension: "DIRECTION", label: "本轮分组", stats: { ...emptyStats, total: 3, wins: 1, pending: 2, win_rate_pct: 100 } }] };
  dailyLearning.archived_summary = { ...emptyStats, total: 2, losses: 2, win_rate_pct: 0 };
  dailyLearning.groups = [{ dimension: "DIRECTION", label: "全部历史分组", stats: dailyLearning.summary }];
  const frozenDaily = structuredClone({ dailyRows, dailyLearning });
  // Statistics stay available in the closed sheet; verify their original calculations separately from default visibility.
  const summary = (rows, value = dailyLearning, currentTime = Date.parse(stamp), compact = false) => render(rows, compact, currentTime, value);
  const dailySummary = summary(dailyRows);
  const defaultSummary = dailySummary.split("<dialog", 1)[0];
  assert.match(defaultSummary, /今日 3\/3 张[\s\S]*今日规则结果：胜 1 \/ 负 0 \/ 平 0 \/ 待定 2/);
  assert.doesNotMatch(defaultSummary, /本轮胜率|原方向研究规则|每天主动建立|每15分钟/, "research methods and mixed-rule statistics do not flood the owner summary");
  assert.match(dailySummary, /<b>今日 3\/3 张<\/b><\/p><p>今日规则结果：胜 1 \/ 负 0 \/ 平 0 \/ 待定 2 \/ 结束未知 0<\/p>/);
  assert.match(dailySummary, /本轮（2026-09-14 起）：3 张 · 规则胜 1 \/ 负 0 \/ 平 0 · 待定 2 · 结束未知 0/);
  assert.match(dailySummary, /本轮胜率：100.0%（1\/1；胜\/已结算）/);
  assert.match(dailySummary, /每日研究规则：<\/b>尚无自然建单样本/);
  const mixedRules = structuredClone(dailyLearning);
  mixedRules.current_round.groups.push({ dimension: "ENTRY_POLICY", label: "原方向研究规则", stats: { ...emptyStats, total: 3, pending: 3, win_rate_pct: null } });
  mixedRules.current_round.groups.push({ dimension: "ENTRY_POLICY", label: "每日研究规则", stats: { ...emptyStats, total: 1, pending: 1, win_rate_pct: null } });
  mixedRules.current_round.groups.push({ dimension: "ENTRY_POLICY", label: "突破入场规则", stats: { ...emptyStats, total: 2, wins: 1, losses: 1, win_rate_pct: 50 } });
  assert.match(summary(dailyRows, mixedRules), /每日研究规则：<\/b>1 张 · 胜 0 \/ 负 0 \/ 平 0 · 待定 1 · 观察胜率 尚不可计算/);
  assert.match(summary(dailyRows, mixedRules), /原方向研究规则：<\/b>3 张 · 胜 0 \/ 负 0 \/ 平 0 · 待定 3 · 观察胜率 尚不可计算/);
  assert.match(summary(dailyRows, mixedRules), /突破入场规则：<\/b>2 张 · 胜 1 \/ 负 1 \/ 平 0 · 待定 0 · 观察胜率 50.0%/);
  assert.match(summary(dailyRows, mixedRules), /不能当作新规则成绩/);
  assert.doesNotMatch(dailySummary, /本轮胜率：[^<]*1\/3/, "pending examples never enter the win-rate denominator");
  assert.doesNotMatch(dailySummary, /今日规则结果：[^<]*负 2/, "old losses in the same symbols must not count toward today's exact plan IDs");
  const compactSummary = summary(dailyRows, dailyLearning, Date.parse(stamp), true);
  assert.match(compactSummary, /<b>今日 3\/3 张<\/b> · 规则胜 1 \/ 负 2 \/ 平 0 · 待定 2 · 结束未知 0<\/p>/);
  assert.doesNotMatch(compactSummary, /今日规则结果|全部历史：/, "the compact summary keeps its original output");
  const roundHtml = render(dailyRows, false, Date.parse(stamp), dailyLearning);
  const [currentHtml, archivedHtml] = roundHtml.split('>旧单归档（2 张可查看）<span');
  assert.ok(archivedHtml, "old tickets must have a separate closed archive sheet");
  for (const title of ["本轮模拟记录（3 张）", "旧单归档（2 张可查看）"]) {
    assert.ok(roundHtml.includes(`aria-haspopup="dialog">${title}<span`), `${title} opens beside the page`);
    assert.ok(!roundHtml.includes(`<summary>${title}</summary>`), "large record groups cannot stretch the main page inline");
  }
  assert.match(currentHtml, /本轮模拟记录（3 张）/); assert.equal((currentHtml.match(/<article /g) ?? []).length, 3);
  assert.match(currentHtml, /本轮模拟规则观察胜率：100.0%/); assert.match(currentHtml, /本轮分组/);
  assert.doesNotMatch(currentHtml, /全部历史分组|paper-plan:2026-09-09|原建单日期：2026-09-09/);
  assert.equal((archivedHtml.match(/<article /g) ?? []).length, 2);
  assert.match(archivedHtml, /归档汇总：2 张 · 胜 0 \/ 负 2 \/ 平 0 · 待定 0 · 结束未知 0/);
  assert.equal((archivedHtml.match(/原建单日期：2026-09-09/g) ?? []).length, 2);
  assert.match(archivedHtml, /Ask \$30.70/); assert.match(archivedHtml, /固定规则结果[\s\S]*?负 · -50.0%/);
  assert.match(archivedHtml, /原价格与固定结果保留，不进入本轮胜率/);
  assert.doesNotMatch(roundHtml, /<details[^>]*\bopen(?:=|\s|>)/);
  for (const current_round of [undefined, { ...dailyLearning.current_round, start_date: "2026-09-13" }]) {
    const unavailable = render(dailyRows, false, Date.parse(stamp), { ...dailyLearning, current_round });
    assert.match(unavailable, /本轮（2026-09-14 起）：结果未确认/);
    assert.match(unavailable, /本轮胜率：未确认/);
    assert.match(unavailable, /本轮模拟胜率统计读取中，结果未确认/);
    assert.doesNotMatch(unavailable, /本轮模拟规则观察胜率：|全部历史分组/);
    assert.equal(render(dailyRows, true, Date.parse(stamp), { ...dailyLearning, current_round }), render(dailyRows, true, Date.parse(stamp), dailyLearning), "new round metadata cannot affect any compact output");
  }
  for (const missing of [undefined, { ...dailyLearning, recent_results: dailyLearning.recent_results.filter((result) => result.plan_id !== dailyRows[1].plan.plan_id) }, { ...dailyLearning, recent_results: [] }]) {
    const incomplete = render(dailyRows, false, Date.parse(stamp), missing).split("<details", 1)[0];
    assert.match(incomplete, /今日规则结果：未确认<\/p>/);
    assert.doesNotMatch(incomplete, /今日规则结果：胜|今日规则结果：[^<]*待定/, "missing results must never become zero counts or pending guesses");
  }
  assert.match(summary(undefined), /模拟单记录尚未读取，数量和结果暂未知/);
  assert.match(summary(dailyRows, dailyLearning, 0), /今日规则结果：未确认/);
  const fridayLearning = { ...dailyLearning, recent_results: fridayRows.map(({ plan }, index) => ({ ...dailyLearning.recent_results[index], plan_id: plan.plan_id })) };
  assert.match(summary(fridayRows, fridayLearning, Date.parse("2026-09-12T12:00:00Z")), /最近交易日 2026-09-11规则结果：胜 1 \/ 负 0 \/ 平 0 \/ 待定 2 \/ 结束未知 0/);
  assert.deepEqual({ dailyRows, dailyLearning }, frozenDaily, "daily summaries never change original plans or learning results");
  const scored = render([row], false, Date.parse(stamp), learning);
  assert.match(scored, /价差占原始 Ask，分组使用同一口径/);
  for (const phrase of ["模拟规则观察胜率：50.0%", "本轮 4 张，胜 1 / 负 1 / 平 0，分母 2；待定 1，结束未知 1", "样本不足", "平均观察回报 -5.0%", "金额加权盈利因子 0.80", "平均原始价差 9.2%", "不限于下方列表", "判定前有采样缺口"]) assert.ok(scored.includes(phrase), phrase);
  assert.match(visible(scored), /固定规则结果[\s\S]*?胜 · \+40.0%[\s\S]*?\+\$1228.00/);
  assert.match(visible(scored), /规则退出后研究涨跌[\s\S]*?-100.0%/);
  assert.match(card(scored), /固定结算报价 \/ 时间<\/dt><dd>Bid \$42.98/);
  assert.ok(card(scored).includes(printedTime(plan.reference.quoted_at)));
  assert.match(scored, /看涨 Call<\/th><td>2<\/td><td>1 \/ 0 \/ 0 \/ 1 \/ 0<\/td><td>100.0%/);
  assert.match(scored, /看跌 Put<\/th><td>2<\/td><td>0 \/ 1 \/ 0 \/ 0 \/ 1<\/td><td>0.0%/);
  assert.match(scored, /原始价差 · 入场价差 &gt;5%–10%/);
  assert.match(scored, /原始到期天数 · 建单距到期 ≤30天/);
  const resultOnly = (result, summary) => ({ ...learning, summary, groups: [], recent_results: [result], current_round: { start_date: paperPlan.PAPER_RESEARCH_START_DATE, summary, groups: [] } });
  const positiveRow = { ...row, estimated_return_pct: 999, latest_quote: { ...row.latest_quote, bid: 33.77, ask: 34 }, highest_observed_return_pct: 10, lowest_observed_return_pct: 0, stop_observed: false, take_profit_observed: false };
  const positiveOriginal = structuredClone(positiveRow);
  const positivePending = render([positiveRow], false, Date.parse(stamp), resultOnly(pendingResult, { ...emptyStats, total: 1, pending: 1 }));
  assert.match(visible(positivePending), /固定规则结果[\s\S]*?未结算/);
  assert.match(visible(positivePending), /建单后跟踪涨跌[\s\S]*?\+10.0%[\s\S]*?\+\$307.00[\s\S]*?最新 Bid 对建单 Ask/);
  assert.doesNotMatch(visible(positivePending), /999.0%/, "derive the displayed change from the displayed quote and original ask");
  assert.deepEqual(positiveRow, positiveOriginal);
  assert.match(positivePending, /模拟规则观察胜率：尚不可计算/);
  assert.match(positivePending, /本轮胜率：尚不可计算（尚无已结算样本）/);
  assert.match(positivePending, /金额加权盈利因子 尚不可计算/);
  assert.doesNotMatch(visible(positivePending), /paper-ticket-result">[胜负]/);
  assert.doesNotMatch(positivePending, /模拟规则观察胜率：0/);
  const unknown = render([{ ...row, status: "EXPIRED" }], false, Date.parse(stamp), resultOnly({ ...pendingResult, status: "UNKNOWN" }, { ...emptyStats, total: 1, unknown: 1 }));
  assert.match(visible(unknown), /结束未知[\s\S]*?无可核验结算报价/);
  assert.match(unknown, /胜 0 \/ 负 0 \/ 平 0，分母 0；待定 0，结束未知 1/);
  const loss = render([row], false, Date.parse(stamp), resultOnly({ ...learning.recent_results[0], status: "LOSS", bid: 15.35, return_pct: -50, pnl: -1535 }, { ...emptyStats, total: 1, losses: 1, win_rate_pct: 0, average_return_pct: -50, profit_factor: 0 }));
  assert.match(loss, /模拟规则观察胜率：0.0%/);
  assert.match(visible(loss), /固定规则结果[\s\S]*?负 · -50.0%[\s\S]*?−\$1535.00/);
  assert.match(loss, /金额加权盈利因子 0.00/);
  const riskExit = { rule_version: "PAPER_RISK_EXIT_V1", reason: "EARNINGS_WINDOW", decision_at: stamp, event_id: "synthetic-current-earnings", title: "财报预告，不预测方向", source: "Finnhub Earnings Calendar", source_url: null, scheduled_for: "2026-09-11", published_at: null, session: "BMO", source_observed_at: stamp, source_checked_at: stamp, scope: "NVDA" };
  for (const [status, pnl, label] of [["WIN", 100, "胜"], ["LOSS", -100, "负"], ["FLAT", 0, "平"]]) {
    const observedRow = { ...row, status: "OBSERVING", estimated_return_pct: 80, latest_quote: { bid: 55.26, ask: 55.5, quoted_at: "2026-09-14T14:00:00.000Z" } };
    const frozenObserved = structuredClone(observedRow);
    const observedLearning = resultOnly({ ...pendingResult, status, event_id: "risk-mark", recorded_at: stamp, quoted_at: stamp, bid: 30.7 + pnl / 100, return_pct: pnl / 30.7, pnl, exit_reason: riskExit.reason, risk_exit: riskExit }, { ...emptyStats, total: 1, wins: status === "WIN" ? 1 : 0, losses: status === "LOSS" ? 1 : 0, flats: status === "FLAT" ? 1 : 0, risk_exits: 1, win_rate_pct: status === "WIN" ? 100 : 0 });
    const frozenLearning = structuredClone(observedLearning);
    const observed = render([observedRow], false, Date.parse("2026-09-14T14:01:00.000Z"), observedLearning);
    assert.match(visible(observed), new RegExp(`固定规则结果[\\s\\S]*?${label} · ${pnl < 0 ? "-" : "\\+"}${Math.abs(pnl / 30.7).toFixed(1)}%`));
    assert.match(visible(observed), /规则退出后研究涨跌[\s\S]*?\+80.0%[\s\S]*?财报避险[\s\S]*?今日继续跟踪，不改结算/);
    assert.ok(visible(observed).includes(printedTime(observedRow.latest_quote.quoted_at)));
    for (const phrase of ["分母 1", "风控提前退出 1 张", "持平计入分母但不算胜", "财报预告，不预测方向", "synthetic-current-earnings"]) assert.ok(observed.includes(phrase), phrase);
    assert.deepEqual(observedRow, frozenObserved); assert.deepEqual(observedLearning, frozenLearning);
  }
  const justSettled = render([{ ...row, latest_quote: { bid: 30.7, ask: 30.8, quoted_at: stamp }, estimated_return_pct: 0 }], false, Date.parse(stamp), resultOnly({ ...pendingResult, status: "FLAT", quoted_at: stamp, recorded_at: stamp, bid: plan.reference.ask, return_pct: 0, pnl: 0, exit_reason: riskExit.reason, risk_exit: riskExit }, { ...emptyStats, total: 1, flats: 1, risk_exits: 1, win_rate_pct: 0 }));
  assert.match(visible(justSettled), /今日继续跟踪，不改结算/);
  assert.ok(visible(justSettled).includes(`重点至 ${printedTime(paperPlan.paperExpiryClose(plan.market_date))}`));
  assert.doesNotMatch(visible(justSettled), /规则退出后研究涨跌/);
  const longList = Array.from({ length: 12 }, (_, index) => ({ ...row, plan: { ...plan, plan_id: `visible-${index}`, symbol: `EXAMPLE${index}`, market_date: "2026-09-09" } }));
  const retainedResults = { ...learning, recent_results: [
    { ...learning.recent_results[0], plan_id: longList[10].plan.plan_id },
    { ...learning.recent_results[0], plan_id: longList[11].plan.plan_id, status: "LOSS", bid: 15.35, return_pct: -50, pnl: -1535 },
  ] };
  const fullList = render(longList, false, Date.parse(stamp), retainedResults), compactList = render(longList, true, Date.parse(stamp), retainedResults);
  assert.equal((fullList.match(/<article /g) ?? []).length, 12);
  assert.match(fullList, /EXAMPLE10/); assert.match(fullList, /EXAMPLE11/);
  assert.match(fullList, /paper-ticket-result">胜 · \+40.0%/); assert.match(fullList, /paper-ticket-result">负 · -50.0%/);
  assert.equal((compactList.match(/<article /g) ?? []).length, 3);
  assert.doesNotMatch(compactList, /EXAMPLE10|EXAMPLE11/);
  assert.match(compactList, /href="\/settlements#research-paper"/);
  for (const [wins, resolved_days] of [[19, 5], [20, 4]]) assert.match(render([], false, Date.parse(stamp), resultOnly(pendingResult, { ...emptyStats, total: wins, wins, resolved_days, win_rate_pct: 100 })), /样本不足/);
  assert.match(render([], false, Date.parse(stamp), resultOnly(pendingResult, { ...emptyStats, total: 20, wins: 20, resolved_days: 5, win_rate_pct: 100 })), /分组差异仅供提出后续研究假设，尚未证明优势/);
  assert.deepEqual(learning, originalLearning);
  const point = { contract_id: plan.contract.contract_id, begins_at: "2026-09-14T13:40:00.000Z", ends_at: stamp, close: 19.75, retrieved_at: stamp, source: "ROBINHOOD", interval: "5minute" };
  const withEvidence = { ...row, plan: { ...plan, reference: { ...plan.reference, mark: 30.1, proof: { received_at: stamp } } }, latest_quote: { ...row.latest_quote, mark: 0.05, proof: { received_at: stamp } }, chart: { entry: point, latest: point, checked_at: stamp, status: "AVAILABLE" } };
  const savedEvidence = structuredClone(withEvidence), evidenceHtml = render([withEvidence]);
  assert.match(visible(html), /Mark 未留存/, "old marks must remain unknown, not reconstructed from Bid/Ask");
  assert.match(visible(evidenceHtml), /Mark \$30.10/); assert.match(visible(evidenceHtml), /Mark \$0.05/);
  assert.match(card(evidenceHtml), /RB 5分钟时间线 · 区间结束价/);
  assert.match(card(evidenceHtml), /\$19.75 · 09\/14 06:40–06:45 PT/);
  assert.match(card(evidenceHtml), /已自动读取/); assert.match(card(evidenceHtml), /图表标注区间起点，区间价不作买入成本/);
  assert.match(card(evidenceHtml), /建单报价原文：已留存/);
  assert.match(card(evidenceHtml), /RB 建单时段[\s\S]*?\$19.75[\s\S]*?RB 最近时段[\s\S]*?\$19.75[\s\S]*?RB 时间线涨跌[\s\S]*?\+0.0%/);
  assert.doesNotMatch(visible(evidenceHtml), /报价原文/, "raw proof stays collapsed");
  assert.match(visible(evidenceHtml), /Ask \$30.70[\s\S]*?-100.0%/, "chart close never replaces original ask or changes performance");
  assert.equal(render([withEvidence], true), render([row], true), "all reconciliation additions must leave the home card byte-for-byte unchanged");
  for (const badPoint of [{ ...point, contract_id: "different-contract" }, { ...point, close: NaN }, { ...point, ends_at: "2026-09-14T13:50:00Z" }, { ...point, retrieved_at: "2026-09-14T13:44:59Z" }]) {
    const invalid = render([{ ...withEvidence, chart: { ...withEvidence.chart, entry: badPoint, latest: null, status: "UNAVAILABLE" } }]);
    assert.match(card(invalid), /建单所在区间：待获取/); assert.doesNotMatch(card(invalid), /\$19.75|NaN|Infinity/);
    assert.match(card(invalid), /时间线暂不可用/);
  }
  assert.match(render([{ ...withEvidence, chart: { ...withEvidence.chart, entry: null, status: "PARTIAL" } }]), /部分时间线待补齐/);
  assert.deepEqual(withEvidence, savedEvidence, "rendering reconciliation metadata never mutates original evidence");
  for (const [symbol, strike, entry, last, increase, pnl] of [["DELL", 540, 19.75, 21.83, "+10.5%", "+$208.00"], ["MSFT", 500, 5.78, 11.13, "+92.6%", "+$535.00"], ["AAPL", 332.5, 5.93, 6.23, "+5.1%", "+$30.00"]]) {
    const sample = { ...row, plan: { ...plan, symbol, contract: { ...plan.contract, strike } }, chart: { entry: { ...point, close: entry }, latest: { ...point, begins_at: "2026-09-14T14:00:00Z", ends_at: "2026-09-14T14:05:00Z", retrieved_at: "2026-09-14T14:06:00Z", close: last }, checked_at: "2026-09-14T14:06:00Z", status: "AVAILABLE" } };
    const now = Date.parse(sample.chart.checked_at), frozen = structuredClone(sample), comparison = paperPlan.paperChartComparison(sample.plan, sample.chart, now);
    assert.equal(comparison.entry.close, entry); assert.equal(comparison.latest.close, last);
    const main = card(render([sample], false, now));
    assert.ok(main.includes(increase)); assert.ok(main.includes(pnl));
    assert.match(main, /06:40–06:45 PT/); assert.match(main, /07:00–07:05 PT/);
    assert.match(main, /固定规则结果 · Ask→Bid/);
    assert.deepEqual(sample, frozen, "RB comparison cannot change stored costs, quotes, or results");
    for (const invalid of [
      { ...sample.chart, entry: null, status: "PARTIAL" },
      { ...sample.chart, entry: { ...sample.chart.entry, close: 0 } },
      { ...sample.chart, entry: { ...sample.chart.entry, contract_id: "another-strike" } },
      { ...sample.chart, entry: { ...sample.chart.entry, close: NaN } },
      { ...sample.chart, entry: { ...sample.chart.entry, begins_at: "2026-09-14T13:35:00Z", ends_at: "2026-09-14T13:40:00Z" } },
      { ...sample.chart, latest: { ...sample.chart.latest, retrieved_at: "2026-09-14T14:04:00Z" } },
      { ...sample.chart, checked_at: "2026-09-14T14:07:00Z" },
    ]) assert.equal(paperPlan.paperChartComparison(sample.plan, invalid, now), null, "wrong contract, time, missing or zero reference must not produce RB returns");
    for (const badTime of [NaN, Infinity, 8.64e15 + 1]) assert.equal(paperPlan.paperChartComparison(sample.plan, sample.chart, badTime), null);
  }
  assert.deepEqual(row, original, "rendering must never change the frozen original or later observations");
  const specialDays = [{ market_date: "2026-09-14", label: "FOMC 议息日", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", source_record_id: "live-shadow:calendar:A1", observed_at: stamp }];
  const marked = render([row], false, Date.parse(stamp), undefined, false, specialDays);
  assert.match(visible(marked), /class="paper-ticket-note">特殊日 · 1项日历标记/);
  assert.doesNotMatch(visible(marked), /special-day-label|FOMC 议息日|查看日程/, "repeated event banners stay inside the ticket's detail sheet");
  assert.match(card(marked), /特殊日 · FOMC 议息日/);
  assert.match(card(marked), /2026-09-14 · 官方日历标记/);
  assert.ok(card(marked).includes(`href="${specialDays[0].source_url}"`), "official calendar evidence remains available");
  assert.match(card(render([row], false, Date.parse("2026-09-16T20:00:00Z"), undefined, false, specialDays)), /特殊日 · FOMC/, "historical card uses its entry day, not viewing day");
  assert.doesNotMatch(render([row], false, Date.parse(stamp), undefined, false, [{ ...specialDays[0], market_date: "2026-09-15" }]), /特殊日 ·/);
  assert.doesNotMatch(render([row]), /特殊日 ·/);
  assert.deepEqual(row, original, "calendar annotation does not rewrite plan or result");
  const twoDays = [...specialDays, { ...specialDays[0], label: "CPI 发布日", release_name: "Consumer Price Index", source_url: "https://www.bls.gov/schedule/news_release/cpi.htm" }];
  const legacyMarked = render([row], false, Date.parse(stamp), undefined, false, twoDays);
  assert.match(visible(legacyMarked), /特殊日 · 2项日历标记/);
  assert.match(legacyMarked, /特殊日 · FOMC 议息日[\s\S]*特殊日 · CPI 发布日/);
  assert.match(legacyMarked, /原规则：\+30% \/ -40%/);
  const specialRow = { ...row, plan: { ...plan, take_profit_pct: 10, stop_loss_pct: -10, threshold_policy: { version: "SPECIAL_DAY_10_10_V1", events: twoDays } } };
  const specialFrozen = structuredClone(specialRow);
  const specialHtml = render([specialRow], false, Date.parse(stamp));
  assert.match(visible(specialHtml), /特殊日试行：\+10% \/ -10%/);
  assert.match(card(specialHtml), /建单时已核验并固定/);
  assert.match(visible(specialHtml), /止盈参考价（\+10%）[\s\S]*?\$33.77/);
  assert.match(visible(specialHtml), /止损参考价（-10%）[\s\S]*?\$27.63/);
  assert.match(specialHtml, /新单按 1–3 个交易日的持有意图复查/);
  assert.match(specialHtml, /每天主动建立 3 张研究模拟单，不足时继续轮换候选/);
  assert.match(visible(specialHtml), /旧观察基线 · 未记录当前建单规则/);
  assert.match(visible(specialHtml), /原持有计划未记录/);
  assert.match(card(specialHtml), /原单未冻结持有意图/);
  const qualifiedRow = { ...specialRow, plan: { ...specialRow.plan, entry_policy: { version: "QUALIFIED_PAPER_ENTRY_V1" }, holding_intent: { min_trading_days: 1, max_trading_days: 3, time_exit: "REVIEW_ONLY" } } };
  const qualifiedFrozen = structuredClone(qualifiedRow);
  const qualifiedHtml = render([qualifiedRow], false, Date.parse(stamp));
  assert.match(visible(qualifiedHtml), /突破入场规则 · 仅模拟/);
  assert.match(card(qualifiedHtml), /原持有意图：1–3个交易日/);
  assert.match(card(qualifiedHtml), /计划复查：2026-09-14 至 2026-09-16/);
  assert.match(visible(qualifiedHtml), /复查期限 2026-09-16/);
  assert.doesNotMatch(visible(qualifiedHtml), /已到第3个交易日/);
  assert.match(visible(render([qualifiedRow], false, Date.parse("2026-09-16T14:00:00Z"))), /持有计划待复查/);
  for (const status of ["EXPIRED", "VOIDED"]) for (const outcome of ["UNKNOWN", "WIN"]) for (const chart of [undefined, { ...withEvidence.chart, entry: null, status: "PARTIAL", entry_issue: "WAIT_ROTATION", latest_issue: "TIMEOUT" }]) {
    const endedRow = { ...qualifiedRow, status, chart, ...(status === "VOIDED" ? { owner_void: voided.owner_void } : {}) };
    const endedLearning = outcome === "UNKNOWN" ? resultOnly({ ...pendingResult, status: "UNKNOWN" }, { ...emptyStats, total: 1, unknown: 1 })
      : resultOnly(learning.recent_results[0], { ...emptyStats, total: 1, wins: 1, win_rate_pct: 100 });
    const saved = structuredClone({ endedRow, endedLearning });
    const endedHtml = render([endedRow], false, Date.parse("2026-09-21T14:00:00Z"), endedLearning), endedCard = card(endedHtml);
    assert.match(endedCard, /停止跟踪/);
    assert.match(endedCard, /观察已结束，原计划仅作历史记录/);
    assert.match(endedCard, /历史图点不足，无法对照/);
    assert.doesNotMatch(endedCard, /持有计划待复查|按计划复查|今日继续跟踪，不改结算|等待下一次自动检查|部分时间线待补齐|待获取|待核对|等待轮次检查|盘末观察，不改结算/, "ended observations must not promise a task that the runtime no longer schedules");
    if (chart) assert.match(endedCard, /停止跟踪前未轮到检查。最新图点：读取超时/);
    if (outcome === "UNKNOWN") {
      assert.match(visible(endedHtml), /不可评分，不计入胜率分母，历史缺口保留/);
      assert.match(endedHtml, /胜 0 \/ 负 0 \/ 平 0，分母 0；待定 0，结束未知 1/);
    } else {
      assert.match(visible(endedHtml), /胜 · \+40.0%[\s\S]*?\+\$1228.00/);
      assert.match(endedHtml, /分母 1/);
    }
    assert.deepEqual({ endedRow, endedLearning }, saved, "terminal labels never rewrite quotes, first results or the denominator");
  }
  assert.match(card(render([qualifiedRow], false, Date.parse("2026-09-16T14:00:00Z"), resultOnly(pendingResult, { ...emptyStats, total: 1, pending: 1 }))), /持有计划待复查[\s\S]*等待下一次自动检查/, "active pending observations still use the existing tracking schedule");
  const beforeHoliday = { ...qualifiedRow, plan: { ...qualifiedRow.plan, market_date: "2026-09-04" } };
  assert.match(visible(render([beforeHoliday], false, Date.parse("2026-09-04T16:00:00Z"))), /复查期限 2026-09-09/, "weekend and Labor Day do not count as holding sessions");
  const windowPlan = { ...qualifiedRow.plan, market_date: "2026-10-01", created_at: "2026-10-01T13:45:00.000Z", expires_at: "2026-10-16T20:00:00.000Z", contract: { ...plan.contract, expiration: "2026-10-16" } };
  const window = paperPlan.paperTrackingWindow(windowPlan);
  assert.equal(window.focus_ends_at, "2026-10-05T20:00:00.000Z");
  assert.equal(window.ends_at, "2026-10-08T13:45:00.000Z");
  const focused = { ...qualifiedRow, plan: windowPlan, status: "OBSERVING", latest_quote: { bid: 30.7, ask: 30.8, quoted_at: windowPlan.created_at } };
  for (const [compact, todayOnly] of [[false, false], [true, false], [false, true]]) {
    const focusedHtml = visible(render([focused], compact, Date.parse(windowPlan.created_at), undefined, todayOnly));
    assert.match(focusedHtml, /重点跟踪/);
    assert.ok(focusedHtml.includes(printedTime(window.focus_ends_at)));
    assert.ok(focusedHtml.includes(printedTime(window.ends_at)));
  }
  const closeResearch = { ...focused, tracking: paperPlan.projectPaperTracking(windowPlan, [], "2026-10-06T18:00:00Z") };
  assert.equal(closeResearch.tracking.stage, "RESEARCH");
  const closeHtml = render([closeResearch], false, Date.parse("2026-10-06T18:00:00Z"));
  assert.match(visible(closeHtml), /盘末观察 · 每天最多一次/);
  assert.match(closeHtml, /收盘前一小时内每天最多尝试一次/);
  assert.doesNotMatch(visible(closeHtml), /重点跟踪/);
  const lossResult = { ...pendingResult, status: "LOSS", quoted_at: "2026-10-01T14:00:00Z", recorded_at: "2026-10-01T14:00:01Z", bid: 15.35, return_pct: -50, pnl: -1535, exit_reason: "STOP_LOSS" };
  const lossLearning = resultOnly(lossResult, { ...emptyStats, total: 1, losses: 1, win_rate_pct: 0 });
  const recovery = { bid: 30.7, return_pct: 0, quoted_at: "2026-10-02T19:15:00Z", recorded_at: "2026-10-02T19:15:01Z" };
  const rebound = { ...focused, latest_quote: { bid: 42.98, ask: 43, quoted_at: "2026-10-05T19:15:00Z" }, window_research: { ends_at: window.ends_at, recovery_after_loss: recovery, target_after_loss: { ...recovery, bid: 42.98, return_pct: 40, quoted_at: "2026-10-05T19:15:00Z" }, best_return_pct: 40, worst_return_pct: -50, gap_observed: true } };
  const immutable = structuredClone({ rebound, lossLearning });
  const reboundHtml = render([rebound], false, Date.parse("2026-10-05T19:16:00Z"), lossLearning);
  assert.match(visible(reboundHtml), /规则退出后研究涨跌[\s\S]*?\+40.0%[\s\S]*?非真实收益，不计原胜率/);
  assert.match(visible(reboundHtml), /固定规则结果[\s\S]*?负 · -50.0%/);
  assert.match(reboundHtml, /模拟规则观察胜率：0.0%/);
  assert.match(reboundHtml, /窗口内最高 \/ 最低采样：\+40.0% \/ -50.0%/);
  assert.match(reboundHtml, /亏损后回本：首次观察 Bid \$30.70 ≥ 原 Ask/);
  assert.match(reboundHtml, /亏损后达到原止盈：首次观察 Bid \$42.98/);
  assert.ok(reboundHtml.includes(printedTime(recovery.quoted_at)));
  assert.match(reboundHtml, /窗口内有报价缺口；未观察到不等于从未发生/);
  assert.deepEqual({ rebound, lossLearning }, immutable, "research views cannot change first results or sample evidence");
  const unknownResearch = { ...rebound, window_research: { ...rebound.window_research, recovery_after_loss: null, target_after_loss: null, best_return_pct: null, worst_return_pct: null } };
  const unknownWindow = render([unknownResearch], false, Date.parse("2026-10-05T19:16:00Z"), lossLearning).split('aria-label="观察窗口复盘"')[1].split('</section>')[0];
  assert.match(unknownWindow, /尚无报价记录 \/ 尚无报价记录/);
  assert.match(unknownWindow, /未观察到回本；采样有限/);
  assert.match(unknownWindow, /未观察到达到原止盈；采样有限/);
  assert.doesNotMatch(unknownWindow, /\$0|[+]0.0%|从未回本/);
  const archivedRow = { ...rebound, status: "ARCHIVED", latest_quote: { ...rebound.latest_quote, quoted_at: "2026-10-09T19:15:00Z" }, latest_entry_confirmation: confirmation, tracking: paperPlan.projectPaperTracking(windowPlan, [], "2026-10-10T18:00:00Z") };
  const archivedCard = card(render([archivedRow], false, Date.parse("2026-10-10T18:00:00Z"), lossLearning));
  assert.match(archivedCard, /观察已结束 · 停止跟踪/);
  assert.match(archivedCard, /历史最后采样 Bid \/ Ask/);
  assert.match(archivedCard, /此历史报价晚于现行观察截止，不计入窗口复盘/);
  assert.match(archivedCard, /归档不代表合约到期或已卖出/);
  assert.match(archivedCard, /历史核验：入场条件已满足/);
  assert.doesNotMatch(archivedCard, /合约已到期|观察结束前最后采样|需新行情复核|本轮报价缺口|等待下一次自动检查|原止盈止损继续生效/);
  assert.ok(archivedCard.includes(printedTime(window.ends_at)));
  const shortExpiry = { ...focused, plan: { ...windowPlan, expires_at: "2026-10-02T20:00:00Z", contract: { ...windowPlan.contract, expiration: "2026-10-02" } }, status: "EXPIRED" };
  assert.match(card(render([shortExpiry], false, Date.parse("2026-10-03T18:00:00Z"))), /合约已到期/);
  assert.ok(visible(render([shortExpiry], false, Date.parse("2026-10-03T18:00:00Z"))).includes(printedTime(shortExpiry.plan.expires_at)));
  assert.doesNotMatch(visible(qualifiedHtml), /旧观察基线|未冻结持有意图/);
  assert.deepEqual(qualifiedRow, qualifiedFrozen);
  const researchRow = { ...qualifiedRow, plan: { ...qualifiedRow.plan, entry_policy: { version: "DAILY_PAPER_RESEARCH_V1" }, warnings: ["index input blocked"] } };
  const researchHtml = render([researchRow], false, Date.parse(stamp));
  assert.match(visible(researchHtml), /每日研究规则 · 仅模拟/);
  assert.match(researchHtml, /建单时风险提示：index input blocked/);
  assert.doesNotMatch(visible(researchHtml), /突破入场规则 · 仅模拟/);
  assert.match(visible(render([{ ...researchRow, plan: { ...researchRow.plan, entry_policy: { version: "BASELINE_PAPER_RESEARCH_V1" } } }], false, Date.parse(stamp))), /原方向研究规则 · 仅模拟/);
  assert.match(specialHtml, /RB 止损限价卖单按 Ask/);
  assert.deepEqual(specialRow, specialFrozen);
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const macro = await import("../app/macro-event-learning.ts"), banner = {};
  const bannerSource = await readFile(new URL("../app/MacroEventNotice.tsx", import.meta.url), "utf8");
  new Function("exports", "require", transpileModule(bannerSource, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText)(banner, (name) => {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "./market-time") return marketTime;
    if (name === "./macro-event-learning") return macro;
    if (name === "./DetailSheet") return detail;
    throw Error(`Unexpected event notice dependency: ${name}`);
  });
  const verifiedDay = { market_date: "2026-09-14", label: "FOMC 议息日", release_name: "FOMC Meeting Decision", scheduled_at: "2026-09-14T14:00:00Z", time_precision: "EXACT", confidence: "official_schedule", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", source_record_id: "live-shadow:20260914T130000Z:A1", observed_at: "2026-09-14T13:00:00Z", received_at: "2026-09-14T13:00:01Z", as_of: "2026-09-14T13:00:00Z" };
  const verifiedCpi = { ...verifiedDay, label: "CPI 公布日", release_name: "Consumer Price Index", time_precision: "DATE_ONLY", scheduled_at: "2026-09-14T12:00:00Z", confidence: "official_federal_reserve_aggregator_date_only", source_url: "https://fred.stlouisfed.org/releases/calendar?rid=10&view=year" };
  const renderBanner = (time, entry_special_days, days = [verifiedDay]) => renderToStaticMarkup(jsx.jsx(banner.MacroEventNotice, { overview: { special_days: days, entry_special_days }, at: Date.parse(time) }));
  assert.match(renderBanner("2026-09-14T23:00:00Z"), /重点事件风险.*今日 · 2026-09-14 · FOMC 议息日/, "banner lasts all day after the scheduled event");
  assert.match(renderBanner("2026-09-15T06:59:59Z"), /FOMC/, "banner uses PT midnight");
  assert.doesNotMatch(renderBanner("2026-09-15T07:00:00Z"), /FOMC/, "yesterday's flag must not label today");
  assert.equal(renderBanner("invalid"), "");
  assert.match(renderBanner(stamp), /当前建单日历待核验/);
  assert.match(renderBanner(stamp, []).split("<dialog", 1)[0], /未确认今日特殊规则；原单规则不变/);
  const tomorrow = { ...verifiedDay, market_date: "2026-09-15", scheduled_at: "2026-09-15T14:00:00Z" };
  assert.doesNotMatch(renderBanner(stamp, [tomorrow]).split("<dialog", 1)[0], /新模拟单 \+10%/, "tomorrow's calendar cannot activate today's special rule");
  assert.match(renderBanner(stamp, undefined, [tomorrow]).split("<dialog", 1)[0], /下一交易日 · 2026-09-15 · FOMC/);
  assert.doesNotMatch(renderBanner(stamp, undefined, [tomorrow]).split("<dialog", 1)[0], /新模拟单|当前建单日历/, "tomorrow's event is not today's entry policy");
  const noticeDays = [verifiedDay, verifiedCpi], frozenNoticeDays = structuredClone(noticeDays);
  const twoDayBanner = renderBanner(stamp, noticeDays, noticeDays);
  const bannerSummary = twoDayBanner.split("<dialog", 1)[0];
  assert.match(bannerSummary, /重点事件风险 · 2 项/);
  assert.match(bannerSummary, /新模拟单 \+10% \/ -10%；旧单规则不变/);
  assert.match(bannerSummary, /FOMC 议息日[\s\S]*CPI 公布日/, "important event names must be visible before opening details");
  assert.match(bannerSummary, /区间／震荡.*不代表肯定下跌.*不代表低风险/);
  assert.match(bannerSummary, /仅网页提醒，不代表手机通知已送达/);
  assert.match(twoDayBanner, /<dialog[^>]*>[\s\S]*重点事件日程与模拟规则/);
  assert.doesNotMatch(twoDayBanner, /<dialog[^>]*\bopen(?:=|\s|>)/);
  for (const day of noticeDays) assert.ok(twoDayBanner.includes(`href="${day.source_url.replaceAll("&", "&amp;")}"`), "the detail sheet retains every official calendar link");
  assert.match(twoDayBanner, /新模拟单试行 \+10% 止盈 \/ -10% 止损，仅限当前建单日历已核验标记；旧单保持原规则/);
  const dateOnly = renderBanner(stamp, undefined, [verifiedCpi]);
  assert.match(dateOnly, /CPI 公布日.*仅核实日期，具体公布时间未核实/);
  assert.doesNotMatch(dateOnly, /05:00|12:00|加州时间/, "date-only calendar placeholder must never look like a verified release time");
  const monday = { ...verifiedDay, market_date: "2026-09-21", scheduled_at: "2026-09-21T14:00:00Z" };
  assert.match(renderBanner("2026-09-19T19:00:00Z", undefined, [monday]), /下一交易日 · 2026-09-21/);
  const thanksgivingFriday = { ...verifiedDay, market_date: "2026-11-27", scheduled_at: "2026-11-27T14:00:00Z" };
  assert.match(renderBanner("2026-11-25T19:00:00Z", undefined, [thanksgivingFriday]), /下一交易日 · 2026-11-27/, "NYSE holiday is skipped");
  for (const field of ["observed_at", "received_at", "as_of"]) assert.equal(renderBanner(stamp, undefined, [{ ...verifiedDay, [field]: "2026-09-14T15:00:00Z" }]), "", `${field} from the future cannot become a prior warning`);
  assert.equal(renderBanner(stamp, undefined, [{ ...verifiedDay, source_url: "https://unverified.test/calendar" }]), "");
  assert.equal(renderBanner(stamp, undefined, [{ ...verifiedDay, market_date: "2026-09-15" }]), "", "event date and timestamp must agree");
  assert.equal(renderBanner(stamp, undefined, specialDays), "", "legacy incomplete provenance is not promoted to a verified notice");
  assert.deepEqual(noticeDays, frozenNoticeDays);
  const reviewed = macro.buildEntrySpecialDays(undefined, "2026-09-18T13:30:45Z");
  const reviewedHtml = renderBanner("2026-09-18T13:30:45Z", reviewed, reviewed);
  for (const text of ["季度集中到期日", "06:15", "06:30", "07:00", "Bowman", "LEI", "加州时间"]) assert.ok(reviewedHtml.includes(text), text);
  const chart = await readFile(new URL("../app/ApprovedBrokerChartPrototype.tsx", import.meta.url), "utf8");
  assert.equal((page.match(/<MacroEventNotice /g) ?? []).length, 1);
  assert.equal((chart.match(/<MacroEventNotice /g) ?? []).length, 1);
  assert.ok(page.indexOf("<MacroEventNotice ") < page.indexOf('<section className="panel" id="today-paper">'), "home event risk comes before simulated cards");
  assert.ok(chart.indexOf("<MacroEventNotice ") < chart.indexOf('<section className="owner-trigger-card" aria-label="当前预测状态">'), "actual market page shows event risk before the forecast");
  assert.match(page, /<MacroEventNotice overview=\{importState.macroEventLearning\} at=\{currentTime\}/);
  assert.match(chart, /<MacroEventNotice overview=\{snapshot\?\.macroEventLearning\} at=\{clockNow\}/);
  assert.equal((page.match(/<PaperPlans overview=\{researchPaper.overview\}/g) ?? []).length, 1);
  const homeOverview = page.match(/\{page === "home" && <section className="today-overview" id="cockpit">([\s\S]*?)\n {8}<\/section>\}/)?.[1];
  assert.ok(homeOverview, "the overview must remain gated to the home page");
  assert.match(homeOverview, /<PaperPlans overview=\{importState.paperPlans\} currentTime=\{currentTime\} todayOnly/);
  assert.equal((page.match(/<PaperPlans overview=\{importState.paperPlans\}/g) ?? []).length, 1, "today's cards must not also appear outside the home overview");
  assert.match(page, /id="research-paper"/);
  assert.match(page, /href="\/settlements#research-paper"/);
  assert.match(page, /void fetchActiveSnapshot\("home"\)/);
  assert.match(page, /模拟单更新失败；若下方有记录，为上次读取内容，不是最新状态/);
  assert.match(page, /researchPaper\.error[^\n]*: null\}<PaperPlans/, "a failed refresh must retain the paper records with a stale warning");
});
