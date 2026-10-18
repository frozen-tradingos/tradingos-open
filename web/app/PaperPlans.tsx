import { formatPtDateTime, formatPtTime, isNyseRegularSession, MARKET_5M_MAX_AGE_SECONDS, nextNyseRegularDateAfter, ptDateKey } from "./market-time";
import { PAPER_CODEX_START_DATE, PAPER_DAILY_TARGET, PAPER_RESEARCH_START_DATE, paperChartComparison, paperExpiryClose, paperReportingDay, paperReturnPct, paperTrackingWindow, type PaperChartPoint, type PaperPlanOverview } from "./paper-plan";
import type { MacroEventLearningOverview } from "./macro-event-learning";
import { DetailSheet } from "./DetailSheet";
import { CompanyEvidence } from "./CompanyEvidence";

const percent = (value: number | null) => value === null ? "尚无报价记录" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
const priceFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
const money = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `$${priceFormat.format(value)}`;
const amount = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;
const quoteTime = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? formatPtDateTime(value).replace(/^\d{4}\//, "").replace(" 加州时间", " PT") : "时间未知";
const exitNames = { TAKE_PROFIT: "止盈", STOP_LOSS: "止损", EARNINGS_WINDOW: "财报避险", OFFICIAL_MACRO_WINDOW: "宏观事件避险", VERIFIED_MAJOR_EVENT: "重大事件避险" };
const chartIssueNames = { TIMEOUT: "读取超时", READ_FAILED: "读取失败", NOT_FOUND: "源未返回图点", INVALID_BAR: "图点未通过校验", WAIT_ROTATION: "等待轮次检查", NO_COMPLETED_BAR: "暂无完整交易区间" };
const rate = (value: number | null) => value === null ? "尚不可计算" : `${value.toFixed(1)}%`;
const entryNames = { CONFIRMED: "入场条件已满足", NOT_CONFIRMED: "入场条件未满足", INVALIDATED: "原条件已失效", CONFLICT: "方向证据冲突", DATA_GAP: "入场证据不全" };
const checkNames = { QUOTE: "标的报价", LEVELS: "冻结价位", INVALIDATION: "失效条件", TRIGGER: "触发价", BARS: "完整K线", STRUCTURE: "突破与保持" };
const checkStates = { PASS: "通过", FAIL: "未通过", UNKNOWN: "缺证据", CONFLICT: "冲突", STALE: "已过时" };
const forecastNames = { ALIGNED: "短线方向与计划一致", CONFLICT: "短线方向与计划相反", RANGE: "短线判断为震荡", UNAVAILABLE: "暂无可用的同标的短线对照" };
const backgroundNames = { ALIGNED: "前晚方向与原单一致", CONFLICT: "前晚方向与原单相反", RANGE: "前晚判断为震荡", UNAVAILABLE: "暂无可用的前晚背景" };
const directionNames = { BULLISH: "偏多", BEARISH: "偏空", RANGE: "震荡" };
const chartLabel = (point: PaperChartPoint | null | undefined, contractId: string, missing = "待获取") => point && point.contract_id === contractId && Number.isFinite(point.close) && point.close >= 0 && Number.isFinite(Date.parse(point.begins_at)) && Date.parse(point.ends_at) - Date.parse(point.begins_at) === 300_000 && Date.parse(point.retrieved_at) >= Date.parse(point.ends_at)
  ? `${money(point.close)} · ${quoteTime(point.begins_at).slice(0, 5)} ${formatPtTime(point.begins_at)}–${formatPtTime(point.ends_at)} PT` : missing;

export function PaperPlans({ overview, currentTime, compact = false, todayOnly = false, specialDays = [] }: { overview?: PaperPlanOverview; currentTime: number; compact?: boolean; todayOnly?: boolean; specialDays?: MacroEventLearningOverview["special_days"] }) {
  if (!overview) return <section className="owner-manual-plans" id="paper-plans" aria-label={todayOnly ? "今日模拟单与跟踪" : "完整期权模拟单与跟踪"}>
    <header className="paper-plan-heading"><h3>{todayOnly ? "今日模拟单" : "模拟练习"}</h3></header>
    <p role="status">模拟单记录尚未读取，数量和结果暂未知。读取后再显示原单与统计。</p>
    {compact || todayOnly ? <p><a href="/settlements#research-paper">查看全部模拟单与历史跟踪记录</a></p> : null}
  </section>;
  const plans = overview?.plans ?? [];
  const reportingDay = paperReportingDay(currentTime);
  const paperDay = todayOnly && reportingDay ? { date: ptDateKey(currentTime), label: "今日" } : reportingDay;
  const todayClosed = todayOnly && paperDay !== null && !isNyseRegularSession(paperDay.date);
  const attempt = overview?.latest_attempt;
  const todayAttempt = attempt?.market_date === paperDay?.date && attempt?.event_type === "ATTEMPT" ? attempt : null;
  const todayPlans = overview && paperDay ? plans.filter(({ plan }) => plan.market_date === paperDay.date) : null;
  const todayCount = todayPlans?.filter((row) => row.status !== "VOIDED").length ?? null;
  const todayVoided = todayPlans?.filter((row) => row.status === "VOIDED").length ?? 0;
  const learning = overview?.learning;
  const round = learning?.current_round?.start_date === PAPER_RESEARCH_START_DATE ? learning.current_round : undefined;
  const stats = compact ? learning?.summary : round?.summary, groups = compact ? learning?.groups : round?.groups;
  const eligibleStats = compact ? learning?.eligible_summary : round?.eligible_summary;
  const archivedStats = learning?.archived_summary;
  const baselineStats = groups?.find((group) => group.dimension === "ENTRY_POLICY" && group.label === "原方向研究规则")?.stats;
  const researchStats = groups?.find((group) => group.dimension === "ENTRY_POLICY" && group.label === "每日研究规则")?.stats;
  const qualifiedStats = groups?.find((group) => group.dimension === "ENTRY_POLICY" && group.label === "突破入场规则")?.stats;
  const codexStats = groups?.find((group) => group.dimension === "ENTRY_POLICY" && group.label === "Codex 亲选规则")?.stats;
  const fallbackStats = groups?.find((group) => group.dimension === "ENTRY_POLICY" && group.label === "规则补位")?.stats;
  const indexStats = groups?.find((group) => group.dimension === "RESEARCH_COHORT" && group.label === "指数方法研究")?.stats;
  const planGroups = todayOnly ? [{ archived: false, plans: todayPlans ?? [] }] : compact ? [{ archived: false, plans: plans.slice(0, 3) }] : [
    { archived: false, plans: plans.filter(({ plan }) => plan.market_date >= PAPER_RESEARCH_START_DATE) },
    { archived: true, plans: plans.filter(({ plan }) => plan.market_date < PAPER_RESEARCH_START_DATE) },
  ];
  const todayResults = !compact && todayPlans && learning ? todayPlans.filter((row) => row.status !== "VOIDED").map(({ plan }) => learning.recent_results.find((result) => result.plan_id === plan.plan_id)) : null;
  const todayCounts = todayResults && todayResults.every((result) => result && ["WIN", "LOSS", "FLAT", "PENDING", "UNKNOWN"].includes(result.status))
    ? ["WIN", "LOSS", "FLAT", "PENDING", "UNKNOWN"].map((status) => todayResults.filter((result) => result?.status === status).length) : null;
  const resolved = stats ? stats.wins + stats.losses + (stats.flats ?? 0) : 0;
  return <section className="owner-manual-plans" id="paper-plans" aria-label={todayOnly ? "今日模拟单与跟踪" : "完整期权模拟单与跟踪"}>
    <header className="paper-plan-heading"><h3>{todayOnly ? "今日模拟单" : "模拟练习"}</h3><p>模拟研究 · 非真实盈亏，不是买入批准。</p></header>
    {todayVoided > 0 ? <p role="status">今日另有 {todayVoided} 张已按你的要求作废，停止跟踪；原价与历史结果保留，不计入当前三张目标。</p> : null}
    {todayOnly ? <p><b>{todayClosed ? "今日休市 · 无建单任务" : todayCount === null ? "今日数量尚未确认" : `今日 ${todayCount}/${PAPER_DAILY_TARGET} 张`}</b> · 加州日期 {paperDay?.date ?? "待确认"}{todayClosed ? ` · 每个交易日仍以 ${PAPER_DAILY_TARGET} 张为目标` : ""}</p> : <>
    {compact ? <p><b>{todayCount === null ? "今日数量尚未确认" : `${paperDay!.label} ${todayCount}/${PAPER_DAILY_TARGET} 张`}</b> · {stats ? `规则胜 ${stats.wins} / 负 ${stats.losses} / 平 ${stats.flats ?? 0} · 待定 ${stats.pending} · 结束未知 ${stats.unknown}` : "结果尚未确认"}</p> : <>
      <p><b>{todayCount === null ? "今日数量尚未确认" : `${paperDay!.label} ${todayCount}/${PAPER_DAILY_TARGET} 张`}</b></p>
      <p>{paperDay?.label ?? "今日"}规则结果：{todayCounts ? `胜 ${todayCounts[0]} / 负 ${todayCounts[1]} / 平 ${todayCounts[2]} / 待定 ${todayCounts[3]} / 结束未知 ${todayCounts[4]}` : "未确认"}</p>
    </>}
    <DetailSheet title="模拟统计与计算依据" label="查看模拟统计与计算依据" className="owner-disclosure">
    {(stats?.voided ?? 0) > 0 ? <p>原始统计保留已作废 {stats!.voided} 张及其首次规则结果；作废不抹掉已记录盈亏。{eligibleStats ? `另列剔除作废口径：${eligibleStats.total} 张，胜 ${eligibleStats.wins} / 负 ${eligibleStats.losses} / 平 ${eligibleStats.flats}，胜率 ${rate(eligibleStats.win_rate_pct)}。` : ""}剔除发生在事后，不能据此宣称策略胜率改善。</p> : null}
    {!compact ? <>
      <p>本轮（{PAPER_RESEARCH_START_DATE} 起）：{stats ? `${stats.total} 张 · 规则胜 ${stats.wins} / 负 ${stats.losses} / 平 ${stats.flats ?? 0} · 待定 ${stats.pending} · 结束未知 ${stats.unknown}` : "结果未确认"}</p>
      <p>本轮胜率：{stats ? resolved ? `${rate(stats.win_rate_pct)}（${stats.wins}/${resolved}；胜/已结算）` : "尚不可计算（尚无已结算样本）" : "未确认"}</p>
      <p><b>原方向研究规则：</b>{!groups ? "样本尚未确认" : baselineStats ? `${baselineStats.total} 张 · 胜 ${baselineStats.wins} / 负 ${baselineStats.losses} / 平 ${baselineStats.flats ?? 0} · 待定 ${baselineStats.pending} · 观察胜率 ${rate(baselineStats.win_rate_pct)}` : "尚无自然建单样本"}。本轮历史汇总包含其他规则与旧观察基线，不能当作新规则成绩。</p>
      {codexStats ? <p><b>Codex 亲选规则：</b>{codexStats.total} 张 · 胜 {codexStats.wins} / 负 {codexStats.losses} / 平 {codexStats.flats ?? 0} · 待定 {codexStats.pending} · 观察胜率 {rate(codexStats.win_rate_pct)}；仅统计 Codex 实际选出的样本。</p> : null}
      {fallbackStats ? <p><b>规则补位：</b>{fallbackStats.total} 张 · 胜 {fallbackStats.wins} / 负 {fallbackStats.losses} / 平 {fallbackStats.flats ?? 0} · 待定 {fallbackStats.pending} · 观察胜率 {rate(fallbackStats.win_rate_pct)}；与 Codex 亲选分开统计。</p> : null}
      <p><b>每日研究规则：</b>{!groups ? "样本尚未确认" : researchStats ? `${researchStats.total} 张 · 胜 ${researchStats.wins} / 负 ${researchStats.losses} / 平 ${researchStats.flats ?? 0} · 待定 ${researchStats.pending} · 观察胜率 ${rate(researchStats.win_rate_pct)}` : "尚无自然建单样本"}；保留原规则与结果，独立统计。</p>
      {qualifiedStats ? <p><b>突破入场规则：</b>{qualifiedStats.total} 张 · 胜 {qualifiedStats.wins} / 负 {qualifiedStats.losses} / 平 {qualifiedStats.flats ?? 0} · 待定 {qualifiedStats.pending} · 观察胜率 {rate(qualifiedStats.win_rate_pct)}；保留原规则与结果，独立统计。</p> : null}
    </> : null}
    {stats ? <p>{resolved < 20 || stats.resolved_days < 5 ? "样本不足，暂不能判断哪类更好。" : "分组差异只供研究，尚未证明优势。"}</p> : null}
    {stats && learning ? <>
      <p><b>{compact ? "" : "本轮"}模拟规则观察胜率：{rate(stats.win_rate_pct)}</b>；{compact ? "全部历史" : "本轮"} {stats.total} 张，胜 {stats.wins} / 负 {stats.losses} / 平 {stats.flats ?? 0}，分母 {resolved}；待定 {stats.pending}，结束未知 {stats.unknown}。已结算中风控提前退出 {stats.risk_exits ?? 0} 张；持平计入分母但不算胜。{resolved < 20 || stats.resolved_days < 5 ? "样本不足，暂不能判断哪类更好。" : "分组差异仅供提出后续研究假设，尚未证明优势。"}</p>
    </> : <p><b>{compact ? "模拟胜率统计读取中，结果未知。" : "本轮模拟胜率统计读取中，结果未确认。"}</b></p>}
    {stats && learning ? <>
      <details><summary>模拟结果统计与学习方法</summary>
        <p>每张单在建单时固定规则：普通日 +30% / -40%，已核验特殊日的新单试行 +10% / -10%，旧单保持原规则。沿不可改写的采样记录顺序，首次实际观察到期权 Bid 相对原始 Ask 达到该单阈值，或带有有效事件风控退出依据时，固定一次模拟结果；回报使用那次实际 Bid，不假定恰好在阈值成交。同次采样同时符合时优先记止盈或止损。建单当天规则退出后继续按原频率采样，次日起在收盘前一小时内每天最多尝试一次研究复盘，后续反弹或下跌不改原胜负、不计入原胜率。尚未结算的活跃单为待定，观察结束仍未结算记未知，均不进入胜率分母。结束研究不是实际卖出，真实持仓独立管理。</p>
        <p>特殊日覆盖官方日历中的 FOMC、CPI、PPI、非农、PCE 和 GDP。特殊日建单 Ask→Bid 损耗达到 10% 的合约跳过；当天性质无法核实时暂停新建，已有单继续跟踪。同日多个事件分别保留，不预测涨跌方向。</p>
        <p>新单按原冻结分析方向和候选排名选单，保留真实双边报价和合约身份校验；特殊日独立使用 +10% / -10%。9/25 08:58 PT 起的新单还须通过价差不超过中间价5%且不超过$0.15、正Bid与持仓量、完整成交量和Greeks检查；开盘成交量0本身不等于无人交易。此前记录保持原规则，不按新门槛追罚。</p>
        <p>财报按最新日历的公布窗口、官方重大宏观事件按公布前90分钟、已核验突发事件按明确影响范围作模拟风险退出；不是预测事件方向，也不是实际卖单。没有当前日程或有效报价时保持待定，报价缺口如实保留。风控退出按当时盈亏记胜、负或平，不因“避险”就算赢；原有历史结果不回填。</p>
        <p>这是采样观察结果，不是连续行情的首次触及、实际成交或正式交易胜率。历史采样有间隔，缺口不补造；当前浮盈不计胜。{compact ? "统计覆盖全部历史模拟单，不限于下方列表。" : `统计与分组仅覆盖 ${PAPER_RESEARCH_START_DATE} 起建单的本轮模拟单，不限于下方列表；旧单不进入本轮胜率。`}</p>
        <p>规则结果覆盖 {stats.resolved_days} 个建单交易日；平均观察回报 {rate(stats.average_return_pct)}；金额加权盈利因子 {stats.profit_factor === null ? "尚不可计算" : stats.profit_factor.toFixed(2)}（观察盈利金额合计 ÷ 观察亏损金额绝对值合计，未扣费用）；判定前已记录采样缺口的单 {stats.gap_count} 张（含待定和未知单）；平均原始价差 {rate(stats.average_entry_spread_pct)}（价差占原始 Ask，分组使用同一口径）。胜率不能单独说明盈亏。</p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderSpacing: "8px", textAlign: "left" }}>
            <caption>按原始建单条件及最终退出原因分组</caption>
            <thead><tr><th scope="col">分组</th><th scope="col">总数</th><th scope="col">胜 / 负 / 平 / 待定 / 未知</th><th scope="col">胜率</th><th scope="col">平均观察回报</th><th scope="col">有缺口</th></tr></thead>
            <tbody>{groups?.map((group) => <tr key={`${group.dimension}:${group.label}`}><th scope="row">{{ DIRECTION: "方向", ENTRY_SPREAD: "原始价差", DTE: "原始到期天数", EXIT_REASON: "退出原因", RISK_POLICY: "阈值规则", ENTRY_POLICY: "建单规则", RESEARCH_COHORT: "研究分组" }[group.dimension]} · {group.label}</th><td>{group.stats.total}</td><td>{group.stats.wins} / {group.stats.losses} / {group.stats.flats ?? 0} / {group.stats.pending} / {group.stats.unknown}</td><td>{rate(group.stats.win_rate_pct)}</td><td>{rate(group.stats.average_return_pct)}</td><td>{group.stats.gap_count}</td></tr>)}</tbody>
          </table>
        </div>
        <p>学习时比较方向、原始价差（≤5%、5–10%、&gt;10%）、建单资格和建单时剩余到期天数（≤30、31–90、&gt;90天）。至少20个规则结果、覆盖5个建单交易日仅是开始讨论的粗略门槛，不代表统计显著。用之后符合条件的新模拟单检验假设；不会自动改写原单、止损止盈或买入规则。</p>
      </details>
    </> : null}
    </DetailSheet>
    <DetailSheet title="建单进度与研究规则" label="查看建单进度与研究规则" className="owner-disclosure">
    <p>新单按 1–3 个交易日的持有意图复查；合约剩余到期天数与持有时间分开看。系统仍选建单时距到期 7–30 天的合约。每天主动建立 {PAPER_DAILY_TARGET} 张研究模拟单，不足时继续轮换候选；实时报价缺失则显示缺口。</p>
    <p>{PAPER_CODEX_START_DATE} 起，每个交易日 06:30 开始由 Codex 分析股票与方向；完成后按当时真实报价筛选合约。调用未完成或候选不足时，原规则补位并明确标注来源。2026-10-01 起，三张中预留一张 SPY／QQQ 指数方法研究，另外两张保留个股选单；指数位缺合格合约时保留缺口，两张个股独立继续。</p>
    {indexStats ? <p><b>指数方法研究：</b>{indexStats.total} 张 · 胜 {indexStats.wins} / 负 {indexStats.losses} / 平 {indexStats.flats} · 待定 {indexStats.pending} · 未知 {indexStats.unknown}。这是本系统的模拟样本，不代表老刘胜率。</p> : null}
    <p><b>模拟研究，不是买入批准，也不是你的真实持仓。</b>每个交易日主动建立{PAPER_DAILY_TARGET}张不同股票的系统模拟票，评估Call与Put，不要求你实际买入。同日股票不重复；跨日可以重新独立研究，并提示已有观察，不能视为加仓指令。选择建单时距到期7–30天且报价有效的合约；指数预测与事件风险作为建单提示保留，特殊日按已核验规则使用+10% / -10%。不足时沿原有15分钟检查继续轮换；缺少真实来源、明确方向、合约报价或官方日历时记录缺口。旧单的合约、原始价格、胜负和观察记录保持不变；不会自动下单。</p>
    <p>建单后的前3个交易日（含建单日）重点跟踪；建单当天即使已有规则结果也继续采样；之后已出结果的单或重点期结束的单，收盘前一小时内每天最多尝试一次研究复盘，报价缺失也保留记录。观察最长7个自然日，真实合约更早到期则提前结束。每15分钟检查一批，最多8笔，按跟踪阶段安排。{compact ? "首页显示最近3张。" : "这里按建单日期分开本轮与旧单；观察归档表示研究停止，不代表合约到期或已卖出，原结果仍保留在所属轮次统计中。"}完整页显示所有未结束旧单及最近10张原单；全部原单统计与历史记录保留。电脑关机期间不采集、不补造轨迹；查不到报价不等于归零。</p>
    {todayCount === null ? <p><b>模拟单记录读取中，今日数量未知。</b></p> : <p><b>{paperDay!.label}已建立 {todayCount}/{PAPER_DAILY_TARGET} 张。</b>{todayCount < PAPER_DAILY_TARGET ? <> {paperDay!.label !== "今日" ? "该交易日原记录保留；下一交易日独立检查，不补造旧单。" : todayVoided ? "原单已作废；重新观察须有独立授权与新证据，不覆盖旧单。" : todayCount === 0 ? "今天还没有建立模拟首单，继续轮换候选读取真实报价。" : "继续轮换候选补齐每日研究单，已建立的原单不会替换。"}{todayAttempt ? `最近尝试：${formatPtDateTime(todayAttempt.recorded_at)}；${todayAttempt.payload.reasons.map((reason) => reason.replace(/^[A-Z_]+：/, "")).join("；")}` : paperDay!.label === "今日" ? "等待当前交易时段的真实来源与报价检查，不会拿历史单冒充今天的新单。" : ""}</> : `${paperDay!.label}已达到每日目标，未作废原单按各自跟踪阶段更新。`}</p>}
    </DetailSheet>
    </>}
    {todayOnly && todayCount === 0 ? <p>{todayClosed ? "休市不计缺单；已有观察与历史记录仍保留在研究与复盘。" : todayVoided ? "今日原单已作废，尚无重新观察的新单。" : "今天还没有建立模拟单。"}</p> : null}
    {todayOnly && todayCount !== null && todayCount < PAPER_DAILY_TARGET && todayAttempt ? <p role="status">最近建单检查：{todayAttempt.payload.reasons.map((reason) => reason.replace(/^[A-Z_]+：/, "")).join("；")}</p> : null}
    {planGroups.map((group) => {
    if (todayOnly && group.plans.length === 0) return null;
    const title = todayOnly ? "今日建单与最新采样" : compact ? overview ? `查看模拟记录（${plans.length} 张）` : "模拟记录尚未读取" : group.archived ? overview ? `旧单归档（${group.plans.length} 张可查看）` : "旧单归档尚未读取" : overview ? `本轮模拟记录（${group.plans.length} 张）` : "本轮模拟记录尚未读取";
    const content = <>
    {group.archived ? <><p>{PAPER_RESEARCH_START_DATE} 之前建立的旧单；原价格与固定结果保留，不进入本轮胜率。此处分组按建单日期，实际跟踪阶段见各张卡片。</p><p>归档汇总：{archivedStats ? `${archivedStats.total} 张 · 胜 ${archivedStats.wins} / 负 ${archivedStats.losses} / 平 ${archivedStats.flats ?? 0} · 待定 ${archivedStats.pending} · 结束未知 ${archivedStats.unknown}` : "未确认"}</p></> : null}
    <div className="paper-plan-grid">{group.plans.map((row) => {
      const { plan } = row;
      const entryReview = row.latest_entry_confirmation ?? plan.entry_confirmation;
      const entryReviewUntil = entryReview && Math.min(Date.parse(entryReview.assessed_at) + 120_000, ...entryReview.checks.filter((check) => check.status === "PASS" && ["QUOTE", "BARS"].includes(check.condition)).map((check) => Date.parse(check.evidence_at ?? "") + (check.condition === "QUOTE" ? 120_000 : MARKET_5M_MAX_AGE_SECONDS * 1000)));
      const entryReviewStale = entryReview && (!Number.isFinite(entryReviewUntil) || currentTime > entryReviewUntil! || currentTime < Date.parse(entryReview.assessed_at));
      const forecastReview = row.latest_formal_forecast_review ?? plan.formal_forecast_review;
      const forecastCurrent = forecastReview?.context_status === "AVAILABLE" && forecastReview.source && currentTime >= Date.parse(forecastReview.assessed_at)
        && currentTime < Math.min(Date.parse(forecastReview.source.next_validation_at), Date.parse(forecastReview.source.forecast_window.end_at ?? forecastReview.source.next_validation_at));
      const result = learning?.recent_results.find((item) => item.plan_id === plan.plan_id);
      const settled = result && ["WIN", "LOSS", "FLAT"].includes(result.status);
      const trackingWindow = row.tracking ?? paperTrackingWindow(plan);
      const trackingEnded = row.status === "EXPIRED" || row.status === "VOIDED" || row.status === "ARCHIVED" || row.tracking?.stage === "ENDED" || currentTime >= Date.parse(trackingWindow.ends_at);
      const researchOnly = !trackingEnded && (settled && ptDateKey(currentTime) !== plan.market_date || row.tracking?.stage === "RESEARCH" || currentTime >= Date.parse(trackingWindow.focus_ends_at));
      const missingChart = trackingEnded ? "未留存有效图点" : "待获取";
      const chartIssue = (issue: keyof typeof chartIssueNames) => trackingEnded && issue === "WAIT_ROTATION" ? "停止跟踪前未轮到检查" : chartIssueNames[issue];
      const bid = Number.isFinite(plan.reference.bid) && plan.reference.bid >= 0 ? plan.reference.bid : null;
      const ask = Number.isFinite(plan.reference.ask) && plan.reference.ask > 0 ? plan.reference.ask : null;
      const units = Number.isFinite(plan.contract.multiplier) && plan.contract.multiplier > 0 && Number.isFinite(plan.reference.quantity) && plan.reference.quantity > 0 ? plan.contract.multiplier * plan.reference.quantity : null;
      const cost = ask !== null && units !== null ? ask * units : null;
      const entrySpread = bid !== null && ask !== null && ask >= bid ? -paperReturnPct(plan, bid) : null;
      const latest = row.latest_quote;
      const validQuote = latest && Number.isFinite(latest.bid) && latest.bid >= 0 && Number.isFinite(latest.ask) && latest.ask > 0 && latest.ask >= latest.bid && Number.isFinite(Date.parse(latest.quoted_at));
      const outsideWindow = validQuote && Date.parse(latest.quoted_at) > Date.parse(trackingWindow.ends_at);
      const trackedReturn = validQuote && ask !== null ? paperReturnPct(plan, latest.bid) : null;
      const trackedPnl = validQuote && ask !== null && units !== null ? (latest.bid - ask) * units : null;
      const afterExit = Boolean(settled && validQuote && result?.quoted_at && Date.parse(latest.quoted_at) > Date.parse(result.quoted_at));
      const age = validQuote && Number.isFinite(currentTime) ? currentTime - Date.parse(latest.quoted_at) : null;
      const ageLabel = age === null ? "" : age < 0 ? "时间异常" : age < 60_000 ? "1分钟内" : age < 86_400_000 ? `${Math.floor(age / 60_000)}分钟前` : `${Math.floor(age / 86_400_000)}天前`;
      const resultLabel = !result ? "结果未确认" : result.status === "PENDING" ? "未结算" : result.status === "UNKNOWN" ? row.status === "VOIDED" ? "作废时结果未知" : "结束未知" : result.status === "WIN" ? "胜" : result.status === "LOSS" ? "负" : "平";
      const exitLabel = result?.exit_reason ? exitNames[result.exit_reason] : "已结算";
      const comparison = compact ? null : paperChartComparison(plan, row.chart, currentTime);
      const entryDays = plan.threshold_policy?.events ?? specialDays.filter((day) => day.market_date === plan.market_date);
      const reviewBy = plan.holding_intent ? nextNyseRegularDateAfter(nextNyseRegularDateAfter(plan.market_date)) : null;
      const latestBackground = row.latest_next_session_forecast_review;
      const latestBackgroundCurrent = latestBackground?.context_status === "AVAILABLE" && latestBackground.source && currentTime >= Date.parse(latestBackground.assessed_at)
        && ptDateKey(latestBackground.assessed_at) === ptDateKey(currentTime) && nextNyseRegularDateAfter(ptDateKey(latestBackground.source.observed_at)) === ptDateKey(currentTime)
        && currentTime >= Date.parse(latestBackground.source.forecast_window.start_at) && (latestBackground.source.forecast_window.end_at === null || currentTime < Date.parse(latestBackground.source.forecast_window.end_at))
        && currentTime < Date.parse(paperExpiryClose(ptDateKey(currentTime)));
      const backgroundReview = [plan.next_session_forecast_review, latestBackgroundCurrent ? latestBackground : undefined].find((review) => review?.scope === "NEXT_SESSION_BACKGROUND" && review.context_status === "AVAILABLE" && review.source && review.forecast_direction);
      const observationStatus = trackingEnded ? entryReview ? `历史核验：${entryNames[entryReview.status]}` : "观察已结束"
        : entryReview?.status === "INVALIDATED" ? "仅观察 · 原条件已失效"
        : row.status === "DATA_GAP" || latest && !validQuote || entryReview?.status === "DATA_GAP" ? "仅观察 · 入场证据不全"
        : entryReviewStale || age !== null && (age < 0 || age > 120_000) ? "仅观察 · 需新行情复核"
        : entryReview?.status === "CONFLICT" ? "仅观察 · 方向证据冲突"
        : forecastCurrent && forecastReview.status === "CONFLICT" ? "仅观察 · 短线方向与计划相反"
        : entryReview ? `仅模拟观察 · ${entryNames[entryReview.status]}` : "仅观察 · 未保存入场核验";
      const forecastChecks = [
        { label: "建单时前晚背景", review: plan.next_session_forecast_review, background: true },
        { label: "建单时短线对照", review: plan.formal_forecast_review, background: false },
        ...(latestBackground ? [{ label: "最新自然复查 · 前晚背景", review: latestBackground, background: true }] : []),
        ...(row.latest_formal_forecast_review ? [{ label: "最新自然复查 · 短线", review: row.latest_formal_forecast_review, background: false }] : []),
      ];
      return <article className={`options-card paper-ticket${compact ? "" : " paper-ticket-rb"}`} key={plan.plan_id}>
        <header className="paper-ticket-heading"><strong>{plan.symbol} · ${plan.contract.strike} {plan.contract.option_type === "call" ? "Call" : "Put"}</strong></header>
        <dl className="paper-ticket-quotes">
          <div><dt>建单 Bid / Ask</dt><dd><b>Bid {money(bid)}</b><b>Ask {money(ask)}</b></dd><small>{quoteTime(plan.reference.quoted_at)}</small>{!compact ? <small>Mark {plan.reference.mark === undefined ? "未留存" : money(plan.reference.mark)}</small> : null}</div>
          <div><dt>{row.status === "VOIDED" ? "作废前最后采样 Bid / Ask" : trackingEnded ? "历史最后采样 Bid / Ask" : "最新采样 Bid / Ask"}</dt><dd><b>Bid {money(validQuote ? latest.bid : null)}</b><b>Ask {money(validQuote ? latest.ask : null)}</b></dd><small>{validQuote ? quoteTime(latest.quoted_at) : "尚无有效后续报价"}{ageLabel ? <span className="paper-ticket-age"> · {ageLabel}</span> : null}</small>{!compact ? <small>Mark {validQuote && latest.mark !== undefined ? money(latest.mark) : "未留存"}</small> : null}</div>
        </dl>
        {row.status === "DATA_GAP" || latest && !validQuote ? <p className="paper-ticket-gap">{trackingEnded ? "历史报价缺口" : row.status === "DATA_GAP" ? "本轮报价缺口" : "报价未确认"}{validQuote ? " · 显示上次有效采样" : ""}</p> : null}
        {outsideWindow ? <p className="paper-ticket-note">此历史报价晚于现行观察截止，不计入窗口复盘。</p> : null}
        <div className="paper-ticket-meta">
        <p className="paper-ticket-expiration"><span>到期日</span><time dateTime={plan.contract.expiration}>{plan.contract.expiration}</time></p>
        <p className="paper-ticket-note"><b>{plan.selection_source?.kind === "CODEX" ? "Codex 亲选股票与方向 · 仅模拟" : plan.selection_source?.kind === "RULE_FALLBACK" ? "规则补位 · 非 Codex 亲选" : plan.entry_policy?.version === "BASELINE_PAPER_RESEARCH_V1" ? "原方向研究规则 · 仅模拟" : plan.entry_policy?.version === "DAILY_PAPER_RESEARCH_V1" ? "每日研究规则 · 仅模拟" : plan.entry_policy?.version === "QUALIFIED_PAPER_ENTRY_V1" ? "突破入场规则 · 仅模拟" : "旧观察基线 · 未记录当前建单规则"}</b></p>
        </div>
        <p className="paper-ticket-note" aria-label="模拟单观察状态">{backgroundReview ? `${backgroundReview === plan.next_session_forecast_review ? "建单前晚" : "后续复查背景"}${directionNames[backgroundReview.forecast_direction!]} · ` : ""}原方向 {plan.contract.option_type === "call" ? "Call" : "Put"} · <b>{observationStatus}</b>{entryReview ? ` · 核验 ${quoteTime(entryReview.assessed_at)}` : ""}</p>
        {row.owner_void ? <p className="paper-ticket-gap"><b>已作废 · 停止跟踪</b> · {quoteTime(row.owner_void.ended_at)}<br />{row.owner_void.detail}。历史价格与首次结果保留，不代表成交退出。</p> : null}
        <p className="paper-ticket-note" aria-label="模拟跟踪安排"><b>{trackingEnded ? "观察已结束 · 停止跟踪" : researchOnly ? "盘末观察 · 每天最多一次" : "重点跟踪"}</b> · {trackingEnded ? "截止" : researchOnly ? "观察截止" : "重点至"} {quoteTime(trackingEnded ? row.owner_void?.ended_at ?? trackingWindow.ends_at : researchOnly ? trackingWindow.ends_at : settled ? paperExpiryClose(plan.market_date) : trackingWindow.focus_ends_at)}{!trackingEnded && !researchOnly ? ` · 观察截止 ${quoteTime(trackingWindow.ends_at)}` : ""}</p>
        {row.status === "EXPIRED" ? <p className="paper-ticket-note">合约已到期，保留原采样与缺口。</p> : row.status === "ARCHIVED" || row.tracking?.reason === "OBSERVATION_WINDOW" ? <p className="paper-ticket-note">观察期限已满；归档不代表合约到期或已卖出。</p> : null}
        {row.status !== "VOIDED" ? reviewBy ? <p className="paper-ticket-note">复查期限 {reviewBy} · {trackingEnded ? "观察已结束，复查已结束" : settled ? "已记录规则结果" : ptDateKey(currentTime) >= reviewBy ? "持有计划待复查" : "按 1–3 个交易日计划观察"}</p> : <p className="paper-ticket-note">原持有计划未记录</p> : null}
        {entryDays.length > 0 ? <p className="paper-ticket-note">特殊日 · {entryDays.length}项日历标记</p> : null}
        <p className="paper-ticket-note">{plan.threshold_policy ? "特殊日试行" : "原规则"}：+{plan.take_profit_pct}% / {plan.stop_loss_pct}% · 建单后不改写</p>
        <dl className="paper-ticket-quotes" aria-label="止盈止损参考价">
          <div><dt>止盈参考价（+{plan.take_profit_pct}%）</dt><dd><b>{money(ask === null ? null : ask * (1 + plan.take_profit_pct / 100))}</b></dd></div>
          <div><dt>止损参考价（{plan.stop_loss_pct}%）</dt><dd><b>{money(ask === null ? null : ask * (1 + plan.stop_loss_pct / 100))}</b></dd></div>
        </dl>
        <p className="paper-ticket-note">基准：建单 Ask {money(ask)} · 美元/股期权</p>
        <div className="paper-ticket-performance">
          <div><span>{afterExit ? "规则退出后研究涨跌" : "建单后跟踪涨跌"}{compact ? "" : " · Ask→Bid"}</span><strong className="paper-ticket-return" data-direction={trackedReturn === null || trackedReturn === 0 ? "flat" : trackedReturn > 0 ? "up" : "down"}>{trackedReturn === null ? "—" : percent(trackedReturn)}</strong><small>{amount(trackedPnl)} · 最新 Bid 对建单 Ask{afterExit ? " · 非真实收益，不计原胜率" : ""}</small></div>
          <div><span>固定规则结果{compact ? "" : " · Ask→Bid"}</span><strong className="paper-ticket-result">{settled ? <>{resultLabel} · {percent(result.return_pct)}</> : resultLabel}</strong><small>{settled ? <>{exitLabel} · {amount(result.pnl)}<br />{row.status === "VOIDED" ? "作废前原结果保留" : trackingEnded ? "观察已结束" : researchOnly ? "盘末观察，不改结算" : "今日继续跟踪，不改结算"}</> : row.status === "VOIDED" ? "作废时未形成规则结果" : trackingEnded ? "无可核验结算报价" : researchOnly ? "等待盘末观察" : "继续观察"}{result?.status === "UNKNOWN" ? "；不可评分，不计入胜率分母，历史缺口保留。" : ""}</small></div>
        </div>
        {entrySpread !== null && entrySpread >= -plan.stop_loss_pct ? <p className="paper-ticket-gap">建单价差已达到止损幅度：报价不变也可能触发模拟止损。</p> : null}
        <DetailSheet title={`${plan.symbol} · ${plan.contract.expiration} · $${plan.contract.strike} ${plan.contract.option_type === "call" ? "Call" : "Put"}`} label="关键详情" className="owner-disclosure paper-ticket-details">
        {plan.owner_reselection ? <p className="paper-ticket-note">按你的要求重新观察 · {quoteTime(plan.owner_reselection.requested_at)} · 独立新记录，未替换旧单</p> : null}
        {plan.research_cohort === "INDEX_CONDITIONS_V1" ? <p className="paper-ticket-note"><b>指数方法研究</b> · 方向与价位由系统独立研究；外部专家仅参考，不是标准答案。</p> : null}
        {group.archived ? <p className="paper-ticket-note">原建单日期：{plan.market_date}</p> : null}
        {entryDays.map((day) => <p className="special-day-label" key={`${day.market_date}:${day.release_name ?? day.label}`}><b>特殊日 · {day.label}</b><small>{day.market_date} · {plan.threshold_policy ? "建单时已核验并固定" : "官方日历标记"} · <a href={day.source_url}>查看日程</a></small></p>)}
        {plan.selection_source ? <p className="paper-ticket-note">{plan.selection_source.kind === "CODEX" ? `选股完成：${quoteTime(plan.selection_source.completed_at)}；${plan.selection_source.version === "CODEX_PAPER_SELECTION_V2" ? "Codex 选择精确合约，系统复核建单报价" : "合约由系统按真实报价筛选"}。` : plan.selection_source.reason}</p> : null}
        <section aria-label="正式短线预测对照"><h4>预测背景与原单方向</h4>
          <dl>{forecastChecks.map(({ label, review, background }) => <div key={label}><dt>{label}</dt><dd>{review ? <>
            {(background ? backgroundNames : forecastNames)[review.status]} · 原预测 {review.forecast_direction ? directionNames[review.forecast_direction] : "方向不可用"} · 核验 {quoteTime(review.assessed_at)}{!background && review === forecastReview && review.context_status === "AVAILABLE" && !forecastCurrent ? " · 该对照已过期" : ""}
            {background && review === latestBackground && review.context_status === "AVAILABLE" && !latestBackgroundCurrent ? " · 该背景当前不可用（未到时段或已过期），仅保留复查记录" : ""}
            {review.summary ? <p>{review.summary}</p> : null}
            {review.source ? <p>原预测窗口：{quoteTime(review.source.forecast_window.start_at)} 至 {review.source.forecast_window.end_at ? quoteTime(review.source.forecast_window.end_at) : review.source.forecast_window.end_condition === "NEXT_REGULAR_SESSION_CLOSE" ? "下一常规交易日收盘" : "原记录未给结束时刻"} · 复查 {quoteTime(review.source.next_validation_at)}<br />实际交付 {quoteTime(review.source.delivered_at)}</p> : null}
          </> : background ? "建单时未保存前晚背景，不用后来的复查回填" : "未记录正式预测对照，不回填为当时已知"}</dd></div>)}</dl>
          <p>前晚背景看下一交易日，正式短线预测看未来30–60分钟；{plan.holding_intent ? "原模拟计划看1–3个交易日" : "原单未记录持有期限"}。不同期限可能方向相反，原方向与建单理由保留；一致或浮盈都不代表已确认入场。</p>
          <p>{trackingEnded ? "此处仅保留当时对照。" : "新行情确认尚未完成时继续观察；相反时核对原触发与失效条件。"}外部专家仅参考，不是标准答案，不据此改写原方向。</p>
        </section>
        {entryReview ? <section aria-label="入场条件逐项核验">
          <h4>{trackingEnded ? "历史入场条件核验" : "入场条件核验"}</h4><p>本次：{entryNames[entryReview.status]} · {quoteTime(entryReview.assessed_at)}{entryReviewStale ? " · 已过时，不能作为当前入场确认" : ""}。{trackingEnded ? "观察已结束，保留当时条件与原规则结果。" : "模拟建单与入场确认分开，原止盈止损继续生效。"}</p>
          <p>建单时：{plan.entry_confirmation ? `${entryNames[plan.entry_confirmation.status]} · ${quoteTime(plan.entry_confirmation.assessed_at)}` : "未记录核验，不用后来的行情补写"}</p>
          <dl>{entryReview.checks.map((check) => <div key={check.condition}><dt>{checkNames[check.condition]} · {checkStates[check.status]}</dt><dd>{check.detail}{check.evidence_at ? ` · ${quoteTime(check.evidence_at)}` : ""}</dd></div>)}</dl>
          <p>本次核验价位（标的股票）：{[entryReview.levels.entry, entryReview.levels.invalidation, entryReview.levels.target].map(money).join(" / ")} · 触发 / 失效 / 目标</p>
        </section> : null}
        <dl><div><dt>选股依据 · 建单时记录</dt><dd>{plan.why_watch.join("；")}</dd></div>
          <div><dt>冻结股票价位 · 触发 / 失效 / 目标</dt><dd>{[plan.levels.entry, plan.levels.invalidation, plan.levels.target].some((price) => price !== null && Number.isFinite(price)) ? [plan.levels.entry, plan.levels.invalidation, plan.levels.target].map((price) => money(price)).join(" / ") : "原单未冻结可用价位，不能据此判断已突破或已失效"} · {quoteTime(plan.source.observed_at)}</dd></div></dl>
        <CompanyEvidence symbol={plan.symbol} />
        <h4>{trackingEnded ? "原计划与通用说明" : "跟单前复查"}</h4>
        <p className="paper-ticket-note">通用复查提示，不是原单新增信号：对照当前大盘与个股强弱，核实关键位、突破或回调是否成立；冻结分析和期权新报价不能证明盘中已企稳。</p>
        <p className="paper-ticket-note">只买一张时，预先确定整张退出条件；一张不能分批卖出留尾仓，也不要为了留尾仓加买。上方参考价沿用原单规则，实际成本不同要重算，不能因为博主仍持有就放宽风险底线。</p>
        <p className="paper-ticket-note">原判断失效、期限不足或达到自己的风险底线时重新评估；不靠“公司没变”无限等待。退出后可重新观察，但再入场要有新证据，不能只为赚回上一笔亏损。</p>
        <p className="paper-ticket-note">{plan.holding_intent ? trackingEnded ? "原持有意图：1–3个交易日；观察已结束，原计划保留。" : "原持有意图：1–3个交易日，按计划复查，不在第3天自动平仓。" : "原单未冻结持有意图，不追填为1–3天计划。"}</p>
        {reviewBy ? <p className="paper-ticket-note">计划复查：{plan.market_date} 至 {reviewBy}（建单日为第1个交易日）。{trackingEnded ? "观察已结束，原计划仅作历史记录。" : settled ? "已记录规则结果，后续报价仅作跟踪。" : ptDateKey(currentTime) >= reviewBy ? "已到第3个交易日或之后，持有计划待复查；不自动延长，也不假定已卖出。" : "观察记录不代表计划持有至合约到期。"}</p> : null}
        {!compact ? <div className="paper-rb-comparison" aria-label="RB时间线价格对照">
          <dl className="paper-ticket-quotes">
            <div><dt>RB 建单时段</dt><dd><b>{money(comparison?.entry.close ?? null)}</b></dd><small>{comparison ? chartLabel(comparison.entry, plan.contract.contract_id).split(" · ")[1] : trackingEnded ? "历史图点不足，无法对照" : "待获取同合约图点"}</small></div>
            <div><dt>RB 最近时段</dt><dd><b>{money(comparison?.latest.close ?? null)}</b></dd><small>{comparison ? chartLabel(comparison.latest, plan.contract.contract_id).split(" · ")[1] : trackingEnded ? "历史图点不足，无法对照" : "待获取同合约图点"}</small></div>
          </dl>
          <span>RB 时间线涨跌</span><strong className="paper-ticket-return" data-direction={!comparison || comparison.return_pct === 0 ? "flat" : comparison.return_pct > 0 ? "up" : "down"}>{comparison ? percent(comparison.return_pct) : trackingEnded ? "无法核对" : "待核对"}</strong>
          <small>{amount(comparison?.pnl ?? null)} · {Number.isFinite(plan.reference.quantity) && plan.reference.quantity > 0 ? plan.reference.quantity : "—"}张等值变化 · 5分钟区间结束价</small>
          {row.chart?.entry_issue || row.chart?.latest_issue ? <small>{row.chart.entry_issue ? `建单图点：${chartIssue(row.chart.entry_issue)}。` : ""}{row.chart.latest_issue ? `最新图点：${chartIssue(row.chart.latest_issue)}。` : ""}</small> : null}
        </div> : null}
        <p className="paper-ticket-note">参考价四舍五入到美分。实际买入价不同需重算；RB 最小报价单位以挂单页为准。系统用 Bid 观察盈亏；RB 止损限价卖单按 Ask 或符合条件的成交触发，触发与成交以挂单规则为准，不保证成交价。</p>
          <dl>
            <div><dt>模拟仓位 / 建单时间</dt><dd>{Number.isFinite(plan.reference.quantity) && plan.reference.quantity > 0 ? plan.reference.quantity : "—"}张 · 参考成本 {money(cost)}（Ask） · {quoteTime(plan.created_at)}</dd></div>
            {!compact ? <div><dt>RB 5分钟时间线 · 区间结束价</dt><dd>建单所在区间：{chartLabel(row.chart?.entry, plan.contract.contract_id, missingChart)}<br />最近完整区间：{chartLabel(row.chart?.latest, plan.contract.contract_id, missingChart)}</dd><dd><small>{row.chart ? `${row.chart.status === "AVAILABLE" ? "已自动读取" : trackingEnded ? "已停止跟踪，历史时间线缺口保留" : row.chart.status === "PARTIAL" ? "部分时间线待补齐" : "时间线暂不可用"} · ${quoteTime(row.chart.checked_at)}` : trackingEnded ? "已停止跟踪，时间线未留存" : researchOnly ? "等待盘末观察" : "等待下一次自动检查"}；图表标注区间起点，区间价不作买入成本。</small></dd></div> : null}
            {!compact ? <div><dt>价格对照</dt><dd>RB 涨跌按同合约区间价对区间价；模拟结算按原 Ask→Bid。时间线回查不计入规则胜率。{!plan.reference.proof ? "原建单报价原文未留存，无法追溯当时报价差异。" : "建单报价已按合约身份及源时间留存。"}</dd></div> : null}
            {settled ? <div><dt>固定结算报价 / 时间</dt><dd>Bid {money(result.bid)} · {quoteTime(result.quoted_at)}</dd></div> : null}
            {result?.risk_exit ? <div><dt>退出事件</dt><dd>{result.risk_exit.title} · {quoteTime(result.risk_exit.decision_at)} · {result.risk_exit.source_url ? <a href={result.risk_exit.source_url} target="_blank" rel="noreferrer">{result.risk_exit.source}</a> : result.risk_exit.source}</dd></div> : null}
            <div><dt>全部历史采样最高 / 最低</dt><dd>{percent(row.highest_observed_return_pct)} / {percent(row.lowest_observed_return_pct)}</dd></div>
            <div><dt>建单价差 / 即时价差损耗</dt><dd>{entrySpread === null || units === null ? "未知" : `${rate(entrySpread)} / ${money((ask! - bid!) * units)}`}</dd></div>
            <div><dt>观察截止</dt><dd>{quoteTime(trackingWindow.ends_at)} · 最长7个自然日与真实到期先到者为准；真实持仓独立管理。</dd></div>
          </dl>
          {row.window_research ? <section aria-label="观察窗口复盘"><h4>观察窗口复盘</h4>
            <p>建单起至 {quoteTime(row.window_research.ends_at)} · 最长7个自然日，真实到期更早则提前截止。</p>
            <p>窗口内最高 / 最低采样：{percent(row.window_research.best_return_pct)} / {percent(row.window_research.worst_return_pct)} · Bid 对原 Ask，仅研究。</p>
            {result?.status === "LOSS" ? <>
              <p>首次亏损结果保留；以下回本或达标不改原胜负、不计原胜率，也不是实际收益。</p>
              <p>亏损后回本：{row.window_research.recovery_after_loss ? <>首次观察 Bid {money(row.window_research.recovery_after_loss.bid)} ≥ 原 Ask · {quoteTime(row.window_research.recovery_after_loss.quoted_at)}</> : "未观察到回本；采样有限"}</p>
              <p>亏损后达到原止盈：{row.window_research.target_after_loss ? <>首次观察 Bid {money(row.window_research.target_after_loss.bid)} · {percent(row.window_research.target_after_loss.return_pct)} · {quoteTime(row.window_research.target_after_loss.quoted_at)}</> : "未观察到达到原止盈；采样有限"}</p>
            </> : null}
            <p>{row.window_research.gap_observed ? "窗口内有报价缺口；" : "报价为间隔采样；"}未观察到不等于从未发生，最高与最低也不代表连续行情极值。</p>
          </section> : null}
          {result?.gap_before_result ? <p className="paper-ticket-note">判定前有采样缺口。</p> : null}
          {row.reasons.length ? <p className="paper-ticket-note">{trackingEnded ? "历史检查" : "最近检查"}：{row.reasons.join("；")}</p> : null}
          {plan.warnings.length ? <p className="paper-ticket-note">建单时风险提示：{plan.warnings.join("；")}</p> : null}
          <details className="paper-ticket-source"><summary>原始记录</summary><p>合约 {plan.contract.contract_id}<br />样本 {plan.plan_id}<br />依据 {plan.source.evidence_id}{result?.risk_exit ? <><br />退出事件 {result.risk_exit.event_id}</> : null}</p>{!compact ? <p>建单报价原文：{plan.reference.proof ? `已留存 · 接收 ${quoteTime(plan.reference.proof.received_at)}` : "未留存"}<br />最新报价原文：{latest?.proof ? `已留存 · 接收 ${quoteTime(latest.proof.received_at)}` : "未留存"}</p> : null}</details>
        </DetailSheet>
      </article>;
    })}</div>
    </>;
    return todayOnly ? <details className="owner-disclosure" open key={String(group.archived)}><summary>{title}</summary>{content}</details>
      : <DetailSheet title={title} className="owner-disclosure" key={String(group.archived)}>{content}</DetailSheet>;
    })}
    {compact || todayOnly ? <p><a href="/settlements#research-paper">查看全部模拟单与历史跟踪记录</a></p> : null}
  </section>;
}
