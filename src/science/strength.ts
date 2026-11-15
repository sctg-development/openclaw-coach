/**
 * Strength sessions: volume load, estimated one-repetition maximum, weekly sets
 * per muscle group.
 *
 * Deliberately descriptive. There is no "muscle freshness" score: no published
 * model predicts local muscular recovery from sets and reps alone, and the watch
 * records neither proximity to failure nor exercise technique.
 */

import type { AlgorithmTag } from "../types.ts";
import { isNum, round } from "./stats.ts";

export const STRENGTH_ALGORITHM: AlgorithmTag = {
  id: "strength-summary",
  version: "1.0.0",
  refs: ["epley1985", "brzycki1993", "schoenfeld2017", "acsm2009"],
};

/** Epley (1985): 1RM = w x (1 + reps / 30). */
export function epley1Rm(weightKg: number, reps: number): number {
  return reps <= 1 ? weightKg : weightKg * (1 + reps / 30);
}

/** Brzycki (1993): 1RM = w x 36 / (37 - reps). */
export function brzycki1Rm(weightKg: number, reps: number): number {
  return reps <= 1 ? weightKg : (weightKg * 36) / (37 - reps);
}

/** Mean of both formulas; null above 10 repetitions, where they stop being accurate. */
export function estimated1Rm(weightKg: number, reps: number): number | null {
  if (!(weightKg > 0) || !(reps >= 1) || reps > 10) return null;
  return round((epley1Rm(weightKg, reps) + brzycki1Rm(weightKg, reps)) / 2, 1);
}

/** Coarse mapping from Garmin exercise categories to the main muscle group trained. */
const MUSCLE_GROUP: Record<string, string> = {
  BENCH_PRESS: "chest",
  PUSH_UP: "chest",
  FLYE: "chest",
  ROW: "back",
  PULL_UP: "back",
  LAT_PULLDOWN: "back",
  HYPEREXTENSION: "lower back",
  DEADLIFT: "posterior chain",
  SHOULDER_PRESS: "shoulders",
  LATERAL_RAISE: "shoulders",
  SHRUG: "shoulders",
  CURL: "biceps",
  TRICEPS_EXTENSION: "triceps",
  SQUAT: "quadriceps and glutes",
  LUNGE: "quadriceps and glutes",
  LEG_PRESS: "quadriceps and glutes",
  HIP_RAISE: "glutes",
  LEG_CURL: "hamstrings",
  CALF_RAISE: "calves",
  PLANK: "core",
  CRUNCH: "core",
  SIT_UP: "core",
  CORE: "core",
  LEG_RAISE: "core",
};

export type StrengthSet = { category: string | null; name: string | null; reps: number | null; weightKg: number | null; durationS: number | null };

export type ExerciseSummary = {
  exercise: string;
  muscleGroup: string | null;
  sets: number;
  reps: number;
  volumeKg: number | null;
  topSet: { weightKg: number; reps: number } | null;
  estimated1RmKg: number | null;
};

/**
 * Reads Garmin's exercise-set payload. Garmin stores weights in grams; rest sets
 * and sets without repetitions are skipped.
 */
export function parseExerciseSets(payload: unknown): StrengthSet[] {
  const list = (payload as { exerciseSets?: unknown })?.exerciseSets;
  if (!Array.isArray(list)) return [];
  const out: StrengthSet[] = [];
  for (const raw of list as Array<Record<string, unknown>>) {
    if (raw?.setType !== "ACTIVE") continue;
    const exercises = Array.isArray(raw.exercises) ? (raw.exercises as Array<Record<string, unknown>>) : [];
    const best = exercises[0];
    const grams = raw.weight;
    out.push({
      category: typeof best?.category === "string" ? best.category : null,
      name: typeof best?.name === "string" ? best.name : null,
      reps: isNum(raw.repetitionCount) && raw.repetitionCount > 0 ? raw.repetitionCount : null,
      weightKg: isNum(grams) && grams > 0 ? round(grams / 1000, 2) : null,
      durationS: isNum(raw.duration) ? round(raw.duration, 0) : null,
    });
  }
  return out;
}

export function summarizeStrength(sets: readonly StrengthSet[]): {
  exercises: ExerciseSummary[];
  totalSets: number;
  totalVolumeKg: number | null;
  setsByMuscleGroup: Record<string, number>;
  unidentifiedSets: number;
} {
  const byExercise = new Map<string, ExerciseSummary>();
  const setsByMuscleGroup: Record<string, number> = {};
  let totalVolume = 0;
  let hasVolume = false;
  let unidentified = 0;
  for (const set of sets) {
    const key = set.name ?? set.category ?? "UNKNOWN";
    if (key === "UNKNOWN") unidentified += 1;
    const group = set.category ? (MUSCLE_GROUP[set.category] ?? null) : null;
    if (group) setsByMuscleGroup[group] = (setsByMuscleGroup[group] ?? 0) + 1;
    let summary = byExercise.get(key);
    if (!summary) {
      summary = { exercise: key, muscleGroup: group, sets: 0, reps: 0, volumeKg: null, topSet: null, estimated1RmKg: null };
      byExercise.set(key, summary);
    }
    summary.sets += 1;
    summary.reps += set.reps ?? 0;
    if (isNum(set.reps) && isNum(set.weightKg)) {
      const volume = set.reps * set.weightKg;
      summary.volumeKg = round((summary.volumeKg ?? 0) + volume, 0);
      totalVolume += volume;
      hasVolume = true;
      const estimate = estimated1Rm(set.weightKg, set.reps);
      if (estimate !== null && (summary.estimated1RmKg === null || estimate > summary.estimated1RmKg)) {
        summary.estimated1RmKg = estimate;
        summary.topSet = { weightKg: set.weightKg, reps: set.reps };
      }
    }
  }
  return {
    exercises: [...byExercise.values()],
    totalSets: sets.length,
    totalVolumeKg: hasVolume ? round(totalVolume, 0) : null,
    setsByMuscleGroup,
    unidentifiedSets: unidentified,
  };
}
