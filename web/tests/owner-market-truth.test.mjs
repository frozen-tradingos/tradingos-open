import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildEntrySpecialDays, buildMacroEventLearning, buildSpecialDays, isKnownSpecialDay } from "../app/macro-event-learning.ts";
import { buildTsForecastDisplay, resolveTsForecastContext } from "../app/ts-forecast-state.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { classifyOwnerMarketHealth } from "../app/owner-market-health.ts";
import { timelineOccurrencesForPtDate } from "../app/timeline-schedule.ts";

test("closed-session cached quotes remain historical data while real gaps and failures stay visible", () => {
  const closed = { status: "MARKET_CLOSED", phase: "CLOSED", quote_freshness_seconds: 38_400, bar_freshness_seconds: 24_000, gap_status: null };
  assert.deepEqual(classifyOwnerMarketHealth(closed), { code: "MARKET_CLOSED", raw_pair: null, quote_live: false, bar_live: false });
  for (const [overrides, code] of [
    [{ system_blocked: true }, "SYSTEM_BLOCKED"],
    [{ gap_status: "SOURCE_GAP" }, "SOURCE_GAP"],
    [{ status: "DATA_BLOCKED" }, "GENUINE_DATA_BLOCKED"],
    [{ phase: "REGULAR" }, "SOURCE_GAP"],
    [{ quote_freshness_seconds: null, bar_freshness_seconds: null }, "SOURCE_GAP"],
    [{ status: "STALE", phase: "OVERNIGHT", bar_freshness_seconds: 60 }, "EXPECTED_PROVIDER_SESSION_LIMIT"],
  ]) assert.equal(classifyOwnerMarketHealth({ ...closed, ...overrides }).code, code);
});

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("reviewed Sep 18 schedule supplies known positives without changing A1 trust, history or ordinary-day coverage", () => {
  const at = "2026-09-18T13:30:45Z", days = buildEntrySpecialDays(undefined, at);
  assert.equal(days.length, 4);
  assert.ok(days.every((day) => day.market_date === "2026-09-18" && day.confidence === "REVIEWED_OFFICIAL_SCHEDULE" && isKnownSpecialDay(day, at)));
  assert.deepEqual(buildSpecialDays([], "2026-09-18T06:58:58.032Z"), []);
  assert.equal(buildSpecialDays([], days[0].received_at).length, 4);
  assert.equal(buildEntrySpecialDays(undefined, "invalid"), undefined);
  for (const date of ["2026-09-17", "2026-09-19", "2026-09-22"]) assert.equal(buildEntrySpecialDays(undefined, `${date}T13:30:45Z`), undefined);
  const original = structuredClone(days);
  for (const day of days) for (const key of Object.keys(day)) {
    assert.equal(isKnownSpecialDay({ ...day, [key]: `${day[key]}-changed` }, at), false, key);
    const missing = { ...day }; delete missing[key]; assert.equal(isKnownSpecialDay(missing, at), false, key);
  }
  assert.equal(isKnownSpecialDay({ ...days[0], injected: true }, at), false);
  days[0].label = "mutated";
  assert.deepEqual(buildEntrySpecialDays(undefined, at), original, "callers cannot mutate the reviewed registry");
  const source = { source_record_id: "live-shadow:20260918T133000Z:A1", source_mode: "LIVE", observed_at: "2026-09-18T13:30:00Z", received_at: "2026-09-18T13:30:05Z", as_of: "2026-09-18T13:30:00Z", coverage: { inflation: "LIVE", employment: "LIVE", central_bank: "LIVE", growth: "LIVE" }, events: [] };
  assert.deepEqual(buildEntrySpecialDays({ ...source, coverage: undefined }, at), original);
  assert.deepEqual(buildEntrySpecialDays({ ...source, observed_at: "2026-09-15T13:30:00Z", as_of: "2026-09-15T13:30:00Z" }, at), original);
  assert.ok(buildEntrySpecialDays(source, "2026-09-21T13:30:45Z").every((day) => day.market_date === "2026-09-21"), "reviewed Friday never becomes a Monday event");
  const invalid = { release_name: "FOMC Meeting Decision", scheduled_at: "2026-09-22", source_url: "https://invalid.example/", time_precision: "DATE_ONLY" };
  assert.equal(buildEntrySpecialDays({ ...source, observed_at: "2026-09-21T20:00:00Z", received_at: "2026-09-21T20:00:05Z", as_of: "2026-09-21T20:00:00Z", events: [invalid] }, "2026-09-22T13:30:45Z"), undefined, "retained supplements cannot turn an invalid A1 event into ordinary-day proof");
  const impersonation = { ...original[1], source_record_id: source.source_record_id, source_url: "https://www.bls.gov/" };
  assert.equal(isKnownSpecialDay(impersonation, at), false, "reviewed labels do not expand the original A1 issuer allowlist");
  assert.ok(original.every((day) => isKnownSpecialDay(day, "2026-10-01T13:30:45Z")), "historical frozen evidence stays verifiable");
});

test("reviewed Sep 21 events use actual receipt time and do not mark Tuesday special", () => {
  const at = "2026-09-21T13:30:45Z", days = buildEntrySpecialDays(undefined, at);
  assert.equal(days.length, 3);
  assert.deepEqual(days.map((day) => day.scheduled_at), ["2026-09-21T10:30:00Z", "2026-09-21T12:30:00Z", "2026-09-21T15:00:00Z"]);
  assert.ok(days.every((day) => day.market_date === "2026-09-21" && day.received_at === "2026-09-20T22:02:53.696Z" && isKnownSpecialDay(day, at)));
  const beforeReceipt = new Date(Date.parse(days[0].received_at) - 1).toISOString();
  assert.equal(buildSpecialDays([], beforeReceipt).filter((day) => day.market_date === "2026-09-21").length, 0);
  assert.equal(buildSpecialDays([], days[0].received_at).filter((day) => day.market_date === "2026-09-21").length, 3);
  assert.ok(days.every((day) => !isKnownSpecialDay(day, beforeReceipt) && !isKnownSpecialDay({ ...day, received_at: "2026-09-18T06:58:58.033Z" }, at)), "later-reviewed facts cannot be backdated");
  const tuesday = "2026-09-22T13:30:45Z";
  assert.equal(buildEntrySpecialDays(undefined, tuesday), undefined, "absence of a reviewed event alone is not ordinary-day proof");
  const checked = { source_record_id: "live-shadow:20260922T130000Z:A1", source_mode: "LIVE", observed_at: "2026-09-22T13:00:00Z", received_at: "2026-09-22T13:00:05Z", as_of: "2026-09-22T13:00:00Z", coverage: { inflation: "LIVE", employment: "LIVE", central_bank: "LIVE", growth: "LIVE" }, events: [] };
  assert.deepEqual(buildEntrySpecialDays(checked, tuesday), []);
});

test("FOMC day annotations preserve calendar dates and require eligible official archived evidence", () => {
  const event = { release_name: "FOMC Meeting Decision", scheduled_at: "2026-09-16T12:00:00+00:00", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", time_precision: "DATE_ONLY" };
  const source = { source_record_id: "live-shadow:20260916T010000Z:A1", source_mode: "LIVE", observed_at: "2026-09-16T01:00:30Z", received_at: "2026-09-16T01:00:40Z", as_of: "2026-09-16T01:00:20Z", events: [event] };
  const newer = { ...source, source_record_id: "live-shadow:20260916T170000Z:A1", observed_at: "2026-09-16T17:00:30Z", received_at: "2026-09-16T17:00:40Z", as_of: "2026-09-16T17:00:20Z" };
  const endOfDay = "2026-09-17T06:59:59Z", before = JSON.stringify([source, newer]);
  const expected = { market_date: "2026-09-16", label: "FOMC 议息日", source_url: event.source_url, source_record_id: newer.source_record_id, observed_at: newer.observed_at, received_at: newer.received_at, as_of: newer.as_of, release_name: event.release_name, scheduled_at: event.scheduled_at, time_precision: "DATE_ONLY", confidence: "" };
  assert.deepEqual(buildSpecialDays([newer, source], endOfDay), [expected], "the latest eligible calendar wins even after the event's scheduled time");
  assert.equal(JSON.stringify([source, newer]), before);
  assert.deepEqual(buildSpecialDays([source, { ...newer, events: [] }], endOfDay).map((day) => day.source_record_id), [source.source_record_id], "a retained older calendar can survive a later empty calendar");
  assert.equal(buildSpecialDays([{ ...source, events: [{ ...event, scheduled_at: "2026-09-17T00:00:00Z" }] }], endOfDay)[0].market_date, "2026-09-17", "DATE_ONLY must not shift back to the previous PT day");
  assert.equal(buildSpecialDays([{ ...source, events: [{ ...event, scheduled_at: "2026-09-17" }] }], endOfDay)[0].market_date, "2026-09-17");
  assert.equal(buildSpecialDays([{ ...source, events: [{ ...event, scheduled_at: "2026-09-17T00:30:00Z", time_precision: "EXACT" }] }], endOfDay)[0].market_date, "2026-09-16", "exact timestamps use the PT market day");
  for (const change of [
    { source_record_id: "replay-shadow:20260916T010000Z:A1" }, { source_mode: "REPLAY" },
    { observed_at: "2026-09-18T01:00:00Z" }, { received_at: "2026-09-18T01:00:00Z" }, { as_of: "2026-09-18T01:00:00Z" },
    { observed_at: "2026-09-16T01:00:30" }, { received_at: "2026-09-16T01:00:00Z" },
    ...["2026-02-30", "2026-09-16garbage", "2026-09-16T99:00:00Z", "2026-09-16T12:00:00"].map((scheduled_at) => ({ events: [{ ...event, scheduled_at }] })),
    ...["https://federalreserve.gov.evil.test/", "http://www.federalreserve.gov/", "https://user@www.federalreserve.gov/", "https://www.bls.gov/"].map((source_url) => ({ events: [{ ...event, source_url }] })),
    { events: [{ ...event, release_name: "Consumer Price Index" }] }, { events: [{ ...event, time_precision: "UNKNOWN" }] },
  ]) assert.deepEqual(buildSpecialDays([{ ...source, ...change }], endOfDay), [], JSON.stringify(change));
});

test("major-day classifier keeps six same-day releases and validates the issuing agency or exact FRED fallback", () => {
  const events = [
    ["FOMC Meeting Decision", "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", "FOMC 议息日"],
    ["Consumer Price Index", "https://www.bls.gov/schedule/news_release/cpi.htm", "CPI 公布日"],
    ["Producer Price Index", "https://www.bls.gov/schedule/news_release/ppi.htm", "PPI 公布日"],
    ["Employment Situation", "https://www.bls.gov/schedule/news_release/empsit.htm", "非农就业日"],
    ["Personal Income and Outlays", "https://apps.bea.gov/API/signup/release_dates.json", "PCE 通胀日"],
    ["Gross Domestic Product", "https://apps.bea.gov/API/signup/release_dates.json", "GDP 公布日"],
  ].map(([release_name, source_url, label]) => ({ release_name, source_url, label, scheduled_at: "2026-09-16T12:30:00Z", time_precision: "EXACT", confidence: "official_schedule" }));
  const source = { source_record_id: "live-shadow:20260916T010000Z:A1", source_mode: "LIVE", observed_at: "2026-09-16T01:00:30Z", received_at: "2026-09-16T01:00:40Z", as_of: "2026-09-16T01:00:20Z", events };
  const at = "2026-09-16T16:00:00Z", newer = { ...source, source_record_id: "live-shadow:20260916T153000Z:A1", observed_at: "2026-09-16T15:30:00Z", received_at: "2026-09-16T15:30:05Z", as_of: "2026-09-16T15:29:59Z", events: [events[5]] };
  const days = buildSpecialDays([source, newer], at);
  assert.equal(days.length, 6, "different releases on the same date must all remain visible");
  for (const event of events) {
    const day = days.find((item) => item.release_name === event.release_name);
    assert.equal(day.label, event.label);
    assert.equal(day.market_date, "2026-09-16");
    assert.equal(isKnownSpecialDay(day, at), true);
  }
  assert.equal(days.find((day) => day.release_name === "Gross Domestic Product").source_record_id, newer.source_record_id);
  for (const [index, rid] of [[1, "10"], [2, "46"], [3, "50"]]) {
    const fallback = { ...events[index], source_url: `https://fred.stlouisfed.org/releases/calendar?rid=${rid}&view=year`, confidence: "official_federal_reserve_aggregator_date_only", time_precision: "DATE_ONLY" };
    assert.equal(buildSpecialDays([{ ...source, events: [fallback] }], at).length, 1);
    for (const change of [{ confidence: "UNVERIFIED" }, { time_precision: "EXACT" }, { source_url: fallback.source_url.replace(`rid=${rid}`, "rid=999") }, { source_url: fallback.source_url + "&rid=10" }]) {
      assert.deepEqual(buildSpecialDays([{ ...source, events: [{ ...fallback, ...change }] }], at), []);
    }
  }
  const excluded = ["Gross Domestic Product by State", "Gross Domestic Product by County", "Gross Domestic Product (Unverified Estimate)", "FOMC Minutes", "Chair Speech", "toString"];
  assert.deepEqual(buildSpecialDays([{ ...source, events: excluded.map((release_name) => ({ ...events[5], release_name })) }], at), []);
  assert.deepEqual(buildSpecialDays([{ ...source, events: [{ ...events[4], source_url: "https://www.bls.gov/" }, { ...events[1], source_url: "https://www.bls.gov.evil.test/" }] }], at), []);
  for (const change of [{ label: "加息日" }, { market_date: "2026-09-17" }, { received_at: "2026-09-17T00:00:00Z" }, { as_of: "2026-02-30T00:00:00Z" }, { time_precision: "UNKNOWN" }]) assert.equal(isKnownSpecialDay({ ...days[0], ...change }, at), false);
  assert.equal(isKnownSpecialDay(days[0], "2026-09-16T00:00:00Z"), false, "later-known evidence cannot validate an earlier entry");
});

test("entry-day coverage distinguishes verified positives, checked ordinary days and unavailable calendars", () => {
  const coverage = { inflation: "LIVE", employment: "LIVE", central_bank: "LIVE", growth: "LIVE", released_values: "DATA_BLOCKED" };
  const source = { source_record_id: "live-shadow:20260916T153000Z:A1", source_mode: "LIVE", observed_at: "2026-09-16T15:30:00Z", received_at: "2026-09-16T15:30:05Z", as_of: "2026-09-16T15:29:59Z", coverage, events: [] };
  const at = "2026-09-16T16:00:00Z";
  assert.deepEqual(buildEntrySpecialDays(source, at), [], "released values are not required to verify a release schedule");
  assert.equal(buildEntrySpecialDays(undefined, at), undefined);
  assert.equal(buildEntrySpecialDays({ ...source, coverage: undefined }, at), undefined);
  assert.equal(buildEntrySpecialDays({ ...source, coverage: { ...coverage, growth: "DATA_BLOCKED" } }, at), undefined);
  assert.equal(buildEntrySpecialDays({ ...source, received_at: "2026-09-17T00:00:00Z" }, at), undefined);
  const event = { release_name: "FOMC Meeting Decision", scheduled_at: "2026-09-16", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", time_precision: "DATE_ONLY", confidence: "issuing_agency_official_date_only" };
  assert.equal(buildEntrySpecialDays({ ...source, coverage: undefined, events: [event] }, at).length, 1, "positive verified facts survive partial coverage");
  assert.equal(buildEntrySpecialDays({ ...source, coverage: undefined, events: [{ ...event, scheduled_at: "2026-09-17" }] }, at), undefined, "a future event does not establish that today is ordinary");
  assert.deepEqual(buildEntrySpecialDays({ ...source, events: [{ ...event, scheduled_at: "2026-09-17" }] }, at), [], "entry evidence contains current-date events only");
  for (const change of [{ time_precision: undefined }, { time_precision: "UNKNOWN" }, { time_precision: "EXACT", scheduled_at: "2026-09-17T00:00:00Z" }, { scheduled_at: "2026-02-30" }, { source_url: "https://calendar.example.test/" }]) {
    assert.equal(buildEntrySpecialDays({ ...source, events: [{ ...event, ...change }] }, at), undefined, "invalid supported events cannot become ordinary-day proof");
  }
  const stale = { ...source, observed_at: "2026-09-14T20:00:00Z", received_at: "2026-09-14T20:00:05Z", as_of: "2026-09-14T19:59:59Z" };
  assert.equal(buildEntrySpecialDays(stale, at), undefined);
  assert.equal(buildEntrySpecialDays({ ...source, as_of: stale.as_of }, at), undefined, "a newly received old calendar is still stale");
  const friday = { ...source, source_record_id: "live-shadow:20260911T200000Z:A1", observed_at: "2026-09-11T20:00:00Z", received_at: "2026-09-11T20:00:05Z", as_of: "2026-09-11T19:59:59Z" };
  assert.deepEqual(buildEntrySpecialDays(friday, "2026-09-14T13:00:00Z"), [], "freshness follows completed NYSE sessions across weekends");
});

test("a current empty calendar cannot cancel a causally known same-day CPI, or revive stale and future evidence", () => {
  const at = "2026-10-14T14:00:00Z", event = { release_name: "Consumer Price Index", scheduled_at: "2026-10-14T12:00:00+00:00", source_url: "https://fred.stlouisfed.org/releases/calendar?rid=10&view=year", time_precision: "DATE_ONLY", confidence: "official_federal_reserve_aggregator_date_only" };
  const source = { source_record_id: "live-shadow:20261014T010000Z:A1", source_mode: "LIVE", observed_at: "2026-10-14T01:00:17Z", received_at: "2026-10-14T01:00:58Z", as_of: "2026-10-14T01:00:17Z", events: [event] };
  const known = buildSpecialDays([source], at).filter((day) => day.market_date === "2026-10-14"), current = { ...source, source_record_id: "live-shadow:20261014T133000Z:A1", observed_at: "2026-10-14T13:35:31Z", received_at: "2026-10-14T13:36:10Z", as_of: "2026-10-14T13:35:31Z", events: [], coverage: { inflation: "LIVE", employment: "LIVE", central_bank: "LIVE", growth: "LIVE" } };
  assert.deepEqual(buildEntrySpecialDays(current, at, known), known);
  assert.deepEqual(buildEntrySpecialDays({ ...current, coverage: undefined }, at, known), known, "a verified positive survives incomplete current coverage");
  assert.deepEqual(buildEntrySpecialDays(undefined, at, known), known);
  assert.equal(buildEntrySpecialDays(current, at, known)[0].time_precision, "DATE_ONLY", "the date placeholder does not become a verified release time");
  for (const change of [
    { source_record_id: "replay-shadow:20261014T010000Z:A1" }, { received_at: "2026-10-14T14:00:01Z" },
    { observed_at: "2026-10-12T20:00:00Z", as_of: "2026-10-12T20:00:00Z" }, { as_of: "2026-10-12T20:00:00Z" },
    { market_date: "2026-10-15", scheduled_at: "2026-10-15" }, { source_url: "https://calendar.example.test/" },
  ]) {
    const invalid = [{ ...known[0], ...change }];
    assert.deepEqual(buildEntrySpecialDays(current, at, invalid), [], JSON.stringify(change));
    assert.equal(buildEntrySpecialDays({ ...current, coverage: undefined }, at, invalid), undefined, "rejected evidence cannot establish coverage");
  }
  for (const [observed, target, decision] of [["2026-10-17T01:00:00Z", "2026-10-19", "2026-10-19T13:00:00Z"], ["2026-09-05T01:00:00Z", "2026-09-08", "2026-09-08T13:00:00Z"]]) {
    const holidaySource = { ...source, source_record_id: `live-shadow:${observed.replace(/[-:]/g, "")}:A1`, observed_at: observed, received_at: observed, as_of: observed, events: [{ ...event, scheduled_at: target }] };
    const days = buildSpecialDays([holidaySource], decision).filter((day) => day.market_date === target);
    assert.equal(buildEntrySpecialDays(undefined, decision, days)?.[0].market_date, target, "the freshness bound crosses weekends and NYSE holidays");
  }
  const exact = buildSpecialDays([{ ...source, events: [{ ...event, scheduled_at: "2026-10-15T00:30:00Z", time_precision: "EXACT", source_url: "https://www.bls.gov/schedule/", confidence: "official_schedule" }] }], at).filter((day) => day.market_date === "2026-10-14");
  assert.equal(buildEntrySpecialDays(undefined, at, exact)?.[0].market_date, "2026-10-14", "EXACT events use the PT date even when their UTC date is tomorrow");
});

test("SQLite entry classification keeps a same-session positive after empty and future-only calendar updates", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-16T17:00:00Z") });
  const directory = mkdtempSync(join(tmpdir(), "trading-os-entry-days-")), file = join(directory, "test.sqlite");
  const store = openSnapshotDatabase(file), db = new DatabaseSync(file);
  try {
    const insert = db.prepare("INSERT INTO output_records(record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, 'A1_SHADOW_RESULT', 'SHADOW', ?, ?, ?, ?, 'test-only')");
    const event = { release_name: "FOMC Meeting Decision", scheduled_at: "2026-09-16", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", time_precision: "DATE_ONLY", confidence: "issuing_agency_official_date_only" };
    const coverage = { inflation: "LIVE", employment: "LIVE", central_bank: "LIVE", growth: "LIVE", released_values: "DATA_BLOCKED" };
    const cases = [
      ["150000", [event], undefined],
      ["153000", [], coverage],
      ["160000", [], undefined],
      ["163000", [{ ...event, scheduled_at: "2026-09-17" }], coverage],
    ];
    for (const [slot, events, coverageValue] of cases) {
      const id = `live-shadow:20260916T${slot}Z:A1`, at = `2026-09-16T${slot.slice(0, 2)}:${slot.slice(2, 4)}:00Z`;
      const payload = JSON.stringify({ source_mode: "LIVE", official_macro: { status: "DEGRADED", collected_at: at, events, coverage: coverageValue, results: [] } });
      insert.run(id, at, at, payload, payload);
      const before = db.prepare("SELECT * FROM output_records ORDER BY sequence").all();
      const state = store.getActive("home"), entry = state.macroEventLearning.entry_special_days;
      assert.equal(entry[0].source_record_id, "live-shadow:20260916T150000Z:A1");
      assert.deepEqual(db.prepare("SELECT * FROM output_records ORDER BY sequence").all(), before);
      assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events").all(), []);
    }
    for (let index = 0; index < 130; index++) {
      const at = new Date(Date.parse("2026-09-16T16:31:00Z") + index * 1000).toISOString(), id = `live-shadow:${at.replace(/[-:]/g, "").replace(".000", "")}:A1`;
      const payload = JSON.stringify({ source_mode: "LIVE", official_macro: { status: "DEGRADED", collected_at: at, events: [{ ...event, scheduled_at: "2026-09-17" }], coverage, results: [] } });
      insert.run(id, at, at, payload, payload);
    }
    assert.equal(store.getActive("home").macroEventLearning.entry_special_days, undefined, "overflow of the bounded source lookup cannot prove an ordinary day");
  } finally { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("SQLite FOMC annotations retain an evening source after the current calendar drops the event without rewriting history", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-17T06:59:59Z") });
  const directory = mkdtempSync(join(tmpdir(), "trading-os-special-days-")), file = join(directory, "test.sqlite");
  const store = openSnapshotDatabase(file), db = new DatabaseSync(file);
  try {
    const insert = db.prepare("INSERT INTO output_records(record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, ?, 'SHADOW', ?, ?, ?, ?, 'test-only')");
    const archivedId = "live-shadow:20260916T010000Z:A1", latestId = "live-shadow:20260916T230000Z:A1";
    const event = { release_name: "FOMC Meeting Decision", scheduled_at: "2026-09-16T12:00:00+00:00", source_url: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", time_precision: "DATE_ONLY" };
    for (const [id, at, events] of [[archivedId, "2026-09-16T01:00:30Z", [event]], [latestId, "2026-09-16T23:00:30Z", [{ ...event, release_name: "Producer Price Index", scheduled_at: "2026-09-18T12:00:00Z", source_url: "https://www.bls.gov/" }]]]) {
      const payload = JSON.stringify({ source_mode: "LIVE", observed_at: at, official_macro: { status: "DEGRADED", collected_at: at, events, results: [] } });
      insert.run(id, "A1_SHADOW_RESULT", at, at, payload, payload);
    }
    const checkpoint = JSON.stringify({ ...timelineOccurrencesForPtDate("2026-09-15").find((row) => row.kind === "EVENING_ANALYSIS"), status: "SUCCEEDED", completed_at: "2026-09-16T01:02:00Z", result_ref: "sqlite://agent_run_events/live-shadow:20260916T010000Z" });
    insert.run("test-only:evening", "SCHEDULE_CHECKPOINT", "2026-09-16T01:02:00Z", "2026-09-16T01:02:00Z", checkpoint, checkpoint);
    const before = db.prepare("SELECT * FROM output_records ORDER BY sequence").all(), paperBefore = db.prepare("SELECT * FROM paper_plan_events").all();
    for (const view of [undefined, "forecast", "settlements"]) {
      const state = store.getActive(view);
      assert.equal(state.macroEventLearning.calendar.source_record_id, latestId, "the ordinary calendar retains its current source identity");
      assert.deepEqual(state.macroEventLearning.special_days.map(({ market_date, label, source_record_id }) => ({ market_date, label, source_record_id })), [{ market_date: "2026-09-16", label: "FOMC 议息日", source_record_id: archivedId }, { market_date: "2026-09-18", label: "PPI 公布日", source_record_id: latestId }], "DEGRADED source health does not invalidate official calendar facts");
      assert.equal(state.macroEventLearning.entry_special_days, undefined, "historical FOMC does not turn incomplete current coverage into an entry-day classification");
    }
    assert.deepEqual(db.prepare("SELECT * FROM output_records ORDER BY sequence").all(), before);
    assert.deepEqual(db.prepare("SELECT * FROM paper_plan_events").all(), paperBefore);
  } finally { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("SQLite calendar projection excludes empty, replay and future updates while preserving all raw rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "trading-os-calendar-")), file = join(directory, "test.sqlite");
  const store = openSnapshotDatabase(file), db = new DatabaseSync(file);
  try {
    const insert = db.prepare("INSERT INTO output_records(record_id, output_type, channel, observed_at, received_at, payload_json, raw_json, raw_sha256) VALUES (?, 'A1_SHADOW_RESULT', 'SHADOW', ?, ?, ?, ?, ?)");
    const event = { release_name: "Producer Price Index", scheduled_at: "2026-09-10T12:00:00.000Z", source_url: "https://www.bls.gov/", confidence: "OFFICIAL", time_precision: "DATE_ONLY" };
    for (const [id, at, mode, events] of [
      ["live-shadow:20260905T010000Z:A1", "2026-09-05T01:00:55.489Z", "LIVE", [event]],
      ["live-shadow:20260907T010000Z:A1", "2026-09-07T01:01:00.000Z", "LIVE", []],
      ["replay-shadow:20260907T020000Z:A1", "2026-09-07T02:01:00.000Z", "REPLAY", [{ ...event, release_name: "REPLAY" }]],
      ["live-shadow:20990907T020000Z:A1", "2099-09-07T02:01:00.000Z", "LIVE", [{ ...event, release_name: "FUTURE" }]],
    ]) {
      const payload = JSON.stringify({ source_mode: mode, observed_at: at, official_macro: { collected_at: at, events, results: [] } });
      insert.run(id, at, at, payload, payload, "test-only");
    }
    const before = db.prepare("SELECT * FROM output_records ORDER BY sequence").all();
    const state = store.getActive("forecast");
    assert.equal(state.macroEventLearning.calendar?.source_record_id, "live-shadow:20260905T010000Z:A1");
    assert.deepEqual(state.macroEventLearning.calendar?.events, [event]);
    assert.deepEqual(db.prepare("SELECT * FROM output_records ORDER BY sequence").all(), before);
  } finally { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("archived official calendar survives missing current A1 without pretending to be live analysis", () => {
  const event = { release_name: "Producer Price Index", scheduled_at: "2026-09-10T12:00:00.000Z", source_url: "https://www.bls.gov/schedule/", confidence: "OFFICIAL", time_precision: "DATE_ONLY", agency: "BLS" };
  const source = { record_id: "live-shadow:20260905T010000Z:A1", observed_at: "2026-09-05T01:00:55.489Z", role: "LATEST", official_macro: { collected_at: "2026-09-05T01:00:40.000Z", events: [event], results: [] }, quotes: [], sector_advance_pct: null };
  const before = JSON.stringify(source);
  const learning = buildMacroEventLearning([source], "2026-09-08T03:00:00.000Z");
  assert.equal(learning.studies.length, 0, "a PPI calendar must not invent a learning prediction");
  assert.equal(learning.calendar?.source_record_id, source.record_id);
  assert.equal(learning.calendar?.as_of, source.official_macro.collected_at);
  assert.deepEqual(learning.calendar?.events, [event]);
  assert.equal(JSON.stringify(source), before);
  const failed = { ...source, record_id: "live-shadow:20260907T010000Z:A1", observed_at: "2026-09-07T01:00:55.000Z", official_macro: { ...source.official_macro, status: "DATA_BLOCKED", events: [] } };
  const replay = { ...source, record_id: "replay-shadow:calendar", observed_at: "2026-09-08T02:00:00.000Z", official_macro: { ...source.official_macro, events: [{ ...event, release_name: "REPLAY_NOT_OFFICIAL" }] } };
  const retained = buildMacroEventLearning([{ ...source, role: "EVENING" }, failed, replay], "2026-09-08T03:00:00.000Z");
  assert.equal(retained.calendar?.source_record_id, source.record_id, "empty or replay updates cannot erase the last official calendar");
  assert.equal(buildMacroEventLearning([], "2026-09-08T03:00:00.000Z").calendar, null);
  assert.match(page, /macroCalendar\?\.events \?\? officialMacro\?\.events/);
});

test("learning bodies render independently of whether the future calendar has entries", () => {
  assert.equal(/upcomingSpecialEvents\.length \? <>[\s\S]*?macroLearningStudies\.map/.test(page), false, "calendar existence must not gate learning");
  assert.ok(page.includes("最近日历资料"));
  assert.match(page, /time_precision === "DATE_ONLY"/);
});

test("home labels a retained target-date forecast and does not call DEGRADED normal", () => {
  const output = { report_type: "NEXT_SESSION", path_bias: "BULLISH", evidence_snapshot: { run_id: "20260905T010248Z-9bb8891c65", market_time: { observed_at: "2026-09-05T01:00:55.489Z", market_date: "2026-09-04" } } };
  const at = Date.parse("2026-09-08T03:00:00.000Z");
  const marketForecastContext = resolveTsForecastContext([output], null, at);
  const declarations = page.match(/ {2}const marketBias = [\s\S]*? {2}const systemResult = [^\n]+/)?.[0];
  assert.ok(declarations);
  const evaluate = new Function("marketForecastContext", "currentTs", "displayTs", "marketIsClosed", "ownerSystemBlocked", "ownerAttentionRequired", "currentTruth", "marketDisplay", "healthOverview = { selfCheckStatus: 'HEALTHY' }", `${declarations}; return { marketStateText, systemResult };`);
  const result = evaluate(marketForecastContext, null, output, false, false, false, { health_status: "DEGRADED" }, buildTsForecastDisplay(output, marketForecastContext.mode, at));
  assert.match(result.marketStateText, /2026-09-08.*预判.*偏多/);
  assert.notEqual(result.systemResult, "正常");
  const empty = evaluate(resolveTsForecastContext([], null, at), null, output, false, false, false, { health_status: "HEALTHY" }, buildTsForecastDisplay(null, "NONE", at));
  assert.equal(empty.marketStateText, "暂无当前分析", "unrelated historical bias is not the current market");
});

test("frozen fixed-pool evidence and last failed collection are not current source health", () => {
  const radar = readFileSync(new URL("../app/MarketRadar.tsx", import.meta.url), "utf8");
  assert.equal(page.includes("最近官方结构 · 当前读取失败"), false);
  assert.equal(/当前官方读取失败|title: "当前实时数据"/.test(radar), false);
  assert.ok(page.includes("最近采集失败"));
  assert.ok(radar.includes("冻结时数据正常"));
});
