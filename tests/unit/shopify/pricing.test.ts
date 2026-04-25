import { describe, expect, it } from "vitest";

import {
  fetchVariantPrice,
  updateProductPrice,
} from "../../../app/lib/shopify/pricing.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateProductPrice", () => {
  it("happy path — sends productVariantsBulkUpdate and returns the new variant snapshot", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariantsBulkUpdate: {
            product: { id: "gid://shopify/Product/1", title: "Dog Washer" },
            productVariants: [
              { id: "gid://shopify/ProductVariant/10", title: "Default Title", price: "19.99" },
            ],
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateProductPrice(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/10",
      newPrice: "19.99",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      variantId: "gid://shopify/ProductVariant/10",
      variantTitle: "Default Title",
      productId: "gid://shopify/Product/1",
      productTitle: "Dog Washer",
      price: "19.99",
    });
    expect(admin.calls[0].variables).toEqual({
      productId: "gid://shopify/Product/1",
      variants: [{ id: "gid://shopify/ProductVariant/10", price: "19.99" }],
    });
  });

  it("rejects malformed input via Zod (non-decimal price)", async () => {
    const admin = fakeAdmin([]);
    const result = await updateProductPrice(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/10",
      newPrice: "$19.99",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/invalid input/);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors as ok:false", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariantsBulkUpdate: {
            product: null,
            productVariants: null,
            userErrors: [
              { field: ["variants", "0", "price"], message: "Price must be greater than zero" },
            ],
          },
        },
      },
    ]);
    const result = await updateProductPrice(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/10",
      newPrice: "0.00",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Price must be greater than zero");
  });

  it("surfaces top-level shopify graphql errors", async () => {
    const admin = fakeAdmin([
      { kind: "errors", errors: [{ message: "Throttled" }] },
    ]);
    const result = await updateProductPrice(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/10",
      newPrice: "19.99",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Throttled");
  });
});

describe("fetchVariantPrice", () => {
  it("returns the snapshot used for the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariant: {
            id: "gid://shopify/ProductVariant/10",
            title: "Default Title",
            price: "29.99",
            product: { id: "gid://shopify/Product/1", title: "Dog Washer" },
          },
        },
      },
    ]);

    const result = await fetchVariantPrice(
      admin,
      "gid://shopify/ProductVariant/10",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.price).toBe("29.99");
    expect(result.data.productTitle).toBe("Dog Washer");
  });

  it("returns ok:false if Shopify returns null variant", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { productVariant: null } }]);
    const result = await fetchVariantPrice(admin, "gid://shopify/ProductVariant/missing");
    expect(result.ok).toBe(false);
  });
});
