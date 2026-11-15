/**
 * Long-term health markers that a watch can follow, compared with published
 * thresholds. No "biological age": each marker is shown as it is, with its
 * evidence, because a composite age needs blood biomarkers and a validated
 * model (Levine 2018) that wearable data cannot replace.
 */

import type { Activity, AlgorithmTag, DayRecord } from "../types.ts";
import { analyzeSleep } from "./sleep.ts";
import type { Profile } from "../types.ts";
import { isNum, mean, median, round, roundOrNull, slope, valid } from "./stats.ts";

export const HEALTHSPAN_ALGORITHM: AlgorithmTag = {
  id: "healthspan-markers",
  version: "1.0.0",
  refs: ["bull2020", "kodama2009", "mandsager2018", "zhang2016", "windred2024", "watson2015"],
};

export type Marker = {
  marker: string;
  value: number | null;
  unit: string;
  /** Published reference the value is compared with. */
  reference: string;
  met: boolean | null;
  trend?: string | null;
  refs: string[];
};

const STRENGTH_TYPES = /strength|weight|pilates|yoga|climbing|bouldering|hiit|crossfit/i;

export function healthspanMarkers(days: readonly DayRecord[], activities: readonly Activity[], profile: Profile): { algorithm: AlgorithmTag; windowDays: number; markers: Marker[]; caveat: string } {
  const last28 = days.slice(-28);
  const moderate = valid(last28.map((day) => day.activity?.moderateMin));
  const vigorous = valid(last28.map((day) => day.activity?.vigorousMin));
  // WHO counts one vigorous minute as two moderate minutes.
  const weeklyEquivalent = moderate.length >= 14 ? round(((mean(moderate) ?? 0) + 2 * (mean(vigorous) ?? 0)) * 7, 0) : null;

  const since = last28[0]?.date;
  const strengthSessions = since ? activities.filter((activity) => activity.date >= since && STRENGTH_TYPES.test(activity.type)).length : 0;
  const strengthPerWeek = last28.length >= 14 ? round(strengthSessions / (last28.length / 7), 1) : null;

  const rhr = days.map((day) => day.restingHr);
  const rhr28 = median(valid(rhr.slice(-28)));
  const rhrSlope = slope(rhr.slice(-90));

  const vo2 = activities.filter((activity) => isNum(activity.vo2max)).sort((a, b) => a.date.localeCompare(b.date));
  const vo2Latest = vo2.length ? (vo2[vo2.length - 1].vo2max as number) : null;
  const vo2First = vo2.length > 1 ? (vo2[0].vo2max as number) : null;

  const sleep = analyzeSleep(days, profile);

  const markers: Marker[] = [
    {
      marker: "Aerobic activity",
      value: weeklyEquivalent,
      unit: "moderate-equivalent min/week (4-week mean)",
      reference: "WHO 2020: 150-300 min/week of moderate activity, or 75-150 min vigorous",
      met: weeklyEquivalent === null ? null : weeklyEquivalent >= 150,
      refs: ["bull2020"],
    },
    {
      marker: "Muscle-strengthening sessions",
      value: strengthPerWeek,
      unit: "sessions/week (4-week mean)",
      reference: "WHO 2020: at least 2 days/week",
      met: strengthPerWeek === null ? null : strengthPerWeek >= 2,
      refs: ["bull2020"],
    },
    {
      marker: "Cardiorespiratory fitness (Garmin VO2max estimate)",
      value: roundOrNull(vo2Latest, 0),
      unit: "ml/kg/min",
      reference: "Each +3.5 ml/kg/min (1 MET) goes with about 13 % lower all-cause mortality; no upper limit of benefit observed",
      met: null,
      trend: vo2Latest !== null && vo2First !== null ? `${round(vo2Latest - vo2First, 0)} over the stored history` : null,
      refs: ["kodama2009", "mandsager2018"],
    },
    {
      marker: "Resting heart rate",
      value: roundOrNull(rhr28, 0),
      unit: "bpm (28-day median)",
      reference: "Lower is associated with lower mortality in population studies (+9 % per +10 bpm)",
      met: null,
      trend: rhrSlope === null ? null : `${round(rhrSlope * 30, 1)} bpm per 30 days`,
      refs: ["zhang2016"],
    },
    {
      marker: "Sleep duration",
      value: sleep.avg14H,
      unit: "h/night (14-night mean)",
      reference: "Adults: 7 h or more per night",
      met: sleep.avg14H === null ? null : sleep.avg14H >= 7,
      refs: ["watson2015"],
    },
    {
      marker: "Sleep regularity index",
      value: sleep.regularity?.sri ?? null,
      unit: "0-100 (main sleep period)",
      reference: "Higher regularity goes with lower all-cause mortality, more strongly than duration",
      met: null,
      refs: ["windred2024"],
    },
  ];
  return {
    algorithm: HEALTHSPAN_ALGORITHM,
    windowDays: last28.length,
    markers,
    caveat:
      "Population associations, not individual predictions. Garmin's VO2max is an estimate (typical error about 5 %), and its 'fitness age' is not a validated biological age.",
  };
}
