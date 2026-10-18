import type { ManagerReview } from "./codex-manager.ts";
import type { PositionRiskCheck } from "../server/position-copilot.ts";
import { isNyseRegularSession, mostRecentNyseRegularDate, nyseClosePtMinutes, OWNER_TIME_ZONE, ptDateKey, utcIso } from "./market-time.ts";
export { ptDateKey } from "./market-time.ts";

export const TIMELINE_KINDS = ["POSITION_MONITOR", "A1_HEARTBEAT", "LOCAL_GUARD", "CODEX_GUARD", "TS_FORECAST", "FULL_ANALYSIS", "HISTORY_ARCHIVE", "TS_SETTLEMENT", "EVENING_ANALYSIS", "EVENING_LOCAL_GUARD", "EVENING_CODEX_GUARD", "DAILY_REVIEW", "CODEX_MANAGER"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];
export type ScheduleCheckpointStatus = "SUCCEEDED" | "FAILED" | "DATA_BLOCKED" | "MISSED" | "SKIPPED_MARKET_CLOSED";
export type TsCoreTerminalOutcome = "DELIVERED" | "NO_TRADE" | "GENUINE_DATA_BLOCKED" | "SYSTEM_BLOCKED" | "FAILED";

export type TimelineOccurrence = {
  slot_id: string;
  kind: TimelineKind;
  label: string;
  business_slot: string;
  scheduled_at: string;
  scheduled_pt: string;
  trading_day: boolean;
  source_files: string[];
};

export type ScheduleCheckpoint = TimelineOccurrence & {
  contract_version: "v1";
  role: "TIMELINE_SCHEDULER";
  status: ScheduleCheckpointStatus;
  started_at: string | null;
  completed_at: string;
  late_seconds: number;
  result_ref: string | null;
  reason: string | null;
  terminal_outcome?: TsCoreTerminalOutcome;
  manager_review?: ManagerReview;
  position_check?: PositionRiskCheck;
};

export const OPERATIONAL_ANNOTATION_KINDS = ["PLANNED_OWNER_SHUTDOWN", "UNPLANNED_INTERRUPTION", "STARTUP_RECOVERY"] as const;
export type OperationalAnnotationKind = (typeof OPERATIONAL_ANNOTATION_KINDS)[number];
export type OperationalAnnotation = {
  contract_version: "v1";
  annotation_id: string;
  kind: OperationalAnnotationKind;
  started_at: string;
  ended_at: string;
  recorded_at: string;
  actor: "OWNER" | "SYSTEM";
  note: string;
  canonical_sha256: string;
};
export type OperationalEvidenceMode = "NATURAL" | OperationalAnnotationKind | "MANUAL_REPLAY";

export type SchedulerState = {
  timezone: typeof OWNER_TIME_ZONE;
  checked_at: string;
  next_run: TimelineOccurrence | null;
  today: { date: string; expected: number; completed: number; missed: number; failed: number; blocked: number; pending: number };
  health_window: { dates: string[]; completed: number; missed: number; failed: number; blocked: number; historical_missed: number; initialization_missed: number };
  groups: Array<{ kind: TimelineKind; label: string; expected: number; completed: number; missed: number; failed: number; blocked: number; pending: number }>;
  recent: ScheduleCheckpoint[];
};

export function operationalEvidenceMode(item: Pick<TimelineOccurrence, "slot_id" | "scheduled_at">, annotations: OperationalAnnotation[] = []): OperationalEvidenceMode {
  if (item.slot_id.startsWith("replay-") || item.slot_id.includes(":replay:")) return "MANUAL_REPLAY";
  if (item.slot_id.startsWith("codex-manager:deploy:")) return "STARTUP_RECOVERY"; // Legacy startup reviews were mislabeled as deployment reviews.
  const scheduledAt = Date.parse(item.scheduled_at);
  const windows = annotations.filter((entry) => Date.parse(entry.started_at) <= scheduledAt && scheduledAt <= Date.parse(entry.ended_at));
  if (windows.some((entry) => entry.kind === "PLANNED_OWNER_SHUTDOWN")) return "PLANNED_OWNER_SHUTDOWN";
  if (windows.some((entry) => entry.kind === "UNPLANNED_INTERRUPTION")) return "UNPLANNED_INTERRUPTION";
  return "NATURAL";
}

export const eligibleForSuccessStatistics = (item: Pick<TimelineOccurrence, "slot_id" | "scheduled_at">, annotations: OperationalAnnotation[] = []) => operationalEvidenceMode(item, annotations) === "NATURAL";
export const eligibleForFaultStatistics = (item: Pick<TimelineOccurrence, "slot_id" | "scheduled_at">, annotations: OperationalAnnotation[] = []) => ["NATURAL", "UNPLANNED_INTERRUPTION"].includes(operationalEvidenceMode(item, annotations));

const ptParts = new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const SOURCES = {
  POSITION_MONITOR: ["trading_os_v2/supervisor/service.py", "docs/SYSTEM_OUTLINE.md"],
  A1_HEARTBEAT: ["config/system.json", "docs/SYSTEM_OUTLINE.md"],
  LOCAL_GUARD: ["trading_os_v2/supervisor/service.py", "config/system.json"],
  CODEX_GUARD: ["trading_os_v2/supervisor/service.py", "config/system.json"],
  TS_FORECAST: ["trading_os_v2/acceptance/service.py", "docs/SYSTEM_OUTLINE.md"],
  FULL_ANALYSIS: ["config/system.json", "docs/SYSTEM_OUTLINE.md"],
  HISTORY_ARCHIVE: ["trading_os_v2/acceptance/service.py", "docs/SYSTEM_OUTLINE.md"],
  TS_SETTLEMENT: ["trading_os_v2/acceptance/service.py", "docs/SYSTEM_OUTLINE.md"],
  EVENING_ANALYSIS: ["config/system.json", "docs/SYSTEM_OUTLINE.md"],
  EVENING_LOCAL_GUARD: ["trading_os_v2/supervisor/service.py", "docs/SYSTEM_OUTLINE.md"],
  EVENING_CODEX_GUARD: ["trading_os_v2/supervisor/service.py", "docs/SYSTEM_OUTLINE.md"],
  DAILY_REVIEW: ["trading_os_v2/daily_review/service.py", "docs/SYSTEM_OUTLINE.md"],
  CODEX_MANAGER: ["server/timeline-scheduler.ts", "app/codex-manager.ts"],
} satisfies Record<TimelineKind, string[]>;

function dateParts(date: Date) { return Object.fromEntries(ptParts.formatToParts(date).map((part) => [part.type, part.value])); }

export function utcForPt(dateKey: string, time: string) {
  const [year, month, day] = dateKey.split("-").map(Number), [hour, minute, second = 0] = time.split(":").map(Number);
  let value = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const part = dateParts(new Date(value));
    const represented = Date.UTC(Number(part.year), Number(part.month) - 1, Number(part.day), Number(part.hour), Number(part.minute), Number(part.second));
    value += Date.UTC(year, month - 1, day, hour, minute, second) - represented;
  }
  return new Date(value);
}

function dateFromKey(value: string) { const [year, month, day] = value.split("-").map(Number); return new Date(Date.UTC(year, month - 1, day)); }
function key(date: Date) { return date.toISOString().slice(0, 10); }
function addDays(value: string, days: number) { const date = dateFromKey(value); date.setUTCDate(date.getUTCDate() + days); return key(date); }
function weekday(value: string) { return dateFromKey(value).getUTCDay(); }

function add(occurrences: TimelineOccurrence[], dateKey: string, kind: TimelineKind, label: string, businessSlot: string, trigger: string, tradingDay: boolean) {
  const scheduledAt = utcForPt(dateKey, trigger);
  occurrences.push({ slot_id: `timeline:${kind.toLowerCase()}:${dateKey.replaceAll("-", "")}:${businessSlot.replace(":", "")}`, kind, label, business_slot: businessSlot, scheduled_at: scheduledAt.toISOString(), scheduled_pt: `${dateKey} ${trigger} PT`, trading_day: tradingDay, source_files: SOURCES[kind] });
}

function slots(start: number, end: number, interval: number) { const values: number[] = []; for (let value = start; value <= end; value += interval) values.push(value); return values; }
function hhmm(minutes: number) { return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; }

export function timelineOccurrencesForPtDate(dateKey: string) {
  const occurrences: TimelineOccurrence[] = [], tradingDay = isNyseRegularSession(dateKey), close = nyseClosePtMinutes(dateKey);
  if (tradingDay) {
    add(occurrences, dateKey, "CODEX_MANAGER", "Codex 盘前公司巡检", "06:20", "06:20:00", true);
    for (const minute of slots(390, close, 1)) add(occurrences, dateKey, "POSITION_MONITOR", "A1 持仓监控", hhmm(minute), `${hhmm(minute)}:30`, true);
    for (const minute of slots(390, close, 15)) add(occurrences, dateKey, "A1_HEARTBEAT", "A1 心跳", hhmm(minute), `${hhmm(minute)}:45`, true);
    for (const minute of slots(393, close + 3, 5)) add(occurrences, dateKey, "LOCAL_GUARD", "本地守卫", hhmm(minute), `${hhmm(minute)}:30`, true);
    for (const minute of slots(394, close + 4, 5)) add(occurrences, dateKey, "CODEX_GUARD", "Codex 守卫", hhmm(minute), `${hhmm(minute)}:30`, true);
    const ts = [390, 405, 420, ...slots(450, 750, 30)].filter((minute) => minute < close);
    for (const minute of ts) add(occurrences, dateKey, "TS_FORECAST", "TS 正式槽 Shadow", hhmm(minute), `${hhmm(minute)}:00`, true);
    for (const minute of [390, 405, 420, 570, 690].filter((value) => value < close)) add(occurrences, dateKey, "FULL_ANALYSIS", "完整分析", hhmm(minute), `${hhmm(minute)}:00`, true);
    add(occurrences, dateKey, "CODEX_MANAGER", "Codex 早盘公司巡检", "07:05", "07:05:00", true);
    add(occurrences, dateKey, "CODEX_MANAGER", "Codex 盘中公司巡检", "09:35", "09:35:00", true);
    add(occurrences, dateKey, "HISTORY_ARCHIVE", "不可变历史归档", hhmm(close + 15), `${hhmm(close + 15)}:00`, true);
    add(occurrences, dateKey, "TS_SETTLEMENT", "TS 独立结算", hhmm(close + 50), `${hhmm(close + 50)}:00`, true);
    add(occurrences, dateKey, "CODEX_MANAGER", "Codex 收盘后公司巡检", hhmm(close + 55), `${hhmm(close + 55)}:00`, true);
    add(occurrences, dateKey, "EVENING_ANALYSIS", "次日提前分析", "18:00", "18:00:00", true);
    add(occurrences, dateKey, "EVENING_LOCAL_GUARD", "18:00 报告本地检查", "18:11", "18:11:00", true);
    add(occurrences, dateKey, "EVENING_CODEX_GUARD", "18:00 报告 Codex 检查", "18:13", "18:13:00", true);
  } else if (weekday(dateKey) === 0) {
    add(occurrences, dateKey, "EVENING_ANALYSIS", "周末分析", "18:00", "18:00:00", false);
    add(occurrences, dateKey, "EVENING_LOCAL_GUARD", "周末报告本地检查", "18:11", "18:11:00", false);
    add(occurrences, dateKey, "EVENING_CODEX_GUARD", "周末报告 Codex 检查", "18:13", "18:13:00", false);
  }
  add(occurrences, dateKey, "DAILY_REVIEW", "每日复盘", "18:20", "18:20:00", tradingDay);
  const priority = (item: TimelineOccurrence) => item.kind === "TS_FORECAST" ? 0 : item.kind === "FULL_ANALYSIS" ? 1 : 2;
  return occurrences.sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at) || priority(a) - priority(b) || a.kind.localeCompare(b.kind));
}

export function nextTimelineOccurrence(after: Date) {
  const start = ptDateKey(after);
  for (let offset = 0; offset < 10; offset += 1) {
    const result = timelineOccurrencesForPtDate(addDays(start, offset)).find((item) => Date.parse(item.scheduled_at) > after.getTime());
    if (result) return result;
  }
  return null;
}

export function nextTimelineOccurrenceOfKind(after: Date, kind: TimelineKind) {
  const start = ptDateKey(after);
  for (let offset = 0; offset < 10; offset += 1) {
    const result = timelineOccurrencesForPtDate(addDays(start, offset)).find((item) => item.kind === kind && Date.parse(item.scheduled_at) > after.getTime());
    if (result) return result;
  }
  return null;
}

export const OPENING_RECOVERY_EFFECTIVE_DATE = "2026-09-21";
export const openingGraceSeconds = (scheduledAt?: string | Date) => scheduledAt && ptDateKey(scheduledAt) >= OPENING_RECOVERY_EFFECTIVE_DATE ? 10 * 60 : 5 * 60;
export const timelineGraceSeconds = (item: Pick<TimelineOccurrence, "kind" | "business_slot"> & Partial<Pick<TimelineOccurrence, "scheduled_at">>) => ["DAILY_REVIEW", "CODEX_MANAGER"].includes(item.kind) ? 9 * 60 : item.kind === "TS_FORECAST" && item.business_slot === "06:30" ? openingGraceSeconds(item.scheduled_at) : ["FULL_ANALYSIS", "EVENING_ANALYSIS"].includes(item.kind) ? 10 * 60 : 90;

export function schedulerState(checkpoints: ScheduleCheckpoint[], at = new Date(), activatedAt?: string | null, annotations: OperationalAnnotation[] = []): SchedulerState {
  const date = ptDateKey(at), expected = timelineOccurrencesForPtDate(date), bySlot = new Map(checkpoints.map((item) => [item.slot_id, item]));
  const activation = Date.parse(activatedAt ?? checkpoints.reduce((first, item) => item.completed_at < first ? item.completed_at : first, checkpoints[0]?.completed_at ?? at.toISOString()));
  const initializationMiss = (item: ScheduleCheckpoint) => eligibleForFaultStatistics(item, annotations) && item.status === "MISSED" && Date.parse(item.scheduled_at) + timelineGraceSeconds(item) * 1_000 < activation;
  const statisticallyEligible = (item: ScheduleCheckpoint) => item.status === "SUCCEEDED" ? eligibleForSuccessStatistics(item, annotations) : eligibleForFaultStatistics(item, annotations);
  const currentExpected = expected.filter((item) => Date.parse(item.scheduled_at) + timelineGraceSeconds(item) * 1_000 >= activation && operationalEvidenceMode(item, annotations) !== "PLANNED_OWNER_SHUTDOWN");
  const healthDates = [...new Set([date, mostRecentNyseRegularDate(date)])];
  const healthCheckpoints = checkpoints.filter((item) => healthDates.includes(item.scheduled_pt.slice(0, 10)) && !initializationMiss(item) && statisticallyEligible(item));
  const healthSlotIds = new Set(healthCheckpoints.map((item) => item.slot_id));
  const today = currentExpected.map((item) => bySlot.get(item.slot_id)).filter((item): item is ScheduleCheckpoint => Boolean(item));
  const currentToday = today.filter((item) => healthSlotIds.has(item.slot_id));
  const groups = TIMELINE_KINDS.map((kind) => {
    const planned = currentExpected.filter((item) => item.kind === kind), recorded = planned.map((item) => bySlot.get(item.slot_id)).filter((item): item is ScheduleCheckpoint => Boolean(item)).filter((item) => healthSlotIds.has(item.slot_id));
    return { kind, label: planned[0]?.label ?? kind, expected: planned.length, completed: recorded.filter((item) => item.status === "SUCCEEDED" && eligibleForSuccessStatistics(item, annotations)).length, missed: recorded.filter((item) => item.status === "MISSED" && eligibleForFaultStatistics(item, annotations)).length, failed: recorded.filter((item) => item.status === "FAILED" && eligibleForFaultStatistics(item, annotations)).length, blocked: recorded.filter((item) => item.status === "DATA_BLOCKED" && eligibleForFaultStatistics(item, annotations)).length, pending: planned.length - recorded.length };
  }).filter((group) => group.expected > 0);
  const count = (status: ScheduleCheckpointStatus) => healthCheckpoints.filter((item) => item.status === status && (status === "SUCCEEDED" ? eligibleForSuccessStatistics(item, annotations) : eligibleForFaultStatistics(item, annotations))).length;
  return { timezone: OWNER_TIME_ZONE, checked_at: utcIso(at), next_run: nextTimelineOccurrence(at), today: { date, expected: currentExpected.length, completed: currentToday.filter((item) => item.status === "SUCCEEDED" && eligibleForSuccessStatistics(item, annotations)).length, missed: currentToday.filter((item) => item.status === "MISSED" && eligibleForFaultStatistics(item, annotations)).length, failed: currentToday.filter((item) => item.status === "FAILED" && eligibleForFaultStatistics(item, annotations)).length, blocked: currentToday.filter((item) => item.status === "DATA_BLOCKED" && eligibleForFaultStatistics(item, annotations)).length, pending: currentExpected.length - currentToday.length }, health_window: { dates: healthDates, completed: count("SUCCEEDED"), missed: count("MISSED"), failed: count("FAILED"), blocked: count("DATA_BLOCKED"), historical_missed: checkpoints.filter((item) => item.status === "MISSED" && eligibleForFaultStatistics(item, annotations) && !healthSlotIds.has(item.slot_id)).length, initialization_missed: checkpoints.filter(initializationMiss).length }, groups, recent: healthCheckpoints.slice(0, 20) };
}
