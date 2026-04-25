import { describe, expect, it } from "vitest";

import {
  fetchProductDescription,
  updateProductDescription,
} from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateProductDescription", () => {
  it("happy path — sends productUpdate and returns the new description", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Dog Washer",
              descriptionHtml: "<p>New description</p>",
              updatedAt: "2026-04-25T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateProductDescription(admin, {
      productId: "gid://shopify/Product/1",
      descriptionHtml: "<p>New description</p>",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      productId: "gid://shopify/Product/1",
      title: "Dog Washer",
      descriptionHtml: "<p>New description</p>",
    });
    expect(admin.calls[0].variables).toEqual({
      product: {
        id: "gid://shopify/Product/1",
        descriptionHtml: "<p>New description</p>",
      },
    });
  });

  it("rejects missing productId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await updateProductDescription(admin, {
      descriptionHtml: "<p>x</p>",
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
            userErrors: [{ field: ["product", "id"], message: "Product not found" }],
          },
        },
      },
    ]);
    const result = await updateProductDescription(admin, {
      productId: "gid://shopify/Product/missing",
      descriptionHtml: "<p>x</p>",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Product not found");
  });
});

describe("fetchProductDescription", () => {
  it("returns the snapshot used for the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Dog Washer",
            descriptionHtml: "<p>Old description</p>",
          },
        },
      },
    ]);
    const result = await fetchProductDescription(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.descriptionHtml).toBe("<p>Old description</p>");
  });

  it("returns ok:false if product is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { product: null } }]);
    const result = await fetchProductDescription(admin, "gid://shopify/Product/missing");
    expect(result.ok).toBe(false);
  });
});
