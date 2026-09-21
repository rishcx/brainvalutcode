// Renders msg_trace rows for the `trace [n]` chat command and the CLI. Web-standard only.
import { localTimeOf } from "../time.ts";
import type { TraceRow } from "../types.ts";

const CHANNEL_SHORT: Record<string, string> = { telegram: "tg", whatsapp: "wa" };

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3))}...`;
}

/** One line per row, newest first: `15:31 wa plan create_reminder ok 1.1s "Reminder set: call mom..."`. */
export function renderTrace(rows: TraceRow[], tz: string): string {
  if (rows.length === 0) return "No trace yet.";
  const ordered = [...rows].sort((a, b) => b.id - a.id);
  return ordered
    .map((r) => {
      const time = localTimeOf(new Date(r.at), tz);
      const ch = CHANNEL_SHORT[r.channel] ?? r.channel;
      const delivery = r.delivery === "ok" ? "ok" : truncate(r.delivery, 30);
      const latency = `${(r.latencyMs / 1000).toFixed(1)}s`;
      const preview = truncate(r.replyPreview ?? "", 60);
      return `${time} ${ch} ${r.route} ${r.intent ?? "-"} ${delivery} ${latency} "${preview}"`;
    })
    .join("\n");
}
