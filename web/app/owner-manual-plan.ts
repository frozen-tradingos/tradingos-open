import type { SnapshotState } from "./snapshot-import.ts";
import { exchangeDateKey, robinhoodSessionAt, nyseClosePtMinutes, MARKET_5M_MAX_AGE_SECONDS } from "./market-time.ts";
import { positionCheckSummary, positionRiskText } from "./today-action.ts";
import { conditionText, contractConditions } from "./ts-forecast-state.ts";
import { nextTimelineOccurrenceOfKind, utcForPt } from "./timeline-schedule.ts";
import { projectStockConditionalPlans, projectStockManualPlans, stockPlanCurrentGaps } from "./stock-manual-plan.ts";

export type OwnerManualPlan = {
  plan_id: string; side: "SELL_TO_CLOSE" | "BUY_TO_OPEN"; holding_id: string | null;
  symbol: string; contract_id: string; option_type: "call" | "put"; expiration: string; strike: number;
  quantity: number; quantity_basis: "HELD_MAX_CONFIRM_OWNER" | "APPROVED";
  reference_price: number; max_debit_usd: number | null;
  trigger: string; trigger_state: "OBSERVED" | "OWNER_CHECK_REQUIRED";
  stop_loss_pct: number; take_profit_pct: number; first_target: string; holding_period: string;
  invalidation: string[]; valid_until: string; source_ref: string; approval_ref: string;
  automated_execution: false; owner_confirmation_required: true;
};

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
const receipt = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const stops = (stop: unknown, target: unknown): stop is number => typeof stop === "number" && Number.isFinite(stop) && stop >= -100 && stop <= 0 && typeof target === "number" && Number.isFinite(target) && target >= 0;
const holdingPeriods = { INTRADAY_0_1: "日内策略（0–1 DTE）", SHORT_2_7: "短线策略（2–7 DTE）", SWING_14_60: "波段策略（14–60 DTE）", LONG_90_PLUS: "长线策略（90+ DTE）", UNCLASSIFIED: "未给出已批准的持有时段" };

// A display-only projection of existing evidence; never an order, approval writer or new forecast.
export function projectOwnerManualPlans(snapshot: SnapshotState, now: number) {
  const checkpoint = snapshot.outputs.SCHEDULE_CHECKPOINT.find((row) => row.kind === "POSITION_MONITOR");
  const stock = projectStockManualPlans(snapshot.outputs.STOCK_MANUAL_PLAN ?? [], now);
  const conditional = projectStockConditionalPlans(snapshot.outputs.STOCK_MANUAL_PLAN ?? [], now);
  const next_stock_check = Number.isFinite(now) ? nextTimelineOccurrenceOfKind(new Date(now), "TS_FORECAST")?.scheduled_at ?? null : null;
  const blocked_reasons: string[] = [...new Set([...stock.blocked_reasons, ...conditional.blocked_reasons])];
  const conditional_plans = conditional.plans.map((plan) => {
    const evidence = snapshot.outputs.STOCK_MANUAL_PLAN.find((output) => output.evidence.evidence_id === plan.source_ref)!.evidence;
    const gaps = stockPlanCurrentGaps(evidence, snapshot, now);
    return gaps.length ? { ...plan, stage: "EXPIRED" as const, pending_conditions: [...new Set([...gaps, ...plan.pending_conditions])] } : plan;
  });
  const currentStockPlans = stock.plans.filter((plan) => {
    const evidence = snapshot.outputs.STOCK_MANUAL_PLAN.find((output) => output.evidence.evidence_id === plan.source_ref)!.evidence;
    const gaps = stockPlanCurrentGaps(evidence, snapshot, now);
    blocked_reasons.push(...gaps.map((gap) => `${plan.symbol}：${gap}`)); return !gaps.length;
  });
  const progress = stock.progress.map((row) => {
    const evidence = snapshot.outputs.STOCK_MANUAL_PLAN.find((output) => output.evidence.evidence_id === row.evidence_id)!.evidence;
    const gaps = stockPlanCurrentGaps(evidence, snapshot, now);
    return gaps.length ? { ...row, stage: row.stage === "OWNER_REVIEW" ? "WAITING" as const : row.stage, reasons: [...new Set([...gaps, ...row.reasons])] } : row;
  });
  const currentStockPlanCount = currentStockPlans.length;
  const risks = positionCheckSummary(checkpoint, now), plans: OwnerManualPlan[] = currentStockPlans;
  if (!snapshot.outputs.STOCK_MANUAL_PLAN?.length) blocked_reasons.push("个股买入：尚无独立复核结果；观察名单不等于已批准计划。");
  const regular = Number.isFinite(now) && robinhoodSessionAt(now).phase === "REGULAR", tradingDate = Number.isFinite(now) ? exchangeDateKey(now) : "";
  const closeMinutes = nyseClosePtMinutes(tradingDate), sessionEnd = regular ? utcForPt(tradingDate, `${Math.floor(closeMinutes / 60)}:${String(closeMinutes % 60).padStart(2, "0")}`).getTime() : now;
  const fresh = (at: string | null | undefined, seconds: number) => { const age = now - Date.parse(at ?? ""); return Number.isFinite(age) && age >= 0 && age <= seconds * 1_000; };
  const expiry = (at: string | null | undefined, seconds: number) => Date.parse(at ?? "") + seconds * 1_000;
  const validDate = (value: string | null) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0, 10) === value);
  const check = risks.check;
  if (!risks.current) blocked_reasons.push("持仓：当前逐仓检查或账户源未核验；旧结论不派单。");
  for (const row of check?.observations ?? []) {
    const hits = row.risks.filter((risk) => ["APPROVED_STOP_REACHED", "APPROVED_TARGET_REACHED"].includes(risk));
    const bound = row.plan_run_id && receipt(row.plan_receipt_hash) && ["ACTIVE", "EXIT_RECOMMENDED"].includes(row.plan_status)
      && row.holding_id && row.position_id && row.contract_id && row.symbol && row.direction === "long"
      && (row.option_type === "call" || row.option_type === "put") && positive(row.strike) && positive(row.quantity) && Number.isInteger(row.quantity)
      && positive(row.average_cost) && stops(row.stop_loss_pct, row.take_profit_pct)
      && check!.observations.filter((item) => item.holding_id === row.holding_id).length === 1;
    const sourceCurrent = regular && risks.current && checkpoint?.status === "SUCCEEDED" && checkpoint.slot_id.startsWith("timeline:position_monitor:")
      && check?.account_status === "LIVE" && row.quote_status === "LIVE" && fresh(row.quote_as_of, 120) && positive(row.bid) && positive(row.ask) && row.ask >= row.bid;
    const exitReturn = positive(row.bid) && positive(row.average_cost) ? Number(((row.bid / row.average_cost - 1) * 100).toFixed(6)) : null;
    const actionable = sourceCurrent && bound && validDate(row.expiration) && row.expiration! >= tradingDate && row.dte !== null && row.dte >= 0
      && hits.length > 0 && row.risks.every((risk) => hits.includes(risk) || risk === "EXPIRY_TODAY")
      && exitReturn !== null && hits.every((risk) => risk === "APPROVED_STOP_REACHED" ? exitReturn <= row.stop_loss_pct! : exitReturn >= row.take_profit_pct!);
    if (!actionable) {
      if (row.risks.length || hits.length) blocked_reasons.push(`持仓 ${row.symbol ?? row.holding_id}：${row.risks.map((risk) => positionRiskText[risk] ?? risk).join("；")}；仅风险提示，未形成当前人工卖出检查计划。`);
      continue;
    }
    plans.push({
      plan_id: `manual-exit:${encodeURIComponent(checkpoint!.slot_id)}:${row.holding_id}:${row.plan_receipt_hash}`, side: "SELL_TO_CLOSE", holding_id: row.holding_id,
      symbol: row.symbol!, contract_id: row.contract_id!, option_type: row.option_type!, expiration: row.expiration!, strike: row.strike!,
      quantity: row.quantity!, quantity_basis: "HELD_MAX_CONFIRM_OWNER", reference_price: row.bid!, max_debit_usd: null,
      trigger: hits.map((risk) => positionRiskText[risk]).join("；"), trigger_state: "OBSERVED", stop_loss_pct: row.stop_loss_pct!, take_profit_pct: row.take_profit_pct!,
      first_target: `原审批止盈 +${row.take_profit_pct}%（Bid 相对持仓成本；不是保证收益）`, holding_period: `触发后人工检查退出；原审批未给出剩余持有时长，合约 ${row.expiration} 到期`,
      invalidation: ["账户、合约、方向、持仓数量或成本变化即失效", "源报价、账户或检查超过120秒或正常交易时段结束即失效；Bid仅参考，不保证成交", "数量是当前持有上限，退出多少由 Owner 确认；不是全仓卖单"],
      valid_until: new Date(Math.min(expiry(check!.checked_at, 120), expiry(check!.account_as_of, 120), expiry(row.quote_as_of, 120), sessionEnd)).toISOString(),
      source_ref: checkpoint!.result_ref ?? checkpoint!.slot_id, approval_ref: `${row.plan_run_id}#${row.plan_receipt_hash}`, automated_execution: false, owner_confirmation_required: true,
    });
  }

  const signal = snapshot.outputs.OPTION_STRATEGY_SIGNAL[0];
  if (!signal || signal.source_mode !== "LIVE" || signal.mode !== "SHADOW" || signal.automated_execution !== false || signal.owner_action !== "EXECUTABLE" || signal.decision_basis !== "EXECUTABLE") {
    blocked_reasons.push("指数买入：尚无既有正式 D/A3 批准的可执行策略；不代表个股也未获批准。");
    return { plans, conditional_plans, blocked_reasons, risks, progress, next_stock_check };
  }
  const reasons: string[] = [], candidate = signal.candidates.find((row) => row.candidate_id === signal.selected_candidate_id), leg = candidate?.legs[0];
  const a1 = snapshot.outputs.A1_SHADOW_RESULT, a2 = snapshot.outputs.A2_SHADOW_RESULT, market = a1?.market_sources, account = market?.account;
  const d = snapshot.outputs.D_SHADOW_OUTPUT, a3 = snapshot.outputs.A3_FINAL_SHADOW, truth = snapshot.currentTruth;
  const ts = snapshot.outputs.TS_SHADOW_OUTPUT.find((row) => row.evidence_snapshot.run_id === signal.ts_run_id);
  if (!candidate || !["LONG_CALL", "LONG_PUT"].includes(candidate.strategy_type) || candidate.legs.length !== 1 || leg?.side !== "BUY") reasons.push("仅支持已批准单腿；缺失候选或借记价差不能拆成一腿派单");
  if (candidate?.status !== "PASS" || candidate.liquidity.status !== "PASS" || !candidate.volatility_gate || candidate.volatility_gate.status === "BLOCKED" || candidate.market_edge.covers_spread_and_decay !== true || candidate.data_gaps.length || signal.data_gaps.length) reasons.push("策略的完整行情、流动性、波动率或成本门禁未通过");
  const entryIssues = signal.risk_summary.issues.filter((issue) => issue.layer === "NEW_ENTRY_BLOCK");
  if (!receipt(signal.risk_summary.context_hash) || signal.risk_summary.core_hard_block_count !== 0 || signal.risk_summary.issues.some((issue) => issue.layer === "CORE_HARD_BLOCK") || signal.risk_summary.new_entry_block_count !== entryIssues.length || entryIssues.some((issue) => issue.scope === "GLOBAL" || issue.scope === candidate?.symbol)) reasons.push("存在核心或本标的新开仓风险阻断");
  if (!regular || truth?.market_session !== "REGULAR" || truth.source_mode !== "LIVE" || truth.health_status === "BLOCKED" || truth.market_data_health.quote_health !== "LIVE" || truth.market_data_health.bar_health !== "LIVE") reasons.push("当前正常交易时段、行情和交易健康未通过");
  if (truth?.natural_slot.slot_id !== signal.slot_id || truth.run_id !== signal.source_run_id || truth.natural_slot.status !== "SUCCEEDED" || truth.natural_slot.statistical_eligibility !== "ELIGIBLE_NATURAL_EVIDENCE" || truth.forecast_id !== signal.ts_run_id || !signal.source_run_id.startsWith("live-shadow:")) reasons.push("当前自然槽、冻结策略与正式 TS 身份不一致");
  const components = { A1: "A1_SHADOW_RESULT", A2: "A2_SHADOW_RESULT", TS: "TS_SHADOW_OUTPUT", D: "D_SHADOW_OUTPUT", A3: "A3_FINAL_SHADOW" };
  for (const [agent, output] of Object.entries(components)) {
    const record = snapshot.recentOutputs.find((row) => row.output_type === output);
    const skill = agent === "A3" ? "A3_FINAL_LIVE_SHADOW" : `${agent}_LIVE_SHADOW`;
    if (record?.record_id !== `${signal.source_run_id}:${agent}` || record.channel !== "SHADOW" || !snapshot.runLedger.runs.some((row) => row.run_id === signal.source_run_id && row.slot_id === signal.slot_id && row.agent_id === agent && row.skill_id === skill && row.channel === "SHADOW" && row.status === "SUCCEEDED" && row.output_status === "PRODUCED" && row.website_delivery === "DELIVERED" && !row.evidence_refs.some((ref) => /replay|backfill|canary/i.test(ref)))) reasons.push(`${agent} 缺少同槽、同技能的成功产出与送达依据`);
  }
  if (a1?.source_mode !== "LIVE" || ["BLOCKED", "DEGRADED_NO_TRADE"].includes(a1.status) || a2?.source_mode !== "LIVE" || ["BLOCKED", "DEGRADED_NO_TRADE"].includes(a2.status) || market?.status !== "LIVE" || market.market_session.state !== "REGULAR" || market.market_session.market_date !== tradingDate || market.snapshot_id !== signal.market_snapshot_id || market.snapshot_hash !== signal.market_snapshot_hash) reasons.push("同槽 A1/A2 或冻结行情健康、身份不完整");
  if (account?.source !== "ROBINHOOD" || account.status !== "LIVE" || !Array.isArray(account.positions) || !fresh(account.as_of, 120)) reasons.push("当前只读账户未在120秒合同内完整核验");
  const times = [signal.observed_at, signal.data_cutoff_at, market?.as_of, ts?.evidence_snapshot.market_time.observed_at, leg?.as_of];
  for (const symbol of ["SPY", "QQQ"]) {
    const quote = market?.quotes.find((row) => row.symbol === symbol && row.source === "ROBINHOOD");
    times.push(quote?.as_of);
    if (quote?.status !== "LIVE" || !positive(quote.last) || !positive(quote.bid) || !positive(quote.ask) || quote.ask < quote.bid) reasons.push(`${symbol} 官方当前报价不完整`);
  }
  if (times.some((at) => !fresh(at, MARKET_5M_MAX_AGE_SECONDS))) reasons.push("行情、期权或正式 TS 源已过期、来自未来或时间无效");
  if (!ts || ts.tradeability.status !== "READY_FOR_D_REVIEW" || ts.evidence_snapshot.market_time.state !== "OPEN" || ts.evidence_snapshot.market_time.market_date !== tradingDate || ts.symbol_outlooks[candidate?.symbol ?? "SPY"]?.direction !== (leg?.option_type === "call" ? "BULLISH" : "BEARISH")) reasons.push("正式 TS 尚未具备同方向交易复核资格");
  const nextCheck = Date.parse(ts?.next_validation.at ?? ""), forecastEnd = ts?.forecast_window.end_at ? Date.parse(ts.forecast_window.end_at) : nextCheck, forecastStart = Date.parse(ts?.forecast_window.start_at ?? "");
  if (!Number.isFinite(nextCheck) || nextCheck <= now || !Number.isFinite(forecastEnd) || forecastEnd <= now || !Number.isFinite(forecastStart) || forecastStart > now) reasons.push("正式 TS 窗口或下一核验期限已失效");
  if (!candidate || !validDate(candidate.expiration) || candidate.expiration < tradingDate || !holdingPeriods[candidate.holding_horizon] || candidate.holding_horizon === "UNCLASSIFIED") reasons.push("合约期限或预计持有档未获批准");
  if (!leg || !positive(leg.bid) || !positive(leg.ask) || leg.ask < leg.bid || !positive(candidate?.max_risk_usd) || candidate.max_risk_usd !== Number((leg.ask * 100).toFixed(2))) reasons.push("单腿报价、数量或最大风险不完整");
  if (!d || !a3 || d.action !== "MANUAL_BUY" || a3.decision !== "MANUAL_BUY" || signal.d_action !== "MANUAL_BUY" || signal.a3_decision !== "MANUAL_BUY" || a3.data_status !== "HEALTHY" || d.data_status !== undefined && d.data_status !== "HEALTHY" || !Array.isArray(d.data_gaps) || d.data_gaps.length
    || ![d, a3].every((row) => row.underlying === candidate?.symbol && row.option_side === leg?.option_type && row.expiration === candidate?.expiration && row.strike === leg?.strike && row.quantity === 1 && positive(row.max_entry_debit) && positive(candidate?.max_risk_usd) && row.max_entry_debit >= candidate.max_risk_usd && stops(row.stop_loss_pct, row.take_profit_pct))) reasons.push("D/A3 未明确批准同一合约、数量、预算和止损止盈");
  if (!texts(d?.entry_conditions) || !d.entry_conditions.length || !texts(d?.invalidation) || !d.invalidation.length || !texts(a3?.invalidation) || !a3.invalidation.length) reasons.push("原审批未给出完整触发和失效条件");
  const firstStage = ts?.scenarios.main.sequence.find((stage) => contractConditions(stage).some((row) => row.symbol === candidate?.symbol));
  const targets = contractConditions(firstStage).filter((row) => row.symbol === candidate?.symbol && row.metric === "LAST_PRICE" && positive(row.value));
  if (!targets.length) reasons.push("冻结 TS 未给出同标的第一价格目标");
  if (reasons.length || !candidate || !leg || !d || !a3) {
    blocked_reasons.push(...reasons.map((reason) => `指数买入：${reason}。`));
    return { plans, conditional_plans, blocked_reasons, risks, progress, next_stock_check };
  }
  // Stock entries are the fallback, not extra orders on top of an approved index entry.
  plans.splice(0, currentStockPlanCount);
  plans.push({
    plan_id: `manual-entry:${signal.signal_id}:${candidate.candidate_id}`, side: "BUY_TO_OPEN", holding_id: null,
    symbol: candidate.symbol, contract_id: leg.contract_id, option_type: leg.option_type, expiration: candidate.expiration, strike: leg.strike,
    quantity: 1, quantity_basis: "APPROVED", reference_price: leg.ask, max_debit_usd: Math.min(d.max_entry_debit as number, a3.max_entry_debit as number),
    trigger: (d.entry_conditions as string[]).join("；"), trigger_state: "OWNER_CHECK_REQUIRED", stop_loss_pct: a3.stop_loss_pct as number, take_profit_pct: a3.take_profit_pct as number,
    first_target: `${candidate.symbol} ${targets.map(conditionText).join("且")}（标的参考，不是期权卖价）`, holding_period: `${holdingPeriods[candidate.holding_horizon]}；期限档不是保证持有天数`,
    invalidation: [...new Set([...(d.invalidation as string[]), ...(a3.invalidation as string[]), "仍须 Owner 核对触发与实时限价；不是已触发，也不保证成交", "正常交易时段结束或来源证据过期即失效"] )],
    valid_until: new Date(Math.min(...times.map((at) => expiry(at, MARKET_5M_MAX_AGE_SECONDS)), expiry(account!.as_of, 120), nextCheck, forecastEnd, sessionEnd)).toISOString(),
    source_ref: signal.signal_id, approval_ref: `${signal.source_run_id}:D|${signal.source_run_id}:A3`, automated_execution: false, owner_confirmation_required: true,
  });
  return { plans, conditional_plans, blocked_reasons, risks, next_stock_check, progress: progress.map((row) => row.stage === "OWNER_REVIEW" ? { ...row, stage: "WAITING" as const, reasons: ["本轮已有指数买入计划，个股保留备选，不叠加开仓", ...row.reasons] } : row) };
}
