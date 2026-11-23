/**
 * Weekly intensity minutes against the public physical-activity guidelines.
 *
 * Both the WHO (2020) and the American guidelines (HHS Physical Activity Guidelines for Americans, 2018, adopted
 * by the American Heart Association) recommend 150 to 300 minutes of moderate activity a week, or 75 to 150
 * minutes of vigorous activity, or an equivalent mix. One vigorous minute counts as two moderate minutes, which
 * is also how Garmin totals its "intensity minutes". The figures are Garmin's own per-day minutes (heart-rate
 * and movement based), so they include walking and daily life as well as workouts.
 *
 * Descriptive only: the guideline is a population minimum for health, not a training target.
 */
import { addDays, weekStart } from "../dates.ts";
import type { AlgorithmTag, DataStatus, DayRecord } from "../types.ts";
import { isNum, round, sum } from "./stats.ts";

export const INTENSITY_ALGORITHM: AlgorithmTag = {
  id: "intensity-minutes",
  version: "1.0.0",
  refs: ["bull2020", "piercy2018"],
};

/** Weekly minimum (moderate-equivalent) and the upper end of the benefit range. */
export const WEEKLY_MINIMUM_MIN = 150;
export const WEEKLY_UPPER_MIN = 300;
/** Days with data needed in a 7-day window before a total is reported. */
export const MIN_DAYS_WITH_DATA = 5;

export type IntensityWindow = {
  /** First day of the window, and the last day included. */
  from: string;
  to: string;
  daysWithData: number;
  moderateMin: number | null;
  vigorousMin: number | null;
  /** Moderate minutes + 2 x vigorous minutes. */
  equivalentMin: number | null;
};

export type IntensityMinutes = {
  status: DataStatus;
  algorithm: AlgorithmTag;
  /** The 7 days ending on the assessed day. */
  rolling7: IntensityWindow;
  /** Monday to the assessed day (the week so far, so it is lower early in the week). */
  weekToDate: IntensityWindow;
  /** Rolling 7-day total as a percentage of the 150-minute minimum. */
  percentOfMinimum: number | null;
  minimumMet: boolean | null;
  /** Completed calendar weeks (Monday-Sunday), most recent first, up to four. */
  previousWeeks: Array<{ weekStart: string; equivalentMin: number | null }>;
  guideline: string;
};

function windowOf(byDate: ReadonlyMap<string, DayRecord>, from: string, to: string, minDays = MIN_DAYS_WITH_DATA): IntensityWindow {
  const moderate: number[] = [];
  const vigorous: number[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const activity = byDate.get(date)?.activity;
    // A day counts only when both figures are known: a missing value is unknown, not zero.
    if (activity && isNum(activity.moderateMin) && isNum(activity.vigorousMin)) {
      moderate.push(activity.moderateMin);
      vigorous.push(activity.vigorousMin);
    }
  }
  const complete = moderate.length >= minDays;
  const m = sum(moderate);
  const v = sum(vigorous);
  return { from, to, daysWithData: moderate.length, moderateMin: complete ? m : null, vigorousMin: complete ? v : null, equivalentMin: complete ? m + 2 * v : null };
}

/** @param days Day records, ascending, ending on the assessed day `date`. */
export function intensityMinutes(days: readonly DayRecord[], date: string): IntensityMinutes {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const rolling7 = windowOf(byDate, addDays(date, -6), date);
  const monday = weekStart(date);
  // Early in the week there are few days: report what exists (daysWithData says how many) instead of nothing.
  const toDate = windowOf(byDate, monday, date, 1);
  const previousWeeks: IntensityMinutes["previousWeeks"] = [];
  for (let i = 1; i <= 4; i += 1) {
    const start = addDays(monday, -7 * i);
    previousWeeks.push({ weekStart: start, equivalentMin: windowOf(byDate, start, addDays(start, 6)).equivalentMin });
  }
  const total = rolling7.equivalentMin;
  return {
    status: total === null ? "insufficient_data" : "ready",
    algorithm: INTENSITY_ALGORITHM,
    rolling7,
    weekToDate: toDate,
    percentOfMinimum: total === null ? null : round((total / WEEKLY_MINIMUM_MIN) * 100, 0),
    minimumMet: total === null ? null : total >= WEEKLY_MINIMUM_MIN,
    previousWeeks,
    guideline: `WHO 2020 and US guidelines: ${WEEKLY_MINIMUM_MIN}-${WEEKLY_UPPER_MIN} min/week moderate, or half that vigorous (1 vigorous min = 2 moderate).`,
  };
}
