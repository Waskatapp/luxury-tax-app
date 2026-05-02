import { describe, expect, it } from "vitest";

import {
  fetchProductTags,
  updateProductTags,
} from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateProductTags", () => {
  it("happy path — replaces tag list and returns snapshot", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Cat Food",
              tags: ["bestseller", "premium", "vip"],
              updatedAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateProductTags(admin, {
      productId: "gid://shopify/Product/1",
      tags: ["bestseller", "premium", "vip"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      productId: "gid://shopify/Product/1",
      title: "Cat Food",
      tags: ["bestseller", "premium", "vip"],
    });
    expect(admin.calls[0].variables).toEqual({
      product: {
        id: "gid://shopify/Product/1",
        tags: ["bestseller", "premium", "vip"],
      },
    });
  });

  it("accepts an empty tag array (clears all tags)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Cat Food",
              tags: [],
              updatedAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);
    const result = await updateProductTags(admin, {
      productId: "gid://shopify/Product/1",
      tags: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tags).toEqual([]);
  });

  it("rejects more than 250 tags via Zod", async () => {
    const admin = fakeAdmin([]);
    const tooMany = Array.from({ length: 251 }, (_, i) => `tag${i}`);
    const result = await updateProductTags(admin, {
      productId: "gid://shopify/Product/1",
      tags: tooMany,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: null,
            userErrors: [{ field: ["product", "tags"], message: "Tag exceeds 255 chars" }],
          },
        },
      },
    ]);
    const result = await updateProductTags(admin, {
      productId: "gid://shopify/Product/1",
      tags: ["ok"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Tag exceeds 255 chars");
  });
});

describe("fetchProductTags", () => {
  it("returns the current tag list as the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
            tags: ["premium", "bestseller"],
          },
        },
      },
    ]);
    const result = await fetchProductTags(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tags).toEqual(["premium", "bestseller"]);
  });

  it("normalizes null tags to empty array", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
            tags: null,
          },
        },
      },
    ]);
    const result = await fetchProductTags(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tags).toEqual([]);
  });
});
