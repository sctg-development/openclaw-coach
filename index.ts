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

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default definePluginEntry({
  id: "coach",
  name: "AI Coach",
  description: "Endurance coaching skill backed by a Garmin Connect training-signal digest tool.",
  register(api) {
    const gcBinary =
      typeof api.pluginConfig?.gcBinary === "string" && api.pluginConfig.gcBinary.trim()
        ? api.pluginConfig.gcBinary.trim()
        : DEFAULT_GC_BINARY;

    api.registerTool({
      name: "coach_garmin_digest",
      description:
        "Fetches a compact Garmin Connect training-signal digest for the coach: recent " +
        "activities, training readiness/status, body battery, sleep, weight trend, and race " +
        "predictions. One call replaces several separate `gc` invocations. Requires the gc CLI " +
        "(garmin-cli) to already be authenticated in this environment.",
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
          activities: Type.Unknown(),
          trainingReadiness: Type.Unknown(),
          trainingStatus: Type.Unknown(),
          bodyBattery: Type.Unknown(),
          sleep: Type.Unknown(),
          weighIns: Type.Unknown(),
          racePredictions: Type.Unknown(),
          errors: Type.Record(Type.String(), Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const days = params.days ?? 7;
        const end = new Date();
        const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
        const rangeStart = isoDate(start);
        const rangeEnd = isoDate(end);

        const fetches = {
          activities: fetchGarminJson(gcBinary, [
            "activities",
            "--start",
            rangeStart,
            "--end",
            rangeEnd,
          ]),
          trainingReadiness: fetchGarminJson(gcBinary, ["metrics", "training-readiness", "today"]),
          trainingStatus: fetchGarminJson(gcBinary, ["metrics", "training-status", "today"]),
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
        } as const;

        const resolved = Object.fromEntries(
          await Promise.all(
            Object.entries(fetches).map(async ([key, pending]) => [key, await pending] as const),
          ),
        ) as Record<keyof typeof fetches, GarminFetchResult>;

        const errors: Record<string, string> = {};
        const digest: Record<string, unknown> = { rangeStart, rangeEnd };
        for (const [key, result] of Object.entries(resolved)) {
          if (result.ok) {
            digest[key] = result.data;
          } else {
            digest[key] = null;
            errors[key] = result.error;
          }
        }
        digest.errors = errors;

        const failedCount = Object.keys(errors).length;
        const summaryText =
          failedCount === 0
            ? `Garmin digest for ${rangeStart} to ${rangeEnd}: all ${Object.keys(fetches).length} signals fetched.`
            : `Garmin digest for ${rangeStart} to ${rangeEnd}: ${failedCount} of ${Object.keys(fetches).length} signals unavailable (${Object.keys(errors).join(", ")}).`;

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
