/**
 * Local store: day records, activities and the journal, as JSON files in the
 * plugin's data directory (owner-only permissions, atomic writes).
 *
 * The store exists because baselines need 60-180 days of history and Garmin
 * cannot be queried for that on every call. It holds nightly aggregates only:
 * no intraday series, no GPS tracks, no credentials.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { addDays } from "./dates.ts";
import type { Activity, DayRecord, JournalEntry } from "./types.ts";

export type StoreData = {
  schemaVersion: 1;
  days: Record<string, DayRecord>;
  /** When each day was last fetched, and whether with per-day detail. */
  fetched: Record<string, { at: string; detail: boolean }>;
  activities: Record<string, Activity>;
  activitiesSyncedAt: string | null;
  /** First day covered by the stored activity list. */
  activitiesFrom: string | null;
  journal: Record<string, JournalEntry>;
  lthr: { value: number; at: string } | null;
};

export function emptyStore(): StoreData {
  return { schemaVersion: 1, days: {}, fetched: {}, activities: {}, activitiesSyncedAt: null, activitiesFrom: null, journal: {}, lthr: null };
}

const FILE = "coach-store.json";

export async function loadStore(dataDir: string): Promise<StoreData> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dataDir, FILE), "utf8")) as Partial<StoreData>;
    if (parsed?.schemaVersion !== 1) return emptyStore();
    return { ...emptyStore(), ...parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    // A corrupt file must not be silently replaced by an empty store on the next save.
    throw new Error(`Coach store at ${path.join(dataDir, FILE)} is unreadable: ${(error as Error).message}`);
  }
}

export async function saveStore(dataDir: string, store: StoreData): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const target = path.join(dataDir, FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(store), { mode: 0o600 });
  await rename(temporary, target);
}

/** Drops everything older than the retention period. The journal follows the same rule. */
export function prune(store: StoreData, today: string, retentionDays: number): void {
  const cutoff = addDays(today, -retentionDays);
  for (const date of Object.keys(store.days)) if (date < cutoff) delete store.days[date];
  for (const date of Object.keys(store.fetched)) if (date < cutoff) delete store.fetched[date];
  for (const date of Object.keys(store.journal)) if (date < cutoff) delete store.journal[date];
  for (const [id, activity] of Object.entries(store.activities)) if (activity.date < cutoff) delete store.activities[id];
}

/** Day records from `start` to `end`; a missing day is an empty record, so series stay aligned. */
export function daysBetweenDates(store: StoreData, dates: readonly string[]): DayRecord[] {
  return dates.map((date) => store.days[date] ?? emptyDay(date));
}

export function emptyDay(date: string): DayRecord {
  return {
    date,
    sleep: null,
    hrv: null,
    restingHr: null,
    respiration: null,
    spo2: null,
    skinTempDeviationC: null,
    stress: null,
    bodyBattery: null,
    activity: null,
    heartRate: null,
    sources: [],
    errors: {},
  };
}

export function activitiesFrom(store: StoreData, start: string, end: string): Activity[] {
  return Object.values(store.activities)
    .filter((activity) => activity.date >= start && activity.date <= end)
    .sort((a, b) => (a.startLocal ?? a.date).localeCompare(b.startLocal ?? b.date));
}
