// Phase Re Round Re-A — structured error codes.
//
// Every tool failure returns a typed { code, retryable } pair instead of a
// free-text-only error. The agent reads `code` and follows the rules in
// decision-rules.md for that specific category — no more confabulating
// "tool not registered" when Gemini 429s, no more silently swallowing
// stale-ID failures.
//
// `retryable` is the contract for Round Re-B's auto-retry harness: a tool
// that failed with retryable=true can be retried once with backoff IF the
// tool is also in IDEMPOTENT_TOOLS (Re-B). This round only sets the flag;
// no retry runs yet.

export type ErrorCode =
  // Gemini RPM (per-minute quota) or Shopify 429. Recoverable in seconds.
  | "RATE_LIMITED_BURST"
  // Gemini RPD (daily quota) — no retry until UTC date rolls over.
  | "RATE_LIMITED_DAILY"
  // The resource (productId, variantId, etc.) doesn't exist. Stale ID;
  // the agent should ask the merchant, not retry blindly.
  | "ID_NOT_FOUND"
  // Shopify access scope missing for the requested action.
  | "PERMISSION_DENIED"
  // Zod parse failure — the agent gave bad input. Retry won't help; the
  // agent must re-formulate.
  | "INVALID_INPUT"
  // Shopify userErrors (validation rules at Shopify's side) — surface
  // verbatim, don't retry.
  | "UPSTREAM_ERROR"
  // Transient socket/DNS/timeout. Retry after short backoff.
  | "NETWORK"
  // Anything else — surface verbatim, don't retry.
  | "UNKNOWN";

export type ErrorClassification = {
  code: ErrorCode;
  retryable: boolean;
};

// Pattern → code mapping. Order matters — first match wins. Patterns are
// case-insensitive substring matches on the error message.
const PATTERNS: Array<{ pattern: RegExp; code: ErrorCode; retryable: boolean }> = [
  // Gemini daily quota — checked BEFORE generic "429" since the message
  // shape is more specific (mentions "quota" + "day"-ish wording).
  { pattern: /quota.*(per\s*day|daily|RPD)/i, code: "RATE_LIMITED_DAILY", retryable: false },
  { pattern: /(daily|RPD).*quota/i, code: "RATE_LIMITED_DAILY", retryable: false },
  // 429 / throttle / rate limit (generic burst-style — assume RPM).
  { pattern: /\b429\b/, code: "RATE_LIMITED_BURST", retryable: true },
  { pattern: /throttl/i, code: "RATE_LIMITED_BURST", retryable: true },
  { pattern: /rate[-\s]?limit/i, code: "RATE_LIMITED_BURST", retryable: true },
  { pattern: /resource_exhausted/i, code: "RATE_LIMITED_BURST", retryable: true },
  // ID not found — products, variants, collections, etc.
  { pattern: /not\s*found/i, code: "ID_NOT_FOUND", retryable: false },
  { pattern: /missing.*productId/i, code: "ID_NOT_FOUND", retryable: false },
  { pattern: /unknown\s*workflow/i, code: "ID_NOT_FOUND", retryable: false },
  { pattern: /unknown\s*department/i, code: "ID_NOT_FOUND", retryable: false },
  // Permission / scope.
  { pattern: /access\s*denied/i, code: "PERMISSION_DENIED", retryable: false },
  { pattern: /forbidden/i, code: "PERMISSION_DENIED", retryable: false },
  { pattern: /(missing|insufficient).*scope/i, code: "PERMISSION_DENIED", retryable: false },
  { pattern: /unauthorized/i, code: "PERMISSION_DENIED", retryable: false },
  // Invalid input (Zod failures).
  { pattern: /invalid\s*input/i, code: "INVALID_INPUT", retryable: false },
  { pattern: /zod/i, code: "INVALID_INPUT", retryable: false },
  // Shopify userErrors — validation that bounced at Shopify's side.
  { pattern: /shopify\s*userErrors/i, code: "UPSTREAM_ERROR", retryable: false },
  { pattern: /userErrors/, code: "UPSTREAM_ERROR", retryable: false },
  // Network / transient.
  { pattern: /network/i, code: "NETWORK", retryable: true },
  { pattern: /ECONNRESET|ETIMEDOUT|ENOTFOUND/i, code: "NETWORK", retryable: true },
  { pattern: /timeout/i, code: "NETWORK", retryable: true },
  { pattern: /fetch\s*failed/i, code: "NETWORK", retryable: true },
];

// Classify an arbitrary error (Error, string, or unknown) into a typed
// { code, retryable } pair. Defaults to UNKNOWN when no pattern matches.
// Pure function — no I/O, no logging.
export function classifyError(rawError: unknown): ErrorClassification {
  const message = errorMessage(rawError);
  for (const { pattern, code, retryable } of PATTERNS) {
    if (pattern.test(message)) {
      return { code, retryable };
    }
  }
  return { code: "UNKNOWN", retryable: false };
}

// Extract a string message from any input shape. Used by classifier.
export function errorMessage(rawError: unknown): string {
  if (rawError instanceof Error) return rawError.message;
  if (typeof rawError === "string") return rawError;
  if (rawError && typeof rawError === "object") {
    const r = rawError as { message?: unknown; error?: unknown };
    if (typeof r.message === "string") return r.message;
    if (typeof r.error === "string") return r.error;
  }
  try {
    return String(rawError);
  } catch {
    return "unknown error";
  }
}
