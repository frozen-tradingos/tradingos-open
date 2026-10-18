// Library-only export for explicit local PAPER annotations. No production CLI,
// broker operation, model invocation or absolute installation path is included.
import type { DatabaseSync } from "node:sqlite";
import { exchangeDateKey } from "../app/market-time.ts";
import { validatePaperOwnerReselection, type PaperOwnerReselection } from "../app/paper-selection.ts";
import type { SnapshotState } from "../app/snapshot-import.ts";
import { makePaperEvent, openPaperPlanStore } from "../server/paper-plan-store.ts";

export function voidOriginalPaperPlans(database: DatabaseSync, snapshot: Pick<SnapshotState, "investmentKernel">, request: PaperOwnerReselection, at: string) {
  const profile = snapshot.investmentKernel;
  if (profile?.profile_mode !== "OWNER" || profile.execution_mode !== "SHADOW" || profile.broker_access !== "READ_ONLY" || profile.automated_execution !== false) throw new Error("PAPER_RESELECTION_OWNER_READONLY_REQUIRED");
  validatePaperOwnerReselection(request, exchangeDateKey(at), at);
  const paper = openPaperPlanStore(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const pending = request.replaces_plan_ids.filter((id) => {
      const events = paper.eventsForPlan(id), ending = events.findLast((event) => event.event_type === "ENDED");
      if (!events.some((event) => event.event_type === "CREATED")) throw new Error("PAPER_RESELECTION_ORIGINAL_MISSING");
      if (ending && (ending.event_type !== "ENDED" || ending.payload.reason !== "OWNER_VOID" || ending.payload.owner_request_ref !== request.request_id)) throw new Error("PAPER_RESELECTION_ORIGINAL_ALREADY_ENDED");
      return !ending;
    });
    for (const id of pending) paper.append(makePaperEvent(id, at, "ENDED", { reason: "OWNER_VOID", ended_at: at, terminal_value: "UNKNOWN", detail: request.reason.slice(0, 1000), owner_request_ref: request.request_id }));
    database.exec("COMMIT");
    return { voided_now: pending, voided_plan_ids: [...request.replaces_plan_ids] };
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
