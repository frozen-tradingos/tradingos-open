"use client";

// Keep the existing native navigation: Vinext's deployed Owner build requires it.
import { useEffect, useRef, useState } from "react";
import { WorkspaceNav } from "./WorkspaceNav";
import { DetailSheet } from "./DetailSheet";
import { MacroEventNotice } from "./MacroEventNotice";
import { ComplaintBox } from "./ComplaintBox";
import { TsForecastCockpit } from "./LiveMarketChart";
import { OptionsPositionPanel } from "./OptionsPositionPanel";
import { PaperPlans } from "./PaperPlans";
import { PAPER_DAILY_TARGET, paperReportingDay } from "./paper-plan";
import { projectOwnerManualPlans } from "./owner-manual-plan";
import { MarketRadar, MarketDecisionSummary, OwnerOpportunityShortlist } from "./MarketRadar";
import { positionCheckSummary, positionRiskText } from "./today-action";
import { decisionReview } from "./decision-review";
import { nextTimelineOccurrenceOfKind } from "./timeline-schedule";
import { ApprovedBrokerChartPrototype } from "./ApprovedBrokerChartPrototype";
import { buildNextSessionObservation } from "./next-session-observation";
import { buildTsForecastDisplay, resolveTsForecastContext } from "./ts-forecast-state";
import { approvedUniverse, fetchActiveSnapshot, uploadSnapshot, type SnapshotState, type TsOutput } from "./snapshot-import";
import { AGENT_REGISTRY, OUTPUT_ROUTE_REGISTRY, SKILL_REGISTRY, type RunState } from "./agent-ledger";
import { buildHealthOverview, recoveredScheduleFaultReason } from "./health-overview";
import { formatPtDateTime, formatPtTime, isNyseRegularSession, MARKET_5M_MAX_AGE_SECONDS, ptDateKey } from "./market-time";
import { capabilityRetentionAudit, type CapabilityRetentionStatus } from "./capability-retention";
import { emptyTsSettlementOverview, type TsSwingObservation } from "./ts-settlement";
import { emptyInvestmentKernel } from "./investment-kernel";
import { codexManagerOnlineStatus, emptyCodexManagerState, type CodexManagerCommandReceipt } from "./codex-production-manager";
import { buildCurrentTruth } from "./current-truth";
import { emptyExternalExpertOverview, type ExternalExpertFacts } from "./external-expert";
import snapshot from "./v2-sanitized-frozen-snapshot.json";

export type OwnerPage = "home" | "forecast" | "options" | "company" | "health" | "settlements" | "issues";

const pageMeta: Record<OwnerPage, { title: string; subtitle: string }> = {
  home: { title: "今日总览", subtitle: "" },
  forecast: { title: "TS 专业看盘", subtitle: "真实 K 线、概率路径和关键位置集中在一页，不用在长页面里寻找。" },
  options: { title: "持仓", subtitle: "真实持仓、原计划与当前风险。" },
  company: { title: "个股与事件", subtitle: "冻结观察不是实时交易指令，操作前需重新核验。" },
  health: { title: "系统状态", subtitle: "当前影响、需要处理的事与运行证据。" },
  settlements: { title: "研究与复盘", subtitle: "模拟练习与历史观察，不代表真实成交。" },
  issues: { title: "反馈与待办", subtitle: "当前事项与历史处理记录。" },
};

const pageSections: Record<OwnerPage, Array<[string, string]>> = {
  home: [["cockpit", "今日决策"]],
  forecast: [["forecast", "当前预测"], ["market-chart", "K线与路径"], ["forecast-evidence", "预测依据"]],
  options: [["options", "持仓与计划"], ["department-review", "复核依据"]],
  company: [["owner-opportunities", "优先观察"], ["opportunities", "固定池"], ["market-events", "事件日历"], ["timeline", "运行记录"]],
  health: [["health", "当前健康"], ["health-history", "故障与恢复"]],
  settlements: [["event-observation", "事件观察"], ["research-paper", "模拟练习"], ["decision-review", "预测复盘"], ["external-expert", "观察案例"], ["settlement-history", "结算记录"]],
  issues: [["complaints", "投诉"], ["capability-audit", "能力保留"], ["codex", "缺失清单"]],
};

const capabilityStatusText: Record<CapabilityRetentionStatus, string> = {
  PRESERVED_LIVE: "已保留并自然运行", WEBSITE_GAP: "存在但未接入网站", FREEZE_GAP: "存在但未接当前冻结链", NOT_IMPLEMENTED: "尚未实现", RETIRED: "明确退役",
};

const sourceStatusText: Record<string, string> = {
  LIVE: "正常", MARKET_CLOSED: "已收盘", STALE: "已过期", DEGRADED: "部分中断", DATA_BLOCKED: "数据被阻断",
  NOT_CONFIGURED: "未配置", NOT_VERIFIED: "未验证", DISABLED_BACKUP: "停用备用",
};
const authorizationText: Record<string, string> = { VALID: "授权有效", EXPIRED: "授权失效", NOT_CONFIGURED: "未配置", NOT_VERIFIED: "未验证", NOT_APPLICABLE: "不适用" };
const macroReleaseText: Record<string, string> = { "Employment Situation": "非农就业报告", "Producer Price Index": "PPI生产者价格指数", "Consumer Price Index": "CPI消费者价格指数", "FOMC Meeting Decision": "美联储利率决定", "Gross Domestic Product": "GDP", "Personal Income and Outlays": "个人收入与支出" };
const macroStudyStageText: Record<string, string> = { PREVIEW: "当前公式推演（未冻结）", FREEZE_PENDING: "尚未独立冻结判断", FROZEN: "预测已锁定（公布前不改）", WAITING_RESULT: "等待公布结果", REVIEWED: "结果已复盘", NOT_FROZEN: "未形成可评分的事前判断", RECONSTRUCTED_RESEARCH: "基于旧资料重算，不算事前预测" };
const acceptanceKinds = ["A1_HEARTBEAT", "LOCAL_GUARD", "CODEX_GUARD", "POSITION_MONITOR", "FULL_ANALYSIS", "TS_FORECAST", "TS_SETTLEMENT", "DAILY_REVIEW"] as const;
const ownerText: Record<string, string> = {
  LIVE: "实时正常", MARKET_CLOSED: "市场已收盘", STALE: "数据已过期", DEGRADED: "部分功能受限", DATA_BLOCKED: "数据被阻断", CRITICAL: "严重故障", HEALTHY: "正常",
  NOT_CONFIGURED: "未配置", NOT_VERIFIED: "未验证", DISABLED_BACKUP: "已停用（备用）", NOT_OBSERVED: "未观察到", NOT_APPLICABLE: "不适用", NOT_SUPPORTED: "暂不支持", NOT_RUN: "尚未运行",
  SUCCEEDED: "已成功", FAILED: "失败", TIMED_OUT: "已超时", STARTED: "已开始", RUNNING: "运行中", SKIPPED: "已跳过", MISSED: "漏跑", SKIPPED_MARKET_CLOSED: "休市跳过",
  NOT_PRODUCED: "未产出", PRODUCED: "已产出", NOT_ATTEMPTED: "未尝试送达", PENDING: "等待送达", DELIVERED: "已送达",
  SHADOW: "影子验证", PRODUCTION: "正式结果", SYSTEM: "系统", REGISTRY: "已登记", REPLAY: "历史回放",
  RANGE: "震荡", BULLISH: "偏涨", BEARISH: "偏跌", bullish: "偏涨", bearish: "偏跌", range: "震荡", UNKNOWN: "方向未定", unknown: "方向未定", mixed: "方向有分歧", entering: "资金进入", exiting: "资金退出", strengthening: "趋势增强", reversing: "方向反转",
  WAIT: "等待条件", CONDITIONAL: "满足条件后再复核", READY_FOR_D_REVIEW: "可交 D 复核（不是交易批准）", NO_TRADE: "不交易", BLOCKED: "已阻断", DEGRADED_NO_TRADE: "数据不足，不交易", NONE: "无",
  OPENING_FORECAST: "开盘预测", OPEN_15M_CHECK: "开盘15分钟复核", OPEN_30M_CHECK: "开盘30分钟复核", INTRADAY_30_60M: "盘中复核", NEXT_SESSION: "下一交易日预判", WEEKEND_OUTLOOK: "周末展望",
  NEW: "新结果", CHECK: "复核", SCHEMA_READ: "合同结构已读取", RULES_READ: "验收规则已读取", PRIMARY_AGENT: "主要部门", OWNER_WORKFLOW: "老板流程", SYSTEM_WORKFLOW: "系统流程", CLOSING_WORKFLOW: "收工流程",
  VERIFIED: "已核验", UNVERIFIED: "未核验", SCHEDULED: "已排期", NOT_CONFIRMED: "未确认", CONFIRMED: "已确认", CONTESTED: "存在争议", MARKET_MOVING: "重大市场事件", earnings: "财报", general: "一般新闻",
  EARLY_WATCH: "早期观察", EXTENDED: "已经走远，不追", REPORTED_WAITING_REACTION: "结果已公布，等待价格验证", IMPACT_OBSERVED: "结果与价格反应已记录", BMO: "盘前公布", AMC: "盘后公布", DMH: "盘中公布",
  volume_breakout: "放量突破", breakout: "突破待确认", false_breakout: "假突破", symmetrical_triangle: "收敛三角", ascending_triangle: "上升三角", descending_triangle: "下降三角", higher_high_higher_low: "高低点抬高", lower_high_lower_low: "高低点下移", unavailable: "数据不足",
  trend_continuation: "趋势延续", breakout_pending_confirmation: "突破待确认", breakout_watch: "关注突破", breakdown_watch: "关注跌破", compression: "波动收窄", failed: "结构失效", unclear: "方向未清",
  SERVICE: "网站服务", DATABASE: "本地数据库", TIME: "时间体系", API: "页面接口", DATA: "数据源", EVIDENCE: "证据", SCHEDULER: "任务调度", AGENT: "部门运行", GATEWAY: "网站写入", LEDGER: "运行账本", RUNTIME: "后台运行", MAINTENANCE: "自动维护", DESKTOP: "桌面程序",
  AGENT_SELF: "Agent 自身故障", UPSTREAM_DATA: "上游数据阻断", UPSTREAM_DEPARTMENT: "上游部门阻断", DELIVERY: "交付链故障", CURRENT_REALTIME: "当前实时状态", CURRENT_SLOT: "当前自然槽", FROZEN_SLOT: "本槽冻结证据",
  INFO: "信息", WARNING: "警告", NO_PRESET_BIAS: "不预设方向",
  PASS: "通过", EXPECTED: "正常等待", NOT_DUE: "尚未到检查时间", PARTIAL: "部分吻合", INVALIDATED: "未吻合",
  ELIGIBLE_NATURAL_EVIDENCE: "具备自然证据统计资格", NOT_ELIGIBLE: "不具备统计资格", NOT_FINAL: "尚未形成最终状态",
  RESOLVED: "已完整结算", NOT_REPORTED: "未上报", OFFICIAL_LIVE: "自然 LIVE 样本", EXCLUDED_REPLAY: "回放样本（不计准确率）", EXCLUDED_NON_LIVE: "非自然样本（不计准确率）",
  INITIAL: "初始判断", EARLY_REVISION: "早盘修正", INTRADAY_REVISION: "盘中修正", FINAL: "收盘 / 次日判断",
  MAIN: "主路径", REVERSE: "反向路径", EXTREME: "极端路径", UNRESOLVED: "路径未形成唯一结果", MAIN_CORRECT: "主路径吻合", ALTERNATE_PATH: "走了备用路径", ON_TIME: "在观察窗口内完成", NOT_SCORABLE: "合同不支持客观评分", CORRECT: "区间内", BREACHED: "突破预测区间",
  PREMARKET: "盘前检查", EARLY: "早盘检查", INTRADAY: "盘中检查", POST_CLOSE: "收盘后检查", DAILY_CLOSE: "每日收工复盘", POST_DEPLOY: "部署后检查",
  SAFE_TO_CONTINUE: "明天可安全继续", CONTINUE_WITH_CAUTION: "明天可继续，但需观察", OWNER_ACTION_REQUIRED: "需要老板处理后再确认",
  EXECUTABLE: "可人工执行", OBSERVE: "观察", HOLD: "继续持有", REDUCE: "减仓", EXIT: "退出", MANUAL_REDUCE: "人工减仓", MANUAL_EXIT: "人工退出", MANUAL_ADJUST: "人工调整",
  ALIGNMENT: "部门结论", WEBSITE: "网站交付", WORK_QUEUE: "故障与待办", PLATFORM: "部署与数据库", PREDICTION: "预测复盘",
  EOD: "官方日终值", OBSERVED: "已观察到", INITIALIZING: "自然槽积累中", TREND_UP: "上升趋势", TREND_DOWN: "下降趋势", NARROW_RANGE: "窄幅震荡", WIDE_CHOP: "宽幅震荡", TRANSITION: "盘型过渡中",
  OVERNIGHT_FUTURES_NOT_SUPPORTED_BY_OFFICIAL_ROBINHOOD_MCP: "当前官方只读源不支持期货", EXTENDED_HOURS_NOT_OBSERVED: "本轮未观察到延长时段成交", XSP_24_5_NOT_SUPPORTED: "XSP 官方24小时行情不支持", FIXED70_EXTENDED_HOURS_READ_FAILED: "固定池部分延长时段读取失败",
  REGULAR: "正常交易时段", AFTER_HOURS: "盘后", OVERNIGHT: "隔夜", CLOSED: "休市", OFFICIAL_OHLCV: "官方完整K线", LOCAL_SAMPLED_QUOTE: "本地采样官方报价", RECENT_EOD: "最近可用EOD", READ_FAILED: "读取失败",
  OPEN: "观察中", PARTIAL_EXIT: "部分出场", RECAP_ONLY: "仅复盘", DELAYED: "延迟", LATE_RECAP: "事后复盘", OFFLINE_RECAP: "关机补交",
  HARD_DATA_BLOCK: "关键数据阻断", MODEL_EVIDENCE_INSUFFICIENT: "模型证据不足", EVIDENCE_CONFLICT: "证据冲突", STALE_OR_EXPIRED: "证据过期", DELIVERY_OR_OWNERSHIP_FAILURE: "交付或所有权失败", STATE_OR_ENGINEERING_BLOCK: "状态或工程阻断", POSSIBLE_OVERBLOCK: "疑似错误风控",
};

function displayText(value: unknown, fallback = "未观察到") {
  if (value === null || value === undefined || value === "") return fallback;
  return ownerText[String(value)] ?? String(value);
}
function evidenceText(value: unknown) { return value === "PARTIAL" ? "证据不完整" : displayText(value); }
function factsText(value: ExternalExpertFacts | null) {
  if (!value || !Object.keys(value).length) return "未提供";
  return Object.entries(value).slice(0, 8).map(([key, item]) => `${displayText(key)}：${Array.isArray(item) ? item.join("、") : item && typeof item === "object" ? JSON.stringify(item) : displayText(item)}`).join("；");
}

function percent(value: number | null) { return value === null ? "样本不足" : `${(value * 100).toFixed(1)}%`; }
function confidence(value: [number, number] | null) { return value ? `${percent(value[0])}–${percent(value[1])}` : "证据不足"; }
function swingText(symbol: "SPY" | "QQQ", value: TsSwingObservation) {
  const sequence = value.first_extreme === "HIGH_FIRST" ? "先见高点" : value.first_extreme === "LOW_FIRST" ? "先见低点" : "高低点同一根 K 线，先后无法确认";
  const excursion = value.favorable_excursion_pct === null ? "发布方向为震荡，不评分有利/不利波动" : `有利波动 ${value.favorable_excursion_pct.toFixed(2)}% · 不利波动 ${value.adverse_excursion_pct!.toFixed(2)}%`;
  return `${symbol}：${excursion} · ${sequence}`;
}

function sourceName(value: string) {
  return value === "ROBINHOOD" ? "Robinhood" : value === "FINNHUB" ? "Finnhub" : value === "TRADIER" ? "Tradier" : value;
}

const initialData: SnapshotState = {
  payload: null,
  archiveCount: 0,
  outputCount: 0,
  recentOutputs: [],
  runLedger: { agents: AGENT_REGISTRY, skills: SKILL_REGISTRY, routes: OUTPUT_ROUTE_REGISTRY, eventCount: 0, runs: [] },
  selfCheck: { status: "HEALTHY", checked_at: null, last_backup_at: null, active: [], recent: [] },
  dataSources: [
    { source: "ROBINHOOD", status: "NOT_VERIFIED", configured: false, authorization: "NOT_VERIFIED", last_success_at: null, as_of: null, freshness_seconds: null, error: "尚未验证", checked_at: new Date(0).toISOString(), capabilities: {} },
    { source: "FINNHUB", status: "NOT_CONFIGURED", configured: false, authorization: "NOT_CONFIGURED", last_success_at: null, as_of: null, freshness_seconds: null, error: "尚未配置", checked_at: new Date(0).toISOString(), capabilities: { news: false, earnings_calendar: false, earnings_results: false } },
    { source: "TRADIER", status: "DISABLED_BACKUP", configured: false, authorization: "NOT_APPLICABLE", last_success_at: null, as_of: null, freshness_seconds: null, error: "账户已停用", checked_at: new Date(0).toISOString(), capabilities: {} },
  ],
  marketIntelligence: { eventCount: 0, events: [], causalChains: [] },
  scheduler: { timezone: "America/Los_Angeles", checked_at: new Date(0).toISOString(), next_run: null, today: { date: "", expected: 0, completed: 0, missed: 0, failed: 0, blocked: 0, pending: 0 }, health_window: { dates: [], completed: 0, missed: 0, failed: 0, blocked: 0, historical_missed: 0, initialization_missed: 0 }, groups: [], recent: [] },
  marketRadar: { snapshot: null, source_record_id: null, market_snapshot_id: null, market_snapshot_hash: null, archived_at: null },
  tsSettlement: emptyTsSettlementOverview(new Date(0).toISOString()),
  ownerTrigger: { current: { SPY: null, QQQ: null }, recent: [] },
  investmentKernel: emptyInvestmentKernel("OWNER"),
  codexManager: emptyCodexManagerState(),
  spxwProxy: { mode: "SPY_SPXW_PROXY", spx_spot_status: "DATA_BLOCKED", analysis_basis: "SPY", reference_index: "SPX", product: "SPX_SPXW_OPTIONS", watches: [], real_holdings: [], owner_observations: [] },
  spxConvexity: { contract_version: "SPX_CONVEXITY_LEDGER_V1", status: "NOT_CONFIGURED", data_mode: "SPY_PROXY", spx_spot_status: "DATA_BLOCKED", capital_context: null, current: null, history: [], statistics: { path_candidates: 0, path_confirmations: 0, qualified_candidate_sets: 0, owner_capital_fit_sets: 0, open_participation_windows: 0, owner_executions: 0, broker_profit_or_loss_events: 0, missed_by_late_confirmation: 0, owner_did_not_execute: 0, hindsight_research_cases: 0 } },
  optionLifecycle: { activated_at: new Date(0).toISOString(), live_strategy_count: 0, live_position_state_count: 0, pending_count: 0, settled_count: 0, recent_settlements: [] },
  externalExpert: emptyExternalExpertOverview(),
  ownerQueue: { open_complaints: 0, pending_approval: 0, total_complaints: 0, closed_complaints: 0 },
  outputs: {
    TS_OUTPUT: [],
    A1_SHADOW_RESULT: null,
    A2_SHADOW_RESULT: null,
    TS_SHADOW_OUTPUT: [],
    TS_SIGNAL_CANDIDATE: [],
    TS_SIGNAL_CANDIDATE_SETTLEMENT: [],
    CODEX_GUARD_SHADOW: null,
    COMMITTEE_SHADOW_OUTPUT: null,
    D_SHADOW_OUTPUT: null,
    A3_REVIEW_SHADOW: null,
    A3_FINAL_SHADOW: null,
    A2_HALF_HOUR_FORECAST: null,
    COMMITTEE_OUTPUT: null,
    D_OUTPUT: null,
    A3_REVIEW: null,
    A3_FINAL: null,
    CODEX_GUARD: null,
    DELIVERY_RECONCILIATION: null,
    SCHEDULE_CHECKPOINT: [],
    OPTION_STRATEGY_SIGNAL: [],
    POSITION_COPILOT_STATE: [],
    STOCK_MANUAL_PLAN: [],
  },
};

function outputTime(output: TsOutput) {
  return formatPtTime(output.evidence_snapshot.market_time.observed_at);
}

function timelineObservation(field: string, outputs: TsOutput[] | null) {
  if (!outputs) return null;
  if (field.includes("INTRADAY_30_60M")) {
    const count = outputs.filter((output) => output.report_type === "INTRADAY_30_60M").length;
    return count ? `已导入 ${count} / 11 份` : null;
  }
  const reportType = field.match(/report_type=([A-Z0-9_]+)/)?.[1];
  const output = outputs.find((item) => item.report_type === reportType);
  return output ? `已导入 ${outputTime(output)} · ${output.evidence_snapshot.run_id}` : null;
}

function timelineRunObservation(time: string, runs: RunState[]) {
  const times: string[] = time.match(/\d{2}:\d{2}/g) ?? [];
  const matching = times.length === 2 && time.includes("–")
    ? runs.filter((run) => /^\d{2}:\d{2}$/.test(run.slot_id) && run.slot_id >= times[0] && run.slot_id <= times[1])
    : runs.filter((run) => times.includes(run.slot_id));
  if (!matching.length) return null;
  const summary = [...new Set(matching.map((run) => displayText(run.status)))].join(" / ");
  return `${matching.length} 项运行 · ${summary}`;
}

function deliverySummary(run: RunState) {
  return `结果${displayText(run.output_status)} · 网站${displayText(run.website_delivery)} · 外部消息${displayText(run.discord_delivery)}`;
}

export default function TradingOsApp({ page = "home" }: { page?: OwnerPage }) {
  return page === "forecast" ? <div className="workspace-shell"><WorkspaceNav page={page} /><ApprovedBrokerChartPrototype /></div> : <TradingOsLegacyApp key={page} page={page} />;
}

function TradingOsLegacyApp({ page }: { page: OwnerPage }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [managerStarting, setManagerStarting] = useState(false);
  const [managerCommandId, setManagerCommandId] = useState<string | null>(null);
  const [managerCommand, setManagerCommand] = useState<CodexManagerCommandReceipt | null>(null);
  const [researchPaper, setResearchPaper] = useState<{ overview?: SnapshotState["paperPlans"]; error?: string }>({});
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState<number | null>(null);
  const [importState, setImportState] = useState<SnapshotState & { notice: { kind: "ok" | "error"; text: string } | null }>({ ...initialData, notice: null });

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = () => {
      setCurrentTime(Date.now());
      if (refreshing) return;
      refreshing = true;
      void fetchActiveSnapshot(page)
      .then((restored) => {
        if (!active) return;
        setCurrentTime(Date.now());
        setSnapshotError(null);
        setSnapshotUpdatedAt(restored.snapshotGeneratedAt ? Date.parse(restored.snapshotGeneratedAt) : null);
        setImportState((current) => ({ ...restored, notice: current.notice }));
      })
      .catch((error) => {
        if (active) setSnapshotError(error instanceof Error ? error.message : "页面数据读取失败");
      }).finally(() => { refreshing = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [page]);

  useEffect(() => {
    if (page !== "settlements") return;
    // Paper tickets use an existing read-only view; their availability never blocks the review page.
    let active = true, refreshing = false;
    const refreshPaper = () => {
      if (refreshing) return;
      refreshing = true;
      void fetchActiveSnapshot("home")
        .then((state) => { if (active) setResearchPaper({ overview: state.paperPlans }); })
        .catch(() => { if (active) setResearchPaper((current) => ({ ...current, error: "模拟单更新失败；若下方有记录，为上次读取内容，不是最新状态。" })); })
        .finally(() => { refreshing = false; });
    };
    refreshPaper();
    const timer = window.setInterval(refreshPaper, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [page]);

  useEffect(() => {
    setManagerCommandId(window.localStorage.getItem("trading-os-manager-command:v1"));
  }, []);

  useEffect(() => {
    if (!managerCommandId) return;
    let active = true;
    let timer = 0;
    const refresh = async () => {
      const response = await fetch(`/api/codex-manager?command_id=${encodeURIComponent(managerCommandId)}`);
      const result = await response.json() as CodexManagerCommandReceipt & { error?: string };
      if (response.status === 404) {
        window.clearInterval(timer);
        window.localStorage.removeItem("trading-os-manager-command:v1");
        if (active) { setManagerCommandId(null); setManagerCommand(null); }
        return;
      }
      if (!response.ok) throw new Error(result.error ?? "经理任务读取失败");
      if (!active) return;
      setManagerCommand(result);
      if (["SUCCEEDED", "FAILED", "TIMED_OUT"].includes(result.status)) {
        window.clearInterval(timer);
        setImportState((current) => ({ ...current, notice: { kind: result.status === "SUCCEEDED" ? "ok" : "error", text: `经理任务 ${result.manager_run_id} · ${result.status}${result.error ? ` · ${result.error}` : ""}` } }));
      }
    };
    const failed = (error: unknown) => { window.clearInterval(timer); if (active) setImportState((current) => ({ ...current, notice: { kind: "error", text: error instanceof Error ? error.message : "经理任务回读失败" } })); };
    void refresh().catch(failed);
    timer = window.setInterval(() => void refresh().catch(failed), 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [managerCommandId]);

  useEffect(() => {
    if (page !== "home") return;
    const legacyRoute = ({ forecast: "/forecast", timeline: "/company", patrol: "/company", health: "/health", comparison: "/settlements", complaints: "/issues", codex: "/issues" } as Record<string, string>)[window.location.hash.slice(1)];
    if (legacyRoute) window.location.replace(legacyRoute);
  }, [page]);

  async function handleImport(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw new Error("数据快照超过 5 MB，未导入且现有数据未改变");
      const result = await uploadSnapshot(await file.text());
      setImportState({ ...result, notice: { kind: "ok", text: "数据快照已写入本地数据库并保留原文" } });
    } catch (error) {
      setImportState((current) => ({ ...current, notice: { kind: "error", text: error instanceof Error ? error.message : "数据快照导入失败，现有数据未改变" } }));
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function runCodexManager() {
    setManagerStarting(true);
    try {
      const response = await fetch("/api/codex-manager", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trigger: "OWNER_MANUAL" }) });
      const result = await response.json() as { error?: string; command_id?: string; status?: string };
      if (!response.ok) throw new Error(result.error ?? "Codex经理未能启动");
      if (result.command_id) {
        window.localStorage.setItem("trading-os-manager-command:v1", result.command_id);
        setManagerCommandId(result.command_id);
      }
      setImportState((current) => ({ ...current, notice: { kind: "ok", text: `经理任务 ${result.command_id ?? "身份未返回"} · ${result.status ?? "QUEUED"}；页面会持续显示同一任务结果。` } }));
    } catch (error) {
      setImportState((current) => ({ ...current, notice: { kind: "error", text: error instanceof Error ? error.message : "Codex经理启动失败" } }));
    } finally {
      setManagerStarting(false);
    }
  }

  const contracts = importState.payload?.contracts;
  const tsOutputs = importState.outputs.TS_OUTPUT.length ? importState.outputs.TS_OUTPUT : contracts?.TS_OUTPUT ?? null;
  const latestTs = tsOutputs?.reduce<TsOutput | null>((latest, output) => !latest || Date.parse(output.evidence_snapshot.market_time.observed_at) > Date.parse(latest.evidence_snapshot.market_time.observed_at) ? output : latest, null) ?? null;
  const currentTruth = importState.currentTruth ?? buildCurrentTruth(importState, currentTime);
  const latestShadowSlot = currentTruth.natural_slot.slot_id;
  const latestRun = (agentId: string) => importState.runLedger.runs.find((run) => run.slot_id === latestShadowSlot && run.agent_id === agentId) ?? null;
  const currentOutputReady = (agentId: string) => {
    const run = latestRun(agentId);
    return run?.status === "SUCCEEDED" && run.output_status === "PRODUCED" && run.website_delivery === "DELIVERED";
  };
  const outputUnavailableReason = (agentId: string, label: string) => {
    const run = latestRun(agentId);
    return run?.status === "FAILED" ? `${label} 本槽运行失败，上游没有生成当前结果`
      : run?.status === "TIMED_OUT" ? `${label} 本槽运行超时，上游没有生成当前结果`
        : run?.status === "DATA_BLOCKED" || run?.status === "SKIPPED" ? `上游数据或门禁阻断，${label} 本槽没有生成结果`
          : run?.status === "RUNNING" || run?.status === "STARTED" ? `${label} 当前槽正在运行`
            : latestShadowSlot ? `当前槽尚未运行到 ${label}` : "尚未积累自然 LIVE 槽";
  };
  const shadowTsOutputs = importState.outputs.TS_SHADOW_OUTPUT;
  const latestTsCandidate = importState.outputs.TS_SIGNAL_CANDIDATE[0] ?? null;
  const latestTsCandidateSettlements = latestTsCandidate ? importState.outputs.TS_SIGNAL_CANDIDATE_SETTLEMENT.filter((item) => item.candidate_forecast_id === latestTsCandidate.candidate_forecast_id) : [];
  const latestShadowTs = shadowTsOutputs.reduce<TsOutput | null>((latest, output) => !latest || Date.parse(output.evidence_snapshot.market_time.observed_at) > Date.parse(latest.evidence_snapshot.market_time.observed_at) ? output : latest, null);
  const latestCompletedShadowSlot = importState.runLedger.runs.find((run) => run.channel === "SHADOW" && run.slot_id.startsWith("live-shadow:") && run.agent_id === "TS" && run.status === "SUCCEEDED" && run.output_status === "PRODUCED" && run.website_delivery === "DELIVERED")?.slot_id ?? null;
  const shadowTsIsCurrent = Boolean(latestCompletedShadowSlot && latestCompletedShadowSlot === latestShadowSlot && currentOutputReady("TS"));
  const shadowTsScope = latestShadowTs ? shadowTsIsCurrent ? ["NEXT_SESSION", "WEEKEND_OUTLOOK"].includes(latestShadowTs.report_type) ? "次日初步预测" : "当前已完成槽" : `最近已完成槽 · ${formatPtDateTime(latestShadowTs.evidence_snapshot.market_time.observed_at)}` : "尚无已完成自然槽";
  const displayTs = latestShadowTs;
  const displayTsOutputs = shadowTsOutputs;
  const tsUnavailableReason = outputUnavailableReason("TS", "TS").replace("当前结果", "当前预测").replace("没有生成结果", "没有生成预测");
  const committeeUnavailableReason = outputUnavailableReason("COMMITTEE", "独立评审组");
  const dUnavailableReason = outputUnavailableReason("D", "D");
  const a3UnavailableReason = outputUnavailableReason("A3", "A3");
  const latestA1Shadow = importState.outputs.A1_SHADOW_RESULT;
  const a1Shadow = currentOutputReady("A1") ? latestA1Shadow : null;
  const a2Shadow = currentOutputReady("A2") ? importState.outputs.A2_SHADOW_RESULT : null;
  const officialMacro = latestA1Shadow?.official_macro;
  const macroCalendar = importState.macroEventLearning?.calendar;
  const specialDays = importState.macroEventLearning?.special_days ?? [];
  const eventProjectionAt = currentTime || Date.parse(officialMacro?.collected_at ?? "") || 0;
  const eventProjectionPtDate = ptDateKey(eventProjectionAt);
  const upcomingMacroEvents = (macroCalendar?.events ?? officialMacro?.events ?? []).filter((event) => event.time_precision === "DATE_ONLY" ? event.scheduled_at.slice(0, 10) >= eventProjectionPtDate : Date.parse(event.scheduled_at) >= eventProjectionAt).toSorted((left, right) => Date.parse(left.scheduled_at) - Date.parse(right.scheduled_at));
  const nextMacroEvent = upcomingMacroEvents[0] ?? null;
  const macroCoverageGood = Boolean(officialMacro?.coverage && Object.values(officialMacro.coverage).every((status) => status === "LIVE"));
  const macroOwnerStatus = macroCoverageGood ? "LIVE" : officialMacro?.status ?? "NOT_OBSERVED";
  const nextMacroWhen = nextMacroEvent ? nextMacroEvent.time_precision === "DATE_ONLY" ? `${nextMacroEvent.scheduled_at.slice(0, 10)}（仅日期）` : formatPtDateTime(nextMacroEvent.scheduled_at) : null;
  const latestMacroResult = officialMacro?.results.at(-1) as { status?: string; release_name?: string; scheduled_at?: string } | undefined;
  const marketSources = a1Shadow?.market_sources;
  const currentApprovedCapabilities = marketSources?.approved_capabilities;
  const currentFixedUsable = Boolean(currentApprovedCapabilities?.fixed_pool.observed_count);
  const approvedCapabilities = currentFixedUsable ? currentApprovedCapabilities : importState.marketRadar.snapshot ?? currentApprovedCapabilities ?? undefined;
  const fixedUniverseSize = approvedUniverse(approvedCapabilities?.contract_version).length;
  const fixedCandidates = approvedCapabilities?.fixed_pool.candidates ?? [];
  const specialEarnings = approvedCapabilities?.earnings_center.items.find((item) => item.result_status === "IMPACT_OBSERVED" && fixedCandidates.includes(item.symbol)) ?? approvedCapabilities?.earnings_center.items.find((item) => fixedCandidates.includes(item.symbol)) ?? null;
  const specialNews = approvedCapabilities?.event_scan.items.find((item) => item.affected_symbols.some((symbol) => fixedCandidates.includes(symbol))) ?? null;
  const specialSymbol = specialEarnings?.symbol ?? specialNews?.affected_symbols.find((symbol) => fixedCandidates.includes(symbol)) ?? null;
  const specialRow = approvedCapabilities?.fixed_pool.rows.find((row) => row.symbol === specialSymbol) ?? null;
  const upcomingEarnings = (approvedCapabilities?.earnings_center.items ?? []).filter((item) => item.result_status === "SCHEDULED" && fixedCandidates.includes(item.symbol) && item.scheduled_for.slice(0, 10) >= eventProjectionPtDate);
  const upcomingSpecialEvents = [
    ...upcomingMacroEvents.map((event) => ({ id: String(event.event_id ?? `${event.release_name}-${event.scheduled_at}`), date: event.scheduled_at.slice(0, 10), scheduledAt: event.scheduled_at, title: macroReleaseText[event.release_name] ?? event.release_name, when: event.time_precision === "DATE_ONLY" ? `${event.scheduled_at.slice(0, 10)} · 官方日历仅日期` : formatPtDateTime(event.scheduled_at), detail: `${String(event.agency ?? "官方机构")} · 已排期；学习预测单独冻结，不改写正式TS` })),
    ...upcomingEarnings.map((item) => ({ id: `earnings-${item.symbol}-${item.scheduled_for}`, date: item.scheduled_for.slice(0, 10), scheduledAt: item.scheduled_for, title: `${item.symbol} · 财报`, when: `${item.scheduled_for.slice(0, 10)} · ${displayText(item.session)}`, detail: "观察池事件观察；结果公布前不推断方向" })),
  ].toSorted((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt));
  const macroLearningStudies = importState.macroEventLearning?.studies ?? [];
  const specialEventTitle = macroLearningStudies.length ? "宏观事件学习预测" : upcomingSpecialEvents[0] ? `${upcomingSpecialEvents[0].title} · ${upcomingSpecialEvents[0].when}` : specialSymbol ? `${specialSymbol} · ${specialEarnings ? "财报后观察" : "重大事件观察"}` : "当前没有通过门禁的特别事件";
  const specialEventReason = specialEarnings
    ? `${displayText(specialEarnings.result_status)} · ${displayText(specialRow?.swing.direction)} · ${displayText(specialRow?.swing.stage)}。${specialEarnings.why_watch}；下一次：${specialEarnings.next_check}。仅为Shadow研究，不是正式TS信号。`
    : specialNews ? `${specialNews.title} · ${evidenceText(specialNews.evidence_state)}。仅为Shadow研究，不是正式TS信号。`
      : "只显示观察池候选池中同时具备财报或已映射重大事件证据的标的；普通新闻不会占位。";
  const fixedAnalysisPending = Boolean(approvedCapabilities && !currentFixedUsable);
  const fixedReadFailed = currentApprovedCapabilities?.fixed_pool.observed_count === 0 || ["FAILED", "TIMED_OUT", "DATA_BLOCKED"].includes(latestRun("A1")?.status ?? "");
  const fixedMultiframeReady = approvedCapabilities?.fixed_pool.data_grade === "OFFICIAL_READONLY_MULTI_TIMEFRAME_SWING";
  const fixedPoolOwnerStatus = approvedCapabilities?.fixed_pool.rows.find((row) => row.status !== "DATA_BLOCKED")?.status ?? approvedCapabilities?.fixed_pool.status ?? "NOT_OBSERVED";
  const marketEnvironment = marketSources?.market_environment;
  const officialMarket = officialMacro?.market_context;
  const treasuryValue = (metric: string) => officialMarket?.treasury_yields.observations.find((item) => item.metric === metric)?.value ?? null;
  const wtiValue = officialMarket?.wti.observations.find((item) => item.metric === "WTI_CUSHING_SPOT")?.value ?? null;
  const patternEvidence = a2Shadow?.pattern_evidence;
  const currentRobinhood = importState.dataSources.find((source) => source.source === "ROBINHOOD") ?? null;
  const sourceAge = (asOf: string | null) => asOf ? Math.max(0, Math.round(((currentTime || Date.parse(asOf)) - Date.parse(asOf)) / 1_000)) : null;
  const marketStatus = (status: string, asOf: string | null) => status === "LIVE" && (sourceAge(asOf) ?? Number.POSITIVE_INFINITY) > MARKET_5M_MAX_AGE_SECONDS ? "STALE" : status;
  const sourceSummary = marketSources?.providers.map((provider) => {
    const age = sourceAge(provider.as_of);
    const status = marketStatus(provider.status, provider.as_of);
    if (provider.source === "ROBINHOOD" && currentRobinhood?.status === "MARKET_CLOSED") return `Robinhood 市场已收盘 · 本槽冻结于 ${provider.as_of ? formatPtDateTime(provider.as_of) : "未观察到"}`;
    return `${sourceName(provider.source)} ${displayText(status)}${age !== null ? ` · ${age}秒` : ""}`;
  }).join(" / ") ?? "未观察到";
  const quoteSummary = marketSources?.quotes.map((quote) => `${quote.symbol} ${quote.last ?? "数据源未返回"} · 本槽冻结 ${quote.as_of ? formatPtDateTime(quote.as_of) : "时间未上报"} · 发布时${displayText(quote.status)}`).join(" / ") ?? "上游尚未生成行情快照";
  const shadowFreshness = a1Shadow ? Math.max(0, Math.round(((currentTime || Date.parse(a1Shadow.observed_at)) - Date.parse(a1Shadow.data_cutoff_at)) / 1_000)) : null;
  const healthState = (contract: string) => contract.startsWith("TS_OUTPUT") ? (shadowTsOutputs.length ? `${shadowTsOutputs.length} 份影子验证输出` : latestRun("TS")?.status ?? null)
    : contract.startsWith("A2_HALF") ? a2Shadow?.status ?? latestRun("A2")?.status ?? null
      : contract.startsWith("delivery") ? latestRun("A3")?.website_delivery ?? latestRun("D")?.website_delivery ?? null
        : contract.startsWith("CODEX_GUARD") ? healthOverview.overall
        : null;
  const healthServices = [...snapshot.system_health, { name: "Codex Guard", contract: "CODEX_GUARD v1", schema_state: "SCHEMA_READ", runtime_state: null, expected: "仅显示本地写入的合同状态，不探测 Production", fields: ["status", "faults", "restart_recommended", "owner_message"] }];
  const slotOutput = (slot: { time: string; report_type: string }) => displayTsOutputs?.find((output) => output.report_type === slot.report_type && outputTime(output) === slot.time) ?? null;
  const shadowRuntimeStatus = currentRobinhood ? marketStatus(currentRobinhood.status, currentRobinhood.as_of) : a1Shadow?.status ?? latestRun("A1")?.status ?? "NOT_RUN";
  const healthOverview = buildHealthOverview(importState, currentTime);
  const criticalIncident = healthOverview.current.find((incident) => incident.severity === "CRITICAL" && (incident.owner_required || currentTruth.health_status === "BLOCKED")) ?? null;
  const systemStatus = healthOverview.overall;
  const committeeShadow = (currentOutputReady("COMMITTEE") ? importState.outputs.COMMITTEE_SHADOW_OUTPUT : null) as { flow_state?: string; direction?: string; confidence?: number; summary?: string; evidence_for?: string[]; evidence_against?: string[]; data_gaps?: string[] } | null;
  const dShadow = (currentOutputReady("D") ? importState.outputs.D_SHADOW_OUTPUT : null) as { action?: string; score?: number; summary?: string; entry_conditions?: string[]; invalidation?: string[]; data_gaps?: string[] } | null;
  const a3ReviewShadow = (currentOutputReady("A3") ? importState.outputs.A3_REVIEW_SHADOW : null) as { conflict_detected?: boolean; review_required?: boolean; review_target?: string; reason?: string } | null;
  const a3Shadow = (currentOutputReady("A3") ? importState.outputs.A3_FINAL_SHADOW : null) as { decision?: string; score?: number; plain_language?: string; supporting_evidence?: string[]; conflicts_resolved?: string[]; invalidation?: string[]; data_status?: string } | null;
  const latestManagerCheckpoint = importState.outputs.SCHEDULE_CHECKPOINT.find((checkpoint) => checkpoint.manager_review) ?? importState.scheduler.recent.find((checkpoint) => checkpoint.manager_review);
  const managerReview = latestManagerCheckpoint?.manager_review ?? null;
  const managerReviewCurrent = Boolean(managerReview && currentTime && currentTime - Date.parse(managerReview.checked_at) <= 20 * 60_000);
  const codexManager = importState.codexManager ?? emptyCodexManagerState();
  const codexManagerRun = codexManager.latest_run;
  const managerOnlineStatus = codexManagerOnlineStatus(codexManager.deterministic_checked_at, Boolean(codexManagerRun), currentTime);
  const managerRunPending = managerStarting || codexManagerRun?.status === "QUEUED" || codexManagerRun?.status === "RUNNING";
  const startupRecovery = codexManager.startup_recovery;
  const latestManagerOperation = codexManager.recent_operations[0] ?? null;
  const latestRecoveryAttribution = codexManager.recovery_attributions[0] ?? null;
  const tsReadiness = codexManager.ts_readiness;
  const currentTs = currentTruth.forecast_id ? shadowTsOutputs.find((output) => output.evidence_snapshot.run_id === currentTruth.forecast_id) ?? null : null;
  const alignedDirection = currentTs && currentTs.symbol_outlooks.SPY.direction === currentTs.symbol_outlooks.QQQ.direction ? currentTs.symbol_outlooks.SPY.direction : null;
  const qualified = currentTs?.tradeability.status === "READY_FOR_D_REVIEW" && (alignedDirection === "BULLISH" || alignedDirection === "BEARISH");
  const tsCoreConclusion = qualified ? alignedDirection === "BULLISH" ? "QUALIFIED LONG" : "QUALIFIED SHORT" : "NO TRADE";
  const robinhoodTruth = currentTruth.data_sources.find((source) => source.source === "ROBINHOOD");
  const qualifiedSymbols = currentTs ? (["SPY", "QQQ"] as const).filter((symbol) => currentTs.symbol_outlooks[symbol].direction === alignedDirection).join(" / ") : "—";
  const healthOwnerRequired = healthOverview.current.some((item) => item.owner_required) || Boolean(managerReviewCurrent && managerReview?.tomorrow === "OWNER_ACTION_REQUIRED");
  const healthOwnerAction = healthOverview.current[0]?.owner_action ?? (managerReviewCurrent ? managerReview?.owner_todos[0] : null) ?? healthOverview.ownerAction;
  const latestPositionState = importState.outputs.POSITION_COPILOT_STATE.find((item) => item.source_mode === "LIVE") ?? null;
  const currentSlotRuns = latestShadowSlot ? importState.runLedger.runs.filter((run) => run.slot_id === latestShadowSlot) : [];
  const requiredDepartments = new Set(currentTruth.natural_slot.required_departments);
  const completedAgents = currentSlotRuns.filter((run) => requiredDepartments.has(run.agent_id as typeof currentTruth.natural_slot.required_departments[number]) && run.status === "SUCCEEDED" && run.output_status === "PRODUCED" && run.website_delivery === "DELIVERED").length;
  const requiredAgentCount = requiredDepartments.size;
  const currentSlotFrozenStatus = !latestShadowSlot ? currentTs?.report_type === "NEXT_SESSION" ? "OVERNIGHT / NEXT_SESSION FORECAST READY" : "OVERNIGHT / NO CURRENT TRADE SLOT" : currentTruth.natural_slot.terminal_state ? `本槽终态 · ${currentTruth.natural_slot.terminal_state}` : currentTruth.natural_slot.status === "RUNNING" ? `运行中 · ${completedAgents}/${requiredAgentCount} 已交付` : currentTruth.natural_slot.status === "BLOCKED" ? `本槽受阻 · ${completedAgents}/${requiredAgentCount} 已交付` : currentTruth.natural_slot.status === "SUCCEEDED" ? "本槽完整交付" : `本槽等待必需部门 · ${completedAgents}/${requiredAgentCount} 已交付`;
  const historyFaultCount = importState.scheduler.today.missed + importState.scheduler.today.failed + importState.scheduler.today.blocked;
  const departmentTruth = currentTruth.departments.map((item) => `${item.agent_id} ${displayText(item.status)}`).join(" · ");
  const absentDepartments = latestShadowSlot ? ["A1", "A2", "TS", "COMMITTEE", "D", "A3", "CODEX_GUARD"].filter((agent) => !importState.runLedger.runs.some((run) => run.slot_id === latestShadowSlot && run.agent_id === agent)) : [];
  const scheduleStatusText: Record<string, string> = { SUCCEEDED: "已运行", FAILED: "失败", DATA_BLOCKED: "数据阻断", MISSED: "漏跑", SKIPPED_MARKET_CLOSED: "休市跳过" };
  const scheduleTone = (status: string) => status === "SUCCEEDED" ? "good" : status === "MISSED" || status === "FAILED" ? "warn" : "idle";
  const schedulerGroup = (kind: string) => importState.scheduler.groups.find((group) => group.kind === kind);
  const activeCausalFingerprints = new Set(importState.marketIntelligence.causalChains.filter((chain) => Date.parse(chain.expires_at) > currentTime).map((chain) => chain.event_fingerprint));
  const importantEvent = importState.marketIntelligence.events.find((event) => event.importance === "MARKET_MOVING" && event.event_fingerprint && activeCausalFingerprints.has(event.event_fingerprint)) ?? null;
  const importantChain = importantEvent?.event_fingerprint ? importState.marketIntelligence.causalChains.find((chain) => chain.event_fingerprint === importantEvent.event_fingerprint) ?? null : null;
  const comparisonRows = [
    { field: "角色 / 组件", formal: latestTs ? `${latestTs.role} · ${displayText(latestTs.report_type)}` : "正式结果未上报", shadow: latestShadowTs ? `TS · ${displayText(latestShadowTs.report_type)}` : tsUnavailableReason },
    { field: "状态", formal: displayText(latestTs?.tradeability.status), shadow: displayText(latestShadowTs?.tradeability.status ?? a2Shadow?.status ?? latestRun("TS")?.status) },
    { field: "方向", formal: latestTs ? displayText(latestTs.path_bias) : "正式结果未上报", shadow: latestShadowTs ? displayText(latestShadowTs.path_bias) : tsUnavailableReason },
    { field: "动作边界", formal: latestTs ? "仅供 D 复核，不是批准" : "正式功能当前没有结果", shadow: latestShadowTs ? "影子验证 · 不得冒充正式结果" : tsUnavailableReason },
    { field: "冻结库存", formal: tsOutputs ? `${tsOutputs.length} 份 TS 输出` : "正式结果未上报", shadow: latestShadowTs ? `${shadowTsOutputs.length} 份最近自然链 TS 输出` : tsUnavailableReason },
    { field: "只读数据来源", formal: "不适用", shadow: sourceSummary },
    { field: "SPY / QQQ 行情", formal: "正式侧没有授权数据源", shadow: quoteSummary },
    { field: "来源差异告警", formal: "不适用", shadow: marketSources?.discrepancies.length ? `${marketSources.discrepancies.length} 条警告` : currentRobinhood ? `无警告 · Robinhood ${displayText(shadowRuntimeStatus)}` : "上游尚未生成行情快照" },
    { field: "预测结算", formal: "正式结果未上报", shadow: importState.tsSettlement.official_live_count ? `${importState.tsSettlement.settled_count} / ${importState.tsSettlement.official_live_count} 份已结算` : "尚未积累功能上线后的自然 LIVE 预测" },
  ];
  const naturalSettlementDates = new Set(importState.tsSettlement.recent.filter((item) => item.eligibility === "OFFICIAL_LIVE" && item.settlement).map((item) => item.market_date));
  const launchGaps: Array<{ owner: string; technical: string }> = [];
  if (!latestPositionState) launchGaps.push({ owner: "首份真实持仓副驾驶状态仍等待下一次自然盘中链；没有 Owner 历史输入时不会冒充建仓逻辑。", technical: "POSITION_COPILOT_STATE source_mode=LIVE" });
  if (!importState.tsSettlement.recent.some((item) => item.eligibility === "OFFICIAL_LIVE" && item.report_type === "NEXT_SESSION")) launchGaps.push({ owner: "明天的初步方向仍等待 18:00 自然槽；尚未到槽不算漏跑。", technical: "TS_SHADOW_OUTPUT report_type=NEXT_SESSION eligibility=OFFICIAL_LIVE" });
  if (naturalSettlementDates.size < 3) launchGaps.push({ owner: `完整自然交易日验收还需连续 3 个有效交易日；当前已有 ${naturalSettlementDates.size} 个交易日的正式结算证据。`, technical: "acceptance valid_streak=3" });
  if (marketEnvironment?.futures.status === "NOT_SUPPORTED") launchGaps.push({ owner: "SPY、QQQ和固定池股票的官方延长时段已单独接入；隔夜期货仍不支持，不用ETF或代理值冒充真实期货。", technical: "OVERNIGHT_FUTURES_NOT_SUPPORTED_BY_OFFICIAL_ROBINHOOD_MCP" });
  const capabilityAudit = capabilityRetentionAudit(importState);
  const meta = pageMeta[page];
  const hasRuntimeData = Boolean(importState.outputCount || importState.runLedger.eventCount);
  const marketIsClosed = shadowRuntimeStatus === "MARKET_CLOSED";
  const ownerAttentionRequired = Boolean(currentTruth.issues.owner_action_required || currentTruth.owner_queue.pending_owner_approval || currentTruth.active_slot_id && currentTruth.natural_slot.status === "BLOCKED");
  const ownerSystemBlocked = currentTruth.health_status === "BLOCKED";
  const systemSurfaceStatus = ownerSystemBlocked || ownerAttentionRequired || healthOverview.current.length ? systemStatus : healthOverview.selfCheckStatus === "NOT_VERIFIED" ? "NOT_VERIFIED" : "HEALTHY";
  const ownerSystemStatus = ownerSystemBlocked ? healthOverview.status
    : ownerAttentionRequired ? healthOverview.status
    : healthOverview.selfCheckStatus === "NOT_VERIFIED" ? "当前待核验 · 无需Owner处理"
    : currentTruth.issues.automatic_recovery ? "自动观察中 · 无需Owner处理"
      : systemStatus !== "HEALTHY" ? "运行边界已分对象展示 · 无需Owner处理"
        : healthOverview.status;
  const ownerNow = tsCoreConclusion;
  const ownerNowReason = currentTs ? `Forecast Layer ${displayText(currentTs.path_bias)} · Trade Qualification ${currentTs.tradeability.status} · ${currentTs.tradeability.reason} · 下一检查 ${formatPtDateTime(currentTs.next_validation.at)}` : "当前没有新的盘中预测；下一交易日的预判在下方单独展示，不能当作开仓批准。";
  const currentOwnerAction = marketIsClosed ? "NO TRADE" : ownerNow;
  const currentOwnerReason = marketIsClosed
    ? `最后有效倾向：${displayTs ? `SPY ${displayText(displayTs.symbol_outlooks.SPY.direction)}` : "尚未形成"}；下个交易日必须用新自然证据重新验证，不是周末建议。`
    : ownerNowReason;
  const ownerConsoleCards = <>
    <article data-tone={ownerSystemBlocked || ownerAttentionRequired ? "WARNING" : "GOOD"}><span>当前交易资格</span><strong>{currentOwnerAction}</strong><small>{currentOwnerReason}</small></article>
    <article data-tone={latestShadowSlot ? "GOOD" : "EXPECTED"}><span>当前自然槽</span><strong>{currentSlotFrozenStatus}</strong><small>{displayText(currentTruth.natural_slot.statistical_eligibility)}</small></article>
    <article data-tone={currentTruth.issues.owner_action_required || currentTruth.owner_queue.pending_owner_approval ? "WARNING" : "GOOD"}><span>Owner处理</span><strong>{currentTruth.issues.owner_action_required || currentTruth.owner_queue.pending_owner_approval ? "需要处理" : "当前无需处理"}</strong><small>待批准 {currentTruth.owner_queue.pending_owner_approval} · 当前故障 {currentTruth.issues.current_unresolved}</small></article>
    <article data-tone="EXPECTED"><span>下一动作</span><strong>{importState.scheduler.next_run?.business_slot ?? "等待排定"}</strong><small>{importState.scheduler.next_run?.label ?? "系统会按合同自动复查"}</small></article>
  </>;
  const nextSessionObservation = buildNextSessionObservation({ outputs: shadowTsOutputs, checkpoints: importState.outputs.SCHEDULE_CHECKPOINT, incidents: importState.selfCheck.active, tradingDate: currentTruth.trading_date, at: currentTime });
  const nextSessionEvent = upcomingSpecialEvents.find((event) => event.date === nextSessionObservation.target_date) ?? null;
  const marketForecastContext = resolveTsForecastContext(shadowTsOutputs, null, currentTime);
  const marketDisplay = buildTsForecastDisplay(marketForecastContext.selected, marketForecastContext.mode, currentTime);
  const marketBias = marketForecastContext.selected?.path_bias ?? "UNKNOWN";
  const marketBiasText = marketBias === "BULLISH" ? "偏多" : marketBias === "BEARISH" ? "偏空" : marketBias === "RANGE" ? "震荡" : "方向未定";
  const marketStateText = marketForecastContext.mode === "NEXT_SESSION" && marketDisplay.state !== "EXPIRED" ? `${marketForecastContext.tradingDate}预判：${marketBiasText}` : marketDisplay.isCurrent ? `${marketBiasText}（本次预测）` : marketForecastContext.selected ? marketDisplay.status : "暂无当前分析";
  const systemResult = ownerSystemBlocked ? "异常" : ownerAttentionRequired ? "需要关注" : healthOverview.selfCheckStatus === "NOT_VERIFIED" ? "当前待核验" : currentTruth.health_status === "DEGRADED" ? "运行中，数据受限" : "正常";
  const marketAnalysis = marketForecastContext.mode === "CURRENT_LIVE" ? marketForecastContext.selected : null;
  const marketCheckStatus = currentTruth.natural_slot.terminal_state === "FAILED" ? "失败：未形成新分析，系统按原计划继续检查" : currentSlotFrozenStatus;
  const manualPlans = projectOwnerManualPlans(importState, currentTime);
  const paperDay = paperReportingDay(currentTime) ? { date: ptDateKey(currentTime), label: "今日" } : null;
  const todayPaperCount = importState.paperPlans && paperDay ? importState.paperPlans.plans.filter(({ plan, status }) => plan.market_date === paperDay.date && status !== "VOIDED").length : null;
  const manualBuySymbols = [...new Set(manualPlans.plans.filter((plan) => plan.side === "BUY_TO_OPEN").map((plan) => plan.symbol))].join(" / ");
  const tradeResult = manualBuySymbols ? "有待你确认的买入计划" : qualified && !marketIsClosed ? "有机会，等待复核" : "暂不开新仓";
  const actionResult = manualBuySymbols ? `核对 ${manualBuySymbols} 的合约与触发条件` : marketIsClosed ? "等待下一次检查" : qualified ? `等待复核 ${qualifiedSymbols}` : "保持观望";
  const ownerResult = ownerAttentionRequired ? "系统需要你处理" : manualBuySymbols ? "是否执行，由你决定" : "无需你操作";
  const quoteBarResult = currentTruth.market_data_health.quote_health === "LIVE" && currentTruth.market_data_health.bar_health === "LIVE"
    ? "Quote / Bar 正常"
    : marketIsClosed ? "Quote / Bar 收盘冻结" : "Quote / Bar 需关注";
  const holdingCount = latestPositionState?.holdings.length ?? marketSources?.account.positions?.length ?? null;
  const holdingSymbols = (latestPositionState?.holdings ?? marketSources?.account.positions ?? []).flatMap((holding) => holding.symbol ? [holding.symbol] : []).filter((symbol, index, symbols) => symbols.indexOf(symbol) === index).slice(0, 3);
  const activeObservationCases = importState.externalExpert.cases.filter((item) => item.status === "OPEN" || item.status === "PARTIAL_EXIT");
  const leadObservationCase = activeObservationCases[0] ?? null;
  const positionCheck = importState.outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "POSITION_MONITOR");
  const riskSummary = positionCheckSummary(positionCheck, currentTime);
  const planDeadline = Math.min(...[...manualPlans.plans, ...manualPlans.conditional_plans.filter((plan) => plan.stage !== "EXPIRED")].map((plan) => Date.parse(plan.valid_until)));
  useEffect(() => {
    if (!Number.isFinite(planDeadline)) return;
    const expire = () => setCurrentTime(Date.now());
    const timer = window.setTimeout(expire, Math.max(0, planDeadline - Date.now() + 1));
    window.addEventListener("focus", expire);
    document.addEventListener("visibilitychange", expire);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", expire); document.removeEventListener("visibilitychange", expire); };
  }, [planDeadline]);
  const reviewSummary = decisionReview(importState.tsSettlement, currentTime);
  const nextAnalysis = currentTime > 0 ? [nextTimelineOccurrenceOfKind(new Date(currentTime), "TS_FORECAST"), nextTimelineOccurrenceOfKind(new Date(currentTime), "EVENING_ANALYSIS")].filter((item) => item !== null).sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))[0] : null;
  const nextAnalysisText = nextAnalysis ? formatPtDateTime(nextAnalysis.scheduled_at) : "正在读取下一自然检查时间";
  const reviewDetails = <>{reviewSummary.publishedAt ? <p>最近案例：{formatPtDateTime(reviewSummary.publishedAt)}</p> : null}<p><b>{reviewSummary.dimensions[0].result}</b></p><p>这是预测复盘，不是实际成交盈亏。</p><DetailSheet title="完整复盘与技术证据" label="查看完整复盘与技术证据"><code>{reviewSummary.forecastId}</code>{reviewSummary.dimensions.map((item) => <p key={item.question}><b>{item.question}</b><br />{item.result}</p>)}<details><summary>查看本次时间记录和缺少的证据</summary>{reviewSummary.evidence.nodes.map((node) => <p key={`${node.name}:${node.id}`}><b>{node.name} · {formatPtDateTime(node.at)}</b><br />{node.basis}<br /><code>{node.id}</code></p>)}{reviewSummary.evidence.gaps.map((gap) => <p key={gap}>{gap}</p>)}</details><p>方向、数据到达、网站入库、实际成交和风险分别核验；证据不全时，不归咎于你的反应。</p><p>对照基线现只使用发布时已经收到的结算，属于更正计算；历史预测和结算没有重写。旧持仓结果保留未更正；新结果注明建议入库后的当日观察时段，不代表整个持有期。期权报价变化不是你的实际盈亏。</p></DetailSheet></>;
  const truthEvidence = <aside className="data-state-guide" aria-label="CURRENT_TRUTH_V1 当前数据口径">
    <span data-kind={latestShadowSlot ? "live" : "missing"}><b>最近正式槽 / 冻结终态</b>{currentSlotFrozenStatus} · 本槽冻结证据 · {displayText(currentTruth.natural_slot.statistical_eligibility)}</span>
    <span data-kind={currentTruth.market_data_health.bar_health === "LIVE" ? "live" : "boundary"}><b>当前实时数据 · {formatPtDateTime(currentTruth.current_time)}</b>{currentTruth.market_data_health.classification} · Quote {currentTruth.market_data_health.quote_health} / Bar {currentTruth.market_data_health.bar_health}</span>
    <span data-kind={currentTruth.next_slot_qualification.status === "READY" ? "live" : "boundary"}><b>下一槽资格</b>{currentTruth.next_slot_qualification.status} · {currentTruth.next_slot_qualification.reason}</span>
    <span data-kind={latestShadowSlot ? "live" : "missing"}><b>同槽部门</b>{departmentTruth}</span>
    <span data-kind={latestCompletedShadowSlot ? "live" : "missing"}><b>最近成功 TS 槽</b>{latestCompletedShadowSlot ? `${latestCompletedShadowSlot.replace("live-shadow:", "")} · ${latestShadowTs ? formatPtDateTime(latestShadowTs.evidence_snapshot.market_time.observed_at) : "已留账本"}` : "尚无"}</span>
    <span data-kind="history"><b>故障 · 当前 / 历史累计</b>{currentTruth.issues.current_unresolved} / {currentTruth.issues.historical_cumulative}；今天历史故障 {historyFaultCount} 条；历史 / REPLAY保留但不冒充现在</span>
    <span data-kind="boundary"><b>下一有效检查</b>{importState.scheduler.next_run ? `${importState.scheduler.next_run.business_slot} · ${importState.scheduler.next_run.label}` : "尚未排定"}</span>
  </aside>;

  return (
    <div className={`app-shell workspace-shell${page === "home" ? " page-home-shell" : ""}`}>
      <a className="skip-link" href="#top">跳到主要内容</a>
      <WorkspaceNav page={page} />

      <main id="top" className={`page-${page}`}>
        <header className="topbar">
          <div>
            <h1>{meta.title}</h1>
            <p className="eyebrow">{currentTime ? `${formatPtDateTime(currentTime).slice(0, 10)} · 加州时间` : "正在读取本地数据"}</p>
            {meta.subtitle && <p className="subtitle">{meta.subtitle}</p>}
          </div>
          <div className="topbar-actions">
            <div className="snapshot-actions">
              {page === "issues" && <>
              <input ref={inputRef} aria-label="选择数据快照 JSON 文件" className="visually-hidden" name="snapshot" type="file" accept=".json,application/json" onChange={(event) => void handleImport(event.target.files?.[0])} />
              <button type="button" onClick={() => inputRef.current?.click()}>导入数据快照</button>
              <a href="/samples/v2-snapshot-import-v1.sanitized.json" download>下载脱敏样本</a>
              </>}
            </div>
            <span className="environment-badge">{importState.outputCount || importState.runLedger.eventCount ? "真实数据 · 只读" : importState.payload ? "已导入脱敏冻结样本" : "等待真实运行数据"}</span>
            {importState.notice?.kind === "error" && <p className="import-notice error" role="alert">{importState.notice.text}</p>}
          </div>
        </header>

        {snapshotError ? <aside className="workspace-refresh-error" role="status"><strong>{snapshotUpdatedAt ? "更新失败，当前保留上次数据" : "暂时无法读取最新数据"}</strong><span>请勿按实时结论操作。{snapshotUpdatedAt ? `上次更新 ${formatPtDateTime(new Date(snapshotUpdatedAt).toISOString())}。` : ""}页面每15秒自动重试；持续失败请查看系统状态。</span><a href="/health">查看系统状态</a><details><summary>查看原因</summary>{snapshotError}</details></aside> : null}

        {pageSections[page].length > 1 && <nav className="page-subnav" aria-label={`${meta.title}页内导航`}>
          {pageSections[page].map(([id, label]) => <a href={`#${id}`} key={id}>{label}</a>)}
        </nav>}

        {page !== "home" && <details className="owner-console-compact">
            <summary><span><small>当前交易资格</small><b>{hasRuntimeData ? currentOwnerAction === "NO TRADE" ? "暂不交易" : displayText(currentOwnerAction) : "尚未确认"}</b></span><span><small>你的待办</small><b>{hasRuntimeData ? currentTruth.issues.owner_action_required || currentTruth.owner_queue.pending_owner_approval ? "需要处理" : "无需处理" : "尚未确认"}</b></span><span><small>下一检查</small><b>{importState.scheduler.next_run ? formatPtDateTime(importState.scheduler.next_run.scheduled_at) : "等待排定"}</b></span></summary>
            <section className="owner-console-strip" aria-label="老板完整当前结论">{ownerConsoleCards}</section>
          </details>}

        {page !== "home" && <DetailSheet className="truth-details" title="数据时间、同槽部门与技术状态">
          {importState.notice ? <p>{importState.notice.text}</p> : null}
          {truthEvidence}
        </DetailSheet>}

        {page === "home" && <section className="today-overview" id="cockpit">
          <div className="workspace-home-status" aria-label="当前状态">
            <a href="/health" data-tone={ownerSystemBlocked ? "critical" : snapshotError || ownerAttentionRequired ? "warning" : "neutral"}>{snapshotError ? "系统状态待刷新" : hasRuntimeData ? "系统" + systemResult : "系统状态读取中"}</a>
            <span>Quote 和 Bar：{snapshotError ? "待刷新" : hasRuntimeData ? quoteBarResult.replace("Quote / Bar ", "") : "读取中"}</span>
            <a href="/company#timeline">下一次自然检查：{importState.scheduler.next_run?.business_slot ?? "等待排定"}</a>
          </div>
          <MacroEventNotice overview={importState.macroEventLearning} at={currentTime} />
          <section className="panel" id="today-paper"><PaperPlans overview={importState.paperPlans} currentTime={currentTime} todayOnly specialDays={specialDays} /></section>
          <section className="workspace-overview-grid workspace-position-priority" id="current-holdings" aria-label="真实持仓待办">
            <div className="workspace-column workspace-overview-column">
            <article className="overview-card workspace-holdings" data-tone={!riskSummary.current || riskSummary.alerts.length || riskSummary.gaps.length ? "warning" : "neutral"}>
              <header className="workspace-card-heading"><h3>真实持仓待办</h3><span>{holdingCount === null ? "数量未确认" : holdingCount + " 项 · 只读快照"}</span></header>
              <strong>{riskSummary.title}</strong>
              <p>{riskSummary.current ? [...riskSummary.alerts, ...riskSummary.gaps.filter((row) => !riskSummary.alerts.includes(row))].slice(0, 3).map((row) => (row.symbol ?? "未识别标的") + "：" + row.risks.map((risk) => positionRiskText[risk] ?? risk).join("、")).join("；") || "仅表示已配置条件未触发；股票、全账户限额与未绑定计划仍未完整覆盖。" : "不能沿用旧检查；请查看原计划与最近逐仓证据。"}</p>
              <div className="workspace-holding-symbols">{holdingSymbols.map((symbol) => <span key={symbol}>{symbol}</span>)}</div>
              <small>{riskSummary.check ? "最近检查 " + formatPtDateTime(riskSummary.check.checked_at) : "尚无逐仓检查证据"}</small>
              {manualPlans.plans.length > 0 ? <p className="workspace-plan-notice">有 {manualPlans.plans.length} 项买卖计划待核对，系统不会自动下单。</p> : null}
              <a href="/options">查看持仓与原计划 <span aria-hidden="true">↗</span></a>
            </article>
            </div>
          </section>
          <details className="overview-evidence">
            <summary><span>查看市场判断与系统待办</span></summary>
          <section className="today-decision workspace-decision" data-tone={ownerSystemBlocked ? "critical" : ownerAttentionRequired ? "warning" : "neutral"} aria-labelledby="today-decision-title">
            <div className="workspace-decision-main">
              <div className="workspace-decision-heading"><div><span className="workspace-label">当前能不能开新仓</span><h2 id="today-decision-title">{snapshotError ? "最新结论读取失败" : hasRuntimeData ? tradeResult : "正在读取交易结论"}</h2></div><a href={manualBuySymbols ? "/options" : "/forecast"}>{manualBuySymbols ? "核对计划" : "市场依据"}<span aria-hidden="true"> ›</span></a></div>
              <p className="today-decision-reason">{manualBuySymbols ? "买入计划须你核对合约与触发条件，系统不会下单。" : marketIsClosed ? "已收盘或休市，开仓需下一交易日的新证据。" : currentTs?.tradeability.reason ?? "暂无新盘中预测；次日预判不是开仓批准。"}</p>
              <div className="today-decision-facts" aria-label="五秒结论">
                <div><span>系统</span><strong>{hasRuntimeData ? systemResult : "读取中"}</strong></div>
                <div><span>当前动作</span><strong>{actionResult}</strong></div>
                <div className="workspace-market-fact"><span>市场判断 · 注意目标日与预测时段</span><strong>{marketStateText}</strong>{marketForecastContext.selected ? <><small>原判断：{marketBiasText} · {marketDisplay.windowText}</small><small>{marketDisplay.reviewText}</small></> : null}</div>
              </div>
            </div>
            <aside className="workspace-owner" data-tone={ownerAttentionRequired ? "warning" : "neutral"}>
              <a href="/issues" aria-label={"查看当前事项：" + (snapshotError ? "读取失败" : hasRuntimeData ? ownerResult : "读取中")}><span className="workspace-label">你的待办</span><strong>{snapshotError ? "读取失败" : hasRuntimeData ? ownerResult : "读取中"}</strong><span aria-hidden="true">›</span></a>
              {!hasRuntimeData || ownerAttentionRequired ? <p>{!hasRuntimeData ? "正在读取当前事项，不把未知当作正常。" : criticalIncident?.title ?? healthOwnerAction}</p> : null}
            </aside>
          </section>
          </details>

          <section className="today-control-grid workspace-overview-grid" aria-label="今日关键状态">
          <div className="workspace-column workspace-overview-column">
            <OwnerOpportunityShortlist snapshot={approvedCapabilities} at={currentTime} nextCheck={nextAnalysisText} currentReadFailed={fixedReadFailed} compact />
          <section className="workspace-tracking" aria-labelledby="tracking-heading">
            <header className="workspace-card-heading"><h3 id="tracking-heading">研究与跟踪</h3><span>与真实持仓分开</span></header>
            <div className="workspace-tracking-rows">
              <a href="#today-paper"><span>模拟练习</span><strong>{paperDay && !isNyseRegularSession(paperDay.date) ? "今日休市 · 无建单任务" : todayPaperCount === null ? "读取中，数量未知" : paperDay!.label + " " + todayPaperCount + "/" + PAPER_DAILY_TARGET + " 张"}</strong><small>仅模拟，不可执行</small><i aria-hidden="true">↗</i></a>
              <a href="/settlements#external-expert"><span>当前观察案例</span><strong>{hasRuntimeData ? importState.externalExpert.open_count + " 个观察中" : "正在读取"}</strong><small>{leadObservationCase ? (leadObservationCase.symbol && leadObservationCase.symbol !== "UNKNOWN" ? leadObservationCase.symbol : "标的待确认") + " · " + (leadObservationCase.direction === "MIXED" ? "方向未统一" : displayText(leadObservationCase.direction)) : hasRuntimeData ? "无开放中的外部案例" : "数量尚未确认"}</small><i aria-hidden="true">↗</i></a>
              <a href="/company#market-events"><span>特别事件</span><strong>{specialEventTitle}</strong><small>学习观察，不交易</small><i aria-hidden="true">↗</i></a>
              <a href="/settlements#decision-review"><span>最近复盘</span><strong>{reviewSummary.dimensions[0].result}</strong><small>不是实际成交盈亏</small><i aria-hidden="true">↗</i></a>
            </div>
          </section>
          </div>
          <div className="workspace-column workspace-overview-column">
            <article className="overview-card workspace-next-session" data-tone={nextSessionObservation.phase === "FAILED" ? "warning" : "neutral"}>
              <header className="workspace-card-heading"><h3>下一交易日初步观察</h3><span>{nextSessionObservation.target_date}</span></header>
              <strong>{nextSessionObservation.direction}</strong>
              <p>{nextSessionObservation.status} · {nextSessionObservation.latest_update && ["FAILED", "DATA_BLOCKED", "MISSED"].includes(nextSessionObservation.latest_update.status) ? "最近更新未完成，详见目标日依据。" : "开仓前仍需目标交易日的新证据确认。"}</p>
              {nextSessionEvent ? <small>次日关键事件：{nextSessionEvent.title} · {nextSessionEvent.when}</small> : null}
              {nextSessionObservation.phase !== "READY" && nextSessionObservation.last_completed ? <details><summary>最近有效观察</summary><p>{nextSessionObservation.last_completed.target_date} · {nextSessionObservation.last_completed.direction} · {formatPtDateTime(nextSessionObservation.last_completed.formed_at)}</p></details> : null}
              <a href="/forecast">查看目标日依据 <span aria-hidden="true">↗</span></a>
            </article>
          </div>
          </section>

          <DetailSheet className="overview-evidence" id="technical-evidence" title="今日技术证据" label="查看技术证据">
            <p className="source-note">{currentOwnerReason}</p>
            <p className="source-note">数据状态：{currentTruth.market_data_health.reason} · 下一次检查：{importState.scheduler.next_run ? importState.scheduler.next_run.scheduled_pt + " · " + importState.scheduler.next_run.label : "尚未排定"}</p>
            <p className="source-note">下一交易日观察：{nextSessionObservation.status} · {nextSessionObservation.reason}</p>
            {marketForecastContext.selected ? <p className="source-note">市场判断形成于 {formatPtDateTime(marketForecastContext.selected.evidence_snapshot.market_time.observed_at)}</p> : null}
            {truthEvidence}
            <dl className="overview-evidence-meta">
              <div><dt>Forecast ID</dt><dd>{currentTs?.evidence_snapshot.run_id ?? nextSessionObservation.forecast_id ?? "当前未形成"}</dd></div>
              <div><dt>Candidate ID</dt><dd>{latestTsCandidate?.candidate_forecast_id ?? "当前未形成"}</dd></div>
              <div><dt>数据年龄</dt><dd>{robinhoodTruth?.freshness_seconds === null || robinhoodTruth?.freshness_seconds === undefined ? "未上报" : `${robinhoodTruth.freshness_seconds} 秒`}</dd></div>
            </dl>
            <nav className="overview-evidence-links" aria-label="技术后台入口"><a href="/health">系统、SQLite、运行版本</a><a href="/company">调度器、Ownership、Lease</a><a href="/settlements">Forecast、Delivery、Candidate</a><a href="/issues">Incident 与内部记录</a></nav>
          </DetailSheet>
        </section>}



        {(page === "options" || page === "forecast") && <section className="panel cockpit" id={page === "options" ? "options" : "forecast"}>
          <div className="section-heading"><div><p className="section-kicker">{page === "options" ? "03 / 策略与持仓" : "02 / TS 预测"}</p><h2>{page === "options" ? "策略、持仓与部门判断" : "TS 预测驾驶舱"}</h2></div><span className={page === "forecast" && latestShadowTs ? "status-chip warn" : "status-chip"} data-status={page === "forecast" ? undefined : systemStatus}>{page === "forecast" ? latestShadowTs ? shadowTsIsCurrent ? `${shadowTsScope} · 持续更新` : `${shadowTsScope} · 当前槽：${tsUnavailableReason}` : tsUnavailableReason : displayText(systemStatus)}</span></div>
          {page === "forecast" && <>
          <p className="source-note">多槽盘型证据：{patternEvidence?.source_mode === "LIVE" ? "自然 LIVE" : patternEvidence?.source_mode === "REPLAY" ? "仅回放，不计自然证据" : "上游尚未生成"} · {displayText(patternEvidence?.status)}{patternEvidence?.symbols ? ` · 已由自然槽确认：SPY ${displayText(patternEvidence.symbols.SPY?.current_state)} / QQQ ${displayText(patternEvidence.symbols.QQQ?.current_state)}` : " · 尚未积累足够自然槽"}</p>
          <TsForecastCockpit outputs={shadowTsOutputs} unavailableReason={tsUnavailableReason} extendedHours={marketEnvironment?.extended_hours} systemARows={approvedCapabilities?.fixed_pool.rows} />
          </>}
          {page === "options" && <>
          <p className="workspace-relocated" id="paper-plans">模拟单已单独归入研究，不与真实持仓混排。<a href="/settlements#research-paper">查看完整模拟单 ↗</a></p>
          <OptionsPositionPanel strategies={importState.outputs.OPTION_STRATEGY_SIGNAL} positions={importState.outputs.POSITION_COPILOT_STATE} lifecycle={importState.optionLifecycle} tradingDate={currentTruth.trading_date} currentTime={currentTime} positionCheck={positionCheck} orders={latestA1Shadow?.market_sources?.account.orders} manualPlans={manualPlans} />
          <div className="subsection-heading" id="department-review"><p className="section-kicker">同槽联合复核</p><h3>部门判断与老板待办</h3></div>
          <div className="unified-review" aria-label="D、独立评审和A3统一结论">
            <div><span>统一行动</span><strong>{dShadow ? displayText(dShadow.action) : dUnavailableReason}</strong><p>{dShadow?.summary ?? "当前自然槽尚未形成老板行动方案。"}</p></div>
            <div><span>主要反方证据</span><strong>{committeeShadow ? `${committeeShadow.evidence_against?.length ?? 0} 条` : committeeUnavailableReason}</strong><p>{committeeShadow?.evidence_against?.slice(0, 2).join("；") || "当前槽没有可展示的独立反方意见。"}</p></div>
            <div><span>管理结论</span><strong>{a3Shadow ? displayText(a3Shadow.decision) : a3UnavailableReason}</strong><p>{a3Shadow?.plain_language ?? "等待同槽管理证据；不会回退套用旧结论。"}</p></div>
          </div>
          <details className="technical-details department-details"><summary>展开 D、独立评审与 A3 逐项证据</summary><div className="runtime-decision-grid">
            <article className={committeeShadow ? "observed" : "offline"}><span>独立评审组意见</span><strong>{committeeShadow ? `${displayText(committeeShadow.direction)} · ${displayText(committeeShadow.flow_state)} · ${committeeShadow.confidence}/10` : committeeUnavailableReason}</strong><p>{committeeShadow?.summary ?? "没有当前自然槽结果时，不回退展示旧意见。"}</p><div className="counter-evidence"><b>老板先看反方证据</b><p>{committeeShadow?.evidence_against?.join("；") || committeeUnavailableReason}</p></div><details><summary>查看支持证据与缺口</summary><p>支持：{committeeShadow?.evidence_for?.join("；") || committeeUnavailableReason}</p><p>缺口：{committeeShadow?.data_gaps?.map((item) => displayText(item)).join("；") || (committeeShadow ? "无已上报缺口" : committeeUnavailableReason)}</p></details></article>
            <article className={dShadow ? "observed" : "offline"}><span>D 给老板的统一结论</span><strong>{dShadow ? `${displayText(dShadow.action)} · ${dShadow.score}/10` : dUnavailableReason}</strong><p>{dShadow?.summary ?? "没有当前自然槽结果时，不生成老板方案。"}</p><ul><li>触发条件：{dShadow ? dShadow.entry_conditions?.join("；") || "当前不交易，没有额外入场触发条件" : dUnavailableReason}</li><li>失效条件：{dShadow ? dShadow.invalidation?.join("；") || "当前不交易，没有需追踪的持仓失效位" : dUnavailableReason}</li><li>下一检查点：{importState.scheduler.next_run ? `${importState.scheduler.next_run.scheduled_pt.replace(" PT", " 加州时间")} · ${importState.scheduler.next_run.label}` : "尚未排定"}</li></ul></article>
            <article className={a3Shadow ? "observed" : "offline"}><span>A3 跟踪事项与待办 · 本槽冻结</span><strong>{a3Shadow ? displayText(a3Shadow.decision) : a3UnavailableReason}</strong><p>当前实时健康：<b data-status={systemStatus}>{healthOverview.status}</b>。{a3Shadow?.plain_language?.replaceAll("свеж", "最新") ?? `${a3UnavailableReason}；投诉与老板待办继续由本地数据库保留。`}</p><ul><li>本槽冻结证据：{latestShadowSlot ?? "尚未积累自然 LIVE 槽"}</li><li>等待条件：{displayTs?.tradeability.status === "WAIT" ? "持续中" : dUnavailableReason}</li><li>证据年龄：{shadowFreshness === null ? "当前槽上游未生成" : `${shadowFreshness} 秒`}</li><li>冲突：{a3ReviewShadow ? `${a3ReviewShadow.conflict_detected ? "有" : "无"} · ${a3ReviewShadow.review_required ? `复核 ${displayText(a3ReviewShadow.review_target)}` : "无需追加复核"}` : a3UnavailableReason}</li><li>部门缺席：{absentDepartments.join("、") || "无"}</li><li>Codex 经理待办：{managerReviewCurrent ? managerReview?.owner_todos.join("；") || "无" : "最近经理检查已归档，当前待办以系统健康为准"}</li><li>当前root问题 / 待老板批准：{currentTruth.issues.current_unresolved} / {currentTruth.owner_queue.pending_owner_approval}</li></ul><details><summary>查看本槽原始状态</summary><code>data_status={a3Shadow?.data_status ?? "NOT_OBSERVED"}</code></details></article>
          </div></details>
          </>}
          {page === "forecast" && <>
          <div className="section-heading forecast-context-heading"><div><p className="section-kicker">冻结市场背景</p><h3>本槽判断所用市场背景</h3></div><span className="status-chip" data-status={systemStatus}>{displayText(systemStatus)}</span></div>
          <article className={`market-event-spotlight ${officialMacro ? "observed" : "offline"}`}>
            <div className="event-heading"><div><span>官方宏观日程与公布结果</span><strong>{nextMacroEvent ? `${nextMacroEvent.release_name} · ${nextMacroWhen}` : "未来 45 天没有已观察到的官方重点事件"}</strong></div><b data-status={macroOwnerStatus}>{displayText(macroOwnerStatus)}</b></div>
            <p>通胀 {displayText(officialMacro?.coverage?.inflation)} · 就业 {displayText(officialMacro?.coverage?.employment)} · 联储 {displayText(officialMacro?.coverage?.central_bank)} · 增长 {displayText(officialMacro?.coverage?.growth)} · 已公布值 {displayText(officialMacro?.coverage?.released_values)}。{latestMacroResult ? `最近结果 ${latestMacroResult.release_name ?? "未命名"}：${displayText(latestMacroResult.status)}` : `已冻结 ${officialMacro?.observations?.length ?? 0} 条官方序列观察。`}</p>
            <details className="card-details"><summary>来源、数据等级与缺口</summary><p>BLS 结果来自官方 RSS / Public Data API；BLS 日程被 403 阻断时，以 Federal Reserve Bank of St. Louis 的官方聚合日期补足并明确标记“仅日期”；FOMC、BEA、Census 均来自发布机构官方入口。</p><div className="field-tags compact"><code>as_of={officialMacro?.as_of ?? "null"}</code><code>context_hash={officialMacro?.context_hash ?? "null"}</code><code>events={officialMacro?.events.length ?? 0}</code><code>results={officialMacro?.results.length ?? 0}</code>{officialMacro?.supplemental_sources?.map((source) => <code key={`${source.source}-${source.role}`}>{source.source}={source.status}/{source.data_grade}</code>)}</div><p>{officialMacro?.errors.join("；") || "无已上报错误"}</p></details>
          </article>
          <article className={`market-event-spotlight ${marketEnvironment && !["STALE", "DATA_BLOCKED"].includes(marketEnvironment.status) ? "observed" : "offline"}`}>
            <div className="event-heading"><div><span>利率、油价、盘前与板块广度</span><strong>{treasuryValue("TREASURY_10Y") === null ? "真实收益率未观察到" : `美债 2年 ${treasuryValue("TREASURY_2Y")?.toFixed(2)}% · 10年 ${treasuryValue("TREASURY_10Y")?.toFixed(2)}% · WTI ${wtiValue === null ? "未观察到" : `$${wtiValue.toFixed(2)}`}`}</strong></div><b data-status={officialMarket?.status ?? marketEnvironment?.status ?? "NOT_OBSERVED"}>{displayText(officialMarket?.status ?? marketEnvironment?.status)}</b></div>
            <p>真实数据：美国财政部收益率 {displayText(officialMarket?.treasury_yields.status)} · EIA WTI {displayText(officialMarket?.wti.status)}；延长时段 {displayText(marketEnvironment?.extended_hours?.status)}；板块广度 {marketEnvironment?.sector_breadth.advance_pct === null || marketEnvironment?.sector_breadth.advance_pct === undefined ? "未观察到" : `${marketEnvironment.sector_breadth.advance_pct}%`}。隔夜期货：不支持。</p>
            <details className="card-details"><summary>来源、代理口径与数据缺口</summary><p>收益率为美国财政部官方 EOD，WTI 为 EIA Cushing 现货日值；TLT/SHY 与 USO 仍只作 ETF 代理，不能冒充真实值。股票盘前、正常、盘后和隔夜使用 Robinhood 官方 24_5 OHLCV；本地单点采样、最近 EOD、不支持和读取失败分别标记。</p><div className="field-tags compact"><code>treasury_as_of={officialMarket?.treasury_yields.as_of ?? "null"}</code><code>wti_as_of={officialMarket?.wti.as_of ?? "null"}</code><code>extended_as_of={marketEnvironment?.extended_hours?.as_of ?? "null"}</code><code>futures={marketEnvironment?.futures.status ?? "NOT_OBSERVED"}</code></div><p>{marketEnvironment?.data_gaps.length ? marketEnvironment.data_gaps.map((item) => displayText(item)).join("；") : "无已上报缺口"}</p></details>
          </article>
          <article className={`market-event-spotlight ${importantEvent ? "observed" : "offline"}`}>
            <div className="event-heading"><div><span>最重要事件及其影响</span><strong>{importantEvent?.title ?? "暂无经验证的重大事件"}</strong></div><b data-status={importantChain?.event_evidence_state ?? "NOT_OBSERVED"}>{importantChain ? `${importantChain.event_evidence_state === "VERIFIED" ? "事件身份已核验" : "事件身份待交叉核验"} · 因果待验证` : "未观察到"}</b></div>
            {importantEvent ? <>
              <p>{importantEvent.kind === "NEWS" ? "重大新闻" : "财报日历"} · 来源：{sourceName(importantEvent.source)} · {importantEvent.published_at ? `发布于 ${formatPtDateTime(importantEvent.published_at)}` : `计划日期 ${importantEvent.scheduled_for ?? "未提供"}`} · 影响标的：{importantEvent.affected_symbols.join("、") || "未观察到"} · 行业：{importantEvent.industry ?? "来源未提供"}</p>
              <div className="causal-summary">
                <div><span>发生了什么</span><b>{importantChain?.what_happened ?? "尚无可验证因果链"}</b></div>
                <div><span>影响机制 / 方向 / 持续时间</span><b>{importantChain ? `${importantChain.mechanism} / ${importantChain.expected_direction} / ${importantChain.expected_duration}` : "待验证假设"}</b></div>
                <div><span>市场是否确认</span><b>{importantChain?.market_confirmation === "CONFIRMED" ? "已确认" : importantChain?.market_confirmation === "CONTESTED" ? "存在争议" : importantChain?.market_confirmation === "NOT_CONFIRMED" ? "未确认" : "未观察到"}</b></div>
                <div><span>置信度 / 失效条件</span><b>{importantChain?.confidence === null || importantChain?.confidence === undefined ? "未评分" : `${importantChain.confidence}%`} · {importantChain?.invalidation_condition ?? "待验证假设"}</b></div>
              </div>
              <details className="card-details"><summary>证据、反证与技术字段</summary><p>支持证据：{importantChain?.supporting_evidence.map((item) => `${item.source}《${item.title}》`).join("；") || "未观察到"}</p><p>反对证据：{importantChain?.opposing_evidence.map((item) => `${item.source}：${item.summary}`).join("；") || "未观察到"}</p><div className="field-tags compact"><code>event_id {importantEvent.event_id}</code><code>event_type {importantEvent.event_type}</code><code>novelty {importantEvent.novelty}</code><code>importance {importantEvent.importance}</code><code>expires_at {importantChain?.expires_at ?? "null"}</code></div></details>
            </> : <p>Finnhub 未配置、未验证或当前没有符合 V2 明确规则的重大事件时保持空白；不会用样本新闻填充。</p>}
          </article>
          <details className="technical-details">
            <summary>查看 V2 合同结构与技术字段</summary>
            <div className="contract-chain" aria-label="V2 固定内部闭环">
              <article className="chain-node wide">
                <span>冻结证据包</span><b>A1 + A2</b>
                <div className="field-tags">{snapshot.relationship.shared_evidence_keys.map((field) => <code key={field}>{field}</code>)}</div>
              </article>
              <span className="chain-arrow">→</span>
              <article className="chain-node split">
                <span>独立判断</span><b>TS v2 + 独立评审组 v1</b><small>两者读取同一证据，不互相替代</small>
              </article>
              <span className="chain-arrow">→</span>
              <article className="chain-node">
                <span>人工方案</span><b>D v1</b><small>读取证据和两份独立结论</small>
              </article>
              <span className="chain-arrow">→</span>
              <article className="chain-node">
                <span>证明</span><b>送达 + 验收</b><small>哈希、回执、槽位共同验收</small>
              </article>
            </div>
            <div className="binding-row">
              <span>送达关联键</span>
              <div className="field-tags">{snapshot.relationship.delivery_join_keys.map((field) => <code key={field}>{field}</code>)}</div>
              <p>TS 的 <code>READY_FOR_D_REVIEW</code> 只允许 D 复核，不是交易批准；A3 才是唯一最终决定。</p>
            </div>
          </details>
          <p className="source-note">当前自然槽冻结证据：{a1Shadow ? `${displayText(a1Shadow.source_mode)} · ${displayText(a1Shadow.status)} · 冻结截至 ${formatPtDateTime(a1Shadow.data_cutoff_at)} · 发布时新鲜度 ${a1Shadow.freshness_seconds === null ? "未上报" : Math.round(a1Shadow.freshness_seconds)} 秒 · ${sourceSummary}` : "尚无 A1 数据；未设置凭证或尚未到运行时段时显示尚未运行或数据被阻断。"}</p>
          <div className="schedule-chart" aria-label="TS v2 正式预测槽位图">
            {snapshot.formal_forecast_slots.map((slot) => {
              const observed = slotOutput(slot);
              return <article key={slot.time} className={observed ? "observed" : ""}><time>{slot.time}</time><span>{displayText(slot.report_type)}</span><small>{displayText(observed ? observed.path_bias : slot.update_mode)}</small></article>;
            })}
          </div>
          <details className="source-details"><summary>技术依据与行情来源</summary><p className="source-note">契约规则：{snapshot.ts_projection.scenario_rule}；SPY 与 QQQ 必须分别提供 <code>symbol_outlooks</code>。只读行情：{quoteSummary}。</p></details>
          </>}
          {page === "options" && <>
          <p className="source-note">策略与持仓只读取当前自然槽的冻结证据和 Robinhood 官方只读数据；历史结果不会冒充当前建议。</p>
          {marketSources && <details className="technical-details market-evidence-details"><summary>展开 Robinhood 行情、持仓与合约技术证据</summary><div className="health-grid market-data-grid">
            {marketSources.quotes.map((quote) => {
              const bars = marketSources.bars.find((item) => item.source === quote.source && item.symbol === quote.symbol);
              const options = marketSources.options.find((item) => item.source === quote.source && item.symbol === quote.symbol);
              const status = currentRobinhood?.status === "MARKET_CLOSED" ? "MARKET_CLOSED" : marketStatus(quote.status, quote.as_of);
              const healthy = ["LIVE", "MARKET_CLOSED"].includes(status) && bars?.status === "LIVE" && options?.status === "LIVE";
              return <article key={`${quote.source}-${quote.symbol}`} className={healthy ? "observed" : "offline"}>
                <div className="health-top"><span className="service-icon">{quote.symbol.charAt(0)}</span><span className={`service-light ${healthy ? "observed" : "idle"}`} /></div>
                <h3>{quote.symbol}</h3><p>{sourceName(quote.source)} · 只读影子验证行情</p>
                <div className="health-meta"><span>本槽价格 {quote.last ?? "数据源未返回"}</span><b data-status={status}>{currentRobinhood?.status === "MARKET_CLOSED" ? "收盘后查看冻结值" : displayText(status)}</b></div>
                <p className="health-expectation">Bid {quote.bid ?? "数据源未返回"} / Ask {quote.ask ?? "数据源未返回"}<br />报价冻结于 {quote.as_of ? formatPtDateTime(quote.as_of) : "上游未生成"} · 发布时新鲜度 {quote.freshness_seconds ?? "未上报"} 秒<br />5分钟 K 线冻结于 {bars?.as_of ? formatPtDateTime(bars.as_of) : "上游未生成"} · 发布时新鲜度 {bars?.freshness_seconds ?? "未上报"} 秒<br />期权链冻结于 {options?.as_of ? formatPtDateTime(options.as_of) : "上游未生成"} · 发布时新鲜度 {options?.freshness_seconds ?? "未上报"} 秒</p>
                <details className="card-details"><summary>查看期权链与技术字段</summary><div className="field-tags compact"><code>5m bars {bars?.bar_count ?? "—"}</code><code>daily {bars?.daily_bar_count ?? "—"}</code><code>expirations {options?.expiration_count ?? "—"}</code><code>nearest {options?.nearest_expiration ?? "—"}</code><code>chain {options?.contract_count ?? "—"}</code><code>sample BBO {options?.bbo_count ?? "—"}</code><code>IV {options?.iv_count ?? "—"}</code><code>Greeks {options?.greeks_count ?? "—"}</code></div><div className="field-tags compact">{options?.contracts.map((contract) => <code key={`${contract.option_type}-${contract.expiration}-${contract.strike}`}>{contract.expiration} {contract.strike}{contract.option_type === "call" ? "C" : "P"} · {contract.bid ?? "—"}/{contract.ask ?? "—"} · IV {contract.iv ?? "—"} · hist {contract.history_bars}</code>)}</div></details>
              </article>;
            })}
            <article className={marketSources.account.status === "LIVE" ? "observed" : "offline"}>
              <div className="health-top"><span className="service-icon">R</span><span className={`service-light ${marketSources.account.status === "LIVE" ? "observed" : "idle"}`} /></div>
              <h3>Robinhood 账户</h3><p>官方只读接口 · 账户号已脱敏</p>
              <div className="health-meta"><span>{marketSources.account.account_count ?? "—"} 个账户</span><b data-status={marketSources.account.status}>{currentRobinhood?.status === "MARKET_CLOSED" ? "本槽只读快照" : displayText(marketSources.account.status)}</b></div>
              <p className="health-expectation">持仓 {marketSources.account.positions?.length ?? "—"} · 订单记录 {marketSources.account.orders?.length ?? "—"}<br />组合 ${marketSources.account.portfolio_value?.toFixed(2) ?? "—"} · 期权 ${marketSources.account.option_value?.toFixed(2) ?? "—"}<br />近一年已实现期权盈亏 ${marketSources.account.realized_pnl?.toFixed(2) ?? "—"}<br />数据截至 {marketSources.account.as_of ? formatPtDateTime(marketSources.account.as_of) : "未观察到"} · 不保存完整账户号</p>
              <details className="card-details"><summary>查看持仓与订单明细</summary><div className="field-tags compact">{marketSources.account.positions?.map((position, index) => <code key={`${position.account_label}-${index}`}>{position.account_label} · {position.symbol ?? "—"} {position.expiration ?? "—"} {position.strike ?? "—"}{position.option_type === "call" ? "C" : position.option_type === "put" ? "P" : ""} · {position.direction ?? "—"} {position.quantity ?? "—"} · cost {position.average_price ?? "—"} / mark {position.mark ?? "—"}</code>)}</div><div className="field-tags compact">{marketSources.account.orders?.slice(0, 5).map((order, index) => <code key={`${order.account_label}-${order.created_at}-${index}`}>{order.created_at?.slice(0, 10) ?? "—"} · {order.symbol ?? "—"} · {order.direction ?? "—"} · {order.state ?? "—"}</code>)}</div></details>
            </article>
          </div></details>}
          </>}
        </section>}

        {page === "settlements" && <div className="two-column chart-row settlements-stack">
          <div className="workspace-column">
          <section className="panel priority-section" id="event-observation">
            <div className="section-heading"><h3>事件观察</h3><span className="muted-chip">人工核查 · 只读</span></div>
            <p>公司事件、会议日程与实际披露分开记录，保留待核实项和历史修订。</p>
            <p>本期4个事件、5条修订；资料截至 <time dateTime="2026-09-27T20:59:37Z">2026年9月27日 13:59 加州时间</time>。</p>
            <p>联合卡片复用已归档行情，逐项标明时间和缺口；每日 Codex 选单可作只读参考，不改变预测、报价门禁或止损。官方资料仍需人工复核，原始静态报告保留。</p>
            <a href="/research/event-disclosure">打开事件与披露报告 ↗</a>
          </section>
          <section className="panel" id="research-paper">{researchPaper.error ? <p className="workspace-refresh-error" role="status">{researchPaper.error}</p> : null}<PaperPlans overview={researchPaper.overview} currentTime={currentTime} specialDays={specialDays} /></section>
          <section className="panel priority-section" id="decision-review"><div className="section-heading"><h3>最近预测，后来怎样了？</h3></div>{reviewDetails}</section>
          <section className="panel priority-section" id="prediction-research">
            <div className="section-heading"><h3>预测增强研究（30 / 60分钟）</h3></div>
            <p>独立研究观察，尚未验证；不进入正式预测成绩或交易执行。</p>
            {latestTsCandidate ? <p>最近研究记录 {formatPtDateTime(latestTsCandidate.observed_at)} · 当时数据截至 {formatPtDateTime(latestTsCandidate.data_cutoff_at)}</p> : null}
              {latestTsCandidate ? <details className="source-details"><summary>查看最新候选与结算依据</summary>
                <p>独立Shadow候选，不进入Owner正式信号、Forward正式分母或Broker执行。<code>{latestTsCandidate.candidate_forecast_id}</code></p>
                <div className="scheduler-summary">{latestTsCandidate.contracts.map((contract) => { const settled = latestTsCandidateSettlements.flatMap((item) => item.results).find((item) => item.contract_id === contract.contract_id); return <article key={contract.contract_id}><span>{contract.symbol} · {contract.horizon}</span><strong>{contract.trade_qualification.conclusion}</strong><small>Forecast {displayText(contract.forecast_layer.direction)} · 触发：{contract.trade_qualification.trigger}<br />失效 {contract.trade_qualification.invalidation ?? "—"} · 第一目标 {contract.trade_qualification.first_target ?? "—"} · {contract.trade_qualification.expected_holding_period}<br />Bar {displayText(contract.data_freshness.status)} · {contract.data_freshness.bar_freshness_seconds === null ? "未知" : `${Math.round(contract.data_freshness.bar_freshness_seconds)}秒`} · 下一检查 {formatPtDateTime(contract.reevaluate_at)}<br />同期基线：VWAP均值回归 {contract.simple_baselines.vwap_mean_reversion ? displayText(contract.simple_baselines.vwap_mean_reversion) : "不可判"} / 短趋势 {contract.simple_baselines.short_trend ? displayText(contract.simple_baselines.short_trend) : "不可判"} / 最近K线 {contract.simple_baselines.last_complete_bar ? displayText(contract.simple_baselines.last_complete_bar) : "不可判"}{settled ? <><br />结算 {displayText(settled.status)} · 实际 {settled.actual_direction ? displayText(settled.actual_direction) : "不可评分"}</> : null}</small></article>; })}</div>
              </details> : <p>尚未读取到增强研究记录；不代表已有新的正式预测。</p>}
          </section>
          <section className="panel priority-section" id="settlement-history">
            <div className="forecast-settlement" aria-label="TS 预测结算">
              <div className="section-heading"><h3>预测表现是否可信？</h3></div>
              <p><b>{hasRuntimeData ? importState.tsSettlement.trusted.validation.status === "UNVALIDATED" ? "尚未证明预测优势" : displayText(importState.tsSettlement.trusted.validation.status) : "结果尚未确认"}</b></p>
              <p>先积累完整的自然交易日记录，再判断是否可靠。</p>
              <DetailSheet title="预测统计口径与技术证据" label="查看统计口径与技术证据">
              <h4>运营完整性与预测准确率分开看</h4>
              <p className="source-note"><b>{importState.tsSettlement.trusted.message}</b>。正式准确率只接纳自然 LIVE、运行身份完整且按 received_at 因果窗口结算的样本；REPLAY、研究和15分钟增强输出不进入分母。</p>

              <div className="scheduler-summary" aria-label="TS预测产品验收状态">
                <article><span>预测优势验收</span><strong>{importState.tsSettlement.trusted.validation.status}</strong><small>{importState.tsSettlement.trusted.validation.reason}</small></article>
                <article><span>独立自然Forward交易日</span><strong>{importState.tsSettlement.trusted.validation.independent_trading_days} / 30 / 60</strong><small>距30日 {importState.tsSettlement.trusted.validation.gap_to_30} · 距60日 {importState.tsSettlement.trusted.validation.gap_to_60}</small></article>
                <article><span>场景权重</span><strong>尚未校准</strong><small>{importState.tsSettlement.trusted.scenario_weights.source} · 5%步长、合计100%、主路径不低于备选</small></article>
                <article><span>高资格方向MCC</span><strong>{importState.tsSettlement.trusted.risk_coverage.find((item) => item.qualification === "READY_FOR_D_REVIEW")?.mcc?.toFixed(3) ?? "证据不足"}</strong><small>只使用READY_FOR_D_REVIEW；研究预测不进入高资格分母</small></article>
              </div>
              <h4>运营交付与结算覆盖</h4>
              <div className="scheduler-summary">
                <article><span>预测交付率</span><strong>{percent(importState.tsSettlement.delivery.rate)}</strong><small>{importState.tsSettlement.delivery.delivered} / {importState.tsSettlement.delivery.expected} 个到槽任务留下正式预测</small></article>
                <article><span>到期结算覆盖率</span><strong>{percent(importState.tsSettlement.coverage.rate)}</strong><small>{importState.tsSettlement.coverage.settled} / {importState.tsSettlement.coverage.due} 份到期预测已有真实走势</small></article>
              </div>
              <h4>当前可信方向、动作与路径</h4>
              <p>方向按预测送达后的可评分窗口净变化评价：上涨超过0.05%为偏涨，下跌超过0.05%为偏跌，±0.05%内为持平（RANGE）。盘中振幅、盘型、路径、关键位和交易资格分别评价。</p>
              <div className="scheduler-summary">
                {(["SPY", "QQQ"] as const).map((symbol) => { const metric = importState.tsSettlement.trusted.direction[symbol]; return <article key={symbol}><span>{symbol} 研究层全预测方向</span><strong>{percent(metric.accuracy)}</strong><small>{metric.correct_count}/{metric.sample_count} · 95%区间 {confidence(metric.confidence_interval_95)} · 后验多数类别占比 {percent(metric.post_hoc_majority_rate)}（不可交易基线） · {metric.evidence === "SUFFICIENT" ? "证据可用" : "证据不足"}</small></article>; })}
                <article><span>主路径归属</span><strong>{percent(importState.tsSettlement.trusted.paths.accuracy)}</strong><small>{importState.tsSettlement.trusted.paths.correct_count}/{importState.tsSettlement.trusted.paths.sample_count} 个可评分路径 · 主/反/极端/歧义/未完成 {Object.values(importState.tsSettlement.trusted.paths.attribution).join("/")}</small></article>
                <article><span>三分类 Brier</span><strong>{importState.tsSettlement.trusted.brier.mean?.toFixed(3) ?? "证据不足"}</strong><small>n={importState.tsSettlement.trusted.brier.sample_count} · ∑(p−y)² · 量程0–2 · 均匀基线 {importState.tsSettlement.trusted.brier.uniform_baseline.toFixed(3)}</small></article>
                <article><span>动作结果层</span><strong>{importState.tsSettlement.trusted.actions.sample_count || "证据不足"}</strong><small>WAIT / CONDITIONAL 单独评价，不当成方向错误 · {importState.tsSettlement.trusted.actions.outcomes.map((item) => `${displayText(item.outcome)} ${item.count}`).join(" · ") || "尚无样本"}</small></article>
                <article><span>区间与关键位</span><strong>{importState.tsSettlement.trusted.range.correct_count}/{importState.tsSettlement.trusted.range.sample_count}</strong><small>区间符合 · 关键位触及 {importState.tsSettlement.trusted.key_levels.observed_count}/{importState.tsSettlement.trusted.key_levels.sample_count}</small></article>
              </div>
              <h4>简单基线与Risk-Coverage</h4>
              <div className="scheduler-summary">
                {importState.tsSettlement.trusted.baselines.map((item) => <article key={item.baseline}><span>{item.label}</span><strong>{item.accuracy === null ? item.mean_brier === null ? "证据不足" : `Brier ${item.mean_brier.toFixed(3)}` : percent(item.accuracy)}</strong><small>n={item.sample_count} · 覆盖 {percent(item.coverage)} · MCC {item.mcc?.toFixed(3) ?? "不足"}</small></article>)}
                {importState.tsSettlement.trusted.risk_coverage.map((item) => <article key={item.qualification}><span>{displayText(item.qualification)}</span><strong>覆盖 {percent(item.coverage)}</strong><small>准确 {percent(item.accuracy)} · 风险 {percent(item.risk)} · MCC {item.mcc?.toFixed(3) ?? "不足"}</small></article>)}
              </div>
              <p className="source-note">合同：{importState.tsSettlement.trusted.forecast_contract} → {importState.tsSettlement.trusted.settlement_contract}；forecast版本 {importState.tsSettlement.trusted.forecast_versions.join("、") || "等待首份"}；时间范围 {importState.tsSettlement.trusted.time_range.start_at ? `${formatPtDateTime(importState.tsSettlement.trusted.time_range.start_at)} 至 ${formatPtDateTime(importState.tsSettlement.trusted.time_range.end_at!)}` : "尚无可信样本"}。</p>
              <details className="source-details"><summary>旧版本历史与只读严格重算投影</summary><p>旧结算标记为 <code>{importState.tsSettlement.legacy.label}</code>，原记录一条不改；严格投影仅在读取时用 received_at 重算，不覆盖原结算，也不进入当前百分比。</p><p>旧预测 {importState.tsSettlement.legacy.forecast_count} · 原结算 {importState.tsSettlement.legacy.settled_count} · 可严格投影 {importState.tsSettlement.legacy.strict_projection_count}；投影方向：SPY {importState.tsSettlement.legacy.strict_projection.direction.SPY.correct_count}/{importState.tsSettlement.legacy.strict_projection.direction.SPY.sample_count}，QQQ {importState.tsSettlement.legacy.strict_projection.direction.QQQ.correct_count}/{importState.tsSettlement.legacy.strict_projection.direction.QQQ.sample_count}。</p>{importState.tsSettlement.legacy.groups.map((item) => <p key={item.label}><b>{item.label}</b> · 预测 {item.forecast_count} · 结算 {item.settled_count} · SPY {item.direction.SPY.correct_count}/{item.direction.SPY.sample_count} · QQQ {item.direction.QQQ.correct_count}/{item.direction.QQQ.sample_count}</p>)}</details>
              {importState.tsSettlement.recent.length ? <details className="settlement-recent-details"><summary>展开最近预测与结算明细（{importState.tsSettlement.recent.length}）</summary><div className="settlement-list">
                <div className="compare-head"><span>发布时预测</span><span>后来实际</span><span>结算说明</span></div>
                {importState.tsSettlement.recent.map((item) => {
                  const result = item.settlement;
                  return <div className="compare-row" key={item.forecast_run_id}>
                    <span><b>{item.market_date} {item.slot} · {displayText(item.phase)}</b><small>Forecast Layer · {displayText(item.report_type)} · {displayText(item.path_bias)}<br />主/反/极端 {item.scenario_probabilities.main}/{item.scenario_probabilities.reverse}/{item.scenario_probabilities.extreme}% · 尚未校准<br />Trade Qualification Layer · {displayText(item.qualification.status)}：{item.qualification.reason}<br />{item.one_line_forecast}</small></span>
                    <b>{result ? <>SPY {displayText(result.symbols.SPY.actual_direction)} {result.symbols.SPY.return_pct.toFixed(2)}%<br />QQQ {displayText(result.symbols.QQQ.actual_direction)} {result.symbols.QQQ.return_pct.toFixed(2)}%<br />{displayText(result.actual_scenario)}</> : item.eligibility === "OFFICIAL_LIVE" ? "尚未到观察窗口结束" : displayText(item.eligibility)}</b>
                    <b>{result ? <>{displayText(result.status)} · {displayText(result.path_result)}<br />SPY {result.symbols.SPY.direction_correct ? "方向正确" : "方向不符"} / QQQ {result.symbols.QQQ.direction_correct ? "方向正确" : "方向不符"}</> : item.eligibility === "OFFICIAL_LIVE" ? "等待真实 K 线自动结算" : "保留原文，但不进入 LIVE 准确率"}</b>
                    <details className="card-details"><summary>查看关键位、因果窗口与技术证据</summary>{result ? <><p>冻结期限：{formatPtDateTime(item.forecast_window.start_at)} 至 {item.forecast_window.end_at ? formatPtDateTime(item.forecast_window.end_at) : displayText(item.forecast_window.end_condition)}；确认延迟 {item.confirmation_delay_minutes === null ? "尚不可评分" : `${item.confirmation_delay_minutes}分钟`}。</p><p>预测区间：SPY {displayText(result.symbols.SPY.range_result.status)} / QQQ {displayText(result.symbols.QQQ.range_result.status)}；路径时间：{displayText(result.timing_result.status)}</p>{result.observation_window.received_at ? <p>观察 {formatPtDateTime(result.observation_window.observed_at!)} · 网关收到 {formatPtDateTime(result.observation_window.received_at)} · 延迟 {Math.round((result.observation_window.gateway_delay_ms ?? 0) / 1000)}秒 · 首根可评分K线 {formatPtDateTime(result.observation_window.first_scorable_bar_at!)} · 使用 {result.observation_window.bar_count} 根。</p> : <p>旧结算使用发布观察时间窗口，标记为 LEGACY_NON_CAUSAL_WINDOW；原记录不改。</p>}{result.swing_observation ? <p>中短期波段复盘：{swingText("SPY", result.swing_observation.symbols.SPY)}；{swingText("QQQ", result.swing_observation.symbols.QQQ)}。</p> : <p>本能力上线前的旧结算没有波段记分字段；历史不回填。</p>}<p>{result.pattern_result.reason}</p>{result.amplitude_result ? <p>实际幅度：SPY 区间 {result.amplitude_result.symbols.SPY.range_pct.toFixed(2)}% / 净变化 {result.amplitude_result.symbols.SPY.net_move_pct.toFixed(2)}%；QQQ 区间 {result.amplitude_result.symbols.QQQ.range_pct.toFixed(2)}% / 净变化 {result.amplitude_result.symbols.QQQ.net_move_pct.toFixed(2)}%。</p> : null}{result.tradeability_result ? <p>动作状态：{displayText(result.tradeability_result.published_status)} → {displayText(result.tradeability_result.outcome)}。{result.tradeability_result.reason}</p> : null}<p>同期简单基线：{(["SPY", "QQQ"] as const).map((symbol) => `${symbol} ${item.baselines[symbol].map((baseline) => `${displayText(baseline.baseline)}=${baseline.prediction ? displayText(baseline.prediction) : "不可判"}`).join("、")}`).join("；")}</p>{item.forecast_identity ? <p>{item.forecast_identity.source_identity ? <>模型源码 SHA256 <code>{item.forecast_identity.source_identity.core_sha256}</code> · 程序源码 SHA256 <code>{item.forecast_identity.source_identity.source_sha256}</code> · 构建 SHA256 <code>{item.forecast_identity.source_identity.runtime_sha256}</code> · 来源 {item.forecast_identity.source_identity.source_origin.kind}；仅证明本机内容一致，不是官方签名或预测优势。</> : <>生成commit <code>{item.forecast_identity.generator_commit}</code> · 模型commit <code>{item.forecast_identity.model_release_commit}</code> · runtime <code>{item.forecast_identity.runtime_release_sha256}</code></>}</p> : null}<code>{item.forecast_run_id}</code></> : <p>预测原文和哈希已永久保存；结算不会覆盖原预测。</p>}</details>
                  </div>;
                })}
              </div></details> : <p className="source-note">功能从 {formatPtDateTime(importState.tsSettlement.activated_at)} 起记录。不会回填旧预测；下一份自然 LIVE TS 发布后会自动出现。</p>}
              {importState.tsSettlement.exclusions.length > 0 && <details className="source-details"><summary>为什么有些槽不进入准确率</summary>{importState.tsSettlement.exclusions.slice(0, 12).map((item, index) => <p key={`${item.slot}-${index}`}>{item.slot} · {displayText(item.status)}：{item.reason}</p>)}</details>}
              {importState.tsSettlement.by_slot.length > 0 && <details className="source-details"><summary>旧合同各槽位（历史参考，不代表当前版本）</summary><div className="field-tags">{importState.tsSettlement.by_slot.map((item) => <code key={item.slot}>{item.slot} · {percent(item.direction_accuracy)} · {item.settled_count}/{item.sample_count} 已结算</code>)}</div>{importState.tsSettlement.probability_buckets.map((item) => <p key={item.probability_pct}>{item.probability_pct}% 概率：{item.hit_count}/{item.forecast_count} 次发生（{percent(item.realized_rate)}）</p>)}</details>}
              </DetailSheet>
            </div>
          </section>
          </div>
          <div className="workspace-column">
          <section className="panel priority-section" id="external-expert">
            <div className="section-heading"><h3>观察案例</h3><span className="muted-chip">{hasRuntimeData ? `${importState.externalExpert.open_count} 个观察中` : "数量尚未确认"}</span></div>
            <p>{hasRuntimeData ? `共 ${importState.externalExpert.case_count} 个案例 · ` : ""}只作研究，不是你的成交收益。</p>
            <DetailSheet title="案例统计与记录口径" label="查看案例统计与记录口径">
            <p className="source-note">原始消息按真实收到时间追加保存；事后与关机补交不会冒充LIVE。外部专家不是教师标签，Broker写入保持为0。期权mark与最大浮盈只是研究观察，不是你的成交收益；未绑定RB逐笔成交时，不判定Owner执行偏差。</p>
            <div className="scheduler-summary">
              <article><span>独立案例</span><strong>{importState.externalExpert.case_count}</strong><small>开放 {importState.externalExpert.open_count} · TS可对照 {importState.externalExpert.ts_comparable_count}</small></article>
              <article><span>实时性</span><strong>{importState.externalExpert.realtime.LIVE} LIVE</strong><small>延迟 {importState.externalExpert.realtime.DELAYED} · 事后 {importState.externalExpert.realtime.LATE_RECAP} · 关机补交 {importState.externalExpert.realtime.OFFLINE_RECAP}</small></article>
              <article><span>WAIT诊断</span><strong>{Object.values(importState.externalExpert.wait_classifications).reduce((sum, count) => sum + count, 0)}</strong><small>{Object.entries(importState.externalExpert.wait_classifications).map(([key, count]) => `${displayText(key)} ${count}`).join(" · ") || "等待真实案例"}</small></article>
              <article><span>信号结果</span><strong>{Object.values(importState.externalExpert.outcomes).reduce((sum, count) => sum + count, 0)}</strong><small>{Object.entries(importState.externalExpert.outcomes).map(([key, count]) => `${displayText(key)} ${count}`).join(" · ") || "未决"}</small></article>
            </div>
            </DetailSheet>
            {importState.externalExpert.cases.length ? [true, false].map((active) => <details className="owner-disclosure case-group" key={String(active)} open={active}>
              <summary>{active ? "当前观察" : "历史案例与已结束观察"}</summary>
              <div className="settlement-list">
              {importState.externalExpert.cases.filter((item) => (item.status === "OPEN" || item.status === "PARTIAL_EXIT") === active).map((item) => <details className="source-details owner-disclosure" key={item.case_id}>
                <summary>{item.symbol && item.symbol !== "UNKNOWN" ? item.symbol : "标的待确认"} · {item.direction === "MIXED" ? "方向未统一" : item.direction && item.direction !== "UNKNOWN" ? displayText(item.direction) : "方向待确认"} · {{ OPEN: "观察中", PARTIAL_EXIT: "部分出场", CLOSED: "已结束", INVALIDATED: "已失效", EXPIRED: "已过期", RECAP_ONLY: "仅复盘" }[item.status]}</summary>
                <p>最近更新：{formatPtDateTime(item.updated_at)}</p>
                <p><b>结论：</b>{item.conclusion ?? "尚未形成复盘结论；不据此判断你的执行好坏。"}</p>
                <DetailSheet title={`${item.symbol} · 原始消息与逐次采样`} label={`查看原始消息与逐次采样（${item.events.length} 条）`}>
                <p>来源：{item.source ?? "待确认"} · 案例编号 <code>{item.case_id}</code></p>
                <p><b>实时性：</b>{displayText(item.realtime_class)} · <b>合约：</b>{item.instrument ?? "UNKNOWN"} · <b>WAIT：</b>{item.wait_classification ? displayText(item.wait_classification) : "待对照"}</p>
                <div className="compare-head"><span>外部专家</span><span>Owner执行</span><span>TS同期</span></div>
                {item.events.map((event) => <div className="compare-row" key={event.event_id}>
                  <span><b>{formatPtDateTime(event.received_at)} · {displayText(event.event_type)}</b><small>{event.raw_text ?? factsText(event.expert)}{event.source_published_at ? <><br />原始发布 {formatPtDateTime(event.source_published_at)}</> : null}{event.evidence.map((evidence) => <a href={evidence.url} target="_blank" rel="noreferrer" key={evidence.evidence_id}><br />查看原始证据：{evidence.name}</a>)}</small></span>
                  <b>{factsText(event.owner)}</b>
                  <b>{factsText(event.ts)}</b>
                  {(event.market || event.recap) && <details className="card-details"><summary>市场路径与复盘</summary><p><b>市场：</b>{factsText(event.market)}</p><p><b>复盘：</b>{factsText(event.recap)}</p></details>}
                </div>)}
                </DetailSheet>
              </details>)}
              </div>
            </details>) : <p className="health-clear">{hasRuntimeData ? "尚无观察案例。" : "案例尚未读取。"}</p>}
          </section>
          </div>
        </div>}

        {page === "company" && <div className="two-column company-layout">
          <section className="workspace-company-summary" id="owner-opportunities">
            <MarketDecisionSummary currentTs={marketAnalysis} nextCheck={nextAnalysisText} analysisDisplay={marketDisplay} checkStatus={marketCheckStatus} checkAt={currentTruth.natural_slot.frozen_at} regularSession={currentTruth.market_session === "REGULAR"} />
            <OwnerOpportunityShortlist snapshot={approvedCapabilities} at={currentTime} nextCheck={nextAnalysisText} currentReadFailed={fixedReadFailed} />
          </section>
            <article className="overview-card overview-card-full" id="market-events" data-tone={upcomingSpecialEvents.length || specialSymbol ? "good" : "neutral"}>
              <span>特别事件 · 学习观察（不交易）</span>
              <strong>{specialEventTitle}</strong>
              {macroLearningStudies.length > 0 && <>
                <p>先看我们的判断。这是练习预测，只用于事后复盘，不会改变正式交易结论，也不会自动下单。</p>
                {macroLearningStudies.length > 0 && <div className="overview-event-list">{macroLearningStudies.map((study) => <div key={study.study_id}>
                  <b>{macroReleaseText[study.release_name]} · {macroStudyStageText[study.stage]}</b>
                  <span>{study.call ? `当前公式推演：${study.call.label}；另一种情况：${study.call.alternative_label}。旧公式未经校准，不把分值当胜率` : "缺少判断资料，本轮不补写"}</span>
                  <small>{study.frozen_at ? `这份判断锁定于 ${formatPtDateTime(study.frozen_at)}，结果公布前不会修改` : "原资料不等于原判断。当前公式推演尚未独立冻结，不能计事前成绩"}</small>
                  {study.review && <small>复盘：{study.review.summary}{study.review.market_reaction ? `；${study.review.market_reaction}` : ""}</small>}
                  <details><summary>为什么这么猜？什么情况算猜错？</summary><p><b>我们看了什么：</b>{study.evidence.join("；") || "目前资料不足"}</p><p><b>什么情况算猜错：</b>{study.falsifiers.join("；") || "目前资料不足"}</p><p><b>结果不同，大盘可能怎么走：</b></p><ul>{study.scenarios.map((scenario) => <li key={scenario.condition}>{scenario.condition}：{scenario.rates}；SPY {scenario.spy}；QQQ {scenario.qqq}</li>)}</ul><small>{study.limitations.join("；")}</small></details>
                </div>)}</div>}
              </>}
              {upcomingSpecialEvents.length > 0 && <details><summary>查看未来事件日历（{upcomingSpecialEvents.length}项）</summary>{macroCalendar && <small>最近日历资料：{formatPtDateTime(macroCalendar.as_of)}；当前分析更新失败不删除既有排期，时间变更等待官方新资料。来源 {macroCalendar.source_record_id}</small>}<div className="overview-event-list">{upcomingSpecialEvents.slice(0, 4).map((event) => <div key={event.id}><b>{event.title}</b><span>{event.when}</span><small>{event.detail}</small></div>)}</div></details>}
              {specialSymbol ? <details><summary>查看当前个股事件复盘</summary><small className="overview-card-note">{specialEventReason}</small></details> : !macroLearningStudies.length && !upcomingSpecialEvents.length ? <p>{specialEventReason}</p> : null}
              <a href="/company#opportunities">查看观察池与事件依据</a>
            </article>
          <section className="panel priority-section" id="opportunities">
            <div className="section-heading"><div><p className="section-kicker">真实业务能力</p><h2>固定池、事件、财报与临时发现</h2></div><span className="status-chip" data-status={fixedReadFailed ? "DATA_BLOCKED" : fixedPoolOwnerStatus}>{approvedCapabilities ? fixedReadFailed ? "最近官方结构 · 最近采集失败" : fixedAnalysisPending ? "最近官方结构 · 分析待槽" : "当前冻结快照" : "等待首次官方归档"}</span></div>
            {fixedReadFailed && <p className="source-note">最近分析尝试：{latestRun("A1")?.slot_id ?? "未上报"} · {latestRun("A1") ? formatPtDateTime(latestRun("A1")!.event_at) : "时间未上报"}。最近有效结构：{approvedCapabilities ? formatPtDateTime(approvedCapabilities.generated_at) : "尚未形成"}；这不是当前连接状态，实时报价与K线健康单独显示。</p>}
            <p className="source-note">优先显示当前自然槽的真实只读冻结数据；当前槽尚未生成时，继续显示 SQLite 中最近一份官方结构并明确标成“分析待槽”。观察池使用日线、4小时、1小时和30分钟同一快照；技术观察不等于交易资格，财报后的同期价格反应也不自动等于因果。</p>
            <div className="capability-summary" aria-label="当前机会来源摘要">
              <article><strong>{fixedMultiframeReady ? approvedCapabilities.fixed_pool.observed_count : 0}/{fixedUniverseSize}</strong><span>固定池完整多周期结构</span></article>
              <article><strong>{approvedCapabilities?.event_scan.items.length ?? 0}</strong><span>事件候选</span></article>
              <article><strong>{approvedCapabilities?.earnings_center.items.length ?? 0}</strong><span>财报日历与真实结果</span></article>
              <article><strong>{approvedCapabilities?.extended_discovery.symbols.length ?? 0}</strong><span>临时发现</span></article>
              <article><strong>{approvedCapabilities?.real_positions.count ?? "—"}</strong><span>真实只读持仓</span></article>
            </div>
            <details className="company-capability-details"><summary>展开观察池、事件、财报与临时发现明细</summary>
            <MarketRadar snapshot={approvedCapabilities} analysisPending={fixedAnalysisPending} currentReadFailed={fixedReadFailed} extendedHours={marketEnvironment?.extended_hours} nextCheck={nextAnalysisText} />
            <div className="company-brain-grid" aria-label="当前公司大脑">
              <article><span>System A · 技术结构</span><strong>{fixedMultiframeReady ? `${approvedCapabilities!.fixed_pool.observed_count}/${fixedUniverseSize} 已形成四周期结构` : "等待四周期自然数据"}</strong><p>{patternEvidence?.symbols ? `SPY ${displayText(patternEvidence.symbols.SPY?.current_state)} · QQQ ${displayText(patternEvidence.symbols.QQQ?.current_state)}` : "多槽盘型证据尚未生成，不用单槽猜形态。"}</p></article>
              <article><span>System B · 事件等级</span><strong>{importantEvent ? `${displayText(importantEvent.importance)} · ${importantEvent.title}` : "当前没有核验后的重大事件"}</strong><p>{importantChain ? `${importantChain.mechanism} · 市场${displayText(importantChain.market_confirmation)}` : "没有证据链时保持待验证，不编造影响原因。"}</p></article>
              <article><span>独立评审组 · 反方证据</span><strong>{committeeShadow ? `${committeeShadow.evidence_against?.length ?? 0} 条反方证据` : committeeUnavailableReason}</strong><p>{committeeShadow?.evidence_against?.slice(0, 2).join("；") || "当前槽没有可展示的独立反方意见。"}</p><a href="/options#department-review">查看完整联合复核</a></article>
              <article><span>D / A3 · 行动与管理</span><strong>{dShadow ? `${displayText(dShadow.action)} · ${dShadow.summary}` : dUnavailableReason}</strong><p>{a3Shadow?.plain_language ?? `${a3UnavailableReason}；投诉、冲突和Owner待办继续留在现有管理链。`}</p><a href="/options#department-review">查看触发、失效和待办</a></article>
            </div>
            <div className="capability-list opportunity-list">
              <article data-retention={approvedCapabilities?.owner_watchlist.status === "OBSERVED" ? "PRESERVED_LIVE" : "FREEZE_GAP"}>
                <div><span>Owner Watchlist</span><b>{approvedCapabilities?.owner_watchlist.items.length ?? 0} 项</b></div>
                <p>{approvedCapabilities?.owner_watchlist.items.length ? approvedCapabilities.owner_watchlist.items.join("、") : approvedCapabilities?.owner_watchlist.reason ?? "等待自然槽上报"}</p>
                <small>必须来自Owner明确确认；不会用固定池、持仓或新闻自动猜出老板观察名单。</small>
              </article>
              <article data-retention={approvedCapabilities?.real_positions.status === "OBSERVED" ? "PRESERVED_LIVE" : "FREEZE_GAP"}>
                <div><span>真实持仓池</span><b>{approvedCapabilities ? displayText(approvedCapabilities.real_positions.status) : "未观察到"}</b></div>
                <p>{approvedCapabilities?.real_positions.symbols.length ? `${approvedCapabilities.real_positions.symbols.join("、")} · 共 ${approvedCapabilities.real_positions.count} 个只读期权持仓` : "当前没有观察到可验证的真实期权持仓，或账户只读数据被阻断。"}</p>
                <small>只保存脱敏账户标签和持仓字段；不显示或保存完整账户号码。</small>
              </article>
              <article data-retention={approvedCapabilities?.earnings_center.status === "OBSERVED" ? "PRESERVED_LIVE" : "FREEZE_GAP"}>
                <div><span>财报机会与公布后验证</span><b>{approvedCapabilities?.earnings_center.items.length ?? 0} 项</b></div>
                {approvedCapabilities?.earnings_center.items.length ? approvedCapabilities.earnings_center.items.slice(0, 8).map((item) => <p key={`${item.symbol}-${item.scheduled_for}`}><b>{item.symbol} · {item.scheduled_for.slice(0, 10)} · {displayText(item.session)}</b>：{item.why_watch ?? "旧自然快照只记录了日历，等待新结果链补充"}。<br />状态：{displayText(item.result_status)}；还缺：{item.missing_confirmation?.join("；") || "等待新财报结果自然槽"}。下一次：{item.next_check ?? "下一自然槽"}。</p>) : <p>前后7日没有观察池财报日历或已公布结果；不会用旧结果填充当前机会。</p>}
                <small>{approvedCapabilities?.earnings_center.limitation ?? "等待自然槽上报"}</small>
              </article>
              <article data-retention={approvedCapabilities?.event_scan.status === "OBSERVED" ? "PRESERVED_LIVE" : "FREEZE_GAP"}>
                <div><span>Event Scan 事件机会</span><b>{approvedCapabilities?.event_scan.items.length ?? 0} 条</b></div>
                {approvedCapabilities?.event_scan.items.length ? approvedCapabilities.event_scan.items.slice(0, 8).map((item) => <p key={item.event_id}><b>{item.title}</b> · {item.source} · 影响 {item.impact_mapping.join("、") || "对象未核验"} · {evidenceText(item.evidence_state)}</p>) : <p>当前没有符合重大事件或明确影响对象门禁的事件候选。</p>}
                <small>只有交叉核验且影响对象明确的重大事件，才有资格进入临时发现；其余保留为证据。</small>
              </article>
              <article data-retention={approvedCapabilities?.extended_discovery.status === "OBSERVED" ? "PRESERVED_LIVE" : "FREEZE_GAP"}>
                <div><span>Extended Discovery 临时发现</span><b>{approvedCapabilities?.extended_discovery.symbols.length ?? 0}/12</b></div>
                <p>{approvedCapabilities?.extended_discovery.symbols.length ? approvedCapabilities.extended_discovery.symbols.join("、") : approvedCapabilities?.extended_discovery.reason ?? "等待自然槽上报"}</p>
                <small>与观察池永久隔离，最多12只，有效期7天；不会改变固定池。</small>
                <details><summary>查看批准来源</summary><div className="field-tags compact">{approvedCapabilities?.provenance.map((item) => <code key={`${item.commit}-${item.path}`}>{item.capability} · {item.commit} · {item.path}</code>) ?? <code>等待自然槽</code>}</div></details>
              </article>
            </div>
            </details>
          </section>
          <section className="panel" id="timeline">
            <div className="section-heading"><div><p className="section-kicker">03 / 公司运行</p><h2>公司时间线</h2></div><span className="muted-chip">V2 固定时序</span></div>
            <div className="scheduler-summary">
              <article><span>下一次运行（加州时间）</span><strong>{importState.scheduler.next_run ? `${importState.scheduler.next_run.business_slot} · ${importState.scheduler.next_run.label}` : "暂无"}</strong><small>{importState.scheduler.next_run?.scheduled_pt.replace(" PT", " 加州时间") ?? "未排定"}</small></article>
              <article><span>今日槽位</span><strong>{importState.scheduler.today.completed} / {importState.scheduler.today.expected}</strong><small>待运行 {importState.scheduler.today.pending} · 阻断 {importState.scheduler.today.blocked}</small></article>
              <article><span>今日已发生的漏跑与失败（留档）</span><strong>{importState.scheduler.health_window.missed + importState.scheduler.health_window.failed}</strong><small>{importState.scheduler.health_window.dates.join(" / ")} 加州时间 · 只有最近 90 分钟且尚未恢复的记录影响当前健康；初始化漏跑 {importState.scheduler.health_window.initialization_missed} 条仅归档</small></article>
            </div>
            {managerReview && <div className="scheduler-summary">
              <article><span>{managerReviewCurrent ? "Codex 当前公司检查" : "Codex 最近冻结检查（历史）"}</span><strong data-status={managerReview.status}>{displayText(managerReview.status)}</strong><small>{displayText(managerReview.review_type)} · {formatPtDateTime(managerReview.checked_at)}{managerReviewCurrent ? "" : " · 不覆盖当前实时健康"}</small></article>
              <article><span>系统已经做了什么</span><strong>{managerReview.actions_taken.length ? `已安全处理 ${managerReview.actions_taken.length} 项` : "本轮无需自动修复"}</strong><small>完整动作和部门原始状态默认折叠保留。</small></article>
              <article><span>下一交易日</span><strong>{displayText(managerReview.tomorrow)}</strong><small>完整预测、WAIT和NO_TRADE状态在下方技术详情查看。</small></article>
            </div>}
            <div className="timeline company-key-timeline" aria-label="关键公司事件">
              {importState.scheduler.recent.slice(0, 2).map((checkpoint) => {
                const recovered = recoveredScheduleFaultReason(importState, checkpoint, currentTime);
                return <div className="timeline-row" key={`key-${checkpoint.slot_id}`}>
                  <time>{checkpoint.business_slot}</time><span className={`timeline-dot ${recovered ? "good" : scheduleTone(checkpoint.status)}`} />
                  <div><b>{checkpoint.label} · {recovered ? "当时受阻，后续已恢复" : scheduleStatusText[checkpoint.status] ?? displayText(checkpoint.status)}</b><small>{checkpoint.scheduled_pt}</small><em className={checkpoint.status === "SUCCEEDED" || recovered ? "observed-text" : ""}>{recovered ?? (checkpoint.status === "SUCCEEDED" ? "已按计划运行；部门原始状态已折叠留证。" : "本槽异常已留证；完整原因在技术详情查看。")}</em></div>
                </div>;
              })}
              {healthOverview.current.slice(0, 1).map((incident) => <div className="timeline-row" key={`key-${incident.incident_id}`}>
                <time>{formatPtTime(incident.last_seen_at)}</time><span className="timeline-dot warn" />
                <div><b>当前观察 · {incident.title}</b><small>{incident.owner_required ? "需要Owner处理" : "系统自动复查，Owner无需处理"}</small><em>{incident.suggestion}</em></div>
              </div>)}
            </div>
            <details className="timeline-details company-technical-log"><summary>展开完整时间线、WAIT / NO_TRADE 与技术状态</summary>
            {managerReview && <div className="incident-list"><article><b>Codex经理原始检查 · {displayText(managerReview.status)}</b><span>{formatPtDateTime(managerReview.checked_at)} · {displayText(managerReview.review_type)}</span><p>{managerReview.headline}</p><p>{managerReview.actions_taken.join("；") || "本轮无需自动修复"}</p><small>{managerReview.prediction_review.summary}</small></article></div>}
            <div className="timeline">
              {importState.scheduler.recent.slice(0, 5).map((checkpoint) => {
                const recovered = recoveredScheduleFaultReason(importState, checkpoint, currentTime);
                return <div className="timeline-row" key={checkpoint.slot_id}>
                  <time>{checkpoint.business_slot}</time><span className={`timeline-dot ${recovered ? "good" : scheduleTone(checkpoint.status)}`} />
                  <div><b>{checkpoint.label} · {recovered ? "当时受阻，后续已恢复" : scheduleStatusText[checkpoint.status] ?? displayText(checkpoint.status)}</b><small>{checkpoint.scheduled_pt} · {checkpoint.late_seconds > 0 ? `迟到 ${checkpoint.late_seconds} 秒` : "准时"}</small><em className={checkpoint.status === "SUCCEEDED" || recovered ? "observed-text" : ""}>{recovered ?? checkpoint.reason ?? "运行账本与本地输出已留证"}</em></div>
                </div>;
              })}
              {officialMacro?.events.slice(0, 3).map((event, index) => <div className="timeline-row" key={`macro-${String(event.event_id ?? event.event_fingerprint ?? index)}`}>
                <time>{formatPtTime(event.scheduled_at)}</time><span className="timeline-dot warn" />
                <div><b>官方宏观 · {event.release_name}</b><small>{String(event.agency ?? (event.source === "BLS Official Release Calendar" ? "BLS" : "官方来源"))} · {formatPtDateTime(event.scheduled_at)}</small><em className="observed-text">计划公布，结果未核验前不推断方向</em></div>
              </div>)}
              {importState.marketIntelligence.events.slice(0, 3).map((event) => {
                const chain = event.event_fingerprint ? importState.marketIntelligence.causalChains.find((item) => item.event_fingerprint === event.event_fingerprint) : null;
                return <div className="timeline-row" key={`event-${event.event_id}`}>
                  <time>{event.published_at ? formatPtTime(event.published_at) : event.scheduled_for?.slice(5) ?? "计划"}</time><span className={`timeline-dot ${event.importance === "MARKET_MOVING" ? "warn" : "idle"}`} />
                  <div><b>{event.kind === "NEWS" ? "新闻" : "财报"} · {event.title}</b><small>{event.source} · {displayText(event.event_type)} · {event.affected_symbols.join("、") || "影响对象未提供"}</small><em className={chain?.event_evidence_state === "VERIFIED" ? "observed-text" : ""}>{chain ? `${chain.what_happened}；价格/期权确认：${displayText(chain.market_confirmation)}` : event.kind === "EARNINGS" ? "日历候选，不代表结果或价格影响" : "尚未进入重大事件因果链"}</em></div>
                </div>;
              })}
              {importState.selfCheck.recent.slice(0, 3).map((incident) => <div className="timeline-row" key={incident.incident_id}>
                <time>{formatPtTime(incident.last_seen_at)}</time><span className={`timeline-dot ${incident.status === "RESOLVED" ? "good" : "warn"}`} />
                <div><b>{incident.status === "RESOLVED" ? "已恢复" : "故障"} · {incident.title}</b><small>{displayText(incident.layer)} · {displayText(incident.severity)}</small><em className={incident.status === "RESOLVED" ? "observed-text" : ""}>{incident.suggestion}</em></div>
              </div>)}
            </div></details>
            <details className="timeline-details planned-timeline"><summary>查看 V2 固定计划槽位（未观察到不等于当前故障）</summary><div className="timeline">
              {snapshot.timeline.map((item) => {
                const observed = timelineRunObservation(item.time, importState.runLedger.runs) ?? timelineObservation(item.field, shadowTsOutputs.length ? shadowTsOutputs : null);
                return (
                  <div className="timeline-row" key={`${item.time}-${item.label}`}>
                    <time>{item.time}</time><span className={`timeline-dot ${observed ? "good" : "idle"}`} />
                    <div><b>{item.label}</b><small>{item.contract === "acceptance" ? "验收计划槽位" : "V2 计划槽位"}</small><em className={observed ? "observed-text" : ""}>{observed ?? "未观察到"}</em><details><summary>合同与技术字段</summary><code>{item.contract}</code><code>{item.field}</code></details></div>
                  </div>
                );
              })}
            </div></details>
            {(importState.runLedger.runs.length > 0 || importState.recentOutputs.length > 0) && <details className="timeline-details"><summary>查看最近运行、交付与记录 ID</summary>
            {importState.runLedger.runs.length > 0 && <>
              <p className="source-note">最近部门运行（运行状态与交付状态分开）</p>
              <div className="timeline">
                {importState.runLedger.runs.slice(0, 8).map((run) => <div className="timeline-row" key={`${run.agent_id}-${run.skill_id}-${run.run_id}-${run.slot_id}`}>
                  <time>{run.slot_id}</time><span className={`timeline-dot ${run.status === "SUCCEEDED" ? "good" : "idle"}`} />
                  <div><b>{run.agent_id} · {displayText(run.status)}</b><small>{run.skill_id} · {displayText(run.channel)}</small><em className={run.status === "SUCCEEDED" ? "observed-text" : ""}>{deliverySummary(run)}</em></div>
                </div>)}
              </div>
            </>}
            {importState.recentOutputs.length > 0 && <>
              <p className="source-note">最近本地输出（按合同时间排序）</p>
              <div className="timeline">
                {importState.recentOutputs.slice(0, 6).map((output) => <div className="timeline-row" key={output.record_id}>
                  <time>{formatPtTime(output.observed_at)}</time><span className="timeline-dot good" />
                  <div><b>{output.output_type}</b><small>{output.channel}</small><em className="observed-text">{output.record_id}</em></div>
                </div>)}
              </div>
            </>}
            </details>}
            <p className="source-note">老板界面默认显示加州时间；固定槽位仍按原有加州时间定义。宏观日程来自 BLS/BEA 官方入口，新闻与财报来自 Finnhub 官方接口；没有证据的因果关系只显示“待验证假设”。</p>
          </section>

          <section className="panel" id="patrol">
            <div className="section-heading"><div><p className="section-kicker">04 / 日常巡检</p><h2>早中晚和收工巡检</h2></div><span className="status-chip" data-status={systemSurfaceStatus}>{ownerSystemStatus}</span></div>
            <details className="company-patrol-details"><summary>展开巡检、自动观察与验收计数</summary>
            {managerReview && <div className="incident-list"><article><b>Codex 经理 · {displayText(managerReview.review_type)} · {managerReviewCurrent ? "当前检查" : "冻结历史"}</b><span>{displayText(managerReview.status)} · {managerReview.company_working ? "该次运行链可用" : "该次运行链未完整通过"}</span><p>{managerReview.headline}{managerReviewCurrent ? "" : " 该结论不覆盖当前实时健康。"}</p><small>下一有效检查：{importState.scheduler.next_run ? `${importState.scheduler.next_run.scheduled_pt.replace(" PT", " 加州时间")} · ${importState.scheduler.next_run.label}` : "等待排定"}</small></article></div>}
            {healthOverview.current.filter((incident) => incident.severity !== "CRITICAL").length > 0 && <div className="incident-list">
              {healthOverview.current.filter((incident) => incident.severity !== "CRITICAL").map((incident) => <article key={incident.incident_id}><b>{incident.title}</b><span>{displayText(incident.layer)} · {displayText(incident.severity)}</span><p>{incident.suggestion}</p></article>)}
            </div>}
            <div className="patrol-grid acceptance-grid">
              {snapshot.acceptance_requirements.map((item, index) => {
                const kind = acceptanceKinds[index];
                const group = schedulerGroup(kind);
                return <article key={item.label} className={group?.completed === group?.expected ? "active" : ""}>
                  <div><span>{item.label === "Position Monitor" ? "持仓监控" : item.label}</span><time>要求</time></div>
                  <strong>{item.expected}<small>{item.unit}</small></strong>
                  <b className={`patrol-status ${group?.completed ? "good" : "idle"}`}>实际：{group ? `${group.completed} 成功 · ${group.blocked} 阻断 · ${group.missed} 漏跑 · ${group.pending} 待运行` : "—"}</b>
                </article>;
              })}
            </div><p className="source-note">完整通过还要求连续 3 个有效交易日、同链哈希一致且没有阻断故障。</p></details>
          </section>
        </div>}

        {page === "health" && <section className="panel priority-section" id="health">
          <div className="section-heading"><div><p className="section-kicker">05 / 系统健康</p><h2>系统健康与管控中心</h2></div><span className="status-chip" data-status={systemSurfaceStatus}>{ownerSystemStatus}</span></div>
          <section className="startup-recovery-panel" aria-label="开机与恢复">
            <div className="codex-manager-heading"><div><span>开机与恢复</span><strong data-status={startupRecovery?.status ?? "NOT_OBSERVED"}>{!startupRecovery ? "等待首次启动留证" : startupRecovery.start_reason === "SERVICE_RESTART" ? "已布防 · 等待下一次真实开机验收" : startupRecovery.status === "READY" ? "冷启动恢复完成" : startupRecovery.status === "OFFLINE_DEGRADED" ? "核心系统已恢复 · LLM解释层不可用" : startupRecovery.status === "RECOVERING" ? "正在恢复" : "启动受阻"}</strong></div></div>
            <div className="codex-manager-summary">
              <article><span>经理命令回执</span><b>{managerCommand ? `${managerCommand.status} · ${managerCommand.manager_run_id}` : "尚无Owner命令"}</b><small>{managerCommand ? `开始 ${formatPtDateTime(managerCommand.requested_at)}${managerCommand.completed_at ? ` · 结束 ${formatPtDateTime(managerCommand.completed_at)}` : " · 等待确定性检查或模型解释"}${managerCommand.error ? ` · ${managerCommand.error}` : ""}` : "点击后立即返回command_id；刷新后仍保留并追踪同一任务"}</small></article>
              <article><span>Windows开机</span><b>{startupRecovery ? formatPtDateTime(startupRecovery.windows_boot_at) : "尚未记录"}</b><small>{startupRecovery?.start_reason === "WINDOWS_STARTUP" ? "本次为真实Windows冷启动" : "当前仅为服务切换，不冒充冷启动"}</small></article>
              <article><span>4070恢复</span><b>{startupRecovery ? `${(startupRecovery.service_recovery_ms / 1000).toFixed(1)} 秒` : "尚未记录"}</b><small>数据库 {startupRecovery?.database_status ?? "未检查"} · 调度器 {startupRecovery?.scheduler_status ?? "未检查"}</small></article>
              <article><span>Codex经理恢复</span><b>{startupRecovery?.manager_recovery_ms !== null && startupRecovery?.manager_recovery_ms !== undefined ? `${(startupRecovery.manager_recovery_ms / 1000).toFixed(1)} 秒` : startupRecovery?.codex_manager_status === "NOT_REQUIRED" ? "下次真实开机执行" : "等待结果"}</b><small>{startupRecovery?.codex_manager_status ?? "未检查"} · 经理重试 {startupRecovery?.retry_count ?? 0} 次 · 监督器重启 {startupRecovery?.supervisor_restart_attempts ?? 0} 次</small></article>
              <article><span>五分钟目标</span><b>{startupRecovery?.target_met === true ? "达标" : startupRecovery?.target_met === false ? "未达标" : "待真实冷启动"}</b><small>{startupRecovery?.blocker ?? "未发现启动阻断"}</small></article>
              <article><span>下一任务</span><b>{importState.scheduler.next_run ? importState.scheduler.next_run.scheduled_pt.replace(" PT", " 加州时间") : "等待排定"}</b><small>经理槽与A3.2日结/周报共用确定性调度并保持幂等，不由桌面端重复执行</small></article>
              <article><span>是否需要Owner处理</span><b>{startupRecovery?.owner_required ? "需要" : "不需要"}</b><small>{startupRecovery?.next_retry_at ? `下一次自动重试 ${formatPtDateTime(startupRecovery.next_retry_at)}` : "系统会自行恢复或安全降级"}</small></article>
            </div>
            {startupRecovery && <details><summary>查看启动阶段与审计身份</summary><div className="field-tags compact"><code>contract={startupRecovery.contract_version}</code><code>boot={startupRecovery.boot_id}</code><code>reason={startupRecovery.start_reason}</code><code>status={startupRecovery.status}</code><code>supervisor={startupRecovery.supervisor_started_at}</code><code>circuit={startupRecovery.supervisor_circuit_state}</code><code>service={startupRecovery.service_ready_at}</code><code>manager_run={startupRecovery.manager_run_id ?? "null"}</code><code>broker_write_calls=0</code></div></details>}
          </section>
          <section className="codex-manager-panel" aria-label="Codex生产经理">
            <div className="codex-manager-heading"><div><span>生产值守、确定性Manager与LLM解释层</span><strong data-status={managerOnlineStatus}>{managerOnlineStatus === "ONLINE" ? "确定性Manager运行中" : managerOnlineStatus === "OFFLINE" ? "确定性检查已过期或未核验" : "尚无确定性检查证据"}</strong></div><button type="button" onClick={() => void runCodexManager()} disabled={managerRunPending}>{managerRunPending ? "检查进行中" : "立即经理检查"}</button></div>
            <div className="codex-manager-summary">
              <article><span>Codex生产值守</span><b>{startupRecovery?.service_ready_at ? "核心服务运行中" : "等待启动证据"}</b><small>{startupRecovery?.service_ready_at ? `4070恢复 ${formatPtDateTime(startupRecovery.service_ready_at)} · 不依赖LLM预算` : "尚未观察到服务恢复时间"}</small></article>
              <article><span>确定性Manager</span><b>{managerOnlineStatus === "ONLINE" ? "运行中 · 检查已完成" : "当前运行未核验"}</b><small>{codexManager.deterministic_checked_at ? `完整自检 ${formatPtDateTime(codexManager.deterministic_checked_at)} · 180秒有效` : "尚无完整自检收尾记录"} · Incident与自动恢复不依赖LLM预算</small></article>
              <article><span>LLM解释层</span><b>{codexManagerRun?.status === "SKIPPED_BUDGET" ? "SKIPPED_BUDGET · 仅解释跳过" : codexManagerRun?.status ?? "NOT_RUN"}</b><small>{codexManagerRun?.status === "SKIPPED_BUDGET" ? "预算跳过不代表确定性检查停止；运行状态以上方自检时间为准" : codexManagerRun?.error ?? "解释层与核心监督分开投影"}</small></article>
              <article><span>当前经理任务</span><b>{codexManager.current_task ?? "没有正在执行的受控动作"}</b><small>{codexManagerRun?.completed_at ? `最近经理检查 ${formatPtDateTime(codexManagerRun.completed_at)} · ${codexManagerRun.snapshot_level ?? "旧版全量快照"}` : "确定性运行状态以上方自检时间为准"}</small></article>
              <article><span>最近经理结论</span><b>{codexManagerRun?.decision?.manager_conclusion ?? (codexManagerRun?.status === "SKIPPED_BUDGET" ? "本次LLM解释层跳过" : codexManagerRun?.error ? "本次解释或受控动作失败；查看原始错误" : "等待首次检查")}</b><small>{codexManagerRun?.decision ? `${codexManagerRun.decision.findings.length} 项发现 · ${codexManager.active_incidents} 个当前Incident` : "不展示模型私有思考，只保留证据、结论和工具结果"}</small></article>
              <article><span>最近动作与恢复归因</span><b>{latestManagerOperation ? `${latestManagerOperation.action} · ${latestManagerOperation.status}` : "尚无生产动作"}</b><small>{latestRecoveryAttribution ? `${latestRecoveryAttribution.actor}：${latestRecoveryAttribution.action} · ${latestRecoveryAttribution.result}` : "每次恢复都要回答谁做了什么及证据"}</small></article>
              <article><span>TS可信样本准备度</span><b>{tsReadiness.independent_trading_days} / 30个独立交易日</b><small>可信预测 {tsReadiness.trusted_forecasts} · v2结算 {tsReadiness.v2_settlements} · 距稳定60日还差 {tsReadiness.gap_to_60}</small></article>
              <article><span>资源与成本</span><b>{codexManagerRun?.usage ? `${codexManagerRun.usage.input_tokens + codexManagerRun.usage.output_tokens} tokens · ${((codexManagerRun.duration_ms ?? 0) / 1000).toFixed(1)} 秒` : "尚无用量"}</b><small>{codexManagerRun?.usage ? `API目录价等价估算 $${codexManagerRun.usage.estimated_cost_usd.toFixed(4)} · 输入快照 ${codexManagerRun.input_bytes || "旧记录未量化"}${codexManagerRun.input_bytes ? " bytes" : ""}` : "每日与每周调用数及估算成本均有上限"}</small></article>
              <article><span>下一经理检查</span><b>06:20 / 07:05 / 09:35 / 18:20</b><small>另含收盘后55分钟、部署后、异常升级和每周复盘；不进入每分钟行情链</small></article>
            </div>
            {codexManagerRun?.decision?.findings.length ? <div className="codex-manager-findings">{codexManagerRun.decision.findings.slice(0, 5).map((finding) => <article key={finding.code}><b>{finding.priority} · {finding.title}</b><span>{finding.classification}</span><p>{finding.evidence}</p></article>)}</div> : null}
            {codexManagerRun && <details><summary>查看真实调用与受控工具审计</summary><div className="field-tags compact"><code>mode={codexManager.mode}</code><code>run={codexManagerRun.manager_run_id}</code><code>thread={codexManagerRun.thread_id ?? "null"}</code><code>checkpoint={codexManagerRun.checkpoint_id ?? "null"}</code><code>snapshot={codexManagerRun.snapshot_id ?? "null"}</code><code>sha256={codexManagerRun.snapshot_sha256 ?? "null"}</code><code>status={codexManagerRun.status}</code><code>broker_write_tools={codexManager.broker_write_tools}</code><code>broker_write_calls={codexManager.broker_write_calls}</code>{codexManagerRun.tools.map((tool) => <code key={tool}>{tool}</code>)}</div></details>}
          </section>
          <div className="health-control-summary">
            <article><span>当前总状态</span><strong data-status={systemSurfaceStatus}>{ownerSystemStatus}</strong><p>{ownerSystemBlocked ? `${healthOverview.current.length} 个当前严重问题仍影响系统；自动处置不等于需要Owner。` : ownerAttentionRequired ? `${healthOverview.current.length} 个当前事项影响自然槽或需要Owner处理。` : currentTruth.issues.automatic_recovery ? `${healthOverview.current.length} 个对象正在自动复查；Owner无需处理，基础设施与EOD冻结状态在下方分开显示。` : healthOverview.currentSummary}</p></article>
            <article><span>本槽冻结证据</span><strong data-status={healthOverview.evidenceWindows.frozen_slot?.status ?? "NOT_OBSERVED"}>{displayText(healthOverview.evidenceWindows.frozen_slot?.status)}</strong><p>{healthOverview.evidenceWindows.frozen_slot ? `${healthOverview.evidenceWindows.frozen_slot.slot_id} · ${formatPtDateTime(healthOverview.evidenceWindows.frozen_slot.recorded_at)}` : "尚未形成自然 Shadow 槽；不冒充当前实时状态。"}</p></article>
            <article><span>最近成功交付</span><strong>{healthOverview.evidenceWindows.latest_success?.agent_id ?? "尚未观察到"}</strong><p>{healthOverview.evidenceWindows.latest_success ? `${healthOverview.evidenceWindows.latest_success.slot_id} · ${formatPtDateTime(healthOverview.evidenceWindows.latest_success.completed_at)}` : "没有成功证据时保持未观察到。"} · 已恢复历史 {healthOverview.evidenceWindows.history_count} 项</p></article>
            <article><span>是否需要老板处理</span><strong>{healthOwnerRequired ? "需要" : "不需要"}</strong><p>{healthOwnerAction}</p></article>
            <article><span>下一项计划任务</span><strong>{healthOverview.nextScheduledRun ? formatPtDateTime(healthOverview.nextScheduledRun.scheduled_at) : "等待排程更新"}</strong><p>{healthOverview.nextScheduledRun?.label ?? "尚无未来任务时间证据。"} · 自检完成后更新状态，不推算下一次完成时间。</p></article>
          </div>
          {managerReview && <details className="health-history"><summary>查看 Codex 经理本轮逐项检查</summary><div className="health-history-list">{managerReview.checks.map((item) => <article key={item.area}><b>{displayText(item.area)}</b><span data-status={item.status}>{displayText(item.status)}</span><small>{item.summary}</small></article>)}</div></details>}
          <details className="health-domain-details"><summary>展开各运行层状态（{healthOverview.domains.length}）</summary><div className="health-domain-grid" aria-label="当前健康分层">
            {healthOverview.domains.map((domain) => <article key={domain.id} data-tone={domain.tone}>
              <div><span>{domain.name}</span><b>{domain.status}</b></div><p>{domain.summary}</p><small>影响：{domain.impact}</small>
            </article>)}
          </div></details>
          {healthOverview.normalNotes.length > 0 && <aside className="health-normal"><b>正常情况，不算故障</b><ul>{healthOverview.normalNotes.map((note) => <li key={note}>{note}</li>)}</ul></aside>}
          <div className="health-incident-section">
            <h3>当前问题</h3>
            {healthOverview.current.length === 0 ? <p className="health-clear">{healthOverview.currentSummary}</p> : <div className="health-current-list">{healthOverview.current.map((incident) => <article key={incident.incident_id}>
              <div><b>{incident.title}</b><span data-status={incident.severity}>{displayText(incident.severity)} · {displayText(incident.fault_origin)}</span></div>
              <p><strong>发现：</strong>{incident.detected}（{displayText(incident.evidence_scope)}）</p><p><strong>影响：</strong>{incident.affected_modules.join("、")}；{incident.forecast_impact}</p><p><strong>系统已做：</strong>{incident.system_action}</p><p><strong>是否需要人工：</strong>{incident.owner_required ? `需要老板处理：${incident.owner_action}` : incident.codex_required ? "已形成 Codex 维修任务；老板无需操作。" : `不需要，${incident.owner_action}`}</p><small>下一次复查：{incident.next_check_at ? formatPtDateTime(incident.next_check_at) : "等待新的复查时间"}{incident.last_success_at ? ` · 最近成功 ${formatPtDateTime(incident.last_success_at)}` : ""}{incident.run_id ? ` · 运行 ${incident.run_id}` : ""}{incident.codex_repair_task ? " · 维修任务已进入投诉与缺失" : ""}</small>
            </article>)}</div>}
          </div>
          <details className="health-history" id="health-history"><summary>已恢复与历史问题（{healthOverview.history.length}）</summary>
            {healthOverview.history.length ? <div className="health-history-list">{healthOverview.history.map((incident) => <article key={incident.incident_id}><b>{incident.title}</b><span>{displayText(incident.layer)} · 已恢复于 {incident.resolved_at ? formatPtDateTime(incident.resolved_at) : "未记录"}</span><small>发生 {incident.occurrences} 次 · 系统动作：{incident.system_action} · 预测影响：{incident.forecast_impact} · 历史数据：{incident.history_impact}</small></article>)}</div> : <p className="empty-state">尚无已恢复故障。</p>}
          </details>
          <details className="technical-details health-technical"><summary>查看数据源、部门、合同与原始状态</summary><div className="health-grid">
            <article className={healthOverview.selfCheckStatus === "HEALTHY" ? "observed" : "offline"}>
              <div className="health-top"><span className="service-icon">检</span><span className={`service-light ${healthOverview.selfCheckStatus === "HEALTHY" ? "observed" : "idle"}`} /></div>
              <h3>网站自检守卫</h3><p>本地后台 · 数据持久保存</p>
              <div className="health-meta"><span>{importState.selfCheck.checked_at ? formatPtTime(importState.selfCheck.checked_at) : "—"}</span><b data-status={healthOverview.selfCheckStatus}>{healthOverview.selfCheckStatus === "NOT_VERIFIED" ? "检查证据待核验" : displayText(healthOverview.selfCheckStatus)}</b></div>
              <p className="health-expectation">当前问题 {healthOverview.current.length} · 最近备份 {importState.selfCheck.last_backup_at ? formatPtDateTime(importState.selfCheck.last_backup_at) : "尚未成功"}</p>
              <details className="card-details"><summary>最近故障原始记录</summary><p>原始账本状态 {displayText(importState.selfCheck.status)}；包含历史留档，当前问题以上方生命周期判断为准。</p><div className="field-tags compact">{importState.selfCheck.recent.slice(0, 5).map((incident) => <code key={incident.incident_id}>{incident.code} · {incident.status}</code>)}</div></details>
            </article>
            <article className={macroCoverageGood ? "observed" : "offline"}>
              <div className="health-top"><span className="service-icon">宏</span><span className={`service-light ${macroCoverageGood ? "observed" : "idle"}`} /></div>
              <h3>官方宏观日程与结果</h3><p>BLS / Fed / BEA / Census 官方事实 · 影子验证</p>
              <div className="health-meta"><span>{officialMacro?.as_of ? formatPtDateTime(officialMacro.as_of) : "未观察到"}</span><b data-status={macroOwnerStatus}>{displayText(macroOwnerStatus)}</b></div>
              <p className="health-expectation">重点通胀/就业日程 {displayText(officialMacro?.coverage?.inflation)} / {displayText(officialMacro?.coverage?.employment)} · 结果序列 {displayText(officialMacro?.coverage?.released_values)}<br />Fed / 增长事件 {displayText(officialMacro?.coverage?.central_bank)} / {displayText(officialMacro?.coverage?.growth)} · 未来事件 {officialMacro?.events.length ?? 0} 条<br />{officialMacro?.errors.join("；") || "当前没有上报错误"}</p>
              <details className="card-details"><summary>冻结合同与技术字段</summary><div className="field-tags compact"><code>OFFICIAL_MACRO_CONTEXT v1</code><code>context_hash={officialMacro?.context_hash ?? "null"}</code><code>results={officialMacro?.results.length ?? 0}</code></div></details>
            </article>
            <article className={marketEnvironment && !["STALE", "DATA_BLOCKED"].includes(marketEnvironment.status) ? "observed" : "offline"}>
              <div className="health-top"><span className="service-icon">环</span><span className={`service-light ${marketEnvironment && !["STALE", "DATA_BLOCKED"].includes(marketEnvironment.status) ? "observed" : "idle"}`} /></div>
              <h3>市场环境增强数据</h3><p>美国财政部 / EIA / Robinhood 官方只读 · 代理另标</p>
              <div className="health-meta"><span>{marketEnvironment?.as_of ? formatPtDateTime(marketEnvironment.as_of) : "未观察到"}</span><b data-status={marketEnvironment?.status ?? "NOT_OBSERVED"}>{displayText(marketEnvironment?.status)}</b></div>
              <p className="health-expectation">真实收益率 {displayText(officialMarket?.treasury_yields.status)} · WTI {displayText(officialMarket?.wti.status)} · 延长时段 {displayText(marketEnvironment?.extended_hours?.status)} / {displayText(marketEnvironment?.extended_hours?.phase)}<br />固定池官方OHLCV {marketEnvironment?.extended_hours?.coverage?.official_ohlcv ?? "等待新自然槽"}/{marketEnvironment?.extended_hours?.instruments.length ?? approvedUniverse().length} · 本地采样 {marketEnvironment?.extended_hours?.coverage?.local_sampled_quote ?? "—"} · 最近EOD {marketEnvironment?.extended_hours?.coverage?.recent_eod ?? "—"} · 不支持 {marketEnvironment?.extended_hours?.coverage?.not_supported ?? "—"} · 读取失败 {marketEnvironment?.extended_hours?.coverage?.read_failed ?? "—"}<br />板块广度 {displayText(marketEnvironment?.sector_breadth.status)} · 期货 {displayText(marketEnvironment?.futures.status)}</p>
              <details className="card-details"><summary>能力与口径</summary><div className="field-tags compact"><code>extended=ROBINHOOD_OFFICIAL_24_5_OHLCV</code><code>overnight_confidence=LOW</code><code>can_override_regime=false</code><code>can_generate_option_order=false</code><code>yields=US_TREASURY_EOD</code><code>wti=EIA_SPOT_EOD</code><code>rates_proxy=TLT,SHY</code><code>oil_proxy=USO</code><code>breadth=11 sector ETFs</code><code>futures=NOT_SUPPORTED</code></div></details>
            </article>
            {importState.dataSources.filter((source) => source.source === "ROBINHOOD" || source.source === "FINNHUB").map((source) => {
              const age = sourceAge(source.as_of);
              const healthy = ["LIVE", "MARKET_CLOSED"].includes(source.status) && source.authorization === "VALID";
              return <article key={`source-${source.source}`} className={healthy ? "observed" : "offline"}>
                <div className="health-top"><span className="service-icon">{source.source.charAt(0)}</span><span className={`service-light ${healthy ? "observed" : "idle"}`} /></div>
                <h3>{source.source === "ROBINHOOD" ? "Robinhood 行情" : "Finnhub 新闻与财报"}</h3><p>{source.source === "ROBINHOOD" ? "官方只读接口 · 影子验证" : "官方接口 · 新闻 / 财报日历 / 公布结果"}</p>
                <div className="health-meta"><span>{sourceStatusText[source.status] ?? source.status}</span><b data-status={source.status}>{authorizationText[source.authorization] ?? source.authorization}</b></div>
                <p className="health-expectation">是否配置：{source.configured ? "是" : "否"}<br />最后成功：{source.last_success_at ? formatPtDateTime(source.last_success_at) : "尚未成功"}<br />数据截至：{source.as_of ? formatPtDateTime(source.as_of) : "未观察到"} · {source.status === "MARKET_CLOSED" ? "收盘后保留，不按盘中阈值报过期" : `新鲜度 ${age ?? "—"} 秒`}{source.error ? <><br />错误：{source.error.replace("官方 MCP smoke", "官方只读连通验证").replace("API Key", "访问密钥")}</> : null}</p>
                <details className="card-details"><summary>能力与技术字段</summary><div className="field-tags compact">{Object.entries(source.capabilities).map(([name, enabled]) => <code key={name}>{name}={String(enabled)}</code>)}<code>status={source.status}</code><code>authorization={source.authorization}</code><code>as_of={source.as_of ?? "null"}</code><code>checked_at={source.checked_at}</code></div></details>
              </article>;
            })}
            {healthServices.map((service) => {
              const state = healthState(service.contract);
              return (
                <article key={service.name} className={state ? "observed" : "offline"}>
                  <div className="health-top"><span className="service-icon">{service.name.charAt(0)}</span><span className={`service-light ${state ? "observed" : "idle"}`} /></div>
                  <h3>{service.name === "Delivery" ? "送达核对" : service.name === "Acceptance" ? "验收规则" : service.name === "Codex Guard" ? "Codex 系统守卫" : service.name === "A2 旧 Shadow" ? "A2 旧影子验证" : service.name}</h3><p>{service.name === "TS 正式预测" ? "检查 TS 槽位与结算是否齐全" : service.name === "A2 旧 Shadow" ? "旧半小时影子验证固定停用" : service.name === "Delivery" ? "核对结果与回执是否完整" : service.name === "Acceptance" ? "核对连续交易日证据" : "检查本地守卫结果"}</p>
                  <div className="health-meta"><span>{displayText(service.schema_state)}</span><b data-status={state ?? "NOT_OBSERVED"}>{displayText(state)}</b></div>
                  <details className="card-details"><summary>合同与技术字段</summary><p>{service.contract} · {service.expected}</p><div className="field-tags compact">{service.fields.map((field) => <code key={field}>{field}</code>)}</div></details>
                </article>
              );
            })}
            {importState.runLedger.agents.map((agent) => {
              const run = latestRun(agent.agent_id);
              const healthy = run?.status === "SUCCEEDED" && run.website_delivery !== "FAILED" && run.discord_delivery !== "FAILED";
              return (
                <article key={`run-${agent.agent_id}`} className={healthy ? "observed" : "offline"}>
                  <div className="health-top"><span className="service-icon">{agent.name.charAt(0)}</span><span className={`service-light ${healthy ? "observed" : "idle"}`} /></div>
                  <h3>{agent.name === "Committee" ? "独立评审组" : agent.name === "Codex Guard" ? "Codex 系统守卫" : agent.name}</h3><p>{displayText(agent.kind)}</p>
                  <div className="health-meta"><span>{displayText(run?.channel ?? "REGISTRY")}</span><b data-status={run?.status ?? "NOT_RUN"}>{displayText(run?.status ?? "NOT_RUN")}</b></div>
                  <p className="health-expectation">{run ? deliverySummary(run) : agent.responsibility.replace("API", "官方接口").replaceAll("Agent", "部门").replace("Committee", "独立评审组").replace("PT", "加州时间")}</p>
                  <details className="card-details"><summary>调用能力与槽位</summary><div className="field-tags compact"><code>{run?.skill_id ?? agent.agent_id}</code><code>{run?.slot_id ?? "NOT_OBSERVED"}</code></div></details>
                </article>
              );
            })}
          </div></details>
          <p className="source-note">合同卡显示冻结输出；部门卡只显示已上报的本地运行事件。没有事件时明确显示“尚未运行”，不读取进程、计划任务或正式系统目录。</p>
        </section>}

        {page === "health" && <details className="page-utility-details health-counts"><summary>查看数据归档与合同计数</summary><section className="metric-strip" aria-label="数据摘要">
          <article><span>V2 来源文件</span><strong>{snapshot.sources.length}</strong><small>合同 · 测试 · 文档</small></article>
          <article><span>TS 正式槽位</span><strong>{snapshot.formal_forecast_slots.length}</strong><small>验收要求，不是运行结果</small></article>
          <article><span>TS 数据快照输出</span><strong className={tsOutputs ? "good-text" : "warn-text"}>{tsOutputs ? tsOutputs.length : "未上报"}</strong><small>{tsOutputs ? "冻结合同对象" : "正式上游没有生成"}</small></article>
          <article><span>本地原文归档</span><strong>{importState.archiveCount + importState.outputCount + importState.runLedger.eventCount}</strong><small>{importState.archiveCount} 份数据快照 · {importState.outputCount} 条输出 · {importState.runLedger.eventCount} 次运行</small></article>
        </section></details>}

        {page === "settlements" && <div className="two-column chart-row settlements-stack">
          <details className="settlement-comparison-details" id="comparison"><summary>展开正式结果与影子验证旧合同对比</summary><section className="panel priority-section">
            <div className="section-heading"><div><p className="section-kicker">06 / 正式与影子验证</p><h2>正式结果与影子验证</h2></div><span className="status-chip warn">{importState.outputCount ? "本地合同输出" : importState.payload ? "冻结数据快照" : "不可做绩效对比"}</span></div>
            <div className="compare-head"><span>对比项目</span><span>正式 TS</span><span>4070 影子验证 / 旧 A2</span></div>
            {comparisonRows.map((row) => <div className="compare-row" key={row.field}><span>{row.field}</span><b>{row.formal}</b><b>{row.shadow}</b></div>)}
            <div className="divergence"><span>隔离边界</span><p>4070 结果始终归入影子验证；正式栏只读取正式 TS 输出。旧 A2 半小时影子验证仍固定不可操作。</p><details><summary>查看合同原值</summary><code>SHADOW</code> / <code>PRODUCTION</code> / <code>TS_OUTPUT</code></details></div>
            <p className="source-note">准确率只统计功能上线后、经本地 Gateway 交付并由 Robinhood 真实 K 线结算的自然 LIVE 预测；回放、样本、未上报和数据阻断均保留原因但不进入分母。</p>
          </section></details>
        </div>}

        {page === "issues" && <div className="two-column bottom-row issues-layout">
          <section className="panel" id="complaints">
            <div className="section-heading"><div><p className="section-kicker">07 / 本地反馈</p><h2>老板投诉箱</h2></div><span className="muted-chip">本地数据库持久保存</span></div>
            <ComplaintBox incidentLifecycle={currentTruth.issues.lifecycle} />
          </section>

          <section className="panel" id="capability-audit">
            <div className="section-heading"><div><p className="section-kicker">08 / 只读能力审计</p><h2>旧能力保留状态</h2></div><span className="muted-chip">V2 · 当前冻结链 · 自然记录</span></div>
            <p className="source-note">“System A / System B / 观察池 / 发现池”不是 pinned V2 的统一正式部门名；下列状态只按实际代码、合同和自然交付证据归类，不按旧频道名称补造职责。</p>
            <div className="capability-summary" aria-label="能力保留统计">
              {Object.entries(capabilityStatusText).map(([status, label]) => <article key={status}><strong>{capabilityAudit.filter((item) => item.status === status).length}</strong><span>{label}</span></article>)}
            </div>
            <details className="capability-audit-details"><summary>展开全部历史能力与实现依据</summary><div className="capability-list">
              {capabilityAudit.map((item) => <article key={item.name} data-retention={item.status}>
                <div><span>{item.name}</span><b>{capabilityStatusText[item.status]}</b></div>
                <p>{item.owner_summary}</p><small>{item.current_evidence}</small>
                <details><summary>查看实现依据</summary><code>{item.source_files.join(" · ")}</code><p>对老板判断影响：{item.impact === "HIGH" ? "高" : item.impact === "MEDIUM" ? "中" : "低"}</p></details>
              </article>)}
            </div></details>
          </section>

          <section className="panel" id="codex">
            <div className="section-heading"><div><p className="section-kicker">08 / 缺失证据</p><h2>上线前剩余证据与已知边界</h2></div><span className="status-chip warn">{launchGaps.length} 项</span></div>
            {launchGaps.length ? <ol className="missing-list">
              {launchGaps.map((item, index) => <li key={item.technical}><span>{String(index + 1).padStart(2, "0")}</span><div><p>{item.owner}</p><details><summary>查看技术依据</summary><code>{item.technical}</code></details></div></li>)}
            </ol> : <p className="health-clear">当前没有未完成的上线证据或已知能力边界。</p>}
          </section>
        </div>}

        <footer><span>TRADING OS</span><span>Shadow · 只读观察 · 不自动下单</span></footer>
      </main>
    </div>
  );
}
