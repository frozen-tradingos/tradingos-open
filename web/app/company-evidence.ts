import { inferNewsSymbols, type MarketEvent, type MarketIntelligenceState } from "./market-intelligence.ts";

export type CompanyEvidenceReport = {
  symbol: string;
  checked_at: string;
  news: Array<{ evidence_ref: string; title: string; source: string; url: string | null; published_at: string; received_at: string }>;
  earnings: Array<{ evidence_ref: string; title: string; date: string; fetched_at: string } & NonNullable<MarketEvent["earnings_result"]>>;
  limitations: string[];
};

export function projectCompanyEvidence(symbol: string, intelligence: MarketIntelligenceState, at: string): CompanyEvidenceReport {
  const report: CompanyEvidenceReport = { symbol, checked_at: at, news: [], earnings: [], limitations: [
    "仅整理系统已有归档；空列表不代表没有消息、财报或事件。",
    "新闻只按标题提及公司归类，不能据此确认重大影响、利好或利空。",
    "财报数字沿用接口原数，币种与财期未独立核实；不推断增长或财务健康。",
  ] };
  const cutoff = Date.parse(at), day = 86_400_000;
  if (!Number.isFinite(cutoff)) { report.limitations.push("截止时间无效，未投影任何资料。"); return report; }
  const known = (value: string | null | undefined) => Number.isFinite(Date.parse(value ?? "")) && Date.parse(value!) <= cutoff;
  const fresh = (value: string | null | undefined, age: number) => known(value) && cutoff - Date.parse(value!) <= age;
  let missingReceipt = false;
  report.news = intelligence.events.filter((event) => {
    if (event.kind !== "NEWS" || !inferNewsSymbols(event.title).includes(symbol) || !fresh(event.published_at, 7 * day) || !known(event.fetched_at)) return false;
    const receipt = intelligence.eventResponseReceivedAt?.[event.event_id];
    if (!receipt || !Number.isFinite(Date.parse(receipt))) missingReceipt = true;
    return known(receipt) && Date.parse(receipt!) >= Date.parse(event.fetched_at);
  }).sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!)).slice(0, 5).map((event) => ({
    evidence_ref: `news:${event.event_id}`, title: event.title, source: event.source, url: event.source_url,
    published_at: event.published_at!, received_at: intelligence.eventResponseReceivedAt![event.event_id]!,
  }));
  if (missingReceipt) report.limitations.push("部分新闻缺少归档接收时间，无法证明截止时已取得，未纳入本次资料。");

  const calendar = intelligence.earningsCalendar;
  if (calendar && fresh(calendar.checked_at, day) && fresh(calendar.response_received_at, day)
    && Date.parse(calendar.response_received_at) >= Date.parse(calendar.checked_at)) {
    report.earnings = (intelligence.currentEarnings ?? []).filter((event) => {
      const date = event.scheduled_for;
      return event.kind === "EARNINGS" && event.source === "Finnhub Earnings Calendar" && ["earnings", "earnings_result"].includes(event.event_type)
        && event.affected_symbols.includes(symbol) && calendar.event_ids.includes(event.event_id) && event.earnings_result
        && known(event.fetched_at) && Date.parse(event.fetched_at) <= Date.parse(calendar.checked_at)
        && date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00.000Z`))
        && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
    }).slice(0, 3).map((event) => ({ evidence_ref: `earnings:${event.event_id}`, title: event.title, date: event.scheduled_for!,
      session: event.earnings_result!.session, reported: event.earnings_result!.reported,
      eps_actual: event.earnings_result!.eps_actual, eps_estimate: event.earnings_result!.eps_estimate,
      revenue_actual: event.earnings_result!.revenue_actual, revenue_estimate: event.earnings_result!.revenue_estimate, fetched_at: event.fetched_at,
    }));
  } else report.limitations.push("缺少截止时有效且最近 24 小时内取得的财报日历，历史日程未自动恢复为当前事件。");
  return report;
}
