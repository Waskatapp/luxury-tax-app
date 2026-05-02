import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> = { ok: true; data: T } | { ok: false; error: string };

// Shopify 2026-04: productVariantUpdate is deprecated. Use
// productVariantsBulkUpdate, which takes a productId and an array of variants.
const UpdateProductPriceInput = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1),
  newPrice: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, "newPrice must be a decimal string like \"19.99\""),
});

// V-PP-A — extended to also pull `compareAtPrice` so update_compare_at_price
// shares this snapshot path. Backward-compatible: existing callers see a
// new `compareAtPrice: string | null` field on the snapshot, no behavior
// change to the price field.
const FETCH_VARIANT_PRICE_QUERY = `#graphql
  query FetchVariantPrice($id: ID!) {
    productVariant(id: $id) {
      id
      title
      price
      compareAtPrice
      product { id title }
    }
  }
`;

const VARIANT_BULK_UPDATE_MUTATION = `#graphql
  mutation PriceUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      product { id title }
      productVariants {
        id
        title
        price
        compareAtPrice
      }
      userErrors { field message }
    }
  }
`;

type FetchVariantResponse = {
  productVariant: {
    id: string;
    title: string;
    price: string;
    compareAtPrice: string | null;
    product: { id: string; title: string } | null;
  } | null;
};

type VariantBulkUpdateResponse = {
  productVariantsBulkUpdate: {
    product: { id: string; title: string } | null;
    productVariants: Array<{
      id: string;
      title: string;
      price: string;
      compareAtPrice: string | null;
    }> | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type VariantPriceSnapshot = {
  variantId: string;
  variantTitle: string;
  productId: string;
  productTitle: string;
  price: string;
  compareAtPrice: string | null;
};

export async function fetchVariantPrice(
  admin: ShopifyAdmin,
  variantId: string,
): Promise<ToolModuleResult<VariantPriceSnapshot>> {
  const result = await graphqlRequest<FetchVariantResponse>(
    admin,
    FETCH_VARIANT_PRICE_QUERY,
    { id: variantId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  const v = result.data.productVariant;
  if (!v) return { ok: false, error: `variant not found: ${variantId}` };
  return {
    ok: true,
    data: {
      variantId: v.id,
      variantTitle: v.title,
      productId: v.product?.id ?? "",
      productTitle: v.product?.title ?? "",
      price: v.price,
      compareAtPrice: v.compareAtPrice,
    },
  };
}

export async function updateProductPrice(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<VariantPriceSnapshot>> {
  const parsed = UpdateProductPriceInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<VariantBulkUpdateResponse>(
    admin,
    VARIANT_BULK_UPDATE_MUTATION,
    {
      productId: parsed.data.productId,
      variants: [
        { id: parsed.data.variantId, price: parsed.data.newPrice },
      ],
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const payload = result.data.productVariantsBulkUpdate;
  if (payload.userErrors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${payload.userErrors.map((e) => e.message).join("; ")}`,
    };
  }
  const variant = payload.productVariants?.[0];
  if (!variant) {
    return { ok: false, error: "productVariantsBulkUpdate returned no variant" };
  }

  return {
    ok: true,
    data: {
      variantId: variant.id,
      variantTitle: variant.title,
      productId: payload.product?.id ?? parsed.data.productId,
      productTitle: payload.product?.title ?? "",
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
    },
  };
}

// ----------------------------------------------------------------------------
// update_compare_at_price (write — runs from approval route, never inline)
//
// Sets the variant's compareAtPrice (the strikethrough "was $X" Shopify
// shows on storefront when compareAtPrice > price). Passing an empty
// string or "0" CLEARS the strikethrough — the handler maps both cases
// to `compareAtPrice: null` in the Shopify mutation.
//
// Reuses VariantPriceSnapshot + fetchVariantPrice — both update_product_price
// and update_compare_at_price share the same before-state shape; AuditLog
// readers get the diff for free.
// ----------------------------------------------------------------------------

const UpdateCompareAtPriceInput = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1),
  // Empty string and "0" are both treated as "clear the strikethrough".
  // Otherwise must be a valid decimal like "29.99".
  newCompareAtPrice: z
    .string()
    .regex(
      /^(|0|0\.0+|\d+(\.\d{1,2})?)$/,
      'newCompareAtPrice must be a decimal string like "29.99", or "" / "0" to clear',
    ),
});

export async function updateCompareAtPrice(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<VariantPriceSnapshot>> {
  const parsed = UpdateCompareAtPriceInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Empty string or "0" → null (clear). Otherwise pass through the
  // decimal string. Shopify accepts null to remove the strikethrough.
  const trimmed = parsed.data.newCompareAtPrice.trim();
  const isClear = trimmed === "" || /^0(\.0+)?$/.test(trimmed);
  const compareAtPriceValue: string | null = isClear ? null : trimmed;

  const result = await graphqlRequest<VariantBulkUpdateResponse>(
    admin,
    VARIANT_BULK_UPDATE_MUTATION,
    {
      productId: parsed.data.productId,
      variants: [
        { id: parsed.data.variantId, compareAtPrice: compareAtPriceValue },
      ],
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const payload = result.data.productVariantsBulkUpdate;
  if (payload.userErrors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${payload.userErrors.map((e) => e.message).join("; ")}`,
    };
  }
  const variant = payload.productVariants?.[0];
  if (!variant) {
    return { ok: false, error: "productVariantsBulkUpdate returned no variant" };
  }

  return {
    ok: true,
    data: {
      variantId: variant.id,
      variantTitle: variant.title,
      productId: payload.product?.id ?? parsed.data.productId,
      productTitle: payload.product?.title ?? "",
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
    },
  };
}

// ----------------------------------------------------------------------------
// bulk_update_prices (write — runs from approval route, never inline)
//
// Apply a percentage or fixed-amount change across many variants.
// Three scope shapes (exactly one must be set):
//   - collectionId: resolves to all products in the collection (cap 50)
//   - productIds:   explicit list, resolved to all variants (cap 50 products)
//   - variantIds:   explicit list, no expansion (cap 100 variants)
//
// Safety:
//   - Zod bounds on changeValue catch typos (e.g. 1000% mark-up).
//   - Negative-price protection in the handler — if any computed new
//     price < 0, return error with the offending variants and refuse
//     to send any mutation (atomic-or-nothing per request).
//   - Per-product loop — Shopify's productVariantsBulkUpdate takes one
//     productId at a time. Sequential await keeps within rate limits.
// ----------------------------------------------------------------------------

const MAX_PRODUCTS_BULK = 50;
const MAX_VARIANTS_BULK = 100;

const BulkUpdatePricesInput = z
  .object({
    collectionId: z.string().min(1).optional(),
    productIds: z.array(z.string().min(1)).min(1).max(MAX_PRODUCTS_BULK).optional(),
    variantIds: z.array(z.string().min(1)).min(1).max(MAX_VARIANTS_BULK).optional(),

    changeType: z.enum(["percentage", "fixed_amount"]),
    changeValue: z.number().refine((v) => v !== 0, {
      message: "changeValue must not be 0 (no-op)",
    }),

    roundTo: z.enum([".99", ".95", ".00"]).optional(),
  })
  .refine(
    (v) => {
      const set = [
        v.collectionId !== undefined,
        v.productIds !== undefined,
        v.variantIds !== undefined,
      ].filter(Boolean).length;
      return set === 1;
    },
    {
      message: "exactly one of collectionId / productIds / variantIds must be set",
    },
  )
  .refine(
    (v) => {
      if (v.changeType === "percentage") {
        return v.changeValue >= -100 && v.changeValue <= 500;
      }
      return v.changeValue >= -100000 && v.changeValue <= 100000;
    },
    {
      message:
        "changeValue out of bounds — percentage must be in [-100, +500]; fixed_amount in [-100000, +100000]",
    },
  );

const FETCH_PRODUCT_VARIANTS_QUERY = `#graphql
  query FetchProductVariants($id: ID!) {
    product(id: $id) {
      id
      title
      variants(first: 100) {
        edges {
          node { id title price }
        }
      }
    }
  }
`;

const FETCH_COLLECTION_PRODUCTS_QUERY = `#graphql
  query FetchCollectionProducts($id: ID!, $first: Int!) {
    collection(id: $id) {
      id
      title
      products(first: $first) {
        edges {
          node {
            id
            title
            variants(first: 100) {
              edges {
                node { id title price }
              }
            }
          }
        }
      }
    }
  }
`;

type FetchProductVariantsResponse = {
  product: {
    id: string;
    title: string;
    variants: {
      edges: Array<{ node: { id: string; title: string; price: string } }>;
    };
  } | null;
};

type FetchCollectionProductsResponse = {
  collection: {
    id: string;
    title: string;
    products: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          variants: {
            edges: Array<{ node: { id: string; title: string; price: string } }>;
          };
        };
      }>;
    };
  } | null;
};

type ResolvedTarget = {
  productId: string;
  productTitle: string;
  variantId: string;
  variantTitle: string;
  currentPrice: string;
};

async function resolveBulkTargets(
  admin: ShopifyAdmin,
  input: z.infer<typeof BulkUpdatePricesInput>,
): Promise<ToolModuleResult<ResolvedTarget[]>> {
  // collectionId path
  if (input.collectionId) {
    const result = await graphqlRequest<FetchCollectionProductsResponse>(
      admin,
      FETCH_COLLECTION_PRODUCTS_QUERY,
      { id: input.collectionId, first: MAX_PRODUCTS_BULK + 1 },
    );
    if (!result.ok) return { ok: false, error: result.error };
    if (!result.data.collection) {
      return { ok: false, error: `collection not found: ${input.collectionId}` };
    }
    const productEdges = result.data.collection.products.edges;
    if (productEdges.length > MAX_PRODUCTS_BULK) {
      return {
        ok: false,
        error: `collection has more than ${MAX_PRODUCTS_BULK} products — too many for a single bulk update. Scope down or split into multiple operations.`,
      };
    }
    const targets: ResolvedTarget[] = [];
    for (const pe of productEdges) {
      for (const ve of pe.node.variants.edges) {
        targets.push({
          productId: pe.node.id,
          productTitle: pe.node.title,
          variantId: ve.node.id,
          variantTitle: ve.node.title,
          currentPrice: ve.node.price,
        });
      }
    }
    return { ok: true, data: targets };
  }

  // productIds path
  if (input.productIds) {
    const targets: ResolvedTarget[] = [];
    for (const productId of input.productIds) {
      const result = await graphqlRequest<FetchProductVariantsResponse>(
        admin,
        FETCH_PRODUCT_VARIANTS_QUERY,
        { id: productId },
      );
      if (!result.ok) return { ok: false, error: result.error };
      const p = result.data.product;
      if (!p) {
        return { ok: false, error: `product not found: ${productId}` };
      }
      for (const ve of p.variants.edges) {
        targets.push({
          productId: p.id,
          productTitle: p.title,
          variantId: ve.node.id,
          variantTitle: ve.node.title,
          currentPrice: ve.node.price,
        });
      }
    }
    return { ok: true, data: targets };
  }

  // variantIds path — fetch each via fetchVariantPrice
  if (input.variantIds) {
    const targets: ResolvedTarget[] = [];
    for (const variantId of input.variantIds) {
      const result = await fetchVariantPrice(admin, variantId);
      if (!result.ok) return { ok: false, error: result.error };
      targets.push({
        productId: result.data.productId,
        productTitle: result.data.productTitle,
        variantId: result.data.variantId,
        variantTitle: result.data.variantTitle,
        currentPrice: result.data.price,
      });
    }
    return { ok: true, data: targets };
  }

  // Unreachable — Zod refinement guarantees one scope is set.
  return { ok: false, error: "no scope set" };
}

// Apply rounding to land on .99 / .95 / .00 endings (storefront-friendly).
// Strategy: round DOWN to the nearest target ending so the new price is
// never higher than the unrounded compute.
function applyPriceRounding(
  rawPrice: number,
  roundTo: ".99" | ".95" | ".00" | undefined,
): number {
  if (!roundTo) return rawPrice;
  const dollars = Math.floor(rawPrice);
  if (roundTo === ".00") {
    return dollars; // floor to whole dollar
  }
  const cents = roundTo === ".99" ? 0.99 : 0.95;
  // If raw price is below dollars + cents (e.g. 19.50 with .99 target),
  // step down to the previous dollar's ending: (dollars - 1) + cents.
  const candidate = dollars + cents;
  if (rawPrice >= candidate) return candidate;
  return Math.max(0, dollars - 1) + cents;
}

function computeNewPrice(
  currentPrice: string,
  changeType: "percentage" | "fixed_amount",
  changeValue: number,
  roundTo: ".99" | ".95" | ".00" | undefined,
): number {
  const current = parseFloat(currentPrice);
  let raw: number;
  if (changeType === "percentage") {
    raw = current * (1 + changeValue / 100);
  } else {
    raw = current + changeValue;
  }
  return applyPriceRounding(raw, roundTo);
}

export type BulkPriceChange = {
  productId: string;
  productTitle: string;
  variantId: string;
  variantTitle: string;
  oldPrice: string;
  newPrice: string;
};

export type BulkUpdatePricesResult = {
  totalUpdated: number;
  totalFailed: number;
  changes: BulkPriceChange[];
  failures: Array<{ variantId: string; error: string }>;
};

export async function bulkUpdatePrices(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<BulkUpdatePricesResult>> {
  const parsed = BulkUpdatePricesInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Resolve targets
  const resolved = await resolveBulkTargets(admin, parsed.data);
  if (!resolved.ok) return resolved;
  const targets = resolved.data;
  if (targets.length === 0) {
    return { ok: false, error: "scope resolved to 0 variants — nothing to update" };
  }
  if (targets.length > MAX_VARIANTS_BULK) {
    return {
      ok: false,
      error: `${targets.length} variants exceeds the bulk cap of ${MAX_VARIANTS_BULK}. Scope down.`,
    };
  }

  // Compute new prices + negative-price check
  type Plan = { target: ResolvedTarget; newPriceFormatted: string };
  const plan: Plan[] = [];
  const negative: Array<{ variantId: string; computed: number }> = [];
  for (const target of targets) {
    const computed = computeNewPrice(
      target.currentPrice,
      parsed.data.changeType,
      parsed.data.changeValue,
      parsed.data.roundTo,
    );
    if (computed < 0) {
      negative.push({ variantId: target.variantId, computed });
      continue;
    }
    plan.push({
      target,
      newPriceFormatted: computed.toFixed(2),
    });
  }
  if (negative.length > 0) {
    const summary = negative
      .slice(0, 5)
      .map((n) => `${n.variantId} → $${n.computed.toFixed(2)}`)
      .join(", ");
    return {
      ok: false,
      error: `computed negative prices for ${negative.length} variant(s) — refusing to proceed. Examples: ${summary}`,
    };
  }

  // Group by productId for the loop
  const byProduct = new Map<string, Plan[]>();
  for (const p of plan) {
    const list = byProduct.get(p.target.productId) ?? [];
    list.push(p);
    byProduct.set(p.target.productId, list);
  }

  // Loop: one productVariantsBulkUpdate per product, sequential
  const changes: BulkPriceChange[] = [];
  const failures: Array<{ variantId: string; error: string }> = [];
  for (const [productId, planForProduct] of byProduct.entries()) {
    const result = await graphqlRequest<VariantBulkUpdateResponse>(
      admin,
      VARIANT_BULK_UPDATE_MUTATION,
      {
        productId,
        variants: planForProduct.map((p) => ({
          id: p.target.variantId,
          price: p.newPriceFormatted,
        })),
      },
    );
    if (!result.ok) {
      // Whole-product failure — every variant in this group fails.
      for (const p of planForProduct) {
        failures.push({ variantId: p.target.variantId, error: result.error });
      }
      continue;
    }
    const payload = result.data.productVariantsBulkUpdate;
    if (payload.userErrors.length > 0) {
      const errMsg = payload.userErrors.map((e) => e.message).join("; ");
      for (const p of planForProduct) {
        failures.push({ variantId: p.target.variantId, error: errMsg });
      }
      continue;
    }
    // Match returned variants back to plan entries (by variantId) so the
    // change record reflects what Shopify actually accepted.
    const returned = new Map(
      (payload.productVariants ?? []).map((v) => [v.id, v]),
    );
    for (const p of planForProduct) {
      const r = returned.get(p.target.variantId);
      if (!r) {
        failures.push({
          variantId: p.target.variantId,
          error: "variant missing from productVariantsBulkUpdate response",
        });
        continue;
      }
      changes.push({
        productId: p.target.productId,
        productTitle: p.target.productTitle,
        variantId: p.target.variantId,
        variantTitle: p.target.variantTitle,
        oldPrice: p.target.currentPrice,
        newPrice: r.price,
      });
    }
  }

  return {
    ok: true,
    data: {
      totalUpdated: changes.length,
      totalFailed: failures.length,
      changes,
      failures,
    },
  };
}
