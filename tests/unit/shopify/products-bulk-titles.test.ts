import { describe, expect, it } from "vitest";

import { bulkUpdateTitles } from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// bulkUpdateTitles flow:
//   1. ONE batched fetch (products(query: "id:X OR id:Y...")) for current
//      titles + tags + status snapshot
//   2. Per-product productUpdate mutation, sequential
//
// For collectionId path: ONE fetch of collection.products instead of step 1.

function bulkProductNode(
  id: string,
  title: string,
  overrides: Partial<{ tags: string[]; status: string }> = {},
) {
  return {
    id,
    title,
    tags: overrides.tags ?? [],
    status: overrides.status ?? "ACTIVE",
  };
}

function productUpdateOk(id: string, title: string) {
  return {
    kind: "data" as const,
    body: {
      productUpdate: {
        product: {
          id,
          title,
          tags: [],
          status: "ACTIVE",
          updatedAt: "2026-05-09T10:00:00Z",
        },
        userErrors: [],
      },
    },
  };
}

describe("bulkUpdateTitles — input validation", () => {
  it("rejects when no scope is set", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdateTitles(admin, {
      transform: { kind: "append", text: " waskat" },
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects when both scopes are set", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdateTitles(admin, {
      collectionId: "gid://shopify/Collection/1",
      productIds: ["gid://shopify/Product/1"],
      transform: { kind: "append", text: " waskat" },
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty productIds array", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdateTitles(admin, {
      productIds: [],
      transform: { kind: "append", text: " waskat" },
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects more than 50 productIds", async () => {
    const admin = fakeAdmin([]);
    const ids = Array.from(
      { length: 51 },
      (_, i) => `gid://shopify/Product/${i + 1}`,
    );
    const result = await bulkUpdateTitles(admin, {
      productIds: ids,
      transform: { kind: "append", text: " waskat" },
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects unknown transform kind", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdateTitles(admin, {
      productIds: ["gid://shopify/Product/1"],
      transform: { kind: "uppercase" },
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects missing transform.text on append", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdateTitles(admin, {
      productIds: ["gid://shopify/Product/1"],
      transform: { kind: "append" },
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });
});

describe("bulkUpdateTitles — happy paths", () => {
  it("productIds path — append transform on 2 products", async () => {
    const admin = fakeAdmin([
      // 1. Batched fetch
      {
        kind: "data",
        body: {
          products: {
            edges: [
              { node: bulkProductNode("gid://shopify/Product/1", "Cat Food") },
              { node: bulkProductNode("gid://shopify/Product/2", "Dog Food") },
            ],
          },
        },
      },
      // 2. productUpdate for product 1
      productUpdateOk("gid://shopify/Product/1", "Cat Food waskat"),
      // 3. productUpdate for product 2
      productUpdateOk("gid://shopify/Product/2", "Dog Food waskat"),
    ]);
    const result = await bulkUpdateTitles(admin, {
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
      transform: { kind: "append", text: " waskat" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(2);
    expect(result.data.totalFailed).toBe(0);
    expect(result.data.changes).toEqual([
      {
        productId: "gid://shopify/Product/1",
        oldTitle: "Cat Food",
        newTitle: "Cat Food waskat",
      },
      {
        productId: "gid://shopify/Product/2",
        oldTitle: "Dog Food",
        newTitle: "Dog Food waskat",
      },
    ]);
    // Mutation variables verify correct product GID + new title
    expect(admin.calls[1].variables).toEqual({
      product: { id: "gid://shopify/Product/1", title: "Cat Food waskat" },
    });
  });

  it("prepend transform", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              { node: bulkProductNode("gid://shopify/Product/1", "Cat Food") },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Premium Cat Food"),
    ]);
    const result = await bulkUpdateTitles(admin, {
      productIds: ["gid://shopify/Product/1"],
      transform: { kind: "prepend", text: "Premium " },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.changes[0].newTitle).toBe("Premium Cat Food");
  });

  it("find_replace transform — substitutes substring", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              {
                node: bulkProductNode(
                  "gid://shopify/Product/1",
                  "OldBrand Snowboard",
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "NewBrand Snowboard"),
    ]);
    const result = await bulkUpdateTitles(admin, {
      productIds: ["gid://shopify/Product/1"],
      transform: {
        kind: "find_replace",
        find: "OldBrand",
        replace: "NewBrand",
      },
    });
    expect(result.ok).toBe(true);
  });

  it("find_replace with empty replace deletes substring", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              {
                node: bulkProductNode(
                  "gid://shopify/Product/1",
                  "Cat Food (DRAFT)",
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food "),
    ]);
    const result = await bulkUpdateTitles(admin, {
      productIds: ["gid://shopify/Product/1"],
      transform: { kind: "find_replace", find: "(DRAFT)", replace: "" },
    });
    expect(result.ok).toBe(true);
  });

  it("collectionId path — fetches collection products and applies transform", async () => {
    const admin = fakeAdmin([
      // 1. Fetch collection.products
      {
        kind: "data",
        body: {
          collection: {
            id: "gid://shopify/Collection/100",
            title: "Snowboards",
            products: {
              edges: [
                {
                  node: bulkProductNode(
                    "gid://shopify/Product/1",
                    "Snow A",
                  ),
                },
                {
                  node: bulkProductNode(
                    "gid://shopify/Product/2",
                    "Snow B",
                  ),
                },
              ],
            },
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Snow A 2026"),
      productUpdateOk("gid://shopify/Product/2", "Snow B 2026"),
    ]);
    const result = await bulkUpdateTitles(admin, {
      collectionId: "gid://shopify/Collection/100",
      transform: { kind: "append", text: " 2026" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(2);
  });
});

describe("bulkUpdateTitles — edge cases", () => {
  it("skips no-ops when transform produces unchanged title", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              {
                node: bulkProductNode(
                  "gid://shopify/Product/1",
                  "Cat Food",
                ),
              },
            ],
          },
        },
      },
    ]);
    // find_replace where find isn't present in title → no-op for every
    // product → returns error rather than a 0-change success.
    const result = await bulkUpdateTitles(admin, {
      productIds: ["gid://shopify/Product/1"],
      transform: { kind: "find_replace", find: "Dog", replace: "Cat" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no changes");
    // Only the fetch ran — no mutation.
    expect(admin.calls).toHaveLength(1);
  });

  it("rejects collection with > 50 products", async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      node: bulkProductNode(`gid://shopify/Product/${i + 1}`, `Product ${i}`),
    }));
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collection: {
            id: "gid://shopify/Collection/100",
            title: "Big",
            products: { edges: tooMany },
          },
        },
      },
    ]);
    const result = await bulkUpdateTitles(admin, {
      collectionId: "gid://shopify/Collection/100",
      transform: { kind: "append", text: " waskat" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("more than 50");
    // No mutation calls fired.
    expect(admin.calls).toHaveLength(1);
  });

  it("collection not found returns clean error", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { collection: null } },
    ]);
    const result = await bulkUpdateTitles(admin, {
      collectionId: "gid://shopify/Collection/9999",
      transform: { kind: "append", text: " waskat" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("collection not found");
  });

  it("missing product in batched fetch returns clean error", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              { node: bulkProductNode("gid://shopify/Product/1", "Cat Food") },
              // Product/2 missing — query returned only Product/1
            ],
          },
        },
      },
    ]);
    const result = await bulkUpdateTitles(admin, {
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
      transform: { kind: "append", text: " waskat" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("product not found");
    expect(result.error).toContain("gid://shopify/Product/2");
  });

  it("partial failure — one product update fails, others succeed", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              { node: bulkProductNode("gid://shopify/Product/1", "Cat Food") },
              { node: bulkProductNode("gid://shopify/Product/2", "Dog Food") },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food waskat"),
      // Product 2 fails
      {
        kind: "data",
        body: {
          productUpdate: {
            product: null,
            userErrors: [
              { field: ["title"], message: "Title contains invalid character" },
            ],
          },
        },
      },
    ]);
    const result = await bulkUpdateTitles(admin, {
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
      transform: { kind: "append", text: " waskat" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(1);
    expect(result.data.totalFailed).toBe(1);
    expect(result.data.failures[0].productId).toBe("gid://shopify/Product/2");
    expect(result.data.failures[0].error).toContain("invalid character");
  });

  it("computed title exceeding 255 chars is recorded as failure (not aborted)", async () => {
    const longText = "x".repeat(250);
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              {
                node: bulkProductNode(
                  "gid://shopify/Product/1",
                  longText, // already 250 chars
                ),
              },
              {
                node: bulkProductNode("gid://shopify/Product/2", "Short"),
              },
            ],
          },
        },
      },
      // Product/1 would compute to 250 + 10 = 260 chars → invalid → recorded
      // as failure WITHOUT a mutation call. Product/2 succeeds normally.
      productUpdateOk("gid://shopify/Product/2", "Short waskattag"),
    ]);
    const result = await bulkUpdateTitles(admin, {
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
      transform: { kind: "append", text: " waskattag" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(1);
    expect(result.data.totalFailed).toBe(1);
    expect(result.data.failures[0].productId).toBe("gid://shopify/Product/1");
    expect(result.data.failures[0].error).toContain("exceed 255");
    // Only ONE mutation should have fired (for product 2). Total calls = 1
    // fetch + 1 mutation = 2.
    expect(admin.calls).toHaveLength(2);
  });
});
