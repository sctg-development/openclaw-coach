import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { addDays } from "../src/dates.ts";
import { analyzeRecovery } from "../src/science/recovery.ts";
import { INTENSITY_ALGORITHM, intensityMinutes } from "../src/science/intensity.ts";
import { applySkinTemperature, skinTempActive } from "../src/skin.ts";
import { signalsChart } from "../src/charts/build.ts";
import { PROFILE, TODAY, makeHistory } from "./helpers.ts";
import type { DayRecord } from "../src/types.ts";

// --- optional skin temperature ---------------------------------------------------------------------

const withoutSensor = () => makeHistory(60, TODAY, () => ({ skinTemp: null }));

test("auto mode drops skin temperature for a watch that never recorded it, and keeps it for one that did", () => {
  assert.equal(skinTempActive("auto", withoutSensor()), false);
  assert.equal(skinTempActive("auto", makeHistory(60)), true);
  // A few stray nights are not enough to build a baseline.
  const sparse = makeHistory(60, TODAY, (fromEnd) => (fromEnd > 3 ? { skinTemp: null } : null));
  assert.equal(skinTempActive("auto", sparse), false);
  assert.equal(skinTempActive("on", withoutSensor()), true);
  assert.equal(skinTempActive("off", makeHistory(60)), false);
});

test("turning the signal off removes it from the recovery score without breaking it", () => {
  const days = makeHistory(60);
  const kept = analyzeRecovery(days, PROFILE);
  assert.ok("skinTemp" in kept.components);
  const off = applySkinTemperature("off", days);
  assert.equal(off.active, false);
  assert.ok(off.days.every((day) => day.skinTempDeviationC === null));
  const without = analyzeRecovery(off.days, PROFILE);
  assert.equal("skinTemp" in without.components, false);
  assert.notEqual(without.score, null);
  // The stored records are not modified.
  assert.ok(days.some((day) => day.skinTempDeviationC !== null));
});

test("the config accepts auto, on and off, and falls back to auto", () => {
  assert.equal(parseConfig({}).skinTemperature, "auto");
  assert.equal(parseConfig({ skinTemperature: "off" }).skinTemperature, "off");
  assert.equal(parseConfig({ skinTemperature: "on" }).skinTemperature, "on");
  assert.equal(parseConfig({ skinTemperature: "sometimes" }).skinTemperature, "auto");
});

test("the signals chart leaves the skin temperature row out when there is nothing to show", () => {
  const row = { value: 0, baseline: 0, delta: 0, z: 0 };
  const none = { value: null, baseline: null, delta: null, z: null };
  const theme = { text: "#000", muted: "#666", grid: "#ddd", track: "#eee", accent: "#06c", good: "#0a0", warn: "#fa0", bad: "#d00", background: "#fff" } as never;
  const make = (skinTemp: typeof row) => signalsChart({ theme, lang: "en", rows: { hrv: row, restingHr: row, respiration: row, skinTemp, spo2: row } });
  const absent = make(none);
  const present = make(row);
  assert.ok(absent.height < present.height);
  assert.ok(!absent.svg.includes("Skin temp."));
  assert.ok(present.svg.includes("Skin temp."));
});

// --- intensity minutes -----------------------------------------------------------------------------

function daysWithMinutes(count: number, moderate: number, vigorous: number, end = TODAY): DayRecord[] {
  return makeHistory(count, end).map((day) => ({ ...day, activity: { steps: null, activeKcal: null, bmrKcal: null, floorsUp: null, moderateMin: moderate, vigorousMin: vigorous } }));
}

test("intensity minutes count a vigorous minute as two moderate ones and compare with the 150-minute minimum", () => {
  const report = intensityMinutes(daysWithMinutes(40, 10, 10), TODAY);
  assert.equal(report.rolling7.moderateMin, 70);
  assert.equal(report.rolling7.vigorousMin, 70);
  assert.equal(report.rolling7.equivalentMin, 210);
  assert.equal(report.percentOfMinimum, 140);
  assert.equal(report.minimumMet, true);
  assert.equal(report.previousWeeks.length, 4);
  assert.ok(report.previousWeeks.every((week) => week.equivalentMin === 210));
  assert.deepEqual(report.algorithm, INTENSITY_ALGORITHM);
  const low = intensityMinutes(daysWithMinutes(40, 5, 0), TODAY);
  assert.equal(low.rolling7.equivalentMin, 35);
  assert.equal(low.minimumMet, false);
});

test("missing days are unknown, not zero, and too few days give no total", () => {
  const days = daysWithMinutes(40, 10, 5);
  const gaps = days.map((day) => (day.date > addDays(TODAY, -4) ? { ...day, activity: null } : day));
  const report = intensityMinutes(gaps, TODAY);
  assert.equal(report.rolling7.daysWithData, 3);
  assert.equal(report.rolling7.equivalentMin, null);
  assert.equal(report.status, "insufficient_data");
  assert.equal(report.minimumMet, null);
  // The week so far reports what exists, however few days there are.
  assert.ok((report.weekToDate.daysWithData ?? 0) <= 7);
});
