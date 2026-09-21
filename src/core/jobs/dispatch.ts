// The job registry and the scheduler the 15-minute cron drives.
// ARCHITECT-OWNED except for the marked registry lines, which the integrator edits.
import { nextLocalTimeAfter } from "../time.ts";
import type { AgentContext, JobSpec, Schedule } from "../types.ts";
import { indexVault } from "../index/job.ts";
import { chatAgendaJob } from "./agenda.ts";
import { dailyChatJob } from "./chat.ts";
import { reconcileReminders } from "./reconcile.ts";
import { digestDaily } from "./digest.ts";
import { pollGmail } from "./gmail.ts";
import { pollGithub } from "./github.ts";
import { pollInvolvement } from "./involvement.ts";
import { syncManual } from "./manual.ts";
import { sweepReminders } from "./reminders.ts";
import { rolloverTasks } from "./tasks.ts";

/** Free-plan Workers allow 50 subrequests per invocation (fetch and, to be safe, D1); stop starting jobs at 25. */
export const TICK_REQUEST_BUDGET = 25;

/** Kept for the existing callers; AgentContext is the real name. */
export type Ctx = AgentContext;

// --- REGISTRY (integration step appends here) ---------------------------------
const SPECS: JobSpec[] = [pollGithub, digestDaily, syncManual, pollGmail, sweepReminders, rolloverTasks, pollInvolvement, indexVault, dailyChatJob, reconcileReminders, chatAgendaJob];
// -----------------------------------------------------------------------------

export const JOBS: Record<string, JobSpec> = Object.fromEntries(SPECS.map((s) => [s.name, s]));

/**
 * When a job should run again after `after`. Interval jobs are aligned to the whole minute `after` falls in, so a
 * run's duration never pushes the next slot past a cron tick (09:34:04 -> 09:35:00). Daily jobs use local time.
 */
export function nextRunAt(schedule: Schedule, after: Date, tz: string): Date {
  if ("everyMinutes" in schedule) {
    const M = 60_000; // whole minute + interval, never completion + interval
    return new Date(Math.floor(after.getTime() / M) * M + schedule.everyMinutes * M);
  }
  return nextLocalTimeAfter(after, tz, schedule.dailyAtLocal);
}

/** kv key holding the registry's job names; ensureJob runs only when it changes. */
export const SPEC_HASH_KEY = "jobs:specHash";

export async function dispatch(name: string, ctx: AgentContext): Promise<string> {
  const job = JOBS[name];
  if (!job) throw new Error(`unknown job "${name}". known: ${Object.keys(JOBS).join(", ")}`);
  return job.run(ctx);
}

export interface JobRunResult {
  name: string;
  status: "ok" | "error";
  detail: string;
}

/**
 * One tick of the cron: run every job whose next_run_at has passed, record the outcome and
 * reschedule it. A failing job is rescheduled too — otherwise it would run on every tick.
 */
export async function runDueJobs(ctx: AgentContext): Promise<JobRunResult[]> {
  const now = ctx.clock.now();
  // One kv read per tick instead of one ensureJob per registered job.
  const specHash = SPECS.map((s) => s.name).join(",");
  if ((await ctx.store.kvGet(SPEC_HASH_KEY)) !== specHash) {
    for (const spec of SPECS) await ctx.store.ensureJob(spec.name, now.toISOString());
    await ctx.store.kvSet(SPEC_HASH_KEY, specHash, now.toISOString());
  }
  const due = await ctx.store.dueJobs(now.toISOString());
  const out: JobRunResult[] = [];
  for (const row of due) {
    // Never start another job once this invocation has spent its share of the request budget; it stays due and
    // runs on the next tick. (The first job always runs, so a heavy job can't be starved forever.)
    if (out.length > 0 && (ctx.requestCount?.() ?? 0) >= TICK_REQUEST_BUDGET) break;
    const spec = JOBS[row.name];
    if (!spec) continue; // a renamed job leaves its row behind; ignore it
    // Anchor the next slot to the minute this run STARTED in (PLAN_V3 A.5): a run that crosses a minute boundary must
    // not skip the next tick.
    const started = ctx.clock.now();
    let result: JobRunResult;
    try {
      result = { name: spec.name, status: "ok", detail: await spec.run(ctx) };
    } catch (e) {
      result = { name: spec.name, status: "error", detail: e instanceof Error ? e.message : String(e) };
    }
    const at = ctx.clock.now();
    await ctx.store.recordJobRun(spec.name, at.toISOString(), result.status, result.detail);
    await ctx.store.setJobNextRun(spec.name, nextRunAt(spec.schedule, started, ctx.clock.tz).toISOString());
    out.push(result);
  }
  return out;
}
