/**
 * Performance anchors: maximum heart rate, training zones, race equivalence,
 * grade-adjusted pace and aerobic decoupling.
 */

import type { Activity, AlgorithmTag, Profile } from "../types.ts";
import { clamp, isNum, quantile, round } from "./stats.ts";

export const ZONES_ALGORITHM: AlgorithmTag = {
  id: "zones-and-paces",
  version: "1.0.0",
  refs: ["tanaka2001", "karvonen1957", "seiler2010", "friel2009", "daniels2014", "riegel1981"],
};

export const ACTIVITY_ALGORITHM: AlgorithmTag = {
  id: "activity-analysis",
  version: "1.0.0",
  refs: ["minetti2002", "maunder2021", "periard2015"],
};

/** Age-predicted maximum heart rate (Tanaka 2001): 208 - 0.7 x age. SD about 10 bpm. */
export function hrMaxFromAge(age: number): number {
  return Math.round(208 - 0.7 * age);
}

/**
 * Highest heart rate reached in recorded activities. The 98th percentile of
 * session maxima is used rather than the single highest value, which is often
 * an optical-sensor spike. Needs at least 10 sessions.
 */
export function observedHrMax(activities: readonly Activity[]): number | null {
  const maxima = activities.map((activity) => activity.maxHr).filter((value): value is number => isNum(value) && value > 100 && value < 230);
  if (maxima.length < 10) return null;
  return Math.round(quantile(maxima, 0.98) as number);
}

export type Zone = { zone: number; name: string; lowBpm: number; highBpm: number };

const ZONE_NAMES = ["Recovery", "Aerobic endurance", "Tempo", "Threshold", "VO2max"];

/** Zones as fractions of heart-rate reserve (Karvonen 1957): 50-60-70-80-90-100 %. */
export function zonesFromReserve(hrMax: number, hrRest: number): Zone[] {
  const at = (fraction: number) => Math.round(hrRest + fraction * (hrMax - hrRest));
  return ZONE_NAMES.map((name, index) => ({ zone: index + 1, name, lowBpm: at(0.5 + index * 0.1), highBpm: at(0.6 + index * 0.1) }));
}

/**
 * Zones anchored on the lactate-threshold heart rate (LTHR), which follows the
 * athlete's current fitness better than a percentage of maximum heart rate.
 * Bounds for running, in percent of LTHR: <85, 85-89, 90-94, 95-99, >=100
 * (Friel's field system, a practitioner convention; the physiological rationale
 * for threshold-anchored zones is in Seiler 2010).
 */
export function zonesFromLthr(lthr: number, hrMax: number | null): Zone[] {
  const bounds = [0.7, 0.85, 0.9, 0.95, 1];
  const top = hrMax ?? Math.round(lthr * 1.1);
  return ZONE_NAMES.map((name, index) => ({
    zone: index + 1,
    name,
    lowBpm: Math.round(lthr * bounds[index]),
    highBpm: index === 4 ? top : Math.round(lthr * bounds[index + 1]) - 1,
  }));
}

export function zonesFromMax(hrMax: number, floorsPct: readonly number[]): Zone[] {
  return ZONE_NAMES.map((name, index) => ({
    zone: index + 1,
    name,
    lowBpm: Math.round((hrMax * floorsPct[index]) / 100),
    highBpm: Math.round((hrMax * (floorsPct[index + 1] ?? 100)) / 100),
  }));
}

/** Oxygen cost of running at `speed` (m/min) on the flat (Daniels & Gilbert 1979). */
function vo2AtSpeed(speed: number): number {
  return -4.6 + 0.182258 * speed + 0.000104 * speed ** 2;
}

/** Fraction of VO2max that can be sustained for `minutes` (Daniels & Gilbert 1979). */
function sustainableFraction(minutes: number): number {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * minutes) + 0.2989558 * Math.exp(-0.1932605 * minutes);
}

/** VDOT: the VO2max that the Daniels-Gilbert model associates with a race result. */
export function vdot(distanceM: number, timeS: number): number | null {
  const minutes = timeS / 60;
  // The model was fitted on races from about 3.5 min to 4 h.
  if (!(distanceM > 0) || minutes < 3.5 || minutes > 300) return null;
  return round(vo2AtSpeed(distanceM / minutes) / sustainableFraction(minutes), 1);
}

/** Running speed (m/min) whose flat oxygen cost is `vo2`. */
function speedAtVo2(vo2: number): number {
  return (-0.182258 + Math.sqrt(0.182258 ** 2 + 4 * 0.000104 * (vo2 + 4.6))) / (2 * 0.000104);
}

function paceSecPerKm(speedMPerMin: number): number {
  return Math.round(60_000 / speedMPerMin);
}

export type TrainingPaces = {
  vdot: number;
  /** Seconds per kilometre. */
  easy: { slow: number; fast: number };
  marathon: number;
  threshold: number;
  interval: number;
  repetition: number;
};

/** Training paces at fixed fractions of VDOT (Daniels' intensity classes). */
export function trainingPaces(vdotValue: number): TrainingPaces {
  const pace = (fraction: number) => paceSecPerKm(speedAtVo2(vdotValue * fraction));
  return {
    vdot: vdotValue,
    easy: { slow: pace(0.59), fast: pace(0.74) },
    marathon: pace(0.8),
    threshold: pace(0.88),
    interval: pace(0.98),
    repetition: pace(1.05),
  };
}

/** Time predicted by the VDOT model for another distance (bisection on the race time). */
export function predictTimeFromVdot(vdotValue: number, distanceM: number): number | null {
  let low = 3.5 * 60;
  let high = 300 * 60;
  const estimate = (seconds: number) => vdot(distanceM, seconds) ?? 0;
  if (estimate(low) < vdotValue || estimate(high) > vdotValue) return null;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (estimate(mid) > vdotValue) low = mid;
    else high = mid;
  }
  return Math.round((low + high) / 2);
}

/** Riegel's endurance equation (1981): T2 = T1 x (D2 / D1)^1.06. Flat races, 3.5 min to ~4 h. */
export function riegel(timeS: number, fromM: number, toM: number, exponent = 1.06): number {
  return Math.round(timeS * (toM / fromM) ** exponent);
}

/**
 * Energy cost of running on a gradient, J/kg/m (Minetti 2002), valid from -0.45 to +0.45.
 * `gradient` is rise over run (0.10 = 10 %).
 */
export function minettiCost(gradient: number): number {
  const i = clamp(gradient, -0.45, 0.45);
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}

/** Flat-equivalent speed of a segment run at `speed` on mean gradient `gradient`. */
export function gradeAdjustedSpeed(speed: number, gradient: number): number {
  return (speed * minettiCost(gradient)) / minettiCost(0);
}

export type Split = {
  durationS: number;
  distanceM: number;
  avgHr: number | null;
  elevGainM: number | null;
  elevLossM: number | null;
  /** Grade-adjusted speed from Garmin when present (m/s). */
  gapSpeedMs: number | null;
};

export type Decoupling = {
  /** Efficiency = flat-equivalent speed (m/min) per heartbeat-per-minute. */
  firstHalfEfficiency: number;
  secondHalfEfficiency: number;
  /** Loss of efficiency from the first to the second half, in percent. */
  decouplingPct: number;
  firstHalfHr: number;
  secondHalfHr: number;
  gradeAdjusted: boolean;
  splitsUsed: number;
};

function splitFlatSpeed(split: Split): { speed: number; adjusted: boolean } {
  if (isNum(split.gapSpeedMs) && split.gapSpeedMs > 0) return { speed: split.gapSpeedMs, adjusted: true };
  const speed = split.distanceM / split.durationS;
  if (isNum(split.elevGainM) || isNum(split.elevLossM)) {
    const gradient = ((split.elevGainM ?? 0) - (split.elevLossM ?? 0)) / split.distanceM;
    return { speed: gradeAdjustedSpeed(speed, gradient), adjusted: true };
  }
  return { speed, adjusted: false };
}

/**
 * Aerobic decoupling: change of the speed-to-heart-rate ratio between the two
 * halves of a steady effort. A rising heart rate for the same output
 * (cardiovascular drift) reflects heat, dehydration, glycogen depletion or
 * insufficient aerobic durability (Maunder 2021). Below about 5 % is the usual
 * practitioner benchmark for a well-tolerated duration; it is a field heuristic.
 * Only meaningful for continuous efforts of 40 min or more.
 */
export function aerobicDecoupling(splits: readonly Split[]): Decoupling | null {
  const usable = splits.filter((split) => split.durationS > 0 && split.distanceM > 0 && isNum(split.avgHr) && split.avgHr > 60);
  const total = usable.reduce((seconds, split) => seconds + split.durationS, 0);
  if (usable.length < 4 || total < 40 * 60) return null;

  const halves = [
    { seconds: 0, flatMeters: 0, beats: 0 },
    { seconds: 0, flatMeters: 0, beats: 0 },
  ];
  let elapsed = 0;
  let adjusted = true;
  for (const split of usable) {
    const half = halves[elapsed + split.durationS / 2 < total / 2 ? 0 : 1];
    const flat = splitFlatSpeed(split);
    adjusted &&= flat.adjusted;
    half.seconds += split.durationS;
    half.flatMeters += flat.speed * split.durationS;
    half.beats += (split.avgHr as number) * split.durationS;
    elapsed += split.durationS;
  }
  if (!halves[0].seconds || !halves[1].seconds) return null;
  const efficiency = halves.map((half) => ((half.flatMeters / half.seconds) * 60) / (half.beats / half.seconds));
  return {
    firstHalfEfficiency: round(efficiency[0], 3),
    secondHalfEfficiency: round(efficiency[1], 3),
    decouplingPct: round(((efficiency[0] - efficiency[1]) / efficiency[0]) * 100, 1),
    firstHalfHr: round(halves[0].beats / halves[0].seconds, 0),
    secondHalfHr: round(halves[1].beats / halves[1].seconds, 0),
    gradeAdjusted: adjusted,
    splitsUsed: usable.length,
  };
}

/** Zone tables available for this profile, most specific anchor first. */
export function zoneTables(profile: Profile): Array<{ anchor: string; zones: Zone[] }> {
  const tables: Array<{ anchor: string; zones: Zone[] }> = [];
  if (isNum(profile.lthr)) tables.push({ anchor: `lactate-threshold heart rate ${profile.lthr} bpm (${profile.lthrSource})`, zones: zonesFromLthr(profile.lthr, profile.hrMax) });
  if (isNum(profile.hrMax) && isNum(profile.hrRest)) {
    tables.push({ anchor: `heart-rate reserve (max ${profile.hrMax}, rest ${profile.hrRest})`, zones: zonesFromReserve(profile.hrMax, profile.hrRest) });
  }
  if (isNum(profile.hrMax)) tables.push({ anchor: `percent of maximum heart rate ${profile.hrMax} bpm (${profile.hrMaxSource})`, zones: zonesFromMax(profile.hrMax, profile.hrZoneFloorsPctMax) });
  return tables;
}
