import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const execFileAsync = promisify(execFile);

const DEFAULT_GC_BINARY = "gc";
const GC_TIMEOUT_MS = 20_000;

type GarminFetchResult = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * Runs one `gc <args...> --format json` call. Each call is independent and
 * failure-isolated: a down Garmin session, a rate limit, or one unsupported
 * subcommand must not blank out the rest of the digest.
 */
async function fetchGarminJson(gcBinary: string, args: string[]): Promise<GarminFetchResult> {
  try {
    const { stdout } = await execFileAsync(gcBinary, [...args, "--format", "json"], {
      timeout: GC_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, data: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs several failure-isolated gc fetches concurrently and splits results from errors. */
async function fetchGarminBatch(
  fetches: Record<string, Promise<GarminFetchResult>>,
): Promise<{ data: Record<string, unknown>; errors: Record<string, string> }> {
  const resolved = await Promise.all(
    Object.entries(fetches).map(async ([key, pending]) => [key, await pending] as const),
  );
  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [key, result] of resolved) {
    if (result.ok) {
      data[key] = result.data;
    } else {
      data[key] = null;
      errors[key] = result.error;
    }
  }
  return { data, errors };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const UnknownJson = Type.Unknown();

export default definePluginEntry({
  id: "coach",
  name: "AI Coach",
  description: "Endurance coaching skill backed by Garmin Connect training-signal tools.",
  register(api) {
    const gcBinary =
      typeof api.pluginConfig?.gcBinary === "string" && api.pluginConfig.gcBinary.trim()
        ? api.pluginConfig.gcBinary.trim()
        : DEFAULT_GC_BINARY;

    api.registerTool({
      name: "coach_garmin_digest",
      label: "Coach Garmin Digest",
      description:
        "Fetches a compact Garmin Connect training-signal digest for the coach: recent " +
        "activities, training readiness/status, HRV, body battery, sleep, weight trend, and " +
        "race predictions. One call replaces several separate `gc` invocations. Use " +
        "coach_activity_deep_dive afterwards for a specific activity's splits/HR-zones/weather. " +
        "Requires the gc CLI (garmin-cli) to already be authenticated in this environment.",
      parameters: Type.Object({
        days: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 90,
            default: 7,
            description: "Lookback window in days for activities and weigh-ins (default 7).",
          }),
        ),
      }),
      outputSchema: Type.Object(
        {
          rangeStart: Type.String(),
          rangeEnd: Type.String(),
          activities: UnknownJson,
          trainingReadiness: UnknownJson,
          trainingStatus: UnknownJson,
          hrv: UnknownJson,
          bodyBattery: UnknownJson,
          sleep: UnknownJson,
          weighIns: UnknownJson,
          racePredictions: UnknownJson,
          errors: Type.Record(Type.String(), Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_id, rawParams) {
        const { days = 7 } = rawParams as { days?: number };
        const end = new Date();
        const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
        const rangeStart = isoDate(start);
        const rangeEnd = isoDate(end);

        const { data, errors } = await fetchGarminBatch({
          activities: fetchGarminJson(gcBinary, [
            "activities",
            "--start",
            rangeStart,
            "--end",
            rangeEnd,
          ]),
          trainingReadiness: fetchGarminJson(gcBinary, ["metrics", "training-readiness", "today"]),
          trainingStatus: fetchGarminJson(gcBinary, ["metrics", "training-status", "today"]),
          hrv: fetchGarminJson(gcBinary, ["metrics", "hrv", "today"]),
          bodyBattery: fetchGarminJson(gcBinary, ["battery", "today"]),
          sleep: fetchGarminJson(gcBinary, ["sleep", "yesterday"]),
          weighIns: fetchGarminJson(gcBinary, [
            "body",
            "weighins",
            "--start",
            rangeStart,
            "--end",
            rangeEnd,
          ]),
          racePredictions: fetchGarminJson(gcBinary, ["metrics", "race-predictions"]),
        });

        const digest = { rangeStart, rangeEnd, ...data, errors };
        const totalCalls = Object.keys(data).length;
        const failedCount = Object.keys(errors).length;
        const summaryText =
          failedCount === 0
            ? `Garmin digest for ${rangeStart} to ${rangeEnd}: all ${totalCalls} signals fetched.`
            : `Garmin digest for ${rangeStart} to ${rangeEnd}: ${failedCount} of ${totalCalls} signals unavailable (${Object.keys(errors).join(", ")}).`;

        return {
          content: [
            { type: "text", text: summaryText },
            { type: "text", text: JSON.stringify(digest, null, 2) },
          ],
          details: digest,
        };
      },
    });

    api.registerTool({
      name: "coach_activity_deep_dive",
      label: "Coach Activity Deep Dive",
      description:
        "Fetches a fine-grained analysis bundle for one Garmin activity: summary, elevation- " +
        "and grade-segmented splits, HR zones, and weather (temperature/conditions) at the " +
        "time of the activity. Use this after coach_garmin_digest identifies an activity worth " +
        "a closer look (a key long run, a race, an unusually hard or easy session).",
      parameters: Type.Object({
        activityId: Type.String({
          description: "Garmin activity id, as returned in coach_garmin_digest's activities list.",
        }),
      }),
      outputSchema: Type.Object(
        {
          activityId: Type.String(),
          summary: UnknownJson,
          typedSplits: UnknownJson,
          hrZones: UnknownJson,
          weather: UnknownJson,
          errors: Type.Record(Type.String(), Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_id, rawParams) {
        const { activityId } = rawParams as { activityId: string };

        const { data, errors } = await fetchGarminBatch({
          summary: fetchGarminJson(gcBinary, ["activities", "get", activityId]),
          // Typed splits carry per-segment elevation/grade, the basis for grade-adjusted
          // pace analysis; plain splits are a strict subset without that detail.
          typedSplits: fetchGarminJson(gcBinary, ["activities", "typed-splits", activityId]),
          hrZones: fetchGarminJson(gcBinary, ["activities", "hr-zones", activityId]),
          weather: fetchGarminJson(gcBinary, ["activities", "weather", activityId]),
        });

        const digest = { activityId, ...data, errors };
        const failedCount = Object.keys(errors).length;
        const summaryText =
          failedCount === 0
            ? `Activity ${activityId}: summary, splits, HR zones, and weather all fetched.`
            : `Activity ${activityId}: ${failedCount} of ${Object.keys(data).length} signals unavailable (${Object.keys(errors).join(", ")}).`;

        return {
          content: [
            { type: "text", text: summaryText },
            { type: "text", text: JSON.stringify(digest, null, 2) },
          ],
          details: digest,
        };
      },
    });
  },
});
