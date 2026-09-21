// Pure, deterministic markmap-ready Markdown. Job wiring is not part of P5.
interface MindmapInput {
  deadlines: { title: string; category?: string; dueAt: string }[];
  tasks: { title: string; status: string }[];
  notes: string[];
}

/** Titles come from mail/GitHub: neutralise HTML and markdown syntax, keep one line. */
const clean = (s: string): string =>
  s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
    .replace(/[\\`*_{}[\]()#+!|~]/g, (c) => `\\${c}`);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function renderMindmap(i: MindmapInput): string {
  const out: string[] = ["# Brain", ""];
  out.push("## Deadlines", "");
  const cats = new Map<string, { title: string; dueAt: string }[]>();
  for (const d of i.deadlines) {
    const c = clean(d.category ?? "") || "uncategorized";
    (cats.get(c) ?? cats.set(c, []).get(c)!).push(d);
  }
  for (const c of [...cats.keys()].sort(cmp)) {
    out.push(`### ${c}`, "");
    for (const d of cats.get(c)!.sort((a, b) => cmp(a.dueAt, b.dueAt) || cmp(a.title, b.title))) {
      out.push(`- ${clean(d.title)} (due ${clean(d.dueAt)})`);
    }
    out.push("");
  }
  out.push("## Tasks", "");
  const sts = new Map<string, string[]>();
  for (const t of i.tasks) {
    const s = clean(t.status) || "unknown";
    (sts.get(s) ?? sts.set(s, []).get(s)!).push(clean(t.title));
  }
  for (const s of [...sts.keys()].sort(cmp)) {
    out.push(`### ${s}`, "");
    for (const t of sts.get(s)!.sort(cmp)) out.push(`- ${t}`);
    out.push("");
  }
  out.push("## Notes", "");
  for (const n of i.notes.map(clean).sort(cmp)) out.push(`- ${n}`);
  return out.join("\n") + "\n";
}
