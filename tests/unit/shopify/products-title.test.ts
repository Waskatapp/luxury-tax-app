import { describe, expect, it } from "vitest";

import {
  fetchProductTitle,
  updateProductTitle,
} from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateProductTitle", () => {
  it("happy path — sends productUpdate with new title and returns snapshot", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Cat Food Premium",
              updatedAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateProductTitle(admin, {
      productId: "gid://shopify/Product/1",
      title: "Cat Food Premium",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      productId: "gid://shopify/Product/1",
      title: "Cat Food Premium",
    });
    expect(admin.calls[0].variables).toEqual({
      product: {
        id: "gid://shopify/Product/1",
        title: "Cat Food Premium",
      },
    });
  });

  it("rejects empty title via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await updateProductTitle(admin, {
      productId: "gid://shopify/Product/1",
      title: "",
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
            userErrors: [{ field: ["product", "title"], message: "Title can't be blank" }],
          },
        },
      },
    ]);
    const result = await updateProductTitle(admin, {
      productId: "gid://shopify/Product/1",
      title: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Title can't be blank");
  });
});

describe("fetchProductTitle", () => {
  it("returns the snapshot used for the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
          },
        },
      },
    ]);
    const result = await fetchProductTitle(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.title).toBe("Cat Food");
  });

  it("returns ok:false if product is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { product: null } }]);
    const result = await fetchProductTitle(admin, "gid://shopify/Product/missing");
    expect(result.ok).toBe(false);
  });
});
