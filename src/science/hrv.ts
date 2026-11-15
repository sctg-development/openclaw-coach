/**
 * Heart-rate variability: individual baseline, rolling trend and stability.
 *
 * Input: Garmin's overnight HRV average (rMSSD, ms). It is log-transformed
 * (ln rMSSD) because rMSSD is right-skewed and its day-to-day changes are
 * proportional to its level.
 *
 * Model (Plews 2012, 2013; Buchheit 2014):
 * - trend   = 7-day rolling mean of ln rMSSD, more informative than one night;
 * - normal  = personal baseline (60 preceding days) +/- the smallest worthwhile
 *             change, SWC = 0.5 x between-day SD (Hopkins 2009);
 * - CV      = coefficient of variation of the last 7 nights: day-to-day stability.
 */

import type { AlgorithmTag, DataStatus, DayRecord } from "../types.ts";
import { isNum, mean, median, robustBaseline, round, roundOrNull, sd, valid, zScore, type Maybe } from "./stats.ts";

export const HRV_ALGORITHM: AlgorithmTag = {
  id: "hrv-baseline",
  version: "1.0.0",
  refs: ["plews2012", "plews2013", "plews2014", "buchheit2014", "hopkins2009"],
};

export const HRV_BASELINE_DAYS = 60;
export const HRV_TREND_DAYS = 7;
/** Nights needed in the baseline window before the normal range is used. */
export const HRV_MIN_BASELINE_NIGHTS = 14;
/** Nights needed among the last 7 for a trend (Plews 2014: 3 to 5 per week). */
export const HRV_MIN_TREND_NIGHTS = 3;
export const HRV_GOOD_TREND_NIGHTS = 5;
const SWC_FACTOR = 0.5;
/** Smallest between-day SD of ln rMSSD accepted, to avoid over-reacting to noise. */
const LN_RMSSD_SD_FLOOR = 0.05;

export type HrvTrend = "below" | "within" | "above";

export type HrvAnalysis = {
  status: DataStatus;
  algorithm: AlgorithmTag;
  lastNightMs: number | null;
  lastNightLn: number | null;
  /** z-score of last night against the personal baseline (acute change). */
  acuteZ: number | null;
  rolling7Ln: number | null;
  rolling7Ms: number | null;
  nightsInTrend: number;
  baseline: {
    meanLn: number;
    sdLn: number;
    lowLn: number;
    highLn: number;
    /** The same range expressed in ms, for display. */
    lowMs: number;
    highMs: number;
    nights: number;
    days: number;
  } | null;
  /** Position of the 7-day mean relative to baseline +/- SWC. */
  trend: HrvTrend | null;
  cv7Pct: number | null;
  cvBaselinePct: number | null;
  /** Change of the 7-day mean over the last 7 days, in percent of rMSSD. */
  weekChangePct: number | null;
  /** Consecutive days (ending today) with the 7-day mean below the normal range. */
  daysBelow: number;
  garminStatus: string | null;
  notes: string[];
};

export function lnRmssd(day: DayRecord | undefined): number | null {
  const value = day?.hrv?.lastNightAvgMs;
  return isNum(value) && value > 0 ? Math.log(value) : null;
}

function rollingMean(values: readonly Maybe[], end: number, size: number, minN: number): number | null {
  const window = valid(values.slice(Math.max(0, end - size + 1), end + 1));
  return window.length >= minN ? mean(window) : null;
}

function cvPct(values: readonly number[]): number | null {
  const m = mean(values);
  const s = sd(values);
  return m && s !== null ? (s / m) * 100 : null;
}

/**
 * @param days Consecutive days in ascending order; the last one is the day being assessed
 *             (its HRV is the night that just ended).
 */
export function analyzeHrv(days: readonly DayRecord[]): HrvAnalysis {
  const series = days.map(lnRmssd);
  const last = series.length - 1;
  const today = last >= 0 ? series[last] : null;
  const notes: string[] = [];

  const baselineWindow = series.slice(Math.max(0, last - HRV_BASELINE_DAYS), Math.max(0, last));
  const robust = robustBaseline(baselineWindow, LN_RMSSD_SD_FLOOR, HRV_MIN_BASELINE_NIGHTS);
  const trendNights = valid(series.slice(Math.max(0, last - HRV_TREND_DAYS + 1), last + 1));
  const rolling7 = trendNights.length >= HRV_MIN_TREND_NIGHTS ? mean(trendNights) : null;

  let baseline: HrvAnalysis["baseline"] = null;
  let trend: HrvTrend | null = null;
  let daysBelow = 0;
  if (robust) {
    const swc = SWC_FACTOR * robust.scale;
    const lowLn = robust.center - swc;
    const highLn = robust.center + swc;
    baseline = {
      meanLn: round(robust.center, 3),
      sdLn: round(robust.scale, 3),
      lowLn: round(lowLn, 3),
      highLn: round(highLn, 3),
      lowMs: round(Math.exp(lowLn), 0),
      highMs: round(Math.exp(highLn), 0),
      nights: robust.n,
      days: baselineWindow.length,
    };
    if (rolling7 !== null) trend = rolling7 < lowLn ? "below" : rolling7 > highLn ? "above" : "within";
    // The baseline is kept fixed while walking back: the question is how long the
    // trend has been below today's normal range.
    for (let index = last; index >= 0; index -= 1) {
      const value = rollingMean(series, index, HRV_TREND_DAYS, HRV_MIN_TREND_NIGHTS);
      if (value === null || value >= lowLn) break;
      daysBelow += 1;
    }
  }

  const cv7 = trendNights.length >= HRV_MIN_TREND_NIGHTS ? cvPct(trendNights) : null;
  const pastCvs: number[] = [];
  for (let index = Math.max(HRV_TREND_DAYS - 1, last - HRV_BASELINE_DAYS); index < last; index += 1) {
    const window = valid(series.slice(index - HRV_TREND_DAYS + 1, index + 1));
    const value = window.length >= HRV_GOOD_TREND_NIGHTS ? cvPct(window) : null;
    if (value !== null) pastCvs.push(value);
  }
  const cvBaseline = pastCvs.length >= 7 ? median(pastCvs) : null;

  const previous7 = last >= HRV_TREND_DAYS ? rollingMean(series, last - HRV_TREND_DAYS, HRV_TREND_DAYS, HRV_MIN_TREND_NIGHTS) : null;
  const weekChangePct = rolling7 !== null && previous7 !== null ? (Math.exp(rolling7 - previous7) - 1) * 100 : null;

  if (trendNights.length > 0 && trendNights.length < HRV_GOOD_TREND_NIGHTS) {
    notes.push(`Only ${trendNights.length} of the last 7 nights have an HRV value: the trend is less reliable.`);
  }
  if (today === null) notes.push("No HRV value for last night (watch not worn, or sleep too short).");

  const status: DataStatus = !baseline ? (valid(series).length ? "calibrating" : "insufficient_data") : rolling7 === null ? "insufficient_data" : "ready";

  return {
    status,
    algorithm: HRV_ALGORITHM,
    lastNightMs: roundOrNull(days[last]?.hrv?.lastNightAvgMs, 0),
    lastNightLn: roundOrNull(today, 3),
    acuteZ: roundOrNull(zScore(today, robust), 2),
    rolling7Ln: roundOrNull(rolling7, 3),
    rolling7Ms: rolling7 === null ? null : round(Math.exp(rolling7), 0),
    nightsInTrend: trendNights.length,
    baseline,
    trend,
    cv7Pct: roundOrNull(cv7, 1),
    cvBaselinePct: roundOrNull(cvBaseline, 1),
    weekChangePct: roundOrNull(weekChangePct, 1),
    daysBelow,
    garminStatus: days[last]?.hrv?.status ?? null,
    notes,
  };
}
