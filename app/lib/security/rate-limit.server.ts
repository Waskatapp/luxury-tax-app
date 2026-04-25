// In-memory sliding-window rate limiter. Single-process Railway makes this
// safe for v1; if we ever scale to N replicas we'll move state to Postgres.
//
// Each bucket stores up to `limit` recent timestamps. On check, we drop
// timestamps older than `windowMs` and either accept (push timestamp) or
// reject (return retry-after).

type Bucket = number[];

const buckets = new Map<string, Bucket>();

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number };

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;
  const bucket = buckets.get(key) ?? [];

  while (bucket.length > 0 && bucket[0] < cutoff) bucket.shift();

  if (bucket.length >= limit) {
    const oldest = bucket[0];
    return { ok: false, retryAfterMs: Math.max(0, oldest + windowMs - now) };
  }

  bucket.push(now);
  buckets.set(key, bucket);
  return { ok: true };
}

// 10 messages/minute per (storeId, userId). Offline sessions in v1 don't
// expose a per-request user identity — we pass null and treat the store as
// the unit of rate-limiting until online sessions land.
export function checkChatRateLimit(
  storeId: string,
  userId: string | null,
): RateLimitResult {
  return checkRateLimit(`chat:${storeId}:${userId ?? "store"}`, 10, 60_000);
}

// 10 RPM per storeId — matches Gemini 2.5 Flash free-tier ceiling. The agent
// loop fires 1–N calls per merchant message; this counter is the local
// pre-check so we don't burn an HTTP round-trip when we know it'll throttle.
// Defense in depth: api.chat also catches 429 from the SDK directly.
export function checkGeminiRateLimit(storeId: string): RateLimitResult {
  return checkRateLimit(`gemini:${storeId}`, 10, 60_000);
}

export function _resetRateLimitForTesting(): void {
  buckets.clear();
}
