import { describe, expect, it } from "vitest";

import {
  fetchInventoryLevels,
  readInventoryLevels,
} from "../../../app/lib/shopify/inventory.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// readInventoryLevels runs ONE productVariant(id:) query per variantId
// in parallel. fetchInventoryLevels runs ONE inventoryItem(id:) query.

function variantNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/ProductVariant/100",
    title: "Default",
    barcode: "BAR-001",
    product: { id: "gid://shopify/Product/10", title: "Cat Food" },
    inventoryItem: {
      id: "gid://shopify/InventoryItem/1000",
      sku: "CAT-001",
      tracked: true,
      inventoryLevels: {
        edges: [
          {
            node: {
              location: {
                id: "gid://shopify/Location/1",
                name: "Vancouver",
              },
              quantities: [{ name: "available", quantity: 42 }],
            },
          },
          {
            node: {
              location: {
                id: "gid://shopify/Location/2",
                name: "Toronto",
              },
              quantities: [{ name: "available", quantity: 8 }],
            },
          },
        ],
      },
    },
    ...overrides,
  };
}

function inventoryItemNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/InventoryItem/1000",
    sku: "CAT-001",
    tracked: true,
    variant: {
      id: "gid://shopify/ProductVariant/100",
      title: "Default",
      barcode: "BAR-001",
      product: { id: "gid://shopify/Product/10", title: "Cat Food" },
    },
    inventoryLevels: {
      edges: [
        {
          node: {
            location: { id: "gid://shopify/Location/1", name: "Vancouver" },
            quantities: [{ name: "available", quantity: 42 }],
          },
        },
      ],
    },
    ...overrides,
  };
}

describe("readInventoryLevels", () => {
  it("happy path — single variant, returns per-location levels", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { productVariant: variantNode() } },
    ]);
    const result = await readInventoryLevels(admin, {
      variantIds: ["gid://shopify/ProductVariant/100"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.variants).toHaveLength(1);
    const v = result.data.variants[0];
    expect(v.variantId).toBe("gid://shopify/ProductVariant/100");
    expect(v.productTitle).toBe("Cat Food");
    expect(v.sku).toBe("CAT-001");
    expect(v.barcode).toBe("BAR-001");
    expect(v.tracked).toBe(true);
    expect(v.inventoryItemId).toBe("gid://shopify/InventoryItem/1000");
    expect(v.perLocation).toEqual([
      {
        locationId: "gid://shopify/Location/1",
        locationName: "Vancouver",
        available: 42,
      },
      {
        locationId: "gid://shopify/Location/2",
        locationName: "Toronto",
        available: 8,
      },
    ]);
  });

  it("batched read — multiple variantIds run in parallel and aggregate", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { productVariant: variantNode() } },
      {
        kind: "data",
        body: {
          productVariant: variantNode({
            id: "gid://shopify/ProductVariant/200",
            product: {
              id: "gid://shopify/Product/20",
              title: "Dog Food",
            },
            inventoryItem: {
              id: "gid://shopify/InventoryItem/2000",
              sku: "DOG-001",
              tracked: true,
              inventoryLevels: {
                edges: [
                  {
                    node: {
                      location: {
                        id: "gid://shopify/Location/1",
                        name: "Vancouver",
                      },
                      quantities: [{ name: "available", quantity: 17 }],
                    },
                  },
                ],
              },
            },
          }),
        },
      },
    ]);
    const result = await readInventoryLevels(admin, {
      variantIds: [
        "gid://shopify/ProductVariant/100",
        "gid://shopify/ProductVariant/200",
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.variants).toHaveLength(2);
    expect(result.data.variants[0].productTitle).toBe("Cat Food");
    expect(result.data.variants[1].productTitle).toBe("Dog Food");
    expect(result.data.variants[1].perLocation).toHaveLength(1);
    expect(admin.calls).toHaveLength(2);
  });

  it("variant with missing inventoryItem surfaces slim 'untracked' shape", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: { productVariant: variantNode({ inventoryItem: null }) },
      },
    ]);
    const result = await readInventoryLevels(admin, {
      variantIds: ["gid://shopify/ProductVariant/100"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v = result.data.variants[0];
    expect(v.inventoryItemId).toBeNull();
    expect(v.tracked).toBe(false);
    expect(v.perLocation).toEqual([]);
    // Variant identity is still surfaced so the merchant sees it exists.
    expect(v.variantId).toBe("gid://shopify/ProductVariant/100");
    expect(v.productTitle).toBe("Cat Food");
  });

  it("missing 'available' quantity defaults to 0", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productVariant: variantNode({
            inventoryItem: {
              id: "gid://shopify/InventoryItem/1000",
              sku: "CAT-001",
              tracked: true,
              inventoryLevels: {
                edges: [
                  {
                    node: {
                      location: {
                        id: "gid://shopify/Location/1",
                        name: "Vancouver",
                      },
                      // No "available" entry — only some other quantity name.
                      quantities: [{ name: "incoming", quantity: 50 }],
                    },
                  },
                ],
              },
            },
          }),
        },
      },
    ]);
    const result = await readInventoryLevels(admin, {
      variantIds: ["gid://shopify/ProductVariant/100"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.variants[0].perLocation[0].available).toBe(0);
  });

  it("rejects empty variantIds via Zod (min 1)", async () => {
    const admin = fakeAdmin([]);
    const result = await readInventoryLevels(admin, { variantIds: [] });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects more than 20 variantIds via Zod (max 20)", async () => {
    const admin = fakeAdmin([]);
    const ids = Array.from(
      { length: 21 },
      (_, i) => `gid://shopify/ProductVariant/${i + 1}`,
    );
    const result = await readInventoryLevels(admin, { variantIds: ids });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty string variantId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await readInventoryLevels(admin, {
      variantIds: [""],
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("missing variant errors out with a clear message", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { productVariant: null } },
    ]);
    const result = await readInventoryLevels(admin, {
      variantIds: ["gid://shopify/ProductVariant/999"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("variant not found");
    expect(result.error).toContain("gid://shopify/ProductVariant/999");
  });

  it("first error in batched call short-circuits", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { productVariant: null } },
      { kind: "data", body: { productVariant: variantNode() } },
    ]);
    const result = await readInventoryLevels(admin, {
      variantIds: [
        "gid://shopify/ProductVariant/999",
        "gid://shopify/ProductVariant/100",
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("variant not found");
  });
});

describe("fetchInventoryLevels (snapshot helper)", () => {
  it("happy path — returns canonical inventory levels shape from inventoryItem(id:)", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    const result = await fetchInventoryLevels(
      admin,
      "gid://shopify/InventoryItem/1000",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.inventoryItemId).toBe("gid://shopify/InventoryItem/1000");
    expect(result.data.variantId).toBe("gid://shopify/ProductVariant/100");
    expect(result.data.productTitle).toBe("Cat Food");
    expect(result.data.tracked).toBe(true);
    expect(result.data.sku).toBe("CAT-001");
    expect(result.data.perLocation[0].available).toBe(42);
  });

  it("inventoryItem with no variant pointer still resolves (variantId null)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: { inventoryItem: inventoryItemNode({ variant: null }) },
      },
    ]);
    const result = await fetchInventoryLevels(
      admin,
      "gid://shopify/InventoryItem/1000",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.variantId).toBeNull();
    expect(result.data.productId).toBeNull();
    expect(result.data.productTitle).toBe("");
    expect(result.data.barcode).toBeNull();
    expect(result.data.tracked).toBe(true);
  });

  it("missing inventory item errors out with a clear message", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { inventoryItem: null } },
    ]);
    const result = await fetchInventoryLevels(
      admin,
      "gid://shopify/InventoryItem/9999",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("inventory item not found");
    expect(result.error).toContain("gid://shopify/InventoryItem/9999");
  });
});
