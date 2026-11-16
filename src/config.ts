/** Plugin configuration: parsing and defaults. Invalid values fall back to the default. */

import os from "node:os";
import path from "node:path";
import { isValidTimezone } from "./dates.ts";
import type { Sex } from "./types.ts";

export type CoachConfig = {
  gcBinary: string;
  timezone: string;
  dataDir: string;
  /** Days of recovery history kept in sync (baselines need 60 + margin). */
  historyDays: number;
  /** Days of activity history used for the load model. */
  loadHistoryDays: number;
  retentionDays: number;
  cacheMinutes: number;
  sex: Sex | null;
  birthYear: number | null;
  hrMax: number | null;
  hrRest: number | null;
  lthr: number | null;
  sleepNeedHours: number | null;
  hrZoneFloorsPctMax: number[];
  allowWorkoutPush: boolean;
  /** Language of chart labels. */
  language: "en" | "fr";
};

export const DEFAULT_ZONE_FLOORS = [50, 60, 70, 80, 90];

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberIn(value: unknown, low: number, high: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high ? value : null;
}

export function parseConfig(raw: unknown): CoachConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const timezone = text(cfg.timezone);
  const floors = Array.isArray(cfg.hrZoneFloorsPctMax) ? cfg.hrZoneFloorsPctMax : null;
  const floorsValid =
    floors !== null &&
    floors.length === 5 &&
    floors.every((value, index) => numberIn(value, 30, 99) !== null && (index === 0 || value > floors[index - 1]));
  const sex = text(cfg.sex);
  return {
    gcBinary: text(cfg.gcBinary) ?? "gc",
    timezone: timezone && isValidTimezone(timezone) ? timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    dataDir: text(cfg.dataDir) ?? path.join(os.homedir(), ".openclaw", "coach"),
    historyDays: numberIn(cfg.historyDays, 30, 365) ?? 90,
    loadHistoryDays: numberIn(cfg.loadHistoryDays, 42, 365) ?? 180,
    retentionDays: numberIn(cfg.retentionDays, 90, 3650) ?? 730,
    cacheMinutes: numberIn(cfg.cacheMinutes, 0, 1440) ?? 15,
    sex: sex === "male" || sex === "female" ? sex : null,
    birthYear: numberIn(cfg.birthYear, 1920, 2020),
    hrMax: numberIn(cfg.hrMax, 120, 230),
    hrRest: numberIn(cfg.hrRest, 25, 100),
    lthr: numberIn(cfg.lthr, 100, 210),
    sleepNeedHours: numberIn(cfg.sleepNeedHours, 6, 10),
    hrZoneFloorsPctMax: floorsValid ? (floors as number[]) : DEFAULT_ZONE_FLOORS,
    allowWorkoutPush: cfg.allowWorkoutPush === true,
    language: text(cfg.language)?.toLowerCase().startsWith("fr") ? "fr" : "en",
  };
}
