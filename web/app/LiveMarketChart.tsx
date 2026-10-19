"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { IChartApi, IPriceLine, ISeriesApi, ISeriesMarkersPluginApi, Time, UTCTimestamp } from "lightweight-charts";
import { forecastFanGeometry, sessionVwapSeries, tsChartOverlay, type ChartBar, type ChartPoint } from "./market-chart";
import type { ApprovedCapabilitySnapshot, ExtendedHoursContext, TsOutput } from "./snapshot-import";
import { formatEtAxisTimestamp, formatEtDateTime, formatPtDateTime } from "./market-time";
import { buildTsForecastState, conditionText, contractConditions } from "./ts-forecast-state";

type SymbolName = "SPY" | "QQQ";
type IntervalName = "1m" | "5m" | "15m";
type RangeName = "1d" | "24h" | "rth" | "gth" | "5d";
type ChartResponse = {
  source: "ROBINHOOD" | "TRADIER" | "NOT_CONFIGURED";
  symbol: SymbolName;
  interval: IntervalName;
  range: RangeName;
  session_bounds: "OFFICIAL_24_5" | "REGULAR_ONLY_EOD_FALLBACK" | "REGULAR_ONLY" | "NOT_OBSERVED";
  data_grade: "OFFICIAL_OHLCV" | "RECENT_OFFICIAL_EOD" | "READ_FAILED";
  session_dates: string[];
  status: "LIVE" | "MARKET_CLOSED" | "STALE" | "DATA_BLOCKED";
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

const pathColors = { main: "#b8e986", reverse: "#6fa8dc", extreme: "#d9955b" } as const;
const statusText = { LIVE: "实时", MARKET_CLOSED: "市场已收盘 · 当日收盘数据", STALE: "数据已过期", DATA_BLOCKED: "数据被阻断" } as const;
const intervalText = { "1m": "1分钟", "5m": "5分钟", "15m": "15分钟" } as const;
const sessionText = { PREMARKET: "盘前", REGULAR: "正常交易时段", AFTER_HOURS: "盘后", OVERNIGHT: "隔夜", CLOSED: "休市" } as const;
const rangeText = { "1d": "当前交易日", "24h": "最近24小时", rth: "RTH", gth: "盘后/GTH", "5d": "近5个交易日" } as const;
const defaultLayers = { vwap: true, paths: true, levels: true, systemA: false, extended: true };
const pathNames = ["main", "reverse", "extreme"] as const;
const ownerText = (value: string) => ({ NOT_OBSERVED: "当前槽未生成", BULLISH: "偏涨", BEARISH: "偏跌", RANGE: "震荡", WAIT: "等待条件", CONDITIONAL: "满足条件后再复核", READY_FOR_D_REVIEW: "可交 D 复核（不是交易批准）" }[value] ?? value);

type SystemARow = ApprovedCapabilitySnapshot["fixed_pool"]["rows"][number];

type PixelPoint = { x: number; y: number };
const linePath = (points: PixelPoint[]) => points.length ? `M ${points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L ")}` : "";
const bandPath = (upper: PixelPoint[], lower: PixelPoint[]) => upper.length > 1 && lower.length > 1 ? `${linePath(upper)} L ${[...lower].reverse().map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L ")} Z` : "";

function ForecastLocalZoom({ model, selectedPath }: { model: ReturnType<typeof chartModel>; selectedPath: typeof pathNames[number] }) {
  const extent = model.fan.priceExtent;
  const points = pathNames.flatMap((name) => model.paths[name].points);
  if (!extent || !points.length || extent.high <= extent.low) return <aside className="forecast-local-zoom forecast-local-zoom-empty"><strong>预测局部放大</strong><span>当前真实路径价格尚未形成可放大的差异。</span></aside>;
  const width = 420, height = 238, left = 46, right = 14, top = 28, bottom = 38;
  const start = Math.min(...points.map((point) => point.time)), end = Math.max(...points.map((point) => point.time));
  const x = (time: number) => left + ((time - start) / Math.max(1, end - start)) * (width - left - right);
  const y = (price: number) => top + ((extent.high - price) / (extent.high - extent.low)) * (height - top - bottom);
  const project = (values: ChartPoint[]) => values.map((point) => ({ x: x(point.time), y: y(point.value) }));
  const nodes = [...new Map(model.nodes.map((node) => [node.time, node])).values()];
  return <aside className="forecast-local-zoom" data-selected-path={selectedPath} data-min-price={extent.low} data-max-price={extent.high} aria-label="预测局部放大，价格未改变">
    <header><strong>预测局部放大</strong><span>价格未改变 · 独立纵轴</span></header>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="同一合同价格的局部放大视图">
      <path className="local-shared-fan" d={bandPath(project(model.fan.sharedUpper), project(model.fan.sharedLower))} />
      <path className="local-shared-trunk" d={linePath(project(model.fan.trunk))} />
      {nodes.map((node) => <g key={node.time}><line className="local-node-line" x1={x(node.time)} x2={x(node.time)} y1={top} y2={height - bottom} /><text className="local-node-label" x={x(node.time)} y={height - 13} textAnchor="middle">{node.label}</text></g>)}
      {pathNames.map((name) => <g key={name} data-path={name} className="local-path">
        <path className="local-range-boundary" d={linePath(project(model.paths[name].upper))} />
        <path className="local-range-boundary" d={linePath(project(model.paths[name].lower))} />
        <path className="local-center-line" d={linePath(project(model.fan.displayPaths[name]))} />
        {model.paths[name].points.slice(1).map((point) => <circle key={point.time} className="local-path-node" data-price={point.value} data-time={point.time} cx={x(point.time)} cy={y(point.value)} r={name === "main" ? 3.5 : 2.5} />)}
      </g>)}
      <text className="local-price-label" x={4} y={top + 4}>{extent.high.toFixed(2)}</text>
      <text className="local-price-label" x={4} y={height - bottom}>{extent.low.toFixed(2)}</text>
    </svg>
    <footer>{pathNames.map((name) => <span key={name} data-path={name}><i />{model.pathMeta[name].label}<b>{model.paths[name].points.at(-1)?.value.toFixed(2) ?? "—"}</b></span>)}</footer>
  </aside>;
}

export function TsForecastCockpit({ outputs, unavailableReason, extendedHours, systemARows }: { outputs: TsOutput[]; unavailableReason: string; extendedHours?: ExtendedHoursContext; systemARows?: SystemARow[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const forecastBoundaryRef = useRef<HTMLButtonElement>(null);
  const phaseRibbonRef = useRef<HTMLDivElement>(null);
  const fanOverlayRef = useRef<SVGSVGElement>(null);
  const nodeOverlayRef = useRef<HTMLDivElement>(null);
  const pathLabelOverlayRef = useRef<HTMLDivElement>(null);
  const overlayUpdateRef = useRef<() => void>(() => undefined);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vwapRef = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const applyRef = useRef<() => void>(() => undefined);
  const modelRef = useRef<ReturnType<typeof chartModel> | null>(null);
  const viewKeyRef = useRef("SPY:5m:24h");
  const fittedViewKeyRef = useRef("");
  const manualViewRef = useRef(false);
  const historyPercentRef = useRef(50);
  const splitDragRef = useRef<{ pointerId: number; left: number; width: number } | null>(null);
  const priceDragRef = useRef<{ pointerId: number; startY: number; from: number; to: number } | null>(null);
  const autoViewRef = useRef<() => void>(() => undefined);
  const layerRef = useRef(defaultLayers);
  const [symbol, setSymbol] = useState<SymbolName>("SPY");
  const [interval, setIntervalName] = useState<IntervalName>("5m");
  const [range, setRange] = useState<RangeName>("24h");
  const [layers, setLayers] = useState(defaultLayers);
  const [fullscreen, setFullscreen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [showDecisionRail, setShowDecisionRail] = useState(true);
  const [showDetails, setShowDetails] = useState(true);
  const [historyPercent, setHistoryPercent] = useState(50);
  const [chartHeight, setChartHeight] = useState<number | null>(null);
  const [selectedPath, setSelectedPath] = useState<typeof pathNames[number]>("main");
  const [localZoom, setLocalZoom] = useState(false);
  const [viewMode, setViewMode] = useState<"AUTO" | "MANUAL">("AUTO");
  const [data, setData] = useState<ChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const forecast = useMemo(() => buildTsForecastState(outputs, symbol), [outputs, symbol]);
  const ts = forecast.today;
  const markManualView = () => {
    if (manualViewRef.current) return;
    manualViewRef.current = true;
    setViewMode("MANUAL");
  };

  useEffect(() => { viewKeyRef.current = `${symbol}:${interval}:${range}`; }, [symbol, interval, range]);
  useEffect(() => { historyPercentRef.current = historyPercent; }, [historyPercent]);
  useEffect(() => { layerRef.current = layers; applyRef.current(); }, [layers]);
  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === workspaceRef.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(`/api/market-chart?symbol=${symbol}&interval=${interval}&range=${range}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json() as ChartResponse | { error?: string };
        if (!response.ok) throw new Error("error" in body && body.error ? body.error : "所选行情源图表读取失败");
        if (active) { setData(body as ChartResponse); setError(null); }
      } catch (requestError) {
        if (active && !(requestError instanceof DOMException && requestError.name === "AbortError")) { setData(null); setError(requestError instanceof Error ? requestError.message : "所选行情源图表读取失败"); }
      } finally { if (active) setLoading(false); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [symbol, interval, range]);

  const model = useMemo(() => chartModel(data, ts, symbol, extendedHours, systemARows), [data, ts, symbol, extendedHours, systemARows]);
  useEffect(() => { modelRef.current = model; applyRef.current(); }, [model]);

  useEffect(() => {
    let active = true;
    let disposeSubscriptions = () => undefined;
    void import("lightweight-charts").then(({ CandlestickSeries, LineSeries, LineStyle, createChart, createSeriesMarkers }) => {
      if (!active || !containerRef.current) return;
      const chart = createChart(containerRef.current, {
        autoSize: true,
        layout: { background: { color: "#0e1316" }, textColor: "#aeb8bf", fontFamily: "Inter, system-ui, sans-serif", fontSize: 14, attributionLogo: true },
        grid: { vertLines: { color: "#20282d" }, horzLines: { color: "#20282d" } },
        rightPriceScale: { borderColor: "#364149", scaleMargins: { top: 0.12, bottom: 0.12 } },
        timeScale: { borderColor: "#364149", timeVisible: true, secondsVisible: false, rightOffset: 8, tickMarkFormatter: (time: Time) => typeof time === "number" ? formatEtAxisTimestamp(time) : String(time) },
        localization: { priceFormatter: (price: number) => price.toFixed(2), timeFormatter: (time: Time) => typeof time === "number" ? formatEtDateTime(time * 1_000) : String(time) },
        crosshair: { vertLine: { color: "#75838c" }, horzLine: { color: "#75838c" } },
        handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true }, mouseWheel: true, pinch: true },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      });
      const candles = chart.addSeries(CandlestickSeries, { upColor: "#78a957", downColor: "#c66d63", borderVisible: false, wickUpColor: "#90bd70", wickDownColor: "#d18178", priceLineVisible: true, lastValueVisible: true });
      const vwap = chart.addSeries(LineSeries, { color: "#e1b96a", lineWidth: 2, title: "VWAP", priceLineVisible: false, lastValueVisible: true });
      const extended = chart.addSeries(LineSeries, { color: "#d9a95d", lineWidth: 2, pointMarkersVisible: true, pointMarkersRadius: 5, title: "延长时段报价", priceLineVisible: false, lastValueVisible: true, autoscaleInfoProvider: () => null });
      const path = () => chart.addSeries(LineSeries, { color: "#00000000", lineWidth: 1, lineStyle: LineStyle.Solid, pointMarkersVisible: false, title: "", priceLineVisible: false, lastValueVisible: false, autoscaleInfoProvider: () => null });
      const paths = {
        main: path(),
        reverse: path(),
        extreme: path(),
      };
      chartRef.current = chart;
      candlesRef.current = candles;
      vwapRef.current = vwap;
      markersRef.current = createSeriesMarkers(candles, []);
      autoViewRef.current = () => {
        const current = modelRef.current;
        if (!current?.candles.length) return;
        const lastCandle = current.candles.at(-1)?.time;
        const boundaryIndex = current.forecastBoundaryTime ? chart.timeScale().timeToIndex(current.forecastBoundaryTime, true) : null;
        const candleIndex = lastCandle ? chart.timeScale().timeToIndex(lastCandle, true) : null;
        const pivot = Number(boundaryIndex ?? candleIndex ?? current.candles.length - 1);
        const historyBars = Math.min(current.candles.length, 90);
        const historyRatio = historyPercentRef.current / 100;
        const futureBars = Math.max(10, Math.round(historyBars * (1 - historyRatio) / historyRatio));
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(-1, pivot - historyBars), to: pivot + futureBars });
      };
      const updateChartOverlays = () => {
        const current = modelRef.current;
        const coordinate = current?.forecastBoundaryTime ? chart.timeScale().timeToCoordinate(current.forecastBoundaryTime) : null;
        if (forecastBoundaryRef.current) {
          forecastBoundaryRef.current.hidden = coordinate === null;
          if (coordinate !== null) forecastBoundaryRef.current.style.left = `${coordinate}px`;
        }
        if (phaseRibbonRef.current) {
          phaseRibbonRef.current.hidden = coordinate === null;
          if (coordinate !== null) phaseRibbonRef.current.style.setProperty("--forecast-x", `${coordinate}px`);
        }
        let previousNodeX = Number.NEGATIVE_INFINITY;
        let nodeRow = 0;
        const nodes = [...(nodeOverlayRef.current?.querySelectorAll<HTMLElement>("[data-node-time]") ?? [])].map((node) => ({ node, x: chart.timeScale().timeToCoordinate(Number(node.dataset.nodeTime) as UTCTimestamp) }));
        for (const { node, x } of nodes) {
          node.hidden = x === null;
          if (x === null) continue;
          nodeRow = x - previousNodeX < 86 ? (nodeRow + 1) % 2 : 0;
          node.dataset.row = String(nodeRow);
          node.style.left = `${x}px`;
          previousNodeX = x;
        }
        const toPixels = (values: ChartPoint[]) => values.flatMap((point) => {
          const x = chart.timeScale().timeToCoordinate(point.time as UTCTimestamp), y = candles.priceToCoordinate(point.value);
          return x === null || y === null ? [] : [{ x: Number(x), y: Number(y) }];
        });
        const setPath = (selector: string, value: string) => fanOverlayRef.current?.querySelector<SVGPathElement>(selector)?.setAttribute("d", value);
        if (current) {
          setPath("[data-fan-shared]", bandPath(toPixels(current.fan.sharedUpper), toPixels(current.fan.sharedLower)));
          setPath("[data-fan-trunk]", linePath(toPixels(current.fan.trunk)));
          for (const name of pathNames) {
            setPath(`[data-fan-center="${name}"]`, linePath(toPixels(current.fan.displayPaths[name])));
            setPath(`[data-fan-upper="${name}"]`, linePath(toPixels(current.paths[name].upper)));
            setPath(`[data-fan-lower="${name}"]`, linePath(toPixels(current.paths[name].lower)));
            const circles = [...(fanOverlayRef.current?.querySelectorAll<SVGCircleElement>(`[data-fan-node="${name}"]`) ?? [])];
            current.paths[name].points.slice(1).forEach((point, index) => {
              const pixel = toPixels([point])[0], circle = circles[index];
              if (!circle) return;
              circle.style.display = pixel ? "" : "none";
              if (pixel) { circle.setAttribute("cx", String(pixel.x)); circle.setAttribute("cy", String(pixel.y)); }
            });
          }
        }
        const labels = [...(pathLabelOverlayRef.current?.querySelectorAll<HTMLElement>("[data-path-name]") ?? [])].flatMap((label) => {
          const name = label.dataset.pathName as "main" | "reverse" | "extreme";
          const point = current?.paths[name].points.at(-1);
          const x = point ? chart.timeScale().timeToCoordinate(point.time) : null;
          const y = point ? candles.priceToCoordinate(point.value) : null;
          return x === null || y === null ? [] : [{ label, name, x: Number(x), y: Number(y) }];
        }).sort((a, b) => a.y - b.y);
        for (const label of pathLabelOverlayRef.current?.querySelectorAll<HTMLElement>("[data-path-name]") ?? []) label.hidden = true;
        const maxY = Math.max(160, (containerRef.current?.clientHeight ?? 0) - 52);
        let previousY = 34;
        const positions = labels.map((item) => {
          const y = Math.max(item.y, previousY + 48);
          previousY = y;
          return { ...item, y };
        });
        const shift = Math.max(0, (positions.at(-1)?.y ?? 0) - maxY);
        for (const item of positions) {
          const y = Math.max(48, item.y - shift);
          const labelWidth = (containerRef.current?.clientWidth ?? 0) < 700 ? 112 : 164;
          const rightX = item.x + 18, leftX = item.x - labelWidth - 18;
          const x = rightX + labelWidth < (containerRef.current?.clientWidth ?? 0) - 8 ? rightX : Math.max(8, leftX);
          item.label.hidden = false;
          item.label.style.left = `${x}px`;
          item.label.style.top = `${y}px`;
          setPath(`[data-label-leader="${item.name}"]`, `M ${item.x.toFixed(1)} ${item.y.toFixed(1)} L ${(x < item.x ? item.x - 10 : item.x + 10).toFixed(1)} ${y.toFixed(1)} L ${(x < item.x ? x + labelWidth : x).toFixed(1)} ${y.toFixed(1)}`);
          previousY = y;
        }
      };
      overlayUpdateRef.current = updateChartOverlays;
      applyRef.current = () => {
        const current = modelRef.current;
        if (!current) return;
        const visible = layerRef.current;
        const visibleBeforeRefresh = manualViewRef.current && fittedViewKeyRef.current === viewKeyRef.current ? chart.timeScale().getVisibleLogicalRange() : null;
        const priceBeforeRefresh = manualViewRef.current ? chart.priceScale("right").getVisibleRange() : null;
        candles.setData(current.candles);
        vwap.setData(current.vwap);
        extended.setData(current.extendedQuote ? [current.extendedQuote.point] : []);
        extended.applyOptions({ title: current.extendedQuote?.label ?? "延长时段报价", visible: visible.extended });
        for (const name of pathNames) paths[name].setData(current.fan.displayPaths[name]);
        vwap.applyOptions({ visible: visible.vwap });
        for (const name of pathNames) paths[name].applyOptions({ title: "", visible: visible.paths });
        for (const line of priceLinesRef.current) candles.removePriceLine(line);
        priceLinesRef.current = [...(visible.levels ? current.levels : []), ...(visible.systemA ? current.systemALevels : [])].map((level) => candles.createPriceLine({ price: level.value, color: level.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: level.label }));
        markersRef.current?.setMarkers(current.forecastMarker ? [{ time: current.forecastMarker, position: "belowBar", shape: "arrowUp", color: "#b8e986", text: "TS预测发布" }] : []);
        if (visibleBeforeRefresh) chart.timeScale().setVisibleLogicalRange(visibleBeforeRefresh);
        else autoViewRef.current();
        if (priceBeforeRefresh) {
          chart.priceScale("right").setAutoScale(false);
          chart.priceScale("right").setVisibleRange(priceBeforeRefresh);
        } else chart.priceScale("right").setAutoScale(true);
        fittedViewKeyRef.current = viewKeyRef.current;
        updateChartOverlays();
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange(updateChartOverlays);
      chart.timeScale().subscribeSizeChange(updateChartOverlays);
      disposeSubscriptions = () => {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(updateChartOverlays);
        chart.timeScale().unsubscribeSizeChange(updateChartOverlays);
      };
      applyRef.current();
    });
    return () => {
      active = false;
      disposeSubscriptions();
      applyRef.current = () => undefined;
      autoViewRef.current = () => undefined;
      overlayUpdateRef.current = () => undefined;
      chartRef.current?.remove();
      chartRef.current = null;
      candlesRef.current = null;
      vwapRef.current = null;
      priceLinesRef.current = [];
      markersRef.current = null;
      fittedViewKeyRef.current = "";
    };
  }, []);

  const vwap = model.vwap.at(-1)?.value ?? null;
  const support = model.levels.find((level) => level.kind === "support")?.value ?? null;
  const resistance = model.levels.find((level) => level.kind === "resistance")?.value ?? null;
  const invalidation = model.levels.find((level) => level.kind === "invalidation")?.value ?? null;
  const target = model.levels.find((level) => level.kind === "target")?.value ?? null;
  const mainTrigger = ts ? contractConditions(ts.scenarios.main.activation).find((condition) => condition.symbol === symbol) ?? null : null;
  const maturity = ts?.evidence_maturity;
  const maturityLabel = maturity ? ({ LOW: "证据仍少", MEDIUM: "证据一般", HIGH: "证据较充分" } as const)[maturity.level] : "当前槽未生成";
  const blocked = !data || data.status === "DATA_BLOCKED";
  const contractMissing = ts ? "TS 合同未上报" : "当前槽未生成";
  const marketMissing = loading ? "正在读取" : error ? "接口读取失败" : data?.status === "STALE" ? "数据已过期" : data?.status === "DATA_BLOCKED" ? "数据源受阻" : "数据源未返回";
  const targetRange = forecast.targetRange ? forecast.targetRange.low === forecast.targetRange.high ? forecast.targetRange.low.toFixed(2) : `${forecast.targetRange.low.toFixed(2)}–${forecast.targetRange.high.toFixed(2)}` : contractMissing;
  const extendedQuote = model.extendedQuote;
  const systemA = model.systemARow;
  const sessionCoverage = Object.entries((data?.bars ?? []).reduce<Record<string, number>>((counts, bar) => { if (bar.session) counts[bar.session] = (counts[bar.session] ?? 0) + 1; return counts; }, {})).map(([name, count]) => `${sessionText[name as keyof typeof sessionText]} ${count}根`).join(" · ") || "SOURCE_GAP";
  const scenarioCards = [
    { label: "主路径", scenario: forecast.main },
    { label: forecast.bullish?.name === "main" ? "偏多路径（主路径）" : "偏多路径", scenario: forecast.bullish },
    { label: forecast.bearish?.name === "main" ? "偏空路径（主路径）" : "偏空路径", scenario: forecast.bearish },
  ];
  const resetRequest = () => {
    manualViewRef.current = false;
    fittedViewKeyRef.current = "";
    setViewMode("AUTO");
    setLoading(true);
    setData(null);
    setError(null);
  };
  const setAutomaticView = () => {
    manualViewRef.current = false;
    setViewMode("AUTO");
    chartRef.current?.priceScale("right").setAutoScale(true);
    autoViewRef.current();
  };
  const showThirtyBars = () => {
    const current = modelRef.current, scale = chartRef.current?.timeScale(), time = current?.candles.at(-1)?.time;
    const end = scale && time ? scale.timeToIndex(time, true) : null;
    if (!scale || end === null) return;
    markManualView();
    scale.setVisibleLogicalRange({ from: Number(end) - 29, to: Number(end) + 1 });
  };
  const scalePrice = (factor: number) => {
    const scale = chartRef.current?.priceScale("right"), visible = scale?.getVisibleRange();
    if (!scale || !visible) return;
    markManualView();
    const middle = (visible.from + visible.to) / 2, half = (visible.to - visible.from) * factor / 2;
    scale.setAutoScale(false);
    scale.setVisibleRange({ from: middle - half, to: middle + half });
    requestAnimationFrame(() => overlayUpdateRef.current());
  };
  const fitReview = () => {
    markManualView();
    chartRef.current?.priceScale("right").setAutoScale(true);
    chartRef.current?.timeScale().fitContent();
  };
  const setSplitRatio = (nextValue: number, commit = true) => {
    const current = modelRef.current, scale = chartRef.current?.timeScale();
    const boundaryTime = current?.forecastBoundaryTime ?? current?.candles.at(-1)?.time;
    const boundaryIndex = scale && boundaryTime ? scale.timeToIndex(boundaryTime, true) : null;
    const visible = scale?.getVisibleLogicalRange();
    if (!scale || boundaryIndex === null || !visible) return;
    const value = Math.round(Math.min(80, Math.max(45, nextValue)));
    const span = Math.max(12, visible.to - visible.from);
    const ratio = value / 100;
    markManualView();
    historyPercentRef.current = value;
    scale.setVisibleLogicalRange({ from: Number(boundaryIndex) - span * ratio, to: Number(boundaryIndex) + span * (1 - ratio) });
    forecastBoundaryRef.current?.setAttribute("aria-valuenow", String(value));
    const output = workspaceRef.current?.querySelector<HTMLOutputElement>("[data-split-output]");
    if (output) output.value = `${value}% 历史 / ${100 - value}% 预测`;
    if (commit) setHistoryPercent(value);
  };
  const startSplitDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    markManualView();
    splitDragRef.current = { pointerId: event.pointerId, left: rect.left, width: rect.width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveSplitDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = splitDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setSplitRatio(((event.clientX - drag.left) / drag.width) * 100, false);
  };
  const endSplitDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (splitDragRef.current?.pointerId !== event.pointerId) return;
    splitDragRef.current = null;
    setHistoryPercent(historyPercentRef.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const splitKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const value = event.key === "ArrowLeft" ? historyPercentRef.current - 5 : event.key === "ArrowRight" ? historyPercentRef.current + 5 : event.key === "Home" ? 45 : event.key === "End" ? 80 : null;
    if (value === null) return;
    event.preventDefault();
    setSplitRatio(value);
  };
  const startPriceDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const visible = chartRef.current?.priceScale("right").getVisibleRange();
    if (!visible) return;
    markManualView();
    priceDragRef.current = { pointerId: event.pointerId, startY: event.clientY, from: visible.from, to: visible.to };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePriceDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = priceDragRef.current, scale = chartRef.current?.priceScale("right");
    if (!drag || drag.pointerId !== event.pointerId || !scale) return;
    const middle = (drag.from + drag.to) / 2;
    const factor = Math.min(4, Math.max(.25, Math.exp((event.clientY - drag.startY) / 180)));
    const half = (drag.to - drag.from) * factor / 2;
    scale.setAutoScale(false);
    scale.setVisibleRange({ from: middle - half, to: middle + half });
    requestAnimationFrame(() => overlayUpdateRef.current());
  };
  const endPriceDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (priceDragRef.current?.pointerId !== event.pointerId) return;
    priceDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resetPriceScale = () => {
    chartRef.current?.priceScale("right").setAutoScale(true);
    requestAnimationFrame(() => overlayUpdateRef.current());
  };
  const priceKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Home") resetPriceScale();
    else if (event.key === "ArrowUp") scalePrice(.85);
    else if (event.key === "ArrowDown") scalePrice(1.18);
    else return;
    event.preventDefault();
  };
  const applyChartHeight = (nextValue: number) => {
    const minimum = window.innerWidth < 600 ? 320 : 420;
    const maximum = Math.min(1200, Math.max(720, Math.round(window.innerHeight * 1.25)));
    const value = Math.round(Math.min(maximum, Math.max(minimum, nextValue)));
    setChartHeight(value);
  };
  const resetChartHeight = () => {
    setChartHeight(null);
  };
  const toggleFullscreen = async () => {
    if (fullscreen) {
      if (document.fullscreenElement) await document.exitFullscreen();
      setFullscreen(false);
      return;
    }
    try { await workspaceRef.current?.requestFullscreen(); } catch { /* CSS fallback covers browsers without element fullscreen. */ }
    setFullscreen(true);
  };

  return <div className="live-market-chart" id="market-chart">
    <div className="forecast-owner-grid">
      <article className="forecast-verdict" data-direction={ts?.symbol_outlooks[symbol].direction ?? "NOT_OBSERVED"}><span>{symbol} 现在的方向</span><strong>{ownerText(forecast.direction)}</strong><p>{ts?.symbol_outlooks[symbol].summary ?? `${unavailableReason}；不根据行情自行猜方向。`}</p></article>
      <article><span>今天是否适合交易</span><strong>{ownerText(forecast.tradeability)}</strong><p>{ts?.tradeability.reason ?? `${unavailableReason}。即使可交 D 复核，也不代表交易批准。`}</p></article>
      <article className="remaining-forecast"><span>今天剩余时间</span><strong>{ts?.one_line_forecast ?? "当前槽未生成"}</strong><p>{ts ? `${ts.current_pattern.summary} · 预测窗口至 ${ts.forecast_window.end_at ? formatPtDateTime(ts.forecast_window.end_at) : ts.forecast_window.end_condition}` : unavailableReason}</p></article>
    </div>
    <div className="forecast-chart-workspace" ref={workspaceRef} data-fullscreen={fullscreen} data-focus={focusMode} data-rail={showDecisionRail} data-details={showDetails} data-view-mode={viewMode} data-selected-path={selectedPath} data-paths={layers.paths} style={chartHeight === null ? undefined : ({ "--chart-height": `${chartHeight}px` } as CSSProperties)}>
      <div className="chart-toolbar">
        <div className="chart-switch" aria-label="选择指数">{(["SPY", "QQQ"] as const).map((name) => <button key={name} type="button" aria-pressed={symbol === name} onClick={() => { if (symbol !== name) { resetRequest(); setSymbol(name); } }}>{name}</button>)}</div>
        <div className="chart-switch" aria-label="选择K线周期">{(["1m", "5m", "15m"] as const).map((name) => <button key={name} type="button" aria-pressed={interval === name} onClick={() => { if (interval !== name) { resetRequest(); setIntervalName(name); } }}>{intervalText[name]}</button>)}</div>
        <div className="chart-switch" aria-label="选择日期范围">{(["1d", "24h", "rth", "gth", "5d"] as const).map((name) => <button key={name} type="button" aria-pressed={range === name} onClick={() => { if (range !== name) { resetRequest(); setRange(name); } }}>{rangeText[name]}</button>)}</div>
        <span className="session-chip">{data?.session_bounds === "OFFICIAL_24_5" ? `官方完整K线 · ${sessionText[data.market_session.phase ?? "CLOSED"]}` : data?.session_bounds === "REGULAR_ONLY_EOD_FALLBACK" ? "最近可用常规时段 EOD" : data?.session_bounds === "REGULAR_ONLY" ? "所选来源 · 仅常规时段5分钟K线" : "所选行情读取失败"}</span>
        <span className="view-mode-chip" data-mode={viewMode}>{viewMode === "AUTO" ? "自动跟随" : "手动视野"}</span>
        <span className="chart-data-state" data-status={data?.status ?? "DATA_BLOCKED"} aria-live="polite">{loading ? "正在读取" : statusText[data?.status ?? "DATA_BLOCKED"]}</span>
      </div>
      <div className="chart-metrics">
        <article><span>当前价格</span><strong>{data?.current_price?.toFixed(2) ?? marketMissing}</strong></article>
        <article><span>当日 VWAP</span><strong>{vwap?.toFixed(2) ?? marketMissing}</strong></article>
        <article><span>支撑</span><strong>{support?.toFixed(2) ?? contractMissing}</strong></article>
        <article><span>阻力</span><strong>{resistance?.toFixed(2) ?? contractMissing}</strong></article>
        <article><span>失效位</span><strong>{invalidation?.toFixed(2) ?? contractMissing}</strong></article>
        <article><span>条件目标</span><strong>{target?.toFixed(2) ?? contractMissing}</strong></article>
      </div>
      <div className="chart-session-strip" data-status={data?.status ?? "NOT_OBSERVED"}>
        <span>当前行情时段</span><strong>{data ? `${sessionText[data.market_session.phase ?? "CLOSED"]} · ${data.data_grade === "OFFICIAL_OHLCV" ? "官方 OHLCV" : data.data_grade === "RECENT_OFFICIAL_EOD" ? "最近 EOD" : "读取失败"}` : "正在确认官方数据"}</strong><small>{data?.session_bounds === "OFFICIAL_24_5" ? `所选来源 24_5 K线 · 交易日 ${data.market_session.trading_date ?? data.market_session.market_date} · ${sessionCoverage}` : data?.error ?? extendedHours?.error ?? "没有可靠数据时不会用样本补齐"}</small>
      </div>
      <div className="chart-trigger-strip"><span>主路径触发</span><strong>{mainTrigger ? conditionText(mainTrigger) : contractMissing}</strong><small>只有满足合同条件并由后续槽确认，路径才继续有效；图中范围不是价格承诺。</small></div>
      <div className="chart-control-row" aria-label="图表操作">
        <div className="layer-controls"><span>图层</span>{([['vwap', 'VWAP'], ['paths', '概率走廊'], ['levels', 'TS关键位'], ['systemA', 'System A结构'], ['extended', '本地采样报价']] as const).map(([name, label]) => { const disabled = name === "systemA" ? !systemA : name === "extended" ? !extendedQuote : false; return <button type="button" key={name} aria-pressed={layers[name]} disabled={disabled} title={disabled ? "本槽没有可绘制的冻结数据" : undefined} onClick={() => setLayers((current) => ({ ...current, [name]: !current[name] }))}>{label}</button>; })}</div>
        <div className="view-controls">
          <button type="button" onClick={showThirtyBars}>约30根K线</button><button type="button" onClick={setAutomaticView}>回到实时</button><button type="button" onClick={setAutomaticView}>重置视图</button><button type="button" onClick={fitReview}>收盘复盘</button><button type="button" aria-pressed={localZoom} disabled={!model.fan.priceExtent} onClick={() => setLocalZoom((value) => !value)}>预测局部放大</button>
        </div>
        <div className="terminal-controls">
          <div className="chart-split-presets" aria-label="历史与预测区域快捷比例"><span>空间</span>{([{ value: 75, label: "历史为主" }, { value: 60, label: "平衡" }, { value: 50, label: "预测为主" }] as const).map((preset) => <button type="button" key={preset.value} aria-pressed={historyPercent === preset.value} onClick={() => setSplitRatio(preset.value)}>{preset.label}</button>)}<output data-split-output>{historyPercent}% 历史 / {100 - historyPercent}% 预测</output></div>
          <button type="button" aria-pressed={showDecisionRail} onClick={() => setShowDecisionRail((value) => !value)}>决策栏</button><button type="button" aria-pressed={showDetails} onClick={() => setShowDetails((value) => !value)}>次要说明</button><button type="button" aria-pressed={focusMode} onClick={() => setFocusMode((value) => !value)}>{focusMode ? "退出专注" : "专注看盘"}</button><button type="button" aria-pressed={fullscreen} onClick={() => void toggleFullscreen()}>{fullscreen ? "退出全屏" : "全屏"}</button>
        </div>
      </div>
      <div className="forecast-stage-grid">
        <div className="chart-frame" onPointerDownCapture={markManualView} onWheelCapture={markManualView} onTouchStartCapture={markManualView}>
          <div ref={containerRef} className="chart-canvas" aria-label={`${symbol} ${intervalText[interval]} 所选行情源K线图`} />
          <div className="chart-phase-ribbon" ref={phaseRibbonRef} hidden aria-hidden="true"><span>真实历史K线</span><span>概率预测区域</span></div>
          <svg className="forecast-fan-overlay" ref={fanOverlayRef} style={{ display: layers.paths ? "block" : "none" }} aria-hidden="true">
            <path className="shared-uncertainty-fan" data-fan-shared="true" />
            <path className="shared-uncertainty-trunk" data-fan-trunk="true" />
            {pathNames.map((name) => <g key={name} className="forecast-fan-path" data-path={name} style={{ color: pathColors[name] }}>
              <path className="forecast-range-boundary" data-fan-upper={name} />
              <path className="forecast-range-boundary" data-fan-lower={name} />
              <path className="forecast-center-line" data-fan-center={name} />
              {model.paths[name].points.slice(1).map((point) => <circle key={point.time} className="forecast-path-node" data-fan-node={name} data-price={point.value} data-time={point.time} r={name === "main" ? 4 : name === "reverse" ? 3.5 : 3} />)}
            </g>)}
            {pathNames.map((name) => <path key={name} className="forecast-label-leader" data-label-leader={name} data-path={name} />)}
          </svg>
          <button type="button" className="forecast-boundary" ref={forecastBoundaryRef} hidden role="slider" aria-label="拖动调整历史K线与预测区域宽度" aria-orientation="horizontal" aria-valuemin={45} aria-valuemax={80} aria-valuenow={historyPercent} onPointerDown={startSplitDrag} onPointerMove={moveSplitDrag} onPointerUp={endSplitDrag} onPointerCancel={endSplitDrag} onKeyDown={splitKeyDown}><b>现在 · TS发布</b><span className="forecast-divider-grip" aria-hidden="true">⋮</span></button>
          <button type="button" className="chart-price-drag" aria-label="上下拖动缩放价格轴，双击恢复自动价格范围" onPointerDown={startPriceDrag} onPointerMove={movePriceDrag} onPointerUp={endPriceDrag} onPointerCancel={endPriceDrag} onDoubleClick={resetPriceScale} onKeyDown={priceKeyDown}><span aria-hidden="true">↕</span><small>价格</small></button>
          <div className="forecast-node-overlay" ref={nodeOverlayRef} aria-hidden="true">{model.nodes.map((node) => <span key={`${node.time}-${node.label}`} data-node-time={node.time}><b>{node.label}</b><small>{formatEtDateTime(node.time * 1_000)}</small></span>)}</div>
          <div className="forecast-path-labels" ref={pathLabelOverlayRef} aria-hidden="true">{pathNames.map((name) => <span key={name} data-path-name={name} data-path={name}><b>{name === "main" ? "主路径" : name === "reverse" ? "反向路径" : "极端路径"} {model.pathMeta[name].probability}</b><small>{model.pathMeta[name].direction}</small></span>)}</div>
          {localZoom && layers.paths ? <ForecastLocalZoom model={model} selectedPath={selectedPath} /> : null}
          {(blocked || error) && <div className="chart-blocked" role="status"><strong>数据被阻断</strong><span>{error ?? data?.error ?? "所选来源没有返回可验证的真实 K 线；未使用模拟数据。"}</span></div>}
        </div>
        <aside className="forecast-decision-rail" aria-label="当前预测摘要">
          <section className="rail-direction" data-direction={ts?.symbol_outlooks[symbol].direction ?? "NOT_OBSERVED"}><span>当前方向</span><strong>{ownerText(forecast.direction)}</strong><p>{ts?.symbol_outlooks[symbol].summary ?? unavailableReason}</p></section>
          <section className="rail-maturity" data-maturity={maturity?.level ?? "NOT_OBSERVED"}><span>证据成熟度</span><strong>{maturityLabel}</strong><p>{maturity?.reason ?? "当前没有可评价的正式 TS 证据。"}</p></section>
          <section className="rail-key-levels"><span>关键位置</span><dl><div><dt>当前价</dt><dd>{data?.current_price?.toFixed(2) ?? marketMissing}</dd></div><div><dt>支撑</dt><dd>{support?.toFixed(2) ?? contractMissing}</dd></div><div><dt>阻力</dt><dd>{resistance?.toFixed(2) ?? contractMissing}</dd></div><div><dt>失效</dt><dd>{invalidation?.toFixed(2) ?? contractMissing}</dd></div><div><dt>目标</dt><dd>{target?.toFixed(2) ?? contractMissing}</dd></div></dl></section>
          <section className="rail-next-check"><span>下一检查</span><strong>{ts ? formatPtDateTime(ts.next_validation.at) : "当前槽未排定"}</strong><p>{ts?.next_validation.purpose ?? unavailableReason}</p></section>
          <section className="rail-risk"><span>边界</span><strong>Shadow 严格只读</strong><p>路径是合同概率范围，不是价格承诺；不下单、不改单、不撤单。</p></section>
        </aside>
      </div>
      <div className="chart-height-control"><label className="chart-height-slider"><strong>拖动调整图表高度</strong><input type="range" min="320" max="1200" step="20" value={chartHeight ?? 600} onInput={(event) => applyChartHeight(Number(event.currentTarget.value))} onChange={(event) => applyChartHeight(Number(event.currentTarget.value))} aria-label="拖动调整图表高度" /><output>{chartHeight === null ? "自动高度" : `${chartHeight}px`}</output></label><button type="button" onClick={resetChartHeight} disabled={chartHeight === null}>恢复自动高度</button></div>
      <p className="chart-gesture-hint">图内横向拖动平移，滚轮、触控板或双指缩放时间；拖动“现在”分割线分配预测空间；右侧“价格”手柄上下拖动缩放纵轴；底边手柄改变图表高度。手动视野会在自动刷新后保持。</p>
      <div className="chart-path-legend" aria-label="TS概率路径图例">{pathNames.map((name) => <button type="button" key={name} data-path={name} aria-pressed={selectedPath === name} onClick={() => setSelectedPath(name)}><i style={{ background: pathColors[name] }} />{model.pathMeta[name].label}</button>)}<span><i className="shared-fan-dot" />共享情景范围</span><span><i className="vwap-dot" />VWAP</span><span className="path-band-note">合同路径范围：共享扇形只绘制一次；单路径上下边界仅来自合同明确范围，不是置信区间</span></div>
      <p className="chart-source">{symbol} · 来源：{data?.source ?? "未配置"} · 只读接口 · Quote：{data?.quote_as_of ? `${formatPtDateTime(data.quote_as_of)} / ${formatEtDateTime(data.quote_as_of)} · ${Math.round(data.quote_freshness_seconds ?? 0)}秒` : marketMissing} · Bar：{data?.bar_as_of ? `${formatPtDateTime(data.bar_as_of)} / ${formatEtDateTime(data.bar_as_of)} · ${Math.round(data.bar_freshness_seconds ?? 0)}秒` : marketMissing} · 横轴：美东交易所时间（含交易日期） · {intervalText[interval]}{interval === "15m" ? "（由真实 5 分钟 K 线聚合）" : "（官方原始周期）"} · {data?.session_dates.length ?? 0} 个交易日 / {data?.bars.length ?? 0} 根真实 K 线 · 数据等级：{data?.data_grade ?? "未观察到"} · {data?.gap_status ?? sessionCoverage} · VWAP 只用常规时段同批 K 线量价计算</p>
      <p className="chart-overlay-note">盘前、正常交易、盘后和隔夜都来自官方 24_5 OHLCV；若 24_5 读取失败，主图只保留最近常规 EOD 并明确降级。隔夜稀疏成交只作次日背景，不改变 TS 合同。</p>
      {systemA && <p className="chart-overlay-note">System A 可选图层：日线 {ownerText(systemA.timeframes.daily.direction)} · 4小时 {ownerText(systemA.timeframes.four_hour.direction)} · 1小时 {ownerText(systemA.timeframes.one_hour.direction)} · 30分钟 {ownerText(systemA.timeframes.thirty_minute.direction)}；只绘制已冻结的支撑与阻力。</p>}
      {!ts && <p className="chart-overlay-note">{unavailableReason}：K 线和 VWAP 可见时继续展示；概率路径与关键位不补造。</p>}
      {ts && (["main", "reverse", "extreme"] as const).some((name) => model.paths[name].points.length < 2) && <p className="chart-overlay-note">部分 TS 场景没有足够的同标的价格条件；对应概率走廊保持未上报，不补值。</p>}
      {ts && <p className="chart-overlay-note">三条条件路径从预测发布时的真实价格分叉；节点只表示合同顺序并限制在冻结预测期限内，横向间距和连接线不是精确时间或价格轨迹。</p>}
      <details className="chart-technical"><summary>查看图表技术信息</summary><code>TS run_id: {ts?.evidence_snapshot.run_id ?? "NOT_OBSERVED"}</code><code>合同版本: {ts?.contract_version ?? "NOT_OBSERVED"}</code><code>时区: {data?.market_session.timezone ?? "America/New_York"}</code><code>市场状态: {data?.market_session.state ?? "NOT_OBSERVED"}</code></details>
    </div>
    <div className="forecast-level-grid" id="forecast-evidence" aria-label={`${symbol} 关键位置`}>
      <article><span>支撑</span><strong>{forecast.support?.toFixed(2) ?? contractMissing}</strong></article>
      <article><span>阻力</span><strong>{forecast.resistance?.toFixed(2) ?? contractMissing}</strong></article>
      <article><span>失效位</span><strong>{forecast.invalidation?.toFixed(2) ?? contractMissing}</strong></article>
      <article><span>目标 / 条件范围</span><strong>{targetRange}</strong></article>
      <article><span>下一检查</span><strong>{ts ? formatPtDateTime(ts.next_validation.at) : "当前槽未排定"}</strong><small>{ts?.next_validation.purpose ?? unavailableReason}</small></article>
    </div>
    <div className="forecast-scenario-grid">
      {scenarioCards.map(({ label, scenario }) => <article key={label}><span>{label}</span><strong>{scenario ? `${scenario.probability_pct}%` : "当前槽未生成"}</strong><b>{scenario ? ownerText(model.pathMeta[scenario.name].direction) : contractMissing}</b><p>{scenario?.summary ?? (ts ? "TS 合同没有上报对应方向的概率路径。" : unavailableReason)}</p><small>合同阈值范围：{scenario && ts ? scenarioThresholdRange(ts, scenario.name, symbol) : contractMissing}</small></article>)}
    </div>
    <div className="forecast-followup-grid">
      <article><span>相比上一槽</span><strong>{ownerText(forecast.changeSummary)}</strong><p>{forecast.previous ? forecast.changes.length ? forecast.changes.join("；") : "方向和三路径概率未发生数值变化。" : ts ? "本交易日尚未积累上一槽可比较。" : unavailableReason}</p></article>
      <article><span>明天初步方向</span><strong>{ownerText(forecast.tomorrowDirection)}</strong><p>{forecast.tomorrow?.one_line_forecast ?? "18:00 下一交易日预判槽尚未到；当前不补造明天方向。"}</p>{forecast.tomorrow && <details><summary>仍待确认的条件</summary><ul>{forecast.tomorrowActivation.length ? forecast.tomorrowActivation.map((item) => <li key={item}>{item}</li>) : <li>主路径合同未上报可复算激活条件。</li>}{forecast.tomorrow.data_gaps.map((item) => <li key={item}>{item}</li>)}</ul></details>}</article>
    </div>
  </div>;
}

function chartModel(data: ChartResponse | null, ts: TsOutput | null, symbol: SymbolName, extendedHours?: ExtendedHoursContext, systemARows?: SystemARow[]) {
  const bars = data?.bars ?? [];
  const extendedColors = { PREMARKET: ["#6887a0", "#516f88"], AFTER_HOURS: ["#9c8152", "#81683f"], OVERNIGHT: ["#756b96", "#62597f"] } as const;
  const candles = bars.map((bar) => {
    const palette = bar.session && bar.session !== "REGULAR" ? extendedColors[bar.session] : null, rising = bar.close >= bar.open, color = palette?.[rising ? 0 : 1];
    return { time: Math.floor(Date.parse(bar.begins_at) / 1_000) as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close, ...(color ? { color, wickColor: color, borderColor: color } : {}) };
  }).filter((bar) => Number.isFinite(bar.time));
  const vwap = sessionVwapSeries(bars).map((point) => ({ time: point.time as UTCTimestamp, value: point.value }));
  const provisional = tsChartOverlay(ts, symbol);
  const anchorBar = provisional.forecastAt === null ? null : candles.filter((bar) => bar.time <= provisional.forecastAt!).at(-1) ?? candles.at(-1) ?? null;
  const overlay = tsChartOverlay(ts, symbol, anchorBar ? { time: Number(anchorBar.time), value: anchorBar.close } : undefined);
  const blankPath = { points: [] as Array<{ time: UTCTimestamp; value: number }>, upper: [] as Array<{ time: UTCTimestamp; value: number }>, lower: [] as Array<{ time: UTCTimestamp; value: number }> };
  const paths = Object.fromEntries((["main", "reverse", "extreme"] as const).map((name) => {
    const path = overlay.paths.find((item) => item.name === name);
    return [name, path ? { points: path.points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })), upper: path.upper.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })), lower: path.lower.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })) } : blankPath];
  })) as Record<"main" | "reverse" | "extreme", typeof blankPath>;
  const rawFan = forecastFanGeometry(overlay.paths);
  const timed = (points: ChartPoint[]) => points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value }));
  const fan = {
    ...rawFan,
    trunk: timed(rawFan.trunk),
    sharedUpper: timed(rawFan.sharedUpper),
    sharedLower: timed(rawFan.sharedLower),
    displayPaths: Object.fromEntries(pathNames.map((name) => [name, timed(rawFan.displayPaths[name])])) as Record<typeof pathNames[number], ReturnType<typeof timed>>,
  };
  const levels = overlay.levels.map((level) => ({ ...level, color: level.kind === "support" ? "#78a957" : level.kind === "resistance" ? "#d9955b" : level.kind === "target" ? "#6fa8dc" : "#c66d63", label: level.kind === "support" ? "支撑" : level.kind === "resistance" ? "阻力" : level.kind === "target" ? "条件目标" : "失效位" }));
  const systemARow = systemARows?.find((row) => row.symbol === symbol && row.status !== "DATA_BLOCKED") ?? null;
  const timeframeNames = { daily: "日线", four_hour: "4小时", one_hour: "1小时", thirty_minute: "30分钟" } as const;
  const systemALevels = systemARow ? Object.entries(systemARow.timeframes).flatMap(([name, frame]) => frame.available ? [
    ...(frame.support === null ? [] : [{ value: frame.support, color: "#648b78", label: `System A ${timeframeNames[name as keyof typeof timeframeNames]}支撑` }]),
    ...(frame.resistance === null ? [] : [{ value: frame.resistance, color: "#8b6f69", label: `System A ${timeframeNames[name as keyof typeof timeframeNames]}阻力` }]),
  ] : []).filter((level, index, all) => all.findIndex((candidate) => candidate.value === level.value && candidate.label === level.label) === index) : [];
  const extended = data?.session_bounds === "REGULAR_ONLY_EOD_FALLBACK" ? extendedHours?.instruments.find((item) => item.symbol === symbol && item.capability === "LOCAL_SAMPLED_QUOTE" && item.as_of && item.price !== null && ["OBSERVED", "STALE"].includes(item.status)) ?? null : null;
  const extendedTime = extended?.as_of ? Math.floor(Date.parse(extended.as_of) / 1_000) : NaN;
  const extendedQuote = extended && Number.isFinite(extendedTime) ? { point: { time: extendedTime as UTCTimestamp, value: extended.price! }, label: `${extended.session ? sessionText[extended.session] : "延长时段"}本地采样`, session: extended.session, status: extended.status, asOf: extended.as_of!, price: extended.price! } : null;
  const forecastBoundaryTime = overlay.paths.find((path) => path.points.length)?.points[0]?.time as UTCTimestamp | undefined ?? null;
  const forecastAnchor = overlay.paths.find((path) => path.points.length)?.points[0]?.value ?? null;
  const forecastMarker = overlay.forecastAt === null ? null : candles.find((bar) => bar.time >= overlay.forecastAt!)?.time ?? null;
  const direction = { BULLISH: "偏多", BEARISH: "偏空", RANGE: "震荡" } as const;
  const pathMeta = Object.fromEntries((["main", "reverse", "extreme"] as const).map((name) => [name, { label: ts ? `${name === "main" ? "主路径" : name === "reverse" ? "反向路径" : "极端路径"} ${ts.scenarios[name].probability_pct}% · ${direction[ts.scenarios[name].bias]}` : name === "main" ? "主路径" : name === "reverse" ? "反向路径" : "极端路径", probability: ts ? `${ts.scenarios[name].probability_pct}%` : "当前槽未生成", direction: ts ? direction[ts.scenarios[name].bias] : "NOT_OBSERVED" }])) as Record<"main" | "reverse" | "extreme", { label: string; probability: string; direction: string }>;
  const nodes = overlay.paths[0]?.nodes ?? [];
  return { candles, vwap, paths, fan, levels, systemALevels, systemARow, extendedQuote, nodes, forecastBoundaryTime, forecastAnchor, forecastMarker, pathMeta };
}

function scenarioThresholdRange(ts: TsOutput, name: "main" | "reverse" | "extreme", symbol: SymbolName) {
  const scenario = ts.scenarios[name];
  const activation = scenario.activation as { conditions?: unknown[] };
  const stages = scenario.sequence as Array<{ conditions?: unknown[] }>;
  const conditions = [...(activation.conditions ?? []), ...stages.flatMap((stage) => stage.conditions ?? [])] as Array<{ symbol?: unknown; value?: unknown; upper_value?: unknown }>;
  const values = conditions.filter((condition) => condition.symbol === symbol).flatMap((condition) => [condition.value, condition.upper_value]).filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  if (!values.length) return "未上报可复算价格阈值";
  const low = Math.min(...values), high = Math.max(...values);
  return low === high ? low.toFixed(2) : `${low.toFixed(2)}–${high.toFixed(2)}`;
}
