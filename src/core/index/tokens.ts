// Tokenisation and per-note index entries. `tokenize` is a copy of qa/retrieve.ts#tokenize (parity-tested): the
// index must rank with the same vocabulary as the v1 path or answers would shift when the index turns on.

const STOP = new Set(
  ("the and for are but not you all any can had her was one our out has have what when where which who whom why how " +
    "this that these those with from into about does did done will would should could there their them then than " +
    "been being were your mine its his she him too very just also over under again more most some such only own same " +
    "tell show give find note notes").split(" "),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

const MAX_TOKENS = 400;
const EXCERPT_CHARS = 600;

export function buildEntry(path: string, content: string): { title: string; tokens: string; excerpt: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  const body = m ? content.slice(m[0].length) : content;
  const stem = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || stem;

  const freq = new Map<string, number>();
  for (const t of tokenize(`${title} ${body}`)) freq.set(t, (freq.get(t) ?? 0) + 1);
  const tokens = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_TOKENS)
    .map(([t]) => t)
    .join(" ");

  return { title, tokens, excerpt: body.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS) };
}

/** Git blob id: sha1("blob <bytes>\0" + content). Lets the indexer compare against a tree listing without reading. */
export async function blobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head, 0);
  all.set(body, head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
