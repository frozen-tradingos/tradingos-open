import { formatPtDateTime, nextNyseRegularDateAfter, ptDateKey } from "./market-time.ts";
import type { IncidentRecord, TsOutput } from "./snapshot-import.ts";
import { timelineGraceSeconds, timelineOccurrencesForPtDate, type ScheduleCheckpoint } from "./timeline-schedule.ts";
import { forecastTradingDate, resolveTsForecastContext } from "./ts-forecast-state.ts";

const nextSessionTypes = new Set(["NEXT_SESSION", "WEEKEND_OUTLOOK"]);
const directionText = { BULLISH: "偏多", BEARISH: "偏空", RANGE: "震荡" } as const;

export type NextSessionObservation = {
  phase: "PENDING" | "FORMING" | "READY" | "FAILED";
  status: string;
  direction: string;
  target_date: string;
  due_at: string | null;
  formed_at: string | null;
  data_status: string | null;
  reason: string;
  forecast_id: string | null;
  owner_action: string | null;
  next_step: string | null;
  last_completed: { target_date: string; direction: string; formed_at: string; forecast_id: string } | null;
  latest_update: Pick<ScheduleCheckpoint, "slot_id" | "scheduled_pt" | "completed_at" | "status" | "reason"> | null;
};

function latest<T extends { evidence_snapshot: { market_time: { observed_at: string } } }>(items: T[]) {
  return items.toSorted((a, b) => Date.parse(b.evidence_snapshot.market_time.observed_at) - Date.parse(a.evidence_snapshot.market_time.observed_at))[0] ?? null;
}

export function buildNextSessionObservation(input: { outputs: TsOutput[]; checkpoints: ScheduleCheckpoint[]; incidents: IncidentRecord[]; tradingDate: string; at: string | number | Date }) {
  const at = input.at instanceof Date ? input.at.getTime() : typeof input.at === "number" ? input.at : Date.parse(input.at);
  if (!Number.isFinite(at) || at <= 0 || !/^20\d{2}-\d{2}-\d{2}$/.test(input.tradingDate)) return {
    phase: "PENDING", status: "正在读取后台结果", direction: "暂不确定", target_date: "正在读取", due_at: null,
    formed_at: null, data_status: null, reason: "正在读取18:00任务状态", forecast_id: null, owner_action: null, next_step: null, last_completed: null, latest_update: null,
  } satisfies NextSessionObservation;
  const scheduleDate = ptDateKey(at);
  const occurrence = timelineOccurrencesForPtDate(scheduleDate).find((item) => item.kind === "EVENING_ANALYSIS") ?? null;
  const nextSessionOutputs = input.outputs.filter((item) => nextSessionTypes.has(item.report_type) && Date.parse(item.evidence_snapshot.market_time.observed_at) <= at);
  const context = resolveTsForecastContext(input.outputs, null, at);
  const targetDate = context.mode === "NEXT_SESSION" ? context.tradingDate! : nextNyseRegularDateAfter(scheduleDate);
  const output = latest(nextSessionOutputs.filter((item) => forecastTradingDate(item) === targetDate));
  const lastOutput = latest(nextSessionOutputs);
  const lastCompleted = lastOutput ? { target_date: nextNyseRegularDateAfter(lastOutput.evidence_snapshot.market_time.market_date), direction: directionText[lastOutput.path_bias], formed_at: lastOutput.evidence_snapshot.market_time.observed_at, forecast_id: lastOutput.evidence_snapshot.run_id } : null;
  const targetUpdates = input.checkpoints.filter((item) => item.kind === "EVENING_ANALYSIS" && Date.parse(item.completed_at) <= at && nextNyseRegularDateAfter(item.scheduled_pt.slice(0, 10)) === targetDate).toSorted((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at));
  const update = targetUpdates[0];
  const latestUpdate = update ? { slot_id: update.slot_id, scheduled_pt: update.scheduled_pt, completed_at: update.completed_at, status: update.status, reason: update.reason } : null;
  const failedUpdate = latestUpdate && ["FAILED", "DATA_BLOCKED", "MISSED"].includes(latestUpdate.status)
    ? `最近更新 ${latestUpdate.scheduled_pt.replace(" PT", " 加州时间")} 失败：${latestUpdate.reason ?? latestUpdate.status}；失败记录保留。` : "";
  if (output) {
    const coreStatus = typeof output.evidence_assessment.core_status === "string" ? output.evidence_assessment.core_status : null;
    const carried = output.evidence_snapshot.market_time.market_date !== scheduleDate;
    return {
      phase: "READY", status: carried ? "沿用已形成预测" : "已自然形成", direction: directionText[output.path_bias], target_date: targetDate,
      due_at: timelineOccurrencesForPtDate(output.evidence_snapshot.market_time.market_date).find((item) => item.kind === "EVENING_ANALYSIS")?.scheduled_at ?? null,
      formed_at: output.evidence_snapshot.market_time.observed_at, data_status: coreStatus === "READY" ? "核心数据正常" : coreStatus,
      reason: `${carried ? `形成于 ${formatPtDateTime(output.evidence_snapshot.market_time.observed_at)}，不是当前新判断；` : ""}${output.one_line_forecast}${failedUpdate ? ` ${failedUpdate}` : ""}`,
      forecast_id: output.evidence_snapshot.run_id, owner_action: null, next_step: null, last_completed: lastCompleted, latest_update: latestUpdate,
    } satisfies NextSessionObservation;
  }

  if (!occurrence) return {
    phase: "PENDING", status: "当日无分析排期", direction: "暂不确定", target_date: targetDate, due_at: null,
    formed_at: null, data_status: null, reason: `当日没有18:00分析任务，不计漏跑；目标交易日尚无已形成预测。${failedUpdate}`,
    forecast_id: null, owner_action: null, next_step: "按原时间表等待下一自然槽；不补造、不回填", last_completed: lastCompleted, latest_update: latestUpdate,
  } satisfies NextSessionObservation;

  const checkpoint = input.checkpoints.filter((item) => item.kind === "EVENING_ANALYSIS" && item.scheduled_pt.startsWith(`${scheduleDate} `) && Date.parse(item.completed_at) <= at).toSorted((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at))[0] ?? null;
  const due = occurrence ? Date.parse(occurrence.scheduled_at) : Number.NaN;
  if (Number.isFinite(due) && at < due) return {
    phase: "PENDING", status: "计划正常", direction: "等待18:00形成", target_date: targetDate, due_at: occurrence!.scheduled_at,
    formed_at: null, data_status: null, reason: "18:00按合同自然冻结；形成前不拿盘中结论冒充次日预测", forecast_id: null, owner_action: null, next_step: null, last_completed: lastCompleted, latest_update: latestUpdate,
  } satisfies NextSessionObservation;
  if (!checkpoint && Number.isFinite(due) && at <= due + timelineGraceSeconds(occurrence!) * 1_000) return {
    phase: "FORMING", status: "正在等待自然形成", direction: "暂不确定", target_date: targetDate, due_at: occurrence!.scheduled_at,
    formed_at: null, data_status: null, reason: "18:00自然任务仍在允许窗口内", forecast_id: null, owner_action: null, next_step: "等待后台返回正式终态；不补造、不回填", last_completed: lastCompleted, latest_update: latestUpdate,
  } satisfies NextSessionObservation;

  const runId = checkpoint?.result_ref?.split("/").at(-1) ?? null;
  const incident = runId ? input.incidents.find((item) => item.status === "ACTIVE" && item.run_id === runId) ?? null : null;
  const ownerRequired = incident?.details.owner_required === true;
  return {
    phase: "FAILED", status: "没有形成", direction: "暂不确定", target_date: targetDate, due_at: occurrence?.scheduled_at ?? null,
    formed_at: null, data_status: null,
    reason: checkpoint?.reason ?? (checkpoint?.status === "SUCCEEDED" ? "18:00任务已有成功终态，但后台没有找到正式下一交易日结果" : "后台没有找到当天18:00正式结果或终态证据"),
    forecast_id: null, owner_action: ownerRequired ? `需要：${incident?.suggestion ?? "按当前Incident处理"}` : "不需要Owner操作",
    next_step: ownerRequired ? incident?.suggestion ?? "等待Owner完成当前Incident要求的操作" : "系统守卫继续复查；不补造、不回填", last_completed: lastCompleted, latest_update: latestUpdate,
  } satisfies NextSessionObservation;
}
