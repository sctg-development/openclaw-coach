import { Type, type TSchema } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseConfig } from "./config.ts";
import { dashboardHandler } from "./dashboard.ts";
import { MAX_TAGS_PER_ENTRY } from "./limits.ts";
import { createGarminRunner } from "./garmin/backend.ts";
import {
  ToolInputError,
  activityDeepDive,
  briefingCharts,
  briefingEmail,
  CHART_IDS,
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
      tags: Type.Optional(Type.Record(Type.String({ maxLength: 60 }), Type.Union([Type.Boolean(), Type.Number({ minimum: 0 })]), { maxProperties: MAX_TAGS_PER_ENTRY })),
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
    name: "coach_briefing_charts",
    label: "Coach Briefing Charts",
    description:
      "Renders the day's key figures as PNG images for an email or report: recovery gauge, today's ceiling, overnight signals against " +
      "the personal baseline, HRV trend with normal range, fitness/fatigue/form curve, sleep of the last 14 nights. Numbers come from " +
      "the same models as coach_daily_briefing. Returns file paths, content ids and alt texts; pass them to send_email as inlineImages. " +
      "Writes files under the coach data directory only. A chart without enough data is skipped with the reason.",
    parameters: Type.Object({
      date: DateParam,
      sync: SyncParam,
      charts: Type.Optional(Type.Array(Type.Union(CHART_IDS.map((id) => Type.Literal(id))), { minItems: 1, maxItems: 6, description: "Subset of charts. Default: all six." })),
      lang: Type.Optional(Type.Union([Type.Literal("en"), Type.Literal("fr")], { description: "Label language. Default: the plugin's `language` setting." })),
      theme: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")], { description: "Default light (best for email: the card keeps its own background)." })),
    }),
    run: briefingCharts as Tool["run"],
    summary: (r: { charts: unknown[]; skipped: unknown[] }) => `${r.charts.length} chart(s) rendered, ${r.skipped.length} skipped.`,
  },
  {
    name: "coach_briefing_email",
    label: "Coach Briefing Email",
    description:
      "Builds the complete daily briefing e-mail in code: subject, HTML (centred column, ceiling banner, recovery gauge, signals, HRV, sleep, " +
      "text summary table), plain-text version and inline-image list. Pass subject, bodyHtml, bodyText and inlineImages to a mail tool " +
      "(send_email) without rewriting them. Optionally supply headline, why and watch in the athlete's language to personalise the three " +
      "sentences that need judgement. The load curve is added on Sundays. It does not send anything.",
    parameters: Type.Object({
      date: DateParam,
      sync: SyncParam,
      lang: Type.Optional(Type.Union([Type.Literal("en"), Type.Literal("fr")], { description: "Language of labels and default texts. Default: the plugin's `language` setting." })),
      headline: Type.Optional(Type.String({ maxLength: 240, description: "One sentence: what to do today, taking ATHLETE.md and PLAN.md into account. Default: the meaning of the ceiling." })),
      why: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 3, description: "Up to 3 bullets, main cause first, with figures and their personal reference. Default: the rules that set the ceiling, for English only; omitted for French when not supplied." })),
      watch: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 4, description: "Cautions only (early warning, symptoms, sleep debt, load, missing data). Default: the briefing's caveats, for English only; omitted for French when not supplied. Pass [] when there is nothing to watch." })),
      weekly: Type.Optional(Type.Boolean({ description: "Add the fitness/fatigue/form curve. Default: only on Sundays." })),
    }),
    run: briefingEmail as Tool["run"],
    summary: (r: { subject: string; inlineImages: unknown[] }) => `E-mail built: "${r.subject}", ${r.inlineImages.length} inline image(s).`,
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
    const deps: Deps = { config, gc: createGarminRunner(config) };

    // Dashboard tab: a read-only HTML page behind Gateway authentication, shown by the Control UI in a sandboxed frame.
    api.registerHttpRoute({ path: "/coach/dashboard", auth: "gateway", match: "exact", handler: dashboardHandler(deps) });
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "coach",
      label: "Coach",
      description: "Recovery, HRV, sleep, cardiac and muscular load, intensity minutes.",
      icon: "heart",
      group: "agent",
      path: "/coach/dashboard",
      requiredScopes: ["operator.read"],
    });

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
