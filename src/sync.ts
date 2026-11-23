/**
 * Keeps the local store in step with Garmin Connect.
 *
 * - History: missing days are fetched through `gc daily` range requests
 *   (28 days per call, about 3 Garmin requests each).
 * - Recent days: the last two days are refetched with per-day detail, because
 *   today's record fills in during the day and last night's sleep appears only
 *   after the watch has synced.
 * - Activities: one list request for the missing span.
 * A failing signal never blocks the others; errors are returned to the caller.
 */

import type { CoachConfig } from "./config.ts";
import { addDays, dateRange, daysBetween } from "./dates.ts";
import type { GcRunner } from "./garmin/gc.ts";
import { hasSignal, lthrFromPayload, normalizeActivities, parseDailyExport, parseDescent } from "./garmin/normalize.ts";
import { prune, type StoreData } from "./store.ts";

const RANGE_CHUNK_DAYS = 28;
const DETAIL_DAYS = 2;
/** `gc daily --detail` accepts at most 14 days. */
const DETAIL_CHUNK_DAYS = 14;
const RANGE_TIMEOUT_MS = 90_000;
/** A stored day is final once it was fetched at least this long after it ended. */
const FINAL_AFTER_DAYS = 2;
const LTHR_REFRESH_DAYS = 7;

export type SyncReport = {
  fetchedDays: number;
  fetchedActivities: number;
  /** FIT files analysed for their descent in this run. */
  fetchedDescents: number;
  /** Stable error codes by step, e.g. { daily: "auth" }. */
  errors: Record<string, string>;
  skipped: boolean;
};

function chunks(dates: string[], size: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = 0;
  while (start < dates.length) {
    let end = start;
    // A chunk is a run of consecutive dates, at most `size` long.
    while (end + 1 < dates.length && end - start + 1 < size && addDays(dates[end], 1) === dates[end + 1]) end += 1;
    out.push([dates[start], dates[end]]);
    start = end + 1;
  }
  return out;
}

function needsFetch(store: StoreData, date: string, today: string, now: Date, cacheMinutes: number): boolean {
  const fetched = store.fetched[date];
  if (!fetched) return true;
  const age = daysBetween(date, today);
  if (age < DETAIL_DAYS) return (now.getTime() - Date.parse(fetched.at)) / 60_000 >= cacheMinutes;
  // Older days are refetched once after they are complete, then never again.
  return daysBetween(date, fetched.at.slice(0, 10)) < FINAL_AFTER_DAYS && age >= FINAL_AFTER_DAYS;
}

export async function syncStore(store: StoreData, gc: GcRunner, config: CoachConfig, today: string, now: Date = new Date()): Promise<SyncReport> {
  const report: SyncReport = { fetchedDays: 0, fetchedActivities: 0, fetchedDescents: 0, errors: {}, skipped: false };
  const stamp = now.toISOString();
  const historyStart = addDays(today, -(config.historyDays - 1));
  const recentStart = addDays(today, -(DETAIL_DAYS - 1));

  const stale = dateRange(historyStart, today).filter((date) => needsFetch(store, date, today, now, config.cacheMinutes));
  const older = stale.filter((date) => date < recentStart);
  const recent = stale.filter((date) => date >= recentStart);

  const apply = (payload: unknown, detail: boolean, step: string) => {
    const parsed = parseDailyExport(payload);
    if (!parsed) {
      report.errors[step] = "parse_error";
      return;
    }
    for (const [signal, code] of Object.entries(parsed.errors)) report.errors[`${step}.${signal}`] = code;
    for (const day of parsed.days) {
      const previous = store.days[day.date];
      // A range fetch must not erase the detail fields of an earlier per-day fetch.
      if (!detail && previous && store.fetched[day.date]?.detail && hasSignal(previous)) {
        store.fetched[day.date] = { at: stamp, detail: true };
        continue;
      }
      if (hasSignal(day) || !previous) store.days[day.date] = day;
      store.fetched[day.date] = { at: stamp, detail };
      report.fetchedDays += 1;
    }
  };

  const fatal = (code: string) => code === "auth" || code === "not_configured" || code === "unsupported";
  // A day first fetched while it was still running holds partial daily totals:
  // it is refetched with detail once it is over. Other old days use range requests.
  const incomplete = older.filter((date) => store.fetched[date]?.detail);
  const missing = older.filter((date) => !store.fetched[date]?.detail);
  const requests: Array<{ start: string; end: string; detail: boolean; step: string }> = [
    ...chunks(missing, RANGE_CHUNK_DAYS).map(([start, end]) => ({ start, end, detail: false, step: "daily" })),
    ...chunks(incomplete, DETAIL_CHUNK_DAYS).map(([start, end]) => ({ start, end, detail: true, step: "daily" })),
    ...(recent.length ? [{ start: recent[0], end: recent[recent.length - 1], detail: true, step: "recent" }] : []),
  ];
  for (const request of requests) {
    const result = await gc(["daily", "--start", request.start, "--end", request.end, request.detail ? "--detail" : "--no-detail"], {
      timeoutMs: RANGE_TIMEOUT_MS,
    });
    if (result.ok) {
      apply(result.data, request.detail, request.step);
      continue;
    }
    report.errors[request.step] = result.code;
    // Without a session or a compatible CLI, every further call would fail the same way.
    if (fatal(result.code)) return report;
  }

  const loadStart = addDays(today, -(config.loadHistoryDays - 1));
  const activitiesFresh = store.activitiesSyncedAt !== null && (now.getTime() - Date.parse(store.activitiesSyncedAt)) / 60_000 < config.cacheMinutes;
  if (!activitiesFresh) {
    // Refetch the last week too: activities are edited, and a late sync adds old ones.
    const covered = store.activitiesFrom !== null && store.activitiesFrom <= loadStart && store.activitiesSyncedAt !== null;
    const from = covered ? addDays((store.activitiesSyncedAt as string).slice(0, 10), -7) : loadStart;
    const result = await gc(["activities", "--start", from < loadStart ? loadStart : from, "--end", today], { timeoutMs: RANGE_TIMEOUT_MS });
    if (result.ok) {
      const list = normalizeActivities(result.data);
      // A refreshed summary must not forget the descent already measured from its FIT file.
      for (const activity of list) {
        const kept = store.activities[activity.id]?.descent;
        store.activities[activity.id] = kept === undefined ? activity : { ...activity, descent: kept };
      }
      store.activitiesSyncedAt = stamp;
      if (!covered) store.activitiesFrom = loadStart;
      report.fetchedActivities = list.length;
    } else {
      report.errors.activities = result.code;
    }
  }

  if (config.lthr === null && (store.lthr === null || daysBetween(store.lthr.at.slice(0, 10), today) >= LTHR_REFRESH_DAYS)) {
    const result = await gc(["metrics", "lactate-threshold"]);
    let value = result.ok ? lthrFromPayload(result.data) : null;
    if (value === null && result.ok) {
      // The latest-threshold endpoint can be empty while the current biometric profile has the value.
      const anchors = await gc(["metrics", "anchors"]);
      value = anchors.ok ? lthrFromPayload(anchors.data) : null;
    }
    if (value !== null) store.lthr = { value, at: stamp };
  }

  await enrichDescents(store, gc, loadStart, report);

  report.skipped = !stale.length && activitiesFresh && report.fetchedDescents === 0;
  prune(store, today, config.retentionDays);
  return report;
}

/** FIT files analysed per sync at most: each one is a download, and a first sync over six months would be hundreds. */
export const DESCENT_PER_SYNC = 5;
/** Below this many metres of descent in the summary, a session is not worth a download. */
const DESCENT_MIN_SUMMARY_M = 20;
const DESCENT_TYPES = /run|hik|walk/i;

/**
 * Measures the descent of recent running and walking sessions from their FIT altitude trace, newest first, a few per
 * sync. The result (or `null` when the file has nothing usable) is kept on the activity so it is never fetched again.
 * Only the native Garmin client can do it: with `gc` alone the first call comes back `unsupported` and the step stops.
 */
export async function enrichDescents(store: StoreData, gc: GcRunner, from: string, report: SyncReport): Promise<void> {
  const todo = Object.values(store.activities)
    .filter((activity) => activity.descent === undefined && activity.date >= from && DESCENT_TYPES.test(activity.type ?? "") && (activity.elevLossM ?? 0) >= DESCENT_MIN_SUMMARY_M)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, DESCENT_PER_SYNC);
  for (const activity of todo) {
    const result = await gc(["activities", "descent", activity.id], { timeoutMs: 90_000 });
    if (!result.ok) {
      // Try again at the next sync, and stop now. "Unsupported" (gc alone, or an older native client) is the normal
      // situation for some setups, not a problem to report; the other codes are.
      if (result.code !== "unsupported") report.errors.descent = result.code;
      return;
    }
    activity.descent = parseDescent(result.data);
    report.fetchedDescents += 1;
  }
}

/** How much usable history the store holds, for the data-status tool and the briefing. */
export function coverage(store: StoreData, today: string, historyDays: number) {
  const dates = dateRange(addDays(today, -(historyDays - 1)), today);
  const count = (test: (date: string) => boolean) => dates.filter(test).length;
  return {
    windowDays: dates.length,
    daysWithHrv: count((date) => store.days[date]?.hrv?.lastNightAvgMs != null),
    daysWithSleep: count((date) => store.days[date]?.sleep?.durationS != null),
    daysWithRestingHr: count((date) => store.days[date]?.restingHr != null),
    daysWithRespiration: count((date) => store.days[date]?.respiration?.sleepAvg != null),
    daysWithSpo2: count((date) => store.days[date]?.spo2?.sleepAvg != null),
    daysWithSkinTemp: count((date) => store.days[date]?.skinTempDeviationC != null),
    activities: Object.keys(store.activities).length,
    activitiesFrom: store.activitiesFrom,
    activitiesWithMeasuredDescent: Object.values(store.activities).filter((activity) => activity.descent != null).length,
    lastSync: store.activitiesSyncedAt,
    journalEntries: Object.keys(store.journal).length,
  };
}
