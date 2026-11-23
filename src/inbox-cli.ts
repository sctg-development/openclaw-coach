#!/usr/bin/env node
/**
 * Optional command for an OpenClaw command cron: reads the replies to the briefing e-mail on a schedule of your choice
 * (every 15 minutes, hourly...), without any model call. The plugin's daily briefing picks them up from the same file.
 *
 *   openclaw cron add --name coach-inbox --every 30m \
 *     --command 'node ~/.openclaw/extensions/coach/dist/inbox-cli.js --account coach@example.org --from me@example.org'
 *
 * Only the inbox file is written (never the coach store), so it cannot clash with the plugin. Prints one JSON line with
 * the counts, never the reply texts. Exit codes: 0 done, 1 the mailbox could not be read, 2 bad usage.
 */
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createGogRunner, syncInbox, withInbox } from "./inbox.ts";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      account: { type: "string" },
      from: { type: "string" },
      subject: { type: "string", default: "Briefing" },
      lookback: { type: "string", default: "3" },
      "data-dir": { type: "string" },
      gog: { type: "string", default: "gog" },
      timezone: { type: "string" },
    },
  });
  const allowedFrom = (values.from ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!values.account || !allowedFrom.length) {
    console.error("usage: inbox-cli.js --account <gog account> --from <address[,address]> [--subject Briefing] [--lookback 3] [--data-dir DIR] [--gog PATH] [--timezone TZ]");
    return 2;
  }
  const dataDir = values["data-dir"] ?? path.join(os.homedir(), ".openclaw", "coach");
  const config = {
    account: values.account,
    allowedFrom,
    subject: values.subject ?? "Briefing",
    lookbackDays: Number(values.lookback) || 3,
    gogBinary: values.gog ?? "gog",
    timezone: values.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
  };
  const report = await withInbox(dataDir, (inbox) => syncInbox(inbox, config, createGogRunner(config.gogBinary)));
  console.log(JSON.stringify(report));
  return report.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`coach inbox: ${error instanceof Error ? error.message : "failed"}`);
    process.exit(1);
  },
);
