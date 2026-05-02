import { describe, expect, it } from "vitest";

import {
  fetchVariantDetails,
  updateVariant,
} from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

const variantNode = {
  id: "gid://shopify/ProductVariant/1",
  title: "Default",
  barcode: "012345678905",
  inventoryPolicy: "DENY",
  taxable: true,
  product: { id: "gid://shopify/Product/1", title: "Cat Food" },
  inventoryItem: {
    id: "gid://shopify/InventoryItem/1",
    sku: "CF-001",
    requiresShipping: true,
    measurement: { weight: { value: 500, unit: "GRAMS" } },
  },
};

describe("updateVariant", () => {
  it("happy path — flat input maps to nested productVariantsBulkUpdate shape", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariantsBulkUpdate: {
            product: { id: "gid://shopify/Product/1", title: "Cat Food" },
            productVariants: [variantNode],
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateVariant(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/1",
      sku: "CF-001",
      barcode: "012345678905",
      weight: 500,
      weightUnit: "GRAMS",
      inventoryPolicy: "DENY",
      requiresShipping: true,
      taxable: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      variantId: "gid://shopify/ProductVariant/1",
      variantTitle: "Default",
      productId: "gid://shopify/Product/1",
      productTitle: "Cat Food",
      sku: "CF-001",
      barcode: "012345678905",
      weight: 500,
      weightUnit: "GRAMS",
      inventoryPolicy: "DENY",
      requiresShipping: true,
      taxable: true,
    });

    // Verify the merchant-friendly flat input was mapped to Shopify's nested
    // ProductVariantsBulkInput shape: variant-level vs inventoryItem-level.
    expect(admin.calls[0].variables).toEqual({
      productId: "gid://shopify/Product/1",
      variants: [
        {
          id: "gid://shopify/ProductVariant/1",
          barcode: "012345678905",
          inventoryPolicy: "DENY",
          taxable: true,
          inventoryItem: {
            sku: "CF-001",
            requiresShipping: true,
            measurement: { weight: { value: 500, unit: "GRAMS" } },
          },
        },
      ],
    });
  });

  it("partial update — only sku changes, omits unchanged fields from request", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariantsBulkUpdate: {
            product: { id: "gid://shopify/Product/1", title: "Cat Food" },
            productVariants: [{ ...variantNode, inventoryItem: { ...variantNode.inventoryItem, sku: "NEW-SKU" } }],
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateVariant(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/1",
      sku: "NEW-SKU",
    });

    expect(result.ok).toBe(true);
    expect(admin.calls[0].variables).toEqual({
      productId: "gid://shopify/Product/1",
      variants: [
        {
          id: "gid://shopify/ProductVariant/1",
          inventoryItem: { sku: "NEW-SKU" },
        },
      ],
    });
  });

  it("rejects empty update (no optional fields set)", async () => {
    const admin = fakeAdmin([]);
    const result = await updateVariant(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/1",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects weight without weightUnit", async () => {
    const admin = fakeAdmin([]);
    const result = await updateVariant(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/1",
      weight: 500,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects weightUnit without weight", async () => {
    const admin = fakeAdmin([]);
    const result = await updateVariant(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/1",
      weightUnit: "GRAMS",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariantsBulkUpdate: {
            product: null,
            productVariants: null,
            userErrors: [{ field: ["variants", "0", "inventoryItem", "sku"], message: "SKU already in use" }],
          },
        },
      },
    ]);
    const result = await updateVariant(admin, {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/1",
      sku: "DUPLICATE",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("SKU already in use");
  });
});

describe("fetchVariantDetails", () => {
  it("returns the AuditLog before-state with all editable fields", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { productVariant: variantNode } },
    ]);
    const result = await fetchVariantDetails(admin, "gid://shopify/ProductVariant/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sku).toBe("CF-001");
    expect(result.data.barcode).toBe("012345678905");
    expect(result.data.weight).toBe(500);
    expect(result.data.weightUnit).toBe("GRAMS");
    expect(result.data.inventoryPolicy).toBe("DENY");
    expect(result.data.requiresShipping).toBe(true);
    expect(result.data.taxable).toBe(true);
  });

  it("normalizes missing weight/measurement to nulls", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariant: {
            ...variantNode,
            inventoryItem: {
              ...variantNode.inventoryItem,
              measurement: null,
            },
          },
        },
      },
    ]);
    const result = await fetchVariantDetails(admin, "gid://shopify/ProductVariant/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.weight).toBeNull();
    expect(result.data.weightUnit).toBeNull();
  });

  it("returns ok:false if variant is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { productVariant: null } }]);
    const result = await fetchVariantDetails(admin, "gid://shopify/ProductVariant/missing");
    expect(result.ok).toBe(false);
  });
});
