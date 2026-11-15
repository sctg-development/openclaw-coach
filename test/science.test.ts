import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, dateRange } from "../src/dates.ts";
import { habitAssociations } from "../src/science/associations.ts";
import { analyzeHrv } from "../src/science/hrv.ts";
import { analyzeLoad, banisterPerMinute, dailyLoads, fitnessFatigue, intensityDistribution, plannedSessionLoad, projectLoads, sessionLoad } from "../src/science/load.ts";
import { aerobicDecoupling, hrMaxFromAge, minettiCost, predictTimeFromVdot, riegel, trainingPaces, vdot, zonesFromLthr, zonesFromReserve } from "../src/science/performance.ts";
import { decideReadiness } from "../src/science/readiness.ts";
import { analyzeRecovery, analyzeWarning } from "../src/science/recovery.ts";
import { analyzeSleep, sleepDebtHours } from "../src/science/sleep.ts";
import { benjaminiHochberg, ewma, hedgesG, normalCdf, permutationP, robustBaseline, seededRandom } from "../src/science/stats.ts";
import { estimated1Rm, parseExerciseSets, summarizeStrength } from "../src/science/strength.ts";
import type { JournalEntry } from "../src/types.ts";
import { PROFILE, TODAY, gaussian, makeActivity, makeDay, makeHistory } from "./helpers.ts";

const close = (actual: number | null, expected: number, tolerance: number) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

// --- statistics -----------------------------------------------------------------------------------

test("normal distribution and exponential average match reference values", () => {
  close(normalCdf(0), 0.5, 1e-7);
  close(normalCdf(1.96), 0.975, 1e-4);
  close(normalCdf(-1), 0.158655, 1e-5);
  // A constant input keeps the average at that value whatever the time constant.
  assert.deepEqual(ewma([50, 50, 50], 42, 50), [50, 50, 50]);
  // After one time constant, a step input is 63.2 % absorbed.
  close(ewma(new Array(42).fill(100), 42, 0)[41], 63.2, 0.1);
});

test("a robust baseline ignores a few outlier nights and never has a zero scale", () => {
  const values = [48, 48, 48, 49, 48, 47, 48, 48, 48, 48, 48, 48, 48, 48, 75, 80];
  const baseline = robustBaseline(values, 1, 14);
  assert.equal(baseline?.center, 48);
  assert.ok((baseline?.scale ?? 0) >= 1 && (baseline?.scale ?? 99) < 3);
  assert.equal(robustBaseline([48, 49], 1, 14), null);
  assert.equal(robustBaseline([null, undefined, 48], 1, 2), null);
});

test("permutation test, effect size and false-discovery adjustment behave as defined", () => {
  const a = [10, 11, 12, 10, 11, 12, 10, 11];
  const b = [20, 21, 22, 20, 21, 22, 20, 21];
  assert.ok((permutationP(a, b) as number) < 0.01);
  assert.ok((permutationP(a, a) as number) > 0.9);
  assert.ok((hedgesG(a, b) as number) < -5);
  assert.deepEqual(benjaminiHochberg([0.01, 0.04, 0.03]), [0.03, 0.04, 0.04]);
});

// --- HRV ------------------------------------------------------------------------------------------

test("a stable HRV history gives a ready baseline and a trend inside the normal range", () => {
  const result = analyzeHrv(makeHistory(75, TODAY, (fromEnd) => (fromEnd < 7 ? { hrvMs: [58, 61, 60, 63, 59, 60, 62][fromEnd] } : null)));
  assert.equal(result.status, "ready");
  assert.equal(result.trend, "within");
  assert.equal(result.daysBelow, 0);
  assert.ok(result.baseline && result.baseline.lowMs < 60 && result.baseline.highMs > 60);
  assert.ok(result.baseline.nights >= 55);
  close(result.cv7Pct, 0.7, 0.3); // CV of ln rMSSD is much smaller than the CV of rMSSD
});

test("a week of suppressed HRV is flagged below the normal range, one bad night is not", () => {
  const week = analyzeHrv(makeHistory(75, TODAY, (fromEnd) => (fromEnd < 7 ? { hrvMs: 45 } : null)));
  assert.equal(week.trend, "below");
  assert.ok(week.daysBelow >= 3);
  assert.ok((week.weekChangePct as number) < -15);

  const night = analyzeHrv(makeHistory(75, TODAY, (fromEnd) => (fromEnd === 0 ? { hrvMs: 40 } : null)));
  assert.equal(night.trend, "within");
  assert.ok((night.acuteZ as number) < -2);
});

test("HRV stays in calibration until 14 baseline nights exist, and missing nights are not zeros", () => {
  assert.equal(analyzeHrv(makeHistory(10)).status, "calibrating");
  const sparse = analyzeHrv(makeHistory(75, TODAY, (fromEnd) => (fromEnd < 7 && fromEnd !== 3 ? { hrvMs: null } : null)));
  assert.equal(sparse.nightsInTrend, 1);
  assert.equal(sparse.trend, null);
  assert.equal(sparse.status, "insufficient_data");
  assert.equal(analyzeHrv([]).status, "insufficient_data");
});

// --- sleep ----------------------------------------------------------------------------------------

test("sleep debt is a running balance: deficits add up, surplus repays, missing nights are skipped", () => {
  const days = dateRange(addDays(TODAY, -4), TODAY).map((date, index) => makeDay(date, { sleepH: [6, 6, null, 9, 7][index] }));
  // (8-6) + (8-6) = 4, skip, 4 - 1 = 3, 3 + 1 = 4
  assert.deepEqual(sleepDebtHours(days, PROFILE), { debtH: 4, nights: 4 });
  const banked = dateRange(addDays(TODAY, -3), TODAY).map((date, index) => makeDay(date, { sleepH: [10, 10, 10, 7][index] }));
  // Extra sleep before a deficit cannot be banked below zero.
  assert.equal(sleepDebtHours(banked, PROFILE).debtH, 1);
});

test("sleep regularity index is 100 for identical nights and drops with shifted bedtimes", () => {
  const regular = analyzeSleep(dateRange(addDays(TODAY, -13), TODAY).map((date) => makeDay(date)), PROFILE);
  assert.equal(regular.regularity?.sri, 100);
  assert.equal(regular.regularity?.onsetSdMin, 0);
  assert.equal(regular.regularity?.meanBedtime, "23:00");

  const irregular = analyzeSleep(dateRange(addDays(TODAY, -13), TODAY).map((date, index) => makeDay(date, { bedtime: index % 2 ? "01:30" : "22:00" })), PROFILE);
  assert.ok((irregular.regularity?.sri as number) < 60);
  assert.ok((irregular.regularity?.onsetSdMin as number) > 100);
  assert.ok(irregular.notes.some((note) => note.includes("irregular")));
});

test("last night is described against the need, with Garmin's need when it is plausible", () => {
  const day = makeDay(TODAY, { sleepH: 6 });
  const own = analyzeSleep([day], PROFILE).lastNight;
  assert.equal(own?.sufficiency, 0.75);
  assert.equal(own?.needSource, "profile");
  assert.equal(own?.efficiencyPct, 95);

  if (day.sleep) day.sleep.needS = 9 * 3600;
  assert.equal(analyzeSleep([day], PROFILE).lastNight?.needSource, "garmin");
  if (day.sleep) day.sleep.needS = 480; // minutes mistaken for seconds: rejected
  assert.equal(analyzeSleep([day], PROFILE).lastNight?.needSource, "profile");
  assert.equal(analyzeSleep([makeDay(TODAY, { sleepH: null })], PROFILE).lastNight, null);
});

// --- training load --------------------------------------------------------------------------------

test("Banister TRIMP matches the published formula", () => {
  // 60 min at 70 % of heart-rate reserve, male: 60 x 0.7 x 0.64 x exp(1.92 x 0.7) = 103.1
  close(60 * banisterPerMinute(0.7, "male"), 103.1, 0.1);
  close(60 * banisterPerMinute(0.7, "female"), 60 * 0.7 * 0.86 * Math.exp(1.67 * 0.7), 1e-9);
  assert.equal(banisterPerMinute(-0.2, "male"), 0);

  const steady = makeActivity(TODAY, { hrZonesS: null, avgHr: 141 }); // (141-50)/130 = 0.7
  assert.deepEqual(sessionLoad(steady, PROFILE), { trimp: 103.1, method: "mean-hr", edwards: null, garmin: 110 });
});

test("zone-based load weights hard minutes more than the mean heart rate does", () => {
  const intervals = makeActivity(TODAY, { hrZonesS: [900, 900, 0, 0, 1800], avgHr: 141 });
  const zoned = sessionLoad(intervals, PROFILE);
  assert.equal(zoned.method, "zones");
  assert.equal(zoned.edwards, 15 * 1 + 15 * 2 + 30 * 5);
  assert.ok((zoned.trimp as number) > 103.1 * 1.2);
  assert.equal(sessionLoad(intervals, { ...PROFILE, hrMax: null }).trimp, null);
  assert.equal(plannedSessionLoad(60, 2, PROFILE), sessionLoad(makeActivity(TODAY, { hrZonesS: [0, 3600, 0, 0, 0] }), PROFILE).trimp);
});

test("fitness and fatigue converge to a constant load, and a taper raises form", () => {
  const loads = dateRange(addDays(TODAY, -119), TODAY).map((date) => ({ date, load: 80 }));
  const curve = fitnessFatigue(loads);
  const last = curve[curve.length - 1];
  assert.deepEqual([last.ctl, last.atl, last.tsb], [80, 80, 0]);

  const taper = projectLoads(last, dateRange(addDays(TODAY, 1), addDays(TODAY, 10)).map((date) => ({ date, load: 20 })));
  const end = taper[taper.length - 1];
  assert.ok(end.tsb > 15, `form after taper ${end.tsb}`);
  assert.ok(end.ctl > 60 && end.ctl < 80);
  assert.ok(end.atl < end.ctl);
});

test("load analysis flags a spike and monotony, and reports unscored sessions", () => {
  const start = addDays(TODAY, -99);
  const base = dateRange(start, addDays(TODAY, -7)).filter((_, index) => index % 2 === 0).map((date) => makeActivity(date));
  const spike = dateRange(addDays(TODAY, -6), TODAY).map((date) => makeActivity(date, { durationS: 7200, hrZonesS: [0, 3600, 3600, 0, 0] }));
  const noHr = makeActivity(addDays(TODAY, -3), { id: "9", hrZonesS: null, avgHr: null });
  const activities = [...base, ...spike, noHr];
  const result = analyzeLoad(dailyLoads(activities, PROFILE, start, TODAY), activities, PROFILE);

  assert.equal(result.status, "ready");
  assert.ok((result.acuteChronicRatio as number) > 1.5);
  assert.ok(result.flags.includes("load_spike"));
  assert.ok(result.flags.includes("high_monotony")); // seven identical days
  assert.equal(result.unscoredSessions28, 1);
  assert.equal(result.restDays7, 0);
  assert.ok((result.today?.tsb as number) < 0);
});

test("load analysis says so when anchors or history are missing", () => {
  const activities = [makeActivity(TODAY)];
  const short = analyzeLoad(dailyLoads(activities, PROFILE, addDays(TODAY, -9), TODAY), activities, PROFILE);
  assert.equal(short.status, "insufficient_data");
  const blind = { ...PROFILE, hrMax: null, sex: null };
  const result = analyzeLoad(dailyLoads(activities, blind, addDays(TODAY, -99), TODAY), activities, blind);
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.notes.length >= 2, true);
});

test("intensity distribution groups zones and computes the polarization index", () => {
  const polarized = intensityDistribution([makeActivity(TODAY, { hrZonesS: [3000, 4000, 1000, 400, 1600] })]);
  assert.deepEqual([polarized?.lowPct, polarized?.moderatePct, polarized?.highPct], [80, 4, 16]);
  // log10(0.8 / 0.04 x 0.16 x 100) = 2.51
  close(polarized?.polarizationIndex ?? null, 2.51, 0.01);
  assert.equal(intensityDistribution([makeActivity(TODAY, { hrZonesS: [3000, 3000, 0, 0, 0] })])?.polarizationIndex, 0);
  assert.equal(intensityDistribution([makeActivity(TODAY, { hrZonesS: null })]), null);
});

// --- recovery, early warning, decision ------------------------------------------------------------

test("a typical night scores near 50 and a clearly bad night falls in the low band", () => {
  const typical = analyzeRecovery(makeHistory(75, TODAY, (fromEnd) => (fromEnd === 0 ? { hrvMs: 60, restingHr: 48, sleepH: 8, respiration: 13.5, skinTemp: 0 } : null)), PROFILE);
  assert.equal(typical.status, "ready");
  assert.ok((typical.score as number) >= 40 && (typical.score as number) <= 65, `typical score ${typical.score}`);
  assert.equal(typical.coverage, 1);

  const bad = analyzeRecovery(makeHistory(75, TODAY, (fromEnd) => (fromEnd === 0 ? { hrvMs: 38, restingHr: 56, sleepH: 5 } : null)), PROFILE);
  assert.equal(bad.band, "low");
  assert.ok((bad.score as number) < 10);
  assert.ok(bad.components.hrv.z < -2 && bad.components.restingHr.z < -2 && bad.components.sleep.z < -2);
});

test("recovery degrades gracefully: no HRV still scores, no cardiac signal does not", () => {
  const noHrv = analyzeRecovery(makeHistory(75, TODAY, (fromEnd) => (fromEnd === 0 ? { hrvMs: null } : null)), PROFILE);
  assert.ok(noHrv.score !== null && !("hrv" in noHrv.components));
  assert.ok(noHrv.coverage < 1);
  const none = analyzeRecovery(makeHistory(75, TODAY, (fromEnd) => (fromEnd === 0 ? { hrvMs: null, restingHr: null } : null)), PROFILE);
  assert.equal(none.score, null);
  assert.equal(analyzeRecovery(makeHistory(5), PROFILE).status, "calibrating");
});

test("early warning needs two concordant signals, and notes when they persist", () => {
  const calm = (fromEnd: number) => (fromEnd <= 1 ? { restingHr: 48, hrvMs: 60, respiration: 13.5, skinTemp: 0 } : null);
  assert.equal(analyzeWarning(makeHistory(75, TODAY, calm)).level, "none");
  const one = analyzeWarning(makeHistory(75, TODAY, (fromEnd) => (fromEnd === 0 ? { ...calm(0), restingHr: 57 } : null)));
  assert.equal(one.level, "watch");
  const alone = decide(makeHistory(75, TODAY, (fromEnd) => (fromEnd === 0 ? { ...calm(0), sleepH: 8, skinTemp: 1.2 } : null)));
  assert.equal(alone.ceiling, "hard"); // one signal alone is reported, it does not cap the day
  assert.ok(alone.caveats.some((text) => text.includes("skin temperature")));
  const sick = (fromEnd: number) => (fromEnd <= 1 ? { restingHr: 58, hrvMs: 36, respiration: 16, skinTemp: 1.1 } : null);
  const two = analyzeWarning(makeHistory(75, TODAY, sick));
  assert.equal(two.level, "elevated");
  assert.equal(two.signals.length, 4);
  assert.equal(two.persistent, true);
  assert.ok(two.confounders.length > 0);
  assert.equal(analyzeWarning(makeHistory(5)).status, "insufficient_data");
});

function decide(days: ReturnType<typeof makeHistory>, journal: JournalEntry | null = null) {
  const start = addDays(TODAY, -99);
  const activities = dateRange(start, TODAY).filter((_, index) => index % 2 === 0).map((date) => makeActivity(date));
  return decideReadiness({
    hrv: analyzeHrv(days),
    recovery: analyzeRecovery(days, PROFILE),
    warning: analyzeWarning(days),
    sleep: analyzeSleep(days, PROFILE),
    load: analyzeLoad(dailyLoads(activities, PROFILE, start, TODAY), activities, PROFILE),
    journal,
  });
}

test("the decision allows a hard day only when no rule argues against it", () => {
  const fine = decide(makeHistory(75, TODAY, (fromEnd) => (fromEnd === 0 ? { hrvMs: 62, restingHr: 48, sleepH: 8 } : null)));
  assert.equal(fine.ceiling, "hard");
  assert.equal(fine.reasons.length, 0);
  assert.ok(fine.suggestedLoad && fine.suggestedLoad.max > fine.suggestedLoad.min);
  assert.ok(fine.caveats.some((text) => text.includes("subjective")));

  const suppressed = decide(makeHistory(75, TODAY, (fromEnd) => (fromEnd < 7 ? { hrvMs: 45 } : null)));
  assert.equal(suppressed.ceiling, "easy");
  assert.ok(suppressed.reasons.some((reason) => reason.rule === "hrv-guided"));

  const shortNight = decide(makeHistory(75, TODAY, (fromEnd) => (fromEnd === 0 ? { hrvMs: 62, restingHr: 48, sleepH: 5.5 } : null)));
  assert.equal(shortNight.ceiling, "moderate");
});

test("reported symptoms and a persistent warning both lead to rest", () => {
  const journal: JournalEntry = { date: TODAY, tags: {}, symptoms: ["sore throat"], updatedAt: "" };
  assert.equal(decide(makeHistory(75), journal).ceiling, "rest");
  assert.ok(decide(makeHistory(75), journal).reasons.some((reason) => reason.rule === "symptoms"));
  const sick = decide(makeHistory(75, TODAY, (fromEnd) => (fromEnd <= 1 ? { restingHr: 58, hrvMs: 36, respiration: 16 } : null)));
  assert.equal(sick.ceiling, "rest");
  assert.equal(decide(makeHistory(8)).confidence, "low");
});

// --- performance ----------------------------------------------------------------------------------

test("VDOT, training paces and race equivalences match Daniels' tables", () => {
  close(vdot(5000, 20 * 60), 49.8, 0.2);
  close(vdot(42195, 3 * 3600), 53.5, 0.3);
  assert.equal(vdot(5000, 60), null);
  const paces = trainingPaces(50);
  close(paces.threshold, 255, 4); // 4:15/km
  close(paces.interval, 236, 5); // about 3:55/km
  assert.ok(paces.easy.slow > paces.easy.fast && paces.easy.fast > paces.marathon);
  close(predictTimeFromVdot(vdot(5000, 1200) as number, 5000), 1200, 1);
  close(predictTimeFromVdot(49.8, 10000), 41 * 60 + 27, 15);
  assert.equal(riegel(1200, 5000, 10000), 2502);
});

test("heart-rate anchors and zones", () => {
  assert.equal(hrMaxFromAge(50), 173);
  assert.deepEqual(zonesFromReserve(180, 50).map((zone) => zone.lowBpm), [115, 128, 141, 154, 167]);
  const lthr = zonesFromLthr(160, 180);
  assert.deepEqual([lthr[1].lowBpm, lthr[3].lowBpm, lthr[4].lowBpm, lthr[4].highBpm], [136, 152, 160, 180]);
});

test("gradient cost follows Minetti's curve and decoupling measures heart-rate drift", () => {
  assert.equal(minettiCost(0), 3.6);
  close(minettiCost(0.1), 5.97, 0.02);
  assert.ok(minettiCost(-0.1) < minettiCost(0));
  assert.ok(minettiCost(-0.4) > minettiCost(-0.2)); // steep descents cost more again

  const lap = (hr: number) => ({ durationS: 600, distanceM: 2000, avgHr: hr, elevGainM: 0, elevLossM: 0, gapSpeedMs: null });
  const drift = aerobicDecoupling([lap(140), lap(140), lap(140), lap(147), lap(147), lap(147)]);
  close(drift?.decouplingPct ?? null, 4.8, 0.1); // 1 - 140/147
  assert.equal(drift?.gradeAdjusted, true);
  assert.equal(aerobicDecoupling([lap(140), lap(140)]), null); // too short
});

// --- strength -------------------------------------------------------------------------------------

test("strength summary reads Garmin sets in grams and estimates 1RM only up to 10 reps", () => {
  assert.equal(estimated1Rm(100, 5), 114.6); // Epley 116.7, Brzycki 112.5
  assert.equal(estimated1Rm(100, 1), 100);
  assert.equal(estimated1Rm(60, 15), null);
  const sets = parseExerciseSets({
    exerciseSets: [
      { setType: "ACTIVE", repetitionCount: 5, weight: 100000, duration: 30, exercises: [{ category: "SQUAT", name: "BACK_SQUAT" }] },
      { setType: "REST", duration: 120 },
      { setType: "ACTIVE", repetitionCount: 8, weight: 80000, exercises: [{ category: "SQUAT", name: "BACK_SQUAT" }] },
      { setType: "ACTIVE", repetitionCount: 12, weight: -1, exercises: [] },
    ],
  });
  const summary = summarizeStrength(sets);
  assert.equal(summary.totalSets, 3);
  assert.equal(summary.totalVolumeKg, 500 + 640);
  assert.equal(summary.exercises[0].estimated1RmKg, 114.6);
  assert.deepEqual(summary.exercises[0].topSet, { weightKg: 100, reps: 5 });
  assert.deepEqual(summary.setsByMuscleGroup, { "quadriceps and glutes": 2 });
  assert.equal(summary.unidentifiedSets, 1);
  assert.deepEqual(parseExerciseSets(null), []);
});

// --- journal associations -------------------------------------------------------------------------

test("a habit followed by lower HRV is reported as a consistent difference, a random tag is not", () => {
  const random = seededRandom(11);
  const dates = dateRange(addDays(TODAY, -59), addDays(TODAY, -1));
  const journal: JournalEntry[] = dates.map((date, index) => ({ date, tags: { alcohol: index % 3 === 0, coin_flip: random() < 0.5 }, updatedAt: "" }));
  const drinking = new Set(journal.filter((entry) => entry.tags.alcohol).map((entry) => addDays(entry.date, 1)));
  const noise = seededRandom(5);
  const days = dateRange(addDays(TODAY, -59), TODAY).map((date) =>
    makeDay(date, { hrvMs: Math.round((drinking.has(date) ? 48 : 60) * Math.exp(0.06 * gaussian(noise))), restingHr: Math.round(48 + 1.5 * gaussian(noise)) }),
  );
  const report = habitAssociations(days, journal);
  const find = (tag: string, outcome: string) => report.associations.find((item) => item.tag === tag && item.outcome === outcome);

  const alcohol = find("alcohol", "overnight HRV");
  assert.equal(alcohol?.reading, "consistent difference");
  close(alcohol?.difference ?? null, -20, 5);
  assert.ok(alcohol?.ci95 && alcohol.ci95[1] < 0);
  assert.equal(alcohol?.nightsWith, 20);
  assert.equal(find("coin_flip", "overnight HRV")?.reading, "no clear difference");
  assert.ok(report.caveats[0].includes("does not show"));
});

test("habits logged too rarely are listed as insufficient instead of compared", () => {
  const dates = dateRange(addDays(TODAY, -20), addDays(TODAY, -1));
  const journal: JournalEntry[] = dates.map((date, index) => ({ date, tags: { sauna: index < 3 }, updatedAt: "" }));
  const report = habitAssociations(makeHistory(30), journal);
  assert.deepEqual(report.associations, []);
  assert.deepEqual(report.insufficient, [{ tag: "sauna", daysWith: 3, daysWithout: 17 }]);
});
