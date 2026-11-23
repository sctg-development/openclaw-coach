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

// --- load status (cardiac and muscular) -----------------------------------------------------------

import { LOAD_STATUSES, loadStatusReport, statusOf } from "../src/science/loadstatus.ts";
import { activityMuscularLoad, dailyMuscularLoads } from "../src/science/muscular.ts";
import { dateRange } from "../src/dates.ts";
import { makeActivity } from "./helpers.ts";

const series = (count: number, valueAt: (index: number) => number) => dateRange(addDays(TODAY, -(count - 1)), TODAY).map((date, index) => ({ date, load: valueAt(index) }));

test("the status follows the ratio of short-term to long-term load, and the range moves with fitness", () => {
  assert.equal(statusOf(0.5, 0, 60), "undertraining");
  assert.equal(statusOf(0.7, 0, 60), "maintaining");
  assert.equal(statusOf(0.9, 0, 60), "optimal");
  assert.equal(statusOf(1.1, 1, 60), "productive");
  assert.equal(statusOf(1.1, -1, 60), "optimal");
  assert.equal(statusOf(1.4, 1, 60), "strained");
  assert.equal(statusOf(1.7, 1, 60), "overreaching");
  assert.equal(statusOf(1.0, 0, 10), "calibrating");
  assert.equal(statusOf(null, null, 60), "calibrating");
});

test("steady training is optimal, a sudden block pushes the load above the range, and the distribution adds up", () => {
  const steady = loadStatusReport(series(90, () => 60), "TRIMP");
  assert.equal(steady.today?.status, "optimal");
  assert.equal(steady.today?.position, "within");
  const spike = loadStatusReport(series(90, (index) => (index >= 85 ? 200 : 60)), "TRIMP");
  assert.equal(spike.today?.position, "above");
  assert.ok(["strained", "overreaching"].includes(spike.today?.status ?? ""));
  assert.ok((spike.today?.optimalRange[1] ?? 0) < (spike.today?.value ?? 0));
  const total = spike.distribution.reduce((sum, entry) => sum + entry.days, 0);
  assert.equal(total, 30);
  assert.ok(spike.distribution.every((entry) => (LOAD_STATUSES as readonly string[]).includes(entry.status)));
  const short = loadStatusReport(series(10, () => 50), "TRIMP");
  assert.equal(short.today?.status, "calibrating");
  assert.ok(short.notes.length > 0);
});

test("muscular load counts running descent, half of it when walking, none by bike, and strength by duration", () => {
  const run = makeActivity(TODAY, { type: "trail_running", elevLossM: 800, durationS: 7200 });
  const hike = makeActivity(TODAY, { type: "hiking", elevLossM: 800, durationS: 7200 });
  const bike = makeActivity(TODAY, { type: "cycling", elevLossM: 800, durationS: 7200 });
  const gym = makeActivity(TODAY, { type: "strength_training", elevLossM: null, durationS: 2700 });
  assert.deepEqual(activityMuscularLoad(run), { eccentric: 800, strength: 0 });
  assert.deepEqual(activityMuscularLoad(hike), { eccentric: 400, strength: 0 });
  assert.deepEqual(activityMuscularLoad(bike), { eccentric: 0, strength: 0 });
  assert.equal(activityMuscularLoad(gym).strength, 67.5);
  const days = dailyMuscularLoads([run, gym], addDays(TODAY, -2), TODAY);
  assert.equal(days.length, 3);
  assert.equal(days[2]?.load, 867.5);
  assert.equal(days[0]?.load, 0);
});

// --- descent measured from the FIT file ------------------------------------------------------------

import { enrichDescents, DESCENT_PER_SYNC, type SyncReport } from "../src/sync.ts";
import { emptyStore } from "../src/store.ts";
import { parseDescent } from "../src/garmin/normalize.ts";
import type { GcRunner } from "../src/garmin/gc.ts";

test("a measured descent replaces the summary's metres lost in the muscular load, and weighs steep descents more", () => {
  const summary = makeActivity(TODAY, { type: "trail_running", elevLossM: 600, durationS: 7200 });
  const measured = { ...summary, descent: { descentM: 580, steepDescentM: 300, eccentricUnits: 800 } };
  assert.equal(activityMuscularLoad(summary).eccentric, 600);
  assert.equal(activityMuscularLoad(measured).eccentric, 800);
  // A file with nothing usable (null) falls back to the summary.
  assert.equal(activityMuscularLoad({ ...summary, descent: null }).eccentric, 600);
  // Walking keeps its half weight on the measured value.
  assert.equal(activityMuscularLoad({ ...measured, type: "hiking" }).eccentric, 400);
});

test("the descent payload is validated", () => {
  assert.deepEqual(parseDescent({ descentM: 120, steepDescentM: 30, eccentricUnits: 150, extra: 1 }), { descentM: 120, steepDescentM: 30, eccentricUnits: 150 });
  assert.equal(parseDescent(null), null);
  assert.equal(parseDescent({ descentM: -5, eccentricUnits: 1 }), null);
  assert.equal(parseDescent({ descentM: "x", eccentricUnits: 1 }), null);
});

test("descents are measured for a few recent running sessions per sync, newest first, once each, and stop on the first failure", async () => {
  const store = emptyStore();
  for (let i = 0; i < 8; i += 1) store.activities[`10${i}`] = makeActivity(addDays(TODAY, -i), { id: `10${i}`, type: "trail_running", elevLossM: 100 });
  store.activities.bike = makeActivity(TODAY, { id: "bike", type: "cycling", elevLossM: 900 });
  store.activities.flat = makeActivity(TODAY, { id: "flat", type: "running", elevLossM: 5 });
  store.activities.old = makeActivity(addDays(TODAY, -400), { id: "old", type: "running", elevLossM: 300 });
  const asked: string[] = [];
  const gc: GcRunner = async (args) => (asked.push(args.join(" ")), { ok: true, data: { descentM: 90, steepDescentM: 10, eccentricUnits: 95 } });
  const report: SyncReport = { fetchedDays: 0, fetchedActivities: 0, fetchedDescents: 0, errors: {}, skipped: false };
  await enrichDescents(store, gc, addDays(TODAY, -180), report);
  assert.equal(report.fetchedDescents, DESCENT_PER_SYNC);
  assert.deepEqual(asked, ["100", "101", "102", "103", "104"].map((id) => `activities descent ${id}`));
  assert.equal(store.activities["100"]?.descent?.eccentricUnits, 95);
  assert.equal(store.activities.bike?.descent, undefined);
  assert.equal(store.activities.flat?.descent, undefined);
  assert.equal(store.activities.old?.descent, undefined);

  // Next sync: the three remaining ones, and none is fetched twice.
  const again: string[] = [];
  await enrichDescents(store, async (args) => (again.push(args[2] as string), { ok: true, data: null }), addDays(TODAY, -180), report);
  assert.deepEqual(again, ["105", "106", "107"]);
  assert.equal(store.activities["105"]?.descent, null, "nothing usable is remembered as null");

  // A failure (here: no native client) stops the step and is reported, leaving the activity to try again later.
  const failing = emptyStore();
  failing.activities.a = makeActivity(TODAY, { id: "a", type: "running", elevLossM: 100 });
  failing.activities.b = makeActivity(addDays(TODAY, -1), { id: "b", type: "running", elevLossM: 100 });
  let calls = 0;
  const failReport: SyncReport = { fetchedDays: 0, fetchedActivities: 0, fetchedDescents: 0, errors: {}, skipped: false };
  await enrichDescents(failing, async () => (calls += 1, { ok: false, code: "unsupported", message: "x" }), addDays(TODAY, -180), failReport);
  assert.equal(calls, 1);
  assert.deepEqual(failReport.errors, {}, "no native client is not an error to report");
  const limited: SyncReport = { fetchedDays: 0, fetchedActivities: 0, fetchedDescents: 0, errors: {}, skipped: false };
  await enrichDescents(failing, async () => ({ ok: false, code: "rate_limited", message: "x" }), addDays(TODAY, -180), limited);
  assert.equal(limited.errors.descent, "rate_limited");
  assert.equal(failing.activities.a?.descent, undefined);
});
