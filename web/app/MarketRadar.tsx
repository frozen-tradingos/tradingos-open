"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { formatPtDateTime } from "./market-time";
import { APPROVED_STOCKS, WATCH_SECTORS, approvedUniverse, type ApprovedCapabilitySnapshot, type ReadonlyMarketSources, type TsOutput } from "./snapshot-import";
import { ownerMarketDecision, ownerObservationDetail, ownerObservationRows } from "./owner-market-decisions";
import type { buildTsForecastDisplay } from "./ts-forecast-state";

type FixedRow = ApprovedCapabilitySnapshot["fixed_pool"]["rows"][number];

const directionText = { BULLISH: "偏多", BEARISH: "偏空", RANGE: "震荡", NOT_OBSERVED: "未观察到" } as const;
const stageText = { DATA_BLOCKED: "数据受阻", WAIT: "结构条件未齐", EARLY_WATCH: "初步观察", CONFIRMED: "结构确认", EXTENDED: "已延伸", INVALIDATED: "已经失效" } as const;
const lifecycleText = { DISCOVERED: "发现", OBSERVING: "观察", WAITING_CONFIRMATION: "仅作结构观察", EXECUTABLE: "冻结时资格通过", HOLDING: "持有", WEAKENING: "减弱", INVALIDATED: "失效", SETTLED: "已结算" } as const;
const relativeText = { INDEPENDENT_STRENGTH: "独立强势", INDEX_FOLLOWING: "跟随指数", LAGGING: "弱于指数", NOT_OBSERVED: "未观察到" } as const;
const timeframeLabels: Array<[keyof FixedRow["timeframes"], string]> = [["daily", "日线"], ["four_hour", "4小时"], ["one_hour", "1小时"], ["thirty_minute", "30分钟"]];
const extendedCapabilityText = { OFFICIAL_OHLCV: "官方完整延长时段 OHLCV", LOCAL_SAMPLED_QUOTE: "本地采样官方报价", RECENT_EOD: "最近可用 EOD", NOT_SUPPORTED: "官方源不支持", READ_FAILED: "官方读取失败" } as const;
const extendedSessionText = { PREMARKET: "盘前", REGULAR: "正常交易时段", AFTER_HOURS: "盘后", OVERNIGHT: "隔夜", CLOSED: "休市" } as const;

function price(value: number | null) {
  return value === null ? "未观察到" : value.toFixed(2);
}

export function MarketDecisionSummary({ currentTs, nextCheck, analysisDisplay, checkStatus, checkAt, regularSession }: { currentTs: TsOutput | null; nextCheck: string; analysisDisplay: ReturnType<typeof buildTsForecastDisplay>; checkStatus: string; checkAt: string | null; regularSession: boolean }) {
  const decision = ownerMarketDecision(currentTs);
  return <article className="overview-card overview-card-full" aria-label="看市场">
    <span>看市场 · 最近完成的盘中分析，不是实时报价</span>
    <p>最近自然检查：{checkAt ? `${formatPtDateTime(checkAt)} · ` : ""}{checkStatus}</p>
    <strong>{decision ? analysisDisplay.isCurrent ? decision.summary : analysisDisplay.status : "当前暂无盘中分析"}</strong>
    {decision ? <>
      <p><b>{analysisDisplay.windowText}</b></p><p>{analysisDisplay.reviewText}</p>
      {!analysisDisplay.isCurrent ? <p>原判断：{decision.summary}</p> : null}
      <p>{analysisDisplay.status}；不能按旧判断或旧价格开仓。</p>
      <p>{decision.symbols.map((item) => `${item.symbol} ${directionText[item.direction]}`).join("；")}。{decision.pattern}</p>
      <p><b>什么情况说明看错：</b>{decision.falsifiers}</p>
      <small>判断冻结于 {formatPtDateTime(decision.frozenAt)}；下一次自然检查：{nextCheck}</small>
      <details><summary>查看理由和原始判断</summary>{decision.symbols.map((item) => <p key={item.symbol}>{item.symbol}：{item.summary}</p>)}<p>最可能看错：{decision.mistake}</p><p>冻结时约定复查：{formatPtDateTime(decision.nextValidation)}</p><code>{decision.forecastId}</code></details>
    </> : <p>{regularSession ? "当前正常交易时段尚无可展示的盘中分析，请以上方最近自然检查结果为准。" : "当前非正常交易时段；下一交易日观察在下方单独展示。"}下一次自然检查：{nextCheck}</p>}
  </article>;
}

export function OwnerOpportunityShortlist({ snapshot, at, nextCheck, currentReadFailed = false, compact = false }: { snapshot?: ApprovedCapabilitySnapshot; at: string | number; nextCheck: string; currentReadFailed?: boolean; compact?: boolean }) {
  const candidates = ownerObservationRows(snapshot);
  if (compact) return <article className="overview-card workspace-opportunities" aria-label="优先观察">
    <header className="workspace-card-heading"><h3>优先观察</h3><span>条件观察 · 不是买卖指令</span></header>
    {candidates.length > 0 ? <table className="workspace-watchlist"><caption className="visually-hidden">优先观察标的、原观察方向、依据与报价状态</caption><thead><tr><th scope="col">标的</th><th scope="col">原观察方向</th><th scope="col">观察依据 / 报价</th></tr></thead><tbody>{candidates.map((row) => {
      const item = ownerObservationDetail(row, at, currentReadFailed);
      return <tr key={row.symbol}><th scope="row">{row.symbol}</th><td>{directionText[item.direction]}</td><td>{item.summary}<br /><small>{item.status}</small></td></tr>;
    })}</tbody></table> : <><strong>{currentReadFailed ? "本次观察读取失败" : "暂无新观察标的"}</strong><p>{currentReadFailed ? "最近采集失败，当前无法核对新候选；请查看系统状态。" : snapshot ? "本次检查没有符合条件的新候选。" : "尚未取得冻结观察；请先查看系统状态中的读取结果。"}</p></>}
    <small>观察冻结于 {snapshot?.generated_at ? formatPtDateTime(snapshot.generated_at) : "未记录"}；下一次自然检查：{nextCheck}</small>
    <a href="/company#owner-opportunities">查看观察条件与依据 <span aria-hidden="true">↗</span></a>
  </article>;
  return <article className="overview-card overview-card-full" aria-label="找机会">
    <span>找机会 · 最多3只条件观察，不是买卖指令</span>
    <strong>{candidates.length ? `优先观察 ${candidates.map((row) => row.symbol).join(" / ")}` : "目前没有可列出的新观察标的"}</strong>
    {candidates.length ? <div className="overview-event-list">{candidates.map((row) => {
      const item = ownerObservationDetail(row, at, currentReadFailed);
      const event = snapshot?.event_scan.items.find((entry) => entry.evidence_state === "VERIFIED" && entry.affected_symbols.includes(row.symbol));
      const earnings = snapshot?.earnings_center.items.find((entry) => entry.symbol === row.symbol);
      return <div key={row.symbol}>
        <b>{row.symbol} · 原观察：{directionText[item.direction]} · {item.status}</b>
        <span>为什么观察：{item.reason}</span>
        <span>观察触发：{item.trigger !== null && item.direction === "BULLISH" ? "向上突破 " : item.trigger !== null && item.direction === "BEARISH" ? "向下跌破 " : ""}{price(item.trigger)}；失效 {price(item.invalidation)}；第一目标 {price(item.target)}</span>
        <small>Robinhood只读快照；报价截至 {row.as_of ? formatPtDateTime(row.as_of) : "未记录"}。{item.quoteFresh ? "报价仍在420秒合同内，但不等于交易获批。" : "这不是当前可执行报价，不可按旧价格操作。"}</small>
        <small>下一次自然检查：{nextCheck}</small>
        <details><summary>还缺什么、相关事件与冻结证据</summary><p>{item.missing.join("；") || "研究条件已列明，仍需独立交易资格与风控审批。"}</p><p>原观察约定：{item.nextCheck ?? "未记录"}</p>{event ? <p>已核验的关联新闻：{event.title}。关联不等于已证明涨跌原因。</p> : null}{earnings ? <p>财报观察：{earnings.why_watch}；{earnings.next_check}</p> : null}<p>观察冻结于 {snapshot ? formatPtDateTime(snapshot.generated_at) : "未记录"}；{row.swing.management?.state_reason ?? row.swing.invalidation}</p></details>
      </div>;
    })}</div> : <p>{snapshot ? "现有冻结候选为空，或只剩持仓、失效及已归档标的；不凑满3只。需要下一次自然数据确认新的观察条件。" : "尚未取得观察池的冻结观察结果，不能凭新闻标题生成买卖机会。"}下一次自然检查：{nextCheck}</p>}
  </article>;
}

function dataState(row: FixedRow | null, unsupported: boolean) {
  if (unsupported) return { code: "NOT_SUPPORTED", title: "官方源不支持", detail: "XSP 在连续官方只读核验中没有返回可用报价和四周期历史；其余 69 个标的不受影响。" };
  if (!row) return { code: "NOT_OBSERVED", title: "尚无数据记录", detail: "尚未保存该标的的官方只读历史，当前不能判断方向。" };
  if (row.status === "LIVE") return { code: "LIVE", title: "冻结时数据正常", detail: "这是快照形成时的官方只读报价与 K 线，不代表现在仍然新鲜。" };
  if (row.status === "MARKET_CLOSED") return { code: "MARKET_CLOSED", title: "最近可用 EOD 数据", detail: "快照采集时为收盘数据；这里保留最近完成交易日的结构，不是当前报价。" };
  if (row.status === "STALE") return { code: "STALE", title: "历史数据已过期", detail: "数据时间早于最近有效交易日，不能据此判断当前走势。" };
  return { code: "DATA_BLOCKED", title: "真正读取失败", detail: row.limitation || "官方只读源没有返回完整报价或 K 线。" };
}

export function MarketRadar({ snapshot, nextCheck, analysisPending = false, currentReadFailed = false, extendedHours }: {
  snapshot?: ApprovedCapabilitySnapshot;
  nextCheck: string;
  analysisPending?: boolean;
  currentReadFailed?: boolean;
  extendedHours?: NonNullable<ReadonlyMarketSources["market_environment"]>["extended_hours"];
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("ALL");
  const [signal, setSignal] = useState("ALL");
  const deferredQuery = useDeferredValue(query.trim().toUpperCase());
  const rows = useMemo(() => new Map(snapshot?.fixed_pool.rows.map((row) => [row.symbol, row])), [snapshot]);
  const universe = approvedUniverse(snapshot?.contract_version), stockCount = universe.filter((symbol) => APPROVED_STOCKS.includes(symbol)).length;
  const [requestedSymbol, setSelectedSymbol] = useState(snapshot?.fixed_pool.candidates[0] ?? universe[0]);
  const selectedSymbol = universe.includes(requestedSymbol) ? requestedSymbol : universe[0];
  const selected = rows.get(selectedSymbol) ?? null;
  const visibleSymbols = universe.filter((symbol) => {
    const row = rows.get(symbol);
    const groupMatch = group === "ALL" || (group === "STOCK" ? APPROVED_STOCKS.includes(symbol) : group === "ETF" ? !APPROVED_STOCKS.includes(symbol) : WATCH_SECTORS.some((sector) => sector.label === group && (sector.symbols as readonly string[]).includes(symbol)));
    const lifecycle = row?.swing.management;
    const signalMatch = signal === "ALL" || (signal === "CANDIDATE" ? snapshot?.fixed_pool.candidates.includes(symbol) : signal === "HOLDING" ? lifecycle?.state === "HOLDING" : signal === "WEAKENING" ? ["WEAKENING", "INVALIDATED"].includes(lifecycle?.state ?? "") : signal === "SETTLED" ? lifecycle?.state === "SETTLED" : signal === "OBSERVED" ? Boolean(row && row.status !== "DATA_BLOCKED") : !row || row.status === "DATA_BLOCKED");
    return groupMatch && signalMatch && (!deferredQuery || symbol.includes(deferredQuery));
  });
  const earnings = snapshot?.earnings_center.items.filter((item) => item.symbol === selectedSymbol) ?? [];
  const events = snapshot?.event_scan.items.filter((item) => item.affected_symbols.includes(selectedSymbol)) ?? [];
  const unsupported = selectedSymbol === "XSP" && Boolean(snapshot?.fixed_pool.missing_symbols.includes("XSP"));
  const state = dataState(selected, unsupported);
  const extended = extendedHours?.instruments.find((item) => item.symbol === selectedSymbol);
  const management = selected?.swing.management;

  return <div className="market-radar" id="market-radar">
    <div className="radar-toolbar">
      <label><span>搜索标的</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如 NVDA" autoComplete="off" /></label>
      <label><span>标的范围</span><select value={group} onChange={(event) => setGroup(event.target.value)}><option value="ALL">全部{universe.length}</option><option value="STOCK">{stockCount}只股票</option><option value="ETF">{universe.length - stockCount}只ETF</option>{WATCH_SECTORS.filter((sector) => sector.symbols.some((symbol) => universe.includes(symbol))).map((sector) => <option key={sector.label} value={sector.label}>{sector.label}</option>)}</select></label>
      <label><span>机会状态</span><select value={signal} onChange={(event) => setSignal(event.target.value)}><option value="ALL">全部状态</option><option value="CANDIDATE">当前重点候选</option><option value="HOLDING">真实持有</option><option value="WEAKENING">减弱 / 失效</option><option value="SETTLED">已结算归档</option><option value="OBSERVED">已有四周期</option><option value="MISSING">缺失 / 不支持</option></select></label>
      <div className="radar-result"><strong>{visibleSymbols.length}</strong><span>个标的</span></div>
    </div>

    <p className="source-note">{snapshot?.contract_version === "v2" ? "当前展示旧70快照；保留原名单与XSP历史，不代表新90池已完成采集。" : snapshot ? "核心70（50只股票、20只ETF）加20只扩展股票；缺失标的继续等待官方自然数据。" : "当前计划观察90个标的：核心70（50只股票、20只ETF）加20只扩展股票，等待首次官方归档。"}</p>

    <div className="radar-layout">
      <nav className="radar-symbols" aria-label={`观察池${universe.length}标的列表`}>
        {visibleSymbols.length ? visibleSymbols.map((symbol) => {
          const row = rows.get(symbol);
          return <button type="button" key={symbol} onClick={() => setSelectedSymbol(symbol)} aria-pressed={symbol === selectedSymbol}>
            <span><b>{symbol}</b><small>{APPROVED_STOCKS.includes(symbol) ? "股票" : "ETF"}</small></span>
            <span><strong>{row ? row.status !== "DATA_BLOCKED" ? directionText[row.direction] : symbol === "XSP" && snapshot?.fixed_pool.missing_symbols.includes("XSP") ? "官方不支持" : "读取失败" : "等待归档"}</strong><small>{row && row.status !== "DATA_BLOCKED" ? row.swing.management ? lifecycleText[row.swing.management.state] : stageText[row.swing.stage] : row ? "没有可用结构" : "尚无官方快照"}</small></span>
          </button>;
        }) : <p className="empty-state">没有符合当前筛选的标的。</p>}
      </nav>

      <article className="radar-detail">
        <div className="radar-data-state">
          <div><span className="status-chip" data-status={currentReadFailed ? "DATA_BLOCKED" : state.code}>{state.title}</span><strong>{currentReadFailed && snapshot ? "最近结构已保留；最近采集失败，不代表当前连接中断" : analysisPending ? "历史结构已保存；分析等待下一自然槽" : snapshot ? "已进入当前冻结分析链" : "尚无可用官方结构"}</strong></div>
          <p>{state.detail}{snapshot ? ` 快照生成：${formatPtDateTime(snapshot.generated_at)}。` : ""}</p>
        </div>
        <header>
          <div><span>观察池{universe.length} · {APPROVED_STOCKS.includes(selectedSymbol) ? "股票" : "ETF"}</span><h3>{selectedSymbol}</h3><p>{selected && selected.status !== "DATA_BLOCKED" ? `${directionText[selected.direction]} · ${management ? lifecycleText[management.state] : stageText[selected.swing.stage]} · ${selected.pattern} / ${selected.state}` : state.detail}</p></div>
          <div className="radar-price"><strong>{selected?.status === "DATA_BLOCKED" ? "无可用报价" : selected ? price(selected.last) : "等待归档"}</strong><span className={(selected?.change_pct ?? 0) >= 0 ? "good-text" : "warn-text"}>{selected?.change_pct === null || selected?.change_pct === undefined ? state.title : `${selected.change_pct >= 0 ? "+" : ""}${selected.change_pct.toFixed(2)}%`}</span><small>{selected?.as_of ? `报价截至 ${formatPtDateTime(selected.as_of)}` : "报价时间未上报"}</small></div>
        </header>

        <div className="radar-timeframes" aria-label={`${selectedSymbol}多周期技术结构`}>
          {timeframeLabels.map(([key, label]) => {
            const frame = selected?.timeframes[key];
            return <section key={key} data-observed={frame?.available ?? false}><span>{label}</span><strong>{frame?.available ? directionText[frame.direction] : state.title}</strong><b>{frame?.available ? `${frame.pattern} · ${frame.state}` : unsupported ? "延长与常规时段均未取得官方历史" : "官方常规时段 K 线不可用"}</b><p>支撑 {frame ? price(frame.support) : "未观察到"} · 阻力 {frame ? price(frame.resistance) : "未观察到"}</p><small>{frame?.available ? `数据截至 ${frame.data_cutoff ? formatPtDateTime(frame.data_cutoff) : "时间未上报"} · 量能 ${frame.volume_context} · 置信度 ${frame.confidence ?? "未评分"}` : frame?.limitation ?? state.detail}</small></section>;
          })}
        </div>

        {management ? <div className="radar-lifecycle" aria-label={`${selectedSymbol}波段持续管理`}>
          <section><span>当前阶段</span><strong data-status={management.state}>{lifecycleText[management.state]}</strong><p>{management.state_reason}</p><small>主要周期 {management.primary_timeframe === "1d" ? "日线" : management.primary_timeframe === "4h" ? "4小时" : "未观察到"} · 已复核 {management.review_count} 次</small></section>
          <section><span>相对强弱</span><strong>{relativeText[management.relative_strength.classification]}</strong><p>{management.relative_strength.reason}</p><small>{management.market_context.regime === "CHOPPY" ? "大盘震荡：只保留独立结构，不追指数反弹" : management.market_context.reason}</small></section>
          <section><span>触发与失效</span><strong>{management.entry_trigger === null ? "日线 / 4小时尚未形成触发价" : `原观察触发 ${price(management.entry_trigger)}`}</strong><p>价格失效 {price(management.price_invalidation)} · 时间失效 {management.time_invalidation_date ?? "未形成"}</p><small>{management.primary_reason}</small></section>
          <section><span>目标与复查</span><strong>{price(management.target_1)} / {price(management.target_2)}</strong><p>第一目标 / 第二目标；没有真实结构位时保持未观察到。</p><small>{management.state === "SETTLED" ? "本次观察已结束" : `下一次自然检查：${nextCheck}`}{management.settlement_reason ? ` · ${management.settlement_reason}` : ""}</small></section>
        </div> : <div className="radar-lifecycle-empty"><strong>等待下一自然槽建立持续波段状态</strong><p>旧四周期结构继续可见，但不会回填生命周期或用 REPLAY 冒充 LIVE。</p></div>}

        <div className="radar-decision">
          <section><span>为什么值得关注</span><p>{selected?.swing.why_watch.join("；") || "当前没有经过多周期门禁的候选理由。"}</p></section>
          <section><span>当前限制</span><p>{management?.missing_confirmation.join("；") || selected?.swing.missing_confirmation.join("；") || (selected ? "四周期结构已经形成，仍需下游独立门禁。" : "尚无四周期结构，当前不能判断方向。")}</p>{snapshot?.fixed_pool.missing_gates?.length ? <p>本观察链未提供执行资格证据：{snapshot.fixed_pool.missing_gates.join("；")}。定时复核会更新结构，不能仅靠等待变成买入批准。</p> : null}</section>
          <section><span>失效与下一检查</span><p>{selected?.swing.invalidation ?? "未观察到可验证失效条件"}</p><b>{management?.state === "SETTLED" ? "本次观察已结束，原记录保留" : nextCheck}</b></section>
        </div>

        <div className="radar-context">
          <section><span>财报</span>{earnings.length ? earnings.map((item) => <p key={item.scheduled_for}><b>{item.scheduled_for.slice(0, 10)} · {item.result_status}</b><br />{item.why_watch || "等待公布后验证"}；还缺：{item.missing_confirmation.join("；") || "无"}</p>) : <p>当前冻结快照没有该标的财报机会或公布后结果。</p>}</section>
          <section><span>重大事件</span>{events.length ? events.map((item) => <p key={item.event_id}><b>{item.title}</b><br />{item.source} · {item.evidence_state} · {item.impact_mapping.join("；") || "影响映射未核验"}</p>) : <p>当前没有通过事件门禁并明确映射到该标的的事件。</p>}</section>
        </div>
        <section className="radar-extended-hours"><span>延长交易时段</span>{extended ? <p><b>{extended.capability ? extendedCapabilityText[extended.capability] : "官方延长时段报价"}</b> · {extended.session ? extendedSessionText[extended.session] : "时段未观察到"} · {price(extended.price)} · {extended.as_of ? `截至 ${formatPtDateTime(extended.as_of)}` : "时间未上报"}。{extended.overnight?.status === "OBSERVED" ? ` 隔夜高/低 ${price(extended.overnight.high)} / ${price(extended.overnight.low)}，相对前收盘 ${extended.overnight.gap_pct === null ? "未观察到" : `${extended.overnight.gap_pct >= 0 ? "+" : ""}${extended.overnight.gap_pct.toFixed(2)}%`}；${extended.overnight.confirmation}` : extended.capability === "NOT_SUPPORTED" ? " XSP 不影响其余69只。" : " 当前交易日尚无隔夜成交，等待官方自然数据。"}</p> : <p>当前标的没有已归档的延长时段证据；等待下一自然槽的官方 24_5 能力清单，不会用样本补齐。</p>}</section>
        <details className="card-details"><summary>查看数据口径与限制</summary><p>观察池{universe.length}的四周期结构来自官方只读行情归档，并保留最近可用 EOD；波段生命周期沿用原批准状态机并永久保留每个自然槽快照。日线和4小时决定核心逻辑，1小时和30分钟只负责确认或减弱。旧数据不会冒充实时，测试和 REPLAY 不会进入这里。</p><code>status={selected?.status ?? "NOT_OBSERVED"}</code> <code>as_of={selected?.as_of ?? "null"}</code> <code>lifecycle_id={management?.lifecycle_id ?? "NOT_OBSERVED"}</code> <code>data_grade={snapshot?.fixed_pool.data_grade ?? "NOT_OBSERVED"}</code></details>
      </article>
    </div>
  </div>;
}
