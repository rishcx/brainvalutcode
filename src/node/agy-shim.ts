// Optional, user-triggered: exposes the local `agy` CLI as an OpenAI-compatible endpoint.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ShimOptions {
  agyBin?: string;
  timeoutMs?: number;
}

const MAX_BODY = 1_000_000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const fail = (res: http.ServerResponse, status: number, message: string): void =>
  send(res, status, { error: { message } });

function extractText(stdout: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof v === "string") return v || null;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["result", "response", "text", "output", "content"]) {
      if (typeof o[k] === "string" && o[k]) return o[k] as string;
    }
  }
  return null;
}

function runAgy(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Argument array, no shell: user text can never become a command.
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8_000_000, shell: false }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

export function createShimServer(opts: ShimOptions = {}): http.Server {
  const bin = opts.agyBin ?? "agy";
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return fail(res, 404, "not found");

      let body: {
        model?: unknown;
        messages?: { role?: unknown; content?: unknown }[];
        response_format?: { json_schema?: { schema?: unknown } };
      };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return fail(res, 400, "invalid json body");
      }
      const model = typeof body.model === "string" ? body.model : "";
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const prompt = msgs
        .filter((m) => typeof m.content === "string")
        .map((m) => (m.role === "system" ? `[system]\n${m.content}` : String(m.content)))
        .join("\n\n");
      if (!model || !prompt) return fail(res, 400, "model and messages are required");

      const args = ["-p", prompt, "--output-format", "json", "--model", model];
      const schema = body.response_format?.json_schema?.schema;
      let dir: string | null = null;
      let stdout: string;
      try {
        if (schema !== undefined) {
          dir = await mkdtemp(join(tmpdir(), "agy-shim-"));
          const file = join(dir, "schema.json");
          await writeFile(file, JSON.stringify(schema), "utf8");
          args.push("--json-schema", file);
        }
        stdout = await runAgy(bin, args, timeoutMs);
      } catch {
        return fail(res, 502, "agy invocation failed");
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }

      const text = extractText(stdout);
      if (text === null) return fail(res, 502, "unparseable agy output");
      return send(res, 200, {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      });
    } catch {
      if (!res.headersSent) fail(res, 500, "internal error");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.AGY_SHIM_PORT ?? 20129);
  createShimServer().listen(port, "127.0.0.1", () => console.log(`agy shim on http://127.0.0.1:${port}`));
}
