import { getGeminiClient } from "./gemini.server";
import { log } from "../log.server";

// V4.2 — Gemini text-embedding-004 wrapper. Used by Phase 4.3's
// retrieval-at-conversation-start (embed the merchant's first user
// message; cosine-compare against the Decision journal) and by the
// post-stream lazy tick in api.chat.tsx (embed pending Decision rows
// 1-2 per request to avoid blocking response latency).
//
// 768-dim float vectors. Free tier on the Gemini API; the rate limit
// is generous enough that we don't need batching for our scale —
// per-request lazy ticks distribute the load naturally across merchant
// activity.

export const EMBEDDING_MODEL = "text-embedding-004";
export const EMBEDDING_DIM = 768;

// Embed a single string. Returns the 768-dim float vector, or null on
// any failure (network, schema, rate limit). Callers MUST handle null —
// embeddings are best-effort and chat experience never blocks on them.
export async function embedText(text: string): Promise<number[] | null> {
  if (!text || text.trim().length === 0) return null;

  try {
    const ai = getGeminiClient();
    const result = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text,
    });
    const values = result.embeddings?.[0]?.values;
    if (!values || values.length === 0) {
      log.warn("embedText returned empty vector", {
        textPreview: text.slice(0, 60),
      });
      return null;
    }
    if (values.length !== EMBEDDING_DIM) {
      log.warn("embedText returned unexpected dim", {
        expected: EMBEDDING_DIM,
        got: values.length,
      });
      // Don't reject — store what we got. The model may have shifted
      // dimensions on a future API revision; cosine still works as long
      // as both vectors have the same dim.
    }
    return values;
  } catch (err) {
    log.warn("embedText failed", {
      err: err instanceof Error ? err.message : String(err),
      textPreview: text.slice(0, 60),
    });
    return null;
  }
}

// Build the embedding source for a Decision row. Combines category +
// hypothesis + outcome (when available) so the vector captures both
// "what the CEO tried" and "what happened" — improving semantic match
// on retrieval. For decisions with outcome pending, the hypothesis
// alone carries the meaning.
//
// Pure function — exported for testing.
export function buildDecisionEmbeddingSource(opts: {
  category: string;
  hypothesis: string;
  expectedOutcome: string;
  actualOutcome: string | null;
}): string {
  const outcome = opts.actualOutcome ?? `pending: ${opts.expectedOutcome}`;
  return `${opts.category}: ${opts.hypothesis} → ${outcome}`;
}
