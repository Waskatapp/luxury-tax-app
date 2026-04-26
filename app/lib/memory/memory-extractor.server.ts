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

const EXTRACTION_PROMPT = `You extract DURABLE STORE-WIDE RULES from a Shopify merchant's conversation with their AI assistant. Most merchant messages are one-off requests, NOT rules — your default output is [].

Categories:
- BRAND_VOICE — voice, tone, language style ("we always write in a casual tone")
- PRICING_RULES — store-wide pricing strategy ("never discount more than 30%")
- PRODUCT_RULES — naming conventions, description format, vendor rules ("always include size in product titles")
- CUSTOMER_RULES — store-wide customer communication rules
- STORE_CONTEXT — facts about the store itself ("we are a coffee roaster in Toronto", "we ship internationally")
- OPERATOR_PREFS — how the merchant wants the Copilot to behave ("always show me a preview first", "keep answers short")

# HARD REQUIREMENT — only extract if a TRIGGER PHRASE is present

You MUST NOT extract anything unless the merchant uses one of these phrases (or close paraphrases) somewhere in their message:

- "always …"
- "never …"
- "remember …" / "remember that …"
- "from now on …"
- "by default …"
- "going forward …"
- "make sure you …"
- "we always …" / "we never …"
- "our brand …" / "our store …" (factual statement about the business itself)

If NONE of these patterns appear in the merchant's message, return [].

# DO NOT EXTRACT (anti-rules — these are the most common mistakes)

DO NOT extract anything from one-off action requests. These are transient, NOT rules:
- "Change the price of X to $20" → DO NOT extract {price: 20} or {price_change_without_id: true}
- "Update the description of Y" → DO NOT extract {product_update_identifier: ...}
- "Make this product active" → DO NOT extract anything
- "Show me my top products" → DO NOT extract anything
- "Create a discount for ..." → DO NOT extract {discount_amount: ...}

DO NOT extract specific values from a single request:
- Product names ("cat food", "snowboard"), variant IDs, prices, SKUs, dates, percentages — these belong to a single action, not a rule
- The store domain (e.g. "...myshopify.com") — that's metadata, not a fact the merchant stated
- Meta-information about how a request is phrased ("user_didnt_provide_id", "request_uses_product_name")

DO NOT extract from the assistant's text. The Assistant said: ... block is context, not a source of truth. Only extract what the MERCHANT explicitly stated.

DO NOT paraphrase or invent. If the merchant said "we ship to Canada", do not extract "international shipping = true". Use the merchant's words.

# Examples

Merchant: "Change the price of cat food to $20"
Output: []

Merchant: "Show me my top 5 products"
Output: []

Merchant: "Update the description on the snowboard product"
Output: []

Merchant: "Always keep your answers short and to the point"
Output: [{"category":"OPERATOR_PREFS","key":"answer_style","value":"short and to the point"}]

Merchant: "Our brand voice is warm and a bit cheeky — please remember that"
Output: [{"category":"BRAND_VOICE","key":"brand_voice","value":"warm and a bit cheeky"}]

Merchant: "Never discount more than 30%"
Output: [{"category":"PRICING_RULES","key":"max_discount_percent","value":"30"}]

Merchant: "From now on, all product titles should include the size"
Output: [{"category":"PRODUCT_RULES","key":"title_format","value":"include the size"}]

# Output format

JSON array only. No prose. No code fences. snake_case keys.

If nothing durable was stated, return: []`;

export type ExtractInput = {
  storeId: string;
  userText: string;
  assistantText: string;
};

export type SavedMemoryEntry = {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
};

// Always resolves; never throws. Returns the rows that were upserted so the
// caller can surface a toast (Phase: V1 polish Tier 3). Returns [] on any
// extraction failure — chat experience must never block on a parse error.
export async function extractAndStoreMemory(
  input: ExtractInput,
): Promise<SavedMemoryEntry[]> {
  if (!input.userText.trim()) return [];

  try {
    const items = await runExtraction(input);
    const saved: SavedMemoryEntry[] = [];
    for (const item of items) {
      const row = await upsertMemory(input.storeId, {
        category: item.category as MemoryCategory,
        key: item.key,
        value: item.value,
      });
      saved.push({
        id: row.id,
        category: row.category,
        key: row.key,
        value: row.value,
      });
    }
    if (saved.length > 0) {
      log.info("memory-extractor: stored facts", {
        storeId: input.storeId,
        count: saved.length,
      });
    }
    return saved;
  } catch (err) {
    log.warn("memory-extractor: extraction failed (non-fatal)", {
      storeId: input.storeId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
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
