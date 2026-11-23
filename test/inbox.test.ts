import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MAX_NEW_PER_SYNC, buildQuery, cleanReplyText, emptyInbox, noteReplies, senderAddress, syncInbox, takeReplies, withInbox, type GogRunner, type InboxConfig } from "../src/inbox.ts";
import { emptyStore } from "../src/store.ts";
import { parseConfig } from "../src/config.ts";

const CONFIG: InboxConfig = { account: "coach@example.org", allowedFrom: ["me@example.org"], subject: "Briefing", lookbackDays: 3, gogBinary: "gog", timezone: "Europe/Paris" };
const NOW = new Date("2026-11-23T09:00:00Z");

const message = (id: string, over: Record<string, unknown> = {}) => ({ id, from: "Me <me@example.org>", subject: "Re: Briefing", internalDateIso: "2026-11-23T08:00:00Z", labels: ["INBOX"], body: "Tired legs, motivated.", ...over });
const gog = (messages: unknown[], calls: string[][] = []): GogRunner => async (args) => {
  calls.push(args);
  return { ok: true, stdout: JSON.stringify({ messages }) };
};

test("quoted history, the 'wrote:' line and signatures are removed, and the length is bounded", () => {
  assert.equal(cleanReplyText("Legs heavy, sleep ok.\n\nOn Mon, 23 Nov 2026 at 07:00, Coach <c@x.org> wrote:\n> Tell me how you feel"), "Legs heavy, sleep ok.");
  assert.equal(cleanReplyText("Jambes lourdes.\n\nLe 23 nov. 2026 à 07:00, Coach a écrit :\n> Dis-moi"), "Jambes lourdes.");
  assert.equal(cleanReplyText("Fine\n-- \nSent from my phone"), "Fine");
  assert.equal(cleanReplyText("> only a quote"), "");
  assert.equal(cleanReplyText("a\u0000b\u0007c"), "abc");
  assert.ok(cleanReplyText("x".repeat(5000)).length <= 1500);
  assert.equal(cleanReplyText(undefined), "");
});

test("only a plain address is accepted as sender, and the query only contains validated values", () => {
  assert.equal(senderAddress("Me <ME@Example.org>"), "me@example.org");
  assert.equal(senderAddress("me@example.org"), "me@example.org");
  assert.equal(senderAddress("not an address"), null);
  assert.equal(senderAddress(42), null);
  const query = buildQuery({ allowedFrom: ["me@example.org", "x@y.org) OR (from:evil"], subject: 'Briefing" OR in:anywhere', lookbackDays: 3 });
  assert.ok(query?.includes("from:(me@example.org)"));
  assert.ok(!query?.includes("evil"));
  assert.ok(!query?.includes('" OR'));
  assert.equal(buildQuery({ allowedFrom: [], subject: "Briefing", lookbackDays: 3 }), null);
});

test("a reply from the athlete is stored as data, noted in the journal, shown once and kept as recent afterwards", async () => {
  const store = emptyStore();
  const inbox = emptyInbox();
  const calls: string[][] = [];
  const report = await syncInbox(inbox, CONFIG, gog([message("msg-1")], calls), NOW);
  assert.deepEqual(report, { ok: true, accepted: 1, ignored: {} });
  // gog is read-only, cannot send, never prompts, and the query went through as one argument (no shell).
  assert.ok(calls[0]?.includes("--readonly") && calls[0]?.includes("--gmail-no-send") && calls[0]?.includes("--no-input"));
  assert.equal(inbox.replies[0]?.date, "2026-11-23");
  assert.equal(noteReplies(store, inbox, NOW), 1);
  assert.equal(noteReplies(store, inbox, NOW), 0);
  assert.match(store.journal["2026-11-23"]?.notes ?? "", /^\[mail\] Tired legs, motivated\.$/);

  const first = takeReplies(inbox, "2026-11-23", NOW);
  assert.deepEqual(first.new.map((reply) => reply.text), ["Tired legs, motivated."]);
  const second = takeReplies(inbox, "2026-11-23", NOW);
  assert.deepEqual(second.new, []);
  assert.equal(second.recent.length, 1);

  // The same message is never processed twice.
  const again = await syncInbox(inbox, CONFIG, gog([message("msg-1")]), NOW);
  assert.equal(again.accepted, 0);
  assert.equal(again.ignored["already handled"], 1);
});

test("messages from other senders, spam, empty replies and old mail are ignored", async () => {
  const store = emptyStore();
  const inbox = emptyInbox();
  const report = await syncInbox(
    inbox,
    CONFIG,
    gog([
      message("a1-xx", { from: "Stranger <evil@example.net>" }),
      message("a2-xx", { labels: ["SPAM"] }),
      message("a3-xx", { body: "> just quoted" }),
      message("a4-xx", { internalDateIso: "2026-10-01T08:00:00Z" }),
      message("a5", { id: "bad id!" }),
    ]),
    NOW,
  );
  assert.equal(report.accepted, 0);
  assert.deepEqual(report.ignored, { "sender not allowed": 1, "spam or trash": 1, "empty after removing quotes": 1, "too old": 1 });
  assert.equal(noteReplies(store, inbox, NOW), 0);
  assert.deepEqual(store.journal, {});
});

test("a flood of replies is bounded per run and in the store", async () => {
  const store = emptyStore();
  const inbox = emptyInbox();
  const many = Array.from({ length: 40 }, (_, i) => message(`id${i}x`, { body: `note ${i}` }));
  const report = await syncInbox(inbox, CONFIG, gog(many), NOW);
  noteReplies(store, inbox, NOW);
  assert.equal(report.accepted, MAX_NEW_PER_SYNC);
  assert.equal(report.ignored["over the per-run limit"], 40 - MAX_NEW_PER_SYNC);
  assert.ok((store.journal["2026-11-23"]?.notes ?? "").length <= 500);
});

test("mailbox problems are reported without throwing, and without echoing gog's output", async () => {
  const failing: GogRunner = async () => ({ ok: false, message: "gog failed" });
  assert.deepEqual(await syncInbox(emptyInbox(), CONFIG, failing, NOW), { ok: false, accepted: 0, ignored: {}, error: "gog failed" });
  const garbage: GogRunner = async () => ({ ok: true, stdout: "SECRET not json" });
  const report = await syncInbox(emptyInbox(), CONFIG, garbage, NOW);
  assert.equal(report.ok, false);
  assert.ok(!JSON.stringify(report).includes("SECRET"));
  const bad = await syncInbox(emptyInbox(), { ...CONFIG, account: "nope" }, gog([]), NOW);
  assert.equal(bad.ok, false);
});

test("the mail settings are validated, and replies stay off by default", () => {
  const config = parseConfig({});
  assert.equal(config.mailReplies, "off");
  assert.equal(config.mailAccount, null);
  assert.deepEqual(config.mailAllowedFrom, []);
  const set = parseConfig({ mailReplies: "briefing", mailAccount: "coach@example.org", mailAllowedFrom: [" Me@Example.org ", 7, ""], mailLookbackDays: 99 });
  assert.equal(set.mailReplies, "briefing");
  assert.deepEqual(set.mailAllowedFrom, ["me@example.org"]);
  assert.equal(set.mailLookbackDays, 3);
  assert.ok(emptyInbox().replies.length === 0);
});

test("the inbox file is shared safely: updates under the lock are kept, and a stale lock does not block", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coach-inbox-"));
  try {
    await Promise.all(Array.from({ length: 8 }, (_, i) => withInbox(dir, (state) => void (state.handled[`id-${i}`] = "2026-11-23"))));
    const seen = await withInbox(dir, (state) => Object.keys(state.handled).length);
    assert.equal(seen, 8);
    // A lock left by a crashed process (old modification time) is taken over.
    const lock = path.join(dir, "coach-inbox.lock");
    await mkdir(lock);
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(lock, old, old);
    assert.equal(await withInbox(dir, () => "ok"), "ok");
    assert.equal((await stat(path.join(dir, "coach-inbox.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
