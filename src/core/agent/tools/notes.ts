// add_note (audit A): "note that ..." / "save this: ..." -> one file under the agent-owned Inbox/ prefix, indexed
// at once so search_notes finds it in the same session. The body is the user's own words (provenance), never a
// model paraphrase, and Inbox/<timestamp>.md is written whole: no read-modify-write against the vault.
import { oneLine } from "../../channels/format.ts";
import { blobSha, buildEntry } from "../../index/tokens.ts";
import { localDateOf, localTimeOf } from "../../time.ts";
import type { AgentContext } from "../../types.ts";
import type { ToolResult } from "../contract.ts";
import { question } from "../dialog.ts";
import { matchSpan } from "../provenance.ts";
import type { ToolEnv } from "./index.ts";

const MAX_BODY = 2000;
const LEAD = /^(?:(?:please|pls)\s+)?(?:note|save|remember|jot)?\s*(?:this|that|it|down)?\s*[:\-]?\s*/i;

export async function addNote(ctx: AgentContext, args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult> {
  const raw = typeof args.text === "string" ? args.text : "";
  const span = raw ? matchSpan(raw, env.sources) : null;
  if (span === null) {
    const flags = raw ? ["provenance_miss:text"] : [];
    return { ok: false, missing: ["text"], flags, render: question("text", {}), data: { slots: {} } };
  }
  const body = span.replace(LEAD, "").replace(/\s+/g, " ").trim().slice(0, MAX_BODY);
  if (!body) return { ok: false, missing: ["text"], render: question("text", {}), data: { slots: {} } };

  const now = env.now;
  const tz = ctx.clock.tz;
  const date = localDateOf(now, tz);
  const path = `Inbox/${date}-${localTimeOf(now, tz).replace(":", "")}-${env.msg.id.replace(/[^\w-]/g, "").slice(0, 16) || "note"}.md`;
  const title = body.split(/[.!?\n]/)[0]!.slice(0, 60) || "Note";
  const content = `---\ntype: note\ndate: ${date}\nsource: chat\n---\n\n# ${title}\n\n${body}\n`;
  await ctx.vault.writeFiles(`note: ${date}`, [{ path, content }]); // throws -> safe() renders "nothing was changed"
  try {
    await ctx.store.upsertNote({ path, sha: await blobSha(content), ...buildEntry(path, content), updatedAt: now.toISOString() });
  } catch {
    /* the note is saved; the next index run picks it up */
  }
  return { ok: true, entityId: path, title, render: `Noted: ${oneLine(title)}` };
}
