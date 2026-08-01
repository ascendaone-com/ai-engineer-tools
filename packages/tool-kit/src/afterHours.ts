/**
 * Local-time after-hours check used by tool-side producers.
 * NOTE: the backend aggregate currently standardises on 08:00-18:00 UTC —
 * a known discrepancy tracked for reconciliation; change it here once the
 * contract decides which definition is canonical.
 */
export function isAfterHours(now = new Date(), start = "19:00", end = "07:00"): boolean {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = parseTimeToMinutes(start, 19 * 60);
  const endMinutes = parseTimeToMinutes(end, 7 * 60);
  if (startMinutes === endMinutes) return false; // zero-length window: after-hours flagging disabled
  if (startMinutes < endMinutes) return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function parseTimeToMinutes(value: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const hours = Number(match[1]); const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return fallback;
  return Math.max(0, Math.min(23, hours)) * 60 + Math.max(0, Math.min(59, minutes));
}
