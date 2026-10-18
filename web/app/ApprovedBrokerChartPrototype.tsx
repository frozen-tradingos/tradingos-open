"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's deployed Owner router requires native navigation. */

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { IChartApi, IPriceLine, Logical, Time, UTCTimestamp } from "lightweight-charts";
import { forecastFanGeometry, sessionVwapSeries, tsChartOverlay, type ChartBar, type ChartPoint, type TsChartPath } from "./market-chart";
import { formatEtDateTime, formatPtDateTime, nyseClosePtMinutes } from "./market-time";
import type { SnapshotState, SpxOptionContract, SpxOptionQuote, TsOutput } from "./snapshot-import";
import { buildTsEvidenceContract, buildTsForecastDisplay, conditionText, contractConditions, resolveTsForecastContext } from "./ts-forecast-state";
import { buildCurrentTruth } from "./current-truth";
import { classifyOwnerMarketHealth } from "./owner-market-health";
import { spxOwnerObservationLifecycle, spxWatchLifecycle } from "./spx-observation-lifecycle";
import { clientRequestId } from "./client-request-id";
import { NextSessionObservationCard } from "./NextSessionObservationCard";
import { DetailSheet } from "./DetailSheet";
import { MacroEventNotice } from "./MacroEventNotice";

type SymbolName = "SPY" | "QQQ";
type IntervalName = "1m" | "5m" | "15m";
type RangeName = "1d" | "24h" | "rth" | "gth" | "5d";
type PathName = "main" | "reverse" | "extreme";
type MarketStatus = "LIVE" | "MARKET_CLOSED" | "STALE" | "DATA_BLOCKED";
type SpxOptionChain = { chain_id: string; chain_symbol: "SPX" | "SPXW"; settlement: "AM" | "PM"; expiration_dates: string[] };
type ChartResponse = {
  source: "ROBINHOOD";
  symbol: SymbolName;
  interval: IntervalName;
  range: RangeName;
  session_bounds: "OFFICIAL_24_5" | "REGULAR_ONLY_EOD_FALLBACK" | "NOT_OBSERVED";
  session_dates: string[];
  status: MarketStatus;
  as_of: string | null;
  freshness_seconds: number | null;
  quote_as_of: string | null;
  quote_freshness_seconds: number | null;
  bar_as_of: string | null;
  bar_freshness_seconds: number | null;
  gap_status: "SOURCE_GAP" | null;
  market_session: { state: "REGULAR" | "CLOSED"; phase?: "PREMARKET" | "REGULAR" | "AFTER_HOURS" | "OVERNIGHT" | "CLOSED"; timezone: "America/New_York"; observed_at: string; market_date: string; trading_date?: string; source: string };
  current_price: number | null;
  bars: ChartBar[];
  error: string | null;
};
type ProxyActionResponse = SnapshotState["spxwProxy"] & { action_id: string; action_status: "SUCCEEDED"; duplicate: boolean; observation_id?: string };
type ContractReadStatus = "CONTRACT_NOT_FOUND" | "CONTRACT_FOUND_QUOTE_LIVE" | "CONTRACT_FOUND_QUOTE_STALE" | "CONTRACT_FOUND_NO_TWO_SIDED_QUOTE" | "PROVIDER_GTH_UNAVAILABLE" | "TIMED_OUT" | "SOURCE_UNAVAILABLE";
type ContractReadResponse = { action_id: string; action_status: "SUCCEEDED" | "FAILED"; status: ContractReadStatus; source: "ROBINHOOD_OFFICIAL_READONLY"; quoted_at: string | null; source_session: string | null; observed_session: string | null; contracts: Array<{ contract: SpxOptionContract; quote: SpxOptionQuote }>; message?: string; error?: string };
type ContractReadReceipt = { action_id: string; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT"; requested_at: string; started_at: string | null; completed_at: string | null; result: Omit<ContractReadResponse, "action_id"> | null; error: string | null };
type ChartModel = {
  symbol: SymbolName;
  range: RangeName;
  bars: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number }>;
  vwap: ChartPoint[];
  paths: TsChartPath[];
  fan: ReturnType<typeof forecastFanGeometry>;
  levels: ReturnType<typeof tsChartOverlay>["levels"];
  anchorIndex: number;
  ts: TsOutput | null;
};
type ChartController = { update: (model: ChartModel, dataKey: string) => void; destroy: () => void };

const pathNames: PathName[] = ["main", "reverse", "extreme"];
const ownerNav = [["/", "今日总览"], ["/forecast", "TS看盘"], ["/options", "策略与持仓"], ["/company", "公司运行"], ["/health", "系统管控"], ["/settlements", "预测复盘"], ["/issues", "投诉与缺失"]] as const;
const pathLabels = { main: "主路径", reverse: "反向路径", extreme: "极端路径" } as const;
const directions = { BULLISH: "偏涨", BEARISH: "偏跌", RANGE: "震荡" } as const;
const evidenceRoleText = { REQUIRED: "必需", CONDITIONAL: "条件性", ENHANCEMENT: "增强" } as const;
const evidenceStateText = { LIVE: "可用", STALE: "已过期", MISSING: "缺失", NOT_STARTED: "尚未开始", DATA_BLOCKED: "读取受阻" } as const;
const qualificationText = { WAIT: "等待条件", CONDITIONAL: "条件满足后再复核", READY_FOR_D_REVIEW: "可交复核，不是交易批准" } as const;
const slotStatusText: Record<string, string> = { NOT_OBSERVED: "尚无运行记录", BLOCKED: "检查受阻，未能完成", RUNNING: "本次检查未结束", SUCCEEDED: "检查完成", FAILED: "检查失败", DATA_BLOCKED: "证据不足，未能完成", TIMED_OUT: "检查超时", MISSED: "错过计划时间", SKIPPED: "本次已跳过", PARTIAL: "仅部分完成" };
const contractReadText: Record<ContractReadStatus, string> = {
  CONTRACT_NOT_FOUND: "未找到精确合约", CONTRACT_FOUND_QUOTE_LIVE: "合约与双边报价均可用", CONTRACT_FOUND_QUOTE_STALE: "合约已找到，报价已过期", CONTRACT_FOUND_NO_TWO_SIDED_QUOTE: "合约已找到，缺少双边报价", PROVIDER_GTH_UNAVAILABLE: "合约已找到，Provider未返回GTH报价", TIMED_OUT: "只读报价请求超时", SOURCE_UNAVAILABLE: "只读报价源不可用",
};
const statusText: Record<MarketStatus | "NOT_OBSERVED", string> = {
  LIVE: "实时行情",
  MARKET_CLOSED: "市场已收盘 · EOD",
  STALE: "数据已过期",
  DATA_BLOCKED: "数据受阻",
  NOT_OBSERVED: "未观察到",
};
const triggerStateText = { DIRECTION_WATCH: "方向观察", PRESSURE_TEST: "压测关键位", TRIGGER_CONFIRMING: "触发确认中", PATH_ACTIVATED: "路径已激活", CHASE_RISK_HIGH: "追单风险高", PATH_INVALIDATED: "路径已失效" } as const;
const triggerActionText = { OBSERVE: "继续观察", WAIT: "继续WAIT", CONSIDER_BY_RULE: "按既定规则考虑", DO_NOT_CHASE: "存在方向偏向，但交易条件不足", CANCEL_SCENARIO: "当前情景已失效" } as const;
const forecastModeText = { CURRENT_LIVE: "当前自然LIVE预测", NEXT_SESSION: "次日初步预测", HISTORICAL: "指定历史预测", NONE: "尚未形成自然预测", MISSING: "预测数据一致性错误" } as const;
const spxSessionText = { RTH: "RTH常规时段", CURB: "CURB收盘延长时段", GTH: "GTH夜盘", CLOSED: "休市" } as const;
const optionStateText: Record<string, string> = { NO_CONTRACT_SELECTED: "尚未选择观测合约", QUOTE_PENDING: "等待第一笔报价", LIVE: "报价正常", STALE: "报价已过期", DATA_BLOCKED: "期权报价读取受阻", CONTRACT_EXPIRED: "合约已到期", WATCH_ENDED: "已结束观察", MARKET_CLOSED: "最近有效报价" };
const regimeStateText: Record<string, string> = { DATA_BLOCKED: "数据阻断", OPENING_UNCERTAINTY: "开盘证据积累", RANGE: "震荡", TREND_CANDIDATE: "趋势候选", TREND_CONFIRMED: "趋势已确认", PULLBACK_VALIDATING: "回踩验证中", TREND_CONTINUATION: "趋势延续", TREND_EXHAUSTED: "趋势衰竭", RANGE_REENTRY: "重新进入震荡" };
const participationText: Record<string, string> = { DATA_BLOCKED: "等待数据恢复", NOT_ELIGIBLE: "尚无参与资格", WAIT_FOR_CONFIRMATION: "等待确认", WINDOW_OPEN: "仍有结构观察空间", WAIT_FOR_PULLBACK: "等待回踩，不追单", CHASE_RISK_HIGH: "已经走远，不追单", WINDOW_CLOSED: "参与窗口已关闭" };
const convexityStateText: Record<string, string> = { PATH_CANDIDATE: "方向候选，尚未确认", PATH_CONFIRMED: "路径已确认", WAIT_FOR_PULLBACK: "等待回踩", WINDOW_OPEN: "参与窗口仍开放", WINDOW_CLOSED: "参与窗口已关闭", PATH_INVALIDATED: "路径已失效" };
const capitalFitText: Record<string, string> = { LOW_COST_REVIEW: "低价合约待审查", NORMAL_FIT: "符合常规本金范围", STRONG_OPPORTUNITY_ONLY: "仅符合强机会范围", OWNER_LIMIT_EXCEEDED: "超过Owner单张规则", CAPITAL_CONCENTRATED: "本金集中风险", UNAFFORDABLE: "当前本金不可负担", DATA_BLOCKED: "成本证据不足" };
const convexityReasonText: Record<string, string> = { DATA_BLOCKED: "关键数据不足", QUOTE_STALE: "报价过期", SPREAD_TOO_WIDE: "Bid/Ask点差过宽", NO_QUALIFIED_CONTRACT: "没有合格冻结合约", OWNER_CAPITAL_UNFIT: "不符合Owner本金规则", OWNER_RISK_LIMIT_UNCONFIGURED: "保留现金/日损/组合风险尚未配置", PATH_NOT_CONFIRMED: "路径尚未确认", LATE_SYSTEM_CONFIRMATION: "系统确认过晚", PARTICIPATION_WINDOW_CLOSED: "参与窗口已关闭", CHASE_RISK_HIGH: "路径已走远，不追", PATH_INVALIDATED: "路径已失效", OWNER_DID_NOT_EXECUTE: "Owner未执行", OWNER_TRAVEL_NETWORK_CONSTRAINT: "旅游网络条件限制", RESEARCH_ONLY: "仅作隔离研究" };
const intervalText = { "1m": "1分钟", "5m": "5分钟", "15m": "15分钟" } as const;
const rangeText = { "1d": "当前交易日", "24h": "最近24小时", rth: "最近RTH", gth: "盘后/GTH", "5d": "近5个交易日" } as const;
const chartSessionText = { PREMARKET: "盘前", REGULAR: "RTH", AFTER_HOURS: "盘后", OVERNIGHT: "GTH" } as const;
const levelColors = { support: "#78a957", resistance: "#c66d63", invalidation: "#d9955b", target: "#70a8d8" } as const;
const fmtPrice = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtVolume = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function finiteBars(data: ChartResponse | null) {
  return (data?.bars ?? []).flatMap((bar) => {
    const time = Date.parse(bar.begins_at) / 1_000;
    return Number.isFinite(time) && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
      ? [{ time: time as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume ?? 0 }]
      : [];
  }).toSorted((a, b) => Number(a.time) - Number(b.time));
}

function chartModel(data: ChartResponse | null, ts: TsOutput | null, symbol: SymbolName, range: RangeName): ChartModel {
  const bars = finiteBars(data);
  const issuedAt = ts ? Date.parse(ts.forecast_window.start_at || ts.evidence_snapshot.market_time.observed_at) / 1_000 : NaN;
  const anchorIndex = bars.length ? Math.max(0, bars.findLastIndex((bar) => !Number.isFinite(issuedAt) || Number(bar.time) <= issuedAt)) : -1;
  const anchorBar = anchorIndex >= 0 ? bars[anchorIndex] : null;
  const overlay = tsChartOverlay(ts, symbol, anchorBar ? { time: Number(anchorBar.time), value: anchorBar.close } : undefined);
  return { symbol, range, bars, vwap: sessionVwapSeries(data?.bars ?? []), paths: overlay.paths, fan: forecastFanGeometry(overlay.paths), levels: overlay.levels, anchorIndex, ts };
}

function polygonPath(upper: Array<{ x: number; y: number }>, lower: Array<{ x: number; y: number }>) {
  if (upper.length < 2 || lower.length < 2) return "";
  return `M ${upper.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L ")} L ${lower.toReversed().map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L ")} Z`;
}

function straightPath(points: Array<{ x: number; y: number }>) {
  return points.length < 2 ? "" : `M ${points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L ")}`;
}

async function mountChart(root: HTMLElement): Promise<ChartController> {
  const { CandlestickSeries, HistogramSeries, LineSeries, LineStyle, createChart } = await import("lightweight-charts");
  const find = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const stage = find<HTMLElement>(".chart-stage"), ohlc = find<HTMLElement>("#ohlc"), overlay = find<SVGSVGElement>("#ts-overlay");
  const chart = createChart(find<HTMLElement>("#chart-host"), {
    autoSize: true,
    layout: { background: { color: "#090e12" }, textColor: "#9cabb3", fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, attributionLogo: true },
    grid: { vertLines: { color: "#1d282e" }, horzLines: { color: "#1d282e" } },
    rightPriceScale: { borderColor: "#33414a", scaleMargins: { top: .1, bottom: .22 } },
    timeScale: { borderColor: "#33414a", timeVisible: true, secondsVisible: false },
    localization: { priceFormatter: (price: number) => price.toFixed(2), timeFormatter: (time: Time) => typeof time === "number" ? formatEtDateTime(time * 1_000) : String(time) },
    crosshair: { vertLine: { color: "#687985" }, horzLine: { color: "#687985" } },
    handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true }, mouseWheel: true, pinch: true },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    kineticScroll: { mouse: true, touch: false },
  });
  const candles = chart.addSeries(CandlestickSeries, { upColor: "#78a957", downColor: "#c66d63", borderVisible: false, wickUpColor: "#90bd70", wickDownColor: "#d18178", priceLineVisible: true, lastValueVisible: true });
  const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false }, 1);
  chart.priceScale("volume").applyOptions({ scaleMargins: { top: .8, bottom: 0 } });
  const vwap = chart.addSeries(LineSeries, { color: "#e1b96a", lineWidth: 2, title: "VWAP", priceLineVisible: false, lastValueVisible: true });
  chart.panes()[1]?.setHeight(92);

  const abort = new AbortController();
  const url = new URL(location.href);
  let model: ChartModel = chartModel(null, null, "SPY", "1d"), currentKey = "", historyRatio = Number(url.searchParams.get("split") ?? 60), tsEnabled = url.searchParams.get("ts") !== "0", forecastFocus = false, requestedForecastFocus = url.searchParams.get("mode") === "forecast", selectedPath = (url.searchParams.get("path") ?? "main") as PathName, manualView = false, redrawFrame = 0;
  let savedView: { logical: ReturnType<IChartApi["timeScale"]>["getVisibleLogicalRange"] extends () => infer T ? T : never; price: ReturnType<IChartApi["priceScale"]>["getVisibleRange"] extends () => infer T ? T : never } | null = null;
  let priceLines: IPriceLine[] = [], splitDrag: { startX: number; startRatio: number } | null = null;
  if (!pathNames.includes(selectedPath)) selectedPath = "main";
  const setQuery = (name: string, value: string | number) => { const next = new URL(location.href); next.searchParams.set(name, String(value)); history.replaceState(null, "", next); };

  const latestOhlc = (bar = model.bars.at(-1)) => {
    ohlc.replaceChildren();
    const values = bar ? [model.symbol, `开 ${fmtPrice.format(bar.open)}`, `高 ${fmtPrice.format(bar.high)}`, `低 ${fmtPrice.format(bar.low)}`, `收 ${fmtPrice.format(bar.close)}`, `量 ${fmtVolume.format(bar.volume)}`] : [model.symbol, "开 —", "高 —", "低 —", "收 —", "量 —"];
    values.forEach((value, index) => { const node = document.createElement(index ? "span" : "b"); node.textContent = value; ohlc.append(node); });
  };
  const scheduleOverlay = () => { if (!redrawFrame) redrawFrame = requestAnimationFrame(drawOverlay); };
  const visibleHistory = () => model.range === "5d" ? Math.max(1, model.anchorIndex + 1) : Math.min(42, Math.max(1, model.anchorIndex + 1));
  const applyRatio = (value: number | string, updateUrl = true) => {
    historyRatio = Math.round(Math.max(50, Math.min(70, Number(value))));
    const slider = find<HTMLInputElement>("#ratio-slider"), output = find<HTMLOutputElement>("#ratio-output");
    slider.value = String(historyRatio); output.textContent = `历史${historyRatio}% · 预测${100 - historyRatio}%`;
    root.querySelectorAll<HTMLButtonElement>("[data-ratio]").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.ratio) === historyRatio)));
    if (model.anchorIndex >= 0 && model.paths.length) {
      const history = visibleHistory(), future = history * (100 - historyRatio) / historyRatio;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(-.5, model.anchorIndex - history + 1), to: model.anchorIndex + future });
    } else chart.timeScale().fitContent();
    manualView = false;
    find("#realtime").textContent = "回到实时";
    if (updateUrl) setQuery("split", historyRatio);
    scheduleOverlay();
  };
  const setPriceLines = () => {
    priceLines.forEach((line) => candles.removePriceLine(line));
    const compactPortrait = matchMedia("(max-width: 700px) and (orientation: portrait)").matches;
    priceLines = tsEnabled ? model.levels.map((level) => candles.createPriceLine({ price: level.value, title: level.label, color: levelColors[level.kind], lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: !compactPortrait })) : [];
  };

  function drawOverlay() {
    redrawFrame = 0;
    const width = stage.clientWidth, height = stage.clientHeight;
    overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const logicalRange = chart.timeScale().getVisibleLogicalRange(), priceRange = chart.priceScale("right").getVisibleRange();
    stage.dataset.visibleBars = logicalRange ? String(Math.round(logicalRange.to - logicalRange.from)) : "";
    stage.dataset.priceSpan = priceRange ? (priceRange.to - priceRange.from).toFixed(4) : "";
    find<HTMLElement>("#path-labels").replaceChildren();
    if (!tsEnabled || !model.fan.anchor || model.anchorIndex < 0) return;
    const anchorX = chart.timeScale().logicalToCoordinate(model.anchorIndex as Logical), anchorY = candles.priceToCoordinate(model.fan.anchor.value);
    if (anchorX === null || anchorY === null) return;
    const allTimes = model.paths.flatMap((path) => path.nodes.map((node) => node.time));
    const closeTime = Math.max(...allTimes, model.fan.anchor.time + 1), plotRight = width - Math.max(68, chart.priceScale("right").width()) - 10, usable = Math.max(150, plotRight - anchorX);
    const xAt = (time: number) => anchorX + (time - model.fan.anchor!.time) / Math.max(1, closeTime - model.fan.anchor!.time) * usable;
    const project = (point: ChartPoint) => { const y = candles.priceToCoordinate(point.value); return y === null ? null : { x: xAt(point.time), y }; };
    const points = (values: ChartPoint[]): Array<{ x: number; y: number }> => values.flatMap((point) => { const projected = project(point); return projected ? [{ x: projected.x, y: Number(projected.y) }] : []; });
    const upper = points(model.fan.sharedUpper), lower = points(model.fan.sharedLower), trunk = points(model.fan.trunk);
    find<SVGPathElement>("#forecast-zone").setAttribute("d", `M ${anchorX} 0 L ${plotRight} 0 L ${plotRight} ${height - 112} L ${anchorX} ${height - 112} Z`);
    find<SVGPathElement>("#shared-fan").setAttribute("d", polygonPath(upper, lower));
    find<SVGPathElement>("#shared-trunk").setAttribute("d", trunk.length > 1 ? `M ${trunk[0].x.toFixed(1)} ${trunk[0].y.toFixed(1)} L ${trunk[1].x.toFixed(1)} ${trunk[1].y.toFixed(1)}` : "");
    find<SVGPathElement>("#now-line").setAttribute("d", `M ${anchorX.toFixed(1)} 0 L ${anchorX.toFixed(1)} ${(height - 112).toFixed(1)}`);
    find<HTMLElement>("#now-label").style.left = `${anchorX}px`; find<HTMLElement>("#split-handle").style.left = `${anchorX}px`;

    const nodes = [...new Map(model.paths.flatMap((path) => path.nodes).map((node) => [node.time, node])).values()].toSorted((a, b) => a.time - b.time);
    find<SVGGElement>("#time-nodes").replaceChildren(...nodes.map((node) => {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g"), x = xAt(node.time), line = document.createElementNS("http://www.w3.org/2000/svg", "line"), text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      line.setAttribute("class", "node-line"); line.setAttribute("x1", String(x)); line.setAttribute("x2", String(x)); line.setAttribute("y1", "28"); line.setAttribute("y2", String(height - 112));
      text.setAttribute("class", "node-text"); text.setAttribute("x", String(x)); text.setAttribute("y", "22"); text.setAttribute("text-anchor", "middle"); text.textContent = node.label;
      group.append(line, text); return group;
    }));

    const pathPoints: Record<PathName, Array<{ x: number; y: number }>> = {
      main: points(model.fan.displayPaths.main),
      reverse: points(model.fan.displayPaths.reverse),
      extreme: points(model.fan.displayPaths.extreme),
    };
    pathNames.forEach((name) => {
      const group = find<SVGGElement>(`.scenario[data-path="${name}"]`), values = pathPoints[name];
      group.querySelector(".scenario-line")?.setAttribute("d", straightPath(values));
      const host = group.querySelector<SVGGElement>(".scenario-nodes")!;
      host.replaceChildren(...values.slice(1).map((point) => { const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle"); circle.setAttribute("cx", String(point.x)); circle.setAttribute("cy", String(point.y)); circle.setAttribute("r", name === "main" ? "4" : "3"); return circle; }));
    });
    const labels = pathNames.flatMap((name) => { const point = pathPoints[name].at(-1); return point ? [{ name, point, desired: point.y, y: 0 }] : []; }).toSorted((a, b) => a.desired - b.desired);
    const minY = height < 360 ? 48 : 62, maxY = height - (height < 360 ? 50 : 160), gap = height < 360 ? 40 : 48;
    labels.forEach((item, index) => { item.y = Math.max(minY, index ? Math.max(item.desired - 20, labels[index - 1].y + gap) : item.desired - 20); });
    const overflow = Math.max(0, (labels.at(-1)?.y ?? 0) - maxY); labels.forEach((item) => { item.y = Math.max(minY, item.y - overflow); });
    const laneX = Math.max(anchorX + 70, plotRight - 150), labelHost = find<HTMLDivElement>("#path-labels"), leaders = find<SVGGElement>("#path-leaders");
    labelHost.replaceChildren(...labels.map((item) => { const label = document.createElement("span"), title = document.createElement("b"), value = document.createElement("span"), probability = model.ts?.scenarios[item.name].probability_pct; label.className = "path-label"; label.dataset.path = item.name; label.style.left = `${laneX}px`; label.style.top = `${item.y}px`; title.textContent = `${pathLabels[item.name]} 未校准 ${probability ?? "—"}%`; value.textContent = fmtPrice.format(model.fan.displayPaths[item.name].at(-1)!.value); label.append(title, value); return label; }));
    leaders.replaceChildren(...labels.map((item) => { const leader = document.createElementNS("http://www.w3.org/2000/svg", "path"); leader.classList.add("label-leader"); leader.dataset.path = item.name; leader.setAttribute("d", `M ${item.point.x.toFixed(1)} ${item.point.y.toFixed(1)} L ${(laneX - 8).toFixed(1)} ${(item.y + 21).toFixed(1)}`); return leader; }));
  }

  const setTs = (enabled: boolean, updateUrl = true) => {
    tsEnabled = enabled; root.dataset.ts = enabled ? "on" : "off"; find("#ts-toggle").setAttribute("aria-pressed", String(enabled)); find("#base-mode").setAttribute("aria-pressed", String(!enabled));
    find("#chart-title").textContent = enabled ? "基础行情与 TS 图层" : "基础券商K线"; setPriceLines();
    if (enabled) applyRatio(historyRatio, false); else { forecastFocus = false; root.dataset.mode = "ratio"; find("#forecast-mode").setAttribute("aria-pressed", "false"); chart.priceScale("right").setAutoScale(true); chart.timeScale().fitContent(); }
    if (updateUrl) setQuery("ts", enabled ? 1 : 0);
    scheduleOverlay();
  };
  const setForecastFocus = (enabled: boolean) => {
    if (!tsEnabled) setTs(true);
    forecastFocus = enabled && Boolean(model.fan.priceExtent); find("#forecast-mode").setAttribute("aria-pressed", String(forecastFocus)); root.dataset.mode = forecastFocus ? "forecast" : "ratio";
    if (forecastFocus && model.fan.priceExtent) {
      savedView = { logical: chart.timeScale().getVisibleLogicalRange(), price: chart.priceScale("right").getVisibleRange() };
      chart.priceScale("right").setVisibleRange({ from: model.fan.priceExtent.low, to: model.fan.priceExtent.high });
      const history = Math.min(16, Math.max(1, model.anchorIndex + 1)); chart.timeScale().setVisibleLogicalRange({ from: model.anchorIndex - history, to: model.anchorIndex + 30 });
      find("#mode-banner").textContent = "预测专注视图 · 主图聚焦未来真实范围 · 价格未改变";
    } else {
      if (savedView?.logical) chart.timeScale().setVisibleLogicalRange(savedView.logical); else applyRatio(historyRatio, false);
      if (savedView?.price) chart.priceScale("right").setVisibleRange(savedView.price); else chart.priceScale("right").setAutoScale(true);
      find("#mode-banner").textContent = model.ts ? "真实比例模式 · 历史与预测共用真实价格轴" : "当前没有正式预测曲线，先显示已取得的真实行情";
    }
    setQuery("mode", forecastFocus ? "forecast" : "ratio"); scheduleOverlay();
  };
  const resetView = () => { chart.priceScale("right").setAutoScale(true); if (tsEnabled) applyRatio(historyRatio, false); else chart.timeScale().fitContent(); manualView = false; find("#realtime").textContent = "回到实时"; };
  const lockView = () => { manualView = true; find("#realtime").textContent = "回到实时 · 视野已锁定"; };
  const setInteractionMode = () => {
    const focus = root.dataset.focus === "true", immersive = focus || document.fullscreenElement === find<HTMLElement>(".terminal-card");
    root.dataset.immersive = String(immersive);
    document.documentElement.toggleAttribute("data-chart-focus", focus);
    chart.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: immersive } });
  };

  chart.subscribeCrosshairMove((parameter) => {
    const bar = parameter.seriesData.get(candles), point = parameter.seriesData.get(volume);
    if (bar && "open" in bar) latestOhlc({ time: (parameter.time ?? bar.time) as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: point && "value" in point ? point.value : 0 });
    else latestOhlc();
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleOverlay);
  const observer = new ResizeObserver(scheduleOverlay); observer.observe(stage);
  stage.addEventListener("pointerdown", lockView, { passive: true, signal: abort.signal }); stage.addEventListener("wheel", () => { lockView(); scheduleOverlay(); }, { passive: true, signal: abort.signal }); stage.addEventListener("pointermove", scheduleOverlay, { passive: true, signal: abort.signal });
  find("#ts-toggle").addEventListener("click", () => setTs(!tsEnabled), { signal: abort.signal }); find("#base-mode").addEventListener("click", () => setTs(false), { signal: abort.signal });
  find("#reset-view").addEventListener("click", resetView, { signal: abort.signal }); find("#realtime").addEventListener("click", resetView, { signal: abort.signal }); find("#reset-price").addEventListener("click", () => { chart.priceScale("right").setAutoScale(true); scheduleOverlay(); }, { signal: abort.signal });
  find("#forecast-mode").addEventListener("click", () => setForecastFocus(!forecastFocus), { signal: abort.signal });
  find("#rail-toggle").addEventListener("click", (event) => { const open = root.dataset.rail !== "open"; root.dataset.rail = open ? "open" : "closed"; (event.currentTarget as HTMLElement).setAttribute("aria-pressed", String(open)); scheduleOverlay(); }, { signal: abort.signal });
  find("#nav-toggle").addEventListener("click", (event) => { const open = root.dataset.nav !== "open"; root.dataset.nav = open ? "open" : "closed"; (event.currentTarget as HTMLElement).setAttribute("aria-label", open ? "收起左侧导航" : "展开左侧导航"); scheduleOverlay(); }, { signal: abort.signal });
  find("#focus-toggle").addEventListener("click", (event) => { const focus = root.dataset.focus !== "true"; root.dataset.focus = String(focus); (event.currentTarget as HTMLElement).setAttribute("aria-pressed", String(focus)); (event.currentTarget as HTMLElement).textContent = focus ? "退出专注" : "专注看盘"; setInteractionMode(); scheduleOverlay(); }, { signal: abort.signal });
  find("#fullscreen-toggle").addEventListener("click", async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await find<HTMLElement>(".terminal-card").requestFullscreen(); }, { signal: abort.signal });
  document.addEventListener("fullscreenchange", () => { find("#fullscreen-toggle").setAttribute("aria-label", document.fullscreenElement ? "退出全屏" : "进入全屏"); setInteractionMode(); scheduleOverlay(); }, { signal: abort.signal });
  find<HTMLInputElement>("#ratio-slider").addEventListener("input", (event) => applyRatio((event.currentTarget as HTMLInputElement).value), { signal: abort.signal });
  root.querySelectorAll<HTMLButtonElement>("[data-ratio]").forEach((button) => button.addEventListener("click", () => applyRatio(button.dataset.ratio ?? 60), { signal: abort.signal }));
  const splitHandle = find<HTMLElement>("#split-handle");
  splitHandle.addEventListener("pointerdown", (event) => { event.preventDefault(); splitDrag = { startX: event.clientX, startRatio: historyRatio }; }, { signal: abort.signal });
  window.addEventListener("pointermove", (event) => { if (splitDrag) applyRatio(splitDrag.startRatio + (event.clientX - splitDrag.startX) / stage.clientWidth * 100); }, { signal: abort.signal });
  window.addEventListener("pointerup", () => { splitDrag = null; }, { signal: abort.signal });
  splitHandle.addEventListener("keydown", (event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); applyRatio(historyRatio + (event.key === "ArrowLeft" ? -1 : 1)); }, { signal: abort.signal });
  root.querySelectorAll<HTMLButtonElement>("[data-select]").forEach((button) => button.addEventListener("click", () => { selectedPath = button.dataset.select as PathName; root.dataset.selected = selectedPath; root.querySelectorAll<HTMLButtonElement>("[data-select]").forEach((item) => item.setAttribute("aria-pressed", String(item === button))); setQuery("path", selectedPath); }, { signal: abort.signal }));
  root.dataset.selected = selectedPath; historyRatio = [50, 60, 70].includes(historyRatio) ? historyRatio : 60; setTs(tsEnabled, false);
  if (!requestedForecastFocus) applyRatio(historyRatio, false);

  return {
    update(next, dataKey) {
      const keyChanged = currentKey !== dataKey, barsKey = `${dataKey}:${next.bars.length}:${next.bars.at(-1)?.time ?? 0}:${next.bars.at(-1)?.close ?? 0}`, oldBarsKey = stage.dataset.barsKey;
      const logical = manualView && !keyChanged ? chart.timeScale().getVisibleLogicalRange() : null, price = manualView && !keyChanged ? chart.priceScale("right").getVisibleRange() : null;
      model = next; currentKey = dataKey; stage.dataset.barsKey = barsKey;
      if (barsKey !== oldBarsKey) {
        candles.setData(next.bars); volume.setData(next.bars.map((bar) => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "rgba(120,169,87,.48)" : "rgba(198,109,99,.48)" }))); vwap.setData(next.vwap.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })));
      }
      latestOhlc(); setPriceLines();
      if (keyChanged) { manualView = false; forecastFocus = false; root.dataset.mode = "ratio"; if (tsEnabled) applyRatio(historyRatio, false); else chart.timeScale().fitContent(); }
      else if (logical) { chart.timeScale().setVisibleLogicalRange(logical); if (price) chart.priceScale("right").setVisibleRange(price); }
      else if (!manualView && tsEnabled) applyRatio(historyRatio, false);
      find("#mode-banner").textContent = next.ts ? "真实比例模式 · 历史与预测共用真实价格轴" : "当前没有正式预测曲线，先显示已取得的真实行情";
      if (requestedForecastFocus && next.fan.priceExtent) { requestedForecastFocus = false; requestAnimationFrame(() => setForecastFocus(true)); }
      scheduleOverlay();
    },
    destroy() { abort.abort(); observer.disconnect(); document.documentElement.removeAttribute("data-chart-focus"); if (redrawFrame) cancelAnimationFrame(redrawFrame); chart.remove(); },
  };
}

function safeDate(value: string | null, zone: "PT" | "ET") {
  if (!value || !Number.isFinite(Date.parse(value))) return "未观察到";
  return zone === "PT" ? formatPtDateTime(value) : formatEtDateTime(value);
}

function contractExpiryLocal(expiration: string) {
  const minutes = nyseClosePtMinutes(expiration);
  return expiration ? `${expiration}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` : "";
}

async function readJson<T>(url: string, label: string, signal: AbortSignal) {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(url, { cache: "no-store", signal: typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal, headers: { "x-trading-os-route": location.pathname, "x-trading-os-caller": "forecast_client", "x-trading-os-blocking": "0" } });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${label}读取失败（${response.status}）`);
  return body;
}

function requestMessage(error: unknown, fallback: string) {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return error.name === "TimeoutError" ? `${fallback}超时` : null;
  if (error instanceof Error && /abort|fetch is aborted/i.test(error.message)) return null;
  return error instanceof Error && /failed to fetch|networkerror/i.test(error.message) ? `${fallback}网络请求失败` : error instanceof Error ? error.message : fallback;
}

async function writeJson<T>(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-trading-os-route": location.pathname, "x-trading-os-caller": "owner_action", "x-trading-os-blocking": "0" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `请求失败（${response.status}）`);
  return value;
}

export function ApprovedBrokerChartPrototype() {
  const rootRef = useRef<HTMLDivElement>(null), controllerRef = useRef<ChartController | null>(null);
  const [symbol, setSymbol] = useState<SymbolName>("SPY"), [interval, setIntervalName] = useState<IntervalName>("5m"), [range, setRange] = useState<RangeName>("24h");
  const [snapshot, setSnapshot] = useState<SnapshotState | null>(null), [dataByKey, setDataByKey] = useState<Record<string, ChartResponse>>({});
  const [snapshotError, setSnapshotError] = useState<string | null>(null), [errorsByKey, setErrorsByKey] = useState<Record<string, string | undefined>>({});
  const [clockNow, setClockNow] = useState(0);
  const [spxChains, setSpxChains] = useState<SpxOptionChain[]>([]), [spxChain, setSpxChain] = useState<"SPX" | "SPXW">("SPXW"), [spxExpiration, setSpxExpiration] = useState(""), [spxStrike, setSpxStrike] = useState(""), [spxType, setSpxType] = useState<"call" | "put">("put");
  const [spxMatch, setSpxMatch] = useState<{ contract: SpxOptionContract; quote: SpxOptionQuote } | null>(null), [spxWatchNote, setSpxWatchNote] = useState(""), [spxValidUntil, setSpxValidUntil] = useState(""), [spxBusy, setSpxBusy] = useState(false), [spxMessage, setSpxMessage] = useState<string | null>(null);
  const [spxAction, setSpxAction] = useState<{ action_id: string; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT"; result: string } | null>(null);
  const [spxContractActionId, setSpxContractActionId] = useState<string | null>(() => typeof window === "undefined" ? null : window.localStorage.getItem("trading-os-spx-contract-action:v1"));
  const [spxChainsLoaded, setSpxChainsLoaded] = useState(false);
  const [requestedForecastId] = useState(() => typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get("forecast_id"));

  useEffect(() => {
    let active = true; const controller = new AbortController();
    let refreshing = false;
    const refresh = async () => { if (refreshing) return; refreshing = true; if (active) setClockNow(Date.now()); try { const body = await readJson<SnapshotState>("/api/snapshot?view=forecast", "SQLite快照", controller.signal); if (active) { setSnapshot(body); setClockNow(Date.now()); setSnapshotError(null); } } catch (error) { const message = requestMessage(error, "SQLite快照更新"); if (active && message) setSnapshotError(message); } finally { refreshing = false; } };
    void refresh(); const timer = setInterval(() => void refresh(), 15_000); return () => { active = false; controller.abort(); clearInterval(timer); };
  }, []);
  useEffect(() => {
    let active = true; const controller = new AbortController(), key = `${symbol}:${interval}:${range}`;
    let refreshing = false;
    const refresh = async () => { if (refreshing) return; refreshing = true; try { const body = await readJson<ChartResponse>(`/api/market-chart?symbol=${symbol}&interval=${interval}&range=${range}`, "Robinhood行情", controller.signal); if (active) { setDataByKey((current) => ({ ...current, [key]: body })); setErrorsByKey((current) => ({ ...current, [key]: undefined })); } } catch (error) { const message = requestMessage(error, "Robinhood行情更新"); if (active && message) setErrorsByKey((current) => ({ ...current, [key]: message })); } finally { refreshing = false; } };
    void refresh(); const timer = setInterval(() => void refresh(), 60_000); return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [symbol, interval, range]);
  useEffect(() => {
    if (!spxContractActionId) return;
    let active = true, timer = 0;
    const refresh = async () => {
      const receipt = await readJson<ContractReadReceipt>(`/api/spxw-proxy/actions/${encodeURIComponent(spxContractActionId)}`, "SPXW动作状态", new AbortController().signal);
      if (!active) return;
      const result = receipt.result;
      if (receipt.status === "QUEUED" || receipt.status === "RUNNING") {
        setSpxBusy(true); setSpxMessage(`精确合约读取${receipt.status === "QUEUED" ? "已排队" : "进行中"} · ${receipt.action_id}`); setSpxAction({ action_id: receipt.action_id, status: receipt.status, result: "等待后台权威终态" }); return;
      }
      window.clearInterval(timer); setSpxBusy(false);
      if (result?.action_status === "SUCCEEDED") {
        setSpxMatch(result.contracts[0] ?? null); const message = `${contractReadText[result.status]}${result.quoted_at ? ` · ${safeDate(result.quoted_at, "PT")}` : ""}${result.message ? ` · ${result.message}` : ""}`; setSpxMessage(`${message} · ${receipt.action_id}`); setSpxAction({ action_id: receipt.action_id, status: "SUCCEEDED", result: message });
      } else {
        const message = receipt.error ?? result?.error ?? (result ? contractReadText[result.status] : "后台动作没有返回结果"); setSpxMessage(`${message} · ${receipt.action_id}`); setSpxAction({ action_id: receipt.action_id, status: receipt.status, result: message });
      }
    };
    const failed = (error: unknown) => { if (active) { const message = requestMessage(error, "SPXW动作状态回读") ?? "动作状态回读已取消"; setSpxMessage(message); if (message.includes("Owner动作不存在")) { window.localStorage.removeItem("trading-os-spx-contract-action:v1"); setSpxContractActionId(null); setSpxBusy(false); setSpxAction({ action_id: spxContractActionId, status: "FAILED", result: message }); } else setSpxAction({ action_id: spxContractActionId, status: "RUNNING", result: `${message}；未改写后台终态` }); } };
    void refresh().catch(failed); timer = window.setInterval(() => void refresh().catch(failed), 1_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [spxContractActionId]);

  const dataKey = `${symbol}:${interval}:${range}`;
  const activeData = dataByKey[dataKey] ?? null, chartError = errorsByKey[dataKey] ?? null;
  const forecastContext = useMemo(() => resolveTsForecastContext(snapshot?.outputs.TS_SHADOW_OUTPUT ?? [], requestedForecastId, clockNow), [snapshot, requestedForecastId, clockNow]);
  const ts = forecastContext.selected;
  const forecastDisplay = buildTsForecastDisplay(ts, forecastContext.mode, clockNow);
  const forecastTypeLabel = forecastContext.mode === "CURRENT_LIVE" && !forecastDisplay.isCurrent ? forecastDisplay.status : forecastModeText[forecastContext.mode];
  const model = useMemo(() => chartModel(activeData, ts, symbol, range), [activeData, ts, symbol, range]);
  const latestChartRef = useRef({ model, dataKey });
  useEffect(() => { let disposed = false; if (rootRef.current) void mountChart(rootRef.current).then((controller) => { if (disposed) controller.destroy(); else { controllerRef.current = controller; controller.update(latestChartRef.current.model, latestChartRef.current.dataKey); } }); return () => { disposed = true; controllerRef.current?.destroy(); controllerRef.current = null; }; }, []);
  useEffect(() => { latestChartRef.current = { model, dataKey }; controllerRef.current?.update(model, dataKey); }, [model, dataKey]);

  const last = model.bars.at(-1), previous = model.bars.at(-2), price = activeData?.current_price ?? last?.close ?? null, change = price !== null && previous ? price - previous.close : null;
  const ownerMarketHealth = activeData ? classifyOwnerMarketHealth({ status: activeData.status, phase: activeData.market_session.phase ?? "CLOSED", quote_freshness_seconds: activeData.quote_freshness_seconds, bar_freshness_seconds: activeData.bar_freshness_seconds, gap_status: activeData.gap_status, system_blocked: Boolean(chartError) }) : null;
  const effectiveStatus: MarketStatus | "NOT_OBSERVED" = chartError ? "DATA_BLOCKED" : ownerMarketHealth?.code === "EXPECTED_PROVIDER_SESSION_LIMIT" || ownerMarketHealth?.code === "BAR_LIVE_QUOTE_STALE" ? "STALE" : activeData?.status ?? "NOT_OBSERVED";
  const ownerMarketText = ownerMarketHealth ? { BAR_LIVE_QUOTE_LIVE: "Quote 与 Bar 正常", BAR_LIVE_QUOTE_STALE: "Quote 已过期 · Bar 可用", EXPECTED_PROVIDER_SESSION_LIMIT: "夜盘Quote受限 · Bar可用", MARKET_CLOSED: "市场休市 · 显示最近行情", GENUINE_DATA_BLOCKED: "行情数据受阻", SYSTEM_BLOCKED: "系统读取受阻", SOURCE_GAP: "行情数据有缺口" }[ownerMarketHealth.code] : statusText[effectiveStatus];
  const vwap = model.vwap.at(-1)?.value ?? null, levels = Object.fromEntries(model.levels.map((level) => [level.kind, level.value])) as Partial<Record<"support" | "resistance" | "invalidation" | "target", number>>;
  const dataNotice = chartError
    ? activeData && model.bars.length ? `行情更新失败：${chartError}；继续显示截至 ${safeDate(activeData.as_of, "PT")} 的最近成功数据` : `行情读取失败：${chartError}；没有可用的EOD回退数据`
    : !activeData ? "正在读取Robinhood官方只读行情（最长10秒）" : ownerMarketHealth?.code === "EXPECTED_PROVIDER_SESSION_LIMIT" ? "夜盘实时Quote不可用，但批准的5分钟Bar仍在420秒合同内；Forecast保留，当前NO TRADE" : activeData.error ?? (!model.bars.length ? "官方源没有返回可用K线" : null);
  const sessionCoverage = Object.entries((activeData?.bars ?? []).reduce<Record<string, number>>((counts, bar) => { if (bar.session) counts[bar.session] = (counts[bar.session] ?? 0) + 1; return counts; }, {})).map(([name, count]) => `${chartSessionText[name as keyof typeof chartSessionText] ?? name} ${count}根`).join(" · ") || "SOURCE_GAP";
  const sourceLine = `Robinhood官方只读 · Quote ${safeDate(activeData?.quote_as_of ?? null, "PT")}（${activeData?.quote_freshness_seconds === null || activeData?.quote_freshness_seconds === undefined ? "未知" : `${Math.round(activeData.quote_freshness_seconds)}秒`}） · Bar ${safeDate(activeData?.bar_as_of ?? null, "PT")}（${activeData?.bar_freshness_seconds === null || activeData?.bar_freshness_seconds === undefined ? "未知" : `${Math.round(activeData.bar_freshness_seconds)}秒`}）`;
  const direction = ts ? directions[ts.symbol_outlooks[symbol].direction] : "未观察到";
  const qualification = ts ? qualificationText[ts.tradeability.status] : "尚无交易资格判断";
  const qualificationReason = ts?.tradeability.reason ?? "等待当前自然槽冻结交易资格。";
  const nextCheck = ts ? safeDate(ts.next_validation.at, "PT") : "等待下一自然槽";
  const pathProbability = (name: PathName) => ts?.scenarios[name].probability_pct ?? null;
  const pathEnd = (name: PathName) => model.fan.displayPaths[name].at(-1)?.value ?? null;
  const levelText = (kind: keyof typeof levels) => levels[kind] === undefined ? "合同未上报" : fmtPrice.format(levels[kind]!);
  const triggerFor = (target: SymbolName) => forecastContext.mode === "NEXT_SESSION" || !ts ? null : [snapshot?.ownerTrigger.current[target], ...(snapshot?.ownerTrigger.recent ?? [])].find((event) => event?.symbol === target && event.forecast_run_id === ts.evidence_snapshot.run_id) ?? null;
  const trigger = triggerFor(symbol);
  const zoneLow = trigger?.key_zone.low ?? null, zoneHigh = trigger?.key_zone.high ?? null;
  const zone = zoneLow === null || zoneHigh === null ? "自然数据尚未形成" : zoneLow === zoneHigh ? fmtPrice.format(zoneLow) : `${fmtPrice.format(zoneLow)}–${fmtPrice.format(zoneHigh)}`;
  const remaining = trigger?.remaining_space === null || trigger?.remaining_space === undefined ? "证据不足" : trigger.remaining_space <= 0 ? "目标空间已用尽" : `${fmtPrice.format(trigger.remaining_space)} 点`;
  const triggerChanged = trigger ? safeDate(trigger.changed_at, "PT") : "等待首个自然状态事件";
  const triggerRisk = ts && !forecastDisplay.isCurrent ? `${forecastDisplay.status}；原触发记录仅供参考。` : trigger?.risk_blockers.length ? trigger.risk_blockers.slice(0, 2).join("；") : trigger?.is_tradeable ? "现有期权与风控门禁均已通过；仍由Owner人工决定" : "等待匹配的自然LIVE期权与风控复核";
  const pendingActivation = ts ? contractConditions(ts.scenarios.main.activation).filter((condition) => condition.symbol === symbol).map(conditionText).join("；") : "";
  const pendingInvalidation = ts ? contractConditions(ts.scenarios.main.invalidation).filter((condition) => condition.symbol === symbol).map(conditionText).join("；") : "";
  const derivedTruth = snapshot ? buildCurrentTruth(snapshot, clockNow) : null, currentTruth = snapshot?.currentTruth ?? derivedTruth, intradayTruth = currentTruth?.intraday_regime;
  const forecastLayerLabel = ts?.forecast_window.horizon === "NEXT_30_TO_60_MINUTES" ? "盘中下一观察窗口（30—60分钟）" : forecastContext.mode === "NEXT_SESSION" ? "下一交易日初步观察" : "原预测观察窗口";
  const evidenceContract = buildTsEvidenceContract(ts, forecastContext.mode, clockNow, intradayTruth), nextRthNotStarted = evidenceContract.next_rth?.state === "NOT_STARTED";
  const evidenceMissing = evidenceContract.missing.length ? evidenceContract.missing.map((item) => `${item.label} ${evidenceStateText[item.state]}`).join("；") : "无缺失或阻断";
  const spyTrigger = triggerFor("SPY"), proxy = snapshot?.spxwProxy, kernel = snapshot?.investmentKernel, spxPack = kernel?.active_strategy_packs.find((item) => item.contract_id === "SPX_FOLLOW") ?? null;
  const watch = proxy?.watches.find((item) => spxWatchLifecycle(item, clockNow).status === "ACTIVE") ?? null, endedWatches = proxy?.watches.filter((item) => spxWatchLifecycle(item, clockNow).status !== "ACTIVE") ?? [], realHolding = proxy?.real_holdings[0] ?? null, optionQuote = watch?.current_quote ?? watch?.created_quote ?? null;
  const activeOwnerObservations = proxy?.owner_observations.filter((item) => spxOwnerObservationLifecycle(item, clockNow).status === "ACTIVE") ?? [];
  const closedOwnerObservations = proxy?.owner_observations.filter((item) => spxOwnerObservationLifecycle(item, clockNow).status !== "ACTIVE") ?? [];
  const autoSelection = proxy?.auto_selection, automaticWatch = watch?.strategy_context?.signal_source.source_mode === "SYSTEM_SIMULATED_RESEARCH";
  const autoSelectionText = autoSelection ? { CREATED: "已建立自动模拟观察", NO_CANDIDATE: "本次未找到符合研究规则的真实合约", WAITING_REGIME: "等待当前自然盘型", ALREADY_TRACKING: "已有模拟观察，继续跟踪", SOURCE_UNAVAILABLE: "本次自动选约未完成", MARKET_CLOSED: "休市，等待下个交易时段" }[autoSelection.status] : spxPack?.version === "1.3.0" ? "自动模拟观察已启用，等待下一自然盘中检查" : "自动模拟观察尚未配置";
  const convexity = snapshot?.spxConvexity, opportunity = convexity?.current ?? null, convexityCandidates = opportunity?.candidates ?? [], capitalContext = convexity?.capital_context ?? kernel?.capital_context?.context ?? null;
  const createdQuoteUsable = watch?.created_quote.contract_quote_status === "CONTRACT_FOUND_QUOTE_LIVE" || !watch?.created_quote.contract_quote_status && watch?.created_quote.status === "LIVE", currentQuoteUsable = optionQuote?.contract_quote_status === "CONTRACT_FOUND_QUOTE_LIVE" || !optionQuote?.contract_quote_status && optionQuote?.status === "LIVE";
  const createdMark = watch?.created_quote.mark, optionChange = createdQuoteUsable && currentQuoteUsable && createdMark !== null && createdMark !== undefined && optionQuote?.mark !== null && optionQuote?.mark !== undefined ? optionQuote.mark - createdMark : null;
  const optionSpread = optionQuote?.bid !== null && optionQuote?.bid !== undefined && optionQuote.ask !== null ? optionQuote.ask - optionQuote.bid : null;
  const chasing = spyTrigger?.new_state === "CHASE_RISK_HIGH" || spyTrigger?.new_state === "PATH_ACTIVATED" && !spyTrigger.is_tradeable;
  const optionTruth = derivedTruth?.spx_option.quote, optionState = optionTruth?.status ?? (!watch && !realHolding ? "NO_CONTRACT_SELECTED" : "QUOTE_PENDING");
  const executionStatus = ts && !forecastDisplay.isCurrent ? forecastDisplay.status : optionState === "NO_CONTRACT_SELECTED" ? "尚未选择观测合约" : optionState === "DATA_BLOCKED" || optionState === "STALE" || optionState === "QUOTE_PENDING" ? "期权报价降级，自动复查中；SPY结构可用" : chasing ? "存在方向偏向，但交易条件不足" : spyTrigger ? triggerActionText[spyTrigger.owner_action] : forecastContext.mode === "NEXT_SESSION" ? "等待下一交易日自然确认" : "等待 SPY 自然 Trigger";
  const contextNote = forecastContext.consistencyError ?? (!forecastDisplay.isCurrent && ts ? `${forecastDisplay.status}；保留原始预测身份与条件。` : forecastContext.mode === "CURRENT_LIVE" ? "当前自然LIVE预测与Trigger、SPY信号层、Proxy使用同一身份。" : "当前尚未形成可绑定的自然预测。");
  const contextIdentity = ts?.evidence_snapshot.run_id ?? requestedForecastId ?? "未形成";
  const contextUpdatedAt = ts?.evidence_snapshot.market_time.observed_at ?? null;
  const expiryOptions = spxChains.find((item) => item.chain_symbol === spxChain)?.expiration_dates ?? [];
  const loadSpxChains = async () => {
    if (spxBusy || spxChainsLoaded) return;
    const controller = new AbortController(), requestId = clientRequestId(), actionId = requestId ? `spx-chain-read-${requestId}` : "AWAITING_SERVER_ID", query = requestId ? `?request_id=${requestId}` : ""; setSpxBusy(true); setSpxMessage("正在更新Robinhood真实只读期权链……"); setSpxAction({ action_id: actionId, status: "RUNNING", result: "等待Robinhood只读链" });
    try { const body = await readJson<{ action_id: string; action_status: "SUCCEEDED"; chains: SpxOptionChain[] }>(`/api/spxw-proxy/chains${query}`, "SPXW期权链", controller.signal); setSpxChains(body.chains); setSpxChainsLoaded(true); const chain = body.chains.find((item) => item.chain_symbol === "SPXW"), firstExpiry = chain?.expiration_dates[0] ?? ""; if (chain) { setSpxExpiration((value) => value || firstExpiry); setSpxValidUntil((value) => value || contractExpiryLocal(firstExpiry)); } setSpxMessage(`期权链读取完成 · ${body.action_id}`); setSpxAction({ action_id: body.action_id, status: "SUCCEEDED", result: `${body.chains.length}条真实只读链` }); }
    catch (error) { const message = requestMessage(error, "SPXW期权链更新") ?? "当前请求已被新请求替代"; setSpxMessage(message); setSpxAction({ action_id: actionId, status: "FAILED", result: `${message}；这不是后台TIMED_OUT终态` }); }
    finally { setSpxBusy(false); }
  };
  const searchSpxContract = async () => {
    const missing = [...(!spxExpiration ? ["到期日"] : []), ...(!spxStrike || Number(spxStrike) <= 0 ? ["Strike"] : [])];
    if (missing.length) { const message = `缺少或无效字段：${missing.join("、")}`; setSpxMessage(message); setSpxAction({ action_id: "NOT_CREATED", status: "FAILED", result: message }); return; }
    const requestId = clientRequestId(), actionId = requestId ? `spx-contract-read-${requestId}` : "AWAITING_SERVER_ID"; setSpxBusy(true); setSpxMessage("正在创建精确合约读取任务……"); setSpxMatch(null); setSpxAction({ action_id: actionId, status: "QUEUED", result: "等待后台返回权威action_id" });
    try {
      const receipt = await writeJson<ContractReadReceipt>("/api/spxw-proxy/contract-reads", { chain_symbol: spxChain, expiration_date: spxExpiration, strike: Number(spxStrike), option_type: spxType, ...(requestId ? { idempotency_key: requestId } : {}) });
      window.localStorage.setItem("trading-os-spx-contract-action:v1", receipt.action_id); setSpxContractActionId(receipt.action_id); setSpxMessage(`精确合约读取${receipt.status === "QUEUED" ? "已排队" : "已开始"} · ${receipt.action_id}`); setSpxAction({ action_id: receipt.action_id, status: receipt.status, result: "页面将通过状态接口读取后台终态" });
    } catch (error) {
      const message = requestMessage(error, "SPXW动作回执") ?? "当前请求已被新请求替代";
      if (requestId) { window.localStorage.setItem("trading-os-spx-contract-action:v1", actionId); setSpxContractActionId(actionId); setSpxMessage(`${message}；正在按同一action_id恢复后台状态`); setSpxAction({ action_id: actionId, status: "RUNNING", result: "浏览器等待结束未改写后台终态" }); }
      else { setSpxBusy(false); setSpxMessage(message); setSpxAction({ action_id: actionId, status: "FAILED", result: `${message}；浏览器没有Web Crypto，未获得后台action_id` }); }
    }
  };
  const createSpxWatch = async () => {
    if (!spxMatch) return;
    if (!spxValidUntil || !Number.isFinite(Date.parse(spxValidUntil))) { const message = "请填写有效期"; setSpxMessage(message); setSpxAction({ action_id: "NOT_CREATED", status: "FAILED", result: message }); return; }
    const requestId = clientRequestId(), actionId = requestId ? `spx-watch-${requestId}` : "AWAITING_SERVER_ID"; setSpxBusy(true); setSpxMessage("正在创建本地观测单……"); setSpxAction({ action_id: actionId, status: "RUNNING", result: "仅写入本地审计" });
    try { const body = await writeJson<ProxyActionResponse>("/api/spxw-proxy/watches", { contract_id: spxMatch.contract.contract_id, owner_note: spxWatchNote, valid_until: new Date(spxValidUntil).toISOString(), forecast_run_id: ts?.evidence_snapshot.run_id ?? null, ...(requestId ? { idempotency_key: requestId } : {}) }); setSnapshot((current) => current ? { ...current, spxwProxy: body } : current); const result = body.duplicate ? "已有同一观测单，未重复写入" : "本地观测单已创建；报价状态已冻结，不是Broker订单"; setSpxMessage(`${result} · ${body.observation_id ?? body.action_id}`); setSpxAction({ action_id: body.action_id, status: "SUCCEEDED", result }); setSpxWatchNote(""); setSpxValidUntil(""); }
    catch (error) { const message = requestMessage(error, "创建观测单") ?? "当前请求已被新请求替代"; setSpxMessage(message); setSpxAction({ action_id: actionId, status: "FAILED", result: `${message}；这不是后台TIMED_OUT终态` }); } finally { setSpxBusy(false); }
  };
  const endSpxWatch = async () => {
    if (!watch || watch.status === "ENDED") return; const actionId = `${watch.watch_id}:end`; setSpxBusy(true); setSpxAction({ action_id: actionId, status: "RUNNING", result: "正在结束本地观察" });
    try { const body = await writeJson<ProxyActionResponse>(`/api/spxw-proxy/watches/${encodeURIComponent(watch.watch_id)}/end`, {}); setSnapshot((current) => current ? { ...current, spxwProxy: body } : current); const result = "已结束本地观察；没有调用Broker写操作"; setSpxMessage(`${result} · ${body.action_id}`); setSpxAction({ action_id: body.action_id, status: "SUCCEEDED", result }); }
    catch (error) { const message = requestMessage(error, "结束观察") ?? "当前请求已被新请求替代"; setSpxMessage(message); setSpxAction({ action_id: actionId, status: "FAILED", result: `${message}；这不是后台TIMED_OUT终态` }); } finally { setSpxBusy(false); }
  };
  const recordOwnerSpxLevel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form), local = String(data.get("valid_until") ?? ""), requestId = clientRequestId(), actionId = requestId ? `owner-spx-${requestId}` : "AWAITING_SERVER_ID";
    setSpxBusy(true); setSpxMessage("正在写入本地Owner观察……"); setSpxAction({ action_id: actionId, status: "RUNNING", result: "仅写入本地追加式审计" });
    try {
      const body = await writeJson<ProxyActionResponse>("/api/spxw-proxy/owner-levels", { kind: data.get("kind"), low: Number(data.get("low")), high: Number(data.get("high") || data.get("low")), valid_until: local ? new Date(local).toISOString() : null, owner_note: data.get("owner_note"), ...(requestId ? { idempotency_key: requestId } : {}) });
      setSnapshot((current) => current ? { ...current, spxwProxy: body } : current); const result = body.duplicate ? "同一请求已存在，未重复写入" : "Owner人工SPX区域已追加留证；自动确认仍使用SPY代理"; setSpxMessage(`${result} · ${body.observation_id ?? body.action_id}`); setSpxAction({ action_id: body.action_id, status: "SUCCEEDED", result }); form.reset();
    } catch (error) { const message = requestMessage(error, "保存Owner人工区域") ?? "当前请求已被新请求替代"; setSpxMessage(message); setSpxAction({ action_id: actionId, status: "FAILED", result: `${message}；这不是后台TIMED_OUT终态` }); }
    finally { setSpxBusy(false); }
  };

  return <div ref={rootRef} className="approved-cockpit prototype-shell" data-nav="open" data-rail="open" data-mode="ratio" data-ts="on" data-selected="main">
    <a className="skip-link" href="#prototype-main">跳到图表</a>
    <header className="mobile-workbench-bar">
      <details className="mobile-site-menu"><summary aria-label="打开 Trading OS 导航"><span aria-hidden="true">☰</span><b>菜单</b></summary><nav aria-label="Trading OS 七个主页面">{ownerNav.map(([href, label]) => <a href={href} key={href} aria-current={href === "/forecast" ? "page" : undefined}>{label}</a>)}</nav></details>
      <a className="mobile-home-link" href="/">← 返回 Trading OS 主站</a>
    </header>
    <aside className="side-nav" aria-label="TS驾驶舱导航"><header><span className="mark">T</span><strong>TRADING OS</strong></header><nav><a href="#chart" aria-current="page">TS专业看盘</a><a href="./">← 返回 Trading OS 主站</a></nav><p>本地真实数据<br />Shadow · 严格只读</p></aside>
    <main id="prototype-main">
      <header className="terminal-header"><div className="instrument"><button id="nav-toggle" className="icon-button" type="button" aria-label="收起左侧导航">☰</button><div><label htmlFor="symbol-select">标的</label><select id="symbol-select" value={symbol} onChange={(event) => setSymbol(event.target.value as SymbolName)}><option>SPY</option><option>QQQ</option></select></div><div><label htmlFor="interval-select">周期</label><select id="interval-select" value={interval} onChange={(event) => setIntervalName(event.target.value as IntervalName)}><option value="1m">1分钟</option><option value="5m">5分钟</option><option value="15m">15分钟</option></select></div><div><label htmlFor="range-select">范围</label><select id="range-select" value={range} onChange={(event) => setRange(event.target.value as RangeName)}><option value="1d">当前交易日</option><option value="24h">最近24小时</option><option value="rth">最近RTH</option><option value="gth">盘后/GTH</option><option value="5d">近5个交易日</option></select></div></div><div className="quote"><strong id="last-price">{price === null ? "—" : fmtPrice.format(price)}</strong><span data-negative={change !== null && change < 0}>{change === null ? "—" : `${change >= 0 ? "+" : ""}${fmtPrice.format(change)} (${change >= 0 ? "+" : ""}${(change / previous!.close * 100).toFixed(2)}%)`}</span><small>{ownerMarketText} · {safeDate(activeData?.as_of ?? null, "PT")}</small></div></header>
      <MacroEventNotice overview={snapshot?.macroEventLearning} at={clockNow} />
      <NextSessionObservationCard outputs={snapshot?.outputs.TS_SHADOW_OUTPUT ?? []} checkpoints={snapshot?.outputs.SCHEDULE_CHECKPOINT ?? []} incidents={snapshot?.selfCheck.active ?? []} tradingDate={currentTruth?.trading_date ?? forecastContext.clock.trading_date} at={clockNow} />
      {snapshotError && <p className="owner-market-note" role="status" data-tone="warning">{snapshot ? "分析更新失败，以下保留上次成功记录；请勿据此确认当前交易条件。" : "分析暂未读取成功。"} {snapshotError}</p>}
      <section className="owner-trigger-card" aria-label="当前预测状态">
        <header><div><span>当前预测</span><strong>{ts ? forecastDisplay.isCurrent ? direction : forecastDisplay.status : snapshot ? "本时段尚无正式预测" : "正在读取预测记录"}</strong></div></header>
        <p className="owner-market-note">{ts ? `${forecastDisplay.windowText}；${forecastDisplay.reviewText}` : forecastContext.consistencyError ?? "行情与预测分别更新；正式预测形成后会自动显示。历史记录仍可查看。"}</p>
        <p className="owner-market-note">行情截至 {safeDate(activeData?.as_of ?? null, "PT")} · 预测发布 {contextUpdatedAt ? safeDate(contextUpdatedAt, "PT") : "尚未形成"}</p>
        {currentTruth?.natural_slot.slot_id ? <p className="owner-market-note">最近自然检查：{slotStatusText[currentTruth.natural_slot.status] ?? "状态待核实"} · 记录时间 {safeDate(currentTruth.natural_slot.terminal_at ?? currentTruth.natural_slot.recorded_at, "PT")} · <a href="/health">查看系统状态与原因</a></p> : null}
        <p className="owner-market-note"><a href="/settlements#decision-review">查看预测历史与复盘</a> · <a href="/settlements#prediction-research">预测增强研究（30 / 60分钟）</a></p>
      </section>
      <DetailSheet title="预测与数据证据" label="查看预测与数据证据" className="market-context-evidence">
      <p>{sourceLine} · 时段覆盖：{sessionCoverage}</p>
      <p>条件节点的横向间距和连接线仅用于展示合同顺序，不是精确价格或时间轨迹；按冻结条件与预测期限结算。场景权重尚未Forward校准。</p>
      <section className="forecast-context-card" data-mode={forecastContext.mode} aria-label="CURRENT_TRUTH_V1 统一预测上下文">
        <div><span>预测类型</span><strong>{forecastTypeLabel}</strong><small>{contextNote}</small></div>
        <div><span>预测身份</span><strong>{contextIdentity}</strong><small>预测时间 {contextUpdatedAt ? safeDate(contextUpdatedAt, "PT") : "未形成"}</small></div>
        {ts ? <><div><span>走势判断 · {forecastLayerLabel}</span><strong>{forecastDisplay.isCurrent ? direction : forecastDisplay.status}</strong><small>{forecastDisplay.windowText} · {forecastDisplay.reviewText}</small><small>原判断：{direction} · 作用域 {forecastContext.tradingDate ?? "未形成"} RTH · 冻结对象、方向、期限与三路径；发布后不改写</small></div>
        <div><span>交易资格</span><strong>{forecastDisplay.isCurrent ? qualification : "原资格仅供参考"}</strong><small>原资格 {qualification} · {qualificationReason}</small></div>
        <div><span>场景权重</span><strong>尚未校准</strong><small>TS约束判断，不是已通过Forward校准的真实概率</small></div></> : null}
        <div><span>SPXW市场上下文</span><strong>{spxSessionText[forecastContext.clock.session]} · 交易日期 {forecastContext.clock.trading_date}</strong><small>本地时间 {formatPtDateTime(clockNow)} · {forecastContext.clock.trading_date !== forecastContext.clock.calendar_date ? "属于下一工作日交易日期" : "属于当前日交易日期"}</small></div>
        <div><span>最近正式槽 / 冻结终态</span><strong>{currentTruth?.natural_slot.slot_id ?? "尚未观察到"} · {currentTruth?.natural_slot.terminal_state ?? currentTruth?.natural_slot.status ?? "NOT_OBSERVED"}</strong><small>{currentTruth?.natural_slot.required_departments.map((agent) => `${agent} ${currentTruth.departments.find((item) => item.agent_id === agent)?.status ?? "NOT_RUN"}`).join(" · ") ?? "等待CURRENT_TRUTH_V1"}</small></div>
        <div><span>当前实时数据</span><strong>{currentTruth?.market_data_health.classification ?? "SOURCE_GAP"}</strong><small>Quote {currentTruth?.market_data_health.quote_health ?? "NOT_OBSERVED"} · Bar {currentTruth?.market_data_health.bar_health ?? "NOT_OBSERVED"} · 不反写冻结终态</small></div>
        <div><span>下一槽资格</span><strong>{currentTruth?.next_slot_qualification.status ?? "BLOCKED"}</strong><small>{currentTruth?.next_slot_qualification.reason ?? "等待CURRENT_TRUTH_V1"}</small></div>
        <div><span>当前日内盘型 · {forecastContext.tradingDate ?? forecastContext.clock.trading_date} RTH</span><strong>{nextRthNotStarted ? "NOT_STARTED · 尚未开盘" : `${regimeStateText[intradayTruth?.state ?? "DATA_BLOCKED"]} · ${intradayTruth?.direction === "UP" ? "向上" : intradayTruth?.direction === "DOWN" ? "向下" : "无方向"}`}</strong><small>{nextRthNotStarted ? `尚未到 ${nextCheck}；不是数据故障，也不等待“恢复”` : `${intradayTruth?.owner_summary ?? "等待当天真实5分钟证据"} · ${participationText[intradayTruth?.participation_status ?? "DATA_BLOCKED"]}`}</small></div>
        <div><span>数据源健康 · 当前行情</span><strong>{ownerMarketText}</strong><small>Quote {safeDate(activeData?.quote_as_of ?? null, "PT")} · Bar {safeDate(activeData?.bar_as_of ?? null, "PT")} · 与冻结预测证据分层显示</small></div>
      </section>
      {ts ? <details className="evidence-contract-card" aria-label="确定性证据合同">
        <summary><span>预测证据 · 必需 {evidenceContract.required_available}/{evidenceContract.required_total} · 条件性 {evidenceContract.conditional_available}/{evidenceContract.conditional_total} · 增强 {evidenceContract.enhancement_available}/{evidenceContract.enhancement_total}</span><b>详细证据默认折叠</b></summary>
        <header><div><span>确定性结果</span><strong>增强缺失不阻断当前预测</strong></div><p>下一确认 {nextCheck} · {ts.next_validation.purpose}</p></header>
        <div>{evidenceContract.items.map((item) => <article key={item.key} data-state={item.state}><span>{evidenceRoleText[item.role]} · {item.scope === "NEXT_RTH" ? `${forecastContext.tradingDate ?? "目标日"} RTH` : "预测发布时"}</span><strong>{item.label} · {evidenceStateText[item.state]}</strong><small>{item.observed_at ? `证据时间 ${safeDate(item.observed_at, "PT")}` : item.state === "NOT_STARTED" ? `等待 ${nextCheck} 自然开始` : "当前没有可用证据"}</small></article>)}</div>
        <footer>缺失/阻断：{evidenceMissing}。增强项缺失只降低解释完整度，不自动否决正式预测。</footer>
      </details> : null}
      </DetailSheet>
      <section className="owner-trigger-card" data-state={trigger?.new_state ?? "NOT_OBSERVED"} aria-label="老板触发观察层" aria-live="polite">
        <header><div><span>交易条件</span><strong>{ts && !forecastDisplay.isCurrent ? forecastDisplay.status : trigger ? triggerStateText[trigger.new_state] : forecastContext.mode === "NEXT_SESSION" ? "下一交易日自然确认尚未开始" : ts ? "预测已绑定 · 等待触发确认" : "正式预测未形成"}</strong></div><b>{forecastDisplay.isCurrent && trigger?.owner_action === "CONSIDER_BY_RULE" ? "可按规则考虑" : "暂不交易"}</b></header>
        <p className="owner-market-note">{triggerRisk}</p>
        <DetailSheet title="触发条件与依据" label="查看触发条件与依据">
        <p className="owner-market-note">Owner Trigger Layer · 只观察，不自动下单</p>
        <div className="owner-trigger-grid">
          <article><span>{forecastDisplay.isCurrent ? "当前结构" : "原预测与触发结构"}</span><strong>{forecastDisplay.isCurrent ? trigger ? `${directions[trigger.structure.direction]} · ${trigger.structure.pattern}` : direction : forecastDisplay.status}</strong><p>{forecastDisplay.windowText} · {forecastDisplay.reviewText}</p><p>原判断：{direction} · {trigger?.structure.summary ?? ts?.symbol_outlooks[symbol].summary ?? "等待当前自然LIVE预测与完整5分钟K线形成同一证据链。"}</p></article>
          <article><span>当前阶段 / 关键区域</span><strong>{ts && !forecastDisplay.isCurrent ? forecastDisplay.status : trigger ? triggerStateText[trigger.new_state] : forecastContext.mode === "NEXT_SESSION" ? "等待下一交易日自然确认" : ts ? "预测已绑定，Trigger尚未形成" : "尚未绑定自然预测"} · {zone}</strong><p>{trigger?.state_reason ?? contextNote}</p></article>
          <article><span>精确激活条件</span><strong>{trigger?.activation.display ?? (pendingActivation || (forecastContext.mode === "NEXT_SESSION" ? "次日预测条件已记录，等待自然时段" : "预测合同未上报激活条件"))}</strong><p>触碰不算确认；按原合同要求等待完整K线或连续停留。</p></article>
          <article><span>剩余合理空间 / 动作</span><strong>{remaining} · {forecastDisplay.isCurrent && trigger?.owner_action === "CONSIDER_BY_RULE" ? "QUALIFIED" : "NO TRADE"}</strong><p>{triggerRisk}</p></article>
          <article><span>失效条件</span><strong>{trigger?.invalidation.display ?? (pendingInvalidation || "预测合同未上报可复算失效条件")}</strong><p>{trigger?.invalidation_reason ?? "原合同失效条件成立时取消剧本。"}</p></article>
          <article><span>最后变化 / 相比上一槽</span><strong>{triggerChanged}</strong><p>{trigger?.previous_slot_change ?? ts?.forecast_update.change_summary ?? "尚无绑定变化"}</p></article>
        </div>
        <footer><span>预测 {contextIdentity} · {forecastTypeLabel}</span><span>原概率 {trigger ? `${trigger.original_probability_pct}%` : "未进入Trigger"}，未被触发层修改</span><span>数据 {trigger?.data_timestamp ? safeDate(trigger.data_timestamp, "PT") : contextUpdatedAt ? safeDate(contextUpdatedAt, "PT") : "未观察到"}</span><span>Shadow · 不自动下单</span></footer>
        </DetailSheet>
      </section>
      <section className="spxw-proxy-card" aria-label="SPY 到 SPXW 代理观察模式" aria-live="polite">
        <header><div><span>SPXW 期权观察</span><strong>{executionStatus}</strong></div><b data-status={optionState}>{optionStateText[optionState] ?? optionState}</b></header>
        <p className="owner-market-note">{autoSelectionText}{autoSelection ? ` · 最近检查 ${safeDate(autoSelection.checked_at, "PT")}` : ""}</p>
        <p className="owner-market-note">{watch ? `${watch.chain_symbol} · ${watch.expiration_date} · ${fmtPrice.format(watch.strike)} ${watch.option_type === "call" ? "看涨" : "看跌"}` : realHolding ? `${realHolding.chain_symbol} · ${realHolding.expiration_date} · ${fmtPrice.format(realHolding.strike)} ${realHolding.option_type === "call" ? "看涨" : "看跌"}` : "尚无观测合约"} · 观察不等于买入。</p>
        <DetailSheet title="合约与观察证据" label="查看合约与观察证据">
        <p className="owner-market-note">当前优先关注 SPY / QQQ；SPXW 为辅助研究。自动观察选择7–30天到期的真实合约，不执行买卖。</p>
        <p className="owner-market-note">SPY → SPXW Proxy Mode</p>
        <div className="proxy-facts"><span>Owner Kernel：<b>{kernel?.constitution ? `${kernel.constitution.contract_id}@${kernel.constitution.version}` : "未配置"}</b></span><span>Strategy Pack：<b>{spxPack ? `${spxPack.contract_id}@${spxPack.version}` : "未配置"}</b></span><span>绑定预测：<b>{forecastTypeLabel} · {contextIdentity}</b></span><span>市场时段：<b>{spxSessionText[forecastContext.clock.session]} · 交易日期 {forecastContext.clock.trading_date}</b></span><span>分析基准：<b>{currentTruth?.spx_market_data.analysis_mode === "SPX_DIRECT" ? "真实SPX" : "SPY代理结构 / 成交量 / VWAP / Owner Trigger"}</b></span><span>参考指数：<b>SPX</b></span><span>观察产品：<b>SPXW期权</b></span><span>SPX现货数据：<b>{currentTruth?.spx_market_data.spot.status ?? "DATA_BLOCKED"} · {currentTruth?.spx_market_data.spot.reason ?? "真实数据合同通过"}</b></span><span>SPX K线数据：<b>{currentTruth?.spx_market_data.kline_5m.status ?? "DATA_BLOCKED"} · {currentTruth?.spx_market_data.kline_5m.reason ?? "真实5分钟OHLC合同通过"}</b></span><span>Owner人工SPX区：<b>{activeOwnerObservations[0] ? `${fmtPrice.format(activeOwnerObservations[0].low)}${activeOwnerObservations[0].high === activeOwnerObservations[0].low ? "" : `–${fmtPrice.format(activeOwnerObservations[0].high)}`}` : "没有当前有效人工观察"}</b></span></div>
        <div className="convexity-grid" aria-label="SPX期权凸性机会账本">
          <article><span>方向资格 / 参与窗口</span><strong>{opportunity ? `${opportunity.direction === "UP" ? "向上" : "向下"} · ${convexityStateText[opportunity.state] ?? opportunity.state}` : "当前没有冻结中的凸性机会"}</strong><p>{opportunity ? `候选 ${safeDate(opportunity.candidate_time, "PT")} · 确认 ${opportunity.confirmation_time ? safeDate(opportunity.confirmation_time, "PT") : "尚未确认"} · 窗口关闭 ${opportunity.participation_window_close_time ? safeDate(opportunity.participation_window_close_time, "PT") : "尚未关闭"}` : "只在自然盘型达到候选或确认时追加留证；不会事后挑选合约。"}</p></article>
          <article><span>当时冻结的真实候选</span><strong>{convexityCandidates.length ? `${convexityCandidates.length}个完整身份` : "0个合格候选"}</strong><p>{convexityCandidates.length ? convexityCandidates.map((item) => `${item.contract.chain_symbol} ${item.contract.expiration_date} ${fmtPrice.format(item.contract.strike)} ${item.contract.option_type.toUpperCase()} · ${item.contract.contract_multiplier}倍`).join("；") : "尚无有效的人工或自动模拟合约；空候选仍记录方向确认和失效，后续新合约不回填旧机会。"}</p><small>{opportunity ? `冻结于 ${safeDate(opportunity.frozen_at, "PT")} · SPY_PROXY · SPX现货DATA_BLOCKED` : "等待下一次自然候选"}</small></article>
          <article><span>Owner本金适配</span><strong>{capitalContext ? `约 $${fmtPrice.format(capitalContext.available_capital_usd)} · 常规 $${capitalContext.normal_premium_usd.min}–$${capitalContext.normal_premium_usd.max}` : "本金上下文未配置"}</strong><p>{convexityCandidates.length ? convexityCandidates.map((item) => `${item.capital_assessment.one_contract_ask_cost_usd === null ? "成本未核验" : `一张Ask成本 $${fmtPrice.format(item.capital_assessment.one_contract_ask_cost_usd)} / ${item.capital_assessment.capital_pct?.toFixed(1)}%`} · ${capitalFitText[item.capital_assessment.fit] ?? item.capital_assessment.fit}`).join("；") : "强机会单张上限 $250；理论可负担张数不是仓位建议。"}</p><small>保留现金、每日亏损和组合风险：{!capitalContext || capitalContext.reserve_cash_usd === "NOT_CONFIGURED" ? "NOT_CONFIGURED，失败关闭" : "已配置"}</small></article>
          <article><span>Ask/Bid可执行证据</span><strong>{opportunity?.executable_multiple_status === "VERIFIED" ? convexityCandidates.map((item) => item.executable_multiple === null ? "未核验" : `${item.executable_multiple.toFixed(2)}倍 / ${item.executable_return_pct?.toFixed(1)}%`).join("；") : "EXECUTABLE_MULTIPLE_UNVERIFIED"}</strong><p>{opportunity?.primary_miss_reason ? `未参与主因：${convexityReasonText[opportunity.primary_miss_reason] ?? opportunity.primary_miss_reason}` : opportunity ? "使用确认后第一条合格Ask与窗口内后续真实Bid；Mark不计可执行收益。" : "等待候选冻结和确认后真实BBO。"}</p>{convexityCandidates.length > 0 && <small>{convexityCandidates.map((item) => `候选前→候选 Bid ${item.pre_candidate_bid_change === null ? "未核验" : fmtPrice.format(item.pre_candidate_bid_change)} · 候选→确认 Bid ${item.candidate_to_confirmation_bid_change === null ? "未核验" : fmtPrice.format(item.candidate_to_confirmation_bid_change)} · 确认后 Ask ${item.initial_valid_ask === null ? "—" : fmtPrice.format(item.initial_valid_ask)} → 最高Bid ${item.highest_valid_bid === null ? "—" : fmtPrice.format(item.highest_valid_bid)} · 窗口关闭Bid ${item.window_close_bid === null ? "—" : fmtPrice.format(item.window_close_bid)} · 窗口后最高Bid ${item.hindsight_session_max_bid === null ? "—" : `${fmtPrice.format(item.hindsight_session_max_bid)}（EXCLUDED_RESEARCH）`}`).join("；")}</small>}<small>Owner真实投入 $0 · 已实现收益 $0 · 未实现收益 $0；观察变化不进入账户P/L或正式胜率。</small></article>
        </div>
        <div className="proxy-grid">
          <article><span>SPY信号层</span><strong>{ts && !forecastDisplay.isCurrent ? forecastDisplay.status : spyTrigger ? `${directions[spyTrigger.structure.direction]} · ${triggerStateText[spyTrigger.new_state]}` : ts ? `${directions[ts.symbol_outlooks.SPY.direction]} · ${forecastContext.mode === "NEXT_SESSION" ? "下一交易日自然确认尚未开始" : "预测已绑定，Trigger尚未形成"}` : "尚未绑定自然预测"}</strong><p>{ts && !forecastDisplay.isCurrent ? `原SPY判断：${directions[ts.symbol_outlooks.SPY.direction]}；${contextNote}` : spyTrigger ? `${spyTrigger.key_zone.kind === "SUPPORT" ? "支撑" : spyTrigger.key_zone.kind === "RESISTANCE" ? "压力" : "区间"} ${spyTrigger.key_zone.low === null ? "未形成" : spyTrigger.key_zone.low === spyTrigger.key_zone.high ? fmtPrice.format(spyTrigger.key_zone.low) : `${fmtPrice.format(spyTrigger.key_zone.low)}–${fmtPrice.format(spyTrigger.key_zone.high!)}`} · ${spyTrigger.activation.display}` : forecastContext.mode === "NEXT_SESSION" ? "次日预测已绑定；GTH只观察，不使用RTH规则假报路径激活。" : ts ? "当前自然预测已绑定；没有Trigger事件时不伪造路径激活。" : "不使用 SPX 假价格自动触发。"}</p><small>剩余空间 {spyTrigger?.remaining_space === null || spyTrigger?.remaining_space === undefined ? "未到RTH确认时段" : `${fmtPrice.format(spyTrigger.remaining_space)} SPY点`} · {forecastDisplay.isCurrent && spyTrigger?.owner_action === "CONSIDER_BY_RULE" ? "QUALIFIED" : "NO TRADE"}</small></article>
          <article><span>当前真实合约</span><strong>{watch ? `${watch.chain_symbol} ${watch.expiration_date} ${fmtPrice.format(watch.strike)} ${watch.option_type.toUpperCase()}` : realHolding ? `${realHolding.chain_symbol} ${realHolding.expiration_date} ${fmtPrice.format(realHolding.strike)} ${realHolding.option_type.toUpperCase()}` : "尚未建立本地观测单"}</strong><p>{watch ? `${watch.settlement}结算 · ${watch.is_real_holding ? "Robinhood真实持仓（只读）" : "Trading OS本地观测单"} · ${watch.status}` : realHolding ? `${realHolding.settlement}结算 · Robinhood真实持仓（只读，尚未建观测单）` : "系统会在自然盘中检查真实SPXW研究合约，也可在下方手动选约；Robinhood App观察列表不会自动同步。"}</p><small>{watch ? `observation_id ${watch.observation_id} · 创建 ${safeDate(watch.created_at, "PT")} · 有效至 ${watch.valid_until ? safeDate(watch.valid_until, "PT") : "历史记录未填写"}` : realHolding ? `合约ID ${realHolding.contract_id}` : "创建观测单不代表买入 · 真实投入 $0 · 真实收益 $0"}</small>{watch?.strategy_context && <small>合约ID {watch.contract_id} · 预测 {watch.strategy_context.evidence.SYSTEM_PREDICTION === "LINKED" ? "已绑定" : "未绑定"} · {automaticWatch ? "系统自动模拟观察" : "Owner观察已记录"} · Owner执行未报告 · {watch.strategy_context.evidence.BROKER_FILL === "READONLY_POSITION_OBSERVED" ? "Broker持仓只读可见" : "Broker成交未观察"}</small>}</article>
          <article><span>Robinhood 官方只读报价</span><strong>{optionQuote?.bid === null || optionQuote?.bid === undefined ? "Bid —" : `Bid ${fmtPrice.format(optionQuote.bid)}`} / {optionQuote?.ask === null || optionQuote?.ask === undefined ? "Ask —" : `Ask ${fmtPrice.format(optionQuote.ask)}`} / {optionQuote?.mark === null || optionQuote?.mark === undefined ? "Mark —" : `Mark ${fmtPrice.format(optionQuote.mark)}`}</strong><p>{optionQuote?.contract_quote_status ?? optionQuote?.status ?? "SOURCE_UNAVAILABLE"} · source session {optionQuote?.source_session ?? "未观察到"} · Spread {optionSpread === null ? "—" : fmtPrice.format(optionSpread)} · IV {optionQuote?.iv === null || optionQuote?.iv === undefined ? "—" : `${(optionQuote.iv * 100).toFixed(2)}%`} · Δ {optionQuote?.delta?.toFixed(4) ?? "—"} · Γ {optionQuote?.gamma?.toFixed(4) ?? "—"} · Θ {optionQuote?.theta?.toFixed(4) ?? "—"} · Vega {optionQuote?.vega?.toFixed(4) ?? "—"}</p><small>报价 {optionQuote?.quoted_at ? safeDate(optionQuote.quoted_at, "PT") : "未观察到"} · 当前真实时间 {formatPtDateTime(clockNow)} · 新鲜度 {optionQuote?.freshness_seconds === null || optionQuote?.freshness_seconds === undefined ? "未知" : `${Math.round(optionQuote.freshness_seconds)}秒`}{optionTruth?.automatic_recovery ? " · 自动复查中，无需Owner处理" : ""}</small></article>
          <article><span>观测变化（不是真实收益）</span><strong>{optionChange === null ? "未建立可执行报价基准" : `${optionChange >= 0 ? "+" : ""}${fmtPrice.format(optionChange)} / 理论单张 ${optionChange >= 0 ? "+" : ""}$${fmtPrice.format(optionChange * (watch?.contract_multiplier ?? 0))}`}</strong><p>创建时报价 {createdQuoteUsable && watch?.created_quote.mark !== null && watch?.created_quote.mark !== undefined ? fmtPrice.format(watch.created_quote.mark) : "不可作为入场价"} · 后续快照 {watch?.quote_snapshot_count ?? watch?.events.filter((event) => event.event_type === "QUOTE").length ?? 0} · MFE {createdQuoteUsable && watch?.highest_mark !== null && watch?.highest_mark !== undefined ? fmtPrice.format(watch.highest_mark) : "—"} · MAE {createdQuoteUsable && watch?.lowest_mark !== null && watch?.lowest_mark !== undefined ? fmtPrice.format(watch.lowest_mark) : "—"}</p><small>真实投入 $0 · 真实收益 $0；缺少创建时LIVE双边报价时不计算入场、盈亏、MFE或MAE；后续报价只追加快照。</small></article>
        </div>
        {[{ title: "当前有效人工观察", items: activeOwnerObservations }, { title: "已过期及非当前人工观察", items: closedOwnerObservations }].map(({ title, items }) => items.length > 0 && <details className="proxy-history" key={title}><summary>{title}（{items.length}）</summary><div>{items.map((item) => <article key={item.observation_id}><strong>{item.kind} · {fmtPrice.format(item.low)}{item.high === item.low ? "" : `–${fmtPrice.format(item.high)}`}</strong><span>{spxOwnerObservationLifecycle(item, clockNow).reason ?? (spxOwnerObservationLifecycle(item, clockNow).status === "ACTIVE" ? "当前有效" : "尚未生效")} · 留证 {safeDate(item.observed_at, "PT")} · 有效至 {item.valid_until ? safeDate(item.valid_until, "PT") : "未填写，不作当前点位"}</span><small>人工留证，不会自动改成新点位；仅作历史研究，不进入TS Forward、v2结算或Broker。</small></article>)}</div></details>)}
        {endedWatches.length > 0 && <details className="proxy-history"><summary>已结束及非当前观测历史（{endedWatches.length}）</summary><div>{endedWatches.map((item) => <article key={item.watch_id}><strong>{item.chain_symbol} {item.expiration_date} {fmtPrice.format(item.strike)} {item.option_type.toUpperCase()}</strong><span>{item.settlement}结算 · {spxWatchLifecycle(item, clockNow).reason ?? "观察尚未开始"} · 有效至 {safeDate(spxWatchLifecycle(item, clockNow).ends_at, "PT")}</span><small>仅保留原始观测审计；不作为当前合约，不产生真实持仓或收益。</small></article>)}</div></details>}
        {(convexity?.history.length ?? 0) > 0 && <details className="proxy-history"><summary>已关闭凸性机会账本（{convexity!.history.length}）</summary><div>{convexity!.history.map((item) => <article key={item.opportunity_id}><strong>{item.trading_date} · {item.direction === "UP" ? "向上" : "向下"} · {convexityStateText[item.state] ?? item.state}</strong><span>冻结候选 {item.candidates.length} · {item.primary_miss_reason ? convexityReasonText[item.primary_miss_reason] ?? item.primary_miss_reason : "窗口完成"}</span><small>{item.executable_multiple_status} · Owner投入/收益均为 $0 · 事后最高只标EXCLUDED_RESEARCH。</small></article>)}</div></details>}
        </DetailSheet>
        <details className="proxy-controls" onToggle={(event) => { if (event.currentTarget.open) void loadSpxChains(); }}><summary>选择观测合约 / 记录我的关键位</summary><div className="proxy-control-grid">
          <form onSubmit={(event) => { event.preventDefault(); void searchSpxContract(); }}><h3>真实 SPX/SPXW 合约</h3><label>链<select value={spxChain} onChange={(event) => { const value = event.target.value as "SPX" | "SPXW", expiry = spxChains.find((item) => item.chain_symbol === value)?.expiration_dates[0] ?? ""; setSpxChain(value); setSpxExpiration(expiry); setSpxValidUntil(contractExpiryLocal(expiry)); setSpxMatch(null); }}><option value="SPXW">SPXW · PM</option><option value="SPX">SPX · AM</option></select></label><label>到期日<select value={spxExpiration} onChange={(event) => { setSpxExpiration(event.target.value); setSpxValidUntil(contractExpiryLocal(event.target.value)); }}><option value="">请选择到期日</option>{expiryOptions.map((value) => <option key={value}>{value}</option>)}</select></label><label>Strike<input inputMode="decimal" type="number" min="0.01" step="0.01" value={spxStrike} onChange={(event) => setSpxStrike(event.target.value)} /></label><label>Put / Call<select value={spxType} onChange={(event) => setSpxType(event.target.value as "call" | "put")}><option value="put">Put</option><option value="call">Call</option></select></label><label>观察有效至<input type="datetime-local" value={spxValidUntil} onChange={(event) => setSpxValidUntil(event.target.value)} /></label><label className="wide">观测单 Owner备注<input maxLength={500} value={spxWatchNote} onChange={(event) => setSpxWatchNote(event.target.value)} /></label><button disabled={spxBusy}>读取精确合约</button>{spxMatch && <button type="button" disabled={spxBusy} onClick={() => void createSpxWatch()}>创建本地观测单</button>}{watch && watch.status !== "ENDED" && <button className="secondary" type="button" disabled={spxBusy} onClick={() => void endSpxWatch()}>结束当前观察</button>}<p>{spxMatch ? `${spxMatch.contract.contract_id} · ${spxMatch.contract.settlement} · ${spxMatch.quote.contract_quote_status ?? spxMatch.quote.status} · source session ${spxMatch.quote.source_session ?? "未返回"} · 报价 ${spxMatch.quote.quoted_at ? safeDate(spxMatch.quote.quoted_at, "PT") : "未返回"}` : "手动查询不会改选 Strike 或标记价内外；报价不可用仍可建立本地观察。"}</p></form>
          <form onSubmit={(event) => void recordOwnerSpxLevel(event)}><h3>Owner 人工观察 SPX 区域</h3><label>类型<select name="kind"><option value="SUPPORT">支撑</option><option value="RESISTANCE">压力</option><option value="LEVEL">单一点位</option></select></label><label>低点<input required name="low" inputMode="decimal" type="number" min="0.01" step="0.01" /></label><label>高点（单点可留空）<input name="high" inputMode="decimal" type="number" min="0.01" step="0.01" /></label><label>有效至<input required name="valid_until" type="datetime-local" /></label><label className="wide">Owner备注<input name="owner_note" maxLength={500} /></label><button disabled={spxBusy}>追加人工观察</button><p>source_mode=OWNER_OBSERVED；不会生成 SPX K线、回填预测或触发交易。</p></form>
        </div></details>
        {spxAction && <p className="proxy-message" data-status={spxAction.status} role={spxAction.status === "FAILED" || spxAction.status === "TIMED_OUT" ? "alert" : "status"}>{spxAction.status} · {spxAction.action_id} · {spxAction.result}</p>}
        {spxMessage && <p className="proxy-message">{spxMessage}</p>}
        <footer><span>SPX现货不可用</span><span>SPY代理确认</span><span>Robinhood官方MCP真实只读期权数据</span><span>Shadow · 不执行交易</span></footer>
      </section>
      <section className="terminal-card" id="chart" aria-labelledby="chart-title">
        <header className="chart-head"><div><p>{symbol} · {intervalText[interval]} · {rangeText[range]}</p><h1 id="chart-title">基础行情与 TS 图层</h1></div><div className="market-state" data-status={effectiveStatus}><span />{ownerMarketText}</div></header>
        <div className="control-deck" aria-label="图表工具"><div className="control-group" aria-label="图表层级"><button id="base-mode" type="button" aria-pressed="false">基础K线</button><button id="ts-toggle" type="button" aria-pressed="true">TS图层</button></div><div className="control-group" aria-label="常用视图操作"><button id="realtime" type="button">回到实时</button></div><details className="more-controls"><summary>更多</summary><div className="control-group" aria-label="更多视图操作"><button id="reset-view" type="button">重置视图</button><button id="reset-price" type="button">价格轴自动</button><button id="forecast-mode" disabled={!model.paths.length} type="button" aria-pressed="false">预测专注</button><button id="rail-toggle" type="button" aria-pressed="true">决策栏</button></div></details><div className="control-group workspace-controls" aria-label="工作区操作"><button id="focus-toggle" type="button" aria-pressed="false">专注看盘</button><button id="fullscreen-toggle" className="icon-button" type="button" aria-label="进入全屏">⛶</button></div></div>
        <details className="mobile-touch-help"><summary>触控帮助</summary><p>单指左右拖动，双指缩放；进入专注看盘后可自由操作图表。</p></details>
        <div className="ratio-control" id="ratio-control" hidden={!model.paths.length}><div className="ratio-presets" aria-label="历史与预测比例"><button type="button" data-ratio="70">历史70 / 预测30</button><button type="button" data-ratio="60" aria-pressed="true">历史60 / 预测40</button><button type="button" data-ratio="50">历史50 / 预测50</button></div><label htmlFor="ratio-slider"><span>拖动调整历史与预测宽度</span><input id="ratio-slider" name="history_ratio" type="range" min="50" max="70" step="1" defaultValue="60" /><output id="ratio-output">历史60% · 预测40%</output></label></div>
        <div className="mode-banner" id="mode-banner" aria-live="polite">{ts ? "概率情景模式 · 路径是范围与备选情景，不是确定走势" : "TS未观察到 · 仅显示真实历史K线"}</div>
        <div className="chart-layout"><div className="chart-stage"><div id="ohlc" className="ohlc-strip" aria-live="polite"><b>{symbol}</b><span>开 —</span><span>高 —</span><span>低 —</span><span>收 —</span><span>量 —</span></div><div id="chart-host" aria-label={`可缩放和平移的 ${symbol} ${intervalText[interval]} Robinhood K线图`} /><svg id="ts-overlay" style={{ display: model.paths.length ? undefined : "none" }} aria-hidden={!model.paths.length} aria-label="TS 场景图层" role="img"><path id="forecast-zone" className="forecast-zone" /><path id="shared-fan" className="shared-fan" /><path id="shared-trunk" className="shared-trunk" />{pathNames.map((name) => <g className="scenario" data-path={name} key={name}><path className="scenario-line" /><g className="scenario-nodes" /></g>)}<g id="time-nodes" /><path id="now-line" className="now-line" /><g id="path-leaders" /></svg><button id="split-handle" hidden={!model.paths.length} className="split-handle" type="button" aria-label="拖动调整历史与预测比例" title="拖动调整历史与预测比例" /><div id="now-label" hidden={!model.paths.length} className="now-label">现在 · TS发布</div><div id="path-labels" className="path-labels" aria-label="路径标签轨道" /><div className="chart-brand" aria-hidden="true">{symbol} · ROBINHOOD</div>{dataNotice && <div className="chart-status-overlay" data-status={effectiveStatus}>{dataNotice}</div>}</div>
          <aside className="decision-rail" aria-label="可收起决策栏">
            {ts ? <><section><span>走势判断 · {forecastTypeLabel}</span><strong>{forecastDisplay.isCurrent ? direction : forecastDisplay.status}</strong><p><b>{forecastDisplay.windowText}</b></p><p>{forecastDisplay.reviewText}</p><p><b>{forecastDisplay.isCurrent ? "未来判断：" : "原预测（仅供参考）："}</b>{ts.one_line_forecast}</p><p>冻结时行情：{ts.current_pattern.summary}</p><p>原判断：{direction} · {ts.symbol_outlooks[symbol].summary}</p></section>
            <section><span>交易资格 · 下一确认窗口</span><strong>{forecastDisplay.isCurrent ? qualification : "原资格仅供参考"}</strong><p>原资格 {qualification} · {qualificationReason}</p></section>
            <section><span>预测证据</span><strong>{evidenceContract.required_total ? <>必需 {evidenceContract.required_available}/{evidenceContract.required_total}</> : "必需证据未上报"}{evidenceContract.enhancement_total ? <> · 增强 {evidenceContract.enhancement_available}/{evidenceContract.enhancement_total}</> : null}</strong><p>{snapshotError ? "核心数据更新暂时失败；保留最近成功冻结证据。" : evidenceContract.next_rth?.state === "NOT_STARTED" ? "尚未到对应交易时段，不计为故障" : "增强证据缺失不阻断正式预测"}</p></section></> : <section><span>走势判断</span><strong>本时段尚无正式预测</strong><p>{contextNote}</p><p>暂时只看真实行情，等待新分析。</p><a href="/settlements#decision-review">查看预测历史与复盘</a></section>}
            <section className="path-picker" hidden={!model.paths.length}><span>尚未校准的场景权重</span>{pathNames.map((name) => <button key={name} type="button" data-select={name} aria-pressed={name === "main"} disabled={!ts}>{pathLabels[name]} {pathProbability(name) === null ? "未观察到" : "未校准 " + pathProbability(name) + "%"}<small className="mobile-path-end">{pathEnd(name) === null ? "终点未观察到" : " · 条件节点 " + fmtPrice.format(pathEnd(name)!)}</small></button>)}</section>
            {ts ? <section><span>关键位置 · 下一检查</span><strong>{nextCheck}</strong><p>支撑 {levelText("support")} · 阻力 {levelText("resistance")} · 失效 {levelText("invalidation")} · 目标 {levelText("target")}</p></section> : null}
            <section><span>边界</span><strong>尚未验证 · 只读观察</strong><p>{ownerMarketText}；尚未证明预测优势，不下单、不改单、不撤单。</p></section>
          </aside></div>
        <footer className="chart-foot"><div className="legend">{model.paths.length ? <><span><i className="main" />主情景</span><span><i className="reverse" />备选情景</span><span><i className="extreme" />极端情景</span><span><i className="fan" />条件情景范围</span></> : null}{vwap !== null ? <span>VWAP {fmtPrice.format(vwap)}</span> : null}</div>{model.paths.length ? <p>情景权重未校准 · 不是确定走势</p> : null}</footer>
      </section>
      <p className="prototype-boundary">Robinhood 官方只读 · {ownerMarketText} · 不执行交易</p>
    </main>
  </div>;
}
