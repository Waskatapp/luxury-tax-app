// Pure helpers for building Shopify admin URLs from store metadata + GIDs.
// Lives outside of `*.server.ts` because the helpers are pure and the route
// file (api.tool-snapshot.tsx) imports them on the server. They have no
// runtime dependencies, which keeps them trivially unit-testable.

// Modern Shopify admin URLs look like:
//   https://admin.shopify.com/store/<shop-handle>/products/<numericId>
// where <shop-handle> is the subdomain part of the shop's myshopify.com
// hostname. Returns null when the input doesn't look like a Shopify domain.
export function shopHandle(shopDomain: string | null | undefined): string | null {
  if (!shopDomain) return null;
  // Tolerate scheme prefix in case a caller hands us "https://x.myshopify.com".
  const stripped = shopDomain.replace(/^https?:\/\//i, "").trim();
  const match = stripped.match(/^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/i);
  return match ? match[1].toLowerCase() : null;
}

// Pulls the numeric tail out of a Shopify Product GID. Returns null for
// non-Product GIDs (e.g. ProductVariant) or malformed input — admin URLs
// for variants live under their parent product, not standalone, so we
// only mint product URLs from here.
export function numericProductId(productGid: string | null | undefined): string | null {
  if (!productGid) return null;
  const match = productGid.match(/^gid:\/\/shopify\/Product\/(\d+)$/);
  return match ? match[1] : null;
}

// Composes the admin URL for a product. Returns null when either piece is
// missing or malformed — callers render the link only when the URL exists.
export function buildProductAdminUrl(
  shopDomain: string | null | undefined,
  productGid: string | null | undefined,
): string | null {
  const handle = shopHandle(shopDomain);
  const id = numericProductId(productGid);
  if (!handle || !id) return null;
  return `https://admin.shopify.com/store/${handle}/products/${id}`;
}

// Pulls a product GID out of a snapshot or the original tool input.
// The snapshot helpers already include `productId` for our three diff-
// supporting tools (price, description, status). For tools where the
// snapshot is null (create_*), the toolInput may carry a productId
// directly. Returns null for tools where no product is referenced
// (create_discount, create_product_draft).
export function extractProductIdFromSnapshot(
  toolName: string,
  before: unknown,
  toolInput: Record<string, unknown> | null,
): string | null {
  // Tools that genuinely have no product association.
  if (toolName === "create_discount") return null;

  const fromBefore = isProductIdShape(before)
    ? (before as { productId: string }).productId
    : null;
  if (fromBefore) return fromBefore;

  // create_product_draft: the product doesn't exist yet — link target
  // would 404. Even if the input had a productId (it doesn't), we'd skip.
  if (toolName === "create_product_draft") return null;

  if (toolInput && typeof toolInput.productId === "string") {
    return toolInput.productId;
  }
  return null;
}

function isProductIdShape(v: unknown): v is { productId: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "productId" in v &&
    typeof (v as { productId: unknown }).productId === "string" &&
    (v as { productId: string }).productId.length > 0
  );
}

// Pulls the product title from a snapshot when the snapshot helper named
// it `productTitle` (price snapshots) or `title` (description/status
// snapshots). Returns null if neither field is present or non-string.
export function extractProductTitleFromSnapshot(before: unknown): string | null {
  if (typeof before !== "object" || before === null) return null;
  const obj = before as Record<string, unknown>;
  if (typeof obj.productTitle === "string" && obj.productTitle.length > 0) {
    return obj.productTitle;
  }
  if (typeof obj.title === "string" && obj.title.length > 0) {
    return obj.title;
  }
  return null;
}
