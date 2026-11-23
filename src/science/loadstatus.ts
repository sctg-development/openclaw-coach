/**
 * Load status: where the recent load stands against the athlete's own chronic load, for the heart and for the muscles.
 *
 * Both indicators use the same mechanics as the fitness-fatigue model (see load.ts): the short-term load (ATL, 7-day
 * time constant) is read against the long-term load (CTL, 42-day time constant, about six weeks). The optimal range
 * is a band around the chronic load, so it moves with the athlete's fitness instead of being a fixed number.
 *
 *   ratio = ATL / CTL            range = [0.8, 1.3] x CTL
 *
 * Seven statuses describe the ratio and the direction of the chronic load (this is a PLUGIN CONVENTION built on the
 * published fitness-fatigue model, not a validated classification, and not Bevel's or Garmin's proprietary one):
 *
 *   calibrating   fewer than 28 days of history at that date
 *   undertraining ratio < 0.6          load is well below what the body is used to: fitness tends to decline
 *   maintaining   0.6 <= ratio < 0.8   below the range: enough to hold the current level
 *   optimal       0.8 <= ratio < 1.0   inside the range and recovered
 *   productive    1.0 <= ratio < 1.3   inside the range and the chronic load is rising
 *                                      (when the chronic load is not rising this band is read as optimal)
 *   strained      1.3 <= ratio < 1.5   above the range: fatigue is accumulating
 *   overreaching  ratio >= 1.5         well above the range: a load spike relative to what the body is used to
 *
 * The ratio describes a progression of load. It does not predict injury (Impellizzeri 2020, Lolli 2019) and
 * "overreaching" names a load level, never a diagnosis.
 */
import type { AlgorithmTag } from "../types.ts";
import { fitnessFatigue, LOAD_MIN_DAYS } from "./load.ts";
import { round } from "./stats.ts";

export const LOAD_STATUS_ALGORITHM: AlgorithmTag = {
  id: "load-status",
  version: "1.0.0",
  refs: ["banister1991", "calvert1976", "impellizzeri2020", "lolli2019"],
};

export const LOAD_STATUSES = ["calibrating", "undertraining", "maintaining", "optimal", "productive", "strained", "overreaching"] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];

/** Optimal range as fractions of the chronic load. */
export const RANGE_LOW = 0.8;
export const RANGE_HIGH = 1.3;
const UNDER = 0.6;
const STRAINED = 1.3;
const OVERREACHING = 1.5;
/** Days over which the status distribution is reported. */
export const DISTRIBUTION_DAYS = 30;

/** Status for one day. `rampPerWeek` is the change of the chronic load over the last 7 days (null when unknown). */
export function statusOf(ratio: number | null, rampPerWeek: number | null, historyDays: number): LoadStatus {
  if (ratio === null || historyDays < LOAD_MIN_DAYS) return "calibrating";
  if (ratio < UNDER) return "undertraining";
  if (ratio < RANGE_LOW) return "maintaining";
  if (ratio < 1.0) return "optimal";
  if (ratio < STRAINED) return rampPerWeek !== null && rampPerWeek > 0 ? "productive" : "optimal";
  if (ratio < OVERREACHING) return "strained";
  return "overreaching";
}

export type LoadStatusReport = {
  algorithm: AlgorithmTag;
  /** What the load is made of, for the reader. */
  unit: string;
  today: {
    date: string;
    /** Short-term load (ATL), the figure shown against the range. */
    value: number;
    /** Long-term load (CTL). */
    chronic: number;
    ratio: number | null;
    optimalRange: [number, number];
    status: LoadStatus;
    /** Position of the value against the range. */
    position: "below" | "within" | "above" | null;
  } | null;
  /** Days and share of the last 30 days spent in each status (statuses with no day are omitted). */
  distribution: Array<{ status: LoadStatus; days: number; pct: number }>;
  /** One entry per day: the short-term load, the chronic load, the optimal range around it and the status. */
  daily: Array<{ date: string; value: number; chronic: number; low: number; high: number; status: LoadStatus }>;
  notes: string[];
};

/** @param loads Daily loads, ascending, one per calendar day, ending on the assessed day. */
export function loadStatusReport(loads: readonly { date: string; load: number }[], unit: string): LoadStatusReport {
  const curve = fitnessFatigue(loads);
  const daily: LoadStatusReport["daily"] = curve.map((point, index) => {
    const ratio = point.ctl > 0 ? point.atl / point.ctl : null;
    const ramp = index >= 7 ? point.ctl - (curve[index - 7]?.ctl ?? point.ctl) : null;
    return { date: point.date, value: round(point.atl, 0), chronic: round(point.ctl, 0), low: round(RANGE_LOW * point.ctl, 0), high: round(RANGE_HIGH * point.ctl, 0), status: statusOf(ratio, ramp, index + 1) };
  });
  const last = curve[curve.length - 1];
  const window = daily.slice(-DISTRIBUTION_DAYS);
  const distribution = LOAD_STATUSES.map((status) => {
    const days = window.filter((day) => day.status === status).length;
    return { status, days, pct: window.length ? Math.round((days / window.length) * 100) : 0 };
  }).filter((entry) => entry.days > 0);
  const notes: string[] = [];
  if (!last) notes.push("No load history.");
  else if (curve.length < LOAD_MIN_DAYS) notes.push(`Only ${curve.length} days of history: the status is calibrating until ${LOAD_MIN_DAYS} days.`);
  if (!last) return { algorithm: LOAD_STATUS_ALGORITHM, unit, today: null, distribution, daily, notes };
  const ratio = last.ctl > 0 ? last.atl / last.ctl : null;
  const range: [number, number] = [Math.round(RANGE_LOW * last.ctl), Math.round(RANGE_HIGH * last.ctl)];
  const value = Math.round(last.atl);
  return {
    algorithm: LOAD_STATUS_ALGORITHM,
    unit,
    today: {
      date: last.date,
      value,
      chronic: Math.round(last.ctl),
      ratio: ratio === null ? null : round(ratio, 2),
      optimalRange: range,
      status: daily[daily.length - 1]?.status ?? "calibrating",
      position: ratio === null ? null : value < range[0] ? "below" : value > range[1] ? "above" : "within",
    },
    distribution,
    daily,
    notes,
  };
}
