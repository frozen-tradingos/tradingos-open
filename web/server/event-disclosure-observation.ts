import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { formatPtDateTime } from "../app/market-time.ts";

// Reviewed phase-one input only. A later source revision needs review and a new hash;
// this reader does not visit websites, collect prices or turn research into a signal.
export const EVENT_DISCLOSURE_INPUT_HASH = "e1e77ba020d891ec1db26f7a184e20c09bf76cd9f1bfdc96b3376a6af041e164";
const events = { "ISRG-Q3-2026-CALL": "ISRG", "RXRX-TUPELO-CGAIGC-2026": "RXRX", "TEM-ESMO-2026": "TEM", "VEEV-STUDY-BUILDER-2026": "VEEV" } as const;
const maxBytes = 65_536;
type Row = Record<string, unknown>;
type Time = { value: string | null; precision: "MINUTE" | "DATE" | "MONTH" | "UNKNOWN"; timezone: string | null; note: string };
type Source = { id: string; url: string; title: string; published_at: Time; observed_at: string };
type Timeline = Time & { label: string; role: string; source_id: string | null };
export type EventObservationMarket = { snapshot: unknown; market_snapshot_id: string | null; market_snapshot_hash: string | null; archived_at?: string | null };
const requireValue: (condition: unknown) => asserts condition = (condition) => { if (!condition) throw Error("EVENT_OBSERVATION_INVALID"); };
const object = (value: unknown): Row => { requireValue(value && typeof value === "object" && !Array.isArray(value)); return value as Row; };
const text = (value: unknown, length = 1000): string => { requireValue(typeof value === "string" && value.trim() && value.length <= length); return value; };
const list = (value: unknown, max: number): unknown[] => { requireValue(Array.isArray(value) && value.length <= max); return value; };
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function instant(value: unknown): number {
  const match = text(value, 40).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
  requireValue(match && validDate(match[1]) && +match[2] < 24 && +match[3] < 60 && +(match[4] ?? 0) < 60 && Number.isFinite(Date.parse(String(value))));
  return Date.parse(String(value));
}
function localParts(at: number, zone: string) {
  requireValue(zone === "UTC" || /^[A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/.test(zone));
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
}
// Same precision/DST rules as the reviewed phase-one report; no executable imports from data/.
function time(value: unknown): Time {
  const row = object(value), precision = row.precision;
  requireValue(["MINUTE", "DATE", "MONTH", "UNKNOWN"].includes(String(precision)));
  const note = text(row.note), timezone = row.timezone === null ? null : text(row.timezone, 80);
  if (timezone) localParts(0, timezone);
  if (precision === "UNKNOWN") { requireValue(row.value === null && timezone === null); return { value: null, precision, timezone, note }; }
  const stamp = text(row.value, 40);
  if (precision === "DATE") requireValue(validDate(stamp));
  if (precision === "MONTH") requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(stamp));
  if (precision === "MINUTE") {
    requireValue(timezone); const parts = localParts(instant(stamp), timezone), match = stamp.match(/^(.{16})(?::(\d{2}))?/)!;
    requireValue(`${match[1]}:${match[2] ?? "00"}` === `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`);
  }
  return { value: stamp, precision: precision as Time["precision"], timezone, note };
}
function knownBy(value: Time, observed: number) {
  if (value.value === null) return true;
  if (value.precision === "MINUTE") return instant(value.value) <= observed;
  if (value.timezone) { const p = localParts(observed, value.timezone); return value.value <= `${p.year}-${p.month}-${p.day}`.slice(0, value.value.length); }
  return Date.parse(`${value.value}${value.precision === "MONTH" ? "-01" : ""}T00:00:00Z`) - 14 * 3_600_000 <= observed;
}
function marketFor(symbol: string, input: EventObservationMarket | null, cutoff: number) {
  try {
    requireValue(input); const snapshot = object(input.snapshot), generated = instant(snapshot.generated_at);
    requireValue(generated <= cutoff && (!input.archived_at || instant(input.archived_at) <= cutoff));
    requireValue(typeof input.market_snapshot_hash === "string" && /^[a-f0-9]{64}$/.test(input.market_snapshot_hash));
    const snapshotId = text(input.market_snapshot_id, 200), rows = list(object(snapshot.fixed_pool).rows, 90);
    const matches = rows.filter((value) => object(value).symbol === symbol); requireValue(matches.length === 1);
    const row = object(matches[0]); requireValue(instant(row.as_of) <= generated && ["LIVE", "MARKET_CLOSED", "STALE"].includes(String(row.status)));
    const frames = object(row.timeframes), timeframes = [];
    for (const [key, label] of [["daily", "日线"], ["four_hour", "4小时"], ["one_hour", "1小时"], ["thirty_minute", "30分钟"]]) {
      try {
        const frame = object(frames[key]); requireValue(frame.available === true && instant(frame.data_cutoff) <= generated && ["放量", "缩量", "正常", "未观察到"].includes(String(frame.volume_context)));
        timeframes.push({ timeframe: label, data_cutoff: String(frame.data_cutoff), volume_context: String(frame.volume_context) });
      } catch { /* A missing/future frame stays absent rather than inheriting another frame's date. */ }
    }
    return { source_snapshot_id: snapshotId, source_snapshot_hash: input.market_snapshot_hash, generated_at: String(snapshot.generated_at), archived_at: input.archived_at ?? null,
      as_of: String(row.as_of), status: String(row.status), last: typeof row.last === "number" && Number.isFinite(row.last) && row.last > 0 ? row.last : null,
      change_pct: typeof row.change_pct === "number" && Number.isFinite(row.change_pct) ? row.change_pct : null, timeframes,
      volume_definition: "最新完整K线成交量／前20根K线非空成交量均值；≥1.35放量，≤0.75缩量。仅存标签，不是当日量／50日均量。data_cutoff是末根完整K线起始标签，不是结束、披露或收到时间。", rvol_50day: null };
  } catch { return null; }
}
type EventCard = { evidence_ref: string; event_id: string; revision: number; symbol: string; title: string; summary: string; novelty: string; state: string; recorded_at: string;
  sources: Source[]; timeline: Timeline[]; natural_received_at: null; market: ReturnType<typeof marketFor>; reaction: string; pullback: { state: "INSUFFICIENT_EVIDENCE"; reason: string }; missing: string[]; research_only: true; actionable: false };
export type EventDisclosureObservation = { status: "OBSERVED" | "UNAVAILABLE"; frozen_at: string; input_sha256: string | null; reason: string; cards: EventCard[]; research_only: true; actionable: false };
const unavailable = (frozenAt: string): EventDisclosureObservation => ({ status: "UNAVAILABLE", frozen_at: frozenAt, input_sha256: null, reason: "事件观察证据缺失、未到登记时间或未通过核验；现有选单继续使用原证据。", cards: [], research_only: true, actionable: false });

export function projectEventDisclosureObservation(raw: string, frozenAt: string, market: EventObservationMarket | null, expectedHash = EVENT_DISCLOSURE_INPUT_HASH): EventDisclosureObservation {
  try {
    const cutoff = instant(frozenAt); requireValue(Buffer.byteLength(raw) <= maxBytes);
    const hash = createHash("sha256").update(raw).digest("hex"); requireValue(hash === expectedHash);
    const lines = raw.split(/\r?\n/).filter((line) => line.trim()); requireValue(lines.length > 0 && lines.length <= 16);
    const latest = new Map<string, EventCard>();
    for (const line of lines) {
      const row = object(JSON.parse(line)), recorded = instant(row.recorded_at);
      if (recorded > cutoff) continue;
      const eventId = text(row.event_id, 100), symbol = events[eventId as keyof typeof events]; requireValue(symbol && row.symbol === symbol);
      const previous = latest.get(eventId); requireValue(Number.isSafeInteger(row.revision) && row.revision === (previous?.revision ?? 0) + 1 && (!previous || recorded > instant(previous.recorded_at)));
      const state = text(row.state, 30); requireValue(["SCHEDULED", "DISCLOSED", "UNVERIFIED", "POSTPONED", "CANCELLED"].includes(state));
      const sources: Source[] = list(row.sources, 4).map((value) => {
        const source = object(value), url = new URL(text(source.url, 2048)); requireValue(url.protocol === "https:" && !url.username && !url.password);
        const observed = instant(source.observed_at), publishedAt = time(source.published_at); requireValue(observed <= recorded && knownBy(publishedAt, observed));
        return { id: text(source.id, 100), title: text(source.title, 200), url: url.href, published_at: publishedAt, observed_at: String(source.observed_at) };
      });
      requireValue(sources.length && new Set(sources.map((s) => s.id)).size === sources.length);
      const timeline: Timeline[] = list(row.timeline, 8).map((value) => {
        const entry = object(value), stamp = time(entry), source = sources.find((s) => s.id === entry.source_id), role = text(entry.role, 30);
        requireValue(["EVENT", "DISCLOSURE_PLAN", "DISCLOSURE_ACTUAL", "AVAILABILITY"].includes(role));
        requireValue(source || entry.source_id === null && stamp.precision === "UNKNOWN");
        if (role === "DISCLOSURE_ACTUAL" && stamp.value !== null) requireValue(source && knownBy(stamp, instant(source.observed_at)));
        return { ...stamp, label: text(entry.label, 120), role, source_id: source?.id ?? null };
      });
      const disclosed = timeline.some((entry) => entry.role === "DISCLOSURE_ACTUAL" && entry.value !== null);
      requireValue(state !== "DISCLOSED" || disclosed);
      requireValue(state !== "SCHEDULED" || timeline.some((entry) => ["EVENT", "DISCLOSURE_PLAN"].includes(entry.role) && entry.value !== null));
      latest.set(eventId, { evidence_ref: `event-observation:${eventId}:r${row.revision}`, event_id: eventId, revision: Number(row.revision), symbol, title: text(row.title, 200), summary: text(row.summary), novelty: text(row.novelty), state, recorded_at: String(row.recorded_at), sources, timeline, natural_received_at: null,
        market: marketFor(symbol, market, cutoff), reaction: "最近行情，尚未确认事件后反应；不能把旧日线放量与新报价合成消息后反应。",
        pullback: { state: "INSUFFICIENT_EVIDENCE", reason: "没有与实际披露时刻对应的完整前序个股分钟线；不能认定首次回调、即时突破或成交。" },
        missing: list(row.missing, 10).map((value) => text(value, 300)), research_only: true, actionable: false });
    }
    return latest.size ? { status: "OBSERVED", frozen_at: frozenAt, input_sha256: hash, reason: "四事件只读观察；人工登记不等于自然收到，不作为方向、买入或退出信号。", cards: [...latest.values()], research_only: true, actionable: false } : unavailable(frozenAt);
  } catch { return unavailable(frozenAt); }
}

export function readEventDisclosureObservation(dataRoot: string, frozenAt: string, market: EventObservationMarket | null): EventDisclosureObservation {
  let fd: number | undefined;
  try {
    const path = resolve(dataRoot, "research/event-disclosure-phase1-20260927/events-20261001-e1e77ba020d891ec1db26f7a184e20c09bf76cd9f1bfdc96b3376a6af041e164.jsonl"), info = lstatSync(path);
    requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= maxBytes);
    fd = openSync(path, "r"); const opened = fstatSync(fd); requireValue(opened.isFile() && opened.size <= maxBytes);
    const bytes = Buffer.alloc(maxBytes + 1), count = readSync(fd, bytes, 0, bytes.length, 0); requireValue(count <= maxBytes && count === opened.size);
    return projectEventDisclosureObservation(bytes.subarray(0, count).toString("utf8"), frozenAt, market);
  } catch { return unavailable(frozenAt); } finally { if (fd !== undefined) closeSync(fd); }
}

const escapeHtml = (value: unknown) => String(value ?? "未知").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function displayTime(value: Time) { return value.value === null ? "待核实" : value.precision === "MINUTE" ? formatPtDateTime(value.value) : `${value.value}（${value.precision === "DATE" ? "仅日期" : "仅月份"}；${value.timezone ?? "源时区未知"}）`; }
export function renderEventDisclosureObservation(report: string, observation: EventDisclosureObservation) {
  const cards = observation.cards.map((card) => {
    const planned = card.timeline.find((entry) => entry.role === "EVENT" && entry.value), actual = card.timeline.find((entry) => entry.role === "DISCLOSURE_ACTUAL" && entry.value);
    return `<article><h3>${escapeHtml(card.symbol)} · ${escapeHtml(card.title)}</h3><p>计划活动：${escapeHtml(planned ? displayTime(planned) : "待核实")}</p>
      <p>真正披露：${escapeHtml(actual ? displayTime(actual) : "尚未核实")}</p>
      ${card.market ? `<p>最近归档价格 ${card.market.last === null ? "未核验" : `$${card.market.last.toFixed(2)}`} · 较前收 ${card.market.change_pct === null ? "未核验" : `${card.market.change_pct > 0 ? "+" : ""}${card.market.change_pct.toFixed(2)}%`} · ${escapeHtml(({ LIVE: "采集时可用", MARKET_CLOSED: "市场已收盘", STALE: "旧行情" } as Record<string, string>)[card.market.status])}<br>报价截至 ${escapeHtml(formatPtDateTime(card.market.as_of))}；尚未确认事件后反应。</p>` : "<p>对应行情尚未核验，不能判断事件后反应。</p>"}
      <p>首次回调：缺少对应披露时刻及连续分钟证据，暂不能判断。</p>
      <details><summary>查看时间与证据</summary><p>${escapeHtml(card.summary)}</p><p>新旧信息：${escapeHtml(card.novelty)}</p>
      <ul>${card.timeline.map((entry) => `<li>${escapeHtml(entry.label)}：${escapeHtml(displayTime(entry))}；${escapeHtml(entry.note)}</li>`).join("")}</ul>
      <p>本地人工登记：${escapeHtml(card.recorded_at)}；自然收到时间未知。</p><ul>${card.sources.map((source) => `<li><a href="${escapeHtml(source.url)}" rel="noreferrer">${escapeHtml(source.title)}</a> · 来源发布时间：${escapeHtml(displayTime(source.published_at))} · 人工阅读：${escapeHtml(source.observed_at)}</li>`).join("")}</ul>
      ${card.market ? `<ul>${card.market.timeframes.map((frame) => `<li>${escapeHtml(frame.timeframe)}：${escapeHtml(frame.volume_context)} · 末根完整K线起始 ${escapeHtml(frame.data_cutoff)}</li>`).join("")}</ul><p>${escapeHtml(card.market.volume_definition)}</p>` : ""}
      <p>${escapeHtml(card.reaction)}</p><ul>${card.missing.map((gap) => `<li>${escapeHtml(gap)}</li>`).join("")}</ul><p>没有50日量比原始值、可追溯float及成交证明；点差、滑点和费用尚不能核算，不报告策略胜率或收益。</p><code>${escapeHtml(card.evidence_ref)}</code></details></article>`;
  }).join("");
  const html = `<section id="event-reaction-observation"><h2>公司消息与股价反应</h2><p>官网资料仍需人工复核；仅观察，不是买卖信号。</p>${observation.cards.length ? "" : `<p>${escapeHtml(observation.reason)}</p>`}${cards}<small>本次读取截至 ${escapeHtml(Number.isFinite(Date.parse(observation.frozen_at)) ? formatPtDateTime(observation.frozen_at) : "待核验")}</small></section>`;
  const tag = /<main\b[^>]*>/i.test(report) ? "main" : "body";
  return report.replace(new RegExp(`<${tag}\\b[^>]*>`, "i"), (opening) => `${opening}${html}<details id="phase-one-static-report"><summary>查看一期原始静态报告与历史修订</summary>`).replace(new RegExp(`</${tag}\\s*>`, "i"), `</details></${tag}>`);
}
