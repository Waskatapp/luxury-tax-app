import { describe, expect, it } from "vitest";

import {
  fetchProductVendor,
  updateProductVendor,
} from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateProductVendor", () => {
  it("happy path — sets vendor and returns snapshot", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Cat Food",
              vendor: "ACME Pet Co",
              updatedAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateProductVendor(admin, {
      productId: "gid://shopify/Product/1",
      vendor: "ACME Pet Co",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      productId: "gid://shopify/Product/1",
      title: "Cat Food",
      vendor: "ACME Pet Co",
    });
    expect(admin.calls[0].variables).toEqual({
      product: {
        id: "gid://shopify/Product/1",
        vendor: "ACME Pet Co",
      },
    });
  });

  it("rejects empty vendor via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await updateProductVendor(admin, {
      productId: "gid://shopify/Product/1",
      vendor: "",
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
            userErrors: [{ field: ["product", "vendor"], message: "Vendor too long" }],
          },
        },
      },
    ]);
    const result = await updateProductVendor(admin, {
      productId: "gid://shopify/Product/1",
      vendor: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Vendor too long");
  });
});

describe("fetchProductVendor", () => {
  it("returns the current vendor as the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
            vendor: "Old Vendor",
          },
        },
      },
    ]);
    const result = await fetchProductVendor(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.vendor).toBe("Old Vendor");
  });

  it("preserves null vendor", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
            vendor: null,
          },
        },
      },
    ]);
    const result = await fetchProductVendor(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.vendor).toBeNull();
  });
});
