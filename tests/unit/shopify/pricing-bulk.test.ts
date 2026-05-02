import { describe, expect, it } from "vitest";

import { bulkUpdatePrices } from "../../../app/lib/shopify/pricing.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// Helper: a productVariantsBulkUpdate response for one product with N variants.
function bulkUpdateOk(
  productId: string,
  productTitle: string,
  variants: Array<{ id: string; title: string; price: string }>,
) {
  return {
    kind: "data" as const,
    body: {
      productVariantsBulkUpdate: {
        product: { id: productId, title: productTitle },
        productVariants: variants.map((v) => ({
          ...v,
          compareAtPrice: null,
        })),
        userErrors: [],
      },
    },
  };
}

describe("bulkUpdatePrices — input validation", () => {
  it("rejects when no scope is set", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdatePrices(admin, {
      changeType: "percentage",
      changeValue: 10,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects when more than one scope is set", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdatePrices(admin, {
      collectionId: "gid://shopify/Collection/1",
      productIds: ["gid://shopify/Product/1"],
      changeType: "percentage",
      changeValue: 10,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects changeValue of 0 (no-op)", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdatePrices(admin, {
      variantIds: ["gid://shopify/ProductVariant/1"],
      changeType: "percentage",
      changeValue: 0,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects percentage outside [-100, +500]", async () => {
    const admin = fakeAdmin([]);
    const tooHigh = await bulkUpdatePrices(admin, {
      variantIds: ["gid://shopify/ProductVariant/1"],
      changeType: "percentage",
      changeValue: 1000,
    });
    expect(tooHigh.ok).toBe(false);

    const tooLow = await bulkUpdatePrices(admin, {
      variantIds: ["gid://shopify/ProductVariant/1"],
      changeType: "percentage",
      changeValue: -200,
    });
    expect(tooLow.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });
});

describe("bulkUpdatePrices — happy paths", () => {
  it("variantIds path — applies percentage and updates per-product", async () => {
    const admin = fakeAdmin([
      // Variant fetch 1
      {
        kind: "data",
        body: {
          productVariant: {
            id: "gid://shopify/ProductVariant/1",
            title: "Small",
            price: "10.00",
            compareAtPrice: null,
            product: { id: "gid://shopify/Product/100", title: "Cat Food" },
          },
        },
      },
      // Variant fetch 2
      {
        kind: "data",
        body: {
          productVariant: {
            id: "gid://shopify/ProductVariant/2",
            title: "Large",
            price: "20.00",
            compareAtPrice: null,
            product: { id: "gid://shopify/Product/100", title: "Cat Food" },
          },
        },
      },
      // Bulk update for Product/100 (both variants in one call)
      bulkUpdateOk("gid://shopify/Product/100", "Cat Food", [
        { id: "gid://shopify/ProductVariant/1", title: "Small", price: "11.00" },
        { id: "gid://shopify/ProductVariant/2", title: "Large", price: "22.00" },
      ]),
    ]);

    const result = await bulkUpdatePrices(admin, {
      variantIds: [
        "gid://shopify/ProductVariant/1",
        "gid://shopify/ProductVariant/2",
      ],
      changeType: "percentage",
      changeValue: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(2);
    expect(result.data.totalFailed).toBe(0);
    expect(result.data.changes).toHaveLength(2);
    expect(result.data.changes[0].oldPrice).toBe("10.00");
    expect(result.data.changes[0].newPrice).toBe("11.00");
    expect(result.data.changes[1].oldPrice).toBe("20.00");
    expect(result.data.changes[1].newPrice).toBe("22.00");
  });

  it("productIds path — fetches variants and applies fixed_amount", async () => {
    const admin = fakeAdmin([
      // Product fetch
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/100",
            title: "Cat Food",
            variants: {
              edges: [
                { node: { id: "gid://shopify/ProductVariant/1", title: "Small", price: "10.00" } },
              ],
            },
          },
        },
      },
      // Bulk update
      bulkUpdateOk("gid://shopify/Product/100", "Cat Food", [
        { id: "gid://shopify/ProductVariant/1", title: "Small", price: "12.50" },
      ]),
    ]);

    const result = await bulkUpdatePrices(admin, {
      productIds: ["gid://shopify/Product/100"],
      changeType: "fixed_amount",
      changeValue: 2.5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(1);
    expect(result.data.changes[0].newPrice).toBe("12.50");
  });

  it("collectionId path — expands all products in collection", async () => {
    const admin = fakeAdmin([
      // Collection fetch
      {
        kind: "data",
        body: {
          collection: {
            id: "gid://shopify/Collection/1",
            title: "Holiday 2026",
            products: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Product/100",
                    title: "Cat Food",
                    variants: {
                      edges: [
                        { node: { id: "gid://shopify/ProductVariant/1", title: "Small", price: "10.00" } },
                      ],
                    },
                  },
                },
                {
                  node: {
                    id: "gid://shopify/Product/200",
                    title: "Dog Food",
                    variants: {
                      edges: [
                        { node: { id: "gid://shopify/ProductVariant/2", title: "Default", price: "20.00" } },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
      // Bulk update for Product/100
      bulkUpdateOk("gid://shopify/Product/100", "Cat Food", [
        { id: "gid://shopify/ProductVariant/1", title: "Small", price: "11.00" },
      ]),
      // Bulk update for Product/200
      bulkUpdateOk("gid://shopify/Product/200", "Dog Food", [
        { id: "gid://shopify/ProductVariant/2", title: "Default", price: "22.00" },
      ]),
    ]);

    const result = await bulkUpdatePrices(admin, {
      collectionId: "gid://shopify/Collection/1",
      changeType: "percentage",
      changeValue: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(2);
    expect(result.data.changes).toHaveLength(2);
  });

  it('roundTo ".99" — applies pretty rounding after compute', async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariant: {
            id: "gid://shopify/ProductVariant/1",
            title: "Default",
            price: "10.00",
            compareAtPrice: null,
            product: { id: "gid://shopify/Product/1", title: "P" },
          },
        },
      },
      // 10.00 + 10% = 11.00; rounded to .99 = 10.99
      bulkUpdateOk("gid://shopify/Product/1", "P", [
        { id: "gid://shopify/ProductVariant/1", title: "Default", price: "10.99" },
      ]),
    ]);

    const result = await bulkUpdatePrices(admin, {
      variantIds: ["gid://shopify/ProductVariant/1"],
      changeType: "percentage",
      changeValue: 10,
      roundTo: ".99",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.changes[0].newPrice).toBe("10.99");
    // Mutation should have been sent with the rounded price (10.99), not 11.00
    const mutationCall = admin.calls[1];
    expect(mutationCall.variables).toEqual({
      productId: "gid://shopify/Product/1",
      variants: [
        { id: "gid://shopify/ProductVariant/1", price: "10.99" },
      ],
    });
  });
});

describe("bulkUpdatePrices — safety", () => {
  it("refuses if any computed price would be negative", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariant: {
            id: "gid://shopify/ProductVariant/1",
            title: "Default",
            price: "5.00",
            compareAtPrice: null,
            product: { id: "gid://shopify/Product/1", title: "P" },
          },
        },
      },
    ]);

    // -$10 fixed change applied to a $5 variant → -$5 → refuse
    const result = await bulkUpdatePrices(admin, {
      variantIds: ["gid://shopify/ProductVariant/1"],
      changeType: "fixed_amount",
      changeValue: -10,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("negative");
    // No mutation should have been sent
    expect(admin.calls).toHaveLength(1); // just the fetch, no mutation
  });

  it("refuses if collection has more than 50 products", async () => {
    const tooManyEdges = Array.from({ length: 51 }, (_, i) => ({
      node: {
        id: `gid://shopify/Product/${i}`,
        title: `P${i}`,
        variants: {
          edges: [
            {
              node: {
                id: `gid://shopify/ProductVariant/${i}`,
                title: "v",
                price: "10.00",
              },
            },
          ],
        },
      },
    }));
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collection: {
            id: "gid://shopify/Collection/1",
            title: "Big",
            products: { edges: tooManyEdges },
          },
        },
      },
    ]);
    const result = await bulkUpdatePrices(admin, {
      collectionId: "gid://shopify/Collection/1",
      changeType: "percentage",
      changeValue: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("more than 50 products");
  });

  it("surfaces per-product mutation failures without blocking other products", async () => {
    const admin = fakeAdmin([
      // Variant fetch 1 (Product/100)
      {
        kind: "data",
        body: {
          productVariant: {
            id: "gid://shopify/ProductVariant/1",
            title: "v1",
            price: "10.00",
            compareAtPrice: null,
            product: { id: "gid://shopify/Product/100", title: "P1" },
          },
        },
      },
      // Variant fetch 2 (Product/200)
      {
        kind: "data",
        body: {
          productVariant: {
            id: "gid://shopify/ProductVariant/2",
            title: "v2",
            price: "20.00",
            compareAtPrice: null,
            product: { id: "gid://shopify/Product/200", title: "P2" },
          },
        },
      },
      // Bulk update for Product/100 succeeds
      bulkUpdateOk("gid://shopify/Product/100", "P1", [
        { id: "gid://shopify/ProductVariant/1", title: "v1", price: "11.00" },
      ]),
      // Bulk update for Product/200 fails with userErrors
      {
        kind: "data",
        body: {
          productVariantsBulkUpdate: {
            product: null,
            productVariants: null,
            userErrors: [
              { field: ["variants"], message: "permissions" },
            ],
          },
        },
      },
    ]);

    const result = await bulkUpdatePrices(admin, {
      variantIds: [
        "gid://shopify/ProductVariant/1",
        "gid://shopify/ProductVariant/2",
      ],
      changeType: "percentage",
      changeValue: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(1);
    expect(result.data.totalFailed).toBe(1);
    expect(result.data.failures[0].error).toContain("permissions");
  });
});
