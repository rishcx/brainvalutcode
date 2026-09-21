import { sha256Hex } from "../crypto.ts";
import type { BrainRequest } from "../types.ts";

/** Stable key over everything that can change the answer. Prefixed for the shared cache table. */
export async function cacheKey(entryName: string, model: string, req: BrainRequest): Promise<string> {
  const canonical = JSON.stringify([
    entryName,
    model,
    req.system ?? "",
    req.prompt,
    req.jsonSchema === undefined ? "" : JSON.stringify(req.jsonSchema),
  ]);
  return `llm:${await sha256Hex(canonical)}`;
}
