import type { SnapshotState, TsOutput } from "./snapshot-import.ts";
import { exchangeDateKey, isNyseRegularSession, latestCompletedNyseSession, MARKET_5M_MAX_AGE_SECONDS, ptDateKey } from "./market-time.ts";
import { activeScheduleFaults } from "./health-overview.ts";
import { buildCurrentTruth } from "./current-truth.ts";
import { approvedPoolCoverage } from "./capability-retention.ts";

export type ManagerReviewType = "PREMARKET" | "EARLY" | "INTRADAY" | "POST_CLOSE" | "DAILY_CLOSE" | "POST_DEPLOY";
export type ManagerCheckStatus = "PASS" | "EXPECTED" | "WARNING" | "BLOCKED" | "NOT_OBSERVED";
export type ManagerIssue = { code: string; severity: "WARNING" | "CRITICAL"; title: string; owner_action: string };
export type ManagerReview = {
  contract_version: "v1";
  role: "CODEX_MANAGER";
  review_type: ManagerReviewType;
  checked_at: string;
  status: "HEALTHY" | "DEGRADED" | "BLOCKED";
  headline: string;
  company_working: boolean;
  checks: Array<{ area: "DATA" | "SCHEDULE" | "AGENTS" | "ALIGNMENT" | "WEBSITE" | "WORK_QUEUE" | "PLATFORM" | "PREDICTION"; status: ManagerCheckStatus; summary: string }>;
  prediction_review: { status: "NOT_DUE" | "CONFIRMED" | "PARTIAL" | "INVALIDATED" | "NOT_OBSERVED"; summary: string };
  actions_taken: string[];
  owner_todos: string[];
  issues: ManagerIssue[];
  tomorrow: "SAFE_TO_CONTINUE" | "CONTINUE_WITH_CAUTION" | "OWNER_ACTION_REQUIRED";
  next_check_at: string | null;
};

function check(area: ManagerReview["checks"][number]["area"], status: ManagerCheckStatus, summary: string) { return { area, status, summary }; }
function text(value: unknown) { return typeof value === "string" ? value : null; }

function predictionReview(state: SnapshotState, at: Date, reviewType: ManagerReviewType): ManagerReview["prediction_review"] {
  if (!["POST_CLOSE", "DAILY_CLOSE"].includes(reviewType)) return { status: "NOT_DUE", summary: "本轮不是收盘复盘；当天预测由收盘结算单独评价。" };
  const marketDate = ptDateKey(at);
  const optionSettlements = state.optionLifecycle.recent_settlements.filter((item) => item.market_date === marketDate);
  const optionSummary = optionSettlements.length
    ? `策略 / 持仓建议已结算 ${optionSettlements.length} 项：${optionSettlements.map((item) => `${item.symbol ?? "SPY/QQQ"} ${item.action}→${item.outcome}`).join("；")}；其中可评分 ${optionSettlements.filter((item) => item.scoreable).length} 项，NO TRADE 不进入准确率。`
    : "策略 / 持仓：功能启用后尚无当天自然 LIVE 建议与完整 K 线可结算。";
  const reviewed = (summary: string) => `${summary} ${optionSummary}`;
  const settled = state.tsSettlement.recent
    .filter((item) => item.market_date === marketDate && item.eligibility === "OFFICIAL_LIVE" && item.settlement && item.report_type !== "NEXT_SESSION")
    .toSorted((left, right) => Date.parse(left.published_at) - Date.parse(right.published_at));
  if (settled.length) {
    const directionTotal = settled.reduce((total, item) => total + Object.keys(item.settlement!.symbols).length, 0);
    const directionCorrect = settled.reduce((total, item) => total + Object.values(item.settlement!.symbols).filter((symbol) => symbol.direction_correct).length, 0);
    const phases = settled.map((item) => `${item.phase === "INITIAL" ? "初始判断" : item.phase === "FINAL" ? "最终判断" : "盘中修正"}${item.slot}：${item.settlement!.status === "RESOLVED" ? "已结算" : "部分结算"}`).join("；");
    return {
      status: directionCorrect === directionTotal && settled.every((item) => item.settlement!.status === "RESOLVED") ? "CONFIRMED" : directionCorrect ? "PARTIAL" : "INVALIDATED",
      summary: reviewed(`不可变预测账本已结算 ${settled.length} 份（方向 ${directionCorrect}/${directionTotal}）：${phases}。样本 ${settled.length}，不把回放或受阻记录计入准确率。`),
    };
  }
  const forecasts = state.outputs.TS_SHADOW_OUTPUT.filter((item) => item.evidence_snapshot.market_time.market_date === marketDate && item.report_type !== "NEXT_SESSION");
  const forecast = forecasts.toSorted((left, right) => Date.parse(left.evidence_snapshot.market_time.observed_at) - Date.parse(right.evidence_snapshot.market_time.observed_at))[0];
  if (!isNyseRegularSession(marketDate) && !forecast) return { status: "NOT_DUE", summary: "今天休市，没有应形成的盘中预测或收盘评分；已计划观察的运行结果单独检查，历史失败不冲销。" };
  const a1 = state.outputs.A1_SHADOW_RESULT;
  const quotes = a1?.market_sources?.quotes.filter((item) => item.source === "ROBINHOOD") ?? [];
  if (!forecast || quotes.length < 2) return { status: "NOT_OBSERVED", summary: reviewed("缺少当天盘中 TS 或收盘行情，不能编造预测对错。") };
  const actual = (symbol: "SPY" | "QQQ") => {
    const quote = quotes.find((item) => item.symbol === symbol);
    if (quote?.last === null || quote?.last === undefined || quote.previous_close === null || quote.previous_close === undefined || quote.previous_close === 0) return null;
    const change = (quote.last - quote.previous_close) / quote.previous_close * 100;
    return { change, direction: Math.abs(change) <= 0.25 ? "RANGE" : change > 0 ? "BULLISH" : "BEARISH" };
  };
  const scores = (["SPY", "QQQ"] as const).map((symbol) => ({ symbol, expected: forecast.symbol_outlooks[symbol].direction, actual: actual(symbol) })).filter((item) => item.actual);
  if (scores.length < 2) return { status: "NOT_OBSERVED", summary: reviewed("收盘价或前收不完整，不能判断方向。") };
  const correct = scores.filter((item) => item.expected === item.actual!.direction).length;
  const details = scores.map((item) => `${item.symbol} 预测${item.expected}、实际${item.actual!.direction}（${item.actual!.change >= 0 ? "+" : ""}${item.actual!.change.toFixed(2)}%）`).join("；");
  const adjustment = forecast.forecast_update.change_summary ? `；最后调整：${forecast.forecast_update.change_summary}` : "";
  const levelLimit = "；SQLite 当前没有可复核的全天高低路径，支撑、阻力和失效位不冒充已验收";
  if (correct === 2) return { status: "PARTIAL", summary: reviewed(`收盘方向两项均吻合：${details}${adjustment}${levelLimit}`) };
  if (correct === 1) return { status: "PARTIAL", summary: reviewed(`收盘方向一项吻合、一项偏差：${details}${adjustment}${levelLimit}`) };
  return { status: "INVALIDATED", summary: reviewed(`收盘方向两项均未吻合：${details}${adjustment}${levelLimit}`) };
}

function alignmentSummary(ts: TsOutput | undefined, committee: Record<string, unknown> | null, d: Record<string, unknown> | null, review: Record<string, unknown> | null, a3: Record<string, unknown> | null) {
  if (!ts || !committee || !d || !review || !a3) return { status: "NOT_OBSERVED" as const, summary: "TS、Committee、D 或 A3 结果不完整。", conflict: true };
  const direction = text(committee.direction)?.toUpperCase();
  const directionalConflict = (ts.path_bias === "BULLISH" && direction === "BEARISH") || (ts.path_bias === "BEARISH" && direction === "BULLISH");
  const unresolved = review.conflict_detected === true && review.review_required === true;
  const decisionMismatch = text(d.action) !== text(a3.decision);
  const conflict = directionalConflict || unresolved || decisionMismatch;
  return conflict
    ? { status: "WARNING" as const, summary: `存在待解释差异：TS ${ts.path_bias}、Committee ${direction ?? "未观察到"}、D ${text(d.action) ?? "未观察到"}、A3 ${text(a3.decision) ?? "未观察到"}。`, conflict: true }
    : { status: "PASS" as const, summary: `TS ${ts.path_bias}、Committee ${direction ?? "未观察到"}、D ${text(d.action)}、A3 ${text(a3.decision)} 已由 A3 完成一致性复核。`, conflict: false };
}

export function buildCodexManagerReview(state: SnapshotState, at = new Date(), reviewType: ManagerReviewType, actionsTaken: string[] = []): ManagerReview {
  const now = at.getTime(), date = ptDateKey(at), tradingDay = isNyseRegularSession(date);
  const truth = buildCurrentTruth(state, at);
  const checks: ManagerReview["checks"] = [], issues: ManagerIssue[] = [], ownerTodos: string[] = [];
  const robinhood = state.dataSources.find((item) => item.source === "ROBINHOOD");
  const finnhub = state.dataSources.find((item) => item.source === "FINNHUB");
  const macro = state.outputs.A1_SHADOW_RESULT?.official_macro;
  const environment = state.outputs.A1_SHADOW_RESULT?.market_sources?.market_environment;
  const pattern = state.outputs.A2_SHADOW_RESULT?.pattern_evidence;
  const risk = state.outputs.OPTION_STRATEGY_SIGNAL?.find((item) => item.source_mode === "LIVE")?.risk_summary;
  const expectsLive = ["EARLY", "INTRADAY"].includes(reviewType);
  const validEod = Boolean(robinhood?.status === "MARKET_CLOSED" && robinhood.as_of && exchangeDateKey(robinhood.as_of) === latestCompletedNyseSession(at));
  const marketAge = robinhood?.as_of ? now - Date.parse(robinhood.as_of) : NaN;
  const freshMarket = marketAge >= 0 && marketAge <= MARKET_5M_MAX_AGE_SECONDS * 1_000;
  const expectedQuoteLimit = !expectsLive && truth.market_session === "OVERNIGHT" && freshMarket && truth.market_data_health.classification === "EXPECTED_PROVIDER_SESSION_LIMIT";
  const marketGood = robinhood?.authorization === "VALID" && (expectsLive ? robinhood.status === "LIVE" && freshMarket : robinhood.status === "LIVE" && freshMarket || validEod || expectedQuoteLimit);
  const newsGood = finnhub?.authorization === "VALID" && finnhub.status === "LIVE";
  const dataGood = marketGood;
  const macroGood = macro?.coverage && Object.values(macro.coverage).every((status) => status === "LIVE");
  const officialMarketGood = macro?.market_context?.status === "LIVE";
  const extended = environment?.extended_hours, extendedCore = extended?.instruments.filter((item) => item.symbol === "SPY" || item.symbol === "QQQ") ?? [];
  const extendedGood = !["PREMARKET", "EARLY"].includes(reviewType) || extended?.status === "OBSERVED" && extendedCore.every((item) => item.capability === "OFFICIAL_OHLCV" || item.capability === "RECENT_EOD" || item.capability === undefined && item.status === "OBSERVED");
  const environmentGood = environment && officialMarketGood && extendedGood && ![environment.rates.status, environment.oil.status, environment.sector_breadth.status].some((status) => ["STALE", "DATA_BLOCKED"].includes(status));
  const patternGood = pattern?.source_mode === "LIVE" && pattern.status === "HEALTHY";
  checks.push(check("DATA", !dataGood ? "BLOCKED" : newsGood && macroGood && environmentGood && patternGood ? "PASS" : "WARNING", !dataGood ? `核心行情不可用：Robinhood ${robinhood?.status ?? "NOT_CONFIGURED"}（授权 ${robinhood?.authorization ?? "NOT_CONFIGURED"}）。Finnhub ${finnhub?.status ?? "NOT_CONFIGURED"} 属于增强事件证据，单独降级。` : newsGood && macroGood && environmentGood && patternGood ? `核心行情 Robinhood ${robinhood?.status}；增强新闻 Finnhub ${finnhub?.status}；重点宏观覆盖、真实收益率、WTI、板块广度和自然多槽盘型证据可用；期货明确不支持。` : `核心行情 Robinhood ${robinhood?.status} 可用；增强新闻 Finnhub ${finnhub?.status}。新闻与财报 ${newsGood ? "正常" : "部分降级"}；宏观覆盖 ${macroGood ? "完整" : "降级"}；官方市场环境 ${macro?.market_context?.status ?? "NOT_OBSERVED"}；盘型证据 ${pattern?.data_grade ?? "NOT_OBSERVED"}/${pattern?.status ?? "NOT_OBSERVED"}，只降低证据成熟度，不把整条 Agent 链误判为停止。`));
  if (!dataGood) issues.push({ code: "MANAGER_DATA_NOT_READY", severity: "CRITICAL", title: "Codex 经理发现核心行情不可用", owner_action: "检查 Robinhood 官方只读授权和行情截至时间。" });
  else if (!newsGood) issues.push({ code: "MANAGER_NEWS_DEGRADED", severity: "WARNING", title: "Codex 经理发现新闻或财报能力部分降级", owner_action: "系统继续自动复查；缺失新闻不得被 TS、Committee、D、A3 当作已观察证据。" });
  if (dataGood && !macroGood) issues.push({ code: "MANAGER_MACRO_DEGRADED", severity: "WARNING", title: "Codex 经理发现官方宏观证据不完整", owner_action: "查看 BLS/FRED、Fed、BEA 与 Census 分项状态；缺失日程或结果不得被 TS、Committee、D、A3 当作已观察证据。" });
  if (dataGood && !environmentGood) issues.push({ code: "MANAGER_MARKET_ENVIRONMENT_DEGRADED", severity: "WARNING", title: "Codex 经理发现市场环境增强证据不完整", owner_action: "检查财政部真实收益率、EIA WTI、Robinhood 官方 24_5 时段数据与 ETF 板块广度；期货继续保持 NOT_SUPPORTED。" });
  if (dataGood && !patternGood) issues.push({ code: "MANAGER_PATTERN_EVIDENCE_ACCUMULATING", severity: "WARNING", title: "Codex 经理发现自然多槽盘型证据仍在积累", owner_action: "继续自然 LIVE 槽；回放只能验证工程，不能升级自然盘型证据。" });

  checks.push(check("DATA", !risk ? "EXPECTED" : risk.core_hard_block_count ? "BLOCKED" : "PASS", !risk ? "等待同槽盘型与分层风控证据。" : risk.core_hard_block_count ? `存在 ${risk.core_hard_block_count} 项核心硬阻断。` : `盘型 ${risk.market_type}；新开仓阻断 ${risk.new_entry_block_count} 项、单一持仓阻断 ${risk.position_management_block_count} 项、软降级 ${risk.soft_degrade_count} 项，均未误伤无关分析。`));
  if (risk?.core_hard_block_count) issues.push({ code: "MANAGER_CORE_RISK_BLOCK", severity: "CRITICAL", title: "Codex 经理发现核心硬阻断", owner_action: "按同槽风险证据检查核心行情与 A2 冻结快照；不得用其他标的或历史结果替代。" });

  const approved = state.outputs.A1_SHADOW_RESULT?.market_sources?.approved_capabilities ?? state.marketRadar.snapshot;
  const fixedPool = approved?.fixed_pool, fixedCoverage = approvedPoolCoverage(approved);
  const managedSwings = fixedPool?.rows.flatMap((row) => row.swing?.management ? [row.swing.management] : []) ?? [];
  const activeSwings = managedSwings.filter((item) => item.archive_status === "ACTIVE"), settledSwings = managedSwings.filter((item) => item.state === "SETTLED");
  checks.push(check("DATA", !fixedPool ? "EXPECTED" : !fixedCoverage.complete ? "WARNING" : managedSwings.length ? "PASS" : "EXPECTED", !fixedPool ? `等待观察池${fixedCoverage.size}首次官方只读归档。` : !fixedCoverage.complete ? `观察池当前仅 ${fixedPool.observed_count}/${fixedCoverage.size} 有完整四周期；缺失 ${fixedPool.missing_symbols.join("、") || "覆盖计数不一致"}。` : managedSwings.length ? `观察池${fixedCoverage.size}持续波段管理已进入同一冻结链：活跃 ${activeSwings.length} 项、已结算归档 ${settledSwings.length} 项；日线/4小时决定核心逻辑。` : `观察池已有 ${fixedPool.observed_count}/${fixedCoverage.size} 四周期结构；等待下一自然槽建立持续生命周期，不回填历史。`));
  if (fixedPool && !fixedCoverage.complete) issues.push({ code: "MANAGER_FIXED70_COVERAGE_DEGRADED", severity: "WARNING", title: "Codex 经理发现观察池多周期覆盖不足", owner_action: "系统将在下一自然槽复查官方只读历史；单项缺失不阻断SPY/QQQ核心TS链。" });

  const currentScheduleFaults = activeScheduleFaults(state, now);
  checks.push(check("SCHEDULE", currentScheduleFaults.length ? "BLOCKED" : "PASS", currentScheduleFaults.length ? `最近 90 分钟有 ${currentScheduleFaults.length} 个漏跑、失败或阻断槽。` : "当前健康窗口没有新的漏跑、失败或阻断。"));
  if (currentScheduleFaults.length) issues.push({ code: "MANAGER_SCHEDULE_FAULT", severity: "CRITICAL", title: "Codex 经理发现自然槽未正常完成", owner_action: "查看公司时间线；错过的自然结果不得补造。" });

  const shadowRuns = state.runLedger.runs.filter((run) => run.channel === "SHADOW" && run.slot_id.startsWith("live-shadow:"));
  const authoritativeSlot = state.currentTruth?.natural_slot ?? truth.natural_slot;
  const authoritativeAt = authoritativeSlot.frozen_at ?? authoritativeSlot.terminal_at ?? state.currentTruth?.current_time;
  const latestSlot = authoritativeSlot.slot_id && authoritativeAt && ptDateKey(authoritativeAt) === date ? authoritativeSlot.slot_id : shadowRuns.filter((run) => ptDateKey(run.event_at) === date).toSorted((a, b) => Date.parse(b.event_at) - Date.parse(a.event_at))[0]?.slot_id ?? null;
  const slotRuns = latestSlot ? shadowRuns.filter((run) => run.slot_id === latestSlot) : [];
  const requiredDepartments = authoritativeSlot.slot_id === latestSlot ? authoritativeSlot.required_departments : truth.natural_slot.required_departments;
  const requiredRuns = slotRuns.filter((run) => requiredDepartments.includes(run.agent_id as typeof requiredDepartments[number]));
  const missing = requiredDepartments.filter((agent) => !requiredRuns.some((run) => run.agent_id === agent));
  const failed = requiredRuns.filter((run) => ["FAILED", "TIMED_OUT"].includes(run.status) || run.website_delivery === "FAILED");
  const upstreamBlocked = requiredRuns.filter((run) => run.status === "DATA_BLOCKED");
  const agentsExpected = !tradingDay || reviewType === "PREMARKET" || reviewType === "POST_DEPLOY";
  const agentsOk = !missing.length && !failed.length && !upstreamBlocked.length && requiredRuns.every((run) => run.status === "SUCCEEDED" && run.output_status === "PRODUCED" && run.website_delivery === "DELIVERED");
  checks.push(check("AGENTS", agentsOk ? "PASS" : agentsExpected && !latestSlot ? "EXPECTED" : "BLOCKED", agentsOk ? `最近槽 ${latestSlot} 的必需部门 ${requiredDepartments.join("→")} 均已留证并交付。` : agentsExpected && !latestSlot ? "当天尚无已运行的自然观察槽；休市不要求盘中部门履职，已计划槽仍由计划账本检查。" : `最近槽缺席：${missing.join("、") || "无"}；Agent 自身失败或交付异常：${failed.map((run) => run.agent_id).join("、") || "无"}；被上游阻断：${upstreamBlocked.map((run) => run.agent_id).join("、") || "无"}。`));
  if (failed.length || missing.length && !(agentsExpected && !latestSlot)) issues.push({ code: "MANAGER_AGENT_CHAIN_INCOMPLETE", severity: "CRITICAL", title: "Codex 经理发现部门自身失败、缺席或网站交付不完整", owner_action: "检查对应 run_id 的 Agent 错误与交付证据；不得把缺席冒充成功。" });
  if (upstreamBlocked.length) issues.push({ code: "MANAGER_AGENT_UPSTREAM_BLOCKED", severity: "CRITICAL", title: "Codex 经理发现部门已运行但被上游阻断", owner_action: "沿同一 run_id 检查上游数据或部门证据；不要误报为 Agent 自身故障。" });

  const ts = state.outputs.TS_SHADOW_OUTPUT[0];
  const alignment = latestSlot && requiredDepartments.includes("COMMITTEE") ? alignmentSummary(ts, state.outputs.COMMITTEE_SHADOW_OUTPUT, state.outputs.D_SHADOW_OUTPUT, state.outputs.A3_REVIEW_SHADOW, state.outputs.A3_FINAL_SHADOW) : { status: "EXPECTED" as const, summary: "本槽合同不要求Committee/D/A3联合复核；不把未分配部门算作缺席。", conflict: false };
  checks.push(check("ALIGNMENT", alignment.status, alignment.summary));
  if (alignment.conflict && alignment.status === "WARNING") issues.push({ code: "MANAGER_DECISION_CONFLICT", severity: "WARNING", title: "Codex 经理发现部门结论仍有冲突", owner_action: "由 A3 保留冲突和反证；未解决前维持 WAIT 或 NO_TRADE。" });

  const latestDeliveryFailed = requiredRuns.some((run) => run.output_status === "PRODUCED" && run.website_delivery !== "DELIVERED");
  const tsRun = slotRuns.find((run) => run.agent_id === "TS" && run.status === "SUCCEEDED");
  const projectionMissing = Boolean(tsRun && !state.outputs.TS_SHADOW_OUTPUT.length);
  const websiteMismatch = latestDeliveryFailed || projectionMissing;
  checks.push(check("WEBSITE", websiteMismatch ? "BLOCKED" : "PASS", websiteMismatch ? "部门已产出，但老板网站没有显示同一运行结果。" : "老板网站投影与同一 SQLite、Run Ledger 和 Output Gateway 的运行证据一致。"));
  if (websiteMismatch) issues.push({ code: "MANAGER_WEBSITE_MISMATCH", severity: "CRITICAL", title: "Codex 经理发现网站显示与真实交付不一致", owner_action: "只重放同一原始 Shadow 输出，不重新生成结果。" });

  const currentIncidents = truth.issues.lifecycle.filter((item) => item.status === "ACTIVE_BLOCKING" || item.status === "ACTIVE_DEGRADED");
  const activeIncidents = state.selfCheck.active.filter((item) => currentIncidents.some((root) => root.incident_id === item.incident_id));
  const ownerRequired = currentIncidents.filter((item) => item.owner_required);
  const queueStatus = ownerRequired.length || state.ownerQueue.pending_approval ? "BLOCKED" : currentIncidents.length ? "WARNING" : "PASS";
  checks.push(check("WORK_QUEUE", queueStatus, `${truth.issues.current_unresolved} 个当前故障，投诉台账未关闭 ${truth.owner_queue.current_open_complaints} 个，${state.ownerQueue.pending_approval} 个待老板批准。`));
  if (ownerRequired.length) ownerTodos.push(...ownerRequired.map((root) => activeIncidents.find((item) => item.incident_id === root.incident_id)?.title ?? root.root_cause_id));
  if (state.ownerQueue.pending_approval) ownerTodos.push(`${state.ownerQueue.pending_approval} 项等待老板批准`);

  const selfCheckFresh = state.selfCheck.checked_at !== null && now - Date.parse(state.selfCheck.checked_at) <= 180_000;
  const platformOk = selfCheckFresh && Boolean(state.selfCheck.last_backup_at) && !activeIncidents.some((item) => ["DATABASE", "MAINTENANCE", "SERVICE"].includes(item.layer));
  checks.push(check("PLATFORM", platformOk ? "PASS" : "BLOCKED", platformOk ? "网站、数据库、备份、部署和维护心跳处于同一健康语义。" : "自检、备份、部署版本或数据库状态尚未全部通过。"));
  if (!platformOk) issues.push({ code: "MANAGER_PLATFORM_NOT_READY", severity: "CRITICAL", title: "Codex 经理发现部署、数据库或维护状态不一致", owner_action: "查看系统健康的自动维护、SQLite 和版本检查。" });

  const prediction = predictionReview(state, at, reviewType);
  checks.push(check("PREDICTION", prediction.status === "CONFIRMED" ? "PASS" : prediction.status === "INVALIDATED" ? "WARNING" : prediction.status === "NOT_OBSERVED" ? "NOT_OBSERVED" : "EXPECTED", prediction.summary));
  const blocked = checks.some((item) => item.status === "BLOCKED"), warning = checks.some((item) => ["WARNING", "NOT_OBSERVED"].includes(item.status));
  const status = blocked ? "BLOCKED" : warning ? "DEGRADED" : "HEALTHY";
  const tomorrow = ownerTodos.length ? "OWNER_ACTION_REQUIRED" : blocked || warning ? "CONTINUE_WITH_CAUTION" : "SAFE_TO_CONTINUE";
  const headline = reviewType === "DAILY_CLOSE"
    ? `${status === "HEALTHY" ? "今天公司正常收工" : status === "DEGRADED" ? "今天已收工，但有事项要继续观察" : "今天没有完整收工"}。${prediction.summary}`
    : status === "HEALTHY" ? "公司本轮检查正常，可以继续 Shadow。" : status === "DEGRADED" ? "公司可以继续 Shadow，但有证据或结论需要观察。" : "公司本轮检查未通过，不能把结果当作完整成功。";
  return { contract_version: "v1", role: "CODEX_MANAGER", review_type: reviewType, checked_at: at.toISOString(), status, headline, company_working: !blocked, checks, prediction_review: prediction, actions_taken: actionsTaken, owner_todos: [...new Set(ownerTodos)], issues, tomorrow, next_check_at: state.scheduler.next_run?.scheduled_at ?? null };
}
