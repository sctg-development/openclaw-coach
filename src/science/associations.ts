/**
 * Habit journal: does a logged habit go with a different night afterwards?
 *
 * For each habit tag, the nights following days with the habit are compared with
 * the nights following days without it. The output is an observed association
 * in one person's uncontrolled data, never a causal effect: habits cluster
 * (alcohol on weekends, late nights with hard sessions), and the athlete knows
 * which nights were which. Each comparison reports group sizes, the difference
 * with a bootstrap confidence interval, a standardized effect size (Hedges' g),
 * a permutation p-value, and a false-discovery-rate adjustment across all the
 * comparisons made in the same call (Benjamini & Hochberg 1995).
 */

import { addDays } from "../dates.ts";
import type { AlgorithmTag, DayRecord, JournalEntry } from "../types.ts";
import { lnRmssd } from "./hrv.ts";
import { benjaminiHochberg, bootstrapDiffCi, hedgesG, isNum, mean, permutationP, round } from "./stats.ts";

export const ASSOCIATION_ALGORITHM: AlgorithmTag = {
  id: "habit-associations",
  version: "1.0.0",
  refs: ["benjamini1995", "efron1993", "hedges1981"],
};

/** Nights needed in each group before a comparison is reported. */
export const MIN_GROUP_SIZE = 5;

type Outcome = { key: string; label: string; unit: string; get: (day: DayRecord) => number | null; asPercent?: boolean };

export const OUTCOMES: Outcome[] = [
  { key: "hrv", label: "overnight HRV", unit: "%", get: (day) => lnRmssd(day), asPercent: true },
  { key: "restingHr", label: "resting heart rate", unit: "bpm", get: (day) => day.restingHr },
  { key: "sleepDuration", label: "sleep duration", unit: "min", get: (day) => (isNum(day.sleep?.durationS) ? day.sleep.durationS / 60 : null) },
  { key: "deepSleep", label: "deep sleep", unit: "min", get: (day) => (isNum(day.sleep?.deepS) ? day.sleep.deepS / 60 : null) },
  { key: "sleepScore", label: "Garmin sleep score", unit: "points", get: (day) => day.sleep?.score ?? null },
  { key: "respiration", label: "sleep respiratory rate", unit: "breaths/min", get: (day) => day.respiration?.sleepAvg ?? null },
];

export type Association = {
  tag: string;
  outcome: string;
  unit: string;
  nightsWith: number;
  nightsWithout: number;
  /** Mean after days with the habit minus mean after days without (HRV: percent). */
  difference: number;
  ci95: [number, number] | null;
  effectSize: number | null;
  pValue: number | null;
  /** p-value adjusted for the number of comparisons in this call. */
  pAdjusted: number | null;
  reading: "no clear difference" | "possible difference" | "consistent difference";
};

export type AssociationReport = {
  algorithm: AlgorithmTag;
  associations: Association[];
  /** Tags logged too rarely (or too often) to compare. */
  insufficient: Array<{ tag: string; daysWith: number; daysWithout: number }>;
  caveats: string[];
};

function isOn(value: boolean | number | undefined): boolean {
  return value === true || (typeof value === "number" && value > 0);
}

/**
 * @param days Day records by ascending date. The night that follows journal day D
 *             is stored on record D + 1 (records are dated by wake-up day).
 */
export function habitAssociations(days: readonly DayRecord[], journal: readonly JournalEntry[]): AssociationReport {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const logged = journal.filter((entry) => byDate.has(addDays(entry.date, 1)));
  const tags = [...new Set(logged.flatMap((entry) => Object.keys(entry.tags)))].sort();

  const associations: Association[] = [];
  const insufficient: AssociationReport["insufficient"] = [];
  for (const tag of tags) {
    // A day counts as "without" only if the journal was filled that day: an
    // absent entry is unknown, not "no".
    const withDays = logged.filter((entry) => isOn(entry.tags[tag]));
    const withoutDays = logged.filter((entry) => !isOn(entry.tags[tag]));
    if (withDays.length < MIN_GROUP_SIZE || withoutDays.length < MIN_GROUP_SIZE) {
      insufficient.push({ tag, daysWith: withDays.length, daysWithout: withoutDays.length });
      continue;
    }
    for (const outcome of OUTCOMES) {
      const values = (entries: readonly JournalEntry[]) =>
        entries.map((entry) => outcome.get(byDate.get(addDays(entry.date, 1)) as DayRecord)).filter(isNum);
      const a = values(withDays);
      const b = values(withoutDays);
      if (a.length < MIN_GROUP_SIZE || b.length < MIN_GROUP_SIZE) continue;
      const raw = (mean(a) as number) - (mean(b) as number);
      const ci = bootstrapDiffCi(a, b);
      // HRV is compared on the log scale; the difference is reported as a percent change.
      const show = (x: number) => (outcome.asPercent ? round((Math.exp(x) - 1) * 100, 1) : round(x, 1));
      associations.push({
        tag,
        outcome: outcome.label,
        unit: outcome.unit,
        nightsWith: a.length,
        nightsWithout: b.length,
        difference: show(raw),
        ci95: ci ? [show(ci[0]), show(ci[1])] : null,
        effectSize: (() => {
          const g = hedgesG(a, b);
          return g === null ? null : round(g, 2);
        })(),
        pValue: permutationP(a, b),
        pAdjusted: null,
        reading: "no clear difference",
      });
    }
  }

  const tested = associations.filter((item) => item.pValue !== null);
  const adjusted = benjaminiHochberg(tested.map((item) => item.pValue as number));
  tested.forEach((item, index) => {
    item.pValue = round(item.pValue as number, 3);
    item.pAdjusted = round(adjusted[index], 3);
    const excludesZero = item.ci95 !== null && (item.ci95[0] > 0 || item.ci95[1] < 0);
    if (item.pAdjusted < 0.05 && excludesZero) item.reading = "consistent difference";
    else if (excludesZero && Math.abs(item.effectSize ?? 0) >= 0.5) item.reading = "possible difference";
  });

  return {
    algorithm: ASSOCIATION_ALGORITHM,
    associations,
    insufficient,
    caveats: [
      "Observed association in uncontrolled personal data: it does not show that the habit causes the difference.",
      "Habits cluster with weekdays, training and each other; a difference can come from what accompanies the habit.",
      `Comparisons need at least ${MIN_GROUP_SIZE} nights in each group; more nights give narrower intervals.`,
    ],
  };
}
