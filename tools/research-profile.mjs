import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSnapshotDatabase } from "../web/build/local-data-core.ts";
import { OWNER_CONSTITUTION_V1, SPX_FOLLOW_V1, SPX_FOLLOW_V1_1, SPX_FOLLOW_V1_2, SPX_FOLLOW_V1_3 } from "../web/app/investment-kernel.ts";

const root = resolve(import.meta.dirname, ".."), defaultDatabase = join(root, "web", "data", "trading-os-web.sqlite");
const templates = [OWNER_CONSTITUTION_V1, SPX_FOLLOW_V1, SPX_FOLLOW_V1_1, SPX_FOLLOW_V1_2, SPX_FOLLOW_V1_3];
const fields = ["available_capital_usd", "normal_premium_min_usd", "normal_premium_max_usd", "strong_premium_max_usd", "concentrated_capital_pct", "reserve_cash_usd", "daily_loss_limit_usd", "portfolio_risk_limit_usd"];
const reason = "LOCAL_USER_CONFIRMED_READ_ONLY_RESEARCH_SETUP";
const hash = (text) => createHash("sha256").update(text).digest("hex");

function databaseFile(requested = defaultDatabase) {
  const file = resolve(requested), work = join(root, "_工作文件");
  if (file !== defaultDatabase && !(file.startsWith(work + sep) && file.endsWith(".sqlite"))) throw new Error("RESEARCH_PROFILE_PATH_OUTSIDE_PACKAGE");
  for (let path = file; ; path = dirname(path)) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw new Error("RESEARCH_PROFILE_LINK_FORBIDDEN");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (path === root) break;
  }
  return file;
}

export function validateResearchInputs(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length || fields.some((key) => !Object.hasOwn(input, key))) throw new Error("RESEARCH_INPUT_REQUIRED: explicitly provide all eight personal settings");
  for (const key of fields) if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > Number.MAX_SAFE_INTEGER / 100) throw new Error(`RESEARCH_INPUT_INVALID: ${key}`);
  const capital = input.available_capital_usd;
  if (capital <= 0 || input.normal_premium_max_usd <= 0 || input.normal_premium_max_usd < input.normal_premium_min_usd || input.strong_premium_max_usd < input.normal_premium_max_usd || input.strong_premium_max_usd > capital) throw new Error("RESEARCH_PREMIUM_RANGE_INVALID");
  if (input.concentrated_capital_pct <= 0 || input.concentrated_capital_pct > 100 || input.concentrated_capital_pct < input.strong_premium_max_usd / capital * 100) throw new Error("RESEARCH_CONCENTRATION_RANGE_INVALID");
  for (const key of ["reserve_cash_usd", "daily_loss_limit_usd", "portfolio_risk_limit_usd"]) if (input[key] > capital) throw new Error(`RESEARCH_INPUT_EXCEEDS_CAPITAL: ${key}`);
  return Object.fromEntries(fields.map((key) => [key, input[key]]));
}

export function readResearchProfile({ databasePath } = {}) {
  const file = databaseFile(databasePath);
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
    if (!names.has("investment_contract_versions") || !names.has("owner_capital_context_versions")) return null;
    const contracts = db.prepare("SELECT * FROM investment_contract_versions").all(), capitals = db.prepare("SELECT * FROM owner_capital_context_versions").all();
    if (!contracts.length && !capitals.length) return null;
    if (contracts.length !== templates.length || capitals.length !== 1) throw new Error("RESEARCH_PROFILE_INCOMPLETE");
    const capital = capitals[0], context = JSON.parse(capital.payload_json);
    if (hash(capital.payload_json) !== capital.payload_hash || context.change_reason !== reason || context.owner_profile_id !== "OWNER_PRIMARY" || context.automated_execution !== false || context.effective_at !== capital.recorded_at) throw new Error("RESEARCH_PROFILE_INTEGRITY_FAILED");
    for (const template of templates) {
      const row = contracts.find((item) => item.contract_id === template.contract_id && item.version === template.version);
      if (!row || hash(row.payload_json) !== row.payload_hash) throw new Error("RESEARCH_PROFILE_INTEGRITY_FAILED");
      const value = JSON.parse(row.payload_json);
      if (value.owner_profile_id !== "OWNER_PRIMARY" || value.change_reason !== reason || value.effective_at !== row.recorded_at || row.recorded_at !== capital.recorded_at) throw new Error("RESEARCH_PROFILE_INTEGRITY_FAILED");
    }
    const store = openSnapshotDatabase(file, { readOnly: true, investmentProfile: "OWNER" });
    try {
      const kernel = store.getActive().investmentKernel;
      if (kernel.status !== "ACTIVE" || kernel.execution_mode !== "SHADOW" || kernel.broker_access !== "READ_ONLY" || kernel.automated_execution !== false) throw new Error("RESEARCH_PROFILE_NOT_READ_ONLY");
      return { status: "ACTIVE", profile_id: "OWNER_PRIMARY", execution_mode: "SHADOW", broker_access: "READ_ONLY", automated_execution: false, configured_at: capital.recorded_at, capital_version: context.version, contract_count: contracts.length };
    } finally { store.close(); }
  } finally { db.close(); }
}

export function saveResearchProfile(input, { confirmed = false, databasePath, now = () => new Date() } = {}) {
  if (confirmed !== true) throw new Error("RESEARCH_PROFILE_CONFIRMATION_REQUIRED");
  const values = validateResearchInputs(input), recordedAt = now().toISOString();
  const context = {
    context_id: "OWNER_CAPITAL_CONTEXT", version: "1.0.0", status: "ACTIVE", effective_at: recordedAt,
    change_reason: reason, owner_profile_id: "OWNER_PRIMARY", precision: "EXACT", source: "OWNER_STATED",
    available_capital_usd: values.available_capital_usd,
    normal_premium_usd: { min: values.normal_premium_min_usd, max: values.normal_premium_max_usd, max_capital_pct: values.normal_premium_max_usd / values.available_capital_usd * 100 },
    strong_opportunity_usd: { max: values.strong_premium_max_usd, max_capital_pct: values.strong_premium_max_usd / values.available_capital_usd * 100 },
    concentrated_capital_pct: values.concentrated_capital_pct, base_contract_quantity: 1, automated_execution: false,
    reserve_cash_usd: values.reserve_cash_usd, daily_loss_limit_usd: values.daily_loss_limit_usd, portfolio_risk_limit_usd: values.portfolio_risk_limit_usd,
  };
  // Reuse the real store's capital validation without writing anything to a user's file.
  const validation = openSnapshotDatabase(":memory:", { investmentProfile: "OWNER" });
  try { validation.recordOwnerCapitalContext(context, recordedAt); } finally { validation.close(); }
  const file = databaseFile(databasePath), store = openSnapshotDatabase(file, { investmentProfile: "OWNER" });
  let db;
  try {
    db = new DatabaseSync(file); db.exec("PRAGMA busy_timeout=30000; BEGIN IMMEDIATE");
    try {
      if (db.prepare("SELECT count(*) n FROM investment_contract_versions").get().n || db.prepare("SELECT count(*) n FROM owner_capital_context_versions").get().n) throw new Error("RESEARCH_PROFILE_ALREADY_CONFIGURED: use a future append-only version, never overwrite");
      const insert = db.prepare("INSERT INTO investment_contract_versions (owner_profile_id, contract_kind, contract_id, version, status, effective_at, recorded_at, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const template of templates) {
        const contract = { ...template, effective_at: recordedAt, change_reason: reason }, payload = JSON.stringify(contract);
        insert.run(contract.owner_profile_id, contract.contract_kind, contract.contract_id, contract.version, contract.status, recordedAt, recordedAt, hash(payload), payload);
      }
      const payload = JSON.stringify(context);
      db.prepare("INSERT INTO owner_capital_context_versions (owner_profile_id, context_id, version, status, effective_at, recorded_at, source, precision, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(context.owner_profile_id, context.context_id, context.version, context.status, recordedAt, recordedAt, context.source, context.precision, hash(payload), payload);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db?.close(); store.close(); }
  return readResearchProfile({ databasePath: file });
}
