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
          totalInventory
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export type ProductSummary = {
  id: string;
  title: string;
  handle: string;
  status: string;
  productType: string | null;
  vendor: string | null;
  totalInventory: number | null;
  priceRange: {
    min: { amount: string; currencyCode: string };
    max: { amount: string; currencyCode: string };
  };
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
        totalInventory: number | null;
        priceRangeV2: {
          minVariantPrice: { amount: string; currencyCode: string };
          maxVariantPrice: { amount: string; currencyCode: string };
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

  const products: ProductSummary[] = result.data.products.edges.map((edge) => ({
    id: edge.node.id,
    title: edge.node.title,
    handle: edge.node.handle,
    status: edge.node.status,
    productType: edge.node.productType,
    vendor: edge.node.vendor,
    totalInventory: edge.node.totalInventory,
    priceRange: {
      min: edge.node.priceRangeV2.minVariantPrice,
      max: edge.node.priceRangeV2.maxVariantPrice,
    },
  }));

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
