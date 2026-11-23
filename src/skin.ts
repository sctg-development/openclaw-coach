/**
 * Wrist skin temperature is optional: many watches (for example the Fenix 6 series) never record it.
 *
 * `auto` (the default) keeps the signal only when the watch actually recorded it on enough recent nights, so
 * a device without the sensor is never shown an empty "skin temperature" row or asked for a baseline it cannot
 * build. `on` keeps whatever data exists, `off` always drops it.
 */
import type { DayRecord } from "./types.ts";

export type SkinTemperatureMode = "auto" | "on" | "off";

/** Nights with a value, within the most recent SKIN_TEMP_WINDOW_DAYS, that turn the signal on in `auto` mode. */
export const SKIN_TEMP_MIN_NIGHTS = 5;
export const SKIN_TEMP_WINDOW_DAYS = 30;

/** Whether the signal is used for these days (ascending dates) under `mode`. */
export function skinTempActive(mode: SkinTemperatureMode, days: readonly DayRecord[]): boolean {
  if (mode === "off") return false;
  if (mode === "on") return true;
  const recent = days.slice(-SKIN_TEMP_WINDOW_DAYS);
  return recent.filter((day) => typeof day.skinTempDeviationC === "number").length >= SKIN_TEMP_MIN_NIGHTS;
}

/**
 * Returns the days with skin temperature removed when the signal is not active. Dropping it at the source keeps
 * the recovery score, the early-warning rules, the charts and the journal outcomes consistent: none of them has to
 * know about the option, and the stored data is left untouched.
 */
export function applySkinTemperature(mode: SkinTemperatureMode, days: DayRecord[]): { days: DayRecord[]; active: boolean } {
  const active = skinTempActive(mode, days);
  return { days: active ? days : days.map((day) => (day.skinTempDeviationC === null ? day : { ...day, skinTempDeviationC: null })), active };
}
