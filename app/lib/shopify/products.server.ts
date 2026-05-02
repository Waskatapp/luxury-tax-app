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
