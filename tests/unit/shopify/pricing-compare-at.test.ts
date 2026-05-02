import { describe, expect, it } from "vitest";

import {
  fetchVariantPrice,
  updateCompareAtPrice,
} from "../../../app/lib/shopify/pricing.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateCompareAtPrice", () => {
  it("happy path — sets compareAtPrice and returns the new variant snapshot", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariantsBulkUpdate: {
            product: { id: "gid://shopify/Product/1", title: "Cat Food" },
            productVariants: [
              {
                id: "gid://shopify/ProductVariant/10",
                title: "Default Title",
                price: "19.99",
                compareAtPrice: "29.99",
              },
            ],
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateCompareAtPrice(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/10",
      newCompareAtPrice: "29.99",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      variantId: "gid://shopify/ProductVariant/10",
      variantTitle: "Default Title",
      productId: "gid://shopify/Product/1",
      productTitle: "Cat Food",
      price: "19.99",
      compareAtPrice: "29.99",
    });
    expect(admin.calls[0].variables).toEqual({
      productId: "gid://shopify/Product/1",
      variants: [
        {
          id: "gid://shopify/ProductVariant/10",
          compareAtPrice: "29.99",
        },
      ],
    });
  });

  it('clears the strikethrough when newCompareAtPrice is "" (maps to null)', async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariantsBulkUpdate: {
            product: { id: "gid://shopify/Product/1", title: "Cat Food" },
            productVariants: [
              {
                id: "gid://shopify/ProductVariant/10",
                title: "Default Title",
                price: "19.99",
                compareAtPrice: null,
              },
            ],
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateCompareAtPrice(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/10",
      newCompareAtPrice: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.compareAtPrice).toBeNull();
    expect(admin.calls[0].variables).toEqual({
      productId: "gid://shopify/Product/1",
      variants: [
        { id: "gid://shopify/ProductVariant/10", compareAtPrice: null },
      ],
    });
  });

  it('clears the strikethrough when newCompareAtPrice is "0" (maps to null)', async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariantsBulkUpdate: {
            product: { id: "gid://shopify/Product/1", title: "Cat Food" },
            productVariants: [
              {
                id: "gid://shopify/ProductVariant/10",
                title: "Default Title",
                price: "19.99",
                compareAtPrice: null,
              },
            ],
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateCompareAtPrice(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/10",
      newCompareAtPrice: "0",
    });

    expect(result.ok).toBe(true);
    expect(admin.calls[0].variables).toEqual({
      productId: "gid://shopify/Product/1",
      variants: [
        { id: "gid://shopify/ProductVariant/10", compareAtPrice: null },
      ],
    });
  });

  it("rejects malformed price via Zod (non-decimal)", async () => {
    const admin = fakeAdmin([]);
    const result = await updateCompareAtPrice(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/10",
      newCompareAtPrice: "$29.99",
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
              {
                field: ["variants", "0", "compareAtPrice"],
                message: "Compare-at price must be greater than price",
              },
            ],
          },
        },
      },
    ]);
    const result = await updateCompareAtPrice(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/10",
      newCompareAtPrice: "10.00",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Compare-at price must be greater than price");
  });
});

describe("fetchVariantPrice — extended with compareAtPrice", () => {
  it("includes compareAtPrice in the snapshot when set", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariant: {
            id: "gid://shopify/ProductVariant/10",
            title: "Default Title",
            price: "19.99",
            compareAtPrice: "29.99",
            product: { id: "gid://shopify/Product/1", title: "Cat Food" },
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
    expect(result.data.price).toBe("19.99");
    expect(result.data.compareAtPrice).toBe("29.99");
  });

  it("returns null compareAtPrice when not set", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariant: {
            id: "gid://shopify/ProductVariant/10",
            title: "Default Title",
            price: "19.99",
            compareAtPrice: null,
            product: { id: "gid://shopify/Product/1", title: "Cat Food" },
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
    expect(result.data.compareAtPrice).toBeNull();
  });
});
