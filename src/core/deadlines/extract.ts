// Deterministic deadline extraction. Runs on RAW subjects: redact() would eat the dates.
import { categorise, loadRules, ruleFor } from "../reminders/rules.ts";
import { dueAtFromLocalDate, dueAtFromLocalDateTime, localDateOf, parseLooseDate } from "../time.ts";
import type { AgentContext, Deadline, GmailMessage, ReminderRule } from "../types.ts";

const DUE_WORD = /\b(?:due|deadline|expires?|expiry|expiring|last date|renew(?:al)?|payment|submit by)\b/i;
const MANUAL_DIR = "Deadlines/manual/";

export const cleanTitle = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
};

/** Stable per message: derived from the received date, not from the poll time. */
export function gmailNotePath(m: GmailMessage, ctx: AgentContext): string {
  const ms = Number(m.internalDate);
  const at = Number.isFinite(ms) && ms > 0 ? new Date(ms) : ctx.clock.now();
  return `Gmail/${localDateOf(at, ctx.clock.tz)}-${m.id.replace(/[^\w-]/g, "_")}.md`;
}

export const gmailSourceRef = (m: GmailMessage): string =>
  `https://mail.google.com/mail/u/0/#inbox/${m.threadId || m.id}`;

const unquote = (v: string): string => v.trim().replace(/^(["'])(.*)\1$/, "$2");

function frontmatter(text: string): Record<string, string> {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!.toLowerCase()] = unquote(kv[2]!);
  }
  return out;
}

const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/;
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

export async function extractFromManualNotes(ctx: AgentContext, rules?: ReminderRule[]): Promise<Deadline[]> {
  const rs = rules ?? (await loadRules(ctx));
  const paths = (await ctx.vault.listFiles(MANUAL_DIR)).filter((p) => p.endsWith(".md"));
  const out: Deadline[] = [];
  for (const path of paths) {
    const text = await ctx.vault.readFile(path);
    if (text === null) continue;
    const fm = frontmatter(text);
    const raw = fm.due;
    if (!raw) continue;
    let dueAt: string | null = null;
    let timed = false;
    const local = LOCAL_DATETIME.exec(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const d = parseLooseDate(raw);
      const time = fm.time && HHMM.test(fm.time) ? fm.time : null;
      if (d) {
        dueAt = dueAtFromLocalDateTime(d, time, ctx.clock.tz, ctx.config.reminders.dueHourLocal);
        timed = time !== null;
      }
    } else if (local) {
      const d = parseLooseDate(local[1]!);
      if (d) {
        dueAt = dueAtFromLocalDateTime(d, local[2]!, ctx.clock.tz, ctx.config.reminders.dueHourLocal);
        timed = true;
      }
    } else {
      const t = Date.parse(raw);
      if (Number.isFinite(t)) {
        dueAt = new Date(t).toISOString();
        timed = true;
      }
    }
    if (!dueAt) continue;
    const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const title = cleanTitle(fm.title || base);
    const explicit = fm.category?.toLowerCase();
    const category = categorise(
      { title, sourceRef: path, source: "manual", category: explicit && ruleFor(explicit, rs) ? explicit : undefined },
      rs,
    );
    out.push({
      id: `manual:${path}`,
      source: "manual",
      sourceRef: path,
      title,
      dueAt,
      status: fm.status === "done" || fm.status === "dismissed" ? fm.status : "open",
      confidence: 1,
      notePath: path,
      category,
      timed,
    });
  }
  return out;
}

export function extractFromGmail(
  ms: GmailMessage[],
  ctx: AgentContext,
  rules: ReminderRule[] = ctx.config.reminders.rules,
): { found: Deadline[]; residue: GmailMessage[] } {
  const found: Deadline[] = [];
  const residue: GmailMessage[] = [];
  for (const m of ms) {
    if (!DUE_WORD.test(m.subject)) continue;
    const date = parseLooseDate(m.subject); // RAW subject, before any redaction
    if (!date) {
      residue.push(m);
      continue;
    }
    const title = cleanTitle(m.subject);
    const sourceRef = gmailSourceRef(m);
    found.push({
      id: `gmail:${m.id}`,
      source: "gmail",
      sourceRef,
      title,
      dueAt: dueAtFromLocalDate(date, ctx.clock.tz, ctx.config.reminders.dueHourLocal),
      status: "open",
      confidence: 1,
      notePath: gmailNotePath(m, ctx),
      category: categorise({ title, sourceRef, source: "gmail" }, rules, `${m.from} ${m.subject}`),
      timed: false,
    });
  }
  return { found, residue };
}
