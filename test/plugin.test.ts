import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseConfig, type CoachConfig } from "../src/config.ts";
import { addDays, clockMinutes, dateRange, daysBetween, isIsoDate, todayIn, weekStart } from "../src/dates.ts";
import { classifyGcError, type GcResult, type GcRunner } from "../src/garmin/gc.ts";
import { VO2_TREND_BELOW_DAYS, garminDaySignals, loadBalanceSignal, lthrFromPayload, maxmetSignals, normalizeActivity, normalizeSplits, parseDailyExport } from "../src/garmin/normalize.ts";
import { createGarminRunner } from "../src/garmin/backend.ts";
import { isNativeCommand, nativeRunner, type NativeGarmin } from "../src/garmin/native.ts";
import { renderBriefingEmail } from "../src/email.ts";
import { loadStore } from "../src/store.ts";
import { dashboardHandler, renderDashboard } from "../src/dashboard.ts";
import { MAX_DISTINCT_TAGS, MAX_TAGS_PER_ENTRY } from "../src/limits.ts";
import { ToolInputError, activityDeepDive, briefingCharts, briefingEmail, dailyBriefing, dataStatus, inboxSync, journalInsights, journalLog, strengthAnalysis, trainingLoad, trends, workoutPush, zonesAndPaces, type Deps } from "../src/tools.ts";
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
  assert.equal(lthrFromPayload({ lactateThreshold: { heartRateBpm: 164, date: "2026-04-02" } }), 164);
  assert.equal(lthrFromPayload({ lactateThreshold: { heartRateBpm: null } }), null);
  assert.equal(parseDailyExport({ schemaVersion: 2, days: [] }), null);
  assert.deepEqual(garminDaySignals(null, null), {});
});

// --- sync and tools -------------------------------------------------------------------------------

test("when the latest-threshold endpoint is empty, the heart-rate threshold comes from the biometric anchors", async () => {
  const { deps, calls, cleanup } = await setup({}, {
    fail: (args) => {
      if (args[0] === "metrics" && args[1] === "lactate-threshold") return { ok: true, data: { speed_and_heart_rate: { heartRate: null } } };
      if (args[0] === "metrics" && args[1] === "anchors") return { ok: true, data: { lactateThreshold: { heartRateBpm: 164, date: "2026-04-02" } } };
      return null;
    },
  });
  try {
    const briefing = await dailyBriefing(deps, {});
    assert.equal(briefing.profile.lthr, 164);
    assert.equal(briefing.profile.lthrSource, "garmin");
    assert.ok(calls.some((args) => args[1] === "anchors"));
  } finally {
    await cleanup();
  }
});

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

test("journal tags are bounded per entry, after merging, and across the retained history", async () => {
  const { deps, cleanup } = await setup();
  try {
    const many = (prefix: string, count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, true]));
    // One oversized call is refused before any work is done.
    await assert.rejects(journalLog(deps, { tags: many("a", MAX_TAGS_PER_ENTRY + 1) }), ToolInputError);
    // Repeated small calls cannot grow one entry past the limit either.
    await journalLog(deps, { tags: many("a", MAX_TAGS_PER_ENTRY) });
    await assert.rejects(journalLog(deps, { tags: { one_more: true } }), ToolInputError);
    // Distinct tags across days are bounded too: fill the history, then a new tag is refused.
    let day = 1;
    for (let used = MAX_TAGS_PER_ENTRY; used < MAX_DISTINCT_TAGS; used += MAX_TAGS_PER_ENTRY) {
      await journalLog(deps, { date: addDays(TODAY, -day++), tags: many(`d${day}_`, Math.min(MAX_TAGS_PER_ENTRY, MAX_DISTINCT_TAGS - used)) });
    }
    await assert.rejects(journalLog(deps, { date: addDays(TODAY, -day), tags: { brand_new: true } }), ToolInputError);
    // Re-using a known tag name is still fine.
    await journalLog(deps, { date: addDays(TODAY, -day), tags: { a0: false } });
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

// --- charts ---------------------------------------------------------------------------------------

function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("briefing charts are rendered as PNG files at twice their display size, with private permissions", async () => {
  const { deps, dataDir, cleanup } = await setup();
  try {
    const result = await briefingCharts(deps, { lang: "fr" });
    assert.deepEqual(result.charts.map((chart) => chart.id), ["recovery_gauge", "ceiling", "signals", "hrv_trend", "load_curve", "sleep_nights", "cardiac_load", "muscular_load", "intensity"]);
    assert.deepEqual(result.skipped, []);
    for (const chart of result.charts) {
      assert.ok(chart.path.startsWith(path.join(dataDir, "charts", TODAY)));
      const bytes = await readFile(chart.path);
      assert.deepEqual(pngSize(bytes), { width: chart.displayWidth * 2, height: chart.displayHeight * 2 });
      assert.ok(bytes.length > 3000 && bytes.length < 400_000, `${chart.id}: ${bytes.length} bytes`);
      assert.equal((await stat(chart.path)).mode & 0o777, 0o600);
      assert.equal(chart.cid, `coach-${chart.id}`);
      assert.ok(chart.alt.length > 10);
    }
    assert.equal((await stat(path.join(dataDir, "charts", TODAY))).mode & 0o777, 0o700);
    if (process.env.COACH_CHART_PREVIEW) {
      await mkdir(process.env.COACH_CHART_PREVIEW, { recursive: true });
      for (const chart of result.charts) await copyFile(chart.path, path.join(process.env.COACH_CHART_PREVIEW, `${chart.id}.png`));
    }
  } finally {
    await cleanup();
  }
});

test("charts skip what has no data, reject bad input and prune old folders", async () => {
  const { deps, dataDir, cleanup } = await setup();
  try {
    await assert.rejects(briefingCharts(deps, { charts: ["../etc/passwd"] }), ToolInputError);
    await assert.rejects(briefingCharts(deps, { theme: "neon" }), ToolInputError);

    const old = path.join(dataDir, "charts", "2026-10-01");
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, "x.png"), "x");
    await mkdir(path.join(dataDir, "charts", "notes"), { recursive: true });
    await briefingCharts(deps, { charts: ["recovery_gauge"], theme: "dark" });
    assert.deepEqual((await readdir(path.join(dataDir, "charts"))).sort(), [TODAY, "notes"]);

    // No signal at all: the gauge still renders (n/a) but the signal rows have nothing to compare with.
    const empty = await setup({}, { fail: (args) => (args[0] === "daily" ? { ok: true, data: { schemaVersion: 1, days: [], errors: {} } } : null) });
    try {
      const result = await briefingCharts(empty.deps, {});
      assert.ok(result.skipped.some((entry) => entry.id === "hrv_trend"));
      assert.ok(result.skipped.some((entry) => entry.id === "sleep_nights"));
      assert.ok(result.charts.some((chart) => chart.id === "recovery_gauge"));
    } finally {
      await empty.cleanup();
    }
  } finally {
    await cleanup();
  }
});

// --- briefing e-mail ------------------------------------------------------------------------------

test("the briefing e-mail is built in code: subject, html, text and one inline image per chart", async () => {
  const { deps, cleanup } = await setup();
  try {
    const result = await briefingEmail(deps, { lang: "fr", headline: "Séance facile <b>aujourd'hui</b>.", why: ["VFC 7 j : 29 ms, ta plage normale : 31-34 ms"] });
    assert.match(result.subject, /^Briefing du dimanche 15 novembre : (Repos|Facile|Modéré|Intense)$/);
    assert.equal(result.inlineImages.length, 9, "Sunday adds the load curve to the 8 daily charts");
    for (const image of result.inlineImages) {
      assert.match(image.cid, /^coach-[a-z_]+$/);
      assert.equal(result.bodyHtml.split(`src="cid:${image.cid}"`).length, 2, `${image.cid} is referenced exactly once`);
      assert.ok((await stat(image.path)).isFile());
    }
    assert.ok(!result.bodyHtml.includes("<b>aujourd'hui"), "model text is escaped");
    assert.match(result.bodyHtml, /&lt;b&gt;aujourd&#39;hui&lt;\/b&gt;/);
    assert.ok(!/<script|https?:\/\/(?!www\.w3\.org)/i.test(result.bodyHtml.replace(/<img[^>]*>/g, "")), "no script and no external resource");
    assert.match(result.bodyHtml, /max-width:600px/);
    assert.match(result.bodyText, /Plafond du jour : /);
    assert.ok(!/No subjective|below the personal/.test(result.bodyHtml + result.bodyText), "no English default text in a French mail");
    assert.ok(result.notes.some((note) => note.startsWith("watch not supplied")));
    assert.match(result.bodyText, /Ce message est une aide à l'entraînement/);
    assert.ok(!/<(table|img|td|html)/i.test(result.bodyText), "plain text carries no layout markup");

    const weekday = await briefingEmail(deps, { date: addDays(TODAY, -1), sync: false, weekly: false });
    assert.equal(weekday.inlineImages.some((image) => image.cid === "coach-load_curve"), false);
    assert.ok(weekday.bodyText.length > 100 && weekday.subject.startsWith("Briefing for "), "falls back to the configured language and default texts");

    await assert.rejects(briefingEmail(deps, { why: ["a", "b", "c", "d"] }), ToolInputError);
    await assert.rejects(briefingEmail(deps, { headline: "x".repeat(300) }), ToolInputError);
    await assert.rejects(briefingEmail(deps, { lang: "de" }), ToolInputError);
  } finally {
    await cleanup();
  }
});

test("the e-mail layout copes with missing charts and missing figures", () => {
  const email = renderBriefingEmail({
    lang: "en",
    date: "2026-11-17",
    ceiling: "rest",
    headline: "Rest today.",
    why: [],
    watch: [],
    charts: [],
    sleep: null,
    sessions: [],
    load: null,
  });
  assert.equal(email.subject, "Briefing for Tuesday, November 17: Rest");
  assert.ok(!email.html.includes("<img"));
  assert.ok(!email.html.includes("<ul"));
  assert.match(email.html, /background:#64748b/);
  assert.match(email.html, /No session yesterday/);
  assert.match(email.text, /Sleep: n\/a/);
});

// --- native Garmin backend ------------------------------------------------------------------------

function fakeNative(overrides: Partial<NativeGarmin> = {}): NativeGarmin & { calls: string[] } {
  const calls: string[] = [];
  const api: NativeGarmin & { calls: string[] } = {
    calls,
    daily: async (options) => (calls.push(`daily ${options.start} ${options.end} ${options.detail}`), { days: [] }),
    activities: async (options) => (calls.push(`activities ${options.start} ${options.end}`), []),
    activity: async (id, view) => (calls.push(`activity ${id} ${view ?? "get"}`), { id }),
    metric: async (name, date) => (calls.push(`metric ${name} ${date}`), []),
    lactateThreshold: async () => (calls.push("lactate"), {}),
    anchors: async () => (calls.push("anchors"), { lactateThreshold: { heartRateBpm: 164 } }),
    ...overrides,
  };
  return api;
}

test("gc arguments map to native calls with the same meaning", async () => {
  const api = fakeNative();
  const run = nativeRunner(api);
  assert.deepEqual(await run(["daily", "--start", "2026-11-01", "--end", "2026-11-16", "--no-detail"]), { ok: true, data: { days: [] } });
  await run(["daily", "--start", "2026-11-16", "--end", "2026-11-16", "--detail"]);
  await run(["activities", "--start", "2026-10-01", "--end", "2026-11-16"]);
  await run(["activities", "get", "123"]);
  await run(["activities", "hr-zones", "123"]);
  await run(["activities", "exercise-sets", "123"]);
  await run(["metrics", "training-readiness", "2026-11-16"]);
  await run(["metrics", "training-status", "2026-11-16"]);
  await run(["metrics", "lactate-threshold"]);
  assert.deepEqual(await run(["metrics", "anchors"]), { ok: true, data: { lactateThreshold: { heartRateBpm: 164 } } });
  const old = await nativeRunner(fakeNative({ anchors: undefined }))(["metrics", "anchors"]);
  assert.equal(old.ok === false && old.code, "unsupported");
  assert.deepEqual(api.calls, [
    "daily 2026-11-01 2026-11-16 false", "daily 2026-11-16 2026-11-16 true", "activities 2026-10-01 2026-11-16",
    "activity 123 get", "activity 123 hr-zones", "activity 123 exercise-sets",
    "metric training-readiness 2026-11-16", "metric training-status 2026-11-16", "lactate", "anchors",
  ]);
});

test("native failures keep the stable codes, and unsupported or malformed commands are refused", async () => {
  const limited = nativeRunner(fakeNative({ daily: async () => Promise.reject(Object.assign(new Error("x"), { code: "rate_limited" })) }));
  assert.deepEqual(await limited(["daily", "--start", "2026-11-16"]), { ok: false, code: "rate_limited", message: (await limited(["daily", "--start", "2026-11-16"]) as { message: string }).message });
  const run = nativeRunner(fakeNative());
  for (const args of [["workouts", "create", "--name", "x"], ["activities", "get", "../1"], ["daily", "--start", "nope"], ["metrics", "training-status", "x"]]) {
    const result = await run(args);
    assert.equal(result.ok, false, args.join(" "));
    assert.equal((result as { code: string }).code, "unsupported");
  }
  assert.equal(isNativeCommand(["workouts", "create"]), false);
  assert.equal(isNativeCommand(["activities", "last"]), false);
});

test("the backend picks native when available, falls back to gc, and always sends writes to gc", async () => {
  const gcCalls: string[][] = [];
  const gc = (async (args: string[]) => (gcCalls.push(args), { ok: true, data: "gc" })) as GcRunner;
  const config = { gcBinary: "gc", garminBackend: "auto" as const, garminTokenFile: null };

  const native = fakeNative();
  const auto = createGarminRunner(config, { gc, load: async () => native });
  assert.equal((await auto(["daily", "--start", "2026-11-16"])).ok, true);
  assert.equal(native.calls.length, 1);
  assert.deepEqual(gcCalls, []);
  await auto(["workouts", "create", "--name", "x"]);
  assert.deepEqual(gcCalls, [["workouts", "create", "--name", "x"]]);

  gcCalls.length = 0;
  const missing = createGarminRunner(config, { gc, load: async () => "not_configured" });
  assert.deepEqual(await missing(["daily", "--start", "2026-11-16"]), { ok: true, data: "gc" });

  const strict = createGarminRunner({ ...config, garminBackend: "native" }, { gc, load: async () => "auth" });
  assert.equal((await strict(["daily", "--start", "2026-11-16"]) as { code: string }).code, "auth");

  let loads = 0;
  const once = createGarminRunner(config, { gc, load: async () => (loads += 1, native) });
  await once(["daily", "--start", "2026-11-16"]);
  await once(["daily", "--start", "2026-11-15"]);
  assert.equal(loads, 1, "the backend is chosen once");

  const forced = createGarminRunner({ ...config, garminBackend: "gc" }, { gc, load: async () => native });
  gcCalls.length = 0;
  await forced(["daily", "--start", "2026-11-16"]);
  assert.equal(gcCalls.length, 1);
});

test("configuration accepts only known backends", () => {
  assert.equal(parseConfig({}).garminBackend, "auto");
  assert.equal(parseConfig({ garminBackend: "native" }).garminBackend, "native");
  assert.equal(parseConfig({ garminBackend: "gc" }).garminBackend, "gc");
  assert.equal(parseConfig({ garminBackend: "other" }).garminBackend, "auto");
  assert.equal(parseConfig({ garminTokenFile: " /x/t.json " }).garminTokenFile, "/x/t.json");
});

// --- load balance, VO2 max trend and acclimation ----------------------------------------------------

const balancePayload = (aerobicLow: number) => ({
  metricsTrainingLoadBalanceDTOMap: {
    "1": { calendarDate: "2026-11-17", primaryTrainingDevice: false, monthlyLoadAerobicLow: 1, monthlyLoadAerobicHigh: 1, monthlyLoadAnaerobic: 1 },
    "2": {
      calendarDate: "2026-11-17", primaryTrainingDevice: true, trainingBalanceFeedbackPhrase: "AEROBIC_LOW_SHORTAGE",
      monthlyLoadAerobicLow: aerobicLow, monthlyLoadAerobicLowTargetMin: 200, monthlyLoadAerobicLowTargetMax: 400,
      monthlyLoadAerobicHigh: 300, monthlyLoadAerobicHighTargetMin: 200, monthlyLoadAerobicHighTargetMax: 400,
      monthlyLoadAnaerobic: 900, monthlyLoadAnaerobicTargetMin: 0, monthlyLoadAnaerobicTargetMax: 100,
    },
  },
});

test("the load balance reads the primary device and says where each category stands against Garmin's target", () => {
  const signal = loadBalanceSignal(balancePayload(115)) as { categories: Record<string, { load: number; status: string }>; phrase: string; date: string };
  assert.deepEqual(Object.fromEntries(Object.entries(signal.categories).map(([name, item]) => [name, [item.load, item.status]])), { aerobicLow: [115, "below"], aerobicHigh: [300, "within"], anaerobic: [900, "above"] });
  assert.equal(signal.phrase, "AEROBIC_LOW_SHORTAGE");
  assert.equal(loadBalanceSignal({}), null);
  assert.equal(loadBalanceSignal({ metricsTrainingLoadBalanceDTOMap: { "1": { calendarDate: "2026-11-17" } } }), null);
});

const maxmetPoint = (date: string, vo2: number, altitude: number, heat = 0, heatBefore = 0) => ({
  generic: { calendarDate: date, vo2MaxPreciseValue: vo2 },
  heatAltitudeAcclimation: { calendarDate: date, currentAltitude: altitude, altitudeAcclimation: 0, heatAcclimationPercentage: heat, previousHeatAcclimationPercentage: heatBefore },
});

test("the VO2 max trend only appears while the coach has little data of its own", () => {
  const series = [maxmetPoint("2026-10-01", 50.0, 20), maxmetPoint("2026-11-01", 51.0, 25), maxmetPoint("2026-11-16", 51.4, 20)];
  const early = maxmetSignals(series, 20) as { vo2maxTrend?: { change: number; points: number } };
  assert.equal(early.vo2maxTrend?.change, 1.4);
  assert.equal(early.vo2maxTrend?.points, 3);
  assert.equal("vo2maxTrend" in maxmetSignals(series, VO2_TREND_BELOW_DAYS), false);
  assert.equal("vo2maxTrend" in maxmetSignals([maxmetPoint("2026-11-16", 51, 20)], 5), false);
});

test("acclimation is reported only at altitude, away from the usual altitude, or while heat is being built", () => {
  const home = (altitude: number) => [maxmetPoint("2026-11-10", 50, 20), maxmetPoint("2026-11-13", 50, 25), maxmetPoint("2026-11-16", 50, altitude)];
  assert.equal("acclimation" in maxmetSignals(home(30), 99), false);
  assert.equal((maxmetSignals(home(1800), 99) as { acclimation: { reason: string } }).acclimation.reason, "at altitude");
  assert.equal((maxmetSignals(home(650), 99) as { acclimation: { reason: string } }).acclimation.reason, "away from the usual altitude");
  const warm = [maxmetPoint("2026-11-10", 50, 20), maxmetPoint("2026-11-16", 50, 20, 40, 30)];
  assert.equal((maxmetSignals(warm, 99) as { acclimation: { reason: string } }).acclimation.reason, "heat acclimation in progress");
  assert.equal("acclimation" in maxmetSignals([maxmetPoint("2026-11-16", 50, 20, 100, 100)], 99), false);
});

test("the native runner serves load balance and VO2 max history, and reports unsupported when the package is older", async () => {
  const calls: string[] = [];
  const api = { daily: async () => null, activities: async () => null, activity: async () => null, metric: async () => null, lactateThreshold: async () => null, loadBalance: async (date: string) => (calls.push(`lb ${date}`), { ok: 1 }), maxmet: async (a: string, b: string) => (calls.push(`mm ${a} ${b}`), []) } as NativeGarmin;
  assert.equal(isNativeCommand(["metrics", "load-balance", "2026-11-17"]), true);
  assert.deepEqual(await nativeRunner(api)(["metrics", "load-balance", "2026-11-17"]), { ok: true, data: { ok: 1 } });
  assert.deepEqual(await nativeRunner(api)(["metrics", "maxmet", "--start", "2026-09-18", "--end", "2026-11-17"]), { ok: true, data: [] });
  assert.deepEqual(calls, ["lb 2026-11-17", "mm 2026-09-18 2026-11-17"]);
  const old = { daily: async () => null, activities: async () => null, activity: async () => null, metric: async () => null, lactateThreshold: async () => null } as NativeGarmin;
  const result = await nativeRunner(old)(["metrics", "load-balance", "2026-11-17"]);
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, "unsupported");
});

// --- dashboard ---------------------------------------------------------------------------------------

test("the dashboard page shows the models, loads nothing, and the route only answers GET and HEAD", async () => {
  const { deps, cleanup } = await setup();
  try {
    const html = await renderDashboard(deps);
    if (process.env.COACH_DASHBOARD_PREVIEW) await writeFile(process.env.COACH_DASHBOARD_PREVIEW, html);
    assert.ok(html.startsWith("<!doctype html>"));
    for (const word of ["Cardiac load", "Muscular load", "Intensity minutes", "Recovery"]) assert.ok(html.includes(word), word);
    assert.ok(!/<script/i.test(html), "no script");
    assert.ok(!/(src|href)="https?:/i.test(html), "no external resource");

    const respond = async (method: string) => {
      const headers: Record<string, string> = {};
      let body: string | undefined;
      const res = { statusCode: 0, setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v), end: (chunk?: string) => void (body = chunk) };
      const handled = await dashboardHandler(deps)({ method } as never, res as never);
      return { handled, status: res.statusCode, headers, body };
    };
    const get = await respond("GET");
    assert.equal(get.status, 200);
    assert.ok(get.headers["content-security-policy"]?.includes("default-src 'none'"));
    assert.ok(get.body?.includes("Cardiac load"));
    const head = await respond("HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, undefined);
    const post = await respond("POST");
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "GET, HEAD");
  } finally {
    await cleanup();
  }
});

// --- replies to the briefing e-mail, through the briefing ----------------------------------------------

test("a reply to the briefing e-mail reaches the next briefing once, then stays as recent context and in the journal", async () => {
  const mail = { mailReplies: "briefing", mailAccount: "coach@example.org", mailAllowedFrom: ["me@example.org"] };
  const { deps, cleanup } = await setup(mail);
  try {
    const gogCalls: string[][] = [];
    deps.gog = async (args) => {
      gogCalls.push(args);
      return { ok: true, stdout: JSON.stringify({ messages: [{ id: "msg-abc1", from: "Me <me@example.org>", subject: "Re: Briefing", internalDateIso: "2026-11-15T07:30:00Z", labels: ["INBOX"], body: "Sore calves, good mood.\n\n> Tell me how you feel" }] }) };
    };
    const first = await dailyBriefing(deps, { sync: false });
    const replies = (first as unknown as { athleteReplies?: { new: Array<{ text: string }>; recent: unknown[]; note: string } }).athleteReplies;
    assert.deepEqual(replies?.new.map((reply) => reply.text), ["Sore calves, good mood."]);
    assert.match(replies?.note ?? "", /never instructions/);
    assert.match(first.journal?.notes ?? "", /\[mail\] Sore calves, good mood\./);

    const second = await dailyBriefing(deps, { sync: false });
    const again = (second as unknown as { athleteReplies?: { new: unknown[]; recent: Array<{ text: string }> } }).athleteReplies;
    assert.equal(again?.new.length, 0);
    assert.equal(again?.recent[0]?.text, "Sore calves, good mood.");

    // Displaying callers do not consume replies.
    const quiet = await dailyBriefing(deps, { sync: false, replies: false });
    assert.equal("athleteReplies" in quiet, false);
    assert.ok(gogCalls.length >= 2);
  } finally {
    await cleanup();
  }
});

test("without mail settings the briefing never starts gog, and the sync tool explains what is missing", async () => {
  const { deps, cleanup } = await setup();
  try {
    let started = false;
    deps.gog = async () => ((started = true), { ok: true, stdout: "{}" });
    const briefing = await dailyBriefing(deps, { sync: false });
    assert.equal(started, false);
    assert.equal("athleteReplies" in briefing, false);
    await assert.rejects(inboxSync(deps, {}), ToolInputError);
  } finally {
    await cleanup();
  }
});

test("the briefing e-mail summary lists the cardiac and muscular load status and the intensity minutes", async () => {
  const { deps, cleanup } = await setup();
  try {
    const fr = await briefingEmail(deps, { lang: "fr" });
    assert.match(fr.bodyText, /Charge cardiaque/);
    assert.match(fr.bodyText, /plage optimale/);
    const en = await briefingEmail(deps, { lang: "en", sync: false });
    assert.match(en.bodyText, /Cardiac load/);
  } finally {
    await cleanup();
  }
});
