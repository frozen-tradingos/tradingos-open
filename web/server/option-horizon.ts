export type OptionHoldingHorizon = "INTRADAY_0_1" | "SHORT_2_7" | "SWING_14_60" | "LONG_90_PLUS" | "UNCLASSIFIED";

export function optionDte(expiration: string | null, marketDate: string) {
  if (!expiration) return null;
  const end = Date.parse(`${expiration}T12:00:00.000Z`), start = Date.parse(`${marketDate}T12:00:00.000Z`);
  return Number.isFinite(end) && Number.isFinite(start) ? Math.floor((end - start) / 86_400_000) : null;
}

export function isPaperOptionExpiration(expiration: string, marketDate: string) {
  const dte = optionDte(expiration, marketDate);
  return dte !== null && dte >= 7 && dte <= 30;
}

export function optionHorizon(dte: number | null): OptionHoldingHorizon {
  if (dte === null || dte < 0) return "UNCLASSIFIED";
  if (dte <= 1) return "INTRADAY_0_1";
  if (dte <= 7) return "SHORT_2_7";
  if (dte >= 14 && dte <= 60) return "SWING_14_60";
  if (dte >= 90) return "LONG_90_PLUS";
  return "UNCLASSIFIED";
}

export function representativeOptionExpirations(expirations: string[], marketDate: string) {
  const rows = expirations.map((expiration) => ({ expiration, dte: optionDte(expiration, marketDate) })).filter((row): row is { expiration: string; dte: number } => row.dte !== null && row.dte >= 0);
  const targets: Array<[OptionHoldingHorizon, number]> = [["INTRADAY_0_1", 0], ["SHORT_2_7", 5], ["SWING_14_60", 30], ["LONG_90_PLUS", 90]];
  return targets.flatMap(([horizon, target]) => rows.filter((row) => optionHorizon(row.dte) === horizon).toSorted((a, b) => Math.abs(a.dte - target) - Math.abs(b.dte - target) || a.dte - b.dte).slice(0, 1).map((row) => row.expiration));
}
