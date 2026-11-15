import { addDays, dateRange } from "../src/dates.ts";
import { DEFAULT_ZONE_FLOORS } from "../src/config.ts";
import { seededRandom } from "../src/science/stats.ts";
import { emptyDay } from "../src/store.ts";
import type { Activity, DayRecord, Profile } from "../src/types.ts";

export const TODAY = "2026-11-15";

export const PROFILE: Profile = {
  sex: "male",
  birthYear: 1975,
  hrMax: 180,
  hrMaxSource: "config",
  hrRest: 50,
  hrRestSource: "config",
  lthr: 160,
  lthrSource: "config",
  sleepNeedS: 8 * 3600,
  sleepNeedSource: "config",
  hrZoneFloorsPctMax: DEFAULT_ZONE_FLOORS,
};

/** Gaussian noise from a seeded generator (Box-Muller). */
export function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());
}

export type DayOverride = Partial<{ hrvMs: number | null; restingHr: number | null; sleepH: number | null; bedtime: string; respiration: number | null; skinTemp: number | null; spo2: number | null }>;

/** One synthetic night: 60 ms HRV, 48 bpm, 7.75 h of sleep from 23:00, unless overridden. */
export function makeDay(date: string, override: DayOverride = {}): DayRecord {
  const day = emptyDay(date);
  const hrv = override.hrvMs === undefined ? 60 : override.hrvMs;
  const sleepH = override.sleepH === undefined ? 7.75 : override.sleepH;
  const bedtime = override.bedtime ?? "23:00";
  if (hrv !== null) {
    day.hrv = { lastNightAvgMs: hrv, lastNight5MinHighMs: null, weeklyAvgMs: null, status: "BALANCED", baselineLowUpperMs: null, baselineBalancedLowMs: null, baselineBalancedUpperMs: null };
  }
  day.restingHr = override.restingHr === undefined ? 48 : override.restingHr;
  if (sleepH !== null) {
    const startDate = bedtime >= "12:00" ? addDays(date, -1) : date;
    const start = Date.parse(`${startDate}T${bedtime}:00Z`);
    const awakeS = 20 * 60;
    const end = new Date(start + sleepH * 3600_000 + awakeS * 1000).toISOString().slice(0, 19);
    day.sleep = {
      startGmt: null,
      endGmt: null,
      startLocal: `${startDate}T${bedtime}:00`,
      endLocal: end,
      durationS: sleepH * 3600,
      deepS: sleepH * 3600 * 0.18,
      lightS: sleepH * 3600 * 0.6,
      remS: sleepH * 3600 * 0.22,
      awakeS,
      napS: null,
      awakeCount: 1,
      score: 80,
      needS: null,
      avgStress: null,
      avgHr: null,
    };
  }
  const respiration = override.respiration === undefined ? 13.5 : override.respiration;
  if (respiration !== null) day.respiration = { sleepAvg: respiration, sleepLow: null, sleepHigh: null, wakingAvg: null };
  day.skinTempDeviationC = override.skinTemp === undefined ? 0 : override.skinTemp;
  const spo2 = override.spo2 === undefined ? 95 : override.spo2;
  if (spo2 !== null) day.spo2 = { sleepAvg: spo2, sleepLow: 90, dayAvg: null, dayLow: null };
  day.activity = { steps: 9000, activeKcal: 600, bmrKcal: 1700, moderateMin: 20, vigorousMin: 10, floorsUp: 10 };
  day.sources = ["test"];
  return day;
}

/**
 * `count` consecutive days ending on `end`, with realistic night-to-night noise
 * (HRV about 8 % CV, resting heart rate SD 1.5 bpm). `tweak` can override a day by
 * its distance from the end (0 = last day).
 */
export function makeHistory(count: number, end = TODAY, tweak: (fromEnd: number, date: string) => DayOverride | null = () => null, seed = 7): DayRecord[] {
  const random = seededRandom(seed);
  return dateRange(addDays(end, -(count - 1)), end).map((date, index) => {
    const base: DayOverride = {
      hrvMs: Math.round(60 * Math.exp(0.08 * gaussian(random))),
      restingHr: Math.round(48 + 1.5 * gaussian(random)),
      sleepH: Math.round((7.75 + 0.5 * gaussian(random)) * 4) / 4,
      respiration: Math.round((13.5 + 0.4 * gaussian(random)) * 10) / 10,
      skinTemp: Math.round(0.25 * gaussian(random) * 10) / 10,
    };
    return makeDay(date, { ...base, ...(tweak(count - 1 - index, date) ?? {}) });
  });
}

export function makeActivity(date: string, override: Partial<Activity> = {}): Activity {
  return {
    id: `${date.replaceAll("-", "")}${override.id ?? "1"}`,
    date,
    startLocal: `${date}T07:30:00`,
    type: "running",
    name: "Run",
    durationS: 3600,
    movingS: 3600,
    distanceM: 10000,
    elevGainM: 100,
    elevLossM: 100,
    avgHr: 141,
    maxHr: 165,
    hrZonesS: [300, 1500, 1500, 300, 0],
    aerobicTE: 3,
    anaerobicTE: 0.5,
    garminLoad: 110,
    avgSpeedMs: 2.78,
    gapSpeedMs: 2.85,
    avgPowerW: null,
    normPowerW: null,
    kcal: 700,
    vo2max: 50,
    tempMinC: 15,
    tempMaxC: 20,
    ...override,
  };
}
