import { GoogleGenAI } from "@google/genai";

// Model IDs per CLAUDE.md section 3. Constants so future upgrades are a
// single-file change.
export const GEMINI_CHAT_MODEL = "gemini-2.5-flash";
export const GEMINI_MEMORY_MODEL = "gemini-2.5-flash-lite";

let singleton: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (singleton) return singleton;
  // eslint-disable-next-line no-undef
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it in Railway's Variables tab for the app service.",
    );
  }
  singleton = new GoogleGenAI({ apiKey });
  return singleton;
}
