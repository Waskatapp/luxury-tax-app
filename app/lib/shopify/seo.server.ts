// V-Mkt-A — Marketing department SEO writes. Uses the existing
// `write_products` scope (Shopify's productUpdate / collectionUpdate take a
// `seo: { title, description }` sub-input — no scope changes needed). Co-
// located in its own file rather than folded into products.server.ts /
// collections.server.ts because SEO is a Marketing-domain concern, not
// Products-domain — keeps the department boundary clean.

import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ----------------------------------------------------------------------------
// Snapshot shapes — same on read (fetch helper) and write (update result) so
// snapshotBefore() in executor.server.ts can build before/after AuditLog
// entries without per-tool conversions.
// ----------------------------------------------------------------------------

export type ProductSeoSnapshot = {
  productId: string;
  productTitle: string;
  seoTitle: string | null;
  seoDescription: string | null;
};

export type CollectionSeoSnapshot = {
  collectionId: string;
  collectionTitle: string;
  seoTitle: string | null;
  seoDescription: string | null;
};

// ----------------------------------------------------------------------------
// Input schemas
//
// Field semantics:
//   undefined  — leave the field unchanged (skip from the GraphQL input)
//   ""         — clear the field (Shopify falls back to product/collection title)
//   "..."      — set the field
//
// At least ONE of seoTitle / seoDescription must be provided. The Marketing
// manager prompt nudges toward Google's title ≤ 70 chars and description
// ≤ 160 chars guidance, but we only enforce loose hard caps (255 / 320) here
// so obviously-malformed inputs don't leak through; SEO best-practice
// formatting belongs in the prompt, not the schema.
// ----------------------------------------------------------------------------

const SEO_TITLE_MAX = 255;
const SEO_DESCRIPTION_MAX = 320;

export const UpdateProductSeoInput = z
  .object({
    productId: z.string().min(1),
    seoTitle: z.string().max(SEO_TITLE_MAX).optional(),
    seoDescription: z.string().max(SEO_DESCRIPTION_MAX).optional(),
  })
  .refine((v) => v.seoTitle !== undefined || v.seoDescription !== undefined, {
    message: "must provide at least one of seoTitle or seoDescription",
  });

export const UpdateCollectionSeoInput = z
  .object({
    collectionId: z.string().min(1),
    seoTitle: z.string().max(SEO_TITLE_MAX).optional(),
    seoDescription: z.string().max(SEO_DESCRIPTION_MAX).optional(),
  })
  .refine((v) => v.seoTitle !== undefined || v.seoDescription !== undefined, {
    message: "must provide at least one of seoTitle or seoDescription",
  });

// ----------------------------------------------------------------------------
// GraphQL
// ----------------------------------------------------------------------------

const FETCH_PRODUCT_SEO_QUERY = `#graphql
  query FetchProductSeo($id: ID!) {
    product(id: $id) {
      id
      title
      seo { title description }
    }
  }
`;

const FETCH_COLLECTION_SEO_QUERY = `#graphql
  query FetchCollectionSeo($id: ID!) {
    collection(id: $id) {
      id
      title
      seo { title description }
    }
  }
`;

const PRODUCT_SEO_UPDATE_MUTATION = `#graphql
  mutation ProductSeoUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        seo { title description }
        updatedAt
      }
      userErrors { field message }
    }
  }
`;

const COLLECTION_SEO_UPDATE_MUTATION = `#graphql
  mutation CollectionSeoUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        title
        seo { title description }
        updatedAt
      }
      userErrors { field message }
    }
  }
`;

type SeoNode = {
  id: string;
  title: string;
  seo: { title: string | null; description: string | null } | null;
};

type FetchProductSeoResponse = { product: SeoNode | null };
type FetchCollectionSeoResponse = { collection: SeoNode | null };

type ProductSeoUpdateResponse = {
  productUpdate: {
    product: SeoNode | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
};

type CollectionSeoUpdateResponse = {
  collectionUpdate: {
    collection: SeoNode | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
};

// ----------------------------------------------------------------------------
// Snapshot helpers — used by snapshotBefore() in executor.server.ts to build
// the AuditLog before-state. Also useful as a standalone read in tests.
// ----------------------------------------------------------------------------

export async function fetchProductSeo(
  admin: ShopifyAdmin,
  productId: string,
): Promise<ToolModuleResult<ProductSeoSnapshot>> {
  const result = await graphqlRequest<FetchProductSeoResponse>(
    admin,
    FETCH_PRODUCT_SEO_QUERY,
    { id: productId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.product) {
    return { ok: false, error: `product not found: ${productId}` };
  }
  const p = result.data.product;
  return {
    ok: true,
    data: {
      productId: p.id,
      productTitle: p.title,
      seoTitle: p.seo?.title ?? null,
      seoDescription: p.seo?.description ?? null,
    },
  };
}

export async function fetchCollectionSeo(
  admin: ShopifyAdmin,
  collectionId: string,
): Promise<ToolModuleResult<CollectionSeoSnapshot>> {
  const result = await graphqlRequest<FetchCollectionSeoResponse>(
    admin,
    FETCH_COLLECTION_SEO_QUERY,
    { id: collectionId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.collection) {
    return { ok: false, error: `collection not found: ${collectionId}` };
  }
  const c = result.data.collection;
  return {
    ok: true,
    data: {
      collectionId: c.id,
      collectionTitle: c.title,
      seoTitle: c.seo?.title ?? null,
      seoDescription: c.seo?.description ?? null,
    },
  };
}

// ----------------------------------------------------------------------------
// updateProductSeo (write — runs from the approval route, never inline)
// ----------------------------------------------------------------------------

export async function updateProductSeo(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ProductSeoSnapshot>> {
  const parsed = UpdateProductSeoInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const seoInput: Record<string, unknown> = {};
  if (parsed.data.seoTitle !== undefined) seoInput.title = parsed.data.seoTitle;
  if (parsed.data.seoDescription !== undefined) {
    seoInput.description = parsed.data.seoDescription;
  }

  const result = await graphqlRequest<ProductSeoUpdateResponse>(
    admin,
    PRODUCT_SEO_UPDATE_MUTATION,
    {
      product: {
        id: parsed.data.productId,
        seo: seoInput,
      },
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.productUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const updated = result.data.productUpdate.product;
  if (!updated) return { ok: false, error: "productUpdate returned no product" };

  return {
    ok: true,
    data: {
      productId: updated.id,
      productTitle: updated.title,
      seoTitle: updated.seo?.title ?? null,
      seoDescription: updated.seo?.description ?? null,
    },
  };
}

// ----------------------------------------------------------------------------
// updateCollectionSeo (write — runs from the approval route, never inline)
// ----------------------------------------------------------------------------

export async function updateCollectionSeo(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<CollectionSeoSnapshot>> {
  const parsed = UpdateCollectionSeoInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const seoInput: Record<string, unknown> = {};
  if (parsed.data.seoTitle !== undefined) seoInput.title = parsed.data.seoTitle;
  if (parsed.data.seoDescription !== undefined) {
    seoInput.description = parsed.data.seoDescription;
  }

  const result = await graphqlRequest<CollectionSeoUpdateResponse>(
    admin,
    COLLECTION_SEO_UPDATE_MUTATION,
    {
      input: {
        id: parsed.data.collectionId,
        seo: seoInput,
      },
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.collectionUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const updated = result.data.collectionUpdate.collection;
  if (!updated) {
    return { ok: false, error: "collectionUpdate returned no collection" };
  }

  return {
    ok: true,
    data: {
      collectionId: updated.id,
      collectionTitle: updated.title,
      seoTitle: updated.seo?.title ?? null,
      seoDescription: updated.seo?.description ?? null,
    },
  };
}
