import type { OptionStrategySignal, PositionCopilotState } from "./snapshot-import.ts";
import { exchangeDateKey, robinhoodSessionAt } from "./market-time.ts";
import type { ScheduleCheckpoint } from "./timeline-schedule.ts";

export type TodayAction = "OBSERVE" | "WAIT" | "EXECUTABLE" | "HOLD" | "REDUCE" | "EXIT";

export const positionRiskText: Record<string, string> = { POSITION_QUOTE_STALE: "报价已过期，不能当作当前卖价", POSITION_QUOTE_UNAVAILABLE: "未取得可靠买卖价", POSITION_MODEL_UNSUPPORTED: "本仓结构尚不能计算退出盈亏", POSITION_COST_UNAVAILABLE: "成本资料不足", PLAN_NOT_BOUND: "尚未绑定可核验的止损止盈计划", APPROVED_STOP_REACHED: "已触及原计划止损线", APPROVED_TARGET_REACHED: "已触及原计划止盈线", POSITION_EXPIRED: "合约已到期，请核对处理结果", EXPIRY_TODAY: "合约今天到期" };

export function positionCheckSummary(checkpoint: ScheduleCheckpoint | null | undefined, now: number) {
  const recorded = checkpoint?.kind === "POSITION_MONITOR" ? checkpoint.position_check : undefined;
  const current = Boolean(recorded?.checks_completed && [recorded.checked_at, recorded.account_as_of].every((at) => {
    const age = now - Date.parse(at ?? "");
    return Number.isFinite(age) && age >= 0 && age <= 120_000;
  }));
  const check = current ? { ...recorded!, observations: recorded!.observations.map((row) => {
    const age = (now - Date.parse(row.quote_as_of ?? "")) / 1_000;
    const quoteStatus = row.quote_status !== "LIVE" ? row.quote_status : !Number.isFinite(age) || age < 0 ? "UNAVAILABLE" as const : age > 120 ? "STALE" as const : "LIVE" as const;
    if (quoteStatus === "LIVE") return row;
    const risks = row.risks.filter((risk) => !["APPROVED_STOP_REACHED", "APPROVED_TARGET_REACHED"].includes(risk));
    return { ...row, quote_status: quoteStatus, quote_age_seconds: Number.isFinite(age) ? age : null, exit_return_pct: null, risks: [...new Set([...risks, `POSITION_QUOTE_${quoteStatus}`])] };
  }) } : recorded;
  const alerts = current ? check!.observations.filter((row) => row.risks.some((risk) => ["APPROVED_STOP_REACHED", "APPROVED_TARGET_REACHED", "POSITION_EXPIRED", "EXPIRY_TODAY"].includes(risk))) : [];
  const gaps = current ? check!.observations.filter((row) => row.risks.some((risk) => !["APPROVED_STOP_REACHED", "APPROVED_TARGET_REACHED", "POSITION_EXPIRED", "EXPIRY_TODAY"].includes(risk))) : [];
  return { check, current, alerts, gaps, title: !current ? "当前持仓风险尚未核验" : alerts.length ? `${alerts.length}项持仓触及原计划或到期条件` : gaps.length ? `${gaps.length}项持仓仍有检查缺口` : check!.observations.length ? "本次已配置条件未触发" : "最近检查未发现期权持仓" };
}

export function isHoldingAdviceCurrent(state: PositionCopilotState, holding: PositionCopilotState["holdings"][number], tradingDate: string, now: number) {
  const observedAt = Date.parse(state.observed_at), nextCheckAt = holding.next_check_at ? Date.parse(holding.next_check_at) : null;
  if (state.source_mode !== "LIVE" || !Number.isFinite(now) || !Number.isFinite(observedAt) || observedAt > now) return false;
  const deadline = holding.time_invalidation, deadlineAt = deadline ? Date.parse(deadline) : null;
  if (deadline && (deadlineAt === null || !Number.isFinite(deadlineAt) || (/^\d{4}-\d{2}-\d{2}$/.test(deadline) ? new Date(deadlineAt).toISOString().slice(0, 10) !== deadline || deadline < exchangeDateKey(now) : deadlineAt < now))) return false;
  const invalidation = holding.price_invalidation, targets = [holding.target_1, holding.target_2].filter((value): value is number => value != null);
  if (targets.some((target) => !Number.isFinite(target) || target <= 0) || invalidation != null && (!Number.isFinite(invalidation) || invalidation <= 0 || targets.some((target) => holding.option_type === "call" ? target <= invalidation : holding.option_type === "put" && target >= invalidation))) return false;
  return robinhoodSessionAt(observedAt).trading_date === tradingDate && (nextCheckAt === null || Number.isFinite(nextCheckAt) && nextCheckAt >= now);
}

export function selectTodayAction(strategy: OptionStrategySignal | null, positions: PositionCopilotState | null, allowNewOpportunity = true) {
  const holdings = positions?.holdings ?? [];
  const urgent = holdings.find((item) => item.owner_action === "EXIT") ?? holdings.find((item) => item.owner_action === "REDUCE") ?? null;
  const selected = allowNewOpportunity && strategy?.owner_action === "EXECUTABLE"
    ? strategy.candidates.find((item) => item.candidate_id === strategy.selected_candidate_id) ?? null
    : null;
  if (urgent) return { action: urgent.owner_action as "EXIT" | "REDUCE", holding: urgent, candidate: null };
  if (selected) return { action: "EXECUTABLE" as const, holding: null, candidate: selected };
  const active = holdings.find((item) => item.owner_action === "HOLD") ?? holdings.find((item) => item.owner_action === "WAIT") ?? null;
  if (active) return { action: active.owner_action as "HOLD" | "WAIT", holding: active, candidate: null };
  if (strategy?.owner_action === "OBSERVE") return { action: "OBSERVE" as const, holding: null, candidate: null };
  return { action: "WAIT" as const, holding: null, candidate: null };
}
