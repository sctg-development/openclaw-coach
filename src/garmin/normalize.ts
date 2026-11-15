/** Turns gc output into the plugin's types. Unknown shapes give null fields, never guesses. */

import { isIsoDate } from "../dates.ts";
import { isNum } from "../science/stats.ts";
import type { Split } from "../science/performance.ts";
import type { Activity, DayRecord } from "../types.ts";

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

/** Lactate-threshold heart rate from `gc metrics lactate-threshold`. */
export function lthrFromPayload(payload: unknown): number | null {
  const root = obj(payload);
  const block = obj(root?.speed_and_heart_rate) ?? root;
  const value = positive(block, "heartRate", "lactateThresholdHeartRate");
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
