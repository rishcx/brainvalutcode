import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatTurn } from "../types.ts";
import { splitTurns, summaryKey } from "./memory.ts";
import { renderSnapshot, hasFacts, type Snapshot } from "./snapshot.ts";
import { cap, cleanText, redactSecrets } from "./text.ts";

const snap = (o: Partial<Snapshot> = {}): Snapshot => ({ today: "2026-09-21", nowLocal: "2026-09-21 14:00", tz: "Asia/Kolkata", overdue: [], dueSoon: [], tasksSection: "", gh: null, ...o });
const turn = (i: number, len: number): ChatTurn => ({ id: i, channel: "telegram", peer: "1", localDate: "d", role: "user", text: "x".repeat(len), at: "a" });

test("cleanText strips controls, bidi, zero-width and collapses newlines", () => {
  assert.equal(cleanText("a\u0000b\u200bc\u202ed\ufeffe\u2028f\n\n\n\ng"), "abcdef\n\ng");
  assert.equal(cleanText("ｆｕｌｌ"), "full");
  assert.equal(cap("abcdef", 4), "abc…");
});

test("redactSecrets", () => {
  const s = redactSecrets("a xoxb-12345678-abcdef b bot123456:ABCdefGHIjklMNOpqrSTUvwx");
  assert.equal(s, "a [redacted] b [redacted]");
});

test("splitTurns newest-first within budget, chronological tail", () => {
  const t = [turn(1, 100), turn(2, 100), turn(3, 100)];
  const { tail, older } = splitTurns(t, 220);
  assert.deepEqual(tail.map((x) => x.id), [2, 3]);
  assert.deepEqual(older.map((x) => x.id), [1]);
  assert.equal(summaryKey("telegram", "1", "d"), "chat:sum:telegram:1:d");
});

test("renderSnapshot trims lowest-priority sections first and never the deadlines", () => {
  const s = snap({
    overdue: [{ id: "a", source: "manual", sourceRef: "", title: "Overdue thing", dueAt: "2026-09-01T00:00:00Z", status: "open", confidence: 1, notePath: "" }],
    tasksSection: "## Today\n- " + "t".repeat(300),
    gh: { login: "me", assignedIssues: [], myOpenPrs: [], reviewRequests: [], mentions: [], recentRepos: [{ fullName: "a/b", lastActivityAt: "", reason: "" }], totals: { assignedIssues: 0, myOpenPrs: 0, reviewRequests: 0, mentions: 0 }, fetchedAt: "", partial: [] },
  });
  const full = renderSnapshot(s, 3000);
  assert.match(full, /Recently active repos: a\/b/);
  const small = renderSnapshot(s, 260);
  assert.doesNotMatch(small, /Recently active/);
  assert.match(small, /Overdue thing/);
  assert.ok(small.length <= 260);
  assert.equal(hasFacts(snap()), false);
});
