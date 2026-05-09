import { describe, expect, it } from "vitest";

import {
  _testing,
  setInventoryQuantity,
} from "../../../app/lib/shopify/inventory.server";
import { fakeAdmin } from "../../helpers/fake-admin";

const { SET_REASONS } = _testing;

// setInventoryQuantity issues TWO calls in the happy path:
// 1. inventorySetQuantities mutation (with ignoreCompareQuantity: true)
// 2. fetchInventoryLevels post-mutation snapshot

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

function setSuccess() {
  return {
    kind: "data" as const,
    body: {
      inventorySetQuantities: {
        inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/2" },
        userErrors: [],
      },
    },
  };
}

describe("setInventoryQuantity", () => {
  it("happy path — sends absolute quantity with cycle_count_available reason", async () => {
    const admin = fakeAdmin([
      setSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 42,
      reason: "cycle_count_available",
      referenceDocumentUri: "cycle-count-2026-05-09",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(admin.calls).toHaveLength(2);

    const vars = admin.calls[0].variables as { input: Record<string, unknown> };
    expect(vars.input).toEqual({
      name: "available",
      reason: "cycle_count_available",
      ignoreCompareQuantity: true,
      quantities: [
        {
          inventoryItemId: "gid://shopify/InventoryItem/1000",
          locationId: "gid://shopify/Location/1",
          quantity: 42,
        },
      ],
      referenceDocumentUri: "cycle-count-2026-05-09",
    });
  });

  it("accepts quantity: 0 (out-of-stock at this location)", async () => {
    const admin = fakeAdmin([
      setSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 0,
      reason: "correction",
      referenceDocumentUri: "audit-2026-05",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects negative quantity via Zod (min 0)", async () => {
    const admin = fakeAdmin([]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: -1,
      reason: "correction",
      referenceDocumentUri: "audit-2026-05",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects non-integer quantity via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 42.5,
      reason: "correction",
      referenceDocumentUri: "audit-2026-05",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects MISSING referenceDocumentUri via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 42,
      reason: "cycle_count_available",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects EMPTY-STRING referenceDocumentUri via Zod (audit-trail integrity)", async () => {
    const admin = fakeAdmin([]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 42,
      reason: "cycle_count_available",
      referenceDocumentUri: "",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects referenceDocumentUri longer than 255 chars via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 42,
      reason: "cycle_count_available",
      referenceDocumentUri: "x".repeat(256),
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects MISSING reason via Zod (no default for set — more deliberate)", async () => {
    const admin = fakeAdmin([]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 42,
      referenceDocumentUri: "audit",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it.each(SET_REASONS)("accepts %s as a valid reason enum", async (reason) => {
    const admin = fakeAdmin([
      setSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 1,
      reason,
      referenceDocumentUri: "audit",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects 'damaged' reason on set (only valid for adjust)", async () => {
    const admin = fakeAdmin([]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 42,
      reason: "damaged",
      referenceDocumentUri: "audit",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("hard-codes ignoreCompareQuantity: true", async () => {
    const admin = fakeAdmin([
      setSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 42,
      reason: "cycle_count_available",
      referenceDocumentUri: "audit",
    });
    const vars = admin.calls[0].variables as { input: Record<string, unknown> };
    expect(vars.input.ignoreCompareQuantity).toBe(true);
  });

  it("hard-codes name: 'available'", async () => {
    const admin = fakeAdmin([
      setSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode() } },
    ]);
    await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 42,
      reason: "cycle_count_available",
      referenceDocumentUri: "audit",
    });
    const vars = admin.calls[0].variables as { input: Record<string, unknown> };
    expect(vars.input.name).toBe("available");
  });

  it("surfaces shopify userErrors verbatim", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          inventorySetQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [
              {
                field: ["input", "quantities", "0", "quantity"],
                message: "Quantity exceeds available capacity",
                code: "INVALID_QUANTITY",
              },
            ],
          },
        },
      },
    ]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 999999,
      reason: "cycle_count_available",
      referenceDocumentUri: "audit",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Quantity exceeds available capacity");
    expect(admin.calls).toHaveLength(1);
  });

  it("surfaces error if mutation returns null adjustmentGroup with no userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          inventorySetQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [],
          },
        },
      },
    ]);
    const result = await setInventoryQuantity(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      locationId: "gid://shopify/Location/1",
      quantity: 42,
      reason: "cycle_count_available",
      referenceDocumentUri: "audit",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no adjustmentGroup");
  });
});
