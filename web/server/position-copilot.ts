import { createHash } from "node:crypto";
import { buildTsForecastState } from "../app/ts-forecast-state.ts";
import { exchangeDateKey } from "../app/market-time.ts";
import type { PositionCopilotState, PositionMonitorV1, ReadonlyMarketSources, TsOutput } from "../app/snapshot-import.ts";
import { optionDte, optionHorizon } from "./option-horizon.ts";
import { projectOwnerHoldingIntent, type OwnerPositionPlan } from "../app/owner-position-plan.ts";

type Position = NonNullable<ReadonlyMarketSources["account"]["positions"]>[number];
type Inputs = {
  runId: string; slotId: string; sourceMode: "LIVE" | "REPLAY"; market: ReadonlyMarketSources | null; monitor: PositionMonitorV1 | null;
  ts: TsOutput | null; d: Record<string, unknown> | null; a3: Record<string, unknown> | null; previous?: PositionCopilotState | null; observedAt?: string;
  ownerPositionPlans?: OwnerPositionPlan[];
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function hash(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function strikeText(value: number) { return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, "").replace(/\.$/, ""); }
function positionId(position: Position) { return position.symbol && position.option_type && position.expiration && finite(position.strike) ? `${position.symbol}-${position.option_type}-${position.expiration}-${strikeText(position.strike)}` : null; }
function sameHolding(a: Position, b: Position) { return a.contract_id !== null && a.account_label === b.account_label && a.contract_id === b.contract_id && positionId(a) === positionId(b) && a.direction === b.direction && a.quantity === b.quantity && a.average_price === b.average_price; }
function monitorMatches(id: string, candidate: string) { return candidate === id || candidate.startsWith(`${id}-r`) && /^\d+$/.test(candidate.slice(id.length + 2)); }

// Same 120-second held-option quote contract as frozen_position_monitor; not the 420-second Bar contract.
export function assessPositionRisks(account: ReadonlyMarketSources["account"] | null, monitor: PositionMonitorV1 | null, checkedAt: string, planAccount: ReadonlyMarketSources["account"] | null = null) {
  const now = Date.parse(checkedAt), accountAge = account?.as_of ? (now - Date.parse(account.as_of)) / 1_000 : Number.NaN;
  const usableAccount = Number.isFinite(now) && account?.source === "ROBINHOOD" && account.status === "LIVE" && Array.isArray(account.positions) && Number.isFinite(accountAge) && accountAge >= 0 && accountAge <= 120;
  const dataGaps = usableAccount ? [] : ["官方只读持仓未读取成功或已过期，不能把旧持仓当作当前风险检查。"];
  const observations = (account?.positions ?? []).map((position) => {
    const id = positionId(position), risks: string[] = [];
    const rawAge = position.as_of ? (now - Date.parse(position.as_of)) / 1_000 : Number.NaN;
    const quoteAge = Number.isFinite(rawAge) ? rawAge : null;
    const bbo = finite(position.bid) && finite(position.ask) && position.bid > 0 && position.ask >= position.bid;
    const quoteStatus = !usableAccount || !bbo || quoteAge === null || quoteAge < 0 ? "UNAVAILABLE" as const : quoteAge > 120 ? "STALE" as const : "LIVE" as const;
    if (quoteStatus !== "LIVE") risks.push(quoteStatus === "STALE" ? "POSITION_QUOTE_STALE" : "POSITION_QUOTE_UNAVAILABLE");
    const modeled = id !== null && position.direction === "long" && finite(position.quantity) && position.quantity > 0 && Number.isInteger(position.quantity);
    if (!modeled) risks.push("POSITION_MODEL_UNSUPPORTED");
    const costAvailable = finite(position.average_price) && position.average_price > 0;
    if (!costAvailable) risks.push("POSITION_COST_UNAVAILABLE");
    const exitReturn = modeled && costAvailable && quoteStatus === "LIVE" ? Number(((position.bid! / position.average_price! - 1) * 100).toFixed(6)) : null;
    // ponytail: small real-holding lists are scanned directly; index by contract if account size makes this material.
    const original = planAccount?.positions?.filter((row) => positionId(row) === id) ?? [];
    const matches = id ? monitor?.positions.filter((row) => monitorMatches(id, row.position_id)) ?? [] : [];
    const candidate = matches.length === 1 ? matches[0] : null;
    // The old monitor omits account and quantity; only its original same-run A1 can bind those facts.
    const dte = Number.isFinite(now) ? optionDte(position.expiration, exchangeDateKey(checkedAt)) : null;
    const plan = modeled && dte !== null && dte >= 0 && original.length === 1 && (account?.positions?.filter((row) => positionId(row) === id).length ?? 0) === 1
      && /^账户-[a-f0-9]{16}$/.test(position.account_label) && sameHolding(position, original[0]) && planAccount?.source === "ROBINHOOD" && planAccount.status === "LIVE"
      && candidate && ["ACTIVE", "EXIT_RECOMMENDED"].includes(candidate.plan_status) && candidate.plan_run_id
      && /^[a-f0-9]{64}$/i.test(candidate.plan_receipt_hash ?? "") && /^[a-f0-9]{64}$/i.test(candidate.position_snapshot_hash)
      && Date.parse(candidate.checked_at) >= Date.parse(planAccount.as_of ?? "") && Date.parse(candidate.checked_at) <= now
      && finite(candidate.stop_loss_pct) && candidate.stop_loss_pct >= -100 && candidate.stop_loss_pct <= 0
      && finite(candidate.take_profit_pct) && candidate.take_profit_pct >= 0 ? candidate : null;
    if (!plan) risks.push("PLAN_NOT_BOUND");
    if (exitReturn !== null && plan?.stop_loss_pct !== null && plan?.stop_loss_pct !== undefined && exitReturn <= plan.stop_loss_pct) risks.push("APPROVED_STOP_REACHED");
    if (exitReturn !== null && plan?.take_profit_pct !== null && plan?.take_profit_pct !== undefined && exitReturn >= plan.take_profit_pct) risks.push("APPROVED_TARGET_REACHED");
    if (dte !== null && dte <= 0) risks.push(dte < 0 ? "POSITION_EXPIRED" : "EXPIRY_TODAY");
    return {
      holding_id: `holding-${hash({ account: position.account_label, contract: position.contract_id, position_id: id, direction: position.direction }).slice(0, 24)}`,
      position_id: id, symbol: position.symbol, contract_id: position.contract_id, direction: position.direction, quantity: position.quantity,
      option_type: position.option_type, expiration: position.expiration, strike: position.strike, average_cost: position.average_price,
      quote_status: quoteStatus, quote_age_seconds: quoteAge, quote_as_of: position.as_of, bid: position.bid, ask: position.ask,
      exit_return_pct: exitReturn, dte, plan_run_id: plan?.plan_run_id ?? null, plan_receipt_hash: plan?.plan_receipt_hash ?? null,
      plan_status: plan?.plan_status ?? "PLAN_NOT_BOUND", stop_loss_pct: plan?.stop_loss_pct ?? null, take_profit_pct: plan?.take_profit_pct ?? null, risks,
    };
  });
  return {
    checked_at: checkedAt, account_status: account?.status ?? "DATA_BLOCKED", account_as_of: account?.as_of ?? null,
    checks_completed: Boolean(usableAccount), status: !usableAccount ? "DATA_BLOCKED" as const : observations.some((row) => row.risks.length) ? "DEGRADED" as const : "CHECKED" as const,
    automated_execution: false as const, observations, data_gaps: dataGaps,
  };
}
export type PositionRiskCheck = ReturnType<typeof assessPositionRisks>;
function exact(result: Record<string, unknown> | null, position: Position) { return Boolean(result && result.underlying === position.symbol && result.option_side === position.option_type && result.expiration === position.expiration && result.strike === position.strike); }
function changeSummary(previous: PositionCopilotState | null | undefined, holdings: PositionCopilotState["holdings"]) {
  if (!previous) return "首次记录：没有更早的持仓副驾驶状态可比较。";
  const before = new Map(previous.holdings.map((item) => [item.holding_id, item.owner_action]));
  const changes = holdings.flatMap((item) => before.get(item.holding_id) && before.get(item.holding_id) !== item.owner_action ? [`${item.symbol ?? "未知持仓"} 从 ${before.get(item.holding_id)} 变为 ${item.owner_action}`] : []);
  return changes.length ? changes.join("；") : "与上一槽一致：持仓动作没有变化。";
}

export function buildPositionCopilotState(input: Inputs): PositionCopilotState {
  const observedAt = input.observedAt ?? input.market?.generated_at ?? new Date().toISOString();
  const globalGaps: string[] = [];
  if (input.sourceMode !== "LIVE") globalGaps.push("REPLAY 只验证持仓副驾驶计算，不进入自然 LIVE 建议");
  if (!input.market || input.market.account.status !== "LIVE" || input.market.account.positions === null) globalGaps.push("Robinhood 官方只读持仓没有形成可用冻结快照");
  if (!input.monitor) globalGaps.push("V2 position-monitor 没有形成同槽逐仓监控");
  if (!input.ts) globalGaps.push("TS 没有形成同槽预测");
  const holdings = (input.market?.account.positions ?? []).map((position): PositionCopilotState["holdings"][number] => {
    const id = positionId(position), monitor = id ? input.monitor?.positions.find((item) => monitorMatches(id, item.position_id)) ?? null : null;
    const actualPositionId = monitor?.position_id ?? id;
    const supported = (position.symbol === "SPY" || position.symbol === "QQQ") && (position.option_type === "call" || position.option_type === "put") && position.direction === "long";
    const positionDte = monitor?.dte ?? optionDte(position.expiration, input.market?.market_session.market_date ?? observedAt.slice(0, 10));
    // Owner plans use the account-scoped risk-check identity, not the separate copilot identity.
    const ownerIdentity = { holding_id: `holding-${hash({ account: position.account_label, contract: position.contract_id, position_id: id, direction: position.direction }).slice(0, 24)}`,
      position_id: id, contract_id: position.contract_id, symbol: position.symbol, option_type: position.option_type, expiration: position.expiration, strike: position.strike, direction: position.direction, quantity: position.quantity, average_cost: position.average_price };
    const ownerPlans = input.ownerPositionPlans?.filter((plan) => plan.holding_id === ownerIdentity.holding_id) ?? [];
    const uniqueHolding = input.market?.account.positions?.filter((row) => row.account_label === position.account_label && positionId(row) === id && row.direction === position.direction).length === 1;
    const accountAge = Date.parse(observedAt) - Date.parse(input.market?.account.as_of ?? ""), quoteAge = Date.parse(observedAt) - Date.parse(position.as_of ?? "");
    const ownerPlan = input.sourceMode === "LIVE" && input.market?.account.source === "ROBINHOOD" && input.market.account.status === "LIVE" && /^账户-[a-f0-9]{16}$/.test(position.account_label)
      && accountAge >= 0 && accountAge <= 120_000 && quoteAge >= 0 && quoteAge <= 120_000 && uniqueHolding && ownerPlans.length === 1 && ownerPlans[0].position_fingerprint === hash(ownerIdentity) ? ownerPlans[0] : undefined;
    const intentReview = projectOwnerHoldingIntent(ownerPlan, ownerIdentity, Date.parse(observedAt));
    const holdingIntent = intentReview.intent && ownerPlan ? { ...intentReview.intent, plan_version_id: ownerPlan.plan_version_id, recorded_at: ownerPlan.recorded_at,
      source_record_id: ownerPlan.source_record_id, owner_holding_id: ownerPlan.holding_id, position_fingerprint: ownerPlan.position_fingerprint } : null;
    const holdingHorizon = holdingIntent ? "UNCLASSIFIED" : optionHorizon(positionDte);
    const approvedRow = input.market?.approved_capabilities?.fixed_pool.rows.find((item) => item.symbol === position.symbol) ?? null;
    const swing = approvedRow?.swing ?? null, management = swing?.management ?? null;
    const gaps = [...globalGaps];
    if (holdingIntent) gaps.push(`${intentReview.reason} ${intentReview.status === "REVIEW_DUE" ? "已到计划复查日" : "计划复查日"}：${holdingIntent.review_on}（加州日期）；不自动平仓。`);
    if (!supported) gaps.push("第一阶段只支持 SPY/QQQ 的 Long Call、Long Put 与对应减仓/退出管理");
    if (supported && !monitor) gaps.push("真实持仓没有匹配到同槽 V2 position-monitor");
    if (monitor?.quote_status !== "HEALTHY") gaps.push("逐仓 Bid/Ask 不健康，禁止给出持有、减仓或退出结论");
    if (!exact(input.d, position) || !exact(input.a3, position)) gaps.push("D/A3 没有同时绑定这一真实持仓");
    const requestedChange = ["MANUAL_REDUCE", "MANUAL_EXIT"].includes(String(input.d?.action));
    const highTimeframeInvalidated = swing?.stage === "INVALIDATED" || position.option_type === "call" && swing?.direction === "BEARISH" || position.option_type === "put" && swing?.direction === "BULLISH";
    const monitorExit = monitor?.plan_status === "EXIT_RECOMMENDED" || monitor?.monitor_status === "EXIT_RECOMMENDED";
    if ((holdingHorizon === "SWING_14_60" || holdingHorizon === "LONG_90_PLUS") && (!swing || ["DATA_BLOCKED", "WAIT"].includes(swing.stage))) gaps.push("14+DTE持仓缺少可用的固定70多周期结构证据，保持等待");
    if ((holdingHorizon === "SWING_14_60" || holdingHorizon === "LONG_90_PLUS") && highTimeframeInvalidated && !requestedChange) gaps.push("多周期结构已失效或反向，等待D/A3形成同持仓处置结论");
    if (!holdingIntent && holdingHorizon === "UNCLASSIFIED") gaps.push("持仓期限位于尚未批准的 8–13 或 61–89 DTE 管理空档，保持等待");
    if ((holdingHorizon === "SWING_14_60" || holdingHorizon === "LONG_90_PLUS") && requestedChange && !highTimeframeInvalidated && !monitorExit) gaps.push("短周期 TS 或单槽噪音不能单独推翻14+DTE持仓；尚无多周期失效或逐仓退出证据");
    let ownerAction: PositionCopilotState["holdings"][number]["owner_action"] = !supported ? "NOT_SUPPORTED" : "WAIT";
    if (!gaps.length && input.d?.action === "OBSERVE" && input.a3?.decision === "OBSERVE") ownerAction = "HOLD";
    else if (!gaps.length && input.d?.action === "MANUAL_REDUCE" && input.a3?.decision === "MANUAL_ADJUST") ownerAction = "REDUCE";
    else if (!gaps.length && input.d?.action === "MANUAL_EXIT" && input.a3?.decision === "MANUAL_EXIT") ownerAction = "EXIT";
    const symbol = position.symbol === "SPY" || position.symbol === "QQQ" ? position.symbol : null;
    const forecast = symbol && input.ts ? buildTsForecastState([input.ts], symbol) : null;
    const longHorizon = holdingHorizon === "SWING_14_60" || holdingHorizon === "LONG_90_PLUS";
    const researchDirection = longHorizon ? swing?.direction : symbol && input.ts?.symbol_outlooks[symbol].direction === input.ts?.scenarios.main.bias ? input.ts?.symbol_outlooks[symbol].direction : null;
    const directionAligned = !holdingIntent && position.direction === "long" && (position.option_type === "call" && researchDirection === "BULLISH" || position.option_type === "put" && researchDirection === "BEARISH");
    const targets = !directionAligned ? [] : longHorizon ? [management?.target_1 ?? null, management?.target_2 ?? null] : forecast?.targetRange ? position.option_type === "put" ? [forecast.targetRange.high, forecast.targetRange.low] : [forecast.targetRange.low, forecast.targetRange.high] : [];
    if (!directionAligned && !holdingIntent) gaps.push("当前研究方向与真实持仓方向不一致或尚未验证，不把研究目标和失效价套用为持仓计划");
    const timeInvalidation = longHorizon && directionAligned && management?.time_invalidation_date && management.time_invalidation_date >= exchangeDateKey(observedAt) && (!position.expiration || management.time_invalidation_date <= position.expiration) ? management.time_invalidation_date : position.expiration;
    if (longHorizon && management?.time_invalidation_date && management.time_invalidation_date < exchangeDateKey(observedAt)) gaps.push("研究失效日期已过期，不能继续作为持仓未来期限；仅显示合约到期日");
    const explanation = ownerAction === "HOLD" ? "D 与 A3 在同一冻结快照下建议继续持有；仍需按下一检查点复核。" : ownerAction === "REDUCE" ? "D 与 A3 同时建议人工减仓；网站不会代替老板执行。" : ownerAction === "EXIT" ? "D 与 A3 同时建议人工退出；网站不会代替老板执行。" : ownerAction === "NOT_SUPPORTED" ? "该持仓不在第一阶段 SPY/QQQ 多头期权管理范围内。" : "证据或部门结论不完整，保持等待，不猜持仓动作。";
    const base = { account: position.account_label, contract: position.contract_id, position_id: actualPositionId, symbol: position.symbol, side: position.option_type, expiration: position.expiration, strike: position.strike };
    const holdingId = `holding-${hash(base).slice(0, 24)}`;
    const previousHolding = input.previous?.holdings.find((item) => item.holding_id === holdingId);
    const discoveryBase = {
      first_seen_at: observedAt,
      market_snapshot_id: input.market?.snapshot_id ?? null,
      ts_run_id: input.ts?.evidence_snapshot.run_id ?? null,
      ts_path_bias: input.ts?.path_bias ?? null,
      ts_one_line_forecast: input.ts?.one_line_forecast ?? null,
      underlying_price: symbol ? input.market?.quotes?.find((quote) => quote.source === "ROBINHOOD" && quote.symbol === symbol)?.last ?? null : null,
      option_bid: position.bid,
      option_ask: position.ask,
      option_mark: position.mark,
      market_status: input.market?.status ?? null,
      market_session: input.market?.market_session?.state ?? null,
      market_as_of: input.market?.as_of ?? null,
      owner_history_status: "NOT_PROVIDED" as const,
    };
    const discoveryContext = previousHolding?.discovery_context ?? { ...discoveryBase, evidence_hash: hash(discoveryBase) };
    return {
      holding_id: holdingId, position_id: actualPositionId, source: "ROBINHOOD_OFFICIAL_TRADING_MCP", symbol: position.symbol,
      option_type: position.option_type, expiration: position.expiration, strike: position.strike, quantity: position.quantity, average_cost: position.average_price,
      bid: position.bid, ask: position.ask, mark: position.mark, as_of: position.as_of, dte: positionDte, holding_horizon: holdingHorizon,
      horizon_basis: holdingIntent ? intentReview.reason : holdingHorizon === "INTRADAY_0_1" ? "0–1 DTE：按日内 TS、剩余时间和逐仓报价管理" : holdingHorizon === "SHORT_2_7" ? "2–7 DTE：按短线 TS 与次日确认管理" : holdingHorizon === "SWING_14_60" ? "14–60 DTE：以固定70多周期波段结构为主，分钟 TS 只作检查" : holdingHorizon === "LONG_90_PLUS" ? "90+ DTE：以多周期结构和原持仓逻辑为主，分钟 TS 不得单独推翻" : "期限不在已批准的四档管理窗口，保持等待",
      ...(holdingIntent ? { holding_intent: holdingIntent } : {}),
      exit_return_pct: monitor?.exit_return_pct ?? null,
      owner_action: ownerAction, thesis_status: ownerAction === "EXIT" ? "INVALIDATED" : "NOT_VERIFIED", original_logic: holdingIntent ? ownerPlan!.original_logic : null,
      normal_range: holdingIntent ? { low: null, high: null, basis: "尚无匹配持有意图的管理计划，不套用DTE或短周期目标" } : { low: longHorizon ? approvedRow?.support ?? null : forecast?.support ?? null, high: longHorizon ? approvedRow?.resistance ?? null : forecast?.resistance ?? null, basis: longHorizon ? "固定70日线/4小时/1小时/30分钟结构；不是原始建仓逻辑" : "当前 TS 支撑/阻力；不是原始建仓逻辑" },
      price_invalidation: !directionAligned ? null : longHorizon ? management?.price_invalidation ?? null : forecast?.invalidation ?? null, time_invalidation: holdingIntent ? null : timeInvalidation, target_1: targets[0] ?? null, target_2: targets[1] ?? null,
      next_check_at: holdingIntent ? null : longHorizon && management?.next_check && Number.isFinite(Date.parse(management.next_check)) ? management.next_check : input.ts?.next_validation.at ?? null, monitor_status: monitor?.monitor_status ?? "NOT_OBSERVED", quote_status: monitor?.quote_status ?? "NOT_OBSERVED",
      explanation: holdingIntent ? `${intentReview.reason} 计划复查：${holdingIntent.review_on}（加州日期）；不会自动在第3天卖出。` : explanation,
      data_gaps: [...new Set([holdingIntent ? "Owner计划为事后说明，不能回填为原始建仓证据或交易批准" : "原始建仓逻辑未保存在现有只读持仓资料中，不能倒推", ...gaps])], discovery_context: discoveryContext,
    };
  });
  const base = {
    contract_version: "v1" as const, component: "POSITION_COPILOT_STATE" as const, mode: "SHADOW" as const, source_mode: input.sourceMode, automated_execution: false as const,
    source_run_id: input.runId, slot_id: input.slotId, previous_state_id: input.previous?.state_id ?? null, observed_at: observedAt,
    market_snapshot_id: input.market?.snapshot_id ?? null, ts_run_id: input.ts?.evidence_snapshot.run_id ?? null,
    change_summary: changeSummary(input.previous, holdings), holdings, data_gaps: [...new Set(globalGaps)],
  };
  return { ...base, state_id: `position-state-${hash(base).slice(0, 24)}` };
}
