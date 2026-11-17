/**
 * Native Garmin backend: runs the `gc` commands the coach uses in-process with @sctg/garmin-ts-client,
 * returning the same JSON as the CLI (checked on a real account). The package is optional and loaded
 * lazily, through a structural interface, so the coach compiles and runs without it.
 */
import { gcFailure, type GcErrorCode, type GcResult, type GcRunner } from "./gc.ts";

export interface NativeGarmin {
  daily(options: { start: string; end?: string; detail?: boolean }): Promise<unknown>;
  activities(options: { start: string; end?: string }): Promise<unknown>;
  activity(id: string, view?: ActivityView): Promise<unknown>;
  metric(name: "training-readiness" | "training-status", date: string): Promise<unknown>;
  lactateThreshold(): Promise<unknown>;
}

export type ActivityView = "splits" | "hr-zones" | "weather" | "exercise-sets";
const ACTIVITY_VIEWS: readonly string[] = ["get", "splits", "hr-zones", "weather", "exercise-sets"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function flags(args: string[]): { positional: string[]; values: Map<string, string>; switches: Set<string> } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--detail" || arg === "--no-detail") switches.add(arg);
    else if (arg.startsWith("--")) values.set(arg, args[(index += 1)] ?? "");
    else positional.push(arg);
  }
  return { positional, values, switches };
}

/** True when the native backend implements the command (writes, such as `workouts create`, stay on gc). */
export function isNativeCommand(args: string[]): boolean {
  const [command, sub] = args;
  if (command === "daily" || command === "activities") return command === "daily" || !sub || sub.startsWith("--") || ACTIVITY_VIEWS.includes(sub);
  return command === "metrics" && (sub === "training-readiness" || sub === "training-status" || sub === "lactate-threshold");
}

function code(error: unknown): GcErrorCode {
  const value = (error as { code?: unknown })?.code;
  return value === "auth" || value === "rate_limited" || value === "connection" ? value : "error";
}

/** Maps `gc` arguments to native calls. Failures become the stable codes the CLI runner reports. */
export function nativeRunner(api: NativeGarmin): GcRunner {
  return async (args) => {
    if (!isNativeCommand(args)) return gcFailure("unsupported");
    const [command, ...rest] = args;
    const { positional, values, switches } = flags(rest);
    try {
      let data: unknown;
      if (command === "daily") {
        const start = values.get("--start");
        if (!start || !DATE.test(start)) return gcFailure("unsupported");
        data = await api.daily({ start, end: values.get("--end"), detail: switches.has("--no-detail") ? false : switches.has("--detail") ? true : undefined });
      } else if (command === "activities" && positional.length > 0) {
        const [view, id] = positional;
        if (!id || !/^\d{1,20}$/.test(id)) return gcFailure("unsupported");
        data = await api.activity(id, view === "get" ? undefined : (view as ActivityView));
      } else if (command === "activities") {
        const start = values.get("--start");
        if (!start || !DATE.test(start)) return gcFailure("unsupported");
        data = await api.activities({ start, end: values.get("--end") });
      } else if (positional[0] === "lactate-threshold") {
        data = await api.lactateThreshold();
      } else {
        const date = positional[1];
        if (!date || !DATE.test(date)) return gcFailure("unsupported");
        data = await api.metric(positional[0] as "training-readiness" | "training-status", date);
      }
      return { ok: true, data } as GcResult;
    } catch (error) {
      return gcFailure(code(error));
    }
  };
}

type Module = Record<string, (...args: never[]) => unknown> & { GarminClient: { fromFile(file?: string): unknown } };

/** Loads the optional package. Returns the failure code instead of throwing: `auth` without a token file, `not_configured` without the package. */
export async function loadNative(tokenFile: string | null, moduleName = "@sctg/garmin-ts-client"): Promise<NativeGarmin | GcErrorCode> {
  let mod: Module;
  try {
    mod = (await import(/* @vite-ignore */ moduleName)) as Module;
  } catch {
    return "not_configured";
  }
  const client = mod.GarminClient.fromFile(tokenFile ?? undefined) as { tokenInfo(): Promise<unknown> };
  try {
    await client.tokenInfo();
  } catch {
    return "auth";
  }
  const call = (name: string, ...args: unknown[]) => (mod[name] as unknown as (...a: unknown[]) => Promise<unknown>)(client, ...args);
  return {
    daily: (options) => call("daily", options),
    activities: (options) => call("listActivities", options),
    activity: (id, view) => call(view === undefined ? "getActivity" : { splits: "activitySplits", "hr-zones": "activityHrZones", weather: "activityWeather", "exercise-sets": "activityExerciseSets" }[view], id),
    metric: (name, date) => call(name === "training-readiness" ? "trainingReadiness" : "trainingStatus", date),
    lactateThreshold: () => call("lactateThreshold"),
  };
}
