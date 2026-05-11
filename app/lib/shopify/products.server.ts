import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> = { ok: true; data: T } | { ok: false; error: string };

const ReadProductsInput = z.object({
  first: z.number().int().min(1).max(50).default(20),
  after: z.string().optional(),
  // Shopify Admin search syntax. Most useful: `title:<name>` matches products
  // whose title contains <name>. The agent should use this for name lookups
  // — without it we only see the first 20 alphabetical products.
  query: z.string().optional(),
});

// We pull `description`, `tags`, `seo`, and `variants` so the agent has
// enough signal to match a merchant's intent (typos, vagueness, "the
// product for cats" instead of the literal name) AND so it can pick the
// right variant without guessing IDs. Description is truncated server-side
// to ~400 chars to keep payload bounded; variants capped at 10 per product
// (clothing-style stores with 50+ variants per product are out of scope
// for v1 lookup — the agent can paginate via `after` if needed).
const READ_PRODUCTS_QUERY = `#graphql
  query ReadProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          title
          handle
          status
          productType
          vendor
          tags
          description
          seo {
            title
            description
          }
          totalInventory
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                price
                sku
                inventoryQuantity
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const DESCRIPTION_PREVIEW_CHARS = 400;

export type ProductVariantSummary = {
  id: string;
  title: string;
  price: string;
  sku: string | null;
  inventoryQuantity: number | null;
};

export type ProductSummary = {
  id: string;
  title: string;
  handle: string;
  status: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  descriptionPreview: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  totalInventory: number | null;
  priceRange: {
    min: { amount: string; currencyCode: string };
    max: { amount: string; currencyCode: string };
  };
  variants: ProductVariantSummary[];
};

export type ReadProductsResult = {
  products: ProductSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

type RawResponse = {
  products: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        title: string;
        handle: string;
        status: string;
        productType: string | null;
        vendor: string | null;
        tags: string[];
        description: string | null;
        seo: { title: string | null; description: string | null } | null;
        totalInventory: number | null;
        priceRangeV2: {
          minVariantPrice: { amount: string; currencyCode: string };
          maxVariantPrice: { amount: string; currencyCode: string };
        };
        variants: {
          edges: Array<{
            node: {
              id: string;
              title: string;
              price: string;
              sku: string | null;
              inventoryQuantity: number | null;
            };
          }>;
        };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export async function readProducts(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadProductsResult>> {
  const parsed = ReadProductsInput.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<RawResponse>(admin, READ_PRODUCTS_QUERY, {
    first: parsed.data.first,
    after: parsed.data.after ?? null,
    query: parsed.data.query ?? null,
  });

  if (!result.ok) return { ok: false, error: result.error };

  const products: ProductSummary[] = result.data.products.edges.map((edge) => {
    const desc = edge.node.description?.trim() ?? "";
    const descPreview =
      desc.length > DESCRIPTION_PREVIEW_CHARS
        ? desc.slice(0, DESCRIPTION_PREVIEW_CHARS) + "…"
        : desc.length > 0
          ? desc
          : null;
    return {
      id: edge.node.id,
      title: edge.node.title,
      handle: edge.node.handle,
      status: edge.node.status,
      productType: edge.node.productType,
      vendor: edge.node.vendor,
      tags: edge.node.tags ?? [],
      descriptionPreview: descPreview,
      seoTitle: edge.node.seo?.title ?? null,
      seoDescription: edge.node.seo?.description ?? null,
      totalInventory: edge.node.totalInventory,
      priceRange: {
        min: edge.node.priceRangeV2.minVariantPrice,
        max: edge.node.priceRangeV2.maxVariantPrice,
      },
      variants: edge.node.variants.edges.map((v) => ({
        id: v.node.id,
        title: v.node.title,
        price: v.node.price,
        sku: v.node.sku,
        inventoryQuantity: v.node.inventoryQuantity,
      })),
    };
  });

  return {
    ok: true,
    data: { products, pageInfo: result.data.products.pageInfo },
  };
}

// ----------------------------------------------------------------------------
// update_product_description (write — runs from approval route, never inline)
// ----------------------------------------------------------------------------

const UpdateProductDescriptionInput = z.object({
  productId: z.string().min(1),
  descriptionHtml: z.string(),
});

const FETCH_PRODUCT_DESCRIPTION_QUERY = `#graphql
  query FetchProductDescription($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
    }
  }
`;

const PRODUCT_UPDATE_MUTATION = `#graphql
  mutation ProductDescriptionUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        descriptionHtml
        updatedAt
      }
      userErrors { field message }
    }
  }
`;

type FetchDescriptionResponse = {
  product: { id: string; title: string; descriptionHtml: string } | null;
};

type ProductUpdateResponse = {
  productUpdate: {
    product: {
      id: string;
      title: string;
      descriptionHtml: string;
      updatedAt: string;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type ProductDescriptionSnapshot = {
  productId: string;
  title: string;
  descriptionHtml: string;
};

export async function fetchProductDescription(
  admin: ShopifyAdmin,
  productId: string,
): Promise<ToolModuleResult<ProductDescriptionSnapshot>> {
  const result = await graphqlRequest<FetchDescriptionResponse>(
    admin,
    FETCH_PRODUCT_DESCRIPTION_QUERY,
    { id: productId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.product) {
    return { ok: false, error: `product not found: ${productId}` };
  }
  return {
    ok: true,
    data: {
      productId: result.data.product.id,
      title: result.data.product.title,
      descriptionHtml: result.data.product.descriptionHtml,
    },
  };
}

export async function updateProductDescription(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ProductDescriptionSnapshot>> {
  const parsed = UpdateProductDescriptionInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ProductUpdateResponse>(
    admin,
    PRODUCT_UPDATE_MUTATION,
    {
      product: {
        id: parsed.data.productId,
        descriptionHtml: parsed.data.descriptionHtml,
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
      title: updated.title,
      descriptionHtml: updated.descriptionHtml,
    },
  };
}

// ----------------------------------------------------------------------------
// update_product_status (write — runs from approval route, never inline)
// ----------------------------------------------------------------------------

const UpdateProductStatusInput = z.object({
  productId: z.string().min(1),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]),
});

const FETCH_PRODUCT_STATUS_QUERY = `#graphql
  query FetchProductStatus($id: ID!) {
    product(id: $id) {
      id
      title
      status
    }
  }
`;

const PRODUCT_STATUS_UPDATE_MUTATION = `#graphql
  mutation ProductStatusUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        status
        updatedAt
      }
      userErrors { field message }
    }
  }
`;

type FetchStatusResponse = {
  product: { id: string; title: string; status: string } | null;
};

type ProductStatusUpdateResponse = {
  productUpdate: {
    product: {
      id: string;
      title: string;
      status: string;
      updatedAt: string;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type ProductStatusSnapshot = {
  productId: string;
  title: string;
  status: string;
};

export async function fetchProductStatus(
  admin: ShopifyAdmin,
  productId: string,
): Promise<ToolModuleResult<ProductStatusSnapshot>> {
  const result = await graphqlRequest<FetchStatusResponse>(
    admin,
    FETCH_PRODUCT_STATUS_QUERY,
    { id: productId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.product) {
    return { ok: false, error: `product not found: ${productId}` };
  }
  return {
    ok: true,
    data: {
      productId: result.data.product.id,
      title: result.data.product.title,
      status: result.data.product.status,
    },
  };
}

export async function updateProductStatus(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ProductStatusSnapshot>> {
  const parsed = UpdateProductStatusInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ProductStatusUpdateResponse>(
    admin,
    PRODUCT_STATUS_UPDATE_MUTATION,
    {
      product: {
        id: parsed.data.productId,
        status: parsed.data.status,
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
      title: updated.title,
      status: updated.status,
    },
  };
}

// ----------------------------------------------------------------------------
// create_product_draft (write — runs from approval route, never inline)
// ----------------------------------------------------------------------------

const CreateProductDraftInput = z.object({
  title: z.string().min(1).max(255),
  descriptionHtml: z.string().optional(),
  vendor: z.string().optional(),
  productType: z.string().optional(),
});

const PRODUCT_CREATE_MUTATION = `#graphql
  mutation ProductDraftCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        title
        handle
        status
        descriptionHtml
        vendor
        productType
        createdAt
        variants(first: 1) {
          edges { node { id title price } }
        }
      }
      userErrors { field message }
    }
  }
`;

type ProductCreateResponse = {
  productCreate: {
    product: {
      id: string;
      title: string;
      handle: string;
      status: string;
      descriptionHtml: string | null;
      vendor: string | null;
      productType: string | null;
      createdAt: string;
      variants: {
        edges: Array<{
          node: { id: string; title: string; price: string };
        }>;
      };
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type CreatedProductDraft = {
  productId: string;
  title: string;
  handle: string;
  status: string;
  vendor: string | null;
  productType: string | null;
  // Shopify auto-creates a default variant when no variants are specified.
  // Returning it here lets the agent immediately call update_product_price
  // on a follow-up turn without needing read_products first.
  defaultVariant: { id: string; title: string; price: string } | null;
};

export async function createProductDraft(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<CreatedProductDraft>> {
  const parsed = CreateProductDraftInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ProductCreateResponse>(
    admin,
    PRODUCT_CREATE_MUTATION,
    {
      product: {
        title: parsed.data.title,
        status: "DRAFT",
        ...(parsed.data.descriptionHtml
          ? { descriptionHtml: parsed.data.descriptionHtml }
          : {}),
        ...(parsed.data.vendor ? { vendor: parsed.data.vendor } : {}),
        ...(parsed.data.productType
          ? { productType: parsed.data.productType }
          : {}),
      },
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.productCreate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const created = result.data.productCreate.product;
  if (!created) return { ok: false, error: "productCreate returned no product" };

  const variantNode = created.variants.edges[0]?.node ?? null;

  return {
    ok: true,
    data: {
      productId: created.id,
      title: created.title,
      handle: created.handle,
      status: created.status,
      vendor: created.vendor,
      productType: created.productType,
      defaultVariant: variantNode
        ? { id: variantNode.id, title: variantNode.title, price: variantNode.price }
        : null,
    },
  };
}

// ----------------------------------------------------------------------------
// update_product_title (write — runs from approval route, never inline)
// ----------------------------------------------------------------------------

const UpdateProductTitleInput = z.object({
  productId: z.string().min(1),
  title: z.string().min(1).max(255),
});

const FETCH_PRODUCT_TITLE_QUERY = `#graphql
  query FetchProductTitle($id: ID!) {
    product(id: $id) {
      id
      title
    }
  }
`;

const PRODUCT_TITLE_UPDATE_MUTATION = `#graphql
  mutation ProductTitleUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        updatedAt
      }
      userErrors { field message }
    }
  }
`;

type FetchTitleResponse = {
  product: { id: string; title: string } | null;
};

type ProductTitleUpdateResponse = {
  productUpdate: {
    product: {
      id: string;
      title: string;
      updatedAt: string;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type ProductTitleSnapshot = {
  productId: string;
  title: string;
};

export async function fetchProductTitle(
  admin: ShopifyAdmin,
  productId: string,
): Promise<ToolModuleResult<ProductTitleSnapshot>> {
  const result = await graphqlRequest<FetchTitleResponse>(
    admin,
    FETCH_PRODUCT_TITLE_QUERY,
    { id: productId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.product) {
    return { ok: false, error: `product not found: ${productId}` };
  }
  return {
    ok: true,
    data: {
      productId: result.data.product.id,
      title: result.data.product.title,
    },
  };
}

export async function updateProductTitle(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ProductTitleSnapshot>> {
  const parsed = UpdateProductTitleInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ProductTitleUpdateResponse>(
    admin,
    PRODUCT_TITLE_UPDATE_MUTATION,
    {
      product: {
        id: parsed.data.productId,
        title: parsed.data.title,
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
      title: updated.title,
    },
  };
}

// ----------------------------------------------------------------------------
// update_product_tags (write — runs from approval route, never inline)
//
// Replaces the FULL tag list. Shopify's productUpdate `tags` field is a
// SET, not a delta — passing ["a","b"] sets tags to exactly ["a","b"] and
// drops everything else. The Products manager is instructed (prompt.md)
// to call read_products first, compute the merged list (current tags +
// new tags / minus removed tags), then propose this tool with the full
// final list. Surgical add/remove via productTagsAdd/productTagsRemove
// is intentionally not exposed — one tool, one shape.
// ----------------------------------------------------------------------------

const UpdateProductTagsInput = z.object({
  productId: z.string().min(1),
  tags: z.array(z.string().min(1).max(255)).max(250),
});

const FETCH_PRODUCT_TAGS_QUERY = `#graphql
  query FetchProductTags($id: ID!) {
    product(id: $id) {
      id
      title
      tags
    }
  }
`;

const PRODUCT_TAGS_UPDATE_MUTATION = `#graphql
  mutation ProductTagsUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        tags
        updatedAt
      }
      userErrors { field message }
    }
  }
`;

type FetchTagsResponse = {
  product: { id: string; title: string; tags: string[] } | null;
};

type ProductTagsUpdateResponse = {
  productUpdate: {
    product: {
      id: string;
      title: string;
      tags: string[];
      updatedAt: string;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type ProductTagsSnapshot = {
  productId: string;
  title: string;
  tags: string[];
};

export async function fetchProductTags(
  admin: ShopifyAdmin,
  productId: string,
): Promise<ToolModuleResult<ProductTagsSnapshot>> {
  const result = await graphqlRequest<FetchTagsResponse>(
    admin,
    FETCH_PRODUCT_TAGS_QUERY,
    { id: productId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.product) {
    return { ok: false, error: `product not found: ${productId}` };
  }
  return {
    ok: true,
    data: {
      productId: result.data.product.id,
      title: result.data.product.title,
      tags: result.data.product.tags ?? [],
    },
  };
}

export async function updateProductTags(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ProductTagsSnapshot>> {
  const parsed = UpdateProductTagsInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ProductTagsUpdateResponse>(
    admin,
    PRODUCT_TAGS_UPDATE_MUTATION,
    {
      product: {
        id: parsed.data.productId,
        tags: parsed.data.tags,
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
      title: updated.title,
      tags: updated.tags ?? [],
    },
  };
}

// ----------------------------------------------------------------------------
// update_product_vendor (write — runs from approval route, never inline)
// ----------------------------------------------------------------------------

const UpdateProductVendorInput = z.object({
  productId: z.string().min(1),
  vendor: z.string().min(1).max(255),
});

const FETCH_PRODUCT_VENDOR_QUERY = `#graphql
  query FetchProductVendor($id: ID!) {
    product(id: $id) {
      id
      title
      vendor
    }
  }
`;

const PRODUCT_VENDOR_UPDATE_MUTATION = `#graphql
  mutation ProductVendorUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        vendor
        updatedAt
      }
      userErrors { field message }
    }
  }
`;

type FetchVendorResponse = {
  product: { id: string; title: string; vendor: string | null } | null;
};

type ProductVendorUpdateResponse = {
  productUpdate: {
    product: {
      id: string;
      title: string;
      vendor: string | null;
      updatedAt: string;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type ProductVendorSnapshot = {
  productId: string;
  title: string;
  vendor: string | null;
};

export async function fetchProductVendor(
  admin: ShopifyAdmin,
  productId: string,
): Promise<ToolModuleResult<ProductVendorSnapshot>> {
  const result = await graphqlRequest<FetchVendorResponse>(
    admin,
    FETCH_PRODUCT_VENDOR_QUERY,
    { id: productId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.product) {
    return { ok: false, error: `product not found: ${productId}` };
  }
  return {
    ok: true,
    data: {
      productId: result.data.product.id,
      title: result.data.product.title,
      vendor: result.data.product.vendor,
    },
  };
}

export async function updateProductVendor(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ProductVendorSnapshot>> {
  const parsed = UpdateProductVendorInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ProductVendorUpdateResponse>(
    admin,
    PRODUCT_VENDOR_UPDATE_MUTATION,
    {
      product: {
        id: parsed.data.productId,
        vendor: parsed.data.vendor,
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
      title: updated.title,
      vendor: updated.vendor,
    },
  };
}

// ----------------------------------------------------------------------------
// update_product_type (write — runs from approval route, never inline)
// ----------------------------------------------------------------------------

const UpdateProductTypeInput = z.object({
  productId: z.string().min(1),
  productType: z.string().min(1).max(255),
});

const FETCH_PRODUCT_TYPE_QUERY = `#graphql
  query FetchProductType($id: ID!) {
    product(id: $id) {
      id
      title
      productType
    }
  }
`;

const PRODUCT_TYPE_UPDATE_MUTATION = `#graphql
  mutation ProductTypeUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        productType
        updatedAt
      }
      userErrors { field message }
    }
  }
`;

type FetchTypeResponse = {
  product: { id: string; title: string; productType: string | null } | null;
};

type ProductTypeUpdateResponse = {
  productUpdate: {
    product: {
      id: string;
      title: string;
      productType: string | null;
      updatedAt: string;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type ProductTypeSnapshot = {
  productId: string;
  title: string;
  productType: string | null;
};

export async function fetchProductType(
  admin: ShopifyAdmin,
  productId: string,
): Promise<ToolModuleResult<ProductTypeSnapshot>> {
  const result = await graphqlRequest<FetchTypeResponse>(
    admin,
    FETCH_PRODUCT_TYPE_QUERY,
    { id: productId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.product) {
    return { ok: false, error: `product not found: ${productId}` };
  }
  return {
    ok: true,
    data: {
      productId: result.data.product.id,
      title: result.data.product.title,
      productType: result.data.product.productType,
    },
  };
}

export async function updateProductType(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ProductTypeSnapshot>> {
  const parsed = UpdateProductTypeInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ProductTypeUpdateResponse>(
    admin,
    PRODUCT_TYPE_UPDATE_MUTATION,
    {
      product: {
        id: parsed.data.productId,
        productType: parsed.data.productType,
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
      title: updated.title,
      productType: updated.productType,
    },
  };
}

// ----------------------------------------------------------------------------
// update_variant (write — runs from approval route, never inline)
//
// Unified variant editor. Accepts variantId + any combination of optional
// fields (sku, barcode, weight, weightUnit, inventoryPolicy,
// requiresShipping, taxable). Price and compareAtPrice live in the
// Pricing & Promotions department — intentionally not here.
//
// Shopify 2026-04: the variant-side fields (barcode, inventoryPolicy,
// taxable) live on ProductVariantsBulkInput directly; the inventory-item
// fields (sku, weight, requiresShipping) live nested under
// `inventoryItem`. The handler shape is merchant-friendly and flat;
// this function maps it to Shopify's nested shape internally.
//
// The Zod refinements enforce: (a) at least one optional field is set
// (no-op updates rejected), (b) weight and weightUnit are mutually
// required (Shopify rejects `weight` without `unit`).
// ----------------------------------------------------------------------------

const UpdateVariantInput = z
  .object({
    productId: z.string().min(1),
    variantId: z.string().min(1),
    sku: z.string().max(255).optional(),
    barcode: z.string().max(255).optional(),
    weight: z.number().nonnegative().optional(),
    weightUnit: z.enum(["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"]).optional(),
    inventoryPolicy: z.enum(["DENY", "CONTINUE"]).optional(),
    requiresShipping: z.boolean().optional(),
    taxable: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.sku !== undefined ||
      v.barcode !== undefined ||
      v.weight !== undefined ||
      v.weightUnit !== undefined ||
      v.inventoryPolicy !== undefined ||
      v.requiresShipping !== undefined ||
      v.taxable !== undefined,
    {
      message:
        "at least one of sku/barcode/weight/weightUnit/inventoryPolicy/requiresShipping/taxable must be set",
    },
  )
  .refine(
    (v) => (v.weight === undefined) === (v.weightUnit === undefined),
    { message: "weight and weightUnit must be set together" },
  );

const FETCH_VARIANT_DETAILS_QUERY = `#graphql
  query FetchVariantDetails($id: ID!) {
    productVariant(id: $id) {
      id
      title
      barcode
      inventoryPolicy
      taxable
      product { id title }
      inventoryItem {
        id
        sku
        requiresShipping
        measurement { weight { value unit } }
      }
    }
  }
`;

const VARIANT_DETAILS_BULK_UPDATE_MUTATION = `#graphql
  mutation VariantDetailsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      product { id title }
      productVariants {
        id
        title
        barcode
        inventoryPolicy
        taxable
        inventoryItem {
          id
          sku
          requiresShipping
          measurement { weight { value unit } }
        }
      }
      userErrors { field message }
    }
  }
`;

type RawVariantDetails = {
  id: string;
  title: string;
  barcode: string | null;
  inventoryPolicy: string;
  taxable: boolean;
  product?: { id: string; title: string } | null;
  inventoryItem: {
    id: string;
    sku: string | null;
    requiresShipping: boolean;
    measurement: {
      weight: { value: number; unit: string } | null;
    } | null;
  } | null;
};

type FetchVariantDetailsResponse = {
  productVariant:
    | (RawVariantDetails & { product: { id: string; title: string } | null })
    | null;
};

type VariantDetailsBulkUpdateResponse = {
  productVariantsBulkUpdate: {
    product: { id: string; title: string } | null;
    productVariants: Array<RawVariantDetails> | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type VariantDetailsSnapshot = {
  variantId: string;
  variantTitle: string;
  productId: string;
  productTitle: string;
  sku: string | null;
  barcode: string | null;
  weight: number | null;
  weightUnit: string | null;
  inventoryPolicy: string;
  requiresShipping: boolean;
  taxable: boolean;
};

function shapeVariantDetails(
  v: RawVariantDetails,
  fallbackProductId: string,
  fallbackProductTitle: string,
): VariantDetailsSnapshot {
  const weight = v.inventoryItem?.measurement?.weight ?? null;
  return {
    variantId: v.id,
    variantTitle: v.title,
    productId: v.product?.id ?? fallbackProductId,
    productTitle: v.product?.title ?? fallbackProductTitle,
    sku: v.inventoryItem?.sku ?? null,
    barcode: v.barcode,
    weight: weight?.value ?? null,
    weightUnit: weight?.unit ?? null,
    inventoryPolicy: v.inventoryPolicy,
    requiresShipping: v.inventoryItem?.requiresShipping ?? false,
    taxable: v.taxable,
  };
}

export async function fetchVariantDetails(
  admin: ShopifyAdmin,
  variantId: string,
): Promise<ToolModuleResult<VariantDetailsSnapshot>> {
  const result = await graphqlRequest<FetchVariantDetailsResponse>(
    admin,
    FETCH_VARIANT_DETAILS_QUERY,
    { id: variantId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  const v = result.data.productVariant;
  if (!v) return { ok: false, error: `variant not found: ${variantId}` };
  return { ok: true, data: shapeVariantDetails(v, "", "") };
}

export async function updateVariant(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<VariantDetailsSnapshot>> {
  const parsed = UpdateVariantInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Map merchant-friendly flat input → Shopify's nested ProductVariantsBulkInput.
  const inventoryItem: Record<string, unknown> = {};
  if (parsed.data.sku !== undefined) inventoryItem.sku = parsed.data.sku;
  if (parsed.data.requiresShipping !== undefined) {
    inventoryItem.requiresShipping = parsed.data.requiresShipping;
  }
  if (parsed.data.weight !== undefined && parsed.data.weightUnit !== undefined) {
    inventoryItem.measurement = {
      weight: { value: parsed.data.weight, unit: parsed.data.weightUnit },
    };
  }

  const variantInput: Record<string, unknown> = { id: parsed.data.variantId };
  if (parsed.data.barcode !== undefined) variantInput.barcode = parsed.data.barcode;
  if (parsed.data.inventoryPolicy !== undefined) {
    variantInput.inventoryPolicy = parsed.data.inventoryPolicy;
  }
  if (parsed.data.taxable !== undefined) variantInput.taxable = parsed.data.taxable;
  if (Object.keys(inventoryItem).length > 0) {
    variantInput.inventoryItem = inventoryItem;
  }

  const result = await graphqlRequest<VariantDetailsBulkUpdateResponse>(
    admin,
    VARIANT_DETAILS_BULK_UPDATE_MUTATION,
    {
      productId: parsed.data.productId,
      variants: [variantInput],
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
    data: shapeVariantDetails(
      variant,
      payload.product?.id ?? parsed.data.productId,
      payload.product?.title ?? "",
    ),
  };
}

// ----------------------------------------------------------------------------
// duplicate_product (write — runs from approval route, never inline)
//
// Uses Shopify's productDuplicate mutation. Returns the NEW product's
// gid + title + status so the CEO can surface it to the merchant in
// the next turn ("Duplicated to gid://… — want me to make any changes?").
//
// Snapshot represents the SOURCE product (what the duplicate came from)
// — `before` in the AuditLog reads as "duplicated FROM this product",
// `after` reads as "into this new product".
// ----------------------------------------------------------------------------

const DuplicateProductInput = z.object({
  productId: z.string().min(1),
  newTitle: z.string().min(1).max(255),
  newStatus: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
  includeImages: z.boolean().optional(),
});

const FETCH_PRODUCT_FOR_DUPLICATE_QUERY = `#graphql
  query FetchProductForDuplicate($id: ID!) {
    product(id: $id) {
      id
      title
      status
      handle
    }
  }
`;

const PRODUCT_DUPLICATE_MUTATION = `#graphql
  mutation ProductDuplicate(
    $productId: ID!,
    $newTitle: String!,
    $newStatus: ProductStatus,
    $includeImages: Boolean
  ) {
    productDuplicate(
      productId: $productId,
      newTitle: $newTitle,
      newStatus: $newStatus,
      includeImages: $includeImages
    ) {
      newProduct {
        id
        title
        status
        handle
        createdAt
      }
      userErrors { field message }
    }
  }
`;

type FetchProductForDuplicateResponse = {
  product: {
    id: string;
    title: string;
    status: string;
    handle: string;
  } | null;
};

type ProductDuplicateResponse = {
  productDuplicate: {
    newProduct: {
      id: string;
      title: string;
      status: string;
      handle: string;
      createdAt: string;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type ProductDuplicateSourceSnapshot = {
  sourceProductId: string;
  sourceTitle: string;
  sourceStatus: string;
  sourceHandle: string;
};

export type ProductDuplicateResult = {
  sourceProductId: string;
  newProductId: string;
  newTitle: string;
  newStatus: string;
  newHandle: string;
};

export async function fetchProductForDuplicate(
  admin: ShopifyAdmin,
  productId: string,
): Promise<ToolModuleResult<ProductDuplicateSourceSnapshot>> {
  const result = await graphqlRequest<FetchProductForDuplicateResponse>(
    admin,
    FETCH_PRODUCT_FOR_DUPLICATE_QUERY,
    { id: productId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.product) {
    return { ok: false, error: `product not found: ${productId}` };
  }
  return {
    ok: true,
    data: {
      sourceProductId: result.data.product.id,
      sourceTitle: result.data.product.title,
      sourceStatus: result.data.product.status,
      sourceHandle: result.data.product.handle,
    },
  };
}

export async function duplicateProduct(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ProductDuplicateResult>> {
  const parsed = DuplicateProductInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ProductDuplicateResponse>(
    admin,
    PRODUCT_DUPLICATE_MUTATION,
    {
      productId: parsed.data.productId,
      newTitle: parsed.data.newTitle,
      newStatus: parsed.data.newStatus ?? "DRAFT",
      includeImages: parsed.data.includeImages ?? true,
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const payload = result.data.productDuplicate;
  if (payload.userErrors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${payload.userErrors.map((e) => e.message).join("; ")}`,
    };
  }
  const created = payload.newProduct;
  if (!created) {
    return { ok: false, error: "productDuplicate returned no newProduct" };
  }

  return {
    ok: true,
    data: {
      sourceProductId: parsed.data.productId,
      newProductId: created.id,
      newTitle: created.title,
      newStatus: created.status,
      newHandle: created.handle,
    },
  };
}

// ----------------------------------------------------------------------------
// Image / media management (add / remove / reorder)
//
// Shopify's media API is **eventually consistent**: productCreateMedia
// returns immediately with `status: PROCESSING` (image transcoding runs
// async; READY is reached within seconds). productReorderMedia returns
// a Job that runs asynchronously. We accept this and surface the state
// in the tool result so the CEO can tell the merchant "Done — image
// processing in the background, will appear on the storefront shortly."
// Polling for READY is out of scope for v1.
//
// Note: Shopify's media mutations return `mediaUserErrors`, NOT the
// usual `userErrors`. They share the same shape but a different field
// name. Watch for that when copying patterns.
// ----------------------------------------------------------------------------

const FETCH_PRODUCT_MEDIA_QUERY = `#graphql
  query FetchProductMedia($id: ID!) {
    product(id: $id) {
      id
      title
      media(first: 100) {
        edges {
          node {
            id
            alt
            mediaContentType
            status
            preview { image { url } }
          }
        }
      }
    }
  }
`;

type FetchProductMediaResponse = {
  product: {
    id: string;
    title: string;
    media: {
      edges: Array<{
        node: {
          id: string;
          alt: string | null;
          mediaContentType: string;
          status: string;
          preview: { image: { url: string } | null } | null;
        };
      }>;
    };
  } | null;
};

export type ProductMediaItem = {
  mediaId: string;
  alt: string | null;
  mediaContentType: string;
  status: string;
  previewUrl: string | null;
};

export type ProductMediaSnapshot = {
  productId: string;
  productTitle: string;
  media: ProductMediaItem[];
};

type MediaEdge = {
  node: {
    id: string;
    alt: string | null;
    mediaContentType: string;
    status: string;
    preview: { image: { url: string } | null } | null;
  };
};

function shapeMedia(edges: MediaEdge[]): ProductMediaItem[] {
  return edges.map((edge) => ({
    mediaId: edge.node.id,
    alt: edge.node.alt,
    mediaContentType: edge.node.mediaContentType,
    status: edge.node.status,
    previewUrl: edge.node.preview?.image?.url ?? null,
  }));
}

export async function fetchProductMedia(
  admin: ShopifyAdmin,
  productId: string,
): Promise<ToolModuleResult<ProductMediaSnapshot>> {
  const result = await graphqlRequest<FetchProductMediaResponse>(
    admin,
    FETCH_PRODUCT_MEDIA_QUERY,
    { id: productId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.product) {
    return { ok: false, error: `product not found: ${productId}` };
  }
  return {
    ok: true,
    data: {
      productId: result.data.product.id,
      productTitle: result.data.product.title,
      media: shapeMedia(result.data.product.media.edges),
    },
  };
}

// ----------------------------------------------------------------------------
// add_product_image (write — runs from approval route, never inline)
// ----------------------------------------------------------------------------

const AddProductImageInput = z.object({
  productId: z.string().min(1),
  imageUrl: z
    .string()
    .min(1)
    .regex(
      /^https:\/\/\S+$/,
      "imageUrl must be a valid HTTPS URL — Shopify rejects http:// URLs",
    ),
  altText: z.string().max(512).optional(),
});

const PRODUCT_CREATE_MEDIA_MUTATION = `#graphql
  mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        ... on MediaImage {
          id
          alt
          mediaContentType
          status
          preview { image { url } }
        }
      }
      mediaUserErrors { field message }
    }
  }
`;

type ProductCreateMediaResponse = {
  productCreateMedia: {
    media: Array<{
      id: string;
      alt: string | null;
      mediaContentType: string;
      status: string;
      preview: { image: { url: string } | null } | null;
    } | null> | null;
    mediaUserErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type AddedProductImage = {
  productId: string;
  mediaId: string;
  alt: string | null;
  status: string;
  previewUrl: string | null;
};

export async function addProductImage(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<AddedProductImage>> {
  const parsed = AddProductImageInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ProductCreateMediaResponse>(
    admin,
    PRODUCT_CREATE_MEDIA_MUTATION,
    {
      productId: parsed.data.productId,
      media: [
        {
          originalSource: parsed.data.imageUrl,
          mediaContentType: "IMAGE",
          ...(parsed.data.altText ? { alt: parsed.data.altText } : {}),
        },
      ],
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.productCreateMedia.mediaUserErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify mediaUserErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const created = result.data.productCreateMedia.media?.[0];
  if (!created) {
    return { ok: false, error: "productCreateMedia returned no media" };
  }

  return {
    ok: true,
    data: {
      productId: parsed.data.productId,
      mediaId: created.id,
      alt: created.alt,
      status: created.status,
      previewUrl: created.preview?.image?.url ?? null,
    },
  };
}

// ----------------------------------------------------------------------------
// remove_product_image (write — runs from approval route, never inline)
// ----------------------------------------------------------------------------

const RemoveProductImageInput = z.object({
  productId: z.string().min(1),
  mediaId: z.string().min(1),
});

const PRODUCT_DELETE_MEDIA_MUTATION = `#graphql
  mutation ProductDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors { field message }
    }
  }
`;

type ProductDeleteMediaResponse = {
  productDeleteMedia: {
    deletedMediaIds: string[] | null;
    mediaUserErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type RemovedProductImage = {
  productId: string;
  removedMediaId: string;
};

export async function removeProductImage(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<RemovedProductImage>> {
  const parsed = RemoveProductImageInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ProductDeleteMediaResponse>(
    admin,
    PRODUCT_DELETE_MEDIA_MUTATION,
    {
      productId: parsed.data.productId,
      mediaIds: [parsed.data.mediaId],
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.productDeleteMedia.mediaUserErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify mediaUserErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const deleted = result.data.productDeleteMedia.deletedMediaIds ?? [];
  if (deleted.length === 0) {
    return {
      ok: false,
      error: `productDeleteMedia returned no deletedMediaIds — media ${parsed.data.mediaId} may not belong to product ${parsed.data.productId}`,
    };
  }

  return {
    ok: true,
    data: {
      productId: parsed.data.productId,
      removedMediaId: deleted[0],
    },
  };
}

// ----------------------------------------------------------------------------
// reorder_product_images (write — runs from approval route, never inline)
//
// productReorderMedia is asynchronous — it returns a Job, not the
// final media state. Callers receive the jobId; merchants will see
// the new order on the storefront within a second or two. Polling
// the job to "READY" is out of scope for v1.
//
// Input is the desired FINAL order. The handler converts to Shopify's
// move list (each id paired with its target index).
// ----------------------------------------------------------------------------

const ReorderProductImagesInput = z.object({
  productId: z.string().min(1),
  orderedMediaIds: z.array(z.string().min(1)).min(1).max(100),
});

const PRODUCT_REORDER_MEDIA_MUTATION = `#graphql
  mutation ProductReorderMedia($id: ID!, $moves: [MoveInput!]!) {
    productReorderMedia(id: $id, moves: $moves) {
      job { id done }
      mediaUserErrors { field message }
    }
  }
`;

type ProductReorderMediaResponse = {
  productReorderMedia: {
    job: { id: string; done: boolean } | null;
    mediaUserErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type ReorderedProductImages = {
  productId: string;
  jobId: string | null;
  done: boolean;
  newOrder: string[];
};

export async function reorderProductImages(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReorderedProductImages>> {
  const parsed = ReorderProductImagesInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Convert the desired final order → Shopify's move list. Each
  // move's newPosition is the target index as a string. Shopify
  // applies moves in array order with positions interpreted in the
  // final state, so this maps cleanly even when items shift.
  const moves = parsed.data.orderedMediaIds.map((id, idx) => ({
    id,
    newPosition: String(idx),
  }));

  const result = await graphqlRequest<ProductReorderMediaResponse>(
    admin,
    PRODUCT_REORDER_MEDIA_MUTATION,
    {
      id: parsed.data.productId,
      moves,
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.productReorderMedia.mediaUserErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify mediaUserErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }

  const job = result.data.productReorderMedia.job;
  return {
    ok: true,
    data: {
      productId: parsed.data.productId,
      jobId: job?.id ?? null,
      done: job?.done ?? false,
      newOrder: parsed.data.orderedMediaIds,
    },
  };
}

// ============================================================================
// V-Bulk-A — Phase Bulk Operations Round A. Three product-level bulk-write
// tools modeled byte-for-byte on bulk_update_prices in pricing.server.ts:
//
//   - bulk_update_titles  — XOR scope + transform { append | prepend | find_replace }
//   - bulk_update_tags    — XOR scope + action { add | remove | replace } + tags[]
//   - bulk_update_status  — XOR scope + status { DRAFT | ACTIVE | ARCHIVED }
//
// Shared design (mirroring bulk_update_prices):
//   - XOR scope: collectionId | productIds (cap 50; collection-resolved
//     products refused if > 50 — same per-call cap as bulk pricing)
//   - One batched fetch up front to capture pre-state (title/tags/status
//     per product) for the result.changes[] payload
//   - Sequential per-product productUpdate mutations (rate-limit safe)
//   - Partial-failure resilient: per-product errors aggregate into
//     failures[]; the rest of the batch proceeds
//   - Result shape: { totalUpdated, totalFailed, changes[], failures[] }
//   - snapshotBefore in executor.server.ts returns null for these tools
//     (matches bulk_update_prices short-circuit) — the result payload
//     already carries the full per-item before/after diff
// ============================================================================

const MAX_PRODUCTS_BULK_OP = 50;
const MAX_TAGS_PER_BULK_REQUEST = 50;

const FETCH_BULK_PRODUCTS_QUERY = `#graphql
  query FetchBulkProducts($first: Int!, $query: String) {
    products(first: $first, query: $query) {
      edges { node { id title tags status } }
    }
  }
`;

const FETCH_BULK_COLLECTION_PRODUCTS_QUERY = `#graphql
  query FetchBulkCollectionProducts($id: ID!, $first: Int!) {
    collection(id: $id) {
      id
      title
      products(first: $first) {
        edges { node { id title tags status } }
      }
    }
  }
`;

// One shared mutation for all three bulk tools — accepts any subset of
// {title, tags, status} on the input and returns all three on the output.
// Each tool sends only its relevant field; the response carries the
// after-state for the changes[] entry.
const BULK_PRODUCT_FIELD_UPDATE_MUTATION = `#graphql
  mutation BulkProductFieldUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title tags status updatedAt }
      userErrors { field message }
    }
  }
`;

type BulkProductSnapshot = {
  productId: string;
  productTitle: string;
  tags: string[];
  status: string;
};

type FetchBulkProductsResponse = {
  products: {
    edges: Array<{
      node: { id: string; title: string; tags: string[]; status: string };
    }>;
  };
};

type FetchBulkCollectionProductsResponse = {
  collection: {
    id: string;
    title: string;
    products: {
      edges: Array<{
        node: { id: string; title: string; tags: string[]; status: string };
      }>;
    };
  } | null;
};

type BulkProductFieldUpdateResponse = {
  productUpdate: {
    product: {
      id: string;
      title: string;
      tags: string[];
      status: string;
      updatedAt: string;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

// Resolve the XOR scope to {found, missing} so callers can mutate what
// resolves and surface the rest. Phase Re Round Re-D — the previous
// behavior failed the WHOLE operation if any one productId was missing,
// which silently lost data when stale IDs reached the executor (ID list
// generated minutes earlier, products deleted in admin during the gap).
// Now: partition. The downstream bulk-update loops mutate `found[]`
// and pass `missing[]` through unchanged so the agent can ask the
// merchant.
type ResolveBulkScope = {
  found: BulkProductSnapshot[];
  missing: string[];
};

async function resolveBulkProductScope(
  admin: ShopifyAdmin,
  scope: { collectionId?: string; productIds?: string[] },
): Promise<ToolModuleResult<ResolveBulkScope>> {
  if (scope.collectionId) {
    const r = await graphqlRequest<FetchBulkCollectionProductsResponse>(
      admin,
      FETCH_BULK_COLLECTION_PRODUCTS_QUERY,
      { id: scope.collectionId, first: MAX_PRODUCTS_BULK_OP + 1 },
    );
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.data.collection) {
      return {
        ok: false,
        error: `collection not found: ${scope.collectionId}`,
      };
    }
    const edges = r.data.collection.products.edges;
    if (edges.length > MAX_PRODUCTS_BULK_OP) {
      return {
        ok: false,
        error: `collection has more than ${MAX_PRODUCTS_BULK_OP} products — too many for a single bulk update. Scope down (e.g. by status filter) or split into multiple operations.`,
      };
    }
    return {
      ok: true,
      data: {
        found: edges.map((e) => ({
          productId: e.node.id,
          productTitle: e.node.title,
          tags: e.node.tags ?? [],
          status: e.node.status,
        })),
        missing: [],
      },
    };
  }

  if (scope.productIds && scope.productIds.length > 0) {
    // Shopify's `products(query: ...)` filter `id:` accepts the bare
    // numeric ID only — full GIDs like `gid://shopify/Product/123` break
    // the search parser (the `:` and `/` chars are reserved syntax), so
    // every requested ID would silently fall into `missing[]`. Strip the
    // GID prefix when building the filter, then keep the full GID as the
    // lookup key (Shopify's response carries full GIDs back).
    const numericIds = scope.productIds.map((id) => id.split("/").pop() ?? id);
    const queryStr = numericIds.map((n) => `id:${n}`).join(" OR ");
    const r = await graphqlRequest<FetchBulkProductsResponse>(
      admin,
      FETCH_BULK_PRODUCTS_QUERY,
      { first: scope.productIds.length, query: queryStr },
    );
    if (!r.ok) return { ok: false, error: r.error };
    const lookup = new Map(
      r.data.products.edges.map((e) => [e.node.id, e.node]),
    );
    const found: BulkProductSnapshot[] = [];
    const missing: string[] = [];
    for (const id of scope.productIds) {
      const node = lookup.get(id);
      if (!node) {
        missing.push(id);
        continue;
      }
      found.push({
        productId: node.id,
        productTitle: node.title,
        tags: node.tags ?? [],
        status: node.status,
      });
    }
    return { ok: true, data: { found, missing } };
  }

  // Unreachable — Zod refinement guarantees one scope is set.
  return { ok: false, error: "no scope set" };
}

// Shared XOR-scope refinement used across the three bulk schemas.
const xorScopeRefine = (v: {
  collectionId?: string;
  productIds?: string[];
}): boolean => {
  const set = [
    v.collectionId !== undefined,
    v.productIds !== undefined,
  ].filter(Boolean).length;
  return set === 1;
};
const xorScopeMessage =
  "exactly one of collectionId / productIds must be set";

// ----------------------------------------------------------------------------
// bulk_update_titles
// ----------------------------------------------------------------------------

export const BulkUpdateTitlesInput = z
  .object({
    collectionId: z.string().min(1).optional(),
    productIds: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_PRODUCTS_BULK_OP)
      .optional(),
    transform: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("append"),
        text: z.string().min(1).max(255),
      }),
      z.object({
        kind: z.literal("prepend"),
        text: z.string().min(1).max(255),
      }),
      z.object({
        kind: z.literal("find_replace"),
        find: z.string().min(1).max(255),
        // Empty replace is allowed (delete-substring semantics).
        replace: z.string().max(255),
      }),
    ]),
  })
  .refine(xorScopeRefine, { message: xorScopeMessage });

export type BulkTitleChange = {
  productId: string;
  oldTitle: string;
  newTitle: string;
};

export type BulkUpdateTitlesResult = {
  totalUpdated: number;
  totalFailed: number;
  totalMissing: number;
  changes: BulkTitleChange[];
  failures: Array<{
    productId: string;
    productTitle: string;
    error: string;
  }>;
  missing: string[];
};

export async function bulkUpdateTitles(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<BulkUpdateTitlesResult>> {
  const parsed = BulkUpdateTitlesInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const resolved = await resolveBulkProductScope(admin, parsed.data);
  if (!resolved.ok) return resolved;
  const products = resolved.data.found;
  const missing = resolved.data.missing;
  if (products.length === 0) {
    return {
      ok: false,
      error:
        missing.length > 0
          ? `scope resolved to 0 products — every requested productId is missing (likely deleted between propose-time and execute-time): ${missing.join(", ")}`
          : "scope resolved to 0 products — nothing to update",
    };
  }

  // Compute new title per product
  const transform = parsed.data.transform;
  type Plan = { snap: BulkProductSnapshot; newTitle: string; invalid: boolean };
  const plan: Plan[] = [];
  for (const snap of products) {
    let newTitle: string;
    if (transform.kind === "append") {
      newTitle = snap.productTitle + transform.text;
    } else if (transform.kind === "prepend") {
      newTitle = transform.text + snap.productTitle;
    } else {
      newTitle = snap.productTitle.split(transform.find).join(transform.replace);
    }
    if (newTitle === snap.productTitle) {
      // No-op — skip silently to save rate-limit budget.
      continue;
    }
    const invalid = newTitle.length === 0 || newTitle.length > 255;
    plan.push({ snap, newTitle, invalid });
  }

  if (plan.length === 0) {
    return {
      ok: false,
      error:
        "transform produced no changes — every title already matches the desired output",
    };
  }

  const changes: BulkTitleChange[] = [];
  const failures: Array<{
    productId: string;
    productTitle: string;
    error: string;
  }> = [];

  for (const p of plan) {
    if (p.invalid) {
      failures.push({
        productId: p.snap.productId,
        productTitle: p.snap.productTitle,
        error:
          "computed title would be empty or exceed 255 characters — skipped",
      });
      continue;
    }
    const r = await graphqlRequest<BulkProductFieldUpdateResponse>(
      admin,
      BULK_PRODUCT_FIELD_UPDATE_MUTATION,
      { product: { id: p.snap.productId, title: p.newTitle } },
    );
    if (!r.ok) {
      failures.push({
        productId: p.snap.productId,
        productTitle: p.snap.productTitle,
        error: r.error,
      });
      continue;
    }
    const errors = r.data.productUpdate.userErrors;
    if (errors.length > 0) {
      failures.push({
        productId: p.snap.productId,
        productTitle: p.snap.productTitle,
        error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
      });
      continue;
    }
    const updated = r.data.productUpdate.product;
    if (!updated) {
      failures.push({
        productId: p.snap.productId,
        productTitle: p.snap.productTitle,
        error: "productUpdate returned no product",
      });
      continue;
    }
    changes.push({
      productId: updated.id,
      oldTitle: p.snap.productTitle,
      newTitle: updated.title,
    });
  }

  return {
    ok: true,
    data: {
      totalUpdated: changes.length,
      totalFailed: failures.length,
      totalMissing: missing.length,
      changes,
      failures,
      missing,
    },
  };
}

// ----------------------------------------------------------------------------
// bulk_update_tags
// ----------------------------------------------------------------------------

export const BulkUpdateTagsInput = z
  .object({
    collectionId: z.string().min(1).optional(),
    productIds: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_PRODUCTS_BULK_OP)
      .optional(),
    action: z.enum(["add", "remove", "replace"]),
    tags: z
      .array(z.string().min(1).max(255))
      .min(1)
      .max(MAX_TAGS_PER_BULK_REQUEST),
  })
  .refine(xorScopeRefine, { message: xorScopeMessage });

export type BulkTagsChange = {
  productId: string;
  productTitle: string;
  oldTags: string[];
  newTags: string[];
};

export type BulkUpdateTagsResult = {
  totalUpdated: number;
  totalFailed: number;
  totalMissing: number;
  changes: BulkTagsChange[];
  failures: Array<{
    productId: string;
    productTitle: string;
    error: string;
  }>;
  missing: string[];
};

// Sorted-equality helper for tag-list comparison (no-op detection).
function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

export async function bulkUpdateTags(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<BulkUpdateTagsResult>> {
  const parsed = BulkUpdateTagsInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const resolved = await resolveBulkProductScope(admin, parsed.data);
  if (!resolved.ok) return resolved;
  const products = resolved.data.found;
  const missing = resolved.data.missing;
  if (products.length === 0) {
    return {
      ok: false,
      error:
        missing.length > 0
          ? `scope resolved to 0 products — every requested productId is missing (likely deleted between propose-time and execute-time): ${missing.join(", ")}`
          : "scope resolved to 0 products — nothing to update",
    };
  }

  const action = parsed.data.action;
  const requestedTags = parsed.data.tags;

  // Compute new tag list per product per action semantics.
  type Plan = { snap: BulkProductSnapshot; newTags: string[] };
  const plan: Plan[] = [];
  for (const snap of products) {
    let newTags: string[];
    if (action === "replace") {
      // Full replacement; de-dupe to be defensive.
      newTags = Array.from(new Set(requestedTags));
    } else if (action === "add") {
      // Union (case-insensitive — Shopify normalizes anyway).
      const existingLower = new Set(snap.tags.map((t) => t.toLowerCase()));
      const merged = [...snap.tags];
      for (const t of requestedTags) {
        if (!existingLower.has(t.toLowerCase())) {
          merged.push(t);
          existingLower.add(t.toLowerCase());
        }
      }
      newTags = merged;
    } else {
      // remove
      const removeLower = new Set(requestedTags.map((t) => t.toLowerCase()));
      newTags = snap.tags.filter((t) => !removeLower.has(t.toLowerCase()));
    }

    // Skip no-ops.
    if (tagsEqual(snap.tags, newTags)) continue;

    plan.push({ snap, newTags });
  }

  if (plan.length === 0) {
    return {
      ok: false,
      error: `transform produced no changes — every product already matches the expected tag state for action "${action}"`,
    };
  }

  const changes: BulkTagsChange[] = [];
  const failures: Array<{
    productId: string;
    productTitle: string;
    error: string;
  }> = [];

  for (const p of plan) {
    const r = await graphqlRequest<BulkProductFieldUpdateResponse>(
      admin,
      BULK_PRODUCT_FIELD_UPDATE_MUTATION,
      { product: { id: p.snap.productId, tags: p.newTags } },
    );
    if (!r.ok) {
      failures.push({
        productId: p.snap.productId,
        productTitle: p.snap.productTitle,
        error: r.error,
      });
      continue;
    }
    const errors = r.data.productUpdate.userErrors;
    if (errors.length > 0) {
      failures.push({
        productId: p.snap.productId,
        productTitle: p.snap.productTitle,
        error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
      });
      continue;
    }
    const updated = r.data.productUpdate.product;
    if (!updated) {
      failures.push({
        productId: p.snap.productId,
        productTitle: p.snap.productTitle,
        error: "productUpdate returned no product",
      });
      continue;
    }
    changes.push({
      productId: updated.id,
      productTitle: updated.title,
      oldTags: p.snap.tags,
      newTags: updated.tags ?? [],
    });
  }

  return {
    ok: true,
    data: {
      totalUpdated: changes.length,
      totalFailed: failures.length,
      totalMissing: missing.length,
      changes,
      failures,
      missing,
    },
  };
}

// ----------------------------------------------------------------------------
// bulk_update_status
// ----------------------------------------------------------------------------

export const BulkUpdateStatusInput = z
  .object({
    collectionId: z.string().min(1).optional(),
    productIds: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_PRODUCTS_BULK_OP)
      .optional(),
    status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]),
  })
  .refine(xorScopeRefine, { message: xorScopeMessage });

export type BulkStatusChange = {
  productId: string;
  productTitle: string;
  oldStatus: string;
  newStatus: string;
};

export type BulkUpdateStatusResult = {
  totalUpdated: number;
  totalFailed: number;
  totalMissing: number;
  changes: BulkStatusChange[];
  failures: Array<{
    productId: string;
    productTitle: string;
    error: string;
  }>;
  missing: string[];
};

export async function bulkUpdateStatus(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<BulkUpdateStatusResult>> {
  const parsed = BulkUpdateStatusInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const resolved = await resolveBulkProductScope(admin, parsed.data);
  if (!resolved.ok) return resolved;
  const products = resolved.data.found;
  const missing = resolved.data.missing;
  if (products.length === 0) {
    return {
      ok: false,
      error:
        missing.length > 0
          ? `scope resolved to 0 products — every requested productId is missing (likely deleted between propose-time and execute-time): ${missing.join(", ")}`
          : "scope resolved to 0 products — nothing to update",
    };
  }

  const newStatus = parsed.data.status;

  // Skip no-ops (products already at the target status).
  const plan = products.filter((p) => p.status !== newStatus);
  if (plan.length === 0) {
    return {
      ok: false,
      error:
        missing.length > 0
          ? `every resolvable product is already ${newStatus} — nothing to change. ${missing.length} requested productId(s) were missing: ${missing.join(", ")}`
          : `every product is already ${newStatus} — nothing to change`,
    };
  }

  const changes: BulkStatusChange[] = [];
  const failures: Array<{
    productId: string;
    productTitle: string;
    error: string;
  }> = [];

  for (const snap of plan) {
    const r = await graphqlRequest<BulkProductFieldUpdateResponse>(
      admin,
      BULK_PRODUCT_FIELD_UPDATE_MUTATION,
      { product: { id: snap.productId, status: newStatus } },
    );
    if (!r.ok) {
      failures.push({
        productId: snap.productId,
        productTitle: snap.productTitle,
        error: r.error,
      });
      continue;
    }
    const errors = r.data.productUpdate.userErrors;
    if (errors.length > 0) {
      failures.push({
        productId: snap.productId,
        productTitle: snap.productTitle,
        error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
      });
      continue;
    }
    const updated = r.data.productUpdate.product;
    if (!updated) {
      failures.push({
        productId: snap.productId,
        productTitle: snap.productTitle,
        error: "productUpdate returned no product",
      });
      continue;
    }
    changes.push({
      productId: updated.id,
      productTitle: updated.title,
      oldStatus: snap.status,
      newStatus: updated.status,
    });
  }

  return {
    ok: true,
    data: {
      totalUpdated: changes.length,
      totalFailed: failures.length,
      totalMissing: missing.length,
      changes,
      failures,
      missing,
    },
  };
}

// ----------------------------------------------------------------------------
// Test seam — exported only for unit tests (Zod schema introspection,
// no-op equality helper).
// ----------------------------------------------------------------------------

export const _bulkTesting = {
  MAX_PRODUCTS_BULK_OP,
  MAX_TAGS_PER_BULK_REQUEST,
  tagsEqual,
};
