/**
 * Runs the garmin-cli binary (`gc`). Arguments are passed as an array to
 * execFile, never through a shell, and callers validate every value coming
 * from a tool call. Failures are returned as stable codes, never thrown, and
 * never include the CLI's full output.
 */

import { execFile } from "node:child_process";

export type GcErrorCode = "not_configured" | "auth" | "rate_limited" | "timeout" | "unsupported" | "parse_error" | "connection" | "error";

export type GcResult<T = unknown> = { ok: true; data: T } | { ok: false; code: GcErrorCode; message: string };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT = 3;

export function classifyGcError(error: { code?: unknown; killed?: boolean; signal?: unknown } | null, stderr: string): GcErrorCode {
  if (error?.code === "ENOENT" || error?.code === "EACCES") return "not_configured";
  if (error?.killed || error?.signal === "SIGTERM") return "timeout";
  const text = stderr.toLowerCase();
  // Checked first: a usage message mentions "--tokenstore" and must not read as an auth failure.
  if (text.includes("no such command") || text.includes("no such option") || text.includes("usage:")) return "unsupported";
  if (text.includes("authentication") || text.includes("gc login") || text.includes("not logged in")) return "auth";
  if (text.includes("rate limit") || text.includes("too many requests") || text.includes("429")) return "rate_limited";
  if (text.includes("connection error") || text.includes("timed out") || text.includes("max retries")) return "connection";
  return "error";
}

const MESSAGES: Record<GcErrorCode, string> = {
  not_configured: "The gc binary was not found or is not executable (check gcBinary).",
  auth: "Garmin session missing or expired: run `gc login` in the Gateway environment.",
  rate_limited: "Garmin Connect is rate limiting requests: wait before retrying.",
  timeout: "The gc command timed out.",
  unsupported: "This gc version does not support the command (garmin-cli >= 0.4.0 is required for `gc daily`).",
  parse_error: "gc returned output that is not valid JSON.",
  connection: "Could not reach Garmin Connect.",
  error: "The gc command failed.",
};

export type GcRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<GcResult>;

/** Builds a runner with its own concurrency limit (Garmin rate-limits bursts). */
export function createGcRunner(binary: string): GcRunner {
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < MAX_CONCURRENT) {
        active += 1;
        resolve();
      } else {
        waiting.push(resolve);
      }
    });
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return async (args, options = {}) => {
    await acquire();
    try {
      return await new Promise<GcResult>((resolve) => {
        execFile(
          binary,
          [...args, "--format", "json"],
          { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
          (error, stdout, stderr) => {
            if (error) {
              const code = classifyGcError(error as { code?: unknown; killed?: boolean; signal?: unknown }, String(stderr ?? ""));
              resolve({ ok: false, code, message: MESSAGES[code] });
              return;
            }
            try {
              resolve({ ok: true, data: JSON.parse(String(stdout)) });
            } catch {
              resolve({ ok: false, code: "parse_error", message: MESSAGES.parse_error });
            }
          },
        );
      });
    } finally {
      release();
    }
  };
}
