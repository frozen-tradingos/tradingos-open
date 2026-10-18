import { formatPtDateTime } from "./market-time";
import type { projectOwnerManualPlans } from "./owner-manual-plan";

const progressText = { WAITING: "条件未齐，暂不开仓", DECLINED: "本轮复核：不做", OWNER_REVIEW: "已形成计划，待你决定", EXPIRED: "上次检查已过期，不能照旧操作" };
function reasonText(reason: string) {
  const setup = new Map([["EQUITY_BARS_INSUFFICIENT_FOR_SETUP", "开盘后的完整K线还不够，只能先列条件预案"], ["STOCK_PATTERN_CLASSIFICATION_UNAVAILABLE", "本次走势还没有完成确认"], ["STOCK_PLANNING_CONTEXT_NOT_OBSERVED", "没有取得该股票的多周期观察依据"]]);
  if (setup.has(reason)) return setup.get(reason)!;
  const code = /^(?:([A-Z][A-Z0-9.-]*)：)?(?:OPTION_|EQUITY_|ACCOUNT_|STOCK_|MARKET_|NO_|DUPLICATE_)[A-Z0-9_]+$/.exec(reason);
  if (code) return `${code[1] ? `${code[1]}：` : ""}官方行情、合约或账户资料未完整取得，需重新检查（技术原因见下方）`;
  return reason.replaceAll("个股原A2", "原走势检查").replaceAll("D/A3", "分析与风险复核").replaceAll("独立D与A3", "独立分析与风险复核");
}

export function OwnerManualPlans({ result, compact = false }: { result: ReturnType<typeof projectOwnerManualPlans>; compact?: boolean }) {
  const progress = result.progress.filter((row) => !result.conditional_plans.some((plan) => plan.source_ref === row.evidence_id));
  return <section className="owner-manual-plans" aria-label="买卖计划与事前预案">
    <h3>买卖计划与事前预案</h3>
    <p>仅网站展示，由你决定是否执行；系统不会下单。研究观点不等于交易批准。</p>
    <details className="owner-disclosure"><summary>查看计划使用说明</summary>
    <p>实际买入后，可到<a href="/options#my-position-plans">我的持仓原计划</a>选择参考来源；系统不会把看过计划当作已经成交。</p>
    <p>指数和个股分别检查。每次自然行情采集结束后，个股独立复核；大盘没有交易机会或缺少原预测，不会直接否决个股。个股仍须通过自己的行情、账户、风险与双复核检查。</p>
    </details>
    {!result.plans.length ? <p><b>当前没有通过全部检查的买卖计划。</b></p> : <p><a href="#owner-ready-plans">有 {result.plans.length} 份计划待你核对，查看条件</a></p>}
    <p>下一次个股复核：{result.next_stock_check ? formatPtDateTime(result.next_stock_check) : "尚未排定"}；不保证形成买单。</p>
    {progress.length ? <div aria-label="个股条件计划进度">{progress.map((row) => <article className="options-card" key={row.evidence_id}>
      <h4>{row.symbol} · {row.direction === "BULLISH" ? "看涨 Call 方向备选" : "看跌 Put 方向备选"}</h4>
      <p><b>{progressText[row.stage]}</b></p>
      <details className="owner-disclosure"><summary>查看条件与未通过的原因</summary>
      <p>检查形成于 {formatPtDateTime(row.observed_at)}；{row.quote_current ? `该次股票报价 $${row.last!.toFixed(2)}，不是保证成交价` : "旧价格不能当作当前报价"}。</p>
      <p>原观察条件：{row.break_level === null ? "尚未形成完整触发价" : `${row.direction === "BULLISH" ? "向上突破" : "向下跌破"} $${row.break_level.toFixed(2)} 后，下一根完整5分钟K线仍保持` }；失效位置：{row.invalidation_price === null ? "尚未形成" : `$${row.invalidation_price.toFixed(2)}`}。价格碰到不等于可以买。</p>
      <p>新闻依据：{row.news.length ? row.news.some((item) => item.verified) ? "已有有效核验记录，仍不证明涨跌原因" : "已收到相关报道，尚无有效核验依据" : "本次没有收到可关联的报道"}；走势确认：{row.structure_confirmed ? "本次已满足原结构条件" : "未满足或已过期"}；独立复核记录：{row.review_count}/2（不是批准数量）。</p>
      {row.reasons.length ? <p>{row.stage === "OWNER_REVIEW" ? "复核理由" : "为什么还不能执行"}：{[...new Set(row.reasons.map(reasonText))].slice(0, compact ? 2 : 4).join("；")}</p> : null}
      <p>下一次个股复核安排：{result.next_stock_check ? formatPtDateTime(result.next_stock_check) : "尚未排定"}；这是预定检查，不保证形成买单。</p>
      <details><summary>查看新闻来源、检查原因和证据</summary>
        {row.news.map((item) => <p key={item.id}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.headline}</a> · {item.source} · {formatPtDateTime(item.published_at)} · {item.verified ? "核验仍有效" : "未核验或已过期"}</p>)}
        <p>{row.reasons.join("；")}</p><p>股票报价源时间：{row.quote_as_of ? formatPtDateTime(row.quote_as_of) : "未取得"}；后续报价不会改写本次证据。</p><code>{row.evidence_id}</code>
      </details>
      </details>
    </article>)}</div> : null}
    {result.conditional_plans.length ? <div aria-label="事前条件计划">{result.conditional_plans.map((plan) => <article className="options-card" key={plan.plan_id} data-plan-stage={plan.stage}>
      <h4>{plan.symbol} · 事前条件计划</h4>
      <p><b>{plan.stage === "EXPIRED" ? "已过期，只供复盘" : "等待条件，暂不执行"}</b> · 不是交易批准</p>
      <details className="owner-disclosure"><summary>查看这份条件计划</summary>
      <p>{plan.expiration} 到期 · 行权价 {plan.strike} · {plan.option_type === "call" ? "Call 看涨期权" : "Put 看跌期权"} · 预设1张</p>
      <dl>
        <div><dt>{plan.stage === "EXPIRED" ? "当时拟定的限价与成本" : "条件成立后的预设最高限价与成本"}</dt><dd>期权限价不高于 ${(plan.max_debit_usd / 100).toFixed(2)}；1张成本上限 ${plan.max_debit_usd.toFixed(2)}（不含费用）。{plan.stage === "EXPIRED" ? "旧限价与旧报价不能用于当前操作" : `本次期权参考价 $${plan.reference_price.toFixed(2)}，不是保证成交价`}</dd></div>
        <div><dt>等待什么条件</dt><dd>{plan.symbol} {plan.option_type === "call" ? "向上突破" : "向下跌破"} ${plan.entry_trigger_price.toFixed(2)}；{plan.entry_conditions.join("；")}</dd></div>
        <div><dt>什么情况放弃</dt><dd>股票失效价 ${plan.invalidation_price.toFixed(2)}；{plan.invalidation.join("；")}</dd></div>
        <div><dt>预设止损 / 首次止盈</dt><dd>{plan.stop_loss_pct}% / {plan.take_profit_pct}%（以实际买入成本为基准，不是已产生的收益）。不能保证止损成交，极端情况下可能损失全部权利金及费用。</dd></div>
        <div><dt>标的第一目标 / 预计持有</dt><dd>股票目标 ${plan.target_price.toFixed(2)}，不是期权卖价；{plan.holding_period}</dd></div>
        <div><dt>还需要确认</dt><dd>{[...new Set(plan.pending_conditions.map(reasonText))].join("；")}。必须收到新证据并通过独立复核，才可能升级；网页碰价不会自动升级或下单。</dd></div>
        <div><dt>证据形成 / 本预案有效到</dt><dd>{formatPtDateTime(plan.observed_at)} / {formatPtDateTime(plan.valid_until)}；过期后不得沿用。</dd></div>
      </dl>
      <p>下一次个股复核安排：{result.next_stock_check ? formatPtDateTime(result.next_stock_check) : "尚未排定"}；这是预定检查，不保证形成买单。</p>
      <details><summary>为什么选这张合约、期限与依据</summary>
        <p>{plan.contract_selection_reason}</p><p>{plan.reasons.join("；")}</p>
        {result.progress.find((row) => row.evidence_id === plan.source_ref)?.news.map((item) => <p key={item.id}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.headline}</a> · {item.source} · {formatPtDateTime(item.published_at)} · {item.verified ? "核验仍有效" : "未核验或已过期"}</p>)}
        <p>原始检查原因：{plan.pending_conditions.join("；")}</p>
        <p>来源：{plan.source_ref} · 复核状态：{plan.approval_ref}</p><p>合约编号：{plan.contract_id}</p><code>{plan.plan_id}</code>
      </details>
      </details>
    </article>)}</div> : null}
    <div id="owner-ready-plans">
    {!result.plans.length ? <details className="owner-disclosure"><summary>查看买卖计划受限原因</summary><p>{[...new Set(result.blocked_reasons.map(reasonText))].join("；")}</p></details> : result.plans.map((plan) => <article className="options-card" key={plan.plan_id}>
      <h4>{plan.symbol} · {plan.side === "SELL_TO_CLOSE" ? "核对原计划，考虑卖出平仓" : "可考虑人工买入开仓"}</h4>
      <p>{plan.expiration}到期 · {plan.strike} {plan.option_type === "call" ? "看涨期权" : "看跌期权"} · {plan.side === "SELL_TO_CLOSE" ? `最多当前持有的${plan.quantity}张，实际退出数量由你确认` : `原批准数量${plan.quantity}张`}</p>
      <dl><div><dt>{plan.trigger_state === "OWNER_CHECK_REQUIRED" ? "仍需你核对触发条件（不是已触发）" : "为什么现在提示"}</dt><dd>{plan.trigger}</dd></div><div><dt>什么情况不能执行</dt><dd>{plan.invalidation.join("；")}</dd></div>
        <div><dt>报价参考</dt><dd>${plan.reference_price.toFixed(2)}，不是保证成交价{plan.max_debit_usd !== null ? `；原批准总成本上限$${plan.max_debit_usd.toFixed(2)}` : ""}</dd></div>
        <div><dt>原计划止损 / 止盈</dt><dd>{plan.stop_loss_pct === null ? "未提供" : `${plan.stop_loss_pct}%`} / {plan.take_profit_pct === null ? "未提供" : `${plan.take_profit_pct}%`}（按原成本）</dd></div>
        <div><dt>第一目标</dt><dd>{plan.first_target}</dd></div><div><dt>预计持有时段</dt><dd>{plan.holding_period}</dd></div>
        <div><dt>本次报价与计划有效到</dt><dd>{formatPtDateTime(plan.valid_until)}；过期后必须重新检查，不能沿用</dd></div></dl>
      <small>执行前在券商确认合约、价格和数量；这里的计划不证明已成交。</small>
      {!compact ? <details><summary>查看依据与计划编号</summary><p>来源：{plan.source_ref} · 审批：{plan.approval_ref}</p><code>{plan.plan_id}</code></details> : null}
    </article>)}
    </div>
  </section>;
}
