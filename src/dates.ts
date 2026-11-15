/** Calendar-date helpers. Dates are `YYYY-MM-DD` strings in the athlete's timezone. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function toUtc(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  return new Date(toUtc(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** Every date from `start` to `end`, both included. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) out.push(day);
  return out;
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(date: string): number {
  return (new Date(toUtc(date)).getUTCDay() + 6) % 7;
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, -weekdayIndex(date));
}

/** Today's calendar date in an IANA timezone. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  // The en-CA locale formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    now,
  );
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Minutes after midnight of a local wall-clock timestamp (`YYYY-MM-DDTHH:MM:SS`,
 * no zone suffix, as written by `gc daily`).
 */
export function clockMinutes(localIso: string | null | undefined): number | null {
  if (typeof localIso !== "string") return null;
  const match = /T(\d{2}):(\d{2})/.exec(localIso);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Epoch minutes of a local wall-clock timestamp, read as if it were UTC. */
export function localEpochMinutes(localIso: string | null | undefined): number | null {
  if (typeof localIso !== "string") return null;
  const time = Date.parse(`${localIso.slice(0, 19)}Z`);
  return Number.isFinite(time) ? Math.round(time / 60_000) : null;
}

export function formatClock(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}
