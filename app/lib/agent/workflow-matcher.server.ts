// Phase Wf Round Wf-A — workflow trigger matcher.
//
// Given the merchant's last user message + last assistant message, return
// the top-N workflow names whose `triggers` (declared in frontmatter) hit.
// The matcher is whole-word, lowercased, punctuation-stripped — so a
// trigger of "price" doesn't fire on "appraised" and a trigger of "promo
// code" matches as an adjacent token sequence.
//
// Why both messages: a follow-up like "do that for the rest" carries no
// keyword on its own — but the prior assistant turn (e.g., "I lowered the
// price on cat food") does. Matching on `userMsg + ' ' + lastAssistantMsg`
// captures these continuations. We bound the assistant-side text we
// consider so a 2k-character prior turn doesn't dominate.
//
// Why whole-word and not substring: the Plan-agent's pushback. "price"
// substring-matching against "appraised" would fire false positives on
// every catalog-audit conversation. Token-based matching is deterministic,
// trivially debuggable, and works fine because workflow authors control
// the trigger list.

import type { WorkflowIndexEntry } from "./workflow-loader.server";

// Cap on the assistant-side text considered for context matching. Larger
// values would let a long prior turn dominate the trigger surface.
const ASSISTANT_CONTEXT_CHAR_CAP = 600;

// Top-N workflows surfaced per turn. Matches the constitutional cap from
// the plan ("cap injection at top-3 matched").
export const MAX_TRIGGER_SUGGESTIONS_PER_TURN = 3;

export type TriggerMatch = {
  name: string;
  summary: string;
  hitCount: number;     // how many distinct triggers fired (drives ranking)
  matchedTriggers: string[];
  priority: number;
};

// Tokenize a string into whole-word lowercase tokens.
//   "I want to lower the price"  →  ["i","want","to","lower","the","price"]
//   "do a 25% promo-code"        →  ["do","a","25","promo","code"]
// Punctuation is stripped; digits stay (they're meaningful, e.g. "2x sale").
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ") // strip punctuation incl. apostrophes
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// Build the searchable token stream from user + (capped) assistant text.
function buildTokens(userMessage: string, lastAssistantMessage: string): string[] {
  const trimmedAssistant = lastAssistantMessage.slice(0, ASSISTANT_CONTEXT_CHAR_CAP);
  return tokenize(`${userMessage} ${trimmedAssistant}`);
}

// Whole-word/phrase match: does the trigger's token sequence appear as a
// contiguous run inside the input tokens? Single-word triggers reduce to
// a Set membership; multi-word triggers do an O(N*M) scan.
function triggerHits(tokens: string[], triggerLower: string): boolean {
  const triggerTokens = tokenize(triggerLower);
  if (triggerTokens.length === 0) return false;
  if (triggerTokens.length === 1) {
    // Optimized hot path; most triggers will be one word.
    return tokens.includes(triggerTokens[0]);
  }
  // Multi-token: scan for contiguous run.
  outer: for (let i = 0; i + triggerTokens.length <= tokens.length; i++) {
    for (let j = 0; j < triggerTokens.length; j++) {
      if (tokens[i + j] !== triggerTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

// Match the merchant's message against the workflow index. Returns top-N
// workflows ranked by:
//   1. hit count desc (more triggers fired = stronger match)
//   2. priority desc  (workflow author's hint)
//   3. name asc       (stable tiebreak)
export function matchTriggers(
  userMessage: string,
  lastAssistantMessage: string,
  index: WorkflowIndexEntry[],
  limit: number = MAX_TRIGGER_SUGGESTIONS_PER_TURN,
): TriggerMatch[] {
  if (!userMessage || userMessage.trim().length === 0) return [];
  const tokens = buildTokens(userMessage, lastAssistantMessage);
  if (tokens.length === 0) return [];

  const matches: TriggerMatch[] = [];
  for (const wf of index) {
    if (!wf.triggers || wf.triggers.length === 0) continue;
    const fired: string[] = [];
    for (const trigger of wf.triggers) {
      if (triggerHits(tokens, trigger)) {
        fired.push(trigger);
      }
    }
    if (fired.length === 0) continue;
    matches.push({
      name: wf.name,
      summary: wf.summary,
      hitCount: fired.length,
      matchedTriggers: fired,
      priority: wf.priority,
    });
  }

  matches.sort((a, b) => {
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.name.localeCompare(b.name);
  });

  return matches.slice(0, limit);
}

// Format the top matches as a compact "Suggested workflows" block to inject
// into the system instruction. Returns null when there are no matches so
// the augmenter pipeline can omit the heading entirely.
export function formatTriggerSuggestionsBlock(matches: TriggerMatch[]): string | null {
  if (matches.length === 0) return null;
  const lines = matches.map(
    (m) => `- \`${m.name}\` — ${m.summary} (matched: ${m.matchedTriggers.join(", ")})`,
  );
  return [
    "These workflow SOPs match the merchant's current message. Read them via `read_workflow` BEFORE proposing an action — they encode the right decisions for this situation:",
    ...lines,
  ].join("\n");
}
