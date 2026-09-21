// Renders the involvement snapshot. Deterministic by construction: no wall clock, no fetchedAt, no relative ages,
// so unchanged data is byte-identical and the vault commit is a no-op.
import type { Bucket, InvolvementItem, InvolvementSnapshot } from "../sources/involvement.ts";
import { clean, frontmatter } from "./markdown.ts";

export const INVOLVEMENT_NOTE_PATH = "GitHub/involvement.md";

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SCOPE = "your repos and public repos of other owners; private org repos are not visible to this token";
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

/**
 * Titles are untrusted. The result is safe inside markdown link text on a single line; it is data and is never
 * interpreted. Order matters: clean() escapes markdown first, everything after only removes or replaces.
 */
export function safeText(s: string, max = 120): string {
  let t = clean(s)
    .replace(CONTROL, "")
    .replace(/^[\s#>!\-*+=]+/, "")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .trim();
  if (t.length > max) t = `${t.slice(0, Math.max(0, max - 1))}…`;
  // A cut must not leave a dangling backslash: it would escape the "]" that closes the link text.
  const trailing = /\\+$/.exec(t)?.[0].length ?? 0;
  if (trailing % 2 === 1) t = t.slice(0, -1);
  return t || "(untitled)";
}

const day = (iso: string): string => iso.slice(0, 10);

const itemLine = (i: InvolvementItem): string => `- [${i.repo} #${i.number} ${safeText(i.title)}](${i.url}) — ${day(i.updatedAt)}`;

const SECTIONS: [Bucket, string][] = [
  ["reviewRequests", "Review requested"],
  ["assignedIssues", "Assigned issues"],
  ["myOpenPrs", "My open PRs"],
  ["mentions", "Mentions"],
];

export function renderInvolvementNote(s: InvolvementSnapshot, maxPerBucket: number): string {
  const fm = frontmatter({
    type: "github-involvement",
    login: s.login,
    scope: SCOPE,
    ...(s.partial.length ? { partial: s.partial } : {}),
    review_requests: s.totals.reviewRequests,
    assigned_issues: s.totals.assignedIssues,
    open_prs: s.totals.myOpenPrs,
    mentions: s.totals.mentions,
  });
  const out = [fm, "# GitHub involvement", ""];
  for (const [b, title] of SECTIONS) {
    const items = s[b].slice(0, maxPerBucket);
    out.push(`## ${title} (${items.length} of ${s.totals[b]})`, "");
    if (s.partial.includes(b)) out.push("_unavailable this run (showing last good data)_", "");
    if (items.length) out.push(...items.map(itemLine));
    else out.push("_none_");
    out.push("");
  }
  out.push("## Recently contributed repos", "");
  if (s.partial.includes("recentRepos")) out.push("_unavailable this run (showing last good data)_", "");
  const repos = s.recentRepos.filter((r) => REPO_RE.test(r.fullName));
  if (repos.length) out.push(...repos.map((r) => `- [${r.fullName}](https://github.com/${r.fullName}) — ${day(r.lastActivityAt)}`));
  else out.push("_none_");
  return `${out.join("\n")}\n`;
}

/** Compact JSON for kv. Titles cut to 80 chars; trailing items dropped until it fits. */
export function serialiseSnapshot(s: InvolvementSnapshot, maxBytes = 3000): string {
  const copy: InvolvementSnapshot = {
    ...s,
    assignedIssues: s.assignedIssues.map((i) => ({ ...i, title: i.title.slice(0, 80) })),
    myOpenPrs: s.myOpenPrs.map((i) => ({ ...i, title: i.title.slice(0, 80) })),
    reviewRequests: s.reviewRequests.map((i) => ({ ...i, title: i.title.slice(0, 80) })),
    mentions: s.mentions.map((i) => ({ ...i, title: i.title.slice(0, 80) })),
    recentRepos: [...s.recentRepos],
  };
  const size = (): number => new TextEncoder().encode(JSON.stringify(copy)).length;
  const order: (Bucket | "recentRepos")[] = ["recentRepos", "mentions", "myOpenPrs", "assignedIssues", "reviewRequests"];
  for (const k of order) {
    while (size() > maxBytes && copy[k].length > 0) copy[k].pop();
  }
  return JSON.stringify(copy);
}

export function renderInvolvementDigestSection(s: InvolvementSnapshot | null, maxPerBucket: number): string {
  if (!s) return "";
  const all: Bucket[] = ["reviewRequests", "assignedIssues", "myOpenPrs", "mentions"];
  if (all.every((b) => s[b].length === 0 && s.totals[b] === 0)) return "";
  const lines = [
    "## GitHub involvement",
    "",
    `${s.totals.reviewRequests} review requests · ${s.totals.assignedIssues} assigned issues · ${s.totals.myOpenPrs} open PRs · ${s.totals.mentions} mentions`,
    ...s.reviewRequests.slice(0, maxPerBucket).map((i) => `- Review: ${itemLine(i).slice(2)}`),
    ...s.assignedIssues.slice(0, maxPerBucket).map((i) => `- Assigned: ${itemLine(i).slice(2)}`),
  ];
  return `${lines.join("\n")}\n`;
}
