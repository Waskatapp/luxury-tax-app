import { describe, expect, it } from "vitest";

import {
  fetchProductStatus,
  updateProductStatus,
} from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateProductStatus", () => {
  it.each(["DRAFT", "ACTIVE", "ARCHIVED"] as const)(
    "happy path — flips a product to %s",
    async (target) => {
      const admin = fakeAdmin([
        {
          kind: "data",
          body: {
            productUpdate: {
              product: {
                id: "gid://shopify/Product/1",
                title: "Dog Washer",
                status: target,
                updatedAt: "2026-04-25T10:00:00Z",
              },
              userErrors: [],
            },
          },
        },
      ]);

      const result = await updateProductStatus(admin, {
        productId: "gid://shopify/Product/1",
        status: target,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.status).toBe(target);
      expect(admin.calls[0].variables).toEqual({
        product: { id: "gid://shopify/Product/1", status: target },
      });
    },
  );

  it("rejects an invalid status via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await updateProductStatus(admin, {
      productId: "gid://shopify/Product/1",
      status: "PUBLISHED",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });
});

describe("fetchProductStatus", () => {
  it("returns the snapshot used for the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Dog Washer",
            status: "DRAFT",
          },
        },
      },
    ]);
    const result = await fetchProductStatus(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("DRAFT");
  });
});
