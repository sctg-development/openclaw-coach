/** Shared data types. Every physiological field is nullable: null means "not measured". */

/** One day of recovery signals, as produced by `gc daily` (schemaVersion 1). */
export type DayRecord = {
  date: string;
  sleep: {
    startGmt: string | null;
    endGmt: string | null;
    startLocal: string | null;
    endLocal: string | null;
    durationS: number | null;
    deepS: number | null;
    lightS: number | null;
    remS: number | null;
    awakeS: number | null;
    napS: number | null;
    awakeCount: number | null;
    score: number | null;
    needS: number | null;
    avgStress: number | null;
    avgHr: number | null;
  } | null;
  hrv: {
    lastNightAvgMs: number | null;
    lastNight5MinHighMs: number | null;
    weeklyAvgMs: number | null;
    status: string | null;
    baselineLowUpperMs: number | null;
    baselineBalancedLowMs: number | null;
    baselineBalancedUpperMs: number | null;
  } | null;
  restingHr: number | null;
  respiration: { sleepAvg: number | null; sleepLow: number | null; sleepHigh: number | null; wakingAvg: number | null } | null;
  spo2: { sleepAvg: number | null; sleepLow: number | null; dayAvg: number | null; dayLow: number | null } | null;
  skinTempDeviationC: number | null;
  stress: {
    avg: number | null;
    max: number | null;
    restS: number | null;
    lowS: number | null;
    mediumS: number | null;
    highS: number | null;
  } | null;
  bodyBattery: {
    high: number | null;
    low: number | null;
    charged: number | null;
    drained: number | null;
    sleepChange: number | null;
  } | null;
  activity: {
    steps: number | null;
    activeKcal: number | null;
    bmrKcal: number | null;
    moderateMin: number | null;
    vigorousMin: number | null;
    floorsUp: number | null;
  } | null;
  heartRate: { min: number | null; max: number | null } | null;
  sources: string[];
  errors: Record<string, string>;
};

/** One recorded activity, reduced to what the models need. */
export type Activity = {
  id: string;
  /** Local calendar date of the start. */
  date: string;
  startLocal: string | null;
  type: string;
  name: string | null;
  durationS: number | null;
  movingS: number | null;
  distanceM: number | null;
  elevGainM: number | null;
  elevLossM: number | null;
  avgHr: number | null;
  maxHr: number | null;
  /** Seconds in Garmin heart-rate zones 1 to 5. */
  hrZonesS: number[] | null;
  aerobicTE: number | null;
  anaerobicTE: number | null;
  garminLoad: number | null;
  avgSpeedMs: number | null;
  gapSpeedMs: number | null;
  avgPowerW: number | null;
  normPowerW: number | null;
  kcal: number | null;
  vo2max: number | null;
  tempMinC: number | null;
  tempMaxC: number | null;
  /**
   * Descent measured from the FIT file's altitude trace (native Garmin client only). `undefined`: not looked at yet;
   * `null`: looked at, nothing usable (so it is not requested again); an object: the result.
   */
  descent?: ActivityDescent | null;
};

export type ActivityDescent = { descentM: number; steepDescentM: number; eccentricUnits: number };

export type Sex = "male" | "female";

/** Physiological anchors of the athlete, each with where it came from. */
export type Profile = {
  sex: Sex | null;
  birthYear: number | null;
  hrMax: number | null;
  hrMaxSource: "config" | "observed" | "age-formula" | null;
  hrRest: number | null;
  hrRestSource: "config" | "baseline" | null;
  lthr: number | null;
  lthrSource: "config" | "garmin" | null;
  sleepNeedS: number;
  sleepNeedSource: "config" | "default";
  /** Lower bound of heart-rate zones 1 to 5, in percent of maximum heart rate. */
  hrZoneFloorsPctMax: number[];
};

/** One entry of the athlete's journal (subjective data and habits). */
export type JournalEntry = {
  date: string;
  /** Habit tags: true/false or a quantity (e.g. alcohol: 2). */
  tags: Record<string, boolean | number>;
  /** Session rating of perceived exertion, CR-10 scale, per activity id or for the day. */
  rpe?: number;
  /** 1 (very poor) to 5 (very good) wellness ratings. */
  fatigue?: number;
  soreness?: number;
  mood?: number;
  sleepQuality?: number;
  stress?: number;
  symptoms?: string[];
  notes?: string;
  updatedAt: string;
};

export type DataStatus = "ready" | "calibrating" | "insufficient_data";

export type AlgorithmTag = {
  id: string;
  version: string;
  /** Keys of the bibliography in docs/SCIENCE.md. */
  refs: string[];
};
