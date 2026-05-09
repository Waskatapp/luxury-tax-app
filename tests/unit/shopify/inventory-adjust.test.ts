import { describe, expect, it } from "vitest";

import {
  _testing,
  adjustInventoryQuantity,
} from "../../../app/lib/shopify/inventory.server";
import { fakeAdmin } from "../../helpers/fake-admin";

const { ADJUST_REASONS } = _testing;

// adjustInventoryQuantity issues TWO calls in the happy path:
// 1. inventoryAdjustQuantities mutation
// 2. fetchInventoryLevels post-mutation snapshot (inventoryItem(id:))

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

function adjustSuccess() {
  return {
    kind: "data" as const,
    body: {
      inventoryAdjustQuantities: {
        inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" },
        userErrors: [],
      },
    },
  };
}

describe("adjustInventoryQuantity", () => {
  it("happy path — positive delta with received reason", async () => {
    const admin = fakeAdmin([
      adjustSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    const result = await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: 10,
      reason: "received",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(admin.calls).toHaveLength(2);

    const vars = admin.calls[0].variables as { input: Record<string, unknown> };
    expect(vars.input).toEqual({
      name: "available",
      reason: "received",
      changes: [
        {
          inventoryItemId: "gid://shopify/InventoryItem/1000",
          locationId: "gid://shopify/Location/1",
          delta: 10,
        },
      ],
    });
  });

  it("happy path — negative delta with damaged reason", async () => {
    const admin = fakeAdmin([
      adjustSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    const result = await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: -3,
      reason: "damaged",
    });
    expect(result.ok).toBe(true);
    const vars = admin.calls[0].variables as { input: Record<string, unknown> };
    const changes = vars.input.changes as Array<{ delta: number }>;
    expect(changes[0].delta).toBe(-3);
    expect(vars.input.reason).toBe("damaged");
  });

  it("default reason is 'correction' when not provided", async () => {
    const admin = fakeAdmin([
      adjustSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: 5,
    });
    const vars = admin.calls[0].variables as { input: Record<string, unknown> };
    expect(vars.input.reason).toBe("correction");
  });

  it("includes referenceDocumentUri when provided", async () => {
    const admin = fakeAdmin([
      adjustSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: 10,
      reason: "received",
      referenceDocumentUri: "shipment-987",
    });
    const vars = admin.calls[0].variables as { input: Record<string, unknown> };
    expect(vars.input.referenceDocumentUri).toBe("shipment-987");
  });

  it("omits referenceDocumentUri from variables when not provided", async () => {
    const admin = fakeAdmin([
      adjustSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: 10,
    });
    const vars = admin.calls[0].variables as { input: Record<string, unknown> };
    expect("referenceDocumentUri" in vars.input).toBe(false);
  });

  it.each(ADJUST_REASONS)("accepts %s as a valid reason enum", async (reason) => {
    const admin = fakeAdmin([
      adjustSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    const result = await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: 1,
      reason,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid reason via Zod enum", async () => {
    const admin = fakeAdmin([]);
    const result = await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: 5,
      reason: "FREEFORM_REASON",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects delta: 0 via Zod refine", async () => {
    const admin = fakeAdmin([]);
    const result = await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: 0,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects non-integer delta via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: 1.5,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty inventoryItemId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await adjustInventoryQuantity(admin, {
      inventoryItemId: "",
      locationId: "gid://shopify/Location/1",
      delta: 5,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty locationId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "",
      delta: 5,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("hard-codes name: 'available' (other quantity names not supported in v1)", async () => {
    const admin = fakeAdmin([
      adjustSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: 5,
    });
    const vars = admin.calls[0].variables as { input: Record<string, unknown> };
    expect(vars.input.name).toBe("available");
  });

  it("surfaces shopify userErrors verbatim", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [
              {
                field: ["input", "changes", "0", "delta"],
                message: "Item is not stocked at this location",
                code: "ITEM_NOT_STOCKED_AT_LOCATION",
              },
            ],
          },
        },
      },
    ]);
    const result = await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Item is not stocked at this location");
    expect(admin.calls).toHaveLength(1);
  });

  it("surfaces error if mutation returns null adjustmentGroup with no userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [],
          },
        },
      },
    ]);
    const result = await adjustInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      delta: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no adjustmentGroup");
  });
});
