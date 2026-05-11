import { describe, expect, it } from "vitest";

import { bulkUpdateStatus } from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function bulkProductNode(
  id: string,
  title: string,
  status: string,
  tags: string[] = [],
) {
  return { id, title, tags, status };
}

function productUpdateOk(id: string, title: string, status: string) {
  return {
    kind: "data" as const,
    body: {
      productUpdate: {
        product: {
          id,
          title,
          tags: [],
          status,
          updatedAt: "2026-05-09T10:00:00Z",
        },
        userErrors: [],
      },
    },
  };
}

describe("bulkUpdateStatus — input validation", () => {
  it("rejects when no scope is set", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdateStatus(admin, { status: "ARCHIVED" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects unknown status enum", async () => {
    const admin = fakeAdmin([]);
    const result = await bulkUpdateStatus(admin, {
      productIds: ["gid://shopify/Product/1"],
      status: "DELETED",
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
    const result = await bulkUpdateStatus(admin, {
      productIds: ids,
      status: "DRAFT",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });
});

describe("bulkUpdateStatus — happy paths", () => {
  it("ACTIVE → ARCHIVED on 2 products", async () => {
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
                  "ACTIVE",
                ),
              },
              {
                node: bulkProductNode(
                  "gid://shopify/Product/2",
                  "Dog Food",
                  "ACTIVE",
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", "ARCHIVED"),
      productUpdateOk("gid://shopify/Product/2", "Dog Food", "ARCHIVED"),
    ]);
    const result = await bulkUpdateStatus(admin, {
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(2);
    expect(result.data.changes).toEqual([
      {
        productId: "gid://shopify/Product/1",
        productTitle: "Cat Food",
        oldStatus: "ACTIVE",
        newStatus: "ARCHIVED",
      },
      {
        productId: "gid://shopify/Product/2",
        productTitle: "Dog Food",
        oldStatus: "ACTIVE",
        newStatus: "ARCHIVED",
      },
    ]);
    // Mutation variables verify correct status payload
    expect(admin.calls[1].variables).toEqual({
      product: { id: "gid://shopify/Product/1", status: "ARCHIVED" },
    });
  });

  it("DRAFT → ACTIVE — publishing drafts at scale", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              {
                node: bulkProductNode(
                  "gid://shopify/Product/1",
                  "Snowboard A",
                  "DRAFT",
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Snowboard A", "ACTIVE"),
    ]);
    const result = await bulkUpdateStatus(admin, {
      productIds: ["gid://shopify/Product/1"],
      status: "ACTIVE",
    });
    expect(result.ok).toBe(true);
  });

  it("ACTIVE → DRAFT — unpublishing at scale", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              {
                node: bulkProductNode(
                  "gid://shopify/Product/1",
                  "Snowboard A",
                  "ACTIVE",
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Snowboard A", "DRAFT"),
    ]);
    const result = await bulkUpdateStatus(admin, {
      productIds: ["gid://shopify/Product/1"],
      status: "DRAFT",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.changes[0].newStatus).toBe("DRAFT");
  });

  it("collectionId path — applies status to all products in collection", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collection: {
            id: "gid://shopify/Collection/100",
            title: "Drafts",
            products: {
              edges: [
                {
                  node: bulkProductNode(
                    "gid://shopify/Product/1",
                    "Draft A",
                    "DRAFT",
                  ),
                },
              ],
            },
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Draft A", "ARCHIVED"),
    ]);
    const result = await bulkUpdateStatus(admin, {
      collectionId: "gid://shopify/Collection/100",
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(true);
  });
});

describe("bulkUpdateStatus — edge cases", () => {
  it("skips no-ops — products already at target status", async () => {
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
                  "ARCHIVED",
                ),
              },
            ],
          },
        },
      },
    ]);
    // Already archived → no-op for every product → returns error.
    const result = await bulkUpdateStatus(admin, {
      productIds: ["gid://shopify/Product/1"],
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("already ARCHIVED");
    // Only the fetch ran; no mutation.
    expect(admin.calls).toHaveLength(1);
  });

  it("mixed — only products NOT at target status are mutated", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              {
                node: bulkProductNode(
                  "gid://shopify/Product/1",
                  "Already Archived",
                  "ARCHIVED",
                ),
              },
              {
                node: bulkProductNode(
                  "gid://shopify/Product/2",
                  "Currently Active",
                  "ACTIVE",
                ),
              },
            ],
          },
        },
      },
      productUpdateOk(
        "gid://shopify/Product/2",
        "Currently Active",
        "ARCHIVED",
      ),
    ]);
    const result = await bulkUpdateStatus(admin, {
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only 1 mutation fired (for Product/2) — Product/1 was already at target.
    expect(admin.calls).toHaveLength(2); // 1 fetch + 1 mutation
    expect(result.data.totalUpdated).toBe(1);
    expect(result.data.changes[0].productId).toBe("gid://shopify/Product/2");
  });

  it("rejects collection with > 50 products", async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      node: bulkProductNode(
        `gid://shopify/Product/${i + 1}`,
        `Product ${i}`,
        "ACTIVE",
      ),
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
    const result = await bulkUpdateStatus(admin, {
      collectionId: "gid://shopify/Collection/100",
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("more than 50");
  });

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
                  "ACTIVE",
                ),
              },
              {
                node: bulkProductNode(
                  "gid://shopify/Product/2",
                  "Dog Food",
                  "ACTIVE",
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", "ARCHIVED"),
      {
        kind: "data",
        body: {
          productUpdate: {
            product: null,
            userErrors: [
              {
                field: ["status"],
                message: "Cannot archive product with active subscriptions",
              },
            ],
          },
        },
      },
    ]);
    const result = await bulkUpdateStatus(admin, {
      productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(1);
    expect(result.data.totalFailed).toBe(1);
    expect(result.data.failures[0].error).toContain("active subscriptions");
  });
});

describe("bulkUpdateStatus — stale ID partitioning (Phase Re Round Re-D)", () => {
  it("partial-resolve: 2 of 3 IDs found — archives the 2, surfaces missing 1", async () => {
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
                  "ACTIVE",
                ),
              },
              {
                node: bulkProductNode(
                  "gid://shopify/Product/3",
                  "Bird Food",
                  "ACTIVE",
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", "ARCHIVED"),
      productUpdateOk("gid://shopify/Product/3", "Bird Food", "ARCHIVED"),
    ]);
    const result = await bulkUpdateStatus(admin, {
      productIds: [
        "gid://shopify/Product/1",
        "gid://shopify/Product/2",
        "gid://shopify/Product/3",
      ],
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalUpdated).toBe(2);
    expect(result.data.totalMissing).toBe(1);
    expect(result.data.missing).toEqual(["gid://shopify/Product/2"]);
    // Confirm only mutations for the resolvable IDs fired (not the missing one).
    expect(admin.calls).toHaveLength(3); // 1 fetch + 2 mutations
  });

  it("all-missing: every requested ID is gone — returns error citing the IDs (not silent success)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [], // none found
          },
        },
      },
    ]);
    const result = await bulkUpdateStatus(admin, {
      productIds: [
        "gid://shopify/Product/99",
        "gid://shopify/Product/100",
      ],
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("every requested productId is missing");
    expect(result.error).toContain("gid://shopify/Product/99");
    expect(result.error).toContain("gid://shopify/Product/100");
    // Only the fetch ran; no mutations.
    expect(admin.calls).toHaveLength(1);
  });

  it("all-missing-but-no-ops-too: every resolved item already at target — error mentions missing IDs", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              {
                node: bulkProductNode(
                  "gid://shopify/Product/1",
                  "Already Archived",
                  "ARCHIVED",
                ),
              },
            ],
          },
        },
      },
    ]);
    const result = await bulkUpdateStatus(admin, {
      productIds: [
        "gid://shopify/Product/1",
        "gid://shopify/Product/404",
      ],
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("already ARCHIVED");
    expect(result.error).toContain("missing");
    expect(result.error).toContain("gid://shopify/Product/404");
  });

  it("all-found: missing[] is empty array, totalMissing 0", async () => {
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
                  "ACTIVE",
                ),
              },
            ],
          },
        },
      },
      productUpdateOk("gid://shopify/Product/1", "Cat Food", "ARCHIVED"),
    ]);
    const result = await bulkUpdateStatus(admin, {
      productIds: ["gid://shopify/Product/1"],
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalMissing).toBe(0);
    expect(result.data.missing).toEqual([]);
  });
});

describe("bulkUpdateStatus — bulk re-fetch query format (regression: 2026-05-10 silent all-missing)", () => {
  // Production trace 2026-05-10: archiving 18 dev-store demo products via
  // bulk_update_status returned "every requested productId is missing" for
  // products that clearly existed. Root cause: the bulk re-fetch was
  // building `query: "id:gid://shopify/Product/123 OR id:gid://..."` —
  // Shopify's products(query:) `id:` filter accepts the NUMERIC id only.
  // The `:` and `/` chars in full GIDs break the search parser, so the
  // query returns zero matches and every input lands in missing[]. Fix
  // strips the GID prefix when building the filter while keeping full GIDs
  // as the lookup map keys (Shopify's response carries full GIDs back).
  it("strips gid://shopify/Product/ prefix when building the products(query:) filter", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              {
                node: bulkProductNode(
                  "gid://shopify/Product/7637962784881",
                  "Snowboard A",
                  "ACTIVE",
                ),
              },
              {
                node: bulkProductNode(
                  "gid://shopify/Product/7634835669105",
                  "Snowboard B",
                  "ACTIVE",
                ),
              },
            ],
          },
        },
      },
      productUpdateOk(
        "gid://shopify/Product/7637962784881",
        "Snowboard A",
        "ARCHIVED",
      ),
      productUpdateOk(
        "gid://shopify/Product/7634835669105",
        "Snowboard B",
        "ARCHIVED",
      ),
    ]);
    const result = await bulkUpdateStatus(admin, {
      productIds: [
        "gid://shopify/Product/7637962784881",
        "gid://shopify/Product/7634835669105",
      ],
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(true);
    const fetchCall = admin.calls[0];
    const fetchedQuery = String(fetchCall.variables?.query ?? "");
    // The query MUST contain bare numeric IDs.
    expect(fetchedQuery).toContain("id:7637962784881");
    expect(fetchedQuery).toContain("id:7634835669105");
    // The query MUST NOT contain the GID prefix — those break Shopify's
    // search parser and were the production bug.
    expect(fetchedQuery).not.toContain("gid://shopify/Product/");
    // OR-joined.
    expect(fetchedQuery).toContain(" OR ");
  });

  it("preserves full GIDs in the result payload even though the search uses numeric IDs", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          products: {
            edges: [
              {
                node: bulkProductNode(
                  "gid://shopify/Product/7637962784881",
                  "Snowboard A",
                  "ACTIVE",
                ),
              },
            ],
          },
        },
      },
      productUpdateOk(
        "gid://shopify/Product/7637962784881",
        "Snowboard A",
        "ARCHIVED",
      ),
    ]);
    const result = await bulkUpdateStatus(admin, {
      productIds: ["gid://shopify/Product/7637962784881"],
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.changes[0].productId).toBe(
      "gid://shopify/Product/7637962784881",
    );
  });
});
