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

const FETCH_VARIANT_PRICE_QUERY = `#graphql
  query FetchVariantPrice($id: ID!) {
    productVariant(id: $id) {
      id
      title
      price
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
    },
  };
}
