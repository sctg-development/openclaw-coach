/** Chooses how Garmin data is fetched: in-process with the native client, or through the `gc` binary. */
import type { CoachConfig } from "../config.ts";
import { createGcRunner, gcFailure, type GcErrorCode, type GcRunner } from "./gc.ts";
import { isNativeCommand, loadNative, nativeRunner, type NativeGarmin } from "./native.ts";

export type BackendDeps = {
  gc?: GcRunner;
  load?: (tokenFile: string | null) => Promise<NativeGarmin | GcErrorCode>;
};

/**
 * - `gc`: the CLI only.
 * - `native`: the native client for what it implements; anything else (workout creation) is `unsupported`.
 * - `auto` (default): native when the package and a token file are present, otherwise gc; commands the
 *   native client does not implement always go to gc. The choice is made once, on first use.
 */
export type GarminRunner = GcRunner & {
  /** The backend that serves reads: `native`, `gc`, or `native-unavailable` (native requested, not usable). */
  backend(): Promise<"native" | "gc" | "native-unavailable">;
};

export function createGarminRunner(config: Pick<CoachConfig, "gcBinary" | "garminBackend" | "garminTokenFile">, deps: BackendDeps = {}): GarminRunner {
  const gc = deps.gc ?? createGcRunner(config.gcBinary);
  if (config.garminBackend === "gc") return Object.assign(gc, { backend: async () => "gc" as const });
  const load = deps.load ?? ((tokenFile: string | null) => loadNative(tokenFile));
  let native: Promise<GcRunner | GcErrorCode> | null = null;
  const resolveNative = () => {
    native ??= load(config.garminTokenFile).then((result) => (typeof result === "string" ? result : nativeRunner(result)));
    return native;
  };
  const run: GcRunner = async (args, options) => {
    if (!isNativeCommand(args)) return gc(args, options);
    const runner = await resolveNative();
    if (typeof runner === "string") return config.garminBackend === "native" ? gcFailure(runner) : gc(args, options);
    return runner(args, options);
  };
  return Object.assign(run, {
    backend: async () => {
      const runner = await resolveNative();
      return typeof runner === "string" ? (config.garminBackend === "native" ? ("native-unavailable" as const) : ("gc" as const)) : ("native" as const);
    },
  });
}
