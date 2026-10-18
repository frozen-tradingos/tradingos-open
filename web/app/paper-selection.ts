import { exchangeDateKey, isNyseRegularSession, robinhoodSessionAt } from "./market-time.ts";
import type { StockPlanningContext } from "./stock-manual-plan.ts";

export function paperFallbackDirectionConflict(direction: string, frames: StockPlanningContext["timeframes"] | null | undefined) {
  const opposite = direction === "BULLISH" ? "BEARISH" : direction === "BEARISH" ? "BULLISH" : null;
  return opposite !== null && [frames?.one_hour, frames?.thirty_minute].every((frame) => frame?.available && frame.direction === opposite);
}

export const PAPER_CODEX_START_DATE = "2026-09-21";
export const PAPER_CODEX_QUALIFIED_START_DATE = "2026-09-22";
export const PAPER_INDEX_RESEARCH_START_DATE = "2026-10-01";
export const isPaperIndexSymbol = (symbol: string) => symbol === "SPY" || symbol === "QQQ";
export const paperIndexResearchActive = (at: string | Date) => exchangeDateKey(at) >= PAPER_INDEX_RESEARCH_START_DATE;
export const paperSlotAccepts = (symbol: string, at: string | Date, ordinal: number) => !paperIndexResearchActive(at) || isPaperIndexSymbol(symbol) === (ordinal === 1);
export type PaperSelectionCandidate = { symbol: string; direction: "BULLISH" | "BEARISH"; contract_id?: string; reason: string; evidence_refs: string[]; entry_conditions?: { evidence_ref: string; entry: number; invalidation: number; target: number } | null };
export type PaperOwnerReselection = { request_id: string; requested_at: string; reason: string; replaces_plan_ids: string[] };

export function validatePaperOwnerReselection(value: unknown, day: string, at: string): PaperOwnerReselection {
  const v = value as PaperOwnerReselection | null;
  const expected = [`paper-plan:${day}`, `paper-plan:${day}:2`, `paper-plan:${day}:3`];
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "reason,replaces_plan_ids,request_id,requested_at"
    || typeof v.request_id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v.request_id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(v.request_id)
    || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 1200
    || typeof v.requested_at !== "string" || !Number.isFinite(Date.parse(v.requested_at)) || !Number.isFinite(Date.parse(at)) || Date.parse(v.requested_at) > Date.parse(at)
    || exchangeDateKey(v.requested_at) !== day || exchangeDateKey(at) !== day
    || !Array.isArray(v.replaces_plan_ids) || v.replaces_plan_ids.length !== 3 || new Set(v.replaces_plan_ids).size !== 3 || !v.replaces_plan_ids.every((id) => expected.includes(id))) throw new Error("PAPER_OWNER_RESELECTION_INVALID");
  return v;
}

export type PaperSelectionSource = {
  version: "CODEX_PAPER_SELECTION_V1" | "CODEX_PAPER_SELECTION_V2"; kind: "CODEX" | "RULE_FALLBACK"; market_date: string; decision_id: string;
  requested_at: string; completed_at: string; reason: string; input_hash: string; input_snapshot_id: string; input_snapshot_hash: string;
  invocation_id: string | null; thread_id: string | null; model: string | null; cli_version: string | null; output_hash: string | null;
  candidates: PaperSelectionCandidate[];
  owner_reselection?: PaperOwnerReselection;
};
export const paperCodexActive = (at: string | Date) => exchangeDateKey(at) >= PAPER_CODEX_START_DATE && isNyseRegularSession(exchangeDateKey(at)) && robinhoodSessionAt(at).phase === "REGULAR";
export const paperCodexQualifiedActive = (at: string | Date) => paperCodexActive(at) && exchangeDateKey(at) >= PAPER_CODEX_QUALIFIED_START_DATE;

export function validatePaperSelection(source: PaperSelectionSource, at: string) {
  const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  const qualified = source?.version === "CODEX_PAPER_SELECTION_V2";
  const candidateKeys = qualified ? "contract_id,direction,evidence_refs,reason,symbol" : "direction,evidence_refs,reason,symbol";
  const keys = ["version", "kind", "market_date", "decision_id", "requested_at", "completed_at", "reason", "input_hash", "input_snapshot_id", "input_snapshot_hash", "invocation_id", "thread_id", "model", "cli_version", "output_hash", "candidates", ...(source && Object.hasOwn(source, "owner_reselection") ? ["owner_reselection"] : [])].sort().join();
  if (!source || typeof source !== "object" || Object.keys(source).sort().join() !== keys || !Array.isArray(source.candidates) || source.candidates.length > 6
    || source.candidates.some((row) => !row || typeof row !== "object" || Object.keys(row).filter((key) => key !== "entry_conditions").sort().join() !== candidateKeys || !qualified && Object.hasOwn(row, "entry_conditions"))) throw new Error("PAPER_SELECTION_IDENTITY_INVALID");
  const reselection = Object.hasOwn(source, "owner_reselection") ? validatePaperOwnerReselection(source.owner_reselection, source.market_date, at) : null;
  const decisionId = `paper-selection:${source.market_date}${reselection ? `:owner-reselect:${reselection.request_id}` : ""}`;
  if (!["CODEX_PAPER_SELECTION_V1", "CODEX_PAPER_SELECTION_V2"].includes(source.version) || !["CODEX", "RULE_FALLBACK"].includes(source.kind)
    || qualified !== paperCodexQualifiedActive(at)
    || !paperCodexActive(at) || source.market_date !== exchangeDateKey(at) || source.decision_id !== decisionId || !text(source.reason) || source.reason.length > 1200
    || reselection && Date.parse(source.requested_at) < Date.parse(reselection.requested_at)
    || !time(source.requested_at) || !time(source.completed_at) || !paperCodexActive(source.requested_at)
    || exchangeDateKey(source.requested_at) !== source.market_date || Date.parse(source.requested_at) > Date.parse(source.completed_at) || Date.parse(source.completed_at) > Date.parse(at)
    || !hash(source.input_hash) || !hash(source.input_snapshot_hash) || !text(source.input_snapshot_id) || source.input_snapshot_id.length > 300
    || [source.invocation_id, source.thread_id, source.model, source.cli_version].some((value) => value !== null && (!text(value) || value.length > 200))
    || source.output_hash !== null && !hash(source.output_hash)
    || new Set(source.candidates.map((row) => row.symbol)).size !== source.candidates.length
    || qualified && new Set(source.candidates.map((row) => row.contract_id)).size !== source.candidates.length
    || source.candidates.some((row) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(row.symbol) || !["BULLISH", "BEARISH"].includes(row.direction)
      || qualified && (typeof row.contract_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.contract_id))
      || !text(row.reason) || row.reason.length > 800 || !Array.isArray(row.evidence_refs) || !row.evidence_refs.length || row.evidence_refs.length > 8 || !row.evidence_refs.every((value) => text(value) && value.length <= 300)
      || qualified && (!row.evidence_refs.includes(`stock:${row.symbol}`) || !row.evidence_refs.includes(`contract:${row.contract_id}`)))) throw new Error("PAPER_SELECTION_IDENTITY_INVALID");
  if (source.kind === "CODEX" && (source.candidates.length < 3 || ![source.invocation_id, source.thread_id, source.model, source.cli_version].every(text) || !hash(source.output_hash))) throw new Error("PAPER_SELECTION_MODEL_EVIDENCE_MISSING");
  if (source.kind === "RULE_FALLBACK" && source.candidates.length) throw new Error("PAPER_FALLBACK_CANNOT_CLAIM_CODEX_PICKS");
  for (const row of source.candidates) if (row.entry_conditions !== undefined && row.entry_conditions !== null) {
    const c = row.entry_conditions;
    if (!c || typeof c !== "object" || Object.keys(c).sort().join() !== "entry,evidence_ref,invalidation,target" || !/^entry:[a-f0-9]{64}$/.test(c.evidence_ref) || !row.evidence_refs.includes(c.evidence_ref)
      || ![c.entry, c.invalidation, c.target].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)
      || !(row.direction === "BULLISH" ? c.invalidation < c.entry && c.entry < c.target : c.target < c.entry && c.entry < c.invalidation)) throw new Error("PAPER_SELECTION_ENTRY_CONDITIONS_INVALID");
  }
  return source;
}
