import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { OWNER_CONSTITUTION_V1, SPX_FOLLOW_V1, SPX_FOLLOW_V1_1, SPX_FOLLOW_V1_2, SPX_FOLLOW_V1_3 } from "../app/investment-kernel.ts";

// Test-only invented numbers. Never imported by the application or offered as risk advice.
export const SYNTHETIC_CAPITAL_CONTEXT = {
  context_id: "OWNER_CAPITAL_CONTEXT", version: "1.0.0", status: "ACTIVE",
  effective_at: "2020-01-01T00:00:00.000Z", change_reason: "SYNTHETIC_TEST_ONLY_NO_REAL_ACCOUNT",
  owner_profile_id: "OWNER_PRIMARY", precision: "EXACT", source: "OWNER_STATED",
  available_capital_usd: 2000,
  normal_premium_usd: { min: 70, max: 180, max_capital_pct: 9 },
  strong_opportunity_usd: { max: 300, max_capital_pct: 15 }, concentrated_capital_pct: 35,
  base_contract_quantity: 1, automated_execution: false,
  reserve_cash_usd: "NOT_CONFIGURED", daily_loss_limit_usd: "NOT_CONFIGURED", portfolio_risk_limit_usd: "NOT_CONFIGURED",
};

export function openSyntheticInvestmentStore(file, options = {}) {
  const investmentProfile = options.investmentProfile ?? "OWNER";
  const store = openSnapshotDatabase(file, { ...options, investmentProfile });
  if (options.readOnly || investmentProfile === "BLANK") return store;
  const db = new DatabaseSync(file);
  try {
    const insert = db.prepare("INSERT OR IGNORE INTO investment_contract_versions (owner_profile_id, contract_kind, contract_id, version, status, effective_at, recorded_at, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const contract of [OWNER_CONSTITUTION_V1, SPX_FOLLOW_V1, SPX_FOLLOW_V1_1, SPX_FOLLOW_V1_2, SPX_FOLLOW_V1_3]) {
      const payload = JSON.stringify(contract), hash = createHash("sha256").update(payload).digest("hex");
      insert.run(contract.owner_profile_id, contract.contract_kind, contract.contract_id, contract.version, contract.status, contract.effective_at, contract.effective_at, hash, payload);
    }
    const capital = SYNTHETIC_CAPITAL_CONTEXT, payload = JSON.stringify(capital), hash = createHash("sha256").update(payload).digest("hex");
    db.prepare("INSERT OR IGNORE INTO owner_capital_context_versions (owner_profile_id, context_id, version, status, effective_at, recorded_at, source, precision, payload_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(capital.owner_profile_id, capital.context_id, capital.version, capital.status, capital.effective_at, capital.effective_at, capital.source, capital.precision, hash, payload);
  } finally { db.close(); }
  return store;
}
