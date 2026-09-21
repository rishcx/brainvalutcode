import type { Command } from "../types.ts";
import { parseRecurrence } from "./recurrence.ts";
import { sanitiseTitle } from "./text.ts";

type TaskCommand = Extract<Command, { kind: "tasks" | "addTask" | "done" | "doneNamed" | "drop" }>;

const DAY = "[a-z]{3,9}";
const SUFFIX_RE = new RegExp(
  `\\s+(every\\s+day|daily|weekdays|every\\s+weekday|every\\s+${DAY}(?:(?:\\s*,\\s*and\\s+|\\s*,\\s*|\\s+and\\s+|\\s+)${DAY})*)\\s*$`,
  "i",
);

const index = (s: string): number | null => {
  const n = Number(s);
  return n >= 1 ? n : null;
};

// "Tasks?", "tasks please", "my tasks", "show me my tasks", "what's on my todo list", "today's tasks". Plural only:
// a bare "task" / "todo" is the start of `add task`, never a list request.
const LIST_RE =
  /^(?:(?:show|list|see|view|display|get|give)\s+(?:me\s+)?(?:all\s+)?(?:(?:my|the|today's|open|pending)\s+)?tasks|what(?:'s|s|\s+is|\s+are)?\s+(?:on\s+)?(?:my\s+)?(?:tasks|to-?do(?:\s+list)?)(?:\s+(?:for\s+)?today)?|(?:my|today's|all|open|pending)\s+(?:tasks|to-?do\s+list)|tasks?\s+list|tasks)$/i;

/** Whole-string, case-insensitive. Anything that is not clearly a task command is null. */
export function parseTaskCommand(text: string): TaskCommand | null {
  const t = text.trim().replace(/^\//, "").trim();
  if (/^(?:tasks|today)$/i.test(t)) return { kind: "tasks" };
  const polite = t
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s*[?!.]+$/, "")
    .replace(/[,\s]+(?:please|pls|plz)$/i, "")
    .replace(/^(?:please|pls|plz)[,\s]+/i, "");
  if (LIST_RE.test(polite)) return { kind: "tasks" };

  const add = /^(?:add\s+task|task|todo)\s+([\s\S]+)$/i.exec(t);
  if (add) {
    let rest = add[1]!.trim();
    let recurrence: string | null = null;
    const suf = SUFFIX_RE.exec(rest);
    if (suf) {
      const rec = parseRecurrence(suf[1]!);
      if (rec) {
        recurrence = rec;
        rest = rest.slice(0, suf.index);
      }
    }
    const title = sanitiseTitle(rest);
    return title ? { kind: "addTask", title, recurrence } : null;
  }

  const doneN = /^done\s+#?(\d{1,4})$/i.exec(t);
  if (doneN) {
    const n = index(doneN[1]!);
    return n === null ? null : { kind: "done", index: n };
  }
  const doneT = /^done\s+([\s\S]+)$/i.exec(t);
  if (doneT) {
    const title = sanitiseTitle(doneT[1]!);
    return title ? { kind: "doneNamed", title } : null;
  }

  const drop = /^(?:drop|not\s+doing)\s+#?(\d{1,4})$/i.exec(t);
  if (drop) {
    const n = index(drop[1]!);
    return n === null ? null : { kind: "drop", index: n };
  }
  return null;
}
