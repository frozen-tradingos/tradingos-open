// Append-only reviewed facts: historical PAPER validation depends on retaining these exact records.
// ponytail: this fills verified calendar gaps; use an official scheduled-event feed for ongoing coverage.
// These are scheduled events, not A1 observations, policy outcomes, or directional predictions.
const reviewedAt = "2026-09-18T06:58:58.033Z";
const reviewedSep21At = "2026-09-20T22:02:53.696Z";
export const REVIEWED_MARKET_EVENTS = Object.freeze([...([
  { release_name: "Quarterly Equity Index Expiration", label: "季度集中到期日", scheduled_at: "2026-09-18", time_precision: "DATE_ONLY", source_url: "https://www.cmegroup.com/trading/equity-index/rolldates.html", source_record_id: "reviewed-schedule:20260918:quarterly-expiry:v1" },
  { release_name: "Industrial Production and Capacity Utilization", label: "工业产出及产能利用率", scheduled_at: "2026-09-18T13:15:00Z", time_precision: "EXACT", source_url: "https://www.federalreserve.gov/newsevents/2026-september.htm", source_record_id: "reviewed-schedule:20260918:g17:v1" },
  { release_name: "Michelle Bowman Speech: Stress Testing", label: "Bowman 讲话：银行压力测试", scheduled_at: "2026-09-18T13:30:00Z", time_precision: "EXACT", source_url: "https://www.federalreserve.gov/newsevents/2026-september.htm", source_record_id: "reviewed-schedule:20260918:bowman:v1" },
  { release_name: "US Leading Economic Index", label: "美国领先经济指标 LEI", scheduled_at: "2026-09-18T14:00:00Z", time_precision: "EXACT", source_url: "https://www.conference-board.org/topics/us-leading-indicators/", source_record_id: "reviewed-schedule:20260918:lei:v1" },
] as const).map((event) => Object.freeze({ ...event, market_date: "2026-09-18", observed_at: reviewedAt, received_at: reviewedAt, as_of: reviewedAt, confidence: "REVIEWED_OFFICIAL_SCHEDULE" })), ...([
  { release_name: "Austan Goolsbee Speech: Monetary Policy in an Uncertain World", label: "Goolsbee 讲话：不确定世界中的货币政策", scheduled_at: "2026-09-21T10:30:00Z", time_precision: "EXACT", source_url: "https://www.chicagofed.org/publications/speeches/2026/sept-21-omfif", source_record_id: "reviewed-schedule:20260921:goolsbee:v1" },
  { release_name: "Chicago Fed National Activity Index", label: "芝加哥联储全国活动指数 CFNAI", scheduled_at: "2026-09-21T12:30:00Z", time_precision: "EXACT", source_url: "https://www.chicagofed.org/research/data/data-release-calendar", source_record_id: "reviewed-schedule:20260921:cfnai:v1" },
  { release_name: "SCE Household Spending Survey", label: "纽约联储家庭支出调查", scheduled_at: "2026-09-21T15:00:00Z", time_precision: "EXACT", source_url: "https://www.newyorkfed.org/research/calendars/i-sep26.html", source_record_id: "reviewed-schedule:20260921:sce-household-spending:v1" },
] as const).map((event) => Object.freeze({ ...event, market_date: "2026-09-21", observed_at: reviewedSep21At, received_at: reviewedSep21At, as_of: reviewedSep21At, confidence: "REVIEWED_OFFICIAL_SCHEDULE" }))]);
