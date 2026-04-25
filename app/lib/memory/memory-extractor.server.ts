import { MemoryCategory } from "@prisma/client";
import { z } from "zod";

import { GEMINI_MEMORY_MODEL, getGeminiClient } from "../agent/gemini.server";
import { log } from "../log.server";
import { upsertMemory } from "./store-memory.server";

// Fire-and-forget extractor. Called once per user→assistant cycle (NOT once
// per Gemini turn — multi-turn tool loops would otherwise burn 4–8 Flash-Lite
// calls per merchant message). On any error: log + swallow. The chat
// experience must never block on extraction.

const ExtractedItem = z.object({
  category: z.enum([
    "BRAND_VOICE",
    "PRICING_RULES",
    "PRODUCT_RULES",
    "CUSTOMER_RULES",
    "STORE_CONTEXT",
    "OPERATOR_PREFS",
  ]),
  key: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_]+$/, "key must be snake_case ([a-z0-9_]+)"),
  value: z.string().min(1).max(500),
});

const ExtractedArray = z.array(ExtractedItem).max(8);

const EXTRACTION_PROMPT = `You extract durable facts from a Shopify merchant's conversation with their AI assistant.

Categories:
- BRAND_VOICE — tone, style, language ("we use casual tone", "always exclamation points")
- PRICING_RULES — strategy, discount caps, currency rules ("never discount over 30%")
- PRODUCT_RULES — naming, description format, vendor rules ("titles must include the size")
- CUSTOMER_RULES — customer-facing communication rules
- STORE_CONTEXT — about the store ("coffee roaster in Toronto", "we ship internationally")
- OPERATOR_PREFS — how the merchant prefers to work ("always show me a preview first")

Rules:
- Extract ONLY durable facts the merchant stated explicitly. Skip questions, transient requests, and things the assistant said.
- Use canonical snake_case keys (brand_voice, store_location, default_discount_percent). The same key overwrites prior values, so prefer stable keys you would reuse for similar facts.
- Each value: short, declarative, under 500 characters.
- If nothing durable was stated, return [].
- Never invent or paraphrase. If the merchant didn't say it, don't extract it.

Output: ONLY a JSON array, no prose, no code fences. Example:
[{"category":"BRAND_VOICE","key":"brand_voice","value":"casual"}]
or
[]`;

export type ExtractInput = {
  storeId: string;
  userText: string;
  assistantText: string;
};

// Public: fire-and-forget. Always resolves; never throws.
export async function extractAndStoreMemory(input: ExtractInput): Promise<void> {
  if (!input.userText.trim()) return;

  try {
    const items = await runExtraction(input);
    for (const item of items) {
      await upsertMemory(input.storeId, {
        category: item.category as MemoryCategory,
        key: item.key,
        value: item.value,
      });
    }
    if (items.length > 0) {
      log.info("memory-extractor: stored facts", {
        storeId: input.storeId,
        count: items.length,
      });
    }
  } catch (err) {
    log.warn("memory-extractor: extraction failed (non-fatal)", {
      storeId: input.storeId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runExtraction(input: ExtractInput): Promise<z.infer<typeof ExtractedArray>> {
  const ai = getGeminiClient();

  const userMessage = `User said:\n${input.userText}\n\nAssistant said:\n${input.assistantText.trim() || "(no text response)"}`;

  const response = await ai.models.generateContent({
    model: GEMINI_MEMORY_MODEL,
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: EXTRACTION_PROMPT,
      responseMimeType: "application/json",
      maxOutputTokens: 1024,
    },
  });

  const text = response.text?.trim() ?? "";
  if (!text) return [];

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
      return [];
    }
  }

  const result = ExtractedArray.safeParse(parsed);
  return result.success ? result.data : [];
}
