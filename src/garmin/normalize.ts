/** Turns gc output into the plugin's types. Unknown shapes give null fields, never guesses. */

import { isIsoDate } from "../dates.ts";
import { isNum } from "../science/stats.ts";
import type { Split } from "../science/performance.ts";
import type { Activity, ActivityDescent, DayRecord } from "../types.ts";

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function num(source: Json | null, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source?.[key];
    if (isNum(value)) return value;
  }
  return null;
}

function positive(source: Json | null, ...keys: string[]): number | null {
  const value = num(source, ...keys);
  return value !== null && value > 0 ? value : null;
}

/** Validates the envelope of `gc daily` and returns its day records. */
export function parseDailyExport(payload: unknown): { days: DayRecord[]; errors: Record<string, string> } | null {
  const root = obj(payload);
  if (!root || root.schemaVersion !== 1 || !Array.isArray(root.days)) return null;
  const days = (root.days as unknown[]).filter((day): day is DayRecord => isIsoDate(obj(day)?.date) && Array.isArray(obj(day)?.sources));
  const errors = obj(root.errors) ?? {};
  return { days, errors: Object.fromEntries(Object.entries(errors).map(([key, value]) => [key, String(value)])) };
}

/** True when the record holds at least one measured signal. */
export function hasSignal(day: DayRecord): boolean {
  return Boolean(day.sleep || day.hrv || day.restingHr !== null || day.stress || day.bodyBattery || day.respiration || day.spo2);
}

export function normalizeActivity(raw: unknown): Activity | null {
  const a = obj(raw);
  const id = a?.activityId;
  const start = typeof a?.startTimeLocal === "string" ? a.startTimeLocal : null;
  if (!a || (typeof id !== "number" && typeof id !== "string") || !start || !isIsoDate(start.slice(0, 10))) return null;
  const zones = [1, 2, 3, 4, 5].map((zone) => num(a, `hrTimeInZone_${zone}`));
  const type = obj(a.activityType);
  return {
    id: String(id),
    date: start.slice(0, 10),
    startLocal: start.replace(" ", "T").slice(0, 19),
    type: typeof type?.typeKey === "string" ? type.typeKey : "unknown",
    name: typeof a.activityName === "string" ? a.activityName : null,
    durationS: positive(a, "duration"),
    movingS: positive(a, "movingDuration"),
    distanceM: positive(a, "distance"),
    elevGainM: num(a, "elevationGain"),
    elevLossM: num(a, "elevationLoss"),
    avgHr: positive(a, "averageHR"),
    maxHr: positive(a, "maxHR"),
    hrZonesS: zones.some((value) => value !== null && value > 0) ? zones.map((value) => value ?? 0) : null,
    aerobicTE: positive(a, "aerobicTrainingEffect"),
    anaerobicTE: num(a, "anaerobicTrainingEffect"),
    garminLoad: positive(a, "activityTrainingLoad"),
    avgSpeedMs: positive(a, "averageSpeed"),
    gapSpeedMs: positive(a, "avgGradeAdjustedSpeed"),
    avgPowerW: positive(a, "avgPower"),
    normPowerW: positive(a, "normPower"),
    kcal: positive(a, "calories"),
    vo2max: positive(a, "vO2MaxValue"),
    tempMinC: num(a, "minTemperature"),
    tempMaxC: num(a, "maxTemperature"),
  };
}

/** Reads the result of `activities descent <id>`; null when the payload has no usable figures. */
export function parseDescent(payload: unknown): ActivityDescent | null {
  const root = obj(payload);
  const eccentric = num(root, "eccentricUnits");
  const descent = num(root, "descentM");
  if (eccentric === null || descent === null || eccentric < 0 || descent < 0) return null;
  return { descentM: descent, steepDescentM: Math.max(0, num(root, "steepDescentM") ?? 0), eccentricUnits: eccentric };
}

export function normalizeActivities(payload: unknown): Activity[] {
  if (!Array.isArray(payload)) return [];
  return payload.map(normalizeActivity).filter((activity): activity is Activity => activity !== null);
}

/** Laps of `gc activities splits ID` (the `lapDTOs` list). */
export function normalizeSplits(payload: unknown): Split[] {
  const laps = obj(payload)?.lapDTOs;
  if (!Array.isArray(laps)) return [];
  const out: Split[] = [];
  for (const raw of laps) {
    const lap = obj(raw);
    const durationS = positive(lap, "movingDuration", "duration");
    const distanceM = positive(lap, "distance");
    if (durationS === null || distanceM === null) continue;
    out.push({
      durationS,
      distanceM,
      avgHr: positive(lap, "averageHR"),
      elevGainM: num(lap, "elevationGain"),
      elevLossM: num(lap, "elevationLoss"),
      gapSpeedMs: positive(lap, "avgGradeAdjustedSpeed"),
    });
  }
  return out;
}

/** Lactate-threshold heart rate from `gc metrics lactate-threshold` or `gc metrics anchors`. */
export function lthrFromPayload(payload: unknown): number | null {
  const root = obj(payload);
  const block = obj(root?.speed_and_heart_rate) ?? obj(root?.lactateThreshold) ?? root;
  const value = positive(block, "heartRate", "heartRateBpm", "lactateThresholdHeartRate");
  return value !== null && value >= 100 && value <= 210 ? Math.round(value) : null;
}

/** Garmin's own readiness, status and load figures for the day, reduced to a few fields. */
export function garminDaySignals(readiness: unknown, status: unknown): Json {
  const first = Array.isArray(readiness) ? obj(readiness[0]) : obj(readiness);
  const out: Json = {};
  if (first) {
    out.trainingReadiness = {
      score: num(first, "score"),
      level: first.level ?? null,
      recoveryTimeMin: num(first, "recoveryTime"),
      acuteLoad: num(first, "acuteLoad"),
      sleepScore: num(first, "sleepScore"),
      hrvWeeklyAverageMs: num(first, "hrvWeeklyAverage"),
    };
  }
  const root = obj(status);
  const vo2 = obj(obj(root?.mostRecentVO2Max)?.generic);
  if (vo2) out.vo2max = { value: num(vo2, "vo2MaxPreciseValue", "vo2MaxValue"), date: vo2.calendarDate ?? null };
  const latest = obj(obj(root?.mostRecentTrainingStatus)?.latestTrainingStatusData);
  const device = latest ? obj(Object.values(latest)[0]) : null;
  if (device) {
    const acute = obj(device.acuteTrainingLoadDTO);
    out.trainingStatus = {
      phrase: device.trainingStatusFeedbackPhrase ?? null,
      acuteLoad: num(acute, "dailyTrainingLoadAcute"),
      chronicLoad: num(acute, "dailyTrainingLoadChronic"),
      loadRatio: num(acute, "dailyAcuteChronicWorkloadRatio"),
    };
  }
  return out;
}

/** Category names of Garmin's load balance, in the order the app shows them. */
const LOAD_CATEGORIES = [
  ["aerobicLow", "monthlyLoadAerobicLow"],
  ["aerobicHigh", "monthlyLoadAerobicHigh"],
  ["anaerobic", "monthlyLoadAnaerobic"],
] as const;

/**
 * Garmin's 30-day training load balance, reduced to each category's load, its target range and where the load
 * stands against it. Returns null when the payload has no device entry. The comparison is Garmin's own target
 * (a proprietary model), reported as such by the caller.
 */
export function loadBalanceSignal(payload: unknown): Json | null {
  const map = obj(obj(payload)?.metricsTrainingLoadBalanceDTOMap);
  const entries = map ? Object.values(map).map(obj).filter((entry): entry is Json => entry !== null) : [];
  // Several devices can report: the primary training device is the one the app displays.
  const entry = entries.find((item) => item.primaryTrainingDevice === true) ?? entries[0];
  if (!entry) return null;
  const categories: Json = {};
  for (const [name, prefix] of LOAD_CATEGORIES) {
    const load = num(entry, prefix);
    const min = num(entry, `${prefix}TargetMin`);
    const max = num(entry, `${prefix}TargetMax`);
    if (load === null) continue;
    const status = min === null || max === null ? null : load < min ? "below" : load > max ? "above" : "within";
    categories[name] = { load: Math.round(load), targetMin: min === null ? null : Math.round(min), targetMax: max === null ? null : Math.round(max), status };
  }
  if (Object.keys(categories).length === 0) return null;
  return { date: entry.calendarDate ?? null, window: "rolling 30 days", categories, phrase: entry.trainingBalanceFeedbackPhrase ?? null };
}

/** Below this many days with data, the coach cannot yet describe the athlete's VO2 max trend from its own history. */
export const VO2_TREND_BELOW_DAYS = 56;
/** Altitude from which acclimation matters (metres), and how far from the usual altitude counts as "outside the usual zone". */
export const ACCLIMATION_ALTITUDE_FLOOR_M = 1000;
export const ACCLIMATION_ALTITUDE_SHIFT_M = 500;
/** Heat acclimation is reported while it is being built (1-99 %) or when it moved by at least this many points. */
export const ACCLIMATION_HEAT_MOVE_POINTS = 5;

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/**
 * VO2 max trend and heat/altitude acclimation from Garmin's `maxmet` history, each only when it is useful:
 *
 * - `vo2maxTrend` only while the coach has fewer than VO2_TREND_BELOW_DAYS days of its own data
 *   (`daysOfOwnData`): later, its own HRV, load and recovery series say more than a slow VO2 max drift.
 * - `acclimation` only when the athlete is at altitude (>= 1000 m) or far from their usual altitude (the median
 *   of the window), or when heat acclimation is being built or has just moved. Otherwise it is noise.
 *
 * Returns an empty object when nothing qualifies, so the caller can spread it.
 */
export function maxmetSignals(payload: unknown, daysOfOwnData: number): Json {
  const series = (Array.isArray(payload) ? payload : []).map(obj).filter((entry): entry is Json => entry !== null);
  const out: Json = {};
  const points = series
    .map((entry) => {
      const generic = obj(entry.generic);
      const value = num(generic, "vo2MaxPreciseValue", "vo2MaxValue");
      return value !== null && typeof generic?.calendarDate === "string" ? { date: generic.calendarDate, value } : null;
    })
    .filter((point): point is { date: string; value: number } => point !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (daysOfOwnData < VO2_TREND_BELOW_DAYS && points.length >= 2) {
    const first = points[0] as { date: string; value: number };
    const last = points[points.length - 1] as { date: string; value: number };
    out.vo2maxTrend = { from: first.date, to: last.date, first: Math.round(first.value * 10) / 10, last: Math.round(last.value * 10) / 10, change: Math.round((last.value - first.value) * 10) / 10, points: points.length };
  }
  const blocks = series.map((entry) => obj(entry.heatAltitudeAcclimation)).filter((block): block is Json => block !== null).sort((a, b) => String(a.calendarDate).localeCompare(String(b.calendarDate)));
  const latest = blocks[blocks.length - 1];
  if (latest) {
    const altitude = num(latest, "currentAltitude");
    const usual = median(blocks.map((block) => num(block, "currentAltitude")).filter((value): value is number => value !== null));
    const heat = num(latest, "heatAcclimationPercentage");
    const heatBefore = num(latest, "previousHeatAcclimationPercentage");
    const highUp = altitude !== null && altitude >= ACCLIMATION_ALTITUDE_FLOOR_M;
    const awayFromUsual = altitude !== null && usual !== null && Math.abs(altitude - usual) >= ACCLIMATION_ALTITUDE_SHIFT_M;
    const heatActive = heat !== null && ((heat > 0 && heat < 100) || (heatBefore !== null && Math.abs(heat - heatBefore) >= ACCLIMATION_HEAT_MOVE_POINTS));
    if (highUp || awayFromUsual || heatActive) {
      out.acclimation = {
        date: latest.calendarDate ?? null,
        altitudeM: altitude === null ? null : Math.round(altitude),
        usualAltitudeM: usual === null ? null : Math.round(usual),
        altitudeAcclimationPercent: num(latest, "altitudeAcclimation"),
        heatAcclimationPercent: heat,
        reason: [highUp ? "at altitude" : null, awayFromUsual && !highUp ? "away from the usual altitude" : null, heatActive ? "heat acclimation in progress" : null].filter(Boolean).join(", "),
      };
    }
  }
  return out;
}
