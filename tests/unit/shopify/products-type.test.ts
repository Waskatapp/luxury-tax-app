import { describe, expect, it } from "vitest";

import {
  fetchProductType,
  updateProductType,
} from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateProductType", () => {
  it("happy path — sets productType and returns snapshot", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Cat Food",
              productType: "Pet Food",
              updatedAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateProductType(admin, {
      productId: "gid://shopify/Product/1",
      productType: "Pet Food",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      productId: "gid://shopify/Product/1",
      title: "Cat Food",
      productType: "Pet Food",
    });
    expect(admin.calls[0].variables).toEqual({
      product: {
        id: "gid://shopify/Product/1",
        productType: "Pet Food",
      },
    });
  });

  it("rejects empty productType via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await updateProductType(admin, {
      productId: "gid://shopify/Product/1",
      productType: "",
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
            userErrors: [{ field: ["product", "productType"], message: "Invalid type" }],
          },
        },
      },
    ]);
    const result = await updateProductType(admin, {
      productId: "gid://shopify/Product/1",
      productType: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Invalid type");
  });
});

describe("fetchProductType", () => {
  it("returns the current productType as the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
            productType: "Old Type",
          },
        },
      },
    ]);
    const result = await fetchProductType(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.productType).toBe("Old Type");
  });

  it("preserves null productType", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
            productType: null,
          },
        },
      },
    ]);
    const result = await fetchProductType(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.productType).toBeNull();
  });
});
