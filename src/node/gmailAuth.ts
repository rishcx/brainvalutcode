// Mac-only loopback OAuth bootstrap. Prints the refresh token once; writes nothing to disk.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const b64url = (b: Buffer): string => b.toString("base64url");

export async function gmailAuthCli(): Promise<void> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId) throw new Error("missing env var GMAIL_CLIENT_ID");
  if (!clientSecret) throw new Error("missing env var GMAIL_CLIENT_SECRET");

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const server = createServer();
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  console.log(`Open this URL in your browser and approve read-only Gmail access:\n\n${url}\n`);

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for consent (5 min)")), 300_000);
      server.on("request", (req, res) => {
        const u = new URL(req.url ?? "/", redirect);
        if (u.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const fail = (msg: string): void => {
          res.writeHead(400, { "content-type": "text/plain" }).end(msg);
          clearTimeout(timer);
          reject(new Error(msg));
        };
        if (u.searchParams.get("state") !== state) return fail("state mismatch");
        const c = u.searchParams.get("code");
        if (!c) return fail(`authorization failed: ${u.searchParams.get("error") ?? "no code"}`);
        res.writeHead(200, { "content-type": "text/plain" }).end("Done. You can close this tab.");
        clearTimeout(timer);
        resolve(c);
      });
    });

    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect,
        code_verifier: verifier,
      }).toString(),
    });
    if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status}`);
    const j = (await r.json()) as { refresh_token?: string };
    if (!j.refresh_token) throw new Error("no refresh_token returned; revoke prior access and retry");
    console.log("Store this in your own .env (it is shown once and not saved anywhere):\n");
    console.log(`GMAIL_REFRESH_TOKEN=${j.refresh_token}`);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}
