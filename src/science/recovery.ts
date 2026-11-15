/**
 * Daily recovery index and physiological early-warning flags.
 *
 * Both compare last night's signals with the athlete's own baseline (median and
 * robust SD of the 60 preceding days): absolute values differ too much between
 * people to be read against population norms.
 *
 * Recovery index (0-100): weighted mean of signed z-scores, mapped through the
 * normal distribution, so 50 is a typical night for this athlete and the bands
 * are roughly the thirds of the personal distribution. The weights are a
 * documented design choice (HRV first, as the best-studied marker: Bellenger
 * 2016, Buchheit 2014), not a validated clinical score.
 *
 * Early warning: several signals deviating together (resting heart rate up, HRV
 * down, respiratory rate up, skin temperature up) often precede or accompany an
 * infection (Mishra 2020, Radin 2020, Natarajan 2020, Miller 2020, Smarr 2020).
 * The same pattern is produced by alcohol, heat, altitude, a late hard session,
 * travel or the luteal phase: it is a prompt to check symptoms, not a diagnosis.
 */

import type { AlgorithmTag, DataStatus, DayRecord, Profile } from "../types.ts";
import { lnRmssd } from "./hrv.ts";
import { describeNight } from "./sleep.ts";
import { clamp, isNum, normalCdf, robustBaseline, round, roundOrNull, zScore, type Baseline, type Maybe } from "./stats.ts";

export const RECOVERY_ALGORITHM: AlgorithmTag = {
  id: "recovery-index",
  version: "1.0.0",
  refs: ["bellenger2016", "buchheit2014", "plews2013", "fullagar2015"],
};

export const WARNING_ALGORITHM: AlgorithmTag = {
  id: "early-warning",
  version: "1.0.0",
  refs: ["mishra2020", "radin2020", "natarajan2020", "miller2020", "smarr2020", "quer2021"],
};

export const BASELINE_DAYS = 60;
export const BASELINE_MIN_NIGHTS = 14;

/** Smallest SD accepted for each signal (measurement resolution). */
const FLOORS = { hrv: 0.05, rhr: 1, respiration: 0.3, skinTemp: 0.2, spo2: 0.7 };

export const RECOVERY_WEIGHTS = { hrv: 0.4, restingHr: 0.2, sleep: 0.25, respiration: 0.075, skinTemp: 0.075 };

type SignalKey = "hrv" | "restingHr" | "respiration" | "skinTemp" | "spo2";

const GETTERS: Record<SignalKey, (day: DayRecord) => Maybe> = {
  hrv: (day) => lnRmssd(day),
  restingHr: (day) => day.restingHr,
  respiration: (day) => day.respiration?.sleepAvg,
  skinTemp: (day) => day.skinTempDeviationC,
  spo2: (day) => day.spo2?.sleepAvg,
};

const SCALE_FLOOR: Record<SignalKey, number> = {
  hrv: FLOORS.hrv,
  restingHr: FLOORS.rhr,
  respiration: FLOORS.respiration,
  skinTemp: FLOORS.skinTemp,
  spo2: FLOORS.spo2,
};

export type SignalDeviation = {
  value: number | null;
  baseline: number | null;
  /** Value minus baseline, in the signal's unit (HRV: percent of rMSSD). */
  delta: number | null;
  z: number | null;
  nights: number;
};

function baselineOf(days: readonly DayRecord[], key: SignalKey): Baseline | null {
  const previous = days.slice(Math.max(0, days.length - 1 - BASELINE_DAYS), Math.max(0, days.length - 1));
  return robustBaseline(previous.map(GETTERS[key]), SCALE_FLOOR[key], BASELINE_MIN_NIGHTS);
}

/** Last night's value of each signal against the personal baseline. */
export function signalDeviations(days: readonly DayRecord[]): Record<SignalKey, SignalDeviation> {
  const today = days[days.length - 1];
  const out = {} as Record<SignalKey, SignalDeviation>;
  for (const key of Object.keys(GETTERS) as SignalKey[]) {
    const raw = today ? GETTERS[key](today) : null;
    const value = isNum(raw) ? raw : null;
    const baseline = baselineOf(days, key);
    const z = zScore(value, baseline);
    let delta: number | null = null;
    if (value !== null && baseline) {
      delta = key === "hrv" ? (Math.exp(value - baseline.center) - 1) * 100 : value - baseline.center;
    }
    const display = (x: number | null) => (x === null ? null : key === "hrv" ? round(Math.exp(x), 0) : round(x, 1));
    out[key] = {
      value: display(value),
      baseline: baseline ? display(baseline.center) : null,
      delta: roundOrNull(delta, 1),
      z: roundOrNull(z, 2),
      nights: baseline?.n ?? 0,
    };
  }
  return out;
}

export type RecoveryBand = "low" | "moderate" | "high";

export type RecoveryAnalysis = {
  status: DataStatus;
  algorithm: AlgorithmTag;
  /** 0-100; 50 is a typical night for this athlete. */
  score: number | null;
  band: RecoveryBand | null;
  /** Signed contribution of each component, in z units (positive = better than usual). */
  components: Record<string, { z: number; weight: number }>;
  /** Share of the full weight that had data (1 = all five components). */
  coverage: number;
  deviations: Record<SignalKey, SignalDeviation>;
  notes: string[];
};

export function analyzeRecovery(days: readonly DayRecord[], profile: Profile): RecoveryAnalysis {
  const deviations = signalDeviations(days);
  const components: RecoveryAnalysis["components"] = {};
  const notes: string[] = [];
  const add = (name: keyof typeof RECOVERY_WEIGHTS, z: number | null) => {
    if (z !== null) components[name] = { z: round(z, 2), weight: RECOVERY_WEIGHTS[name] };
  };

  // More HRV than usual is not "more recovered" without limit: the benefit is capped.
  if (deviations.hrv.z !== null) add("hrv", clamp(deviations.hrv.z, -3, 1.5));
  if (deviations.restingHr.z !== null) add("restingHr", clamp(-deviations.restingHr.z, -3, 1.5));
  // Respiration and skin temperature only count against recovery when elevated.
  if (deviations.respiration.z !== null) add("respiration", clamp(-deviations.respiration.z, -3, 0.5));
  if (deviations.skinTemp.z !== null) add("skinTemp", clamp(-deviations.skinTemp.z, -3, 0.5));

  const night = describeNight(days[days.length - 1], profile);
  if (night && isNum(night.sufficiency)) {
    // 15 % of the need (about 70 min for 8 h) is taken as one "SD" of sleep sufficiency.
    add("sleep", clamp((night.sufficiency - 1) / 0.15, -3, 1));
  }

  const weight = Object.values(components).reduce((total, part) => total + part.weight, 0);
  const hasCardiac = "hrv" in components || "restingHr" in components;
  let score: number | null = null;
  if (hasCardiac && weight >= 0.5) {
    const z = Object.values(components).reduce((total, part) => total + part.z * part.weight, 0) / weight;
    score = Math.round(100 * normalCdf(z));
  }
  if (!("hrv" in components)) notes.push("No HRV for last night: the index relies on resting heart rate and sleep.");
  if (!night) notes.push("No sleep recorded for last night.");

  const calibrating = deviations.hrv.nights < BASELINE_MIN_NIGHTS && deviations.restingHr.nights < BASELINE_MIN_NIGHTS;
  return {
    status: score === null ? (calibrating ? "calibrating" : "insufficient_data") : "ready",
    algorithm: RECOVERY_ALGORITHM,
    score,
    band: score === null ? null : score >= 67 ? "high" : score >= 34 ? "moderate" : "low",
    components,
    coverage: round(weight, 2),
    deviations,
    notes,
  };
}

export type WarningLevel = "none" | "watch" | "elevated";

export type WarningAnalysis = {
  status: DataStatus;
  algorithm: AlgorithmTag;
  level: WarningLevel;
  /** Signals outside the personal range last night. */
  signals: string[];
  /** True when at least two signals were also deviating the night before. */
  persistent: boolean;
  spo2Note: string | null;
  confounders: string[];
};

const CONFOUNDERS = [
  "alcohol the evening before",
  "hard or late training session",
  "heat, dehydration",
  "altitude or travel across time zones",
  "short or fragmented night",
  "luteal phase of the menstrual cycle (higher temperature and heart rate)",
];

function deviatingSignals(days: readonly DayRecord[]): string[] {
  const d = signalDeviations(days);
  const out: string[] = [];
  if (isNum(d.restingHr.z) && isNum(d.restingHr.delta) && d.restingHr.z >= 2 && d.restingHr.delta >= 3) {
    out.push(`resting heart rate +${d.restingHr.delta} bpm`);
  }
  if (isNum(d.hrv.z) && d.hrv.z <= -2) out.push(`HRV ${d.hrv.delta} % vs baseline`);
  if (isNum(d.respiration.z) && isNum(d.respiration.delta) && d.respiration.z >= 2 && d.respiration.delta >= 0.8) {
    out.push(`respiratory rate +${d.respiration.delta} breaths/min`);
  }
  const temp = d.skinTemp;
  if (isNum(temp.value) && ((isNum(temp.z) && temp.z >= 2 && temp.value >= 0.5) || (temp.z === null && temp.value >= 1))) {
    out.push(`skin temperature +${temp.value} °C vs personal norm`);
  }
  if (isNum(d.spo2.z) && isNum(d.spo2.delta) && d.spo2.z <= -2 && d.spo2.delta <= -2) {
    out.push(`sleep SpO2 ${d.spo2.delta} points`);
  }
  return out;
}

export function analyzeWarning(days: readonly DayRecord[]): WarningAnalysis {
  const signals = deviatingSignals(days);
  const before = days.length > 1 ? deviatingSignals(days.slice(0, -1)) : [];
  const deviations = signalDeviations(days);
  const usable = (["hrv", "restingHr", "respiration", "skinTemp"] as SignalKey[]).filter((key) => deviations[key].z !== null).length;
  const low = days[days.length - 1]?.spo2?.sleepLow;
  const spo2Note =
    isNum(low) && low < 85
      ? `Lowest sleep SpO2 ${low} %: wrist oximetry is imprecise; if this repeats at low altitude with snoring or daytime sleepiness, it is worth mentioning to a doctor.`
      : null;
  const level: WarningLevel = signals.length >= 2 ? "elevated" : signals.length === 1 ? "watch" : "none";
  return {
    status: usable >= 2 ? "ready" : usable === 1 ? "calibrating" : "insufficient_data",
    algorithm: WARNING_ALGORITHM,
    level,
    signals,
    persistent: signals.length >= 2 && before.length >= 2,
    spo2Note,
    confounders: level === "none" ? [] : CONFOUNDERS,
  };
}
