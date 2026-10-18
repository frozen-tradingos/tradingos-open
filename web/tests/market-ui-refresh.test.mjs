import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/ApprovedBrokerChartPrototype.tsx", import.meta.url), "utf8");

function refreshFor(type, bindings) {
  const declaration = source.split("\n").find((line) => line.includes(`readJson<${type}>`) && line.includes("const refresh ="));
  assert.ok(declaration);
  const { outputText } = ts.transpileModule(`${declaration}; return refresh;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  return new Function(...Object.keys(bindings), `let active = true, refreshing = false; const controller = new AbortController(); ${outputText}`)(...Object.values(bindings));
}

test("market refresh failures retain matching data and keep the snapshot clock moving", async () => {
  let snapshot, snapshotError, clock = 0, fail = false;
  const frozen = { forecast: "original-evidence" };
  const snapshotRefresh = refreshFor("SnapshotState", {
    readJson: async () => { if (fail) throw new Error("offline"); return frozen; },
    requestMessage: (error) => error.message,
    setSnapshot: (value) => { snapshot = value; },
    setSnapshotError: (value) => { snapshotError = value; },
    setClockNow: (value) => { clock = value; },
  });
  await snapshotRefresh();
  fail = true; clock = 0;
  await snapshotRefresh();
  assert.equal(snapshot, frozen);
  assert.equal(snapshotError, "offline");
  assert.ok(clock > 0, "expiry checks must not stop when snapshot refresh fails");

  let data = {}, errors = {};
  const key = "SPY:5m:24h", chart = { bars: [{ close: 100 }] };
  const chartRefresh = refreshFor("ChartResponse", {
    key, symbol: "SPY", interval: "5m", range: "24h",
    readJson: async () => { if (fail) throw new Error("offline"); return chart; },
    requestMessage: (error) => error.message,
    setDataByKey: (update) => { data = update(data); },
    setErrorsByKey: (update) => { errors = update(errors); },
  });
  fail = false; await chartRefresh();
  fail = true; await chartRefresh();
  assert.equal(data[key], chart);
  assert.equal(data["QQQ:5m:24h"], undefined);
  assert.equal(errors[key], "offline");
  fail = false; await chartRefresh();
  assert.equal(errors[key], undefined);
});

test("long market evidence uses sheets while refresh and trading risks remain visible", () => {
  for (const title of ["预测与数据证据", "触发条件与依据", "合约与观察证据"]) assert.ok(source.includes(`<DetailSheet title="${title}"`));
  assert.match(source, /snapshotError && <p[^>]*role="status"[^>]*>[\s\S]*?请勿据此确认当前交易条件/);
  assert.match(source, /<p className="owner-market-note">\{triggerRisk\}<\/p>\s*<DetailSheet/);
  assert.match(source, /继续显示截至[\s\S]*?的最近成功数据/);
  assert.doesNotMatch(source, /<details className="mobile-touch-help" open/);
});

test("empty and expired forecasts keep history reachable without empty counts or invented paths", async () => {
  const [React, { renderToStaticMarkup }, { buildTsForecastDisplay }] = await Promise.all([import("react"), import("react-dom/server"), import("../app/ts-forecast-state.ts")]);
  const rail = source.match(/<aside className="decision-rail"[\s\S]*?<\/aside>/)?.[0];
  const footer = source.match(/<footer className="chart-foot"[\s\S]*?<\/footer>/)?.[0];
  assert.ok(rail && footer);
  const { outputText } = ts.transpileModule(`export function View(props) { const { ts, forecastDisplay, model } = props; return <>${rail}${footer}</>; }`, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  const bindings = {
    React, forecastTypeLabel: "原预测", direction: "偏涨", qualification: "等待条件", qualificationReason: "原始风险条件：等待确认",
    evidenceContract: { required_total: 2, required_available: 1, enhancement_total: 0, enhancement_available: 0, next_rth: null },
    snapshotError: null, contextNote: "当前尚未形成可绑定的自然预测。", pathNames: ["main", "reverse", "extreme"], pathLabels: { main: "主路径", reverse: "反向路径", extreme: "极端路径" },
    pathProbability: () => 60, pathEnd: () => 100, fmtPrice: new Intl.NumberFormat("en-US"), nextCheck: "原定检查时间", levelText: () => "原始点位", ownerMarketText: "行情数据有缺口", vwap: null,
  };
  new Function("exports", ...Object.keys(bindings), outputText)(exports, ...Object.values(bindings));
  const render = (value, at) => renderToStaticMarkup(React.createElement(exports.View, { ts: value, forecastDisplay: buildTsForecastDisplay(value, "CURRENT_LIVE", at), model: { paths: value ? [{}] : [] } }));
  const empty = render(null, "2026-10-01T14:00:00Z");
  assert.match(empty, /本时段尚无正式预测/);
  assert.match(empty, /href="\/settlements#decision-review"/);
  assert.match(empty, /class="path-picker" hidden=""/);
  assert.doesNotMatch(empty, /0\/0|Forecast Layer|Trade Qualification Layer|<i class="main"/);
  const original = { one_line_forecast: "原始预测内容", current_pattern: { summary: "原始行情判断" }, symbol_outlooks: { SPY: { summary: "原始标的判断" } }, forecast_window: { start_at: "2026-10-01T13:30:00Z", end_at: "2026-10-01T14:00:00Z" }, next_validation: { at: "2026-10-01T13:45:00Z" } };
  // Render the original forecast after its deadline; display validity must not rewrite its content or risk.
  bindings.symbol = "SPY";
  new Function("exports", ...Object.keys(bindings), outputText)(exports, ...Object.values(bindings));
  const frozen = structuredClone(original), expired = render(original, "2026-10-01T14:01:00Z");
  assert.match(expired, /原预测已过期，仅供复盘/);
  for (const text of ["原始预测内容", "原始行情判断", "原始标的判断", "原始风险条件：等待确认"]) assert.ok(expired.includes(text));
  assert.doesNotMatch(expired, /未来判断：|增强 0\/0/);
  assert.deepEqual(original, frozen);
});

test("research entry and source times remain visible when no current forecast exists", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const summary = source.match(/<section className="owner-trigger-card" aria-label="当前预测状态">[\s\S]*?<\/section>/)?.[0];
  assert.ok(summary);
  assert.match(summary, /href="\/settlements#prediction-research"/);
  assert.match(summary, /行情截至[\s\S]*?预测发布[\s\S]*?记录时间/);
  assert.match(summary, /slotStatusText\[currentTruth.natural_slot.status\]/);
  assert.doesNotMatch(summary, /模型.*生成中/);
  assert.match(page, /id="prediction-research"[\s\S]*?尚未读取到增强研究记录/);
  assert.ok(page.indexOf('id="prediction-research"') < page.indexOf('<DetailSheet title="预测统计口径与技术证据"'), "research must be reachable outside the closed statistics dialog");
  for (const name of ["ApprovedBrokerChartPrototype.tsx", "page.tsx"]) {
    const bytes = await readFile(new URL(`../app/${name}`, import.meta.url));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert.equal(text.includes("\uFFFD"), false, `${name} must contain valid Chinese source, not replacement characters`);
  }
});

test("a chart without forecast paths does not reserve empty future space", () => {
  const body = source.slice(source.indexOf("  const applyRatio ="), source.indexOf("  const setPriceLines ="));
  const { outputText } = ts.transpileModule(`${body}; return applyRatio;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  for (const paths of [[], [{}]]) {
    const views = [], chart = { timeScale: () => ({ fitContent: () => views.push("history"), setVisibleLogicalRange: () => views.push("forecast") }) };
    const apply = new Function("chart", "model", `${outputText}`.replace("const applyRatio", "let historyRatio, manualView; const find = () => ({}), root = {querySelectorAll: () => []}, visibleHistory = () => 10, scheduleOverlay = () => {}, setQuery = () => {}; const applyRatio"))(chart, { anchorIndex: 20, paths });
    apply(60);
    assert.deepEqual(views, paths.length ? ["forecast"] : ["history"]);
  }
});
