// Prompt-injection stripping for user text before it reaches Claude.
// Defense in depth — the real safety net is the approval gate: even if Claude
// is fooled into emitting a write tool, no store mutation executes without a
// human click on the ApprovalCard.

const PATTERNS: Array<RegExp> = [
  /\bignore\s+(?:all|any|the)?\s*(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?|constraints?)\b/gi,
  /\bdisregard\s+(?:all|any|the)?\s*(?:previous|prior|above)\b/gi,
  /\bforget\s+(?:everything|all)\s+(?:above|before|prior)\b/gi,
  /^\s*system\s*:\s*/gim,
  /^\s*assistant\s*:\s*/gim,
  /<\|?im_(?:start|end)\|?>/gi,
  /\[INST\][\s\S]*?\[\/INST\]/gi,
  /```\s*(?:system|new_instructions|instructions)[\s\S]*?```/gi,
];

const MAX_LEN = 4000;
const REDACTED = "[redacted]";

export function sanitizeUserInput(text: string): string {
  let out = text.slice(0, MAX_LEN);
  for (const p of PATTERNS) out = out.replace(p, REDACTED);
  return out;
}

export function containsInjectionAttempt(text: string): boolean {
  return sanitizeUserInput(text) !== text.slice(0, MAX_LEN);
}
