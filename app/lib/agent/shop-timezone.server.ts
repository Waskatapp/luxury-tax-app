import prisma from "../../db.server";
import { log } from "../log.server";
import {
  graphqlRequest,
  type ShopifyAdmin,
} from "../shopify/graphql-client.server";

// V6.8 — Lazy shop-timezone resolver. Pulls the merchant's IANA timezone
// from Shopify on first detection and caches it on the Store row. Every
// subsequent chat turn reuses the cached value at zero cost.
//
// Why lazy: the timezone almost never changes for a given store, but
// querying Shopify on every chat turn would add ~100-200ms of latency
// across every prompt build. A single cold-start fetch per store is
// cheaper. If the merchant moves their store to a new timezone they can
// trigger a refresh by uninstalling/reinstalling — that path overwrites
// the Store row.
//
// Returns "UTC" as the safe fallback if Shopify fails or returns null.
// "UTC" is the ISO baseline so tool inputs (which expect ISO timestamps)
// remain valid even when local-timezone display falls back.

const SHOP_TIMEZONE_QUERY = `#graphql
  query GetShopTimezone {
    shop {
      ianaTimezone
    }
  }
`;

type ShopTimezoneResponse = {
  shop: { ianaTimezone: string | null };
};

export async function getOrPopulateTimezone(opts: {
  storeId: string;
  currentTimezone: string | null;
  admin: ShopifyAdmin;
}): Promise<string> {
  if (opts.currentTimezone) return opts.currentTimezone;

  const result = await graphqlRequest<ShopTimezoneResponse>(
    opts.admin,
    SHOP_TIMEZONE_QUERY,
  );

  if (!result.ok) {
    log.warn("timezone: shop fetch failed (non-fatal — falling back to UTC)", {
      storeId: opts.storeId,
      error: result.error,
    });
    return "UTC";
  }

  const tz = result.data?.shop?.ianaTimezone ?? null;
  if (!tz) {
    log.warn("timezone: shop returned null ianaTimezone (falling back to UTC)", {
      storeId: opts.storeId,
    });
    return "UTC";
  }

  // Persist for future turns. updateMany is tenant-safe even though we
  // already have the storeId — keeps the pattern consistent with other
  // mutations in this module.
  try {
    await prisma.store.update({
      where: { id: opts.storeId },
      data: { ianaTimezone: tz },
    });
  } catch (err) {
    // Non-fatal: even if the cache write fails, we still return the
    // timezone for THIS turn. The next turn just re-fetches.
    log.warn("timezone: failed to persist (non-fatal)", {
      storeId: opts.storeId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return tz;
}
