/**
 * Sleep: sufficiency against the individual need, running debt, continuity,
 * and regularity of timing.
 *
 * - Need: Garmin's nightly personal need when the watch reports it, otherwise the
 *   configured need (default 8 h; adults need at least 7 h, Watson 2015; athletes
 *   often more, Walsh 2021).
 * - Debt: running balance of (need - sleep) over the last 14 nights, floored at 0.
 *   Deficits accumulate (Van Dongen 2003) and are repaid slowly (Kitamura 2016).
 *   This balance is a bookkeeping heuristic, not a measured physiological quantity.
 * - Regularity: Sleep Regularity Index (Phillips 2017) computed on the main sleep
 *   period, and the SD of sleep onset / midpoint (Huang 2020). Irregular sleep
 *   predicts mortality better than short sleep (Windred 2024).
 * - Stages (deep/REM) are reported but not scored: wrist staging agrees only
 *   moderately with polysomnography (de Zambotti 2019, Chinoy 2021).
 */

import { addDays, formatClock, localEpochMinutes, weekdayIndex } from "../dates.ts";
import type { AlgorithmTag, DataStatus, DayRecord, Profile } from "../types.ts";
import { isNum, mean, round, roundOrNull, sd } from "./stats.ts";

export const SLEEP_ALGORITHM: AlgorithmTag = {
  id: "sleep-balance",
  version: "1.0.0",
  refs: ["watson2015", "walsh2021", "vandongen2003", "kitamura2016", "phillips2017", "windred2024", "huang2020", "dezambotti2019"],
};

export const SLEEP_DEBT_NIGHTS = 14;
export const SLEEP_REGULARITY_NIGHTS = 14;
const MIN_REGULARITY_NIGHTS = 5;
const MINUTES_PER_DAY = 1440;

export type SleepNight = {
  date: string;
  durationH: number | null;
  needH: number;
  needSource: "garmin" | "profile";
  /** Sleep duration divided by need. */
  sufficiency: number | null;
  /** Sleep time / (sleep time + awake time): continuity of the sleep period. */
  efficiencyPct: number | null;
  deepPct: number | null;
  remPct: number | null;
  awakeMin: number | null;
  bedtime: string | null;
  wakeTime: string | null;
  garminScore: number | null;
};

export type SleepAnalysis = {
  status: DataStatus;
  algorithm: AlgorithmTag;
  lastNight: SleepNight | null;
  /** Running sleep debt in hours, and how it was built. */
  debtH: number | null;
  debtNights: number;
  avg7H: number | null;
  avg14H: number | null;
  avgNeedH: number | null;
  regularity: {
    nights: number;
    /** Sleep Regularity Index, 0-100 (main sleep period only). */
    sri: number | null;
    onsetSdMin: number | null;
    wakeSdMin: number | null;
    midpointSdMin: number | null;
    meanBedtime: string | null;
    meanWakeTime: string | null;
    /** Midpoint difference between nights ending on Saturday/Sunday and other nights. */
    socialJetlagMin: number | null;
  } | null;
  notes: string[];
};

function needSeconds(day: DayRecord, profile: Profile): { seconds: number; source: "garmin" | "profile" } {
  const garmin = day.sleep?.needS;
  // A need outside 5-11 h is treated as a payload unit problem, not as physiology.
  if (isNum(garmin) && garmin >= 5 * 3600 && garmin <= 11 * 3600) return { seconds: garmin, source: "garmin" };
  return { seconds: profile.sleepNeedS, source: "profile" };
}

export function describeNight(day: DayRecord | undefined, profile: Profile): SleepNight | null {
  const sleep = day?.sleep;
  if (!day || !sleep || !isNum(sleep.durationS)) return null;
  const need = needSeconds(day, profile);
  const awake = sleep.awakeS;
  const pct = (part: number | null) => (isNum(part) && sleep.durationS ? round((part / sleep.durationS) * 100, 0) : null);
  return {
    date: day.date,
    durationH: round(sleep.durationS / 3600, 2),
    needH: round(need.seconds / 3600, 2),
    needSource: need.source,
    sufficiency: round(sleep.durationS / need.seconds, 2),
    efficiencyPct: isNum(awake) ? round((sleep.durationS / (sleep.durationS + awake)) * 100, 0) : null,
    deepPct: pct(sleep.deepS),
    remPct: pct(sleep.remS),
    awakeMin: isNum(awake) ? round(awake / 60, 0) : null,
    bedtime: sleep.startLocal ? sleep.startLocal.slice(11, 16) : null,
    wakeTime: sleep.endLocal ? sleep.endLocal.slice(11, 16) : null,
    garminScore: sleep.score,
  };
}

/** Running balance of need minus sleep; a night without data leaves the balance unchanged. */
export function sleepDebtHours(days: readonly DayRecord[], profile: Profile): { debtH: number | null; nights: number } {
  let debt = 0;
  let nights = 0;
  for (const day of days.slice(-SLEEP_DEBT_NIGHTS)) {
    const duration = day.sleep?.durationS;
    if (!isNum(duration)) continue;
    nights += 1;
    debt = Math.max(0, debt + needSeconds(day, profile).seconds - duration);
  }
  return { debtH: nights >= 3 ? round(debt / 3600, 1) : null, nights };
}

type Interval = { date: string; start: number; end: number };

function intervals(days: readonly DayRecord[]): Interval[] {
  const out: Interval[] = [];
  for (const day of days) {
    const start = localEpochMinutes(day.sleep?.startLocal);
    const end = localEpochMinutes(day.sleep?.endLocal);
    if (start !== null && end !== null && end > start && end - start < MINUTES_PER_DAY) out.push({ date: day.date, start, end });
  }
  return out;
}

/**
 * Sleep Regularity Index: probability of being in the same state (asleep/awake)
 * at two times 24 h apart, rescaled to 0-100 (100 = identical days).
 * Computed in closed form from the main sleep intervals of consecutive nights.
 */
export function sleepRegularityIndex(nights: readonly Interval[]): number | null {
  const agreements: number[] = [];
  for (let index = 0; index + 1 < nights.length; index += 1) {
    const a = nights[index];
    const b = nights[index + 1];
    if (addDays(a.date, 1) !== b.date) continue;
    const shiftedStart = b.start - MINUTES_PER_DAY;
    const shiftedEnd = b.end - MINUTES_PER_DAY;
    const overlap = Math.max(0, Math.min(a.end, shiftedEnd) - Math.max(a.start, shiftedStart));
    const mismatch = a.end - a.start + (shiftedEnd - shiftedStart) - 2 * overlap;
    agreements.push(1 - mismatch / MINUTES_PER_DAY);
  }
  if (agreements.length < MIN_REGULARITY_NIGHTS - 1) return null;
  return round(-100 + 200 * (mean(agreements) as number), 0);
}

/** Clock time as minutes relative to the midnight that starts the wake-up date. */
function relativeMinutes(night: Interval, which: "start" | "end" | "mid"): number {
  const midnight = (localEpochMinutes(`${night.date}T00:00:00`) as number);
  const value = which === "start" ? night.start : which === "end" ? night.end : (night.start + night.end) / 2;
  return value - midnight;
}

export function analyzeSleep(days: readonly DayRecord[], profile: Profile): SleepAnalysis {
  const notes: string[] = [];
  const lastNight = describeNight(days[days.length - 1], profile);
  const { debtH, nights: debtNights } = sleepDebtHours(days, profile);

  const hours = (count: number) => {
    const values = days
      .slice(-count)
      .map((day) => day.sleep?.durationS)
      .filter(isNum)
      .map((seconds) => seconds / 3600);
    return values.length >= Math.ceil(count / 2) ? mean(values) : null;
  };
  const needs = days.slice(-SLEEP_DEBT_NIGHTS).filter((day) => isNum(day.sleep?.durationS)).map((day) => needSeconds(day, profile).seconds / 3600);

  const recent = intervals(days.slice(-SLEEP_REGULARITY_NIGHTS));
  let regularity: SleepAnalysis["regularity"] = null;
  if (recent.length >= MIN_REGULARITY_NIGHTS) {
    const onsets = recent.map((night) => relativeMinutes(night, "start"));
    const wakes = recent.map((night) => relativeMinutes(night, "end"));
    const mids = recent.map((night) => relativeMinutes(night, "mid"));
    const free = recent.filter((night) => weekdayIndex(night.date) >= 5).map((night) => relativeMinutes(night, "mid"));
    const work = recent.filter((night) => weekdayIndex(night.date) < 5).map((night) => relativeMinutes(night, "mid"));
    regularity = {
      nights: recent.length,
      sri: sleepRegularityIndex(recent),
      onsetSdMin: roundOrNull(sd(onsets), 0),
      wakeSdMin: roundOrNull(sd(wakes), 0),
      midpointSdMin: roundOrNull(sd(mids), 0),
      meanBedtime: formatClock(mean(onsets) as number),
      meanWakeTime: formatClock(mean(wakes) as number),
      socialJetlagMin: free.length >= 2 && work.length >= 2 ? round(Math.abs((mean(free) as number) - (mean(work) as number)), 0) : null,
    };
    if (isNum(regularity.onsetSdMin) && regularity.onsetSdMin > 60) {
      notes.push(`Bedtime varies by ${regularity.onsetSdMin} min (SD) over ${recent.length} nights: irregular timing.`);
    }
  }

  if (lastNight) {
    if (isNum(lastNight.durationH) && lastNight.durationH < 7) notes.push(`Short night: ${lastNight.durationH} h (adults need at least 7 h).`);
    if (isNum(lastNight.efficiencyPct) && lastNight.efficiencyPct < 85) notes.push(`Fragmented night: sleep efficiency ${lastNight.efficiencyPct} %.`);
  } else {
    notes.push("No sleep recorded for last night.");
  }

  const status: DataStatus = lastNight ? (debtNights >= 7 ? "ready" : "calibrating") : debtNights >= 7 ? "calibrating" : "insufficient_data";
  return {
    status,
    algorithm: SLEEP_ALGORITHM,
    lastNight,
    debtH,
    debtNights,
    avg7H: roundOrNull(hours(7), 2),
    avg14H: roundOrNull(hours(14), 2),
    avgNeedH: roundOrNull(mean(needs), 2),
    regularity,
    notes,
  };
}
