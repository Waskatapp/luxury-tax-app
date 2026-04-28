import { GEMINI_CHAT_MODEL, GEMINI_MEMORY_MODEL } from "./gemini.server";
import { parseSlashCommand } from "./slash-commands";

// V2.4 — pick which Gemini model to use for a given turn. Flash-Lite is
// ~3-4× cheaper and faster than Flash but weaker on reasoning, planning,
// and multi-step tool use. The router defaults to Flash and only down-tiers
// on confident heuristics so quality stays the floor.
//
// Pure module — no `.server` suffix because the picker is testable without
// a network or DB. Imports gemini.server.ts only for the model ID
// constants; importing those constants doesn't pull in the SDK.

export type ModelTier = "flash" | "flash-lite";

export type ModelRouterInput = {
  message: string;
  // True when the conversation has an APPROVED but not yet fully-executed
  // plan. Mid-plan execution always uses Flash because the steps need
  // tool-use reasoning. (api.chat.tsx checks Plan rows for this.)
  hasActivePlan: boolean;
  // True when the previous assistant turn fired any approval-required
  // write tool. Conservative: stay on Flash so the follow-up summary
  // matches the same reasoning depth.
  recentWriteToolUse: boolean;
};

export type ModelRouterDecision = {
  tier: ModelTier;
  modelId: string;
  // One-line tag for logging / TurnSignal so we can see WHY a tier was
  // picked in the admin view. Helps tune the heuristic later.
  reason: string;
};

const TIER_TO_MODEL: Record<ModelTier, string> = {
  flash: GEMINI_CHAT_MODEL,
  "flash-lite": GEMINI_MEMORY_MODEL,
};

// Words that, when appearing as the FIRST word of the message, are very
// reliable signals of a read-only summary turn. These are cases where
// Flash-Lite handles the workload at full quality. Anchored to
// start-of-message — internal occurrences ("show me a plan to ...")
// aren't enough to down-tier.
const SIMPLE_QUESTION_LEADS = new Set([
  "show",
  "list",
  "what",
  "which",
  "who",
  "where",
  "when",
  "summarize",
  "summary",
]);

// Phrasings that frequently lead summary questions but contain extra
// words ("how many", "how much"). Matched as a leading prefix.
const SIMPLE_QUESTION_PREFIXES = ["how many", "how much"];

// Length above which we never down-tier — a long message usually means a
// nuanced request even if it starts with a simple word.
const FLASH_LENGTH_THRESHOLD = 200;

export function pickModelTier(opts: ModelRouterInput): ModelRouterDecision {
  const msg = opts.message.trim();

  if (opts.hasActivePlan) {
    return wrap("flash", "active plan — multi-step reasoning needed");
  }
  if (opts.recentWriteToolUse) {
    return wrap("flash", "recent write tool use — preserve reasoning depth");
  }

  // Slash commands carry an explicit tier hint. We honor it directly —
  // we picked these tiers per-command knowing the workload shape, so the
  // router doesn't second-guess.
  const slash = parseSlashCommand(msg);
  if (slash) {
    return wrap(slash.cmd.tier, `slash:/${slash.cmd.name}`);
  }

  if (msg.length > FLASH_LENGTH_THRESHOLD) {
    return wrap("flash", `length>${FLASH_LENGTH_THRESHOLD} — likely complex`);
  }

  // First-word heuristic — must be quick and unambiguous to qualify.
  // Lowercase + trailing-punct strip + contraction tail strip on the
  // first token, so "what's", "where's", "who's" all match the same
  // simple-question bucket as their non-contracted forms.
  const firstWord = msg
    .split(/\s+/)[0]
    ?.replace(/[.,!?;:]+$/, "")
    .replace(/['’](s|re|ll|ve|d)$/i, "")
    .toLowerCase();
  if (firstWord && SIMPLE_QUESTION_LEADS.has(firstWord)) {
    return wrap("flash-lite", `first-word "${firstWord}" — read-only summary`);
  }

  const lower = msg.toLowerCase();
  for (const prefix of SIMPLE_QUESTION_PREFIXES) {
    if (lower.startsWith(prefix + " ")) {
      return wrap("flash-lite", `prefix "${prefix}" — read-only summary`);
    }
  }

  return wrap("flash", "default");
}

function wrap(tier: ModelTier, reason: string): ModelRouterDecision {
  return { tier, modelId: TIER_TO_MODEL[tier], reason };
}
