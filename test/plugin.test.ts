import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseConfig, type CoachConfig } from "../src/config.ts";
import { addDays, clockMinutes, dateRange, daysBetween, isIsoDate, todayIn, weekStart } from "../src/dates.ts";
import { classifyGcError, type GcResult, type GcRunner } from "../src/garmin/gc.ts";
import { garminDaySignals, lthrFromPayload, normalizeActivity, normalizeSplits, parseDailyExport } from "../src/garmin/normalize.ts";
import { loadStore } from "../src/store.ts";
import { ToolInputError, activityDeepDive, dailyBriefing, dataStatus, journalInsights, journalLog, strengthAnalysis, trainingLoad, trends, workoutPush, zonesAndPaces, type Deps } from "../src/tools.ts";
import { TODAY, makeHistory } from "./helpers.ts";

const NOW = new Date(`${TODAY}T08:00:00Z`);

function garminActivity(date: string, id: number) {
  return {
    activityId: id,
    activityName: "Morning Run",
    startTimeLocal: `${date} 07:30:00`,
    activityType: { typeKey: "running" },
    duration: 3600,
    movingDuration: 3550,
    distance: 10000,
    elevationGain: 120,
    elevationLoss: 118,
    averageHR: 141,
    maxHR: 172,
    hrTimeInZone_1: 300,
    hrTimeInZone_2: 1500,
    hrTimeInZone_3: 1500,
    hrTimeInZone_4: 300,
    hrTimeInZone_5: 0,
    aerobicTrainingEffect: 3.1,
    activityTrainingLoad: 112,
    averageSpeed: 2.78,
    vO2MaxValue: 51,
  };
}

/** A fake `gc`: serves a synthetic history and records every call. */
function fakeGc(options: { fail?: (args: string[]) => GcResult | null } = {}) {
  const calls: string[][] = [];
  const history = new Map(makeHistory(200).map((day) => [day.date, day]));
  const gc: GcRunner = async (args) => {
    calls.push(args);
    const failure = options.fail?.(args);
    if (failure) return failure;
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    if (args[0] === "daily") {
      const days = dateRange(value("--start"), value("--end")).map((date) => history.get(date)).filter(Boolean);
      return { ok: true, data: { schemaVersion: 1, start: value("--start"), end: value("--end"), detail: args.includes("--detail"), days, errors: {} } };
    }
    if (args[0] === "activities" && args[1] === "--start") {
      const dates = dateRange(value("--start"), value("--end")).filter((_, index) => index % 2 === 0);
      return { ok: true, data: dates.map((date, index) => garminActivity(date, 1000 + daysBetween("2026-01-01", date) + index * 0)) };
    }
    if (args[0] === "metrics" && args[1] === "lactate-threshold") return { ok: true, data: { speed_and_heart_rate: { heartRate: 162 } } };
    if (args[0] === "metrics" && args[1] === "training-readiness") return { ok: true, data: [{ score: 71, level: "HIGH", recoveryTime: 600 }] };
    if (args[0] === "metrics" && args[1] === "training-status") {
      return { ok: true, data: { mostRecentVO2Max: { generic: { vo2MaxValue: 51, calendarDate: TODAY } }, mostRecentTrainingStatus: { latestTrainingStatusData: { "1": { trainingStatusFeedbackPhrase: "PRODUCTIVE_1", acuteTrainingLoadDTO: { dailyTrainingLoadAcute: 400, dailyTrainingLoadChronic: 380, dailyAcuteChronicWorkloadRatio: 1.05 } } } } } };
    }
    if (args[0] === "activities" && args[1] === "get") return { ok: true, data: { activityId: Number(args[2]), activityName: "Long Run", activityTypeDTO: { typeKey: "trail_running" }, summaryDTO: { startTimeLocal: `${TODAY}T07:00:00.0`, duration: 5400, distance: 15000, averageHR: 145, maxHR: 170, elevationGain: 600, elevationLoss: 600, averageSpeed: 2.78, trainingEffect: 3.8 } } };
    if (args[0] === "activities" && args[1] === "splits") {
      const lap = (hr: number) => ({ distance: 2500, duration: 900, movingDuration: 900, averageHR: hr, elevationGain: 100, elevationLoss: 100 });
      return { ok: true, data: { lapDTOs: [lap(138), lap(140), lap(142), lap(150), lap(152), lap(154)] } };
    }
    if (args[0] === "activities" && args[1] === "hr-zones") {
      return { ok: true, data: [1, 2, 3, 4, 5].map((zone) => ({ zoneNumber: zone, secsInZone: [600, 2400, 1800, 600, 0][zone - 1], zoneLowBoundary: 90 + zone * 15 })) };
    }
    if (args[0] === "activities" && args[1] === "weather") return { ok: true, data: { temp: 86, relativeHumidity: 60, weatherTypeDTO: { desc: "Sunny" } } };
    if (args[0] === "activities" && args[1] === "exercise-sets") return { ok: true, data: { exerciseSets: [{ setType: "ACTIVE", repetitionCount: 5, weight: 100000, exercises: [{ category: "SQUAT", name: "BACK_SQUAT" }] }] } };
    if (args[0] === "workouts") return { ok: true, data: { workoutId: 4242 } };
    return { ok: false, code: "unsupported", message: "unexpected call" };
  };
  return { gc, calls };
}

async function setup(overrides: Record<string, unknown> = {}, gcOptions: Parameters<typeof fakeGc>[0] = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "coach-test-"));
  const config: CoachConfig = parseConfig({ dataDir, timezone: "Europe/Paris", sex: "male", hrMax: 180, ...overrides });
  const fake = fakeGc(gcOptions);
  const deps: Deps = { config, gc: fake.gc, now: () => NOW };
  return { deps, calls: fake.calls, dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

// --- helpers and parsing --------------------------------------------------------------------------

test("date helpers handle timezones, weeks and local clock times", () => {
  assert.equal(todayIn("Europe/Paris", new Date("2026-11-15T23:30:00Z")), "2026-11-16");
  assert.equal(todayIn("America/Los_Angeles", new Date("2026-11-15T02:00:00Z")), "2026-11-14");
  assert.equal(addDays("2026-03-28", 2), "2026-03-30"); // across a daylight-saving change
  assert.equal(weekStart("2026-11-15"), "2026-11-09"); // a Sunday belongs to the week started on Monday
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("2026-11-15; rm -rf"), false);
  assert.equal(clockMinutes("2026-11-14T23:30:00"), 1410);
});

test("configuration falls back to defaults on invalid values", () => {
  const config = parseConfig({ timezone: "Mars/Olympus", hrMax: 400, sex: "x", hrZoneFloorsPctMax: [50, 60, 55, 80, 90], historyDays: 5 });
  assert.equal(config.hrMax, null);
  assert.equal(config.sex, null);
  assert.deepEqual(config.hrZoneFloorsPctMax, [50, 60, 70, 80, 90]);
  assert.equal(config.historyDays, 90);
  assert.equal(config.allowWorkoutPush, false);
  assert.notEqual(config.timezone, "Mars/Olympus");
  assert.equal(parseConfig(undefined).gcBinary, "gc");
});

test("gc failures map to stable codes without leaking output", () => {
  assert.equal(classifyGcError({ code: "ENOENT" }, ""), "not_configured");
  assert.equal(classifyGcError({ killed: true }, ""), "timeout");
  assert.equal(classifyGcError({ code: 1 }, "Error: Authentication failed. Try 'gc login' again."), "auth");
  assert.equal(classifyGcError({ code: 1 }, "Error: Rate limit exceeded."), "rate_limited");
  assert.equal(classifyGcError({ code: 2 }, "Usage: gc [OPTIONS] --tokenstore TEXT\nNo such command 'daily'."), "unsupported");
  assert.equal(classifyGcError({ code: 1 }, "Traceback ... secret"), "error");
});

test("Garmin payloads are normalized, and unknown shapes give nulls or nothing", () => {
  const activity = normalizeActivity(garminActivity(TODAY, 77));
  assert.equal(activity?.id, "77");
  assert.equal(activity?.date, TODAY);
  assert.deepEqual(activity?.hrZonesS, [300, 1500, 1500, 300, 0]);
  assert.equal(activity?.avgPowerW, null);
  assert.equal(normalizeActivity({ activityId: 1 }), null);
  assert.equal(normalizeActivity("x"), null);
  assert.equal(normalizeSplits({ lapDTOs: [{ distance: 1000, duration: 300, averageHR: 150 }, { distance: 0, duration: 10 }] }).length, 1);
  assert.equal(lthrFromPayload({ speed_and_heart_rate: { heartRate: 162.4 } }), 162);
  assert.equal(lthrFromPayload({ speed_and_heart_rate: { heartRate: 20 } }), null);
  assert.equal(parseDailyExport({ schemaVersion: 2, days: [] }), null);
  assert.deepEqual(garminDaySignals(null, null), {});
});

// --- sync and tools -------------------------------------------------------------------------------

test("the first briefing backfills history in few requests, then serves from the store", async () => {
  const { deps, calls, dataDir, cleanup } = await setup();
  try {
    const briefing = await dailyBriefing(deps, {});
    const daily = calls.filter((args) => args[0] === "daily");
    // 90 days: 88 older days in 28-day range chunks, plus one detailed call for the last two days.
    assert.equal(daily.length, 5);
    assert.equal(daily.filter((args) => args.includes("--no-detail")).length, 4);
    assert.ok(daily.every((args) => daysBetween(args[args.indexOf("--start") + 1], args[args.indexOf("--end") + 1]) < 28));

    assert.equal(briefing.date, TODAY);
    assert.equal(briefing.hrv.status, "ready");
    assert.equal(briefing.recovery.status, "ready");
    assert.equal(briefing.load.status, "ready");
    assert.ok(["hard", "moderate", "easy", "rest"].includes(briefing.readiness.ceiling));
    assert.equal(briefing.profile.lthr, 162);
    assert.equal(briefing.profile.hrRestSource, "baseline");
    assert.equal((briefing.garmin as unknown as { trainingReadiness: { score: number } }).trainingReadiness.score, 71);
    assert.equal(briefing.data.coverage.daysWithHrv, 90);
    assert.deepEqual(briefing.data.sync, { fetchedDays: 90, fetchedActivities: 90, errors: {} });

    const mode = (await stat(path.join(dataDir, "coach-store.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
    const raw = await readFile(path.join(dataDir, "coach-store.json"), "utf8");
    assert.ok(!raw.includes("password") && !raw.includes("token"));

    calls.length = 0;
    await dailyBriefing(deps, {});
    assert.deepEqual(calls.filter((args) => args[0] === "daily" || (args[0] === "activities" && args[1] === "--start")), []);
  } finally {
    await cleanup();
  }
});

test("an expired Garmin session is reported once and the briefing still answers from the store", async () => {
  const { deps, calls, cleanup } = await setup({}, { fail: () => ({ ok: false, code: "auth", message: "expired" }) });
  try {
    const briefing = await dailyBriefing(deps, {});
    assert.equal(calls.filter((args) => args[0] === "daily").length, 1);
    assert.deepEqual((briefing.data.sync as { errors: Record<string, string> }).errors, { daily: "auth" });
    assert.equal(briefing.hrv.status, "insufficient_data");
    assert.equal(briefing.recovery.score, null);
    assert.equal(briefing.readiness.confidence, "low");
    const status = await dataStatus(deps, { sync: true });
    assert.ok(status.advice.some((line) => line.includes("gc login")));
  } finally {
    await cleanup();
  }
});

test("a corrupt store stops the tool instead of being overwritten", async () => {
  const { deps, dataDir, cleanup } = await setup();
  try {
    await writeFile(path.join(dataDir, "coach-store.json"), "{not json");
    await assert.rejects(dailyBriefing(deps, {}), /unreadable/);
    assert.equal(await readFile(path.join(dataDir, "coach-store.json"), "utf8"), "{not json");
  } finally {
    await cleanup();
  }
});

test("trends aggregate by week and a plan can be projected", async () => {
  const { deps, cleanup } = await setup();
  try {
    const report = await trends(deps, { days: 28, includeDaily: true });
    const weekly = report.weekly as Array<{ weekStart: string; sessions: number; hrvMs: number | null }>;
    assert.equal(weekly.length, 4); // 28 days ending on a Sunday are four full weeks
    assert.ok(weekly.every((week) => week.hrvMs !== null && week.sessions >= 1));
    assert.equal((report.daily as unknown[]).length, 28);
    assert.equal((report.healthspan as { markers: unknown[] }).markers.length, 6);

    const plan = dateRange(addDays(TODAY, 1), addDays(TODAY, 14)).map((date) => ({ date, durationMin: 30, zone: 1 }));
    const load = await trainingLoad(deps, { plan: [...plan, { date: "2020-01-01", load: 50 }, { date: addDays(TODAY, 3) }], sync: false });
    const projection = load.projection as { atEnd: { formNextMorning: number }; fitnessChange: number; rejected: string[] };
    assert.ok(projection.atEnd.formNextMorning > 0, "an easy fortnight raises form");
    assert.ok(projection.fitnessChange < 0);
    assert.equal(projection.rejected.length, 2);
  } finally {
    await cleanup();
  }
});

test("activity deep dive computes decoupling, zones and a heat flag, and rejects unsafe ids", async () => {
  const { deps, calls, cleanup } = await setup();
  try {
    await dataStatus(deps, { sync: true }); // anchors (resting heart rate) come from the synced history
    const dive = (await activityDeepDive(deps, { activityId: "123456" })) as Record<string, unknown>;
    assert.equal((dive.summary as { type: string }).type, "trail_running");
    assert.ok(((dive.decoupling as { decouplingPct: number }).decouplingPct) > 5);
    assert.deepEqual((dive.hrZones as { minutes: number[] }).minutes, [10, 40, 30, 10, 0]);
    assert.equal((dive.weather as { temperatureC: number }).temperatureC, 30);
    assert.equal((dive.flags as string[]).length, 3);
    assert.equal((dive.load as { method: string }).method, "zones");
    await assert.rejects(activityDeepDive(deps, { activityId: "12; rm -rf /" }), ToolInputError);
    await assert.rejects(strengthAnalysis(deps, { activityId: "--help" }), ToolInputError);
    assert.ok(calls.every((args) => !args.some((arg) => arg.includes("rm -rf"))));
    assert.equal(((await strengthAnalysis(deps, { activityId: 5 })) as { totalSets: number }).totalSets, 1);
  } finally {
    await cleanup();
  }
});

test("zones and paces use the resolved anchors and a race result", async () => {
  const { deps, cleanup } = await setup();
  try {
    await dataStatus(deps, { sync: true });
    const result = await zonesAndPaces(deps, { raceDistanceM: 10000, raceTimeS: 2700 });
    assert.equal((result.heartRateZones as unknown[]).length, 3);
    const race = result.race as { vdot: number; predictions: Array<{ distance: string; riegel: string }> };
    assert.ok(race.vdot > 44 && race.vdot < 46);
    assert.equal(race.predictions.length, 4);
    await assert.rejects(zonesAndPaces(deps, { raceDistanceM: 1000, raceTimeS: 150 }), ToolInputError);
  } finally {
    await cleanup();
  }
});

test("the journal merges entries, validates input and feeds the insights", async () => {
  const { deps, dataDir, cleanup } = await setup();
  try {
    await journalLog(deps, { tags: { "Late Caffeine": true, alcohol: 2 }, fatigue: 2 });
    const second = await journalLog(deps, { tags: { alcohol: 0 }, symptoms: ["sore throat"], notes: "x".repeat(900) });
    assert.deepEqual(second.saved.tags, { late_caffeine: true, alcohol: 0 });
    assert.equal(second.saved.fatigue, 2);
    assert.equal(second.saved.notes?.length, 500);
    assert.equal(Object.keys((await loadStore(dataDir)).journal).length, 1);
    await assert.rejects(journalLog(deps, { tags: { "bad tag!": true } }), ToolInputError);
    await assert.rejects(journalLog(deps, { fatigue: 9 }), ToolInputError);
    await assert.rejects(journalLog(deps, { date: addDays(TODAY, 1) }), ToolInputError);

    const briefing = await dailyBriefing(deps, {});
    assert.equal(briefing.readiness.ceiling, "rest");
    // A habit is compared through the night that follows it: yesterday's entry has one.
    await journalLog(deps, { date: "yesterday", tags: { sauna: true, alcohol: false } });
    const insights = await journalInsights(deps, {});
    assert.equal(insights.journalDays, 2);
    assert.deepEqual(insights.insufficient.map((item) => item.tag), ["alcohol", "sauna"]);
    assert.deepEqual(insights.associations, []);
  } finally {
    await cleanup();
  }
});

test("a workout is only written to Garmin when enabled and confirmed", async () => {
  const steps = [
    { type: "warmup", durationS: 900, target: "hr_zone:2" },
    { type: "interval", durationS: 240, target: "hr_zone:4" },
    { type: "recovery", durationS: 180 },
    { type: "cooldown", durationS: 600 },
  ];
  const disabled = await setup();
  try {
    const result = await workoutPush(disabled.deps, { name: "4 min", sport: "running", steps, confirm: true });
    assert.equal(result.created, false);
    assert.equal(disabled.calls.filter((args) => args[0] === "workouts").length, 0);
  } finally {
    await disabled.cleanup();
  }

  const enabled = await setup({ allowWorkoutPush: true });
  try {
    const preview = await workoutPush(enabled.deps, { name: "4 min", sport: "running", steps });
    assert.equal(preview.created, false);
    assert.equal(preview.preview.totalMin, 32);
    assert.equal(enabled.calls.filter((args) => args[0] === "workouts").length, 0);

    const done = await workoutPush(enabled.deps, { name: "4 min", sport: "running", steps, confirm: true });
    assert.equal(done.created, true);
    assert.equal(done.workoutId, 4242);
    const call = enabled.calls.find((args) => args[0] === "workouts") as string[];
    assert.deepEqual(JSON.parse(call[call.indexOf("--steps") + 1])[1], { type: "interval", duration: 240, target: "hr_zone:4" });

    await assert.rejects(workoutPush(enabled.deps, { name: "x", sport: "running", steps: [{ type: "interval", durationS: 60, target: "$(reboot)" }] }), ToolInputError);
    await assert.rejects(workoutPush(enabled.deps, { name: "x", sport: "golf", steps }), ToolInputError);
  } finally {
    await enabled.cleanup();
  }
});
