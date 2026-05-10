import { describe, expect, it } from "vitest";

import { bulkUpdateTags } from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function bulkProductNode(
  id: string,
  title: string,
  tags: string[],
  status: string = "ACTIVE",
) {
  return { id, title, tags, status };
}

function productUpdateOk(id: string, title: string, tags: string[]) {
  return {
    kind: "data" as const,
    body: {
      productUpdate: {
        product: {
          id,
          title,
          tags,
          status: "ACTIVE",
          updatedAt: "2026-05-09T10:00:00Z",
        },
        userErrors: [],
      },
    },
  };
}

describe("bulkUpdateTags — input validation", () => {
  it("rejects when no scope is set", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdateTags(admin, {
      action: "add",
      tags: ["winter-2026"],
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects when both scopes are set", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdateTags(admin, {
      collectionId: "gid://shopify/Collection/1",
      productIds: ["gid://shopify/Product/1"],
      action: "add",
      tags: ["winter-2026"],
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects unknown action", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1"],
      action: "merge",
      tags: ["x"],
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty tags array", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1"],
      action: "add",
      tags: [],
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects more than 50 tags", async () => {
    const admin = fakeAdmin([]);
    const tags = Array.from({ length: 51 }, (_, i) => `tag-${i}`);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1"],
      action: "add",
      tags,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });
});

describe("bulkUpdateTags — action: add (union semantics)", () => {
  it("merges new tags with existing — preserves existing, adds new", async () => {
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
                  ["existing", "vip"],
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", [
        "existing",
        "vip",
        "winter-2026",
      ]),
    ]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1"],
      action: "add",
      tags: ["winter-2026"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Mutation receives merged list (existing + new), not the new ones alone.
    expect(admin.calls[1].variables).toEqual({
      product: {
        id: "gid://shopify/Product/1",
        tags: ["existing", "vip", "winter-2026"],
      },
    });
    expect(result.data.changes[0].oldTags).toEqual(["existing", "vip"]);
    expect(result.data.changes[0].newTags).toEqual([
      "existing",
      "vip",
      "winter-2026",
    ]);
  });

  it("idempotent — adding existing tag is a no-op (no mutation)", async () => {
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
                  ["winter-2026"],
                ),
              },
            ],
          },
        },
      },
    ]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1"],
      action: "add",
      tags: ["winter-2026"],
    });
    // Every product no-op → returns error rather than 0-change success.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no changes");
    expect(admin.calls).toHaveLength(1); // Only the fetch
  });

  it("case-insensitive uniqueness — adding 'WINTER-2026' when 'winter-2026' exists is a no-op", async () => {
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
                  ["winter-2026"],
                ),
              },
            ],
          },
        },
      },
    ]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1"],
      action: "add",
      tags: ["WINTER-2026"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no changes");
  });
});

describe("bulkUpdateTags — action: remove", () => {
  it("removes only the listed tags, preserves others", async () => {
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
                  ["sale", "vip", "winter-2026"],
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", [
        "vip",
        "winter-2026",
      ]),
    ]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1"],
      action: "remove",
      tags: ["sale"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(admin.calls[1].variables).toEqual({
      product: {
        id: "gid://shopify/Product/1",
        tags: ["vip", "winter-2026"],
      },
    });
  });

  it("case-insensitive removal", async () => {
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
                  ["Sale", "vip"],
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", ["vip"]),
    ]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1"],
      action: "remove",
      tags: ["sale"], // lowercase, but matches "Sale" in source
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(admin.calls[1].variables).toEqual({
      product: { id: "gid://shopify/Product/1", tags: ["vip"] },
    });
  });

  it("removing a non-existent tag is a no-op", async () => {
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
                  ["vip"],
                ),
              },
            ],
          },
        },
      },
    ]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1"],
      action: "remove",
      tags: ["sale"], // not in product's tags
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no changes");
  });
});

describe("bulkUpdateTags — action: replace (destructive)", () => {
  it("replaces full tag list — pre-existing tags are dropped", async () => {
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
                  ["old1", "old2", "old3"],
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", [
        "hydrogen",
        "snowboard",
      ]),
    ]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1"],
      action: "replace",
      tags: ["hydrogen", "snowboard"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(admin.calls[1].variables).toEqual({
      product: {
        id: "gid://shopify/Product/1",
        tags: ["hydrogen", "snowboard"],
      },
    });
    expect(result.data.changes[0].oldTags).toEqual(["old1", "old2", "old3"]);
    expect(result.data.changes[0].newTags).toEqual(["hydrogen", "snowboard"]);
  });

  it("de-dupes the supplied tags array", async () => {
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
                  ["a"],
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", ["b", "c"]),
    ]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1"],
      action: "replace",
      tags: ["b", "c", "b", "c"], // duplicates
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(admin.calls[1].variables).toEqual({
      product: { id: "gid://shopify/Product/1", tags: ["b", "c"] },
    });
  });
});

describe("bulkUpdateTags — multi-product + collection", () => {
  it("multi-product add — runs sequentially across both", async () => {
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
                  ["existing"],
                ),
              },
              {
                node: bulkProductNode(
                  "gid://shopify/Product/2",
                  "Dog Food",
                  [],
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", [
        "existing",
        "winter-2026",
      ]),
      productUpdateOk("gid://shopify/Product/2", "Dog Food", ["winter-2026"]),
    ]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
      action: "add",
      tags: ["winter-2026"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(2);
  });

  it("collectionId path — applies action to all products in collection", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collection: {
            id: "gid://shopify/Collection/100",
            title: "Hydrogen",
            products: {
              edges: [
                {
                  node: bulkProductNode(
                    "gid://shopify/Product/1",
                    "Cat Food",
                    [],
                  ),
                },
              ],
            },
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", ["hydrogen"]),
    ]);
    const result = await bulkUpdateTags(admin, {
      collectionId: "gid://shopify/Collection/100",
      action: "add",
      tags: ["hydrogen"],
    });
    expect(result.ok).toBe(true);
  });
});

describe("bulkUpdateTags — failure surfacing", () => {
  it("partial failure — userErrors aggregate without aborting siblings", async () => {
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
                  [],
                ),
              },
              {
                node: bulkProductNode(
                  "gid://shopify/Product/2",
                  "Dog Food",
                  [],
                ),
              },
            ],
          },
        },
      },
      // Product/1 succeeds
      productUpdateOk("gid://shopify/Product/1", "Cat Food", ["new"]),
      // Product/2 returns userErrors
      {
        kind: "data",
        body: {
          productUpdate: {
            product: null,
            userErrors: [
              { field: ["tags"], message: "Tag is too long" },
            ],
          },
        },
      },
    ]);
    const result = await bulkUpdateTags(admin, {
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
      action: "add",
      tags: ["new"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(1);
    expect(result.data.totalFailed).toBe(1);
    expect(result.data.failures[0].productTitle).toBe("Dog Food");
    expect(result.data.failures[0].error).toContain("Tag is too long");
  });
});

describe("bulkUpdateTags — stale ID partitioning (Phase Re Round Re-D)", () => {
  it("partial-resolve: tags the 1 of 2 IDs that still exists, surfaces the other in missing[]", async () => {
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
                  [],
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", ["new"]),
    ]);
    const result = await bulkUpdateTags(admin, {
      productIds: [
        "gid://shopify/Product/1",
        "gid://shopify/Product/9999", // deleted between propose-time and execute-time
      ],
      action: "add",
      tags: ["new"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(1);
    expect(result.data.totalMissing).toBe(1);
    expect(result.data.missing).toEqual(["gid://shopify/Product/9999"]);
  });
});
