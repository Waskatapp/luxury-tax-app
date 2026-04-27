import { z } from "zod";

import { GEMINI_MEMORY_MODEL, getGeminiClient } from "./gemini.server";
import { log } from "../log.server";

// Generates a 3-7 word descriptive title for a conversation from the
// merchant's first message + the assistant's first reply. Called once
// per conversation, after the first user→assistant exchange completes.
//
// Mirrors the memory-extractor posture: never throws, falls back to a
// best-effort cleanup of the user's first message when the LLM call
// fails or returns garbage.

const TITLE_PROMPT = `You write a short title for a Shopify merchant's chat conversation, given the first user message and the assistant's first reply.

Rules:
- 3 to 7 words. No more.
- Capitalize like a title (first letter of each major word).
- No punctuation at the end. No quotes. No emoji.
- Describe what the merchant is asking about, not how the assistant replied.
- Use plain, clear English. Avoid Shopify jargon when possible.

Examples:
User: "What's running low on stock?"
Title: Low Stock Inventory Check

User: "Change the price of cat food to $20"
Title: Cat Food Price Update

User: "Help me create a 15% off discount for the weekend"
Title: Weekend 15% Off Discount

User: "How is revenue this week?"
Title: Weekly Revenue Summary

Output the title text only — no JSON, no markdown, no prose.`;

const TitleResponse = z.string().min(2).max(60);

const FALLBACK_MAX_WORDS = 6;

// Generates a title. Always resolves; on any failure returns a fallback
// derived from the user's first message. Caller should persist whatever
// this returns.
export async function generateTitle(
  userText: string,
  assistantText: string,
): Promise<string> {
  const fallback = buildFallback(userText);

  if (!userText.trim()) return fallback;

  try {
    const ai = getGeminiClient();
    const userMessage = `User said: ${userText}\n\nAssistant said: ${assistantText.trim() || "(no text response)"}\n\nWrite a short title (3-7 words):`;

    const response = await ai.models.generateContent({
      model: GEMINI_MEMORY_MODEL,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: TITLE_PROMPT,
        maxOutputTokens: 64,
      },
    });

    const raw = (response.text ?? "").trim();
    if (!raw) return fallback;

    // Strip surrounding quotes/punctuation Flash-Lite occasionally adds.
    const cleaned = raw
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/[.!?]+$/g, "")
      .trim();

    const parsed = TitleResponse.safeParse(cleaned);
    if (!parsed.success) return fallback;

    // Defensive: cap at 7 words even if Flash-Lite ignored the rule.
    const words = parsed.data.split(/\s+/);
    if (words.length > 7) return words.slice(0, 7).join(" ");

    return parsed.data;
  } catch (err) {
    log.warn("title-generator: failed (non-fatal)", {
      err: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

// Best-effort title from the user's first message when the LLM is
// unavailable. Strip leading "please/help me/can you" filler, take the
// first ~6 words, capitalize, drop trailing punctuation. Better than
// raw `userText.slice(0, 60)` mid-word truncation.
function buildFallback(userText: string): string {
  const trimmed = userText
    .trim()
    .replace(/^(please|hey|hi|hello|can you|could you|help me|i want to|i need to|i'd like to)\s+/i, "")
    .replace(/[?!.]+$/g, "");

  if (!trimmed) return "New Conversation";

  const words = trimmed.split(/\s+/).slice(0, FALLBACK_MAX_WORDS);
  const titled = words
    .map((w, i) =>
      i === 0 || w.length > 3
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        : w.toLowerCase(),
    )
    .join(" ");

  return titled.length > 0 ? titled : "New Conversation";
}
