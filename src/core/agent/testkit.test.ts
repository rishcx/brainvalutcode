// Shared offline kit for the agent tests (not a test itself: node --test runs it harmlessly, it has no tests).
import { testContext } from "../../node/testing/context.ts";
import { localDateOf, localTimeOf } from "../time.ts";
import type { AgentContext, Brain, BrainRequest, Clock, Deadline, InboundResult, Store, Task } from "../types.ts";
import { runAgent } from "./handle.ts";

export const AT = "2026-09-21T09:30:00Z"; // Mon 15:00 IST
export const TG = "111";
export const WA = "919";

export class StepClock implements Clock {
  readonly tz: string;
  private t: number;
  constructor(iso: string, tz = "Asia/Kolkata") {
    this.t = Date.parse(iso);
    this.tz = tz;
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Script {
  plan?: unknown | unknown[];
  compose?: string;
}

/** A Brain that answers the current turn's scripted PLAN/COMPOSE; anything unscripted is recorded as unexpected. */
export function scripted() {
  let cur: Script = {};
  let planIdx = 0;
  const calls: BrainRequest[] = [];
  const unexpected: string[] = [];
  const brain: Brain = {
    async complete(req) {
      calls.push(req);
      const ok = (text: string) => ({ text, entry: "fake", model: "scripted", cached: false, ms: 1 });
      if (req.purpose === "plan" && cur.plan !== undefined) {
        const p = Array.isArray(cur.plan) ? cur.plan[Math.min(planIdx++, cur.plan.length - 1)] : cur.plan;
        return ok(typeof p === "string" ? p : JSON.stringify(p));
      }
      if (req.purpose === "compose" && cur.compose !== undefined) return ok(cur.compose);
      if (req.purpose === "summary") return ok("summary");
      unexpected.push(req.purpose ?? "other");
      return { text: "", entry: "deterministic", model: "none", cached: false, ms: 0 };
    },
  };
  return {
    brain,
    calls,
    unexpected,
    set(s: Script) {
      cur = s;
      planIdx = 0;
    },
  };
}

/** Counts every Store method call. */
export function counting(store: Store): { store: Store; n: () => number; reset: () => void; names: string[] } {
  const names: string[] = [];
  const proxy = new Proxy(store, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        names.push(String(prop));
        return (v as (...x: unknown[]) => unknown).apply(target, a);
      };
    },
  });
  return { store: proxy, n: () => names.length, reset: () => void names.splice(0), names };
}

export const cr = (what: string | null, when_text: string | null, at_local: string | null = null) => ({
  intent: "create_reminder",
  tools: [{ name: "create_reminder", args: { what, when_text, at_local } }],
  say: "",
  compose: false,
});
export const tool = (name: string, args: Record<string, unknown>, compose = false) => ({ intent: name, tools: [{ name, args }], say: "", compose });
export const talk = (intent: "smalltalk" | "help" | "unsupported", say: string) => ({ intent, tools: [], say, compose: false });

export interface Turn {
  reply: string;
  result: InboundResult;
  llm: number;
  tools: string[];
}

export function agent(o: { at?: string; brain?: boolean; seed?: { tasks?: string[]; deadlines?: Partial<Deadline>[]; involvement?: unknown } } = {}) {
  const clock = new StepClock(o.at ?? AT);
  const sb = scripted();
  const base = testContext({ clock, brain: o.brain === false ? undefined : sb.brain, configPatch: { chat: { engine: "v3" } } });
  const cnt = counting(base.store);
  const ctx: AgentContext = { ...base, store: cnt.store };
  let seq = 0;
  const today = localDateOf(clock.now(), clock.tz);
  const seedAll = async () => {
    for (const title of o.seed?.tasks ?? []) {
      const t: Task = {
        id: `t:${title}`, title, status: "open", dueDate: today, createdDate: today, firstDate: today, rollCount: 0,
        doneAt: null, recurrence: null, source: "chat", notePath: `Tasks/${today}.md`,
      };
      await base.store.upsertTask(t);
    }
    for (const d of o.seed?.deadlines ?? []) {
      await base.store.upsertDeadline({
        id: d.id ?? `seed:${d.title}`, source: d.source ?? "manual", sourceRef: "x", title: d.title ?? "x", dueAt: d.dueAt ?? AT,
        status: d.status ?? "open", confidence: d.confidence ?? 1, notePath: "", originChannel: d.originChannel ?? null, originPeer: d.originPeer ?? null,
      });
    }
    if (o.seed?.involvement) await base.store.kvSet("gh:involvement", JSON.stringify(o.seed.involvement), AT);
  };
  let seeded = false;
  return {
    ctx,
    clock,
    sb,
    cnt,
    async say(text: string, s: Script = {}, channel: "telegram" | "whatsapp" = "telegram"): Promise<Turn> {
      if (!seeded) {
        await seedAll();
        seeded = true;
      }
      sb.set(s);
      const before = sb.calls.length;
      const result = await runAgent(ctx, { channel, id: `m${++seq}`, from: channel === "telegram" ? TG : WA, text, at: clock.now().toISOString() });
      const tools = result.trace.toolsJson ? (JSON.parse(result.trace.toolsJson) as { name: string; ok: boolean }[]).filter((t) => t.ok).map((t) => t.name) : [];
      return { reply: result.reply ?? "", result, llm: sb.calls.length - before, tools };
    },
    async reminders(): Promise<{ title: string; local: string; status: string; origin: string | null }[]> {
      const ds = (await base.store.listDeadlines()).filter((d) => d.source === "chat");
      return ds.map((d) => ({
        title: d.title,
        local: `${localDateOf(new Date(d.dueAt), clock.tz)} ${localTimeOf(new Date(d.dueAt), clock.tz)}`,
        status: d.status,
        origin: d.originChannel ?? null,
      }));
    },
    async tasks(): Promise<string[]> {
      return (await base.store.listTasks({ status: ["open"] })).map((t) => t.title).sort();
    },
    async dialog(channel: "telegram" | "whatsapp" = "telegram") {
      const d = await base.store.getDialog(channel, channel === "telegram" ? TG : WA);
      return d && Date.parse(d.expiresAt) > clock.now().getTime() ? d : null;
    },
  };
}
