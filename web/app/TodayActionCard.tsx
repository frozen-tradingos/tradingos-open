import type { OptionStrategySignal, PositionCopilotState, TsOutput } from "./snapshot-import.ts";
import { formatPtDateTime } from "./market-time.ts";
import { selectTodayAction, type TodayAction } from "./today-action.ts";

type CommitteeSummary = { summary?: string; evidence_against?: string[] } | null;
type DSummary = { summary?: string; entry_conditions?: string[]; invalidation?: string[] } | null;
type A3Summary = { plain_language?: string } | null;

const actionText: Record<TodayAction, string> = { OBSERVE: "观察", WAIT: "等待", EXECUTABLE: "可执行", HOLD: "继续持有", REDUCE: "减仓", EXIT: "退出" };
const strategyText = { LONG_CALL: "Long Call", LONG_PUT: "Long Put", CALL_DEBIT_SPREAD: "Call 借记价差", PUT_DEBIT_SPREAD: "Put 借记价差" } as const;
const directionText = { BULLISH: "偏涨", BEARISH: "偏跌", RANGE: "震荡", UNKNOWN: "方向未定" } as const;
const marketBoundaryText: Record<string, string> = { MARKET_CLOSED: "市场已收盘", STALE: "行情已过期", DATA_BLOCKED: "行情读取受阻", NOT_OBSERVED: "行情未观察到" };
const holdingPriority = ["EXIT", "REDUCE", "HOLD", "WAIT", "NOT_SUPPORTED"] as const;
const money = (value: number | null) => value === null ? "未观察到" : `$${value.toFixed(2)}`;
const price = (value: number | null) => value === null ? "未形成" : value.toFixed(2);

export function TodayActionCard({ strategy, positions, ts, committee, d, a3, currentSlot, marketStatus, nextRun, strategyUnavailableReason }: {
  strategy: OptionStrategySignal | null;
  positions: PositionCopilotState | null;
  ts: TsOutput | null;
  committee: CommitteeSummary;
  d: DSummary;
  a3: A3Summary;
  currentSlot: string | null;
  marketStatus: string;
  nextRun: { scheduled_pt: string; label: string } | null;
  strategyUnavailableReason: string;
}) {
  const allowNewOpportunity = marketStatus === "LIVE" && Boolean(currentSlot && strategy?.slot_id === currentSlot);
  const selected = allowNewOpportunity && strategy?.owner_action === "EXECUTABLE"
    ? strategy.candidates.find((item) => item.candidate_id === strategy.selected_candidate_id) ?? null
    : null;
  const primary = selectTodayAction(strategy, positions, allowNewOpportunity);
  const marketClosed = marketStatus === "MARKET_CLOSED";
  const highestHolding = selectTodayAction(null, positions).holding;
  const visibleHoldings = (positions?.holdings ?? []).toSorted((left, right) => holdingPriority.indexOf(left.owner_action) - holdingPriority.indexOf(right.owner_action)).slice(0, 3);
  const nextCheck = nextRun ? `${nextRun.scheduled_pt.replace(" PT", " 加州时间")} · ${nextRun.label}` : "尚未排定";
  const noOpportunityReason = marketStatus === "MARKET_CLOSED"
    ? "市场已收盘，旧信号不会继续冒充当前可执行机会。"
    : marketStatus !== "LIVE"
      ? `${marketBoundaryText[marketStatus] ?? "当前行情不可用"}，没有可靠数据时保持等待。`
    : strategy?.slot_id !== currentSlot
      ? strategyUnavailableReason
      : strategy?.data_gaps[0] ?? d?.summary ?? a3?.plain_language ?? "本槽没有候选通过全部数据、流动性和风险门禁。";
  const newAction: TodayAction = selected ? "EXECUTABLE" : strategy?.owner_action === "OBSERVE" && allowNewOpportunity ? "OBSERVE" : "WAIT";
  const mainTarget = selected?.scenario_pnl.find((item) => item.path === "main")?.target_price ?? null;
  const selectedDirection = selected && ts ? directionText[ts.symbol_outlooks[selected.symbol].direction] : "方向未确认";
  const primarySubject = marketClosed ? "市场已收盘 · 当前不交易" : primary.holding
    ? `${primary.holding.symbol ?? "未知标的"} · ${primary.holding.option_type === "call" ? "Call" : primary.holding.option_type === "put" ? "Put" : "期权持仓"}`
    : primary.candidate ? `${primary.candidate.symbol} · ${strategyText[primary.candidate.strategy_type]}` : "暂无合格标的";
  const primaryDirection = marketClosed ? `最后有效倾向：${ts ? directionText[ts.symbol_outlooks.SPY.direction] : "方向未定"} · 下个交易日重新验证` : primary.holding ? primary.holding.option_type === "call" ? "偏多持仓" : primary.holding.option_type === "put" ? "偏空持仓" : "方向未确认" : primary.candidate ? selectedDirection : "方向未确认";
  const primaryReason = marketClosed ? "周五冻结的策略与持仓只作历史参考；下个交易日的新自然证据形成前，不是新的可执行建议。" : primary.holding?.explanation ?? (primary.candidate ? d?.summary ?? a3?.plain_language ?? strategy?.change_summary : noOpportunityReason);
  const primaryAction = marketClosed ? "WAIT" : primary.action;

  return <section className="today-action-card" aria-labelledby="today-action-title">
    <header className="today-action-heading">
      <div><p className="section-kicker">今日行动</p><h2 id="today-action-title">现在先做什么</h2></div>
      <strong data-action={primaryAction}>{actionText[primaryAction]}</strong>
    </header>
    <div className="today-action-priority">
      <span>最高优先级</span><div><strong>{primarySubject}</strong><p>{primaryDirection} · {marketClosed ? "休市冻结参考" : primary.candidate ? "新机会" : primary.holding ? "已有持仓管理优先" : "等待证据完整的自然 LIVE 信号"}</p></div><p>{primaryReason}</p>
    </div>
    <details className="today-action-details">
      <summary>展开机会、持仓与触发证据</summary>
      <div className="today-action-lanes">
      <article>
        <header><div><span>新机会</span><strong>{selected ? `${selected.symbol} · ${strategyText[selected.strategy_type]}` : "当前暂无可执行机会"}</strong></div><b data-action={newAction}>{actionText[newAction]}</b></header>
        <p>{selected ? d?.summary ?? a3?.plain_language ?? strategy?.change_summary : noOpportunityReason}</p>
        <dl>
          <dt>方向</dt><dd>{selected ? selectedDirection : "未形成合格方向"}</dd>
          <dt>为什么</dt><dd>{selected ? committee?.summary ?? d?.summary ?? "已通过现有部门联合复核" : noOpportunityReason}</dd>
          <dt>触发条件</dt><dd>{selected ? d?.entry_conditions?.join("；") || "D 未上报额外触发条件" : "当前没有入场触发条件"}</dd>
          <dt>失效条件</dt><dd>{selected ? d?.invalidation?.join("；") || "D 未上报失效条件" : "尚未进入交易评估"}</dd>
          <dt>目标</dt><dd>{selected ? `主路径标的条件位 ${price(mainTarget)} · 最大风险 ${money(selected.max_risk_usd)}` : "尚未形成"}</dd>
          <dt>下一检查</dt><dd>{nextCheck}</dd>
        </dl>
        {committee?.evidence_against?.length ? <small>反方提醒：{committee.evidence_against[0]}</small> : null}
      </article>
      <article>
        <header><div><span>已有持仓</span><strong>{positions?.holdings.length ? `${positions.holdings.length} 项真实只读持仓` : "当前没有可管理的真实持仓"}</strong></div><b data-action={highestHolding?.owner_action === "EXIT" || highestHolding?.owner_action === "REDUCE" || highestHolding?.owner_action === "HOLD" ? highestHolding.owner_action : "WAIT"}>{highestHolding ? actionText[highestHolding.owner_action === "NOT_SUPPORTED" ? "WAIT" : highestHolding.owner_action] : "等待"}</b></header>
        {positions?.holdings.length ? <><p>最新自然 LIVE 持仓状态截至 {formatPtDateTime(positions.observed_at)}；只读展示，不代替老板操作。</p><div className="today-position-list">{visibleHoldings.map((holding) => <section key={holding.holding_id}>
          <div><strong>{holding.symbol ?? "未知标的"} · {holding.expiration?.slice(0, 10) ?? "到期日未上报"} · {holding.strike ?? "—"}{holding.option_type === "call" ? " Call" : holding.option_type === "put" ? " Put" : ""}</strong><b data-action={holding.owner_action === "NOT_SUPPORTED" ? "WAIT" : holding.owner_action}>{holding.owner_action === "NOT_SUPPORTED" ? "等待" : actionText[holding.owner_action]}</b></div>
          <p>{holding.explanation}</p>
          <dl><dt>正常范围</dt><dd>{price(holding.normal_range.low)}–{price(holding.normal_range.high)}</dd><dt>价格 / 时间失效</dt><dd>{price(holding.price_invalidation)} / {holding.time_invalidation ? formatPtDateTime(holding.time_invalidation) : "未形成"}</dd><dt>第一 / 第二目标</dt><dd>{price(holding.target_1)} / {price(holding.target_2)}</dd><dt>下一检查</dt><dd>{holding.next_check_at ? formatPtDateTime(holding.next_check_at) : nextCheck}</dd></dl>
        </section>)}{positions.holdings.length > visibleHoldings.length ? <small>首页按风险优先显示前 3 项；其余 {positions.holdings.length - visibleHoldings.length} 项请进入策略与持仓页面查看。</small> : null}</div></> : <p>{positions?.data_gaps.join("；") || "Robinhood 当前没有返回可管理持仓；不会猜测建仓逻辑或制造持仓建议。"}</p>}
      </article>
      </div>
    </details>
    <footer><span>只汇总现有 TS、独立评审组、D、A3、期权策略和持仓副驾驶；4070 不执行交易。</span><a href="/options">查看完整策略与持仓依据</a></footer>
  </section>;
}
