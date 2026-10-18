export const OWNER_TIME_ZONE = "America/Los_Angeles";
export const EXCHANGE_TIME_ZONE = "America/New_York";
export const MARKET_5M_MAX_AGE_SECONDS = 420;

const ptClock = new Intl.DateTimeFormat("en-GB", { timeZone: OWNER_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const ptDateTime = new Intl.DateTimeFormat("zh-CN", { timeZone: OWNER_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const etDateTime = new Intl.DateTimeFormat("zh-CN", { timeZone: EXCHANGE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const etAxis = new Intl.DateTimeFormat("en-US", { timeZone: EXCHANGE_TIME_ZONE, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const ptScheduleParts = new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIME_ZONE, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const etScheduleParts = new Intl.DateTimeFormat("en-US", { timeZone: EXCHANGE_TIME_ZONE, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-07-02", "2027-11-26", "2028-07-03", "2028-11-24"]); // NYSE official 2026-2028 calendar.

function date(value: string | number | Date) {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error("时间必须是有效的 ISO 8601 值");
  return result;
}

export function utcIso(value: string | number | Date) {
  return date(value).toISOString();
}

export function formatPtTime(value: string | number | Date) {
  return ptClock.format(date(value));
}

export function formatPtDateTime(value: string | number | Date) {
  return `${ptDateTime.format(date(value))} 加州时间`;
}

export function formatEtDateTime(value: string | number | Date) {
  return `${etDateTime.format(date(value))} 美东时间`;
}

export function formatEtAxisTimestamp(timestampSeconds: number) {
  return etAxis.format(date(timestampSeconds * 1_000));
}

function parts(formatter: Intl.DateTimeFormat, value: string | number | Date) {
  return Object.fromEntries(formatter.formatToParts(date(value)).map((part) => [part.type, part.value]));
}

function dateFromKey(value: string) { const [year, month, day] = value.split("-").map(Number); return new Date(Date.UTC(year, month - 1, day)); }
function key(value: Date) { return value.toISOString().slice(0, 10); }
function addDays(value: string, days: number) { const result = dateFromKey(value); result.setUTCDate(result.getUTCDate() + days); return key(result); }
function weekday(value: string) { return dateFromKey(value).getUTCDay(); }
function nthWeekday(year: number, month: number, day: number, occurrence: number) { const first = new Date(Date.UTC(year, month - 1, 1)); return key(new Date(Date.UTC(year, month - 1, 1 + (day - first.getUTCDay() + 7) % 7 + 7 * (occurrence - 1)))); }
function lastWeekday(year: number, month: number, day: number) { const last = new Date(Date.UTC(year, month, 0)); last.setUTCDate(last.getUTCDate() - (last.getUTCDay() - day + 7) % 7); return key(last); }
function observed(value: string) { const day = weekday(value); return day === 6 ? addDays(value, -1) : day === 0 ? addDays(value, 1) : value; }
function easter(year: number) { const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),day=(h+l-7*m+114)%31+1; return key(new Date(Date.UTC(year,month-1,day))); }

export function ptDateKey(value: string | number | Date) { const item = parts(ptScheduleParts, value); return `${item.year}-${item.month}-${item.day}`; }
export function exchangeDateKey(value: string | number | Date) { const item = parts(etScheduleParts, value); return `${item.year}-${item.month}-${item.day}`; }

export function isNyseRegularSession(dateKey: string) {
  const year = Number(dateKey.slice(0, 4)), day = weekday(dateKey);
  if (day === 0 || day === 6) return false;
  const newYear = `${year}-01-01`;
  const nextNewYearObserved = observed(`${year + 1}-01-01`);
  const holidays = new Set([
    ...(weekday(newYear) === 6 ? [] : [observed(newYear)]), nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), addDays(easter(year), -2),
    lastWeekday(year, 5, 1), ...(year >= 2022 ? [observed(`${year}-06-19`)] : []), observed(`${year}-07-04`), nthWeekday(year, 9, 1, 1), nthWeekday(year, 11, 4, 4), observed(`${year}-12-25`), ...(nextNewYearObserved.startsWith(`${year}-`) ? [nextNewYearObserved] : []),
  ]);
  return !holidays.has(dateKey);
}

export function nyseClosePtMinutes(dateKey: string) { return EARLY_CLOSES.has(dateKey) ? 600 : 780; }
export function mostRecentNyseRegularDate(dateKey: string) { let candidate = dateKey; while (!isNyseRegularSession(candidate)) candidate = addDays(candidate, -1); return candidate; }
export function nextNyseRegularDate(dateKey: string) { let candidate = dateKey; while (!isNyseRegularSession(candidate)) candidate = addDays(candidate, 1); return candidate; }
export function nextNyseRegularDateAfter(dateKey: string) { return nextNyseRegularDate(addDays(dateKey, 1)); }

export type RobinhoodSessionPhase = "PREMARKET" | "REGULAR" | "AFTER_HOURS" | "OVERNIGHT" | "CLOSED";
export type SpxOptionSession = "RTH" | "CURB" | "GTH" | "CLOSED";

export function spxOptionSessionAt(value: string | number | Date) {
  const item = parts(etScheduleParts, value), calendarDate = `${item.year}-${item.month}-${item.day}`, minutes = Number(item.hour) * 60 + Number(item.minute);
  const regular = isNyseRegularSession(calendarDate), nextCalendarDate = addDays(calendarDate, 1), nextTradingDate = nextNyseRegularDate(nextCalendarDate);
  const regularEnd = EARLY_CLOSES.has(calendarDate) ? 780 : 975;
  let session: SpxOptionSession = "CLOSED", tradingDate = calendarDate;
  if (regular && minutes < 565) session = "GTH";
  else if (regular && minutes >= 570 && minutes < regularEnd) session = "RTH";
  else if (regular && !EARLY_CLOSES.has(calendarDate) && minutes >= 975 && minutes < 1_020) session = "CURB";
  else if (minutes >= 1_215 && nextTradingDate === nextCalendarDate) { session = "GTH"; tradingDate = nextTradingDate; }
  return { session, trading_date: tradingDate, calendar_date: calendarDate, timezone: EXCHANGE_TIME_ZONE as typeof EXCHANGE_TIME_ZONE };
}

export function robinhoodSessionAt(value: string | number | Date) {
  const item = parts(etScheduleParts, value), calendarDate = `${item.year}-${item.month}-${item.day}`, minutes = Number(item.hour) * 60 + Number(item.minute);
  const regular = isNyseRegularSession(calendarDate), regularClose = nyseClosePtMinutes(calendarDate) + 180, extendedClose = regularClose < 960 ? 1_020 : 1_200;
  const nextCalendarDate = addDays(calendarDate, 1), nextTradingDate = nextNyseRegularDate(nextCalendarDate);
  let phase: RobinhoodSessionPhase = "CLOSED", tradingDate = calendarDate;
  if (regular && minutes < 420) phase = "OVERNIGHT";
  else if (regular && minutes < 570) phase = "PREMARKET";
  else if (regular && minutes < regularClose) phase = "REGULAR";
  else if (regular && minutes < extendedClose) phase = "AFTER_HOURS";
  else if (minutes >= 1_200 && nextTradingDate === nextCalendarDate) { phase = "OVERNIGHT"; tradingDate = nextTradingDate; }
  return { phase, trading_date: tradingDate, calendar_date: calendarDate, timezone: EXCHANGE_TIME_ZONE as typeof EXCHANGE_TIME_ZONE };
}

export function latestCompletedNyseSession(value: string | number | Date) {
  const item = parts(etScheduleParts, value), dateKey = `${item.year}-${item.month}-${item.day}`, minutes = Number(item.hour) * 60 + Number(item.minute);
  if (isNyseRegularSession(dateKey) && minutes >= nyseClosePtMinutes(dateKey) + 180) return dateKey;
  return mostRecentNyseRegularDate(addDays(dateKey, -1));
}

export function isPtShadowWindow(value: Date) {
  const item = parts(ptScheduleParts, value), dateKey = `${item.year}-${item.month}-${item.day}`;
  const minutes = Number(item.hour) * 60 + Number(item.minute);
  return isNyseRegularSession(dateKey) && minutes >= 395 && minutes < nyseClosePtMinutes(dateKey);
}
