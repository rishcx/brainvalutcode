// LLM-assisted extraction for the residue only. Input is gmailToLlmPayload() output, nothing else.
import { DEADLINE_SCHEMA, deadlinePrompt } from "../brain/prompts.ts";
import { gmailToLlmPayload } from "../sources/gmail.ts";
import { categorise } from "../reminders/rules.ts";
import { dueAtFromLocalDate, parseLooseDate } from "../time.ts";
import type { AgentContext, Deadline, GmailMessage, ReminderRule } from "../types.ts";
import { cleanTitle, gmailNotePath, gmailSourceRef } from "./extract.ts";

const MAX_CONFIDENCE = 0.9;

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(t);
}

export async function extractWithLlm(
  ctx: AgentContext,
  residue: GmailMessage[],
  rules: ReminderRule[] = ctx.config.reminders.rules,
): Promise<Deadline[]> {
  if (!ctx.brain || residue.length === 0) return [];
  const byId = new Map(residue.map((m) => [m.id, m]));
  const { system, prompt } = deadlinePrompt(residue.map((m) => ({ id: m.id, ...gmailToLlmPayload(m) })));

  let items: unknown;
  try {
    const r = await ctx.brain.complete({ system, prompt, jsonSchema: DEADLINE_SCHEMA });
    items = (parseJson(r.text) as { deadlines?: unknown } | null)?.deadlines;
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];

  const out: Deadline[] = [];
  const seen = new Set<string>();
  for (const it of items as Record<string, unknown>[]) {
    if (!it || typeof it !== "object") continue;
    const { id, title, date, confidence } = it;
    if (typeof id !== "string" || typeof title !== "string" || typeof date !== "string") continue;
    const m = byId.get(id);
    if (!m || seen.has(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || parseLooseDate(date) !== date) continue;
    const t = cleanTitle(title);
    if (!t) continue;
    seen.add(id);
    const sourceRef = gmailSourceRef(m);
    const c = typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0.5;
    out.push({
      id: `gmail:llm:${m.id}`,
      source: "gmail",
      sourceRef,
      title: t,
      dueAt: dueAtFromLocalDate(date, ctx.clock.tz, ctx.config.reminders.dueHourLocal),
      status: "proposed",
      confidence: Math.min(MAX_CONFIDENCE, Math.max(0, c)),
      notePath: gmailNotePath(m, ctx),
      category: categorise({ title: t, sourceRef, source: "gmail" }, rules, `${m.from} ${m.subject}`),
      timed: false,
    });
  }
  return out;
}
