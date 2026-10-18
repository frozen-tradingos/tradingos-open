import type { IncidentRecord, SnapshotState } from "./snapshot-import";
import { exchangeDateKey, latestCompletedNyseSession, MARKET_5M_MAX_AGE_SECONDS } from "./market-time.ts";
import { buildCurrentTruth } from "./current-truth.ts";
import { isHoldingAdviceCurrent } from "./today-action.ts";
import { codexManagerOnlineStatus } from "./codex-production-manager.ts";

export type HealthTone = "GOOD" | "EXPECTED" | "WARNING" | "CRITICAL";

export type HealthDomain = {
  id: "website" | "database" | "market" | "options" | "account" | "holding" | "risk" | "news" | "scheduler" | "agents" | "gateway" | "page" | "maintenance";
  name: string;
  tone: HealthTone;
  status: string;
  summary: string;
  impact: string;
};

export type OwnerIncident = IncidentRecord & {
  impact: string;
  system_action: string;
  owner_action: string;
  owner_required: boolean;
  codex_required: boolean;
  detected: string;
  forecast_impact: string;
  history_impact: string;
  fault_origin: string;
  capability: string;
  affected_modules: string[];
  evidence_scope: string;
  last_success_at: string | null;
  next_check_at: string | null;
  codex_repair_task: string | null;
};

const IMPACT: Record<string, string> = {
  SERVICE: "网站可用性和所有设备访问",
  DATABASE: "SQLite 持久保存、快照和输出写入",
  DATA: "当前行情、新闻和本槽分析",
  SCHEDULER: "当前或下一次自然运行槽",
  AGENT: "A1 → A2 → TS → Guard 及下游部门",
  RUNTIME: "影子验证后台运行",
  GATEWAY: "结果进入网站",
  LEDGER: "运行状态与审计证据",
  API: "页面、K线和老板可见数据",
  EVIDENCE: "结论可信度",
  DESKTOP: "不影响独立网站，仅保留记录",
  MAINTENANCE: "网站长期运行、自动恢复和本机容量",
};

function issueView(issue: IncidentRecord): OwnerIncident {
  const details = issue.details ?? {};
  const detailText = (key: string) => typeof details[key] === "string" ? details[key] as string : null;
  const ownerRequired = typeof details.owner_required === "boolean" ? details.owner_required : issue.severity === "CRITICAL" || /AUTH|CREDENTIAL|NOT_CONFIGURED|API_KEY/.test(issue.code);
  const automaticRecovery = ["SERVICE", "RUNTIME"].includes(issue.layer);
  const impact = detailText("forecast_impact") ?? IMPACT[issue.layer] ?? "当前影子验证";
  const attempted = Array.isArray(details.attempted_actions) ? details.attempted_actions.filter((item): item is string => typeof item === "string") : [];
  return {
    ...issue,
    impact,
    detected: detailText("detected") ?? issue.title,
    forecast_impact: impact,
    history_impact: detailText("history_impact") ?? "既有 SQLite、运行账本和审计记录继续保留。",
    system_action: detailText("automatic_action") ?? (attempted.length ? attempted.join("；") : `${automaticRecovery ? "已触发允许范围内的进程恢复；" : ""}已写入故障日志和投诉箱，自检守卫持续复查。`),
    owner_action: detailText("owner_action") ?? (ownerRequired ? `若下一次复查仍未恢复：${issue.suggestion}` : "目前无需处理；等待自动复查。"),
    owner_required: ownerRequired,
    codex_required: details.codex_required === true,
    fault_origin: detailText("fault_origin") ?? (issue.layer === "AGENT" ? "AGENT_SELF" : issue.layer === "DATA" ? "UPSTREAM_DATA" : "PLATFORM"),
    capability: detailText("capability") ?? issue.layer,
    affected_modules: Array.isArray(details.affected_modules) ? details.affected_modules.filter((item): item is string => typeof item === "string") : [IMPACT[issue.layer] ?? "当前影子验证"],
    evidence_scope: detailText("evidence_scope") ?? "CURRENT_REALTIME",
    last_success_at: detailText("last_success_at"),
    next_check_at: detailText("next_check_at"),
    codex_repair_task: detailText("codex_repair_task"),
  };
}

function fromIncident(id: HealthDomain["id"], name: string, issues: OwnerIncident[], layers: string[], normal: Omit<HealthDomain, "id" | "name">) {
  const issue = issues.find((item) => layers.includes(item.layer));
  return issue ? {
    id,
    name,
    tone: issue.severity === "CRITICAL" ? "CRITICAL" as const : "WARNING" as const,
    status: issue.severity === "CRITICAL" ? "故障" : "需关注",
    summary: issue.title,
    impact: issue.impact,
  } : { id, name, ...normal };
}

export function recoveredScheduleFaultReason(state: SnapshotState, item: SnapshotState["scheduler"]["recent"][number], now: number) {
  const robinhood = state.dataSources.find((item) => item.source === "ROBINHOOD");
  const validClose = Boolean(robinhood?.authorization === "VALID" && robinhood.status === "MARKET_CLOSED" && robinhood.as_of && exchangeDateKey(robinhood.as_of) === latestCompletedNyseSession(now));
  const settlementRecovered = state.tsSettlement?.pending_count === 0 && state.optionLifecycle?.pending_count === 0;
  if (item.status === "DATA_BLOCKED" && item.kind === "TS_SETTLEMENT" && settlementRecovered) return "后续真实 K 线已完成结算；原阻断仅保留历史。";
  if (item.status === "DATA_BLOCKED" && validClose && ["POSITION_MONITOR", "A1_HEARTBEAT"].includes(item.kind)) return "后续已确认正常收盘；原阻断仅保留历史。";
  const recovered = state.scheduler.recent.find((candidate) => candidate.kind === item.kind && candidate.status === "SUCCEEDED" && Date.parse(candidate.completed_at) > Date.parse(item.completed_at));
  if (recovered) return `后续 ${recovered.business_slot} 同类自然槽已成功；原记录继续留在历史。`;
  return null;
}

export function activeScheduleFaults(state: SnapshotState, now: number) {
  return state.scheduler.recent.filter((item) => {
    const faultAt = Date.parse(item.status === "MISSED" ? item.scheduled_at : item.completed_at);
    if (!["MISSED", "FAILED", "DATA_BLOCKED"].includes(item.status) || now - faultAt > 90 * 60_000) return false;
    return !recoveredScheduleFaultReason(state, item, now);
  });
}

export function buildHealthOverview(state: SnapshotState, now = Date.now()) {
  const truth = state.currentTruth ?? buildCurrentTruth(state, now);
  const futureTime = (value: string | null | undefined) => value && Date.parse(value) > now ? value : null;
  const currentIds = new Set(truth.issues.lifecycle.filter((item) => item.status === "ACTIVE_BLOCKING" || item.status === "ACTIVE_DEGRADED").map((item) => item.incident_id));
  const current = state.selfCheck.active.filter((item) => item.severity !== "INFO" && currentIds.has(item.incident_id)).map((item) => { const issue = issueView(item); return { ...issue, next_check_at: futureTime(issue.next_check_at) }; });
  const history = state.selfCheck.recent.filter((item) => item.status === "RESOLVED").map(issueView);
  const checkedAt = state.selfCheck.checked_at ? Date.parse(state.selfCheck.checked_at) : 0;
  const selfCheckFresh = codexManagerOnlineStatus(state.selfCheck.checked_at, false, now) === "ONLINE";
  const selfCheckStatus = !selfCheckFresh ? "NOT_VERIFIED" : current.some((item) => item.severity === "CRITICAL") ? "CRITICAL" : current.length ? "DEGRADED" : "HEALTHY";
  const nextCheckAt = current.flatMap((item) => item.next_check_at ? [item.next_check_at] : []).sort()[0] ?? null;
  const nextScheduledRun = futureTime(state.scheduler.next_run?.scheduled_at) ? state.scheduler.next_run : null;
  const robinhood = state.dataSources.find((item) => item.source === "ROBINHOOD");
  const finnhub = state.dataSources.find((item) => item.source === "FINNHUB");
  const frozenMarket = state.outputs.A1_SHADOW_RESULT?.source_mode === "LIVE" ? state.outputs.A1_SHADOW_RESULT.market_sources : undefined;
  const livePosition = state.outputs.POSITION_COPILOT_STATE?.find((item) => item.source_mode === "LIVE") ?? null;
  const currentPosition = livePosition?.holdings.every((holding) => isHoldingAdviceCurrent(livePosition, holding, truth.trading_date, now)) ? livePosition : null;
  const liveStrategy = state.outputs.OPTION_STRATEGY_SIGNAL?.find((item) => item.source_mode === "LIVE") ?? null;
  const recentRun = state.runLedger.runs[0] ?? null;
  const running = state.runLedger.runs.find((run) => ["STARTED", "RUNNING"].includes(run.status) && now - Date.parse(run.event_at) < 15 * 60_000);

  const website = fromIncident("website", "网站服务", current, ["SERVICE"], selfCheckFresh
    ? { tone: "GOOD", status: "正常", summary: "4070 服务在线，独立守护持续运行。", impact: "手机、iPad 和电脑访问" }
    : { tone: "WARNING", status: "待核验", summary: checkedAt ? "完整自检时间无效或已超过 3 分钟，等待新检查证据。" : "等待首次完整自检证据。", impact: "尚不能确认当前网站守护状态" });
  const backupAt = Date.parse(state.selfCheck.last_backup_at ?? "");
  const database = fromIncident("database", "SQLite 数据库", current, ["DATABASE"], selfCheckFresh && Number.isFinite(backupAt) && backupAt <= now
    ? { tone: "GOOD", status: "正常", summary: "当前完整自检通过；最近成功备份时间另列。", impact: "快照、运行账本和投诉记录" }
    : { tone: "WARNING", status: "待核验", summary: !selfCheckFresh ? "完整自检时间无效或已过期，最近备份仅作历史留证。" : "等待有效且不晚于当前时间的成功备份证据。", impact: "尚不能确认当前数据库与恢复证据状态" });

  let market: HealthDomain = { id: "market", name: "行情数据", tone: "WARNING", status: "待确认", summary: "Robinhood 尚未验证。", impact: "A1、A2、TS 和 Guard" };
  if (truth.market_data_health.classification === "EXPECTED_PROVIDER_SESSION_LIMIT") market = { ...market, tone: "EXPECTED", status: "夜盘能力受限", summary: "实时Quote不可用，但批准的5分钟Bar仍可用；NEXT_SESSION Forecast保留，当前NO TRADE。" };
  else if (robinhood?.authorization === "EXPIRED" || robinhood?.status === "DATA_BLOCKED") market = { ...market, tone: "CRITICAL", status: "数据中断", summary: robinhood.error ?? "Robinhood 数据被阻断。" };
  else if (robinhood?.status === "STALE" || robinhood?.status === "LIVE" && (robinhood.freshness_seconds ?? Number.POSITIVE_INFINITY) > MARKET_5M_MAX_AGE_SECONDS) market = { ...market, tone: "WARNING", status: "数据过期", summary: "行情超过合同新鲜度限制。" };
  else if (robinhood?.status === "MARKET_CLOSED" && robinhood.authorization === "VALID") market = { ...market, tone: "EXPECTED", status: "正常收盘", summary: "保留最近 EOD 数据，不算数据断流。" };
  else if (robinhood?.status === "LIVE" && robinhood.authorization === "VALID") market = { ...market, tone: "GOOD", status: "实时正常", summary: "官方只读行情已授权且新鲜。" };

  const chains = frozenMarket?.options ?? [];
  const options: HealthDomain = chains.length && chains.every((item) => ["LIVE", "MARKET_CLOSED"].includes(item.status) && item.contract_count > 0)
    ? { id: "options", name: "本槽期权链", tone: "GOOD", status: "冻结已留证", summary: `SPY / QQQ 共 ${chains.reduce((total, item) => total + item.contract_count, 0)} 份合约。`, impact: "期权策略比较" }
    : chains.some((item) => ["STALE", "DATA_BLOCKED"].includes(item.status))
      ? { id: "options", name: "本槽期权链", tone: "WARNING", status: "链数据受限", summary: "本槽期权链缺失或过期；不影响标的行情，但策略必须降级。", impact: "期权策略比较" }
      : { id: "options", name: "本槽期权链", tone: "EXPECTED", status: "等待本槽", summary: "当前冻结槽尚未形成期权链证据。", impact: "期权策略比较" };
  const account: HealthDomain = frozenMarket?.account.status === "LIVE"
    ? { id: "account", name: "本槽账户读取", tone: "GOOD", status: "只读正常", summary: `${frozenMarket.account.account_count ?? 0} 个账户已读取；完整账号不保存。`, impact: "真实持仓与成本" }
    : frozenMarket?.account.status === "DATA_BLOCKED" || frozenMarket?.account.status === "NOT_AUTHORIZED"
      ? { id: "account", name: "本槽账户读取", tone: "WARNING", status: "账户读取受限", summary: "账户或持仓读取失败；与标的行情、期权链分别判断。", impact: "真实持仓与成本" }
      : { id: "account", name: "本槽账户读取", tone: "EXPECTED", status: "等待本槽", summary: "当前冻结槽尚未形成账户读取证据。", impact: "真实持仓与成本" };
  const quoteProblems = currentPosition?.holdings.filter((item) => !["HEALTHY", "NOT_OBSERVED"].includes(item.quote_status)) ?? [];
  const holding: HealthDomain = quoteProblems.length
    ? { id: "holding", name: "逐持仓合约报价", tone: "WARNING", status: "报价异常", summary: `${quoteProblems.length} 项持仓的逐合约 Bid/Ask 不健康；标的行情、期权链和账户读取不因此判坏。`, impact: "持有、减仓或退出判断" }
    : currentPosition?.holdings.length
      ? { id: "holding", name: "逐持仓合约报价", tone: "GOOD", status: "报价正常", summary: `${currentPosition.holdings.length} 项只读持仓已有独立报价状态。`, impact: "持有、减仓或退出判断" }
      : livePosition?.holdings.length
        ? { id: "holding", name: "逐持仓合约报价", tone: "EXPECTED", status: "等待新槽", summary: "最近持仓建议已过检查点；旧报价只作历史，不判断当前持有、减仓或退出。", impact: "持有、减仓或退出判断" }
      : { id: "holding", name: "逐持仓合约报价", tone: "EXPECTED", status: "没有可检查持仓", summary: "没有真实持仓时不生成报价故障。", impact: "持有、减仓或退出判断" };
  const riskSummary = liveStrategy?.risk_summary;
  const risk: HealthDomain = !riskSummary
    ? { id: "risk", name: "分层风控", tone: "EXPECTED", status: "等待本槽", summary: "等待首份同槽盘型与分层风控证据。", impact: "核心分析、新开仓与单一持仓分别管控" }
    : riskSummary.core_hard_block_count
      ? { id: "risk", name: "分层风控", tone: "WARNING", status: "交易资格硬阻断", summary: `${riskSummary.core_hard_block_count} 项资格证据阻断；确定性系统继续运行，但不得形成可执行结论。`, impact: "本槽交易资格，不等于运行控制面故障" }
      : riskSummary.position_management_block_count
        ? { id: "risk", name: "分层风控", tone: "WARNING", status: "单一持仓受限", summary: `${riskSummary.position_management_block_count} 项持仓报价只阻断各自管理，不影响无关行情分析。`, impact: "对应持仓的持有、减仓或退出" }
        : riskSummary.new_entry_block_count
          ? { id: "risk", name: "分层风控", tone: "EXPECTED", status: "新开仓等待", summary: `${riskSummary.new_entry_block_count} 项盘型或期权成本门禁正在保护新开仓；公司与行情分析继续运行。`, impact: "只影响新机会，不是系统故障" }
          : { id: "risk", name: "分层风控", tone: "GOOD", status: "核心门禁正常", summary: `核心硬阻断为 0；${riskSummary.soft_degrade_count} 项增强证据明确软降级。`, impact: "Shadow 只读分析继续运行" };
  const news: HealthDomain = finnhub?.status === "LIVE" && finnhub.authorization === "VALID"
    ? { id: "news", name: "新闻与财报事件", tone: "GOOD", status: "正常", summary: "官方事件源已授权，当前采集正常。", impact: "System B 事件证据与因果链" }
    : finnhub?.status === "DEGRADED" || finnhub?.status === "STALE" || finnhub?.status === "DATA_BLOCKED" || finnhub?.authorization === "EXPIRED"
      ? { id: "news", name: "新闻与财报事件", tone: "WARNING", status: "能力降级", summary: finnhub.error ?? "新闻或财报能力部分不可用；核心行情与 Agent 自身状态继续单独判断。", impact: "事件证据成熟度，不等于整家公司停工" }
      : { id: "news", name: "新闻与财报事件", tone: "EXPECTED", status: finnhub?.status === "NOT_CONFIGURED" ? "未配置" : "尚未验证", summary: "没有可靠事件证据时保持未观察到，不影响基础行情读取。", impact: "System B 事件证据与因果链" };

  const recentScheduleFaults = state.scheduler.recent.filter((item) => ["MISSED", "FAILED", "DATA_BLOCKED"].includes(item.status) && now - Date.parse(item.status === "MISSED" ? item.scheduled_at : item.completed_at) <= 90 * 60_000);
  const currentScheduleFaults = activeScheduleFaults(state, now);
  const scheduleNormal = currentScheduleFaults.length
    ? { tone: "CRITICAL" as const, status: "运行异常", summary: `最近 90 分钟有 ${currentScheduleFaults.length} 个漏跑、失败或阻断槽。`, impact: "当前自然槽及下游结果" }
    : state.scheduler.today.expected === 0
      ? { tone: "EXPECTED" as const, status: "休市 / 无槽", summary: "今日没有应运行的自然槽。", impact: "不产生虚假漏跑告警" }
      : state.scheduler.today.pending > 0
        ? { tone: "EXPECTED" as const, status: "尚未到槽", summary: `下一次：${state.scheduler.next_run?.label ?? "等待排定"}。`, impact: "尚未到时不算漏跑" }
        : { tone: "GOOD" as const, status: "按计划", summary: "当前健康窗口没有漏跑、失败或阻断。", impact: "自然槽运行" };
  const scheduler = fromIncident("scheduler", "任务调度", current, ["SCHEDULER"], scheduleNormal);
  const agentSelfIssues = current.filter((item) => item.fault_origin === "AGENT_SELF" || item.layer === "RUNTIME");
  const agents = fromIncident("agents", "Agent 运行", agentSelfIssues, ["AGENT", "RUNTIME"], running
    ? { tone: "EXPECTED", status: "运行中", summary: `${running.agent_id} 正在运行。`, impact: "下游等待本槽完成" }
    : recentRun
      ? { tone: "GOOD", status: "已留痕", summary: `最近 ${recentRun.agent_id}：${recentRun.status}。`, impact: "运行与交付状态分别记账" }
      : { tone: "EXPECTED", status: "尚未运行", summary: "等待第一次自然槽。", impact: "没有结果不会冒充成功" });
  const gateway = fromIncident("gateway", "Gateway 与账本", current, ["GATEWAY", "LEDGER"], state.outputCount || state.runLedger.eventCount
    ? { tone: "GOOD", status: "正常", summary: `${state.outputCount} 条输出、${state.runLedger.eventCount} 条运行事件已保存。`, impact: "网站展示与重启恢复" }
    : { tone: "EXPECTED", status: "等待首条结果", summary: "尚无真实写入，不算交付失败。", impact: "当前没有可展示运行结果" });
  const page = fromIncident("page", "页面与 K 线 API", current, ["API"], selfCheckFresh
    ? { tone: "GOOD", status: "正常", summary: "页面数据接口和正式构建已通过最近自检。", impact: "老板可见页面与 K 线" }
    : { tone: "WARNING", status: "待核验", summary: "等待新的完整页面接口自检证据。", impact: "老板可见数据" });
  const maintenance = fromIncident("maintenance", "自动维护", current, ["MAINTENANCE"], selfCheckFresh
    ? { tone: "GOOD", status: "持续运行", summary: "监督器、调度心跳、版本、磁盘及日志备份保留已纳入自检。", impact: "异常恢复、审计记录和长期无人值守" }
    : { tone: "WARNING", status: "待核验", summary: checkedAt ? "完整自检时间无效或已过期，等待新的维护检查证据。" : "等待自动维护首次完整自检。", impact: "尚不能确认当前自动维护状态" });

  const domains = [website, database, market, options, account, holding, risk, news, scheduler, agents, gateway, page, maintenance];
  const attentionDomains = domains.filter((domain) => domain.tone === "WARNING" || domain.tone === "CRITICAL");
  const currentSummary = current.length ? `${current.length} 个当前问题，详见各项证据。` : attentionDomains.length
    ? `当前没有活动 Incident 记录；分层状态：${attentionDomains.map((domain) => `${domain.name}（${domain.status}）`).join("、")}。`
    : "当前没有活动故障。历史问题保留，不影响当前状态。";
  const overall = current.some((item) => item.severity === "CRITICAL") || domains.some((item) => item.tone === "CRITICAL") ? "CRITICAL" as const
    : current.length || domains.some((item) => item.tone === "WARNING") ? "DEGRADED" as const : "HEALTHY" as const;
  const skippedClosed = state.scheduler.recent.filter((item) => item.status === "SKIPPED_MARKET_CLOSED").length;
  const archivedScheduleFaults = state.scheduler.health_window.missed + state.scheduler.health_window.failed + state.scheduler.health_window.blocked - currentScheduleFaults.length;
  const normalNotes = [
    robinhood?.status === "MARKET_CLOSED" ? "市场正常收盘：EOD 数据继续可用，不算断流。" : null,
    truth.market_data_health.classification === "EXPECTED_PROVIDER_SESSION_LIMIT" ? "夜盘Quote能力限制不阻断NEXT_SESSION Forecast；5分钟Bar与Quote分开判断。" : null,
    state.scheduler.today.expected === 0 ? "今天是休市日或没有计划槽，不产生漏跑。" : state.scheduler.today.pending > 0 ? "尚未到槽的任务保持等待，不算漏跑。" : null,
    state.tsSettlement?.pending_count ? `${state.tsSettlement.pending_count} 份正式预测尚未到观察窗口，继续等待，不算结算失败。` : null,
    skippedClosed ? `${skippedClosed} 条休市跳过属于合理跳过。` : null,
    recentScheduleFaults.length > currentScheduleFaults.length ? `${recentScheduleFaults.length - currentScheduleFaults.length} 条近期受阻记录已由后续收盘或结算状态确认恢复，仅保留审计。` : null,
    archivedScheduleFaults > 0 ? `${archivedScheduleFaults} 条较早的漏跑、失败或阻断继续留在审计记录，不计入当前故障。` : null,
    state.scheduler.health_window.initialization_missed ? `${state.scheduler.health_window.initialization_missed} 条历史初始化漏跑仅归档，不计入当前健康。` : !state.scheduler.health_window.initialization_missed && state.scheduler.health_window.historical_missed ? `${state.scheduler.health_window.historical_missed} 条历史漏跑仅归档，不计入当前健康。` : null,
    state.selfCheck.active.some((item) => item.severity === "INFO") ? "信息记录不影响总体健康。" : null,
    news.tone === "WARNING" ? "新闻或财报单项降级只降低事件证据成熟度；核心行情和 Agent 链另行判断。" : null,
  ].filter((item): item is string => Boolean(item));

  const latestFrozenRun = state.runLedger.runs.find((run) => run.slot_id === truth.natural_slot.slot_id) ?? null;
  const latestSuccessfulRun = state.runLedger.runs.find((run) => run.agent_id === "CODEX_GUARD" && run.status === "SUCCEEDED" && run.website_delivery === "DELIVERED") ?? state.runLedger.runs.find((run) => run.status === "SUCCEEDED" && run.website_delivery === "DELIVERED") ?? null;

  return {
    overall,
    status: overall === "HEALTHY" ? "系统正常" : overall === "DEGRADED" ? "需要关注" : "当前有故障",
    ownerAction: current[0]?.owner_action ?? (overall === "HEALTHY" ? "目前不需要处理，继续观察 Shadow。" : "查看下方异常项和建议动作。"),
    nextCheckAt,
    nextScheduledRun,
    selfCheckStatus,
    currentSummary,
    domains,
    current,
    history,
    normalNotes,
    evidenceWindows: {
      current: { checked_at: state.selfCheck.checked_at, status: overall },
      frozen_slot: latestFrozenRun ? { slot_id: latestFrozenRun.slot_id, run_id: latestFrozenRun.run_id, status: truth.natural_slot.status === "RUNNING" ? "IN_PROGRESS" : truth.natural_slot.status, recorded_at: truth.natural_slot.recorded_at ?? latestFrozenRun.event_at } : null,
      latest_success: latestSuccessfulRun ? { slot_id: latestSuccessfulRun.slot_id, run_id: latestSuccessfulRun.run_id, agent_id: latestSuccessfulRun.agent_id, completed_at: latestSuccessfulRun.event_at } : null,
      history_count: history.length,
      next_check_at: nextCheckAt,
    },
  };
}
