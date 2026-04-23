import Anthropic from "@anthropic-ai/sdk";

// Model IDs per CLAUDE.md section 3. Use constants so future upgrades are a
// single-file change.
export const CLAUDE_CHAT_MODEL = "claude-sonnet-4-6";
export const CLAUDE_MEMORY_MODEL = "claude-haiku-4-5-20251001";

let singleton: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (singleton) return singleton;
  // eslint-disable-next-line no-undef
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it in Railway's Variables tab for the app service.",
    );
  }
  singleton = new Anthropic({ apiKey });
  return singleton;
}
