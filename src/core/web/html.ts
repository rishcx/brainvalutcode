// Server-rendered HTML, zero JS. Every dynamic value goes through esc().
export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const CSS =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1rem}" +
  "textarea{width:100%;min-height:60vh;font:14px/1.4 ui-monospace,monospace;box-sizing:border-box}" +
  "input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:.5rem}" +
  "button{padding:.5rem 1rem}.note{background:#e8f5e9;padding:.5rem}.err{background:#fdecea;padding:.5rem}" +
  "li{margin:.25rem 0;word-break:break-all}";

export function page(title: string, body: string, status = 200, extra: Record<string, string> = {}): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>` +
    `<style>${CSS}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
}

export function redirect(location: string, extra: Record<string, string> = {}, cookies: string[] = []): Response {
  const h = new Headers({ location, ...SECURITY_HEADERS, ...extra });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 303, headers: h });
}

export const csrfField = (csrf: string): string => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

export const loginPage = (error?: string, status = 200): Response =>
  page(
    "Login",
    `<h1>Brain</h1>${error ? `<p class="err">${esc(error)}</p>` : ""}` +
      `<form method="post" action="/login"><label>Password<br>` +
      `<input type="password" name="password" autocomplete="current-password" required></label>` +
      `<p><button type="submit">Log in</button></p></form>`,
    status,
  );

export function listPage(paths: string[], csrf: string): Response {
  const items = paths
    .map((p) => `<li><a href="/edit/file?path=${encodeURIComponent(p)}">${esc(p)}</a></li>`)
    .join("");
  return page(
    "Notes",
    `<h1>Notes</h1><ul>${items || "<li>(no files)</li>"}</ul>` +
      `<h2>New note</h2><form method="get" action="/edit/file"><input type="text" name="path" ` +
      `placeholder="Notes/my note.md" required><p><button type="submit">Open</button></p></form>` +
      `<form method="post" action="/logout">${csrfField(csrf)}<button type="submit">Log out</button></form>`,
  );
}

export function editorPage(o: { path: string; sha: string; csrf: string; content: string; saved: boolean }): Response {
  return page(
    o.path,
    `<p><a href="/edit">&larr; all notes</a></p><h1>${esc(o.path)}</h1>` +
      (o.saved ? `<p class="note">Saved.</p>` : "") +
      `<form method="post" action="/edit/save">${csrfField(o.csrf)}` +
      `<input type="hidden" name="path" value="${esc(o.path)}"><input type="hidden" name="sha" value="${esc(o.sha)}">` +
      // The HTML parser drops one leading newline inside <textarea>; emit one to preserve the user's own.
      `<textarea name="content" spellcheck="false">\n${esc(o.content)}</textarea>` +
      `<p><button type="submit">Save</button></p></form>`,
  );
}

export function conflictPage(path: string, content: string): Response {
  return page(
    "Conflict",
    `<h1>Conflict</h1><p class="err">${esc(path)} changed since you opened it. Nothing was saved. ` +
      `Your text is kept below; copy it, then reload.</p>` +
      `<p><a href="/edit/file?path=${encodeURIComponent(path)}">Reload the current version</a></p>` +
      `<textarea readonly>\n${esc(content)}</textarea>`,
    409,
  );
}

export const errorPage = (status: number, message: string, extra: Record<string, string> = {}): Response =>
  page(`Error ${status}`, `<h1>${status}</h1><p class="err">${esc(message)}</p><p><a href="/edit">Back</a></p>`, status, extra);
