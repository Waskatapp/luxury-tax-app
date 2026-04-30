import type { StoreMemory } from "@prisma/client";
import { z } from "zod";

import prisma from "../../db.server";
import { GEMINI_MEMORY_MODEL, getGeminiClient } from "./gemini.server";
import { log } from "../log.server";

// V6.4 — Phase 6 Memory Hygiene. Periodic scan that detects contradictions
// across StoreMemory entries and surfaces them as Insights for merchant
// review. Catches the kind of mess that accumulates over time:
//
//   - merchant_name: Sam   AND   operator_name: Alex   (CEO can't address
//     them consistently — one is wrong, or one is stale)
//   - max_discount_percent: 30   AND   no_discounts_below: 35   (math
//     conflict; an action could be valid by one rule and not the other)
//   - brand_voice: "warm and casual"   AND   tone: "formal and direct"
//     (semantic clash; the CEO ends up writing in some confused middle)
//
// Detection strategy: send all entries to Flash-Lite as JSON, ask for
// pairs that conflict. The model is much better at semantic conflict
// detection than any heuristic regex would be. Cap the prompt size by
// truncating values past 200 chars (conflicts manifest in the FACT,
// not the prose).
//
// Output: structured array of conflicts. The cron writer
// (run-evaluator.ts) creates an Insight row per detected conflict
// with category="anomaly", but only if no anomaly Insight was created
// for this store in the last 7 days — keeps the merchant from being
// spammed with the same conflict on every scan.

const MIN_ENTRIES_TO_SCAN = 5;
const VALUE_TRUNCATE_AT = 200;
const SPAM_GUARD_DAYS = 7;

export type MemoryConflict = {
  type: "value-conflict" | "semantic-clash" | "duplicate-intent";
  keyA: string;
  keyB: string;
  reason: string; // one-line explanation, merchant-facing
};

const ConflictSchema = z.object({
  type: z.enum(["value-conflict", "semantic-clash", "duplicate-intent"]),
  keyA: z.string().min(1).max(200),
  keyB: z.string().min(1).max(200),
  reason: z.string().min(1).max(400),
});
const ConflictArraySchema = z.array(ConflictSchema).max(10);

const HYGIENE_PROMPT = `You scan a Shopify merchant's stored memory entries for CONTRADICTIONS. Each entry is a category + key + value. Two entries conflict when:

1. **value-conflict**: same conceptual fact, different values.
   Example: \`merchant_name: Sam\` and \`operator_name: Alex\` — both name the merchant; only one can be right.
   Example: \`max_discount_percent: 30\` and \`no_discounts_below: 35\` — math conflict.

2. **semantic-clash**: same domain, contradictory directives.
   Example: \`brand_voice: warm and casual\` and \`tone: formal and direct\` — clash on tone.
   Example: \`pricing_rules: never below cost+30%\` and \`pricing_rules: be aggressive on slow movers\` — clash on margin discipline.

3. **duplicate-intent**: two entries that fundamentally say the same thing under different keys, leading to bloat.
   Example: \`brand_voice: casual and witty\` and \`voice_guidelines: keep it casual\` — same instruction, two keys.

# Hard rules

- Goals (\`goal:active:*\` and \`goal:dormant:*\` keys) under STRATEGIC_GUARDRAILS are EXPECTED to coexist with other guardrails. Don't flag a goal as conflicting with a non-goal guardrail unless they directly contradict (e.g., goal: aggressive promo activity, guardrail: never discount).
- Don't flag entries that are MERELY similar but address different facets ("brand_voice" vs "product_description_style" — both about voice but different scope).
- If you can't identify a clear, defensible conflict, return [].
- The merchant's time is expensive. Be conservative — false positives erode trust faster than missed catches.

# Output format

JSON array. No prose. Up to 10 conflicts (hard cap). Each item:

{ "type": "value-conflict" | "semantic-clash" | "duplicate-intent",
  "keyA": "first key", "keyB": "second key",
  "reason": "one short sentence explaining the conflict in merchant-facing language" }

If no conflicts found, return [].`;

function summarizeEntry(e: StoreMemory): string {
  const value =
    e.value.length > VALUE_TRUNCATE_AT
      ? e.value.slice(0, VALUE_TRUNCATE_AT) + "…"
      : e.value;
  return `[${e.category}] ${e.key}: ${value}`;
}

// Pure: builds the user-message body that goes alongside HYGIENE_PROMPT.
// Exported for testing.
export function buildHygieneUserMessage(entries: StoreMemory[]): string {
  const lines = entries.map(summarizeEntry);
  return `Here are the stored memory entries:\n\n${lines.join("\n")}\n\nReturn the conflicts as a JSON array (or [] if none).`;
}

// Pure: parses Gemini's JSON output. Tolerates code fences, returns
// validated MemoryConflict[] or []. Never throws.
export function parseHygieneResponse(raw: string): MemoryConflict[] {
  if (!raw || raw.trim().length === 0) return [];

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    try {
      candidate = JSON.parse(stripped);
    } catch {
      return [];
    }
  }

  const result = ConflictArraySchema.safeParse(candidate);
  return result.success ? result.data : [];
}

// Calls Gemini Flash-Lite to detect conflicts. Returns [] on any failure
// (network, schema, rate limit) — never throws. Cron path must keep
// running even if one store's scan fails.
export async function findMemoryConflicts(
  entries: StoreMemory[],
): Promise<MemoryConflict[]> {
  if (entries.length < MIN_ENTRIES_TO_SCAN) return [];

  try {
    const ai = getGeminiClient();
    const userMessage = buildHygieneUserMessage(entries);

    const response = await ai.models.generateContent({
      model: GEMINI_MEMORY_MODEL,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: HYGIENE_PROMPT,
        responseMimeType: "application/json",
        maxOutputTokens: 1024,
      },
    });

    const text = response.text?.trim() ?? "";
    return parseHygieneResponse(text);
  } catch (err) {
    log.warn("memory-hygiene: scan failed (non-fatal)", {
      err: err instanceof Error ? err.message : String(err),
      entryCount: entries.length,
    });
    return [];
  }
}

// Spam guard: should we surface another anomaly Insight for this store?
// Returns true if no anomaly Insight was created in the last
// SPAM_GUARD_DAYS days. Bounded indexed query (storeId + createdAt index
// already exists on Insight per Phase 3.1 schema).
export async function shouldSurfaceAnomaly(
  storeId: string,
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(
    now.getTime() - SPAM_GUARD_DAYS * 24 * 60 * 60 * 1000,
  );
  const recent = await prisma.insight.findFirst({
    where: {
      storeId,
      category: "anomaly",
      createdAt: { gte: cutoff },
    },
    select: { id: true },
  });
  return recent === null;
}

// Render a conflict as the Insight body merchant will read in /settings/insights.
// Pure for testing.
export function formatConflictAsInsightBody(conflict: MemoryConflict): {
  title: string;
  body: string;
} {
  const typeLabel =
    conflict.type === "value-conflict"
      ? "Value conflict"
      : conflict.type === "semantic-clash"
        ? "Semantic clash"
        : "Duplicate intent";
  return {
    title: `${typeLabel}: ${conflict.keyA} vs ${conflict.keyB}`,
    body: `${conflict.reason}\n\nReview both entries at /app/settings/memory and either delete the stale one, merge them, or rename the one that doesn't fit.`,
  };
}
