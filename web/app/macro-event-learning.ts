import { formatPtTime, latestCompletedNyseSession, mostRecentNyseRegularDate, ptDateKey } from "./market-time.ts";
import type { OfficialMacroContext } from "./snapshot-import.ts";
import { REVIEWED_MARKET_EVENTS } from "./reviewed-market-events.ts";

export const MACRO_EVENT_LEARNING_CONTRACT = "MACRO_EVENT_LEARNING_SHADOW_V1" as const;

export type MacroEventEvidenceRow = {
  record_id: string;
  observed_at: string;
  role: "LATEST" | "EVENING";
  official_macro: OfficialMacroContext;
  quotes: Array<{ symbol: string; last: number | null; previous_close: number | null; as_of: string | null }>;
  sector_advance_pct: number | null;
};

export type MacroEventLearningStudy = {
  study_id: string;
  release_name: "Employment Situation" | "FOMC Meeting Decision";
  scheduled_at: string;
  stage: "PREVIEW" | "FREEZE_PENDING" | "FROZEN" | "WAITING_RESULT" | "REVIEWED" | "NOT_FROZEN" | "RECONSTRUCTED_RESEARCH";
  source_record_id: string | null;
  frozen_at: string | null;
  probability_grade: "UNCALIBRATED_SHADOW";
  call: { outcome: "UP" | "HOLD"; label: string; probability_pct: number; alternative_label: string; alternative_probability_pct: number } | null;
  evidence: string[];
  falsifiers: string[];
  scenarios: Array<{ condition: string; rates: string; spy: string; qqq: string }>;
  review: null | { verdict: "CORRECT" | "WRONG" | "INCONCLUSIVE"; summary: string; market_reaction: string | null };
  limitations: string[];
};

export type MacroEventLearningOverview = {
  contract_version: typeof MACRO_EVENT_LEARNING_CONTRACT;
  mode: "SHADOW";
  actionable: false;
  studies: MacroEventLearningStudy[];
  calendar?: { source_record_id: string; as_of: string; events: OfficialMacroContext["events"] } | null;
  special_days?: SpecialDay[];
  entry_special_days?: SpecialDay[];
};

const specialDayLabels = {
  "FOMC Meeting Decision": "FOMC 议息日",
  "Consumer Price Index": "CPI 公布日",
  "Producer Price Index": "PPI 公布日",
  "Employment Situation": "非农就业日",
  "Personal Income and Outlays": "PCE 通胀日",
  "Gross Domestic Product": "GDP 公布日",
} as const;

export type SpecialDay = {
  market_date: string; label: string; source_url: string; source_record_id: string;
  observed_at: string; received_at: string; as_of: string;
  release_name: keyof typeof specialDayLabels | (typeof REVIEWED_MARKET_EVENTS)[number]["release_name"]; scheduled_at: string; time_precision: "DATE_ONLY" | "EXACT"; confidence: string;
};

export type SpecialDaySource = { source_record_id: string; source_mode: string; observed_at: string; received_at: string; as_of: string; events: OfficialMacroContext["events"]; coverage?: OfficialMacroContext["coverage"] };

function validCalendarDate(value: string) {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function timestamp(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && validCalendarDate(value.slice(0, 10)) ? Date.parse(value) : NaN;
}

function knownSource(source: { source_record_id?: unknown; observed_at?: unknown; received_at?: unknown; as_of?: unknown }, at: string | number | Date) {
  const now = new Date(at).getTime();
  return Number.isFinite(now) && typeof source.source_record_id === "string" && /^live-shadow:\d{8}T\d{6}Z:A1$/.test(source.source_record_id)
    && [source.observed_at, source.received_at, source.as_of].every((item) => Number.isFinite(timestamp(item)) && timestamp(item) <= now)
    && timestamp(source.observed_at) <= timestamp(source.received_at) && timestamp(source.as_of) <= timestamp(source.received_at);
}

/** Revalidate frozen event provenance at entry time; a calendar event is not a policy outcome. */
export function isKnownSpecialDay(value: unknown, at: string | number | Date): value is SpecialDay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const day = value as Record<string, unknown>;
  const reviewed = REVIEWED_MARKET_EVENTS.find((event) => event.source_record_id === day.source_record_id);
  if (reviewed) return timestamp(reviewed.received_at) <= new Date(at).getTime()
    && Object.keys(day).length === Object.keys(reviewed).length && Object.entries(reviewed).every(([key, expected]) => Object.hasOwn(day, key) && day[key] === expected);
  if (!knownSource(day, at) || typeof day.release_name !== "string" || !Object.hasOwn(specialDayLabels, day.release_name)
    || day.label !== specialDayLabels[day.release_name as keyof typeof specialDayLabels] || typeof day.confidence !== "string"
    || typeof day.scheduled_at !== "string" || !validCalendarDate(day.scheduled_at.slice(0, 10))) return false;
  if (day.time_precision === "DATE_ONLY") {
    if (day.scheduled_at !== day.scheduled_at.slice(0, 10) && !Number.isFinite(timestamp(day.scheduled_at))) return false;
  } else if (day.time_precision !== "EXACT" || !Number.isFinite(timestamp(day.scheduled_at))) return false;
  if (day.confidence.endsWith("_date_only") && day.time_precision !== "DATE_ONLY") return false;
  if (day.market_date !== (day.time_precision === "DATE_ONLY" ? day.scheduled_at.slice(0, 10) : ptDateKey(day.scheduled_at))) return false;
  try {
    if (typeof day.source_url !== "string") return false;
    const url = new URL(day.source_url);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (day.release_name === "FOMC Meeting Decision") return ["federalreserve.gov", "www.federalreserve.gov"].includes(url.hostname);
    if (["Gross Domestic Product", "Personal Income and Outlays"].includes(day.release_name)) return ["bea.gov", "www.bea.gov", "apps.bea.gov"].includes(url.hostname);
    if (["bls.gov", "www.bls.gov"].includes(url.hostname)) return true;
    const fredId = ({ "Consumer Price Index": "10", "Producer Price Index": "46", "Employment Situation": "50" } as Record<string, string>)[day.release_name];
    return url.hostname === "fred.stlouisfed.org" && url.pathname === "/releases/calendar" && url.searchParams.getAll("rid").length === 1
      && url.searchParams.get("rid") === fredId && day.time_precision === "DATE_ONLY" && day.confidence === "official_federal_reserve_aggregator_date_only";
  } catch { return false; }
}

/** Calendar annotations from archived sources, not proof of an entry-time decision or risk flag. */
function buildSourceSpecialDays(sources: SpecialDaySource[], at: string | number | Date): SpecialDay[] {
  const now = new Date(at).getTime(), days = new Map<string, SpecialDay>();
  if (!Number.isFinite(now)) return [];
  const eligible = sources.filter((source) => source.source_mode === "LIVE" && knownSource(source, at));
  for (const source of eligible.toSorted((a, b) => timestamp(b.observed_at) - timestamp(a.observed_at) || b.source_record_id.localeCompare(a.source_record_id))) {
    for (const event of Array.isArray(source.events) ? source.events : []) {
      if (!event || typeof event.scheduled_at !== "string" || !validCalendarDate(event.scheduled_at.slice(0, 10))) continue;
      const time_precision = event.time_precision;
      if (time_precision !== "DATE_ONLY" && time_precision !== "EXACT") continue;
      if (time_precision !== "DATE_ONLY" && !Number.isFinite(timestamp(event.scheduled_at))) continue;
      const day = { market_date: time_precision === "DATE_ONLY" ? event.scheduled_at.slice(0, 10) : ptDateKey(event.scheduled_at), label: specialDayLabels[event.release_name as keyof typeof specialDayLabels], source_url: event.source_url, source_record_id: source.source_record_id, observed_at: source.observed_at, received_at: source.received_at, as_of: source.as_of, release_name: event.release_name, scheduled_at: event.scheduled_at, time_precision, confidence: event.confidence ?? "" };
      if (!isKnownSpecialDay(day, at)) continue;
      const key = `${day.market_date}:${day.release_name}`;
      if (!days.has(key)) days.set(key, day);
    }
  }
  return [...days.values()].toSorted((a, b) => a.market_date.localeCompare(b.market_date) || a.release_name.localeCompare(b.release_name));
}

/** Reviewed supplements have independent provenance and never manufacture a LIVE A1 source. */
export function buildSpecialDays(sources: SpecialDaySource[], at: string | number | Date): SpecialDay[] {
  return [...buildSourceSpecialDays(sources, at), ...REVIEWED_MARKET_EVENTS.filter((day) => isKnownSpecialDay(day, at)).map((day) => ({ ...day }))]
    .toSorted((a, b) => a.market_date.localeCompare(b.market_date) || a.scheduled_at.localeCompare(b.scheduled_at) || a.release_name.localeCompare(b.release_name));
}

/** Missing current rows do not cancel a known same-day event; unknown coverage cannot establish an ordinary day. */
export function buildEntrySpecialDays(source: SpecialDaySource | undefined, at: string | number | Date, knownDays: SpecialDay[] = []): SpecialDay[] | undefined {
  if (!Number.isFinite(new Date(at).getTime())) return undefined;
  const cutoff = latestCompletedNyseSession(at);
  const reviewed = REVIEWED_MARKET_EVENTS.filter((day) => day.market_date === ptDateKey(at) && isKnownSpecialDay(day, at)).map((day) => ({ ...day }));
  const known = knownDays.filter((day) => day.market_date === ptDateKey(at) && isKnownSpecialDay(day, at)
    && ptDateKey(day.observed_at) >= cutoff && ptDateKey(day.as_of) >= cutoff);
  const positives = [...new Map([...known, ...reviewed].map((day) => [day.release_name, day])).values()];
  const verifiedPositive = positives.length ? positives : undefined;
  if (!source || source.source_mode !== "LIVE" || !knownSource(source, at) || !Array.isArray(source.events)) return verifiedPositive;
  if (ptDateKey(source.observed_at) < cutoff || ptDateKey(source.as_of) < cutoff) return verifiedPositive;
  const days = [...new Map([...positives, ...buildSourceSpecialDays([source], at).filter((day) => day.market_date === ptDateKey(at))].map((day) => [day.release_name, day])).values()];
  if (days.length) return days;
  if (source.events.some((event) => event && Object.hasOwn(specialDayLabels, event.release_name) && buildSourceSpecialDays([{ ...source, events: [event] }], at).length === 0)) return undefined;
  if ((["inflation", "employment", "central_bank", "growth"] as const).every((key) => source.coverage?.[key] === "LIVE")) return days;
  return undefined;
}

type MacroEvent = { event_id?: unknown; release_name?: unknown; scheduled_at?: unknown };
type MacroResult = { status?: unknown; release_name?: unknown; scheduled_at?: unknown; metrics?: unknown; decision?: unknown };

function previousDay(dateKey: string) {
  const value = new Date(`${dateKey}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return mostRecentNyseRegularDate(value.toISOString().slice(0, 10));
}

function metric(context: OfficialMacroContext, id: string) {
  return context.observations?.find((item) => item.series_id === id) ?? null;
}

function officialMarketMetric(context: OfficialMacroContext, id: string) {
  return context.market_context?.treasury_yields.observations.find((item) => item.metric === id)?.value
    ?? context.market_context?.wti.observations.find((item) => item.metric === id)?.value
    ?? null;
}

function pct(value: number | null) { return value === null ? "未观察" : `${value.toFixed(2)}%`; }
function jobs(value: number) { return `${value < 0 ? "减少" : "增加"} ${Math.abs(Math.round(value * 1_000)).toLocaleString("zh-CN")} 个`; }

function prediction(releaseName: MacroEventLearningStudy["release_name"], source: MacroEventEvidenceRow) {
  const macro = source.official_macro;
  if (releaseName === "Employment Situation") {
    const payroll = metric(macro, "NONFARM_PAYROLL_CHANGE"), unemployment = metric(macro, "LNS14000000");
    if (!payroll || !unemployment) return null;
    let probability = 50;
    if (payroll.value < 0) probability += 8;
    if (unemployment.previous_value !== null && unemployment.value <= unemployment.previous_value) probability += 4;
    if ((source.sector_advance_pct ?? 0) >= 55) probability += 3;
    probability = Math.min(70, Math.max(50, Math.round(probability / 5) * 5));
    return {
      call: { outcome: "UP" as const, label: "本月新增工作岗位会比上月多", probability_pct: probability, alternative_label: "与上月差不多或更少", alternative_probability_pct: 100 - probability },
      evidence: [`上月工作岗位${jobs(payroll.value)}`, `上月失业率 ${pct(unemployment.value)}（再前一个月 ${pct(unemployment.previous_value)}）`, `保存资料时，上涨行业占比 ${pct(source.sector_advance_pct)}`],
      falsifiers: ["本月新增工作岗位没有高于上月", "失业率明显升高", "工资上涨重新加快，抵消就业人数改善"],
      scenarios: [
        { condition: "就业温和改善，失业率稳定", rates: "市场对加息的担忧略微增加", spy: "可能上涨", qqq: "可能上涨，但高利率可能压制涨幅" },
        { condition: "就业大幅走强，或工资上涨过快", rates: "市场更担心加息，短期利率可能上升", spy: "可能震荡或下跌", qqq: "可能下跌，而且通常跌得更多" },
        { condition: "就业继续减少，失业率明显上升", rates: "市场可能期待降息，但会先担心经济走弱", spy: "可能下跌", qqq: "可能下跌" },
      ],
    };
  }
  const payroll = metric(macro, "NONFARM_PAYROLL_CHANGE")?.value ?? null;
  const cpi = metric(macro, "CPI_MOM_PCT")?.value ?? null, ppi = metric(macro, "PPI_FINAL_DEMAND_MOM_PCT")?.value ?? null;
  const twoYear = officialMarketMetric(macro, "TREASURY_2Y"), oil = officialMarketMetric(macro, "WTI_CUSHING_SPOT");
  if (payroll === null || cpi === null || ppi === null) return null;
  let probability = 50;
  if (payroll < 50) probability += 5;
  if (cpi <= 0.2) probability += 6;
  if (ppi <= 0.2) probability += 4;
  if ((twoYear ?? 0) > 4.25) probability -= 3;
  if ((oil ?? 0) > 90) probability -= 5;
  probability = Math.min(70, Math.max(35, Math.round(probability / 5) * 5));
  return {
    call: { outcome: "HOLD" as const, label: "维持当前利率，不加息", probability_pct: probability, alternative_label: "提高利率", alternative_probability_pct: 100 - probability },
    evidence: [`最近一次工作岗位${jobs(payroll)}`, `消费者物价月度涨幅 ${pct(cpi)} / 生产端物价月度涨幅 ${pct(ppi)}`, `两年期美国国债利率 ${pct(twoYear)} / 原油价格 ${oil === null ? "未观察" : `$${oil.toFixed(2)}`}`],
    falsifiers: ["就业和工资都明显过热", "消费者和生产端物价重新加快上涨", "美联储在会议前明确暗示要提高利率"],
    scenarios: [
      { condition: "维持利率，也没有暗示以后会加息", rates: "短期利率可能下降", spy: "可能上涨", qqq: "可能上涨，而且通常涨得更多" },
      { condition: "维持利率，但暗示以后可能加息", rates: "短期利率可能继续处于高位", spy: "可能震荡或下跌", qqq: "可能下跌" },
      { condition: "提高利率", rates: "短期利率可能上升", spy: "可能下跌", qqq: "可能下跌，而且通常跌得更多" },
    ],
  };
}

function resultFor(study: Pick<MacroEventLearningStudy, "release_name" | "scheduled_at">, rows: MacroEventEvidenceRow[]) {
  const date = study.scheduled_at.slice(0, 10);
  for (const row of rows.toSorted((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))) {
    const results = [...(row.official_macro.results ?? []), ...(row.official_macro.policy_results ?? [])] as MacroResult[];
    const result = results.find((item) => item.status === "VERIFIED" && item.release_name === study.release_name && String(item.scheduled_at ?? "").slice(0, 10) === date);
    if (result) return { result, row };
  }
  return null;
}

function review(study: MacroEventLearningStudy, resultEvidence: ReturnType<typeof resultFor>) {
  if (!resultEvidence || !study.call) return null;
  const { result } = resultEvidence;
  let actual = "官方结果已到，但缺少可核验结果字段";
  if (study.release_name === "Employment Situation" && Array.isArray(result.metrics)) {
    const payroll = (result.metrics as Array<Record<string, unknown>>).find((item) => item.name === "PAYROLL_EMPLOYMENT_CHANGE")?.value;
    if (typeof payroll === "number" && Number.isFinite(payroll)) actual = `官方新增工作岗位 ${payroll.toLocaleString("zh-CN")} 个`;
  } else if (study.release_name === "FOMC Meeting Decision" && typeof result.decision === "string") {
    actual = `FOMC官方决定：${({ HOLD: "维持利率", HIKE: "加息", CUT: "降息" } as Record<string, string>)[result.decision] ?? "待核验"}`;
  }
  return { verdict: "INCONCLUSIVE" as const, summary: `${actual}；原判断未独立冻结，不能计为事前预测命中或失败`, market_reaction: null };
}

export function buildMacroEventLearning(rows: MacroEventEvidenceRow[], at: string | number | Date = new Date()): MacroEventLearningOverview {
  const latest = rows.filter((row) => row.role === "LATEST").toSorted((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0];
  if (!latest) return { contract_version: MACRO_EVENT_LEARNING_CONTRACT, mode: "SHADOW", actionable: false, studies: [], calendar: null };
  const today = ptDateKey(at), events = new Map<string, MacroEvent>();
  for (const row of rows.toSorted((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))) for (const raw of row.official_macro.events ?? []) {
    const event = raw as MacroEvent;
    if (!["Employment Situation", "FOMC Meeting Decision"].includes(String(event.release_name)) || typeof event.scheduled_at !== "string") continue;
    const key = `${event.release_name}:${event.scheduled_at.slice(0, 10)}`;
    if (!events.has(key)) events.set(key, event);
  }
  const studies = [...events.values()].flatMap((event) => {
    const releaseName = event.release_name as MacroEventLearningStudy["release_name"], scheduledAt = event.scheduled_at as string, eventDate = scheduledAt.slice(0, 10);
    const resultEvidence = resultFor({ release_name: releaseName, scheduled_at: scheduledAt }, rows);
    if (eventDate < today && !resultEvidence) return [];
    const freezeDate = previousDay(eventDate);
    const frozen = rows.filter((row) => row.role === "EVENING" && ptDateKey(row.observed_at) === freezeDate && row.official_macro.events.some((item) => item.release_name === releaseName && item.scheduled_at.slice(0, 10) === eventDate)).toSorted((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0] ?? null;
    const source = frozen ?? latest, projected = prediction(releaseName, source);
    const freezeDue = today > freezeDate || today === freezeDate && formatPtTime(at) >= "18:00";
    // An archived A1 freezes inputs, not the output of today's prediction() code.
    const stage: MacroEventLearningStudy["stage"] = frozen ? "RECONSTRUCTED_RESEARCH" : freezeDue ? "NOT_FROZEN" : "PREVIEW";
    const study: MacroEventLearningStudy = {
      study_id: `${MACRO_EVENT_LEARNING_CONTRACT}:${String(event.event_id ?? `${releaseName}:${eventDate}`)}:${frozen?.record_id ?? "PREVIEW"}`,
      release_name: releaseName, scheduled_at: scheduledAt, stage, source_record_id: source.record_id, frozen_at: null,
      probability_grade: "UNCALIBRATED_SHADOW", call: projected?.call ?? null, evidence: projected?.evidence ?? [], falsifiers: projected?.falsifiers ?? [], scenarios: projected?.scenarios ?? [], review: null,
      limitations: ["当前只保存了原资料，未独立保存并冻结原判断；以下为当前公式推演，不计事前预测成绩", "目前没有接入华尔街的普遍预测，因此只能判断比上月好还是差，不能判断是否超出市场预期", ...(releaseName === "FOMC Meeting Decision" ? ["旧公式没有覆盖降息，概率选项不完整，不能作为可靠政策判断"] : []), "这些概率未经校准，不能用于正式交易，也不计入正式准确率"],
    };
    study.review = review(study, resultEvidence);
    return [study];
  }).toSorted((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
  const calendarSource = rows.filter((row) => row.record_id.startsWith("live-shadow:") && Date.parse(row.observed_at) <= new Date(at).getTime() && row.official_macro.events.length).toSorted((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0];
  return { contract_version: MACRO_EVENT_LEARNING_CONTRACT, mode: "SHADOW", actionable: false, studies: studies.slice(0, 2), calendar: calendarSource ? { source_record_id: calendarSource.record_id, as_of: calendarSource.official_macro.collected_at, events: calendarSource.official_macro.events } : null };
}
