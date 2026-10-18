import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readResearchProfile, saveResearchProfile, validateResearchInputs } from "../tools/research-profile.mjs";
import { openSnapshotDatabase } from "../web/build/local-data-core.ts";
import { makePaperEvent } from "../web/server/paper-plan-store.ts";

const root = resolve(import.meta.dirname, ".."), work = join(root, "_工作文件");
const synthetic = { available_capital_usd: 4200, normal_premium_min_usd: 80, normal_premium_max_usd: 260, strong_premium_max_usd: 420, concentrated_capital_pct: 45, reserve_cash_usd: 800, daily_loss_limit_usd: 120, portfolio_risk_limit_usd: 500 };
const stamp = "2026-10-19T14:00:00.000Z", now = () => new Date(stamp);

function fixture(context) {
  mkdirSync(work, { recursive: true });
  const directory = mkdtempSync(join(work, "research-profile-test-")), file = join(directory, "local.sqlite");
  context.after(() => { assert.ok(directory.startsWith(work + sep)); rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, options: { confirmed: true, databasePath: file, now } };
}

function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Object.fromEntries(["investment_contract_versions", "owner_capital_context_versions", "output_records", "ts_forecast_archive", "paper_plan_events"].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { db.close(); }
}

test("research setup requires all explicit values and confirmation before creating a file", (context) => {
  const { file, options } = fixture(context);
  assert.equal(readResearchProfile({ databasePath: file }), null);
  assert.throws(() => saveResearchProfile(synthetic, { ...options, confirmed: false }), /CONFIRMATION_REQUIRED/);
  assert.throws(() => saveResearchProfile(synthetic, { ...options, confirmed: "yes" }), /CONFIRMATION_REQUIRED/);
  for (const input of [null, [], {}, { ...synthetic, daily_loss_limit_usd: undefined }, { ...synthetic, available_capital_usd: 0 }, { ...synthetic, daily_loss_limit_usd: -1 }, { ...synthetic, reserve_cash_usd: Infinity }, { ...synthetic, normal_premium_min_usd: NaN }, { ...synthetic, available_capital_usd: "4200" }, { ...synthetic, normal_premium_min_usd: 300 }, { ...synthetic, strong_premium_max_usd: 5000 }, { ...synthetic, concentrated_capital_pct: 1 }, { ...synthetic, portfolio_risk_limit_usd: 5000 }, { ...synthetic, automated_execution: true }]) assert.throws(() => saveResearchProfile(input, options), /RESEARCH_/);
  assert.equal(existsSync(file), false, "bad input and missing consent cannot create even an empty user database");
  assert.deepEqual(validateResearchInputs(synthetic), synthetic);
  assert.notEqual(validateResearchInputs(synthetic), synthetic, "validation does not mutate the caller's input");
});

test("confirmed own profile becomes active and unlocks only local read-only research append", (context) => {
  const { file, options } = fixture(context);
  const initial = openSnapshotDatabase(file), attempt = makePaperEvent("paper-plan:2026-10-19", stamp, "ATTEMPT", { reasons: ["SYNTHETIC_OFFLINE_TEST_NO_MARKET_DATA"] });
  try {
    assert.equal(initial.getActive().investmentKernel.profile_mode, "BLANK");
    assert.equal(initial.getActive().investmentKernel.capital_context, null);
    assert.throws(() => initial.appendPaperPlanEvent(attempt), /Owner|空白/);
  } finally { initial.close(); }
  assert.deepEqual(Object.values(rows(file)).map((value) => value.length), [0, 0, 0, 0, 0]);
  let externalRequests = 0;
  context.mock.method(globalThis, "fetch", () => { externalRequests++; throw Error("No external calls allowed"); });
  const result = saveResearchProfile(synthetic, options);
  assert.deepEqual(result, { status: "ACTIVE", profile_id: "OWNER_PRIMARY", execution_mode: "SHADOW", broker_access: "READ_ONLY", automated_execution: false, configured_at: stamp, capital_version: "1.0.0", contract_count: 5 });
  assert.deepEqual(readResearchProfile({ databasePath: file }), result);
  const saved = rows(file), capital = JSON.parse(saved.owner_capital_context_versions[0].payload_json);
  assert.equal(capital.available_capital_usd, synthetic.available_capital_usd);
  assert.equal(capital.normal_premium_usd.max_capital_pct, synthetic.normal_premium_max_usd / synthetic.available_capital_usd * 100);
  assert.equal(capital.strong_opportunity_usd.max_capital_pct, synthetic.strong_premium_max_usd / synthetic.available_capital_usd * 100);
  assert.ok(saved.investment_contract_versions.every((row) => row.effective_at === stamp && row.recorded_at === stamp));
  assert.deepEqual([saved.output_records.length, saved.ts_forecast_archive.length, saved.paper_plan_events.length], [0, 0, 0]);
  const configured = openSnapshotDatabase(file, { investmentProfile: "OWNER" });
  try {
    assert.equal(configured.getActive().investmentKernel.status, "ACTIVE");
    assert.deepEqual(configured.appendPaperPlanEvent(attempt), { duplicate: false });
    assert.equal(configured.getPaperPlanEvents(attempt.plan_id).length, 1);
    assert.equal(configured.getActivePaperPlans().length, 0, "configuration plus missing data must not invent a trade plan");
    assert.deepEqual(configured.appendPaperPlanEvent(attempt), { duplicate: true });
  } finally { configured.close(); }
  assert.equal(externalRequests, 0);
});

test("existing profile is never overwritten and duplicate setup leaves all original rows unchanged", (context) => {
  const { file, options } = fixture(context);
  saveResearchProfile(synthetic, options);
  const before = rows(file);
  assert.throws(() => saveResearchProfile({ ...synthetic, available_capital_usd: 6500 }, options), /ALREADY_CONFIGURED/);
  assert.deepEqual(rows(file), before);
});

test("capital insertion failure rolls back every strategy record in the same transaction", (context) => {
  const { file, options } = fixture(context);
  openSnapshotDatabase(file).close();
  const db = new DatabaseSync(file);
  try { db.exec("CREATE TRIGGER synthetic_profile_failure BEFORE INSERT ON owner_capital_context_versions BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_PROFILE_FAILURE'); END"); }
  finally { db.close(); }
  const before = rows(file);
  assert.throws(() => saveResearchProfile(synthetic, options), /SYNTHETIC_PROFILE_FAILURE/);
  assert.deepEqual(rows(file), before);
  assert.equal(readResearchProfile({ databasePath: file }), null);
});

test("profile helper rejects external paths and linked files before opening SQLite", (context) => {
  const { directory, options } = fixture(context);
  assert.throws(() => saveResearchProfile(synthetic, { ...options, databasePath: join(root, "web", "app", "not-a-database.sqlite") }), /PATH_OUTSIDE_PACKAGE/);
  const original = join(directory, "original.sqlite"), linked = join(directory, "linked.sqlite");
  writeFileSync(original, "SYNTHETIC_NOT_A_DATABASE"); linkSync(original, linked);
  assert.throws(() => readResearchProfile({ databasePath: linked }), /LINK_FORBIDDEN/);
  assert.throws(() => saveResearchProfile(synthetic, { ...options, databasePath: linked }), /LINK_FORBIDDEN/);
});

test("a dangling data-directory link cannot evade path checks", (context) => {
  const { directory, options } = fixture(context), linked = join(directory, "dangling"), file = join(linked, "not-created.sqlite");
  try { symlinkSync(join(directory, "missing-target"), linked, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return context.skip("OS permission does not allow creating a test link"); throw error; }
  assert.equal(existsSync(linked), false, "the test specifically covers a dangling link");
  assert.throws(() => readResearchProfile({ databasePath: file }), /LINK_FORBIDDEN/);
  assert.throws(() => saveResearchProfile(synthetic, { ...options, databasePath: file }), /LINK_FORBIDDEN/);
});
