import { getGeminiClient } from "./gemini.server";
import { log } from "../log.server";

// V4.2 / V8 — Gemini embedding wrapper. Used by Phase 4.3's
// retrieval-at-conversation-start (embed the merchant's first user
// message; cosine-compare against the Decision journal) and by the
// post-stream lazy tick in api.chat.tsx (embed pending Decision rows
// 1-2 per request to avoid blocking response latency).
//
// V8 — switched from `text-embedding-004` to `gemini-embedding-001`.
// The older model is still listed in some Google docs but has been
// silently failing in production (6 decisions stuck on
// embeddingPending: true after 100+ chat turns that should have fired
// the lazy tick). gemini-embedding-001 is the current generation;
// returns 3072 dims natively, but we use outputDimensionality:768
// to match the existing Decision.embedding column shape — same cosine
// geometry as before, no schema migration needed.
//
// Free tier rate limit on embeddings is generous (1500 RPM); per-
// request lazy ticks distribute the load naturally across merchant
// activity.

export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIM = 768;

// Embed a single string. Returns the 768-dim float vector, or null on
// any failure (network, schema, rate limit, model deprecation). Callers
// MUST handle null — embeddings are best-effort and chat experience
// never blocks on them.
//
// Logs at WARN level on failure with model name, error class, error
// message, and a short text preview. The class info is the diagnostic
// that catches model-deprecation regressions early (which is what
// silently broke v4.2 embedding under text-embedding-004 — the SDK
// was throwing an Error subclass without a useful `.message`, so the
// old log was effectively "embedText failed: " with no detail).
export async function embedText(text: string): Promise<number[] | null> {
  if (!text || text.trim().length === 0) return null;

  try {
    const ai = getGeminiClient();
    const result = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text,
      config: {
        outputDimensionality: EMBEDDING_DIM,
      },
    });
    const values = result.embeddings?.[0]?.values;
    if (!values || values.length === 0) {
      log.warn("embedText returned empty vector", {
        model: EMBEDDING_MODEL,
        textPreview: text.slice(0, 60),
      });
      return null;
    }
    if (values.length !== EMBEDDING_DIM) {
      log.warn("embedText returned unexpected dim", {
        model: EMBEDDING_MODEL,
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
      model: EMBEDDING_MODEL,
      errorClass: err?.constructor?.name ?? "Unknown",
      errorMessage: err instanceof Error ? err.message : String(err),
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
