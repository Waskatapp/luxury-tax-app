// Per-storeId Shopify GraphQL token bucket.
//
// Standard Admin GraphQL plan: 1000-point capacity, 50-point/sec refill. We
// trust Shopify's reported `extensions.cost.throttleStatus.currentlyAvailable`
// over our own predictive accounting whenever a response gives it to us.
//
// `rateLimitedAdmin` wraps the admin object once at `requireStoreAccess` so
// every tool module gets rate-limiting transparently — no tool-module
// refactor needed.

import { log } from "../log.server";
import type { ShopifyAdmin } from "./graphql-client.server";

type Bucket = {
  available: number;
  lastUpdate: number; // ms epoch
};

const buckets = new Map<string, Bucket>();

const CAPACITY = 1000;
const REFILL_PER_SEC = 50;
const MIN_HEADROOM = 100; // wait until at least this much budget is back
const SLOW_WAIT_LOG_MS = 2000;

function getBucket(storeId: string): Bucket {
  let b = buckets.get(storeId);
  if (!b) {
    b = { available: CAPACITY, lastUpdate: Date.now() };
    buckets.set(storeId, b);
  }
  return b;
}

function refill(b: Bucket): void {
  const now = Date.now();
  const elapsedSec = (now - b.lastUpdate) / 1000;
  if (elapsedSec > 0) {
    b.available = Math.min(CAPACITY, b.available + elapsedSec * REFILL_PER_SEC);
    b.lastUpdate = now;
  }
}

export async function awaitShopifyHeadroom(storeId: string): Promise<void> {
  const b = getBucket(storeId);
  refill(b);
  if (b.available >= MIN_HEADROOM) return;

  const need = MIN_HEADROOM - b.available;
  const waitMs = Math.ceil((need / REFILL_PER_SEC) * 1000);
  if (waitMs >= SLOW_WAIT_LOG_MS) {
    log.warn("shopify rate-limiter sleeping for headroom", {
      storeId,
      waitMs,
      available: Number(b.available.toFixed(1)),
    });
  }
  await new Promise((res) => setTimeout(res, waitMs));
  refill(b);
}

export function recordShopifyCost(
  storeId: string,
  currentlyAvailable: number | null,
): void {
  if (typeof currentlyAvailable !== "number") return;
  const b = getBucket(storeId);
  b.available = currentlyAvailable;
  b.lastUpdate = Date.now();
}

// Single chokepoint. Awaits headroom before every Shopify call and
// post-calibrates the local bucket from the real `currentlyAvailable` after
// each response. Body is read via `response.clone()` so callers can still
// consume the original response stream.
export function rateLimitedAdmin(
  admin: ShopifyAdmin,
  storeId: string,
): ShopifyAdmin {
  return {
    async graphql(query, options) {
      await awaitShopifyHeadroom(storeId);
      const response = await admin.graphql(query, options);

      // Sniff cost out-of-band; never block the caller.
      response
        .clone()
        .json()
        .then(
          (body: unknown) => {
            const cost = (body as {
              extensions?: {
                cost?: { throttleStatus?: { currentlyAvailable?: number } };
              };
            })?.extensions?.cost?.throttleStatus?.currentlyAvailable;
            if (typeof cost === "number") recordShopifyCost(storeId, cost);
          },
          () => {
            // best-effort calibration; ignore parse failures
          },
        );

      return response;
    },
  };
}

export function _resetShopifyBucketsForTesting(): void {
  buckets.clear();
}
