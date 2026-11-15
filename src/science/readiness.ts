/**
 * Daily training decision: the highest intensity that today's signals support.
 *
 * The core rule is HRV-guided training, the only wearable-based daily rule
 * tested in randomized trials: do high-intensity work when the 7-day HRV trend
 * is inside the personal normal range, otherwise train easy or rest (Kiviniemi
 * 2007, Vesterinen 2016, Javaloyes 2019; meta-analysis Düking 2021). The other
 * rules only lower the ceiling: a possible illness, a short night, a load spike.
 *
 * The result is a ceiling, not a prescription: the plan, the athlete's symptoms
 * and the constraints of ATHLETE.md come first, and subjective state is at least
 * as informative as any device signal (Saw 2016).
 */

import type { AlgorithmTag, JournalEntry } from "../types.ts";
import type { HrvAnalysis } from "./hrv.ts";
import type { LoadAnalysis } from "./load.ts";
import type { RecoveryAnalysis, WarningAnalysis } from "./recovery.ts";
import type { SleepAnalysis } from "./sleep.ts";
import { isNum, round } from "./stats.ts";

export const READINESS_ALGORITHM: AlgorithmTag = {
  id: "readiness-decision",
  version: "1.0.0",
  refs: ["kiviniemi2007", "vesterinen2016", "javaloyes2019", "duking2021", "saw2016", "fullagar2015", "schwellnus2016", "foster1998"],
};

export type Ceiling = "rest" | "easy" | "moderate" | "hard";
const ORDER: Ceiling[] = ["rest", "easy", "moderate", "hard"];

export type ReadinessDecision = {
  algorithm: AlgorithmTag;
  /** Highest intensity supported today. */
  ceiling: Ceiling;
  /** What each ceiling means in practice. */
  meaning: string;
  reasons: Array<{ rule: string; caps: Ceiling; detail: string }>;
  /** Suggested load range for today, in the load unit, relative to current fitness (heuristic). */
  suggestedLoad: { min: number; max: number } | null;
  confidence: "high" | "medium" | "low";
  caveats: string[];
};

const MEANING: Record<Ceiling, string> = {
  rest: "Rest or very light movement only.",
  easy: "Easy aerobic work only (zones 1-2), no intensity.",
  moderate: "Steady aerobic or tempo work is fine; postpone maximal or very long sessions.",
  hard: "No signal argues against a planned hard or long session.",
};

/** Share of current fitness (CTL) suggested as today's load for each ceiling. */
const LOAD_SHARE: Record<Ceiling, [number, number]> = {
  rest: [0, 0.3],
  easy: [0.3, 0.8],
  moderate: [0.8, 1.3],
  hard: [1.2, 2],
};

export function decideReadiness(input: {
  hrv: HrvAnalysis;
  recovery: RecoveryAnalysis;
  warning: WarningAnalysis;
  sleep: SleepAnalysis;
  load: LoadAnalysis;
  journal?: JournalEntry | null;
}): ReadinessDecision {
  const { hrv, recovery, warning, sleep, load, journal } = input;
  const reasons: ReadinessDecision["reasons"] = [];
  const cap = (rule: string, caps: Ceiling, detail: string) => reasons.push({ rule, caps, detail });

  if (warning.level === "elevated") {
    cap(
      "early-warning",
      warning.persistent ? "rest" : "easy",
      `Several signals are outside the personal range (${warning.signals.join("; ")})${warning.persistent ? ", for the second day" : ""}. Check for symptoms before training.`,
    );
  }

  if (hrv.trend === "below") {
    cap("hrv-guided", "easy", `7-day HRV (${hrv.rolling7Ms} ms) is below the personal normal range (${hrv.baseline?.lowMs}-${hrv.baseline?.highMs} ms) for ${hrv.daysBelow} day(s).`);
  } else if (hrv.trend === "above" && isNum(recovery.deviations.restingHr.z) && recovery.deviations.restingHr.z > 1) {
    cap("hrv-guided", "moderate", "7-day HRV is above the normal range while resting heart rate is also raised: an unusual pattern, treat with caution.");
  }

  if (recovery.band === "low") {
    cap("recovery-index", "easy", `Recovery index ${recovery.score}/100: last night is clearly below this athlete's usual.`);
  }

  const night = sleep.lastNight;
  if (night && isNum(night.durationH) && (night.durationH < 5 || (isNum(night.sufficiency) && night.sufficiency < 0.6))) {
    cap("sleep", "easy", `Very short night (${night.durationH} h).`);
  } else if (night && isNum(night.durationH) && (night.durationH < 6 || (isNum(night.sufficiency) && night.sufficiency < 0.75))) {
    cap("sleep", "moderate", `Short night (${night.durationH} h for a need of ${night.needH} h).`);
  }
  if (isNum(sleep.debtH) && sleep.debtH >= 8) {
    cap("sleep-debt", "moderate", `Sleep debt of ${sleep.debtH} h over ${sleep.debtNights} nights.`);
  }

  if (load.flags.includes("load_spike")) {
    cap("load", "moderate", `The last 7 days carry ${load.acuteChronicRatio} times the load of the previous three weeks.`);
  }
  if (load.flags.includes("high_monotony")) {
    cap("load", "moderate", `Training monotony ${load.monotony} (> 2): the week lacks easy days.`);
  }

  if (journal) {
    if (journal.symptoms?.length) {
      cap("symptoms", "rest", `Reported symptoms: ${journal.symptoms.join(", ")}. Symptoms come before any device signal.`);
    }
    const poor = [journal.fatigue, journal.soreness, journal.mood, journal.sleepQuality, journal.stress].filter((value) => isNum(value) && value <= 2).length;
    if (poor >= 2) cap("wellness", "easy", `${poor} wellness ratings at 2/5 or below today.`);
  }

  const ceiling = reasons.reduce<Ceiling>((lowest, reason) => (ORDER.indexOf(reason.caps) < ORDER.indexOf(lowest) ? reason.caps : lowest), "hard");

  const ready = [hrv.status, recovery.status, sleep.status].filter((status) => status === "ready").length;
  const confidence = ready === 3 && hrv.nightsInTrend >= 5 ? "high" : ready >= 2 ? "medium" : "low";
  const caveats: string[] = [];
  if (hrv.status !== "ready") caveats.push("HRV baseline not established yet: the HRV-guided rule is inactive.");
  // A single deviating signal happens by chance on several days a month: it is
  // reported, but it does not lower the ceiling on its own.
  if (warning.level === "watch") caveats.push(`One signal is outside the personal range (${warning.signals[0]}): worth a second look tomorrow.`);
  if (!journal) caveats.push("No subjective check-in for today: ask how the athlete feels before applying this ceiling.");

  const ctl = load.today?.ctl;
  const share = LOAD_SHARE[ceiling];
  return {
    algorithm: READINESS_ALGORITHM,
    ceiling,
    meaning: MEANING[ceiling],
    reasons,
    suggestedLoad: isNum(ctl) && ctl > 0 ? { min: round(ctl * share[0], 0), max: round(ctl * share[1], 0) } : null,
    confidence,
    caveats,
  };
}
