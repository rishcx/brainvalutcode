// Offline test doubles. Pure + web-standard, so package tests can use them anywhere.
// ARCHITECT-OWNED: builder packages import from here and never edit this file.
import type { Channel, ChannelId, Fetcher, VaultFile, VaultWriter } from "../types.ts";
import { assertWritable } from "../vault/paths.ts";

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface FakeRoute {
  /** Substring or pattern tested against the full URL. */
  match: string | RegExp;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** How many times this route may answer before it is exhausted. Default: unlimited. */
  times?: number;
}

export interface FakeFetch {
  (url: string, init?: RequestInit): Promise<Response>;
  readonly calls: FakeCall[];
}

const hit = (url: string, m: string | RegExp): boolean =>
  typeof m === "string" ? url.includes(m) : m.test(url);

/**
 * A Fetcher backed by a route table. An unmatched request throws loudly rather than
 * returning a 404, because a test that silently talks to the wrong URL proves nothing.
 */
export function fakeFetch(routes: FakeRoute[]): FakeFetch {
  const left = routes.map((r) => r.times ?? Number.POSITIVE_INFINITY);
  const calls: FakeCall[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const i = routes.findIndex((r, idx) => left[idx]! > 0 && hit(url, r.match));
    if (i < 0) throw new Error(`fakeFetch: no route for ${init?.method ?? "GET"} ${url}`);
    left[i]!--;
    const r = routes[i]!;
    const body = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
    return new Response(body, {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...r.headers },
    });
  };
  return Object.assign(fn, { calls }) as FakeFetch;
}

/** In-memory VaultWriter with the real write allowlist. */
export class MemoryVault implements VaultWriter {
  readonly files = new Map<string, string>();
  readonly commits: string[] = [];

  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async listFiles(prefix = ""): Promise<string[]> {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  async writeFiles(message: string, files: VaultFile[]): Promise<string[]> {
    for (const f of files) assertWritable(f.path);
    const changed: string[] = [];
    for (const f of files) {
      if (this.files.get(f.path) === f.content) continue;
      this.files.set(f.path, f.content);
      changed.push(f.path);
    }
    if (changed.length) this.commits.push(message);
    return changed;
  }
}

/** Records what a channel was asked to send; never touches the network. */
export class MemoryChannel implements Channel {
  readonly id: ChannelId;
  readonly sent: string[] = [];
  constructor(id: ChannelId) {
    this.id = id;
  }
  /** Per-peer deliveries (V3-1): peer -> texts, in order. `sent` also records them for older assertions. */
  readonly sentTo: { peer: string; text: string }[] = [];
  readonly typed: string[] = [];
  async send(text: string): Promise<void> {
    this.sent.push(text);
  }
  async sendTo(peer: string, text: string): Promise<void> {
    this.sentTo.push({ peer, text });
    this.sent.push(text);
  }
  async typing(peer: string): Promise<void> {
    this.typed.push(peer);
  }
}

/** A Fetcher that fails every call: proves a code path is offline. */
export const offlineFetch: Fetcher = async (url) => {
  throw new Error(`network disabled in tests: ${url}`);
};
