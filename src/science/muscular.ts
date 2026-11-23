/**
 * Muscular load: the mechanical stress put on the muscles and tendons each day.
 *
 * Heart-rate based load (TRIMP) says nothing about muscle damage: a long descent or a strength session can be hard on
 * the legs at a low heart rate. This model adds two sources, in one unit ("muscular load units"):
 *
 *   eccentric  descent in running and walking sessions. When the session's FIT file has been analysed (native Garmin
 *              client), the grade-weighted descent measured from its altitude trace is used: steep descents count up to
 *              1.5 times more per metre than gentle ones. Otherwise the metres lost of the activity summary are used. Lengthening contractions on the way down are the
 *              main source of delayed muscle soreness and damage in trail running (Giandolini 2016, Vernillo 2017).
 *              1 unit = 1 metre of descent when running, 0.5 when hiking or walking, 0 on a bike (no braking effort).
 *   strength   strength sessions, from their duration: 1.5 units per minute. (A more exact figure from sets, repetitions
 *              and weight is possible when the session's exercise sets are available.)
 *
 * The relative weight of the two sources is a PLUGIN CONVENTION chosen so that a 45-minute strength session weighs
 * about as much as 70 m of running descent. It is not validated; the status model reads each athlete against their own
 * history, so only the relative size of days matters, not the unit.
 */
import { dateRange } from "../dates.ts";
import type { Activity, AlgorithmTag } from "../types.ts";
import { isNum, round } from "./stats.ts";

export const MUSCULAR_ALGORITHM: AlgorithmTag = {
  id: "muscular-load",
  version: "1.0.0",
  refs: ["giandolini2016", "vernillo2017"],
};

export const STRENGTH_UNITS_PER_MIN = 1.5;
const RUNNING = /run/i;
const WALKING = /hik|walk|mountaineer/i;
const STRENGTH = /strength|weight|hiit|crossfit|pilates|cardio_training|fitness_equipment/i;

export type MuscularDay = { date: string; load: number; eccentric: number; strength: number };

/** Muscular load of one activity, split by source. Missing data counts as zero for that source. */
export function activityMuscularLoad(activity: Activity): { eccentric: number; strength: number } {
  const type = activity.type ?? "";
  const measured = activity.descent?.eccentricUnits;
  const loss = isNum(measured) ? measured : isNum(activity.elevLossM) && activity.elevLossM > 0 ? activity.elevLossM : 0;
  const eccentric = RUNNING.test(type) ? loss : WALKING.test(type) ? loss * 0.5 : 0;
  const minutes = isNum(activity.durationS) ? activity.durationS / 60 : 0;
  const strength = STRENGTH.test(type) ? minutes * STRENGTH_UNITS_PER_MIN : 0;
  return { eccentric, strength };
}

/** One entry per calendar day from `start` to `end`; a day without activity has load 0. */
export function dailyMuscularLoads(activities: readonly Activity[], start: string, end: string): MuscularDay[] {
  const byDate = new Map<string, MuscularDay>();
  for (const date of dateRange(start, end)) byDate.set(date, { date, load: 0, eccentric: 0, strength: 0 });
  for (const activity of activities) {
    const day = byDate.get(activity.date);
    if (!day) continue;
    const part = activityMuscularLoad(activity);
    day.eccentric += part.eccentric;
    day.strength += part.strength;
    day.load += part.eccentric + part.strength;
  }
  return [...byDate.values()].map((day) => ({ ...day, load: round(day.load, 1), eccentric: round(day.eccentric, 1), strength: round(day.strength, 1) }));
}
