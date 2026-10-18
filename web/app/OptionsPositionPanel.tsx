import type { OptionLifecycleOverview, OptionStrategySignal, PositionCopilotState, ReadonlyMarketSources } from "./snapshot-import.ts";
import { formatPtDateTime } from "./market-time.ts";
import { nextTimelineOccurrenceOfKind, type ScheduleCheckpoint } from "./timeline-schedule.ts";
import { isHoldingAdviceCurrent } from "./today-action.ts";
import { OwnerPositionPlans } from "./OwnerPositionPlans";
import { OwnerManualPlans } from "./OwnerManualPlans";
import type { projectOwnerManualPlans } from "./owner-manual-plan";
import { DetailSheet } from "./DetailSheet";

const actionText = { OBSERVE: "观察", WAIT: "等待", EXECUTABLE: "可人工执行", NO_TRADE: "不交易", HOLD: "继续持有", REDUCE: "减仓", EXIT: "退出", NOT_SUPPORTED: "暂不支持" } as const;
const strategyText = { LONG_CALL: "买入 Call", LONG_PUT: "买入 Put", CALL_DEBIT_SPREAD: "Call 借记价差", PUT_DEBIT_SPREAD: "Put 借记价差" } as const;
const pathText = { main: "主路径", reverse: "反向路径", extreme: "极端路径" } as const;
const horizonText = { INTRADAY_0_1: "0–1 DTE 日内", SHORT_2_7: "2–7 DTE 短线", SWING_14_60: "14–60 DTE 波段", LONG_90_PLUS: "90+ DTE 长期 / LEAPS", UNCLASSIFIED: "期限待归类" } as const;
const decisionText = { DIRECTION_UNCLEAR: "方向不清楚，当前不选合约", NO_QUALIFIED_CONTRACT: "方向存在，但没有合格合约", PREMIUM_TOO_EXPENSIVE: "方向存在，但权利金或 IV 回落压力过高", SKEW_UNFAVORABLE: "方向存在，但候选 Strike 的 Skew 不划算", EVENT_IV_CRUSH_RISK: "事件后 IV Crush 风险过高", SINGLE_LEG_BLOCKED_SPREAD_ACCEPTABLE: "单腿不合格，借记价差仍可继续审批", ALL_CONTRACTS_REJECTED: "所有真实合约均未通过门禁", QUALIFIED_CONTRACT_WAITING_APPROVAL: "已有合格合约，等待D/A3批准", DEPARTMENT_NO_TRADE: "合约可比较，但D/A3决定不交易", EXECUTABLE: "当时获D/A3批准；当前以有效人工计划为准" } as const;
const outcomeText = { NO_TRADE: "不交易（合法结果）", TARGET_2: "达到第二目标", TARGET_1: "达到第一目标", INVALIDATED: "价格失效", HELD_RANGE: "仍在观察范围", WAIT_DATA: "等待 / 数据不足", OBSERVED: "观察", NOT_SCORABLE: "不可评分", AMBIGUOUS: "同根 K 线先后不明" } as const;
const money = (value: number | null) => value === null ? "未观察到" : `$${value.toFixed(2)}`;
const emptyStrategyText = (strategy: OptionStrategySignal | null) => !strategy
  ? "下一次自然 LIVE 槽会比较 Long Call、Long Put、Call/Put 借记价差；没有完整证据就保持等待。"
  : strategy.data_gaps.length ? strategy.data_gaps.join("；")
    : strategy.owner_action === "NO_TRADE" ? "本槽已完成策略比较，没有候选通过全部门禁；不交易是合法结论。"
      : strategy.change_summary;

export function OptionsPositionPanel({ strategies, positions, lifecycle, tradingDate, currentTime, positionCheck, orders, manualPlans }: { strategies: OptionStrategySignal[]; positions: PositionCopilotState[]; lifecycle: OptionLifecycleOverview; tradingDate: string; currentTime: number; positionCheck?: ScheduleCheckpoint | null; orders?: ReadonlyMarketSources["account"]["orders"]; manualPlans: ReturnType<typeof projectOwnerManualPlans> }) {
  const strategy = strategies.find((item) => item.source_mode === "LIVE") ?? null;
  const positionState = positions.find((item) => item.source_mode === "LIVE") ?? null;
  const nextAnalysis = nextTimelineOccurrenceOfKind(new Date(currentTime), "FULL_ANALYSIS");
  const nextAnalysisText = nextAnalysis ? `${nextAnalysis.scheduled_pt.replace(" PT", " 加州时间")} · ${nextAnalysis.label}` : "下一完整分析槽";
  const staleHoldingCount = positionState?.holdings.filter((holding) => !isHoldingAdviceCurrent(positionState, holding, tradingDate, currentTime)).length ?? 0;
  const currentCandidates = strategy?.candidates.filter((item) => item.expiration >= tradingDate) ?? [];
  const selected = currentCandidates.find((item) => item.candidate_id === strategy?.selected_candidate_id) ?? null;
  const currentBuyPlan = manualPlans.plans.some((plan) => plan.side === "BUY_TO_OPEN" && plan.source_ref === strategy?.signal_id);
  const best = selected ?? currentCandidates.find((item) => item.candidate_id === strategy?.best_candidate_id) ?? null;
  const history = [
    ...strategies.filter((item) => item.source_mode === "LIVE").map((item) => ({ id: item.signal_id, at: item.observed_at, source: "新开仓策略", action: item.owner_action, detail: item.change_summary })),
    ...positions.filter((item) => item.source_mode === "LIVE").flatMap((item) => item.holdings.map((holding) => ({ id: `${item.state_id}:${holding.holding_id}`, at: item.observed_at, source: `${holding.symbol ?? "未知"} 持仓`, action: holding.owner_action, detail: item.change_summary }))),
  ].toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, 20);
  const observedActions = new Set(history.map((item) => item.action));
  const stateMachine = [{ action: "OBSERVE", label: "观察" }, { action: "WAIT", label: "等待" }, { action: "EXECUTABLE", label: "可执行" }, { action: "HOLD", label: "继续持有" }, { action: "REDUCE", label: "减仓" }, { action: "EXIT", label: "退出" }] as const;
  return <section className="options-copilot" aria-label="期权策略与持仓副驾驶">
    <div className="workspace-column">
    <OwnerPositionPlans currentTime={currentTime} positionCheck={positionCheck} />
    <OwnerManualPlans result={manualPlans} />
    </div>
    <div className="workspace-column">
    <DetailSheet className="options-card" title="最近归档的RB订单与真实成交" label="查看最近订单与成交">
      <p>不是完整账户交易史。下单价不等于成交价，撤单不等于亏损；没有精确成交明细就不推算你的实赚或反应速度。</p>
      {orders?.length ? orders.slice(0, 10).map((order, index) => <section key={order.evidence?.order_id ?? `${order.created_at}:${index}`}>
        <h4>{order.symbol ?? "未识别标的"} · {order.state ?? "状态未返回"}</h4>
        <p>创建：{order.created_at ? formatPtDateTime(order.created_at) : "未返回"} · 原请求{order.quantity ?? "—"}份 · 官方已处理{order.evidence?.processed_quantity ?? "未返回"}份（不替代逐笔成交）</p>
        <details className="owner-disclosure"><summary>查看这笔订单的成交与技术证据</summary>
        {order.evidence ? <><p>真实接收：{formatPtDateTime(order.evidence.received_at)} · 脱敏订单ID <code>{order.evidence.order_id ?? "未返回"}</code></p>
          {order.evidence.legs?.map((leg, legIndex) => <div key={leg.leg_id ?? legIndex}>
            <p>合约 {leg.contract_id ?? "未返回"} · {leg.side === "buy" ? "买入" : leg.side === "sell" ? "卖出" : "买卖待核验"} · {leg.position_effect === "open" ? "开仓" : leg.position_effect === "close" ? "平仓" : "开平待核验"}</p>
            {leg.executions?.length ? leg.executions.map((fill, fillIndex) => <p key={fill.execution_id ?? fillIndex}>成交：{fill.executed_at ? formatPtDateTime(fill.executed_at) : "时间未返回"} · {fill.quantity ?? "—"}份 · 单价 {money(fill.price)} · <code>{fill.execution_id ?? "成交ID未返回"}</code></p>) : <p>该腿没有返回逐笔成交，不能拿限价补成成交。</p>}
          </div>)}
        </> : <p>这是旧摘要，没有保留订单ID或逐笔成交；原记录保留，不回填。</p>}
        </details>
      </section>) : <p>尚无归档订单证据，不能据此判断你没有交易。</p>}
    </DetailSheet>
    <article className={currentBuyPlan ? "options-card actionable" : "options-card"}>
      <div className="options-card-heading"><div><span>最近冻结的新开仓研究</span><strong>{currentBuyPlan ? "已有人工核对计划，见上方" : "归档研究，不代表当前可执行"}</strong></div><b data-status={currentBuyPlan ? "EXECUTABLE" : "WAIT"}>{strategy ? "只读 Shadow" : "未观察到"}</b></div>
      {best ? <>
        <h3>{best.symbol} · {strategyText[best.strategy_type]}{selected ? " · 当时批准候选" : " · 当时最优候选"}</h3>
        <p>{horizonText[best.holding_horizon] ?? "期限待归类"} · {best.expiration} 到期 · 最大风险 {money(best.max_risk_usd)} · 盈亏平衡 {best.breakeven?.toFixed(2) ?? "未观察到"}</p>
        <p>{strategy?.decision_basis ? decisionText[strategy.decision_basis] : best.selection_note}</p>
      </> : <p>{strategy?.decision_basis ? decisionText[strategy.decision_basis] : emptyStrategyText(strategy)}</p>}
      <DetailSheet title="新开仓研究 · 合约与依据" label="查看合约门禁、路径与候选明细">
        <p>以下保留当时的策略与审批；当前是否可考虑，只看上方仍在有效期内的买卖计划。</p>
        {best ? <>
        {best.volatility_gate ? <div className="strategy-comparison" aria-label="波动率定价门禁">
          <div><span>IV 是否昂贵</span><b>{best.volatility_gate.price_state === "EXPENSIVE" ? "昂贵" : best.volatility_gate.price_state === "CHEAP" ? "偏低" : best.volatility_gate.price_state === "FAIR" ? "正常区间" : `样本不足（${best.volatility_gate.iv_history.session_count}/20日）`}</b></div>
          <div><span>Skew / 期限结构</span><b>{best.volatility_gate.skew.status === "UNFAVORABLE" ? "Strike Skew 不利" : best.volatility_gate.term_structure.status === "UNFAVORABLE" ? "期限结构不利" : best.volatility_gate.skew.status === "NOT_OBSERVED" ? "真实样本不足" : "未见明显不利"}</b></div>
          <div><span>市场隐含幅度 / TS</span><b>{best.volatility_gate.implied_move.implied_move_pct === null ? "未观察到" : `${best.volatility_gate.implied_move.implied_move_pct.toFixed(2)}% / ${best.volatility_gate.implied_move.ts_main_move_pct?.toFixed(2) ?? "不可比"}%`}</b></div>
          <div><span>IV -20% 压力后</span><b>{money(best.volatility_gate.stress.iv_down_20pct_expected_pnl_usd)}</b></div>
        </div> : null}
        <div className="options-paths">{best.scenario_pnl.map((path) => <div key={path.path}><span>{pathText[path.path]} {path.probability_pct}%</span><b>{money(path.estimated_pnl_usd)}</b><small>标的条件位 {path.target_price?.toFixed(2) ?? "未观察到"}</small></div>)}</div>
        {best.scenario_node_pnl?.length ? <details><summary>查看冻结期限内条件节点及次日路径盈亏</summary>{best.scenario_node_pnl.map((node) => <p key={`${node.window}:${node.path}:${node.node}`}><b>{node.window === "NEXT_SESSION" ? "次日" : "本槽"} · {pathText[node.path]} · {node.node}</b>：标的 {node.target_price.toFixed(2)}，估算 {money(node.estimated_pnl_usd)}</p>)}</details> : null}
        </> : null}
      <div className="strategy-comparison" aria-label="本槽期权策略比较过程">
        <div><span>本槽比较范围</span><b>Long Call / Put 与 Call / Put 借记价差 · 0–1 DTE · 2–7 DTE · 14–60 DTE · 90+ DTE</b></div>
        <div><span>通过数据门禁</span><b>{strategy ? `${currentCandidates.filter((item) => item.status === "PASS").length} / ${currentCandidates.length} 个未到期真实候选` : "等待自然 LIVE 槽"}</b></div>
        <div><span>IV 历史归档</span><b>{strategy?.volatility_summary ? `${strategy.volatility_summary.history_session_count}/20 个交易日 · ${strategy.volatility_summary.archive_status === "READY" ? "可计算历史位置" : "持续积累中"}` : "旧记录未启用"}</b></div>
        <div><span>最终处理</span><b>{strategy ? actionText[strategy.owner_action] : "未观察到"}</b></div>
      </div>
      {currentCandidates.length ? <div className="strategy-candidate-list">{currentCandidates.slice(0, 10).map((item) => <div key={item.candidate_id}><b>{item.symbol} · {strategyText[item.strategy_type]} · {item.holding_horizon ? horizonText[item.holding_horizon] : `${item.dte ?? "—"} DTE`}</b><span>{item.status === "PASS" ? item.selection_note ?? "通过结构门禁" : item.data_gaps[0] ?? "被数据或风险门禁阻断"}</span><small>{item.expiration} · {item.legs[0]?.strike ?? "—"}{item.legs[0]?.option_type === "call" ? "C" : "P"} · Ask成本 {money(item.execution_cost?.entry_at_ask_usd ?? item.max_risk_usd)} · 单边中点滑点 {money(item.execution_cost?.one_way_slippage_from_mid_usd ?? null)} · OI {item.liquidity.minimum_open_interest ?? "未观察到"} · 成交量 {item.liquidity.minimum_volume ?? "未观察到"}</small></div>)}</div> : <p className="empty-state">当前没有未到期、可比较的真实合约候选；旧候选只保留在技术历史。</p>}
      {strategy && <details className="card-details"><summary>查看全部候选与技术字段</summary><p>{strategy.change_summary}</p><p>{strategy.risk_summary ? `盘型 ${strategy.risk_summary.market_type} · 核心硬阻断 ${strategy.risk_summary.core_hard_block_count} · 新开仓阻断 ${strategy.risk_summary.new_entry_block_count} · 单一持仓阻断 ${strategy.risk_summary.position_management_block_count} · 软降级 ${strategy.risk_summary.soft_degrade_count}` : "本字段启用前的历史记录未保存分层风控摘要。"}</p>{strategy.candidates.map((item) => <p key={item.candidate_id}><b>{item.symbol} {strategyText[item.strategy_type]}</b> · {item.status === "PASS" ? "通过结构门禁" : "阻断"} · 最大风险 {money(item.max_risk_usd)} · 概率盈亏 {money(item.expected_pnl_usd)} · 扣除双向 Bid/Ask 后 {money(item.market_edge?.expected_after_spread_usd ?? null)} · {item.data_gaps.join("；") || "无已上报缺口"}</p>)}<code>{strategy.signal_id}</code></details>}
      </DetailSheet>
    </article>
    <article className="options-card">
      <div className="options-card-heading"><div><span>最近冻结的持仓分析</span><strong>{positionState?.holdings.length ? staleHoldingCount ? `${staleHoldingCount} / ${positionState.holdings.length} 项旧建议已停用` : `${positionState.holdings.length} 项冻结持仓记录` : positionState ? "本次分析没有持仓记录" : "尚无持仓分析记录"}</strong></div><b data-status={staleHoldingCount ? "WAIT" : positionState?.holdings.some((item) => item.owner_action === "EXIT") ? "WARNING" : "HEALTHY"}>{staleHoldingCount ? "旧建议不沿用" : "不代替老板操作"}</b></div>
      {positionState?.holdings.filter((holding) => isHoldingAdviceCurrent(positionState, holding, tradingDate, currentTime)).map((holding) => <p key={holding.holding_id}><b>{holding.symbol} · {holding.strike} {holding.option_type} · {holding.expiration}：{actionText[holding.owner_action]}</b> · {holding.explanation}</p>)}
      {staleHoldingCount && positionState ? <p className="source-note">部分建议已过期或条件不一致，不能沿用。下一次：{nextAnalysisText}。</p> : null}
      <DetailSheet title="最近冻结的持仓分析" label="查看冻结持仓分析与历史依据">
      {positionState?.holdings.length ? <div className="holding-list">{positionState.holdings.map((holding) => { const current = isHoldingAdviceCurrent(positionState, holding, tradingDate, currentTime); return <section key={holding.holding_id}>
        <div><h3>{holding.symbol ?? "缺少标的名称"} · {holding.expiration ?? "到期日未上报"} · {holding.strike ?? "—"}{holding.option_type === "call" ? " Call" : holding.option_type === "put" ? " Put" : ""}</h3><strong data-status={current ? holding.owner_action : "WAIT"}>{current ? actionText[holding.owner_action] : "旧建议已停用"}</strong></div>
        {current ? <p>{holding.explanation}</p> : null}
        {holding.holding_intent ? <p>计划复查 {holding.holding_intent.review_on}（加州日期）· 尚无该计划的持有/退出判断</p> : null}
        <DetailSheet title={`${holding.symbol ?? "持仓"} · 原持仓分析与依据`} label="查看原持仓分析与依据">
        <p>冻结于 {formatPtDateTime(positionState.observed_at)}{!current ? "；以下为历史原文，价格和期限不作为当前操作条件。" : ""}</p>
        <p>合约剩余寿命：{holding.dte ?? "未知"} DTE（日历日）。{holding.holding_intent ? `已记录1–3交易日意图；计划复查 ${holding.holding_intent.review_on}（加州日期）。当前只作计划复查，尚无该计划的持有/退出判断。` : "此份冻结分析没有结构化持有意图；DTE分组不代表你准备持有多久。"}</p>
        <p>{holding.quantity ?? "—"} 张 · 成本 {money(holding.average_cost)} · 可卖 Bid {money(holding.bid)} · 退出收益 {holding.exit_return_pct === null ? "未观察到" : `${holding.exit_return_pct.toFixed(2)}%`} · {holding.holding_intent ? "按已记录意图等待计划复查" : `原记录的DTE分组：${holding.holding_horizon ? horizonText[holding.holding_horizon] : `${holding.dte ?? "—"} DTE`}`}</p>
        {holding.horizon_basis ? <p>{holding.horizon_basis}</p> : null}
        {holding.holding_intent ? <p>意图记录于 {formatPtDateTime(holding.holding_intent.recorded_at)}；计划版本 <code>{holding.holding_intent.plan_version_id}</code>。这是本次分析冻结的已匹配计划，不是事前建仓证明。</p> : null}
        <ul><li>原逻辑：{holding.original_logic ?? "现有持仓记录未绑定原始建仓理由，不能倒推"}</li><li>首次发现：{holding.discovery_context ? `${formatPtDateTime(holding.discovery_context.first_seen_at)} · 标的 ${holding.discovery_context.underlying_price?.toFixed(2) ?? "未观察到"} · 期权 ${money(holding.discovery_context.option_mark)} · TS ${holding.discovery_context.ts_path_bias ?? "未观察到"}` : "旧记录没有首次发现冻结上下文"}</li><li>正常震荡参考：{holding.normal_range.low?.toFixed(2) ?? "未观察到"}–{holding.normal_range.high?.toFixed(2) ?? "未观察到"}（标的价格）</li><li>价格 / 时间失效：{holding.price_invalidation?.toFixed(2) ?? "未观察到"} / {holding.time_invalidation?.slice(0, 10) ?? "未观察到"}</li><li>第一 / 第二目标：{holding.target_1?.toFixed(2) ?? "未观察到"} / {holding.target_2?.toFixed(2) ?? "未观察到"}（标的条件位）</li><li>下一检查：{current && holding.next_check_at ? formatPtDateTime(holding.next_check_at) : nextAnalysisText}</li></ul>
        <p>{current ? holding.explanation : `最近冻结动作：${actionText[holding.owner_action]}。原建议已失效或条件尚需复核，等待新自然证据。`}</p><details><summary>查看监控状态与缺口</summary><p>监控 {holding.monitor_status} · 报价 {holding.quote_status} · 截至 {holding.as_of ? formatPtDateTime(holding.as_of) : "未观察到"}{current ? "" : " · 历史冻结"}</p><p>{holding.data_gaps.join("；") || "无已上报缺口"}</p><code>{holding.holding_id}</code></details>
        </DetailSheet>
      </section>; })}</div> : <p>{positionState?.data_gaps.join("；") || "Robinhood 实际持仓会在下一自然盘中槽进入持仓监控；非 SPY/QQQ 持仓会保留但标明暂不支持。"}</p>}
      {positionState && <DetailSheet title="持仓建议变化记录" label="查看建议变化记录"><p>{positionState.change_summary}</p><code>{positionState.state_id}</code></DetailSheet>}
      </DetailSheet>
    </article>
    <article className="options-card options-history">
      <div className="options-card-heading"><div><span>信号状态机与收盘复盘</span><strong>只展示真实发生过的变化</strong></div><b data-status={lifecycle.pending_count ? "WAIT" : "HEALTHY"}>{lifecycle.settled_count} 项已结算</b></div>
      <DetailSheet title="自然状态、历史记录与结算" label="查看历史记录与结算">
      <div className="option-state-machine" aria-label="信号状态完整性">
        {stateMachine.map((item) => <div key={item.action} data-observed={observedActions.has(item.action)}><b>{item.label}</b><small>{observedActions.has(item.action) ? "已在自然 LIVE 历史出现" : "尚未自然发生"}</small></div>)}
      </div>
      <p>NO TRADE 是合法结果；系统不会为了走遍状态或通过验收而制造建议。下面只列最近自然 LIVE 记录，完整原文、上下游引用和哈希永久保存在 SQLite。</p>
      {history.length ? <div className="option-history-list">{history.map((item) => <div key={item.id}><time>{formatPtDateTime(item.at)}</time><b>{item.source} · {actionText[item.action as keyof typeof actionText] ?? item.action}</b><span>{item.detail}</span></div>)}</div> : <p>功能启用后尚未积累自然 LIVE 信号。</p>}
      <h3>收盘后价格与路径复盘（非真实成交）</h3>
      {lifecycle.recent_settlements.length ? <div className="option-settlement-list">{lifecycle.recent_settlements.map((item) => <div key={`${item.source_id}:${item.holding_id ?? "strategy"}`}>
        <b>{item.symbol ?? "SPY / QQQ"} · {actionText[item.action as keyof typeof actionText] ?? item.action} → {outcomeText[item.outcome]}</b>
        <small>{item.path_scoring_version === "FIRST_TERMINAL_V2" ? "按目标与价格失效先后复核" : "旧路径算法 · 原结果保留未更正"}</small>
        {item.observation_window ? <small>当日观察：{item.observation_window.start_at ? formatPtDateTime(item.observation_window.start_at) : "起点未核验"} → {item.observation_window.end_at ? formatPtDateTime(item.observation_window.end_at) : "终点未核验"}；不代表完整持有期</small> : <small>旧观察时段未更正，不能据此确认持有时间合适</small>}
        <span>{item.actual.map((actual) => `${actual.symbol} ${actual.return_pct >= 0 ? "+" : ""}${actual.return_pct.toFixed(2)}%（${actual.low.toFixed(2)}–${actual.high.toFixed(2)}）`).join("；")}</span>
        {item.volatility_result ? <span>期权报价估算变化（非真实成交） {item.volatility_result.actual_option_return_pct === null ? "未观察到" : `${item.volatility_result.actual_option_return_pct.toFixed(2)}%`} · IV变化 {item.volatility_result.iv_change_pct_points === null ? "未观察到" : `${item.volatility_result.iv_change_pct_points.toFixed(2)}点`} · 单腿/价差匹配 {item.volatility_result.path_fit}</span> : null}
        {item.avoidance_assessment ? <span>{item.avoidance_assessment.reason}</span> : null}
        {item.notes.length || item.observation_window?.data_gaps.length ? <details><summary>查看路径说明与数据缺口</summary>{item.notes.map((note, index) => <p key={index}>{note}</p>)}{item.observation_window?.data_gaps.map((gap) => <p key={gap}>{gap}</p>)}</details> : null}
        <small>{item.scoreable ? "可按目标与失效位复核" : "不进入建议准确率"} · {formatPtDateTime(item.settled_at)}</small>
      </div>)}</div> : <p>等待功能启用后的自然 LIVE 建议与完整 Robinhood 当日 K 线；REPLAY 和测试数据不会出现在这里。</p>}
      <details className="card-details"><summary>查看结算范围</summary><p>启用后策略信号 {lifecycle.live_strategy_count} 条，持仓状态 {lifecycle.live_position_state_count} 条；待结算 {lifecycle.pending_count} 项。新结果只使用建议实际入库后、当日收盘或明确时间失效前的完整 K 线；不是整个持有期的评价。第二目标（未设时用第一目标）与价格失效按先发生者判定；同根 K 线触及则先后不明。报价须在有效时段内、结算前已收到，仍不等于真实成交。</p><code>activated_at={lifecycle.activated_at}</code></details>
      </DetailSheet>
    </article>
    </div>
  </section>;
}
