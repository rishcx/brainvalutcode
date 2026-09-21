export type FrontmatterValue = string | number | boolean | string[];

const PLAIN = /^[A-Za-z0-9][\w .@+\-/]*$/;

/** YAML scalars from the outside world: quote anything that is not an obviously plain token. */
function scalar(v: string): string {
  return PLAIN.test(v) ? v : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

function value(v: FrontmatterValue): string {
  if (Array.isArray(v)) return `[${v.map(scalar).join(", ")}]`;
  return typeof v === "string" ? scalar(v) : String(v);
}

export function frontmatter(fields: Record<string, FrontmatterValue>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${value(v)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Titles come from the outside world: keep them on one line and out of markdown control syntax. */
export function clean(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\\/g, "\\\\") // first, or the escapes below get double-escaped
    .replace(/[[\]|`]/g, (c) => `\\${c}`)
    .trim();
}

/** Angle-bracket form when the URL would otherwise terminate the markdown link early. */
export const link = (text: string, url: string): string =>
  `[${clean(text)}](${/[()\s<>]/.test(url) ? `<${url.replace(/[<>]/g, "")}>` : url})`;
