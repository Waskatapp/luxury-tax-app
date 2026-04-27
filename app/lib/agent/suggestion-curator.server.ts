import { z } from "zod";

import { log } from "../log.server";
import { GEMINI_MEMORY_MODEL, getGeminiClient } from "./gemini.server";
import type { Candidate, Signals, Suggestion } from "./suggestions.server";

// Picks 3-4 from a heuristic top-8 and may rewrite each label in the
// merchant's brand voice. NEVER changes the prompt text or templateId —
// those stay stable so SuggestionEvent telemetry remains coherent.
//
// Hardened: 600ms AbortController timeout, Zod-validated response, drops any
// templateId not in the input set. Returns null on any failure → orchestrator
// falls back to heuristic top 4. Same posture as memory-extractor.server.ts.

const CURATOR_TIMEOUT_MS = 600;
const MIN_VALID_RESULTS = 3;
const MAX_LABEL_CHARS = 60;

const CuratorItem = z.object({
  templateId: z.string().min(1).max(80),
  label: z.string().min(1).max(MAX_LABEL_CHARS),
});

const CuratorArray = z.array(CuratorItem).min(MIN_VALID_RESULTS).max(4);

export async function curateWithFlashLite(
  candidates: Candidate[],
  signals: Signals,
): Promise<Suggestion[] | null> {
  if (candidates.length < MIN_VALID_RESULTS) return null;

  const allowedIds = new Set(candidates.map((c) => c.id));
  const candidatesById = new Map(candidates.map((c) => [c.id, c] as const));

  const userMessage = buildUserMessage(candidates, signals);
  const systemInstruction = buildSystemInstruction(signals);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CURATOR_TIMEOUT_MS);

  let text: string;
  try {
    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: GEMINI_MEMORY_MODEL,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        maxOutputTokens: 512,
        abortSignal: controller.signal,
      },
    });
    text = response.text?.trim() ?? "";
  } catch (err) {
    log.warn("suggestion-curator: call failed (non-fatal)", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Flash-Lite occasionally wraps in code fences despite responseMimeType.
    const stripped = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return null;
    }
  }

  const result = CuratorArray.safeParse(parsed);
  if (!result.success) return null;

  // Drop hallucinated IDs; keep order Flash-Lite returned.
  const filtered = result.data.filter((item) => allowedIds.has(item.templateId));
  if (filtered.length < MIN_VALID_RESULTS) return null;

  // De-dupe in case Flash-Lite returned the same templateId twice.
  const seen = new Set<string>();
  const final: Suggestion[] = [];
  for (const item of filtered) {
    if (seen.has(item.templateId)) continue;
    seen.add(item.templateId);
    const candidate = candidatesById.get(item.templateId);
    if (!candidate) continue;
    final.push({
      templateId: item.templateId,
      label: item.label.trim(),
      prompt: candidate.prompt,
    });
  }

  return final.length >= MIN_VALID_RESULTS ? final : null;
}

function buildSystemInstruction(signals: Signals): string {
  const brandVoice = signals.brandVoiceText
    ? `\n\nBrand voice the merchant has set: "${signals.brandVoiceText}". When you rewrite labels, lean into this voice.`
    : "";
  return `You pick 3-4 suggested prompts for a Shopify merchant's Copilot chat welcome screen.

You will be given 8 candidate prompts (each with a stable templateId, default label, and category) plus a few signals about the store and the current time.

Your job:
1. Pick the 3-4 most relevant for THIS merchant in THIS moment.
2. You MAY rewrite the label to be more natural, conversational, and tailored — but keep it under ${MAX_LABEL_CHARS} characters and under 8 words.
3. NEVER change the templateId. NEVER invent a templateId that isn't in the candidate list.

Prefer:
- Variety across categories (don't pick 4 analytics prompts).
- Time-appropriate phrasing (e.g. "today" / "this week" rather than vague time references).
- Concise, plain English. No emoji. No exclamation marks.${brandVoice}

Output JSON array only. No prose. No code fences. Shape:
[{"templateId":"<id>","label":"<short label>"}, ...]`;
}

function buildUserMessage(candidates: Candidate[], signals: Signals): string {
  const candidateLines = candidates
    .map(
      (c) =>
        `- templateId: ${c.id} | category: ${c.category} | default label: "${c.label}"`,
    )
    .join("\n");

  const signalLines = [
    `store age: ${signals.storeAgeHours < 24 ? "new (under 24h)" : signals.storeAgeHours < 168 ? "less than 1 week" : "established"}`,
    `products: ${signals.productCount > 0 ? "has products" : "no products yet"}`,
    `drafts: ${signals.draftCount}`,
    `low-stock variants: ${signals.lowStockCount}`,
    `memory entries: ${signals.memoryCount}`,
    `time: ${signals.isWeekend ? "weekend" : signals.isBusinessHours ? "business-hours weekday" : signals.dayOfWeek === 5 && signals.hourOfDay >= 17 ? "Friday evening" : "off-hours weekday"}`,
    `recent merchant actions (last 24h): ${
      signals.recentTools.length > 0
        ? signals.recentTools
            .filter((t) => t.hoursAgo < 24)
            .map((t) => t.name)
            .slice(0, 5)
            .join(", ") || "none"
        : "none"
    }`,
  ].join("\n");

  return `Candidates:\n${candidateLines}\n\nStore signals:\n${signalLines}\n\nReturn 3-4 picks as JSON.`;
}
