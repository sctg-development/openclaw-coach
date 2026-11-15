import { Type, type TSchema } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseConfig } from "./config.ts";
import { createGcRunner } from "./garmin/gc.ts";
import {
  ToolInputError,
  activityDeepDive,
  dailyBriefing,
  dataStatus,
  journalInsights,
  journalLog,
  strengthAnalysis,
  trainingLoad,
  trends,
  workoutPush,
  zonesAndPaces,
  type Deps,
} from "./tools.ts";

const DateParam = Type.Optional(Type.String({ description: "YYYY-MM-DD, 'today' or 'yesterday'. Default: today in the configured timezone." }));
const SyncParam = Type.Optional(Type.Boolean({ description: "Fetch new data from Garmin first (default true). Pass false to reuse the local store." }));
const ActivityIdParam = Type.String({ pattern: "^[0-9]{1,20}$", description: "Garmin activity id, as listed by coach_daily_briefing or coach_training_load." });
const Rating = (label: string) => Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: `${label}: 1 = worst, 5 = best.` }));

type Tool = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  run: (deps: Deps, params: never) => Promise<unknown>;
  summary: (result: never) => string;
};

const TOOLS: Tool[] = [
  {
    name: "coach_daily_briefing",
    label: "Coach Daily Briefing",
    description:
      "Daily physiological assessment from Garmin data, computed with documented models against the athlete's own baselines: " +
      "training ceiling for the day (rest/easy/moderate/hard) with its reasons, recovery index, HRV trend versus personal normal range, " +
      "sleep sufficiency/debt/regularity, early-warning flags (possible illness or strain), training load (fitness, fatigue, form) and " +
      "yesterday's sessions. Start every check-in with this tool. Every block carries a status (ready/calibrating/insufficient_data).",
    parameters: Type.Object({ date: DateParam, sync: SyncParam }),
    run: dailyBriefing as Tool["run"],
    summary: (r: { date: string; readiness: { ceiling: string; confidence: string }; recovery: { score: number | null } }) =>
      `Briefing ${r.date}: ceiling "${r.readiness.ceiling}" (confidence ${r.readiness.confidence}), recovery ${r.recovery.score ?? "n/a"}/100.`,
  },
  {
    name: "coach_trends",
    label: "Coach Trends",
    description:
      "Multi-week view for weekly reviews and plan adjustments: weekly aggregates (HRV, resting heart rate, sleep, load, volume, " +
      "elevation, intensity distribution, fitness and form), HRV and sleep analysis, training-load indicators, and long-term health " +
      "markers compared with published thresholds. Set includeDaily for the day-by-day series.",
    parameters: Type.Object({
      days: Type.Optional(Type.Integer({ minimum: 14, maximum: 365, default: 28, description: "Window in days (limited by the stored history)." })),
      includeDaily: Type.Optional(Type.Boolean({ description: "Also return one row per day (larger output)." })),
      sync: SyncParam,
    }),
    run: trends as Tool["run"],
    summary: (r: { windowDays: number; weekly: unknown[] }) => `Trends over ${r.windowDays} days (${r.weekly.length} weeks).`,
  },
  {
    name: "coach_training_load",
    label: "Coach Training Load",
    description:
      "Training-load model: per-session load (Banister TRIMP), fitness (42-day), fatigue (7-day), form, weekly change, monotony and " +
      "strain, intensity distribution. Pass `plan` (future sessions as a load, or as duration and heart-rate zone) to project " +
      "fitness, fatigue and form over the plan before proposing it: use this to check a build or a taper.",
    parameters: Type.Object({
      plan: Type.Optional(
        Type.Array(
          Type.Object({
            date: Type.String({ description: "YYYY-MM-DD, after today." }),
            load: Type.Optional(Type.Number({ minimum: 0, description: "Session load in TRIMP, if already known." })),
            durationMin: Type.Optional(Type.Number({ minimum: 1, maximum: 1440 })),
            zone: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Mean heart-rate zone of the session." })),
          }),
          { maxItems: 200 },
        ),
      ),
      sync: SyncParam,
    }),
    run: trainingLoad as Tool["run"],
    summary: (r: { load: { today: { ctl: number; atl: number; tsb: number } | null } }) =>
      r.load.today ? `Load: fitness ${r.load.today.ctl}, fatigue ${r.load.today.atl}, form ${r.load.today.tsb}.` : "Load: no history yet.",
  },
  {
    name: "coach_activity_deep_dive",
    label: "Coach Activity Deep Dive",
    description:
      "Analysis of one activity: load, time in heart-rate zones, per-lap pace and grade-adjusted pace, aerobic decoupling " +
      "(heart-rate drift for the same output), efficiency, weather and heat flags. Use it on key sessions, long runs, races and " +
      "any session whose heart rate or pace looks unusual.",
    parameters: Type.Object({ activityId: ActivityIdParam }),
    run: activityDeepDive as Tool["run"],
    summary: (r: { activityId: string; flags?: string[] }) => `Activity ${r.activityId}: ${r.flags?.length ?? 0} flag(s).`,
  },
  {
    name: "coach_zones_and_paces",
    label: "Coach Zones And Paces",
    description:
      "Heart-rate zone tables from the athlete's anchors (lactate-threshold heart rate, heart-rate reserve, maximum heart rate). " +
      "With a recent race result (raceDistanceM, raceTimeS) also returns VDOT, training paces and equivalent times for other flat distances.",
    parameters: Type.Object({
      raceDistanceM: Type.Optional(Type.Number({ minimum: 800, maximum: 100000 })),
      raceTimeS: Type.Optional(Type.Number({ minimum: 120, maximum: 86400 })),
      targetDistanceM: Type.Optional(Type.Number({ minimum: 800, maximum: 100000 })),
    }),
    run: zonesAndPaces as Tool["run"],
    summary: () => "Zones and paces computed.",
  },
  {
    name: "coach_strength_analysis",
    label: "Coach Strength Analysis",
    description:
      "Summary of one strength session recorded on the watch: sets, repetitions, volume load, top set and estimated one-repetition " +
      "maximum per exercise, sets per muscle group. Descriptive only.",
    parameters: Type.Object({ activityId: ActivityIdParam }),
    run: strengthAnalysis as Tool["run"],
    summary: (r: { activityId: string; totalSets?: number }) => `Strength session ${r.activityId}: ${r.totalSets ?? 0} sets.`,
  },
  {
    name: "coach_journal_log",
    label: "Coach Journal Log",
    description:
      "Saves the athlete's subjective check-in and habits for a day in the local journal: wellness ratings, session RPE, symptoms, " +
      "and habit tags (e.g. alcohol: 2, late_caffeine: true, sauna: true). Log tags as false on days without the habit, so that " +
      "coach_journal_insights can compare. Only record what the athlete actually said.",
    parameters: Type.Object({
      date: DateParam,
      tags: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Boolean(), Type.Number({ minimum: 0 })]))),
      rpe: Type.Optional(Type.Number({ minimum: 0, maximum: 10, description: "Session rating of perceived exertion (CR-10)." })),
      fatigue: Rating("Fatigue"),
      soreness: Rating("Muscle soreness"),
      mood: Rating("Mood"),
      sleepQuality: Rating("Perceived sleep quality"),
      stress: Rating("Life stress"),
      symptoms: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 10, description: "Symptoms reported today (sore throat, fever, pain...)." })),
      notes: Type.Optional(Type.String({ maxLength: 500 })),
    }),
    run: journalLog as Tool["run"],
    summary: (r: { saved: { date: string } }) => `Journal saved for ${r.saved.date}.`,
  },
  {
    name: "coach_journal_insights",
    label: "Coach Journal Insights",
    description:
      "Compares the nights that follow days with a logged habit to the nights that follow days without it (HRV, resting heart rate, " +
      "sleep). Returns group sizes, difference with a confidence interval, effect size and adjusted p-value. These are observed " +
      "associations in personal data, never proof of cause: present them that way.",
    parameters: Type.Object({ days: Type.Optional(Type.Integer({ minimum: 30, maximum: 730, default: 120 })) }),
    run: journalInsights as Tool["run"],
    summary: (r: { associations: unknown[]; journalDays: number }) => `Journal: ${r.journalDays} days, ${r.associations.length} comparison(s).`,
  },
  {
    name: "coach_workout_push",
    label: "Coach Workout Push",
    description:
      "Creates a structured workout in Garmin Connect. Without confirm it only returns a preview (duration, estimated load): show it " +
      "to the athlete, and call again with confirm: true only after they explicitly agree. Disabled unless allowWorkoutPush is set.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 80 }),
      sport: Type.Union(["running", "cycling", "swimming", "strength_training", "walking", "hiking"].map((sport) => Type.Literal(sport))),
      steps: Type.Array(
        Type.Object({
          type: Type.Union(["warmup", "interval", "recovery", "cooldown", "rest"].map((type) => Type.Literal(type))),
          durationS: Type.Integer({ minimum: 10, maximum: 21600 }),
          target: Type.Optional(Type.String({ description: "hr_zone:2, pace_zone:3, power_zone:4, heart_rate:150, power:220-240 or no_target." })),
        }),
        { minItems: 1, maxItems: 60, description: "Flat list of steps: write out each repetition of an interval block." },
      ),
      confirm: Type.Optional(Type.Boolean({ description: "true only after the athlete has approved the preview." })),
    }),
    run: workoutPush as Tool["run"],
    summary: (r: { created: boolean; message: string }) => (r.created ? "Workout created." : r.message),
  },
  {
    name: "coach_data_status",
    label: "Coach Data Status",
    description:
      "State of the coach's data: history coverage per signal, last sync and its errors, physiological anchors in use and where they " +
      "come from, and what to configure. Use it when a briefing reports calibrating or insufficient_data, or to backfill (sync: true).",
    parameters: Type.Object({ sync: Type.Optional(Type.Boolean({ description: "Fetch missing history from Garmin now (default false)." })) }),
    run: dataStatus as Tool["run"],
    summary: (r: { advice: string[] }) => `Data status: ${r.advice.length} point(s) to address.`,
  },
];

export default definePluginEntry({
  id: "coach",
  name: "AI Coach",
  description: "Endurance and recovery coach: documented physiological models computed on Garmin data, with a coaching skill.",
  register(api) {
    const config = parseConfig(api.pluginConfig);
    const deps: Deps = { config, gc: createGcRunner(config.gcBinary) };

    for (const tool of TOOLS) {
      api.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        async execute(_id: string, rawParams: unknown) {
          try {
            const result = await tool.run(deps, (rawParams ?? {}) as never);
            return {
              content: [
                { type: "text" as const, text: tool.summary(result as never) },
                { type: "text" as const, text: JSON.stringify(result) },
              ],
              details: result,
            };
          } catch (error) {
            // Input errors are explained to the model; anything else is reported without internals.
            const message = error instanceof ToolInputError ? error.message : `The coach tool failed: ${error instanceof Error ? error.message : "unknown error"}.`;
            const failure = { error: error instanceof ToolInputError ? "invalid_input" : "internal_error", message };
            return { content: [{ type: "text" as const, text: JSON.stringify(failure) }], details: failure };
          }
        },
      });
    }
  },
});
