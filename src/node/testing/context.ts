// Builds a fully offline AgentContext around a real in-memory SqliteStore.
// ARCHITECT-OWNED: builder packages import from here and never edit this file.
import { FixedClock } from "../../core/clock.ts";
import { parseConfig } from "../../core/config.ts";
import { MemoryVault, offlineFetch } from "../../core/testing/fakes.ts";
import type { AgentContext } from "../../core/types.ts";
import { SqliteStore } from "../store/sqlite.ts";

export interface TestContextOptions extends Partial<AgentContext> {
  /** Raw config object, merged through parseConfig so defaults and validation apply. */
  configPatch?: Record<string, unknown>;
  at?: string; // ISO instant for the FixedClock
  tz?: string;
}

/** Default: frozen clock, in-memory db, in-memory vault, no network, no brain, no channels. */
export function testContext(o: TestContextOptions = {}): AgentContext {
  const tz = o.tz ?? "Asia/Kolkata";
  const clock = o.clock ?? new FixedClock(o.at ?? "2026-09-20T04:30:00Z", tz);
  const config = o.config ?? parseConfig({ timezone: tz, ...o.configPatch });
  return {
    store: o.store ?? new SqliteStore(":memory:", clock),
    vault: o.vault ?? new MemoryVault(),
    clock,
    fetch: o.fetch ?? offlineFetch,
    config,
    env: o.env ?? (() => undefined),
    runtime: o.runtime ?? "cli",
    brain: o.brain,
    channels: o.channels,
    githubToken: o.githubToken ?? (async () => "test-token"),
    requestCount: o.requestCount,
  };
}
