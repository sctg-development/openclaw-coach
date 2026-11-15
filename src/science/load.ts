/**
 * Training load.
 *
 * Session load: Banister's training impulse (TRIMP), the dose unit of the
 * fitness-fatigue model (Banister 1991, Morton 1990):
 *     TRIMP = minutes x HRr x a x exp(b x HRr),  HRr = (HR - HRrest) / (HRmax - HRrest)
 * with (a, b) = (0.64, 1.92) for men and (0.86, 1.67) for women. When the time
 * in each heart-rate zone is known, the formula is applied zone by zone, which
 * counts interval sessions correctly (the mean heart rate of an interval session
 * under-weights its hard parts). Edwards' zone score (Edwards 1993) and Garmin's
 * own load are reported next to it for comparison.
 *
 * Daily loads feed two exponentially weighted averages (Calvert 1976; the
 * simplified form popularized as the "performance manager"):
 *     fitness (CTL), time constant 42 days;  fatigue (ATL), time constant 7 days;
 *     form (TSB) = yesterday's fitness - yesterday's fatigue.
 *
 * Descriptive indicators: monotony and strain (Foster 1998), week-on-week
 * change, and an uncoupled acute:chronic ratio. The acute:chronic ratio is
 * reported as a description of load progression only: its use as an injury
 * predictor is not supported (Impellizzeri 2020, Lolli 2019).
 */

import { addDays, dateRange } from "../dates.ts";
import type { Activity, AlgorithmTag, DataStatus, Profile, Sex } from "../types.ts";
import { clamp, ewma, isNum, mean, round, roundOrNull, sd, sum } from "./stats.ts";

export const LOAD_ALGORITHM: AlgorithmTag = {
  id: "training-load",
  version: "1.0.0",
  refs: ["banister1991", "morton1990", "edwards1993", "calvert1976", "foster1998", "impellizzeri2020", "lolli2019", "nielsen2014", "treff2019"],
};

export const CTL_TAU_DAYS = 42;
export const ATL_TAU_DAYS = 7;
/** Days of history before fitness (CTL) has absorbed ~63 % / ~88 % of its inputs. */
export const LOAD_MIN_DAYS = 28;
export const LOAD_GOOD_DAYS = 90;

const BANISTER: Record<Sex, { a: number; b: number }> = {
  male: { a: 0.64, b: 1.92 },
  female: { a: 0.86, b: 1.67 },
};

/** Banister weighting of one minute at heart-rate reserve fraction `hrr`. */
export function banisterPerMinute(hrr: number, sex: Sex | null): number {
  const x = clamp(hrr, 0, 1);
  const { a, b } = BANISTER[sex ?? "male"];
  return x * a * Math.exp(b * x);
}

export type SessionLoad = {
  /** Banister TRIMP (arbitrary units), or null when heart rate or anchors are missing. */
  trimp: number | null;
  method: "zones" | "mean-hr" | null;
  edwards: number | null;
  garmin: number | null;
};

export function sessionLoad(activity: Activity, profile: Profile): SessionLoad {
  const zones = activity.hrZonesS;
  const zoneSeconds = zones ? sum(zones.filter(isNum)) : 0;
  const edwards = zones && zoneSeconds > 0 ? round(sum(zones.map((seconds, index) => ((seconds || 0) / 60) * (index + 1))), 1) : null;
  const garmin = roundOrNull(activity.garminLoad, 0);
  const { hrMax, hrRest } = profile;
  if (!isNum(hrMax) || !isNum(hrRest) || hrMax <= hrRest) return { trimp: null, method: null, edwards, garmin };

  const reserve = hrMax - hrRest;
  if (zones && zoneSeconds > 0) {
    const floors = profile.hrZoneFloorsPctMax;
    let trimp = 0;
    zones.forEach((seconds, index) => {
      const low = floors[index] ?? 50 + index * 10;
      const high = floors[index + 1] ?? 100;
      const midHr = ((low + high) / 200) * hrMax;
      trimp += ((seconds || 0) / 60) * banisterPerMinute((midHr - hrRest) / reserve, profile.sex);
    });
    return { trimp: round(trimp, 1), method: "zones", edwards, garmin };
  }
  if (isNum(activity.avgHr) && isNum(activity.durationS)) {
    const minutes = (activity.movingS ?? activity.durationS) / 60;
    return {
      trimp: round(minutes * banisterPerMinute((activity.avgHr - hrRest) / reserve, profile.sex), 1),
      method: "mean-hr",
      edwards,
      garmin,
    };
  }
  return { trimp: null, method: null, edwards, garmin };
}

/** Load of a planned session, on the same scale as recorded sessions. */
export function plannedSessionLoad(minutes: number, zone: number, profile: Profile): number | null {
  const { hrMax, hrRest } = profile;
  if (!isNum(hrMax) || !isNum(hrRest) || hrMax <= hrRest) return null;
  const index = clamp(Math.round(zone), 1, 5) - 1;
  const floors = profile.hrZoneFloorsPctMax;
  const midHr = (((floors[index] ?? 50 + index * 10) + (floors[index + 1] ?? 100)) / 200) * hrMax;
  return round(minutes * banisterPerMinute((midHr - hrRest) / (hrMax - hrRest), profile.sex), 1);
}

export type DailyLoad = { date: string; load: number; sessions: number; unscored: number };

/** One entry per calendar day from `start` to `end`; a day without activity has load 0. */
export function dailyLoads(activities: readonly Activity[], profile: Profile, start: string, end: string): DailyLoad[] {
  const byDate = new Map<string, DailyLoad>();
  for (const date of dateRange(start, end)) byDate.set(date, { date, load: 0, sessions: 0, unscored: 0 });
  for (const activity of activities) {
    const day = byDate.get(activity.date);
    if (!day) continue;
    const { trimp } = sessionLoad(activity, profile);
    day.sessions += 1;
    if (trimp === null) day.unscored += 1;
    else day.load += trimp;
  }
  return [...byDate.values()];
}

export type LoadPoint = { date: string; load: number; ctl: number; atl: number; tsb: number };

/** Fitness-fatigue curves. TSB of a day uses the previous day's CTL and ATL. */
export function fitnessFatigue(loads: readonly { date: string; load: number }[]): LoadPoint[] {
  if (!loads.length) return [];
  const values = loads.map((day) => day.load);
  // Start from the mean of the first two weeks instead of 0, so that the first
  // weeks of the window are not read as a fitness build-up from nothing.
  const seed = mean(values.slice(0, Math.min(14, values.length))) ?? 0;
  const ctl = ewma(values, CTL_TAU_DAYS, seed);
  const atl = ewma(values, ATL_TAU_DAYS, seed);
  return loads.map((day, index) => ({
    date: day.date,
    load: round(day.load, 1),
    ctl: round(ctl[index], 1),
    atl: round(atl[index], 1),
    tsb: round((index ? ctl[index - 1] : seed) - (index ? atl[index - 1] : seed), 1),
  }));
}

/** Continue the curves over planned loads, to see where a plan leads. */
export function projectLoads(last: LoadPoint, planned: readonly { date: string; load: number }[]): LoadPoint[] {
  const out: LoadPoint[] = [];
  let ctl = last.ctl;
  let atl = last.atl;
  const kc = 1 - Math.exp(-1 / CTL_TAU_DAYS);
  const ka = 1 - Math.exp(-1 / ATL_TAU_DAYS);
  for (const day of planned) {
    const tsb = ctl - atl;
    ctl += (day.load - ctl) * kc;
    atl += (day.load - atl) * ka;
    out.push({ date: day.date, load: round(day.load, 1), ctl: round(ctl, 1), atl: round(atl, 1), tsb: round(tsb, 1) });
  }
  return out;
}

export type IntensityDistribution = {
  totalMin: number;
  /** Percent of heart-rate zone time in Garmin zones 1 to 5. */
  zonesPct: number[];
  /** Three-zone grouping: low = zones 1-3, moderate = zone 4, high = zone 5 (percent-of-HRmax zones). */
  lowPct: number;
  moderatePct: number;
  highPct: number;
  /** Polarization index (Treff 2019); above 2.0 the distribution is polarized. */
  polarizationIndex: number | null;
};

export function intensityDistribution(activities: readonly Activity[]): IntensityDistribution | null {
  const totals = [0, 0, 0, 0, 0];
  for (const activity of activities) activity.hrZonesS?.forEach((seconds, index) => (totals[index] += seconds || 0));
  const total = sum(totals);
  if (total < 600) return null;
  const pct = totals.map((seconds) => round((seconds / total) * 100, 0));
  const low = (totals[0] + totals[1] + totals[2]) / total;
  const moderate = totals[3] / total;
  const high = totals[4] / total;
  // Treff 2019: PI = log10(low / moderate x high x 100), with shares as fractions.
  // By definition PI = 0 when there is no high-intensity time or when high > low,
  // and a zero moderate share is replaced by 0.01.
  const polarizationIndex =
    high <= 0 || high >= low ? 0 : round(Math.log10((low / Math.max(moderate, 0.01)) * high * 100), 2);
  return {
    totalMin: round(total / 60, 0),
    zonesPct: pct,
    lowPct: round(low * 100, 0),
    moderatePct: round(moderate * 100, 0),
    highPct: round(high * 100, 0),
    polarizationIndex,
  };
}

export type LoadAnalysis = {
  status: DataStatus;
  algorithm: AlgorithmTag;
  unit: "TRIMP (Banister)";
  historyDays: number;
  today: LoadPoint | null;
  /** Fitness (CTL) change over the last 7 days, absolute and in percent. */
  rampPerWeek: number | null;
  rampPctPerWeek: number | null;
  last7: number | null;
  previous7: number | null;
  weekChangePct: number | null;
  /** 7-day mean daily load / mean daily load of the 21 days before (uncoupled). */
  acuteChronicRatio: number | null;
  monotony: number | null;
  strain: number | null;
  sessions7: number;
  unscoredSessions28: number;
  restDays7: number;
  intensity28: IntensityDistribution | null;
  flags: string[];
  notes: string[];
};

/**
 * @param loads Daily loads in ascending order, ending on the assessed day.
 */
export function analyzeLoad(loads: readonly DailyLoad[], activities: readonly Activity[], profile: Profile): LoadAnalysis {
  const notes: string[] = [];
  const flags: string[] = [];
  const curve = fitnessFatigue(loads);
  const today = curve.length ? curve[curve.length - 1] : null;
  const values = loads.map((day) => day.load);
  const tail = (count: number, offset = 0) => values.slice(Math.max(0, values.length - offset - count), values.length - offset);

  const week = tail(7);
  const last7 = week.length === 7 ? sum(week) : null;
  const before = tail(7, 7);
  const previous7 = before.length === 7 ? sum(before) : null;
  const chronic = tail(21, 7);
  const chronicMean = chronic.length === 21 ? mean(chronic) : null;
  const acuteChronicRatio = last7 !== null && chronicMean ? round(last7 / 7 / chronicMean, 2) : null;
  const weekSd = week.length === 7 ? sd(week) : null;
  const monotony = last7 !== null && weekSd ? round(last7 / 7 / weekSd, 2) : null;
  const weekAgo = curve.length > 7 ? curve[curve.length - 8] : null;
  const rampPerWeek = today && weekAgo ? round(today.ctl - weekAgo.ctl, 1) : null;

  if (!isNum(profile.hrMax) || !isNum(profile.hrRest)) {
    notes.push("Maximum or resting heart rate unknown: sessions cannot be scored. Set hrMax in the plugin config or ATHLETE.md.");
  }
  if (!profile.sex) notes.push("Sex not configured: the male TRIMP coefficients are used.");
  if (profile.hrMaxSource === "age-formula") {
    notes.push("Maximum heart rate comes from an age formula (SD about 10 bpm): loads are approximate until a measured value is set.");
  }

  const unscored28 = sum(loads.slice(-28).map((day) => day.unscored));
  if (unscored28) notes.push(`${unscored28} session(s) in the last 28 days have no heart-rate data and count as zero load.`);

  if (monotony !== null && monotony > 2) flags.push("high_monotony");
  if (acuteChronicRatio !== null && acuteChronicRatio > 1.5) flags.push("load_spike");
  if (last7 !== null && previous7 !== null && previous7 > 0 && last7 / previous7 > 1.3 && acuteChronicRatio !== null && acuteChronicRatio > 1.2) {
    flags.push("fast_weekly_increase");
  }

  const last28 = loads.length >= 28 ? loads[loads.length - 28].date : loads[0]?.date;
  const recentActivities = last28 ? activities.filter((activity) => activity.date >= last28) : [];
  const status: DataStatus = !today || !isNum(profile.hrMax) ? "insufficient_data" : loads.length < LOAD_MIN_DAYS ? "insufficient_data" : loads.length < LOAD_GOOD_DAYS ? "calibrating" : "ready";

  return {
    status,
    algorithm: LOAD_ALGORITHM,
    unit: "TRIMP (Banister)",
    historyDays: loads.length,
    today,
    rampPerWeek,
    rampPctPerWeek: rampPerWeek !== null && weekAgo && weekAgo.ctl > 0 ? round((rampPerWeek / weekAgo.ctl) * 100, 0) : null,
    last7: roundOrNull(last7, 0),
    previous7: roundOrNull(previous7, 0),
    weekChangePct: last7 !== null && previous7 ? round((last7 / previous7 - 1) * 100, 0) : null,
    acuteChronicRatio,
    monotony,
    strain: monotony !== null && last7 !== null ? round(last7 * monotony, 0) : null,
    sessions7: sum(loads.slice(-7).map((day) => day.sessions)),
    unscoredSessions28: unscored28,
    restDays7: loads.slice(-7).filter((day) => day.sessions === 0).length,
    intensity28: intensityDistribution(recentActivities),
    flags,
    notes,
  };
}

/** Dates following `after`, for building projections. */
export function nextDates(after: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addDays(after, index + 1));
}
