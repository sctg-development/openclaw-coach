/**
 * Replies to the briefing e-mail: "tell me how you feel (fatigue, pain, motivation)" answered by mail.
 *
 * `gog` (the Google CLI shipped in the Gateway image) searches the mailbox that receives the replies. A reply is kept only
 * when it comes from an allowed sender and answers a briefing; its text, cleaned of quoted history, is stored in the local
 * journal (as a note for the day) and offered once to the next briefing, so the coach can turn it into structured check-in
 * values and take it into account afterwards.
 *
 * The reply text is UNTRUSTED input (anyone able to forge the sender could write it): it is bounded, stripped of control
 * characters, stored as data and always presented as the athlete's words, never as instructions. `gog` is run read-only
 * and with sending blocked, and arguments go through execFile, never through a shell.
 */
import { execFile } from "node:child_process";
import { addDays, todayIn } from "./dates.ts";
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoreData } from "./store.ts";
import type { JournalEntry } from "./types.ts";

export type InboxConfig = {
  /** Mailbox (gog account) that receives the replies. */
  account: string;
  /** Addresses whose replies are accepted. Anything else is ignored. */
  allowedFrom: string[];
  /** Word the replied-to subject contains (the briefing subjects start with "Briefing"). */
  subject: string;
  lookbackDays: number;
  gogBinary: string;
  timezone: string;
};

export type Reply = {
  /** Gmail message id: the key that makes processing idempotent. */
  id: string;
  /** Local date the reply was written, which is the journal day it informs. */
  date: string;
  receivedAt: string;
  text: string;
  /** Set once a briefing has presented the reply to the coach. */
  shownAt: string | null;
  /** True once the reply has been added to the journal note of its day. */
  noted: boolean;
};

export type InboxState = { replies: Reply[]; /** Ids already handled (accepted or rejected), with the date seen. */ handled: Record<string, string> };

export const emptyInbox = (): InboxState => ({ replies: [], handled: {} });

// --- Own file with a lock -----------------------------------------------------------------------------
// The inbox lives in its own file, not in the coach store: an optional cron process can fetch replies while the plugin
// runs, and two processes must never rewrite the same file from a stale copy. A lock directory (atomic to create)
// serialises them; a lock older than a minute is taken to belong to a crashed process.

const FILE = "coach-inbox.json";
const LOCK = "coach-inbox.lock";
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;

async function loadInbox(dataDir: string): Promise<InboxState> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dataDir, FILE), "utf8")) as Partial<InboxState>;
    return { replies: Array.isArray(parsed.replies) ? parsed.replies : [], handled: parsed.handled && typeof parsed.handled === "object" ? parsed.handled : {} };
  } catch {
    return emptyInbox();
  }
}

/** Runs `task` on the inbox state under the lock, then saves it (atomic write, owner-only permissions). */
export async function withInbox<T>(dataDir: string, task: (state: InboxState) => Promise<T> | T): Promise<T> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(dataDir, LOCK);
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await rmdir(lock).catch(() => undefined);
      else if (Date.now() - started > LOCK_WAIT_MS) throw new Error("the inbox is locked by another process");
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    const state = await loadInbox(dataDir);
    const result = await task(state);
    const target = path.join(dataDir, FILE);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, target);
    return result;
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

/** Limits: a mailbox must not be able to grow the store or the briefing without bound. */
export const MAX_REPLY_CHARS = 1500;
export const MAX_NEW_PER_SYNC = 10;
export const MAX_STORED_REPLIES = 30;
export const MAX_HANDLED_IDS = 500;
export const JOURNAL_NOTE_CHARS = 500;

export type GogRunner = (args: string[]) => Promise<{ ok: true; stdout: string } | { ok: false; message: string }>;

/** Runs the gog binary with a timeout; never leaks its output into errors. */
export function createGogRunner(binary: string, timeoutMs = 60_000): GogRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(binary, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env }, (error, stdout) => {
        if (error) resolve({ ok: false, message: (error as NodeJS.ErrnoException).code === "ENOENT" ? "gog binary not found" : error.killed ? "gog timed out" : "gog failed" });
        else resolve({ ok: true, stdout });
      });
    });
}

const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** The address inside "Name <address>" (or a bare address), lower-cased, or null. */
export function senderAddress(from: unknown): string | null {
  if (typeof from !== "string") return null;
  const angle = from.match(/<([^<>]+)>\s*$/);
  const address = (angle ? angle[1] : from).trim().toLowerCase();
  return EMAIL.test(address) ? address : null;
}

/**
 * Removes what is not the athlete's own words: quoted history, the "On ... wrote:" line, signatures and control
 * characters. Returns an empty string when nothing is left.
 */
export function cleanReplyText(body: unknown): string {
  if (typeof body !== "string") return "";
  const lines = body.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    // Start of the quoted message (English, French, Outlook, forwarded).
    if (/^\s*(On .{5,200} wrote:|Le .{5,200} a écrit\s?:|-{2,}\s*(Original Message|Message d'origine|Forwarded message)|From:\s|De\s?:\s)/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    if (/^--\s*$/.test(line)) break;
    kept.push(line);
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS - 1)}…` : text;
}

/** Gmail search words for the query: only values that passed validation are ever put in it. */
export function buildQuery(config: Pick<InboxConfig, "allowedFrom" | "subject" | "lookbackDays">): string | null {
  const senders = config.allowedFrom.filter((address) => EMAIL.test(address));
  const subject = config.subject.replace(/[^\p{L}\p{N} ._'-]/gu, "").trim();
  if (!senders.length || !subject) return null;
  return `in:inbox -in:spam newer_than:${Math.max(1, Math.min(30, Math.round(config.lookbackDays)))}d subject:"${subject}" from:(${senders.join(" OR ")})`;
}

export type InboxReport = {
  ok: boolean;
  /** Replies kept by this run. */
  accepted: number;
  /** Messages found and left out, by reason. */
  ignored: Record<string, number>;
  error?: string;
};

type GogMessage = { id?: unknown; from?: unknown; subject?: unknown; internalDateIso?: unknown; date?: unknown; body?: unknown; labels?: unknown };

function messagesOf(stdout: string): GogMessage[] | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { messages?: unknown })?.messages;
    return Array.isArray(list) ? (list as GogMessage[]) : null;
  } catch {
    return null;
  }
}

/**
 * Fetches replies and adds the new ones to the inbox state. The caller saves it (see `withInbox`).
 * Nothing here throws for a mailbox problem: the report says what happened.
 */
export async function syncInbox(inbox: InboxState, config: InboxConfig, run: GogRunner = createGogRunner(config.gogBinary), now: Date = new Date()): Promise<InboxReport> {
  const ignored: Record<string, number> = {};
  const skip = (reason: string) => (ignored[reason] = (ignored[reason] ?? 0) + 1);
  const query = buildQuery(config);
  if (!query || !EMAIL.test(config.account)) return { ok: false, accepted: 0, ignored, error: "mail replies need a valid mail account and at least one allowed sender" };

  const result = await run(["gmail", "messages", "search", query, "--max", String(MAX_NEW_PER_SYNC * 3), "--include-body", "--json", "--readonly", "--gmail-no-send", "--no-input", "-a", config.account]);
  if (!result.ok) return { ok: false, accepted: 0, ignored, error: result.message };
  const messages = messagesOf(result.stdout);
  if (!messages) return { ok: false, accepted: 0, ignored, error: "gog returned something that is not a message list" };

  const allowed = new Set(config.allowedFrom.map((address) => address.toLowerCase()));
  const today = todayIn(config.timezone, now);
  let accepted = 0;
  for (const message of messages) {
    const id = typeof message.id === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(message.id) ? message.id : null;
    if (!id) continue;
    if (inbox.handled[id]) {
      skip("already handled");
      continue;
    }
    if (accepted >= MAX_NEW_PER_SYNC) {
      skip("over the per-run limit");
      continue;
    }
    inbox.handled[id] = today;
    const sender = senderAddress(message.from);
    if (!sender || !allowed.has(sender)) {
      skip("sender not allowed");
      continue;
    }
    if (Array.isArray(message.labels) && message.labels.some((label) => label === "SPAM" || label === "TRASH")) {
      skip("spam or trash");
      continue;
    }
    const text = cleanReplyText(message.body);
    if (!text) {
      skip("empty after removing quotes");
      continue;
    }
    const received = typeof message.internalDateIso === "string" && !Number.isNaN(Date.parse(message.internalDateIso)) ? new Date(message.internalDateIso) : now;
    const date = todayIn(config.timezone, received);
    if (date < addDays(today, -config.lookbackDays - 1)) {
      skip("too old");
      continue;
    }
    inbox.replies.push({ id, date, receivedAt: received.toISOString(), text, shownAt: null, noted: false });
    accepted += 1;
  }
  // Bound what is kept: newest replies first, and the list of handled ids.
  inbox.replies.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  inbox.replies.length = Math.min(inbox.replies.length, MAX_STORED_REPLIES);
  const ids = Object.entries(inbox.handled).sort((a, b) => b[1].localeCompare(a[1]));
  if (ids.length > MAX_HANDLED_IDS) inbox.handled = Object.fromEntries(ids.slice(0, MAX_HANDLED_IDS));
  return { ok: true, accepted, ignored };
}

/**
 * Adds every reply not yet noted to the journal note of its day (same 500-character limit as the journal tool) and returns
 * how many. Run by the plugin, which owns the journal; the inbox state is updated, the caller saves both.
 */
export function noteReplies(store: StoreData, inbox: InboxState, now: Date = new Date()): number {
  let count = 0;
  for (const reply of inbox.replies) {
    if (reply.noted) continue;
    addNote(store, reply.date, reply.text, now);
    reply.noted = true;
    count += 1;
  }
  return count;
}

function addNote(store: StoreData, date: string, text: string, now: Date): void {
  const entry: JournalEntry = store.journal[date] ?? { date, tags: {}, updatedAt: now.toISOString() };
  const piece = `[mail] ${text.replace(/\s+/g, " ")}`;
  const notes = entry.notes ? `${entry.notes} | ${piece}` : piece;
  entry.notes = notes.length > JOURNAL_NOTE_CHARS ? `${notes.slice(0, JOURNAL_NOTE_CHARS - 1)}…` : notes;
  entry.updatedAt = now.toISOString();
  store.journal[date] = entry;
}

/** Replies the briefing has not shown yet, and the ones from the last few days. Marks the new ones as shown. */
export function takeReplies(inbox: InboxState, today: string, now: Date = new Date()): { new: Reply[]; recent: Reply[] } {
  const fresh = inbox.replies.filter((reply) => reply.shownAt === null);
  for (const reply of fresh) reply.shownAt = now.toISOString();
  const recent = inbox.replies.filter((reply) => reply.shownAt !== null && !fresh.includes(reply) && reply.date >= addDays(today, -3));
  return { new: fresh, recent };
}
