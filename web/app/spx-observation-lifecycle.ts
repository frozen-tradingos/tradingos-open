import { isNyseRegularSession, nyseClosePtMinutes } from "./market-time.ts";
import { utcForPt } from "./timeline-schedule.ts";
import type { OwnerObservedSpxLevel, SpxOptionWatch } from "./snapshot-import.ts";

export type SpxObservationLifecycle = { status: "ACTIVE" | "EXPIRED" | "ENDED" | "VALIDITY_UNKNOWN" | "NOT_STARTED"; ends_at: string | null; reason: string | null };

export function spxContractObservationEnd(contract: Pick<SpxOptionWatch, "expiration_date" | "settlement">) {
  const date = contract.expiration_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || !isNyseRegularSession(date)) return null;
  // Cboe opening-price/closing-price settlement basis; this is an observation cutoff, not a last-trade or settlement-value timestamp.
  const minutes = contract.settlement === "AM" ? 390 : contract.settlement === "PM" ? nyseClosePtMinutes(date) : NaN;
  return Number.isFinite(minutes) ? utcForPt(date, `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`).toISOString() : null;
}

function lifecycle(start: string, end: string | null, at: string | number | Date, reason: string): SpxObservationLifecycle {
  const now = new Date(at).getTime(), began = Date.parse(start), ends = Date.parse(end ?? "");
  if (![now, began, ends].every(Number.isFinite) || ends <= began) return { status: "VALIDITY_UNKNOWN", ends_at: end, reason: "有效期未确认，不能作为当前观察" };
  return { status: now < began ? "NOT_STARTED" : now >= ends ? "EXPIRED" : "ACTIVE", ends_at: end, reason: now >= ends ? reason : null };
}

export function spxOwnerObservationLifecycle(observation: Pick<OwnerObservedSpxLevel, "observed_at" | "valid_until">, at: string | number | Date = Date.now()) {
  return lifecycle(observation.observed_at, observation.valid_until, at, "人工观察有效期已到，仅保留历史");
}

export function spxWatchLifecycle(watch: Pick<SpxOptionWatch, "created_at" | "valid_until" | "expiration_date" | "settlement"> & Partial<Pick<SpxOptionWatch, "events">>, at: string | number | Date = Date.now()): SpxObservationLifecycle {
  const contractEnd = spxContractObservationEnd(watch), ownerEnd = watch.valid_until;
  const invalidOwnerEnd = ownerEnd !== null && !Number.isFinite(Date.parse(ownerEnd));
  const end = !contractEnd || invalidOwnerEnd ? null : ownerEnd && Date.parse(ownerEnd) < Date.parse(contractEnd) ? ownerEnd : contractEnd;
  const ended = watch.events?.find((event) => event.event_type === "ENDED");
  if (ended) return { status: "ENDED", ends_at: end, reason: ended.reason ?? "已记录结束观察" };
  return lifecycle(watch.created_at, end, at, end === contractEnd ? "合约观察到期，仅保留历史；最终价值未核验" : "本地观察有效期已到，仅保留历史");
}
