import { describe, expect, it } from "vitest";

import {
  duplicateProduct,
  fetchProductForDuplicate,
} from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("duplicateProduct", () => {
  it("happy path — duplicates with new title, defaults DRAFT + includeImages true", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productDuplicate: {
            newProduct: {
              id: "gid://shopify/Product/2",
              title: "Cat Food XL",
              status: "DRAFT",
              handle: "cat-food-xl",
              createdAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await duplicateProduct(admin, {
      productId: "gid://shopify/Product/1",
      newTitle: "Cat Food XL",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      sourceProductId: "gid://shopify/Product/1",
      newProductId: "gid://shopify/Product/2",
      newTitle: "Cat Food XL",
      newStatus: "DRAFT",
      newHandle: "cat-food-xl",
    });
    expect(admin.calls[0].variables).toEqual({
      productId: "gid://shopify/Product/1",
      newTitle: "Cat Food XL",
      newStatus: "DRAFT",
      includeImages: true,
    });
  });

  it("respects explicit newStatus and includeImages overrides", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productDuplicate: {
            newProduct: {
              id: "gid://shopify/Product/3",
              title: "Cat Food (Active Copy)",
              status: "ACTIVE",
              handle: "cat-food-active-copy",
              createdAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);
    const result = await duplicateProduct(admin, {
      productId: "gid://shopify/Product/1",
      newTitle: "Cat Food (Active Copy)",
      newStatus: "ACTIVE",
      includeImages: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.newStatus).toBe("ACTIVE");
    expect(admin.calls[0].variables).toMatchObject({
      newStatus: "ACTIVE",
      includeImages: false,
    });
  });

  it("rejects empty newTitle via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await duplicateProduct(admin, {
      productId: "gid://shopify/Product/1",
      newTitle: "",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productDuplicate: {
            newProduct: null,
            userErrors: [{ field: ["productId"], message: "Product not found" }],
          },
        },
      },
    ]);
    const result = await duplicateProduct(admin, {
      productId: "gid://shopify/Product/missing",
      newTitle: "Whatever",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Product not found");
  });
});

describe("fetchProductForDuplicate", () => {
  it("returns the source product info as the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
            status: "ACTIVE",
            handle: "cat-food",
          },
        },
      },
    ]);
    const result = await fetchProductForDuplicate(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      sourceProductId: "gid://shopify/Product/1",
      sourceTitle: "Cat Food",
      sourceStatus: "ACTIVE",
      sourceHandle: "cat-food",
    });
  });

  it("returns ok:false if product is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { product: null } }]);
    const result = await fetchProductForDuplicate(admin, "gid://shopify/Product/missing");
    expect(result.ok).toBe(false);
  });
});
