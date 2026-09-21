import { extractFromGmail } from "../deadlines/extract.ts";
import { extractWithLlm } from "../deadlines/llmExtract.ts";
import { fetchGmail, gmailToLlmPayload } from "../sources/gmail.ts";
import { upsertAndMaterialise } from "../reminders/engine.ts";
import { localDate } from "../time.ts";
import type { Deadline, JobSpec, VaultFile } from "../types.ts";
import { deadlineFiles } from "./github.ts";

export const pollGmail: JobSpec = {
  name: "poll:gmail",
  schedule: { everyMinutes: 30 },
  async run(ctx) {
    if (!ctx.config.gmail.enabled) return "disabled";
    const msgs = await fetchGmail(ctx);
    const { found, residue } = extractFromGmail(msgs, ctx);
    const proposed = await extractWithLlm(ctx, residue);

    const all: Deadline[] = [...found, ...proposed];
    // Deliberately no markStale for gmail:* — it would retire still-unconfirmed proposals.
    await upsertAndMaterialise(ctx, all);

    // One note per message that produced a deadline. Redacted fields only; never a body.
    const byId = new Map(msgs.map((m) => [m.id, m]));
    const notes: VaultFile[] = [];
    for (const d of [...found, ...proposed]) {
      const m = byId.get(d.id.replace(/^gmail:(?:llm:)?/, ""));
      if (!m) continue;
      const p = gmailToLlmPayload(m);
      notes.push({
        path: d.notePath,
        content:
          `---\nsource: gmail\nstatus: ${d.status}\ndue: ${d.dueAt}\n---\n\n# ${d.title}\n\n` +
          `- From: ${p.from}\n- Date: ${p.date}\n- Subject: ${p.subject}\n- Snippet: ${p.snippet}\n` +
          `- [Open in Gmail](${d.sourceRef})\n`,
      });
    }

    const changed = await ctx.vault.writeFiles(`poll:gmail ${localDate(ctx.clock)}`, [
      ...notes,
      ...(await deadlineFiles(ctx)),
    ]);
    return `msgs=${msgs.length} found=${found.length} proposed=${proposed.length} changed=${changed.length}`;
  },
};
