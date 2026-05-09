import { describe, expect, it } from "vitest";

import {
  _testing,
  transferInventory,
} from "../../../app/lib/shopify/inventory.server";
import { fakeAdmin } from "../../helpers/fake-admin";

const { TRANSFER_REASONS } = _testing;

// transferInventory issues THREE calls in the happy path:
// 1. fetchInventoryLevels pre-flight (verify from-quantity)
// 2. inventoryAdjustQuantities mutation (atomic single-call, two change entries)
// 3. fetchInventoryLevels post-mutation snapshot
//
// Pre-flight refusal short-circuits before the mutation; only one call.

function inventoryItemNode(
  vancouverAvailable: number,
  torontoAvailable: number,
) {
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
            quantities: [{ name: "available", quantity: vancouverAvailable }],
          },
        },
        {
          node: {
            location: { id: "gid://shopify/Location/2", name: "Toronto" },
            quantities: [{ name: "available", quantity: torontoAvailable }],
          },
        },
      ],
    },
  };
}

function adjustSuccess() {
  return {
    kind: "data" as const,
    body: {
      inventoryAdjustQuantities: {
        inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/3" },
        userErrors: [],
      },
    },
  };
}

describe("transferInventory", () => {
  it("happy path — atomic single-call paired delta with default reason", async () => {
    const admin = fakeAdmin([
      // 1. Pre-flight fetch: vancouver 42, toronto 8.
      { kind: "data", body: { inventoryItem: inventoryItemNode(42, 8) } },
      // 2. Mutation success.
      adjustSuccess(),
      // 3. Post-mutation snapshot: vancouver 37, toronto 13.
      { kind: "data", body: { inventoryItem: inventoryItemNode(37, 13) } },
    ]);
    const result = await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/2",
      quantity: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(admin.calls).toHaveLength(3);

    // The mutation is the SECOND call (first is the pre-flight fetch).
    const vars = admin.calls[1].variables as { input: Record<string, unknown> };
    expect(vars.input).toEqual({
      name: "available",
      reason: "movement_created",
      changes: [
        {
          inventoryItemId: "gid://shopify/InventoryItem/1000",
          locationId: "gid://shopify/Location/1",
          delta: -5,
        },
        {
          inventoryItemId: "gid://shopify/InventoryItem/1000",
          locationId: "gid://shopify/Location/2",
          delta: 5,
        },
      ],
    });
  });

  it("paired delta is sent as ONE atomic mutation (not two separate calls)", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { inventoryItem: inventoryItemNode(42, 0) } },
      adjustSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode(37, 5) } },
    ]);
    await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/2",
      quantity: 5,
    });
    // 1 pre-flight + 1 mutation + 1 post-fetch = 3, NOT 4 (which would mean
    // two mutation calls — the partial-transfer footgun).
    expect(admin.calls).toHaveLength(3);
    const mutationVars = admin.calls[1].variables as {
      input: { changes: unknown[] };
    };
    expect(mutationVars.input.changes).toHaveLength(2);
  });

  it("includes referenceDocumentUri when provided", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { inventoryItem: inventoryItemNode(42, 0) } },
      adjustSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode(37, 5) } },
    ]);
    await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/2",
      quantity: 5,
      referenceDocumentUri: "transfer-ticket-42",
    });
    const vars = admin.calls[1].variables as { input: Record<string, unknown> };
    expect(vars.input.referenceDocumentUri).toBe("transfer-ticket-42");
  });

  it("pre-flight refuses if from-location not found in inventory levels", async () => {
    const admin = fakeAdmin([
      // Pre-flight: only Vancouver, no Toronto.
      {
        kind: "data",
        body: {
          inventoryItem: {
            ...inventoryItemNode(42, 0),
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
              ],
            },
          },
        },
      },
    ]);
    const result = await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/999", // doesn't exist for this item
      toLocationId: "gid://shopify/Location/1",
      quantity: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("from location");
    expect(result.error).toContain("no inventory level");
    // Only the pre-flight ran — no mutation.
    expect(admin.calls).toHaveLength(1);
  });

  it("pre-flight refuses if from-quantity insufficient (would drive negative)", async () => {
    const admin = fakeAdmin([
      // Pre-flight: vancouver only has 3.
      { kind: "data", body: { inventoryItem: inventoryItemNode(3, 0) } },
    ]);
    const result = await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/2",
      quantity: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Vancouver");
    expect(result.error).toContain("negative");
    expect(result.error).toContain("3");
    expect(result.error).toContain("5");
    // Only the pre-flight ran — no mutation.
    expect(admin.calls).toHaveLength(1);
  });

  it("pre-flight allows transfer when from-quantity exactly equals requested", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { inventoryItem: inventoryItemNode(5, 0) } },
      adjustSuccess(),
      { kind: "data", body: { inventoryItem: inventoryItemNode(0, 5) } },
    ]);
    const result = await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/2",
      quantity: 5,
    });
    expect(result.ok).toBe(true);
    expect(admin.calls).toHaveLength(3);
  });

  it("rejects same fromLocationId and toLocationId via Zod refine", async () => {
    const admin = fakeAdmin([]);
    const result = await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/1",
      quantity: 5,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects quantity: 0 via Zod (positive required)", async () => {
    const admin = fakeAdmin([]);
    const result = await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/2",
      quantity: 0,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects negative quantity via Zod (positive required)", async () => {
    const admin = fakeAdmin([]);
    const result = await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/2",
      quantity: -5,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects non-integer quantity via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/2",
      quantity: 5.5,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it.each(TRANSFER_REASONS)(
    "accepts %s as a valid reason enum",
    async (reason) => {
      const admin = fakeAdmin([
        { kind: "data", body: { inventoryItem: inventoryItemNode(42, 0) } },
        adjustSuccess(),
        { kind: "data", body: { inventoryItem: inventoryItemNode(37, 5) } },
      ]);
      const result = await transferInventory(admin, {
        inventoryItemId: "gid://shopify/InventoryItem/1000",
        fromLocationId: "gid://shopify/Location/1",
        toLocationId: "gid://shopify/Location/2",
        quantity: 5,
        reason,
      });
      expect(result.ok).toBe(true);
    },
  );

  it("rejects 'received' reason on transfer (only valid for adjust)", async () => {
    const admin = fakeAdmin([]);
    const result = await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/2",
      quantity: 5,
      reason: "received",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors from the mutation verbatim", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { inventoryItem: inventoryItemNode(42, 0) } },
      {
        kind: "data",
        body: {
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [
              {
                field: ["input", "changes"],
                message: "Item is not stocked at one of the locations",
                code: "ITEM_NOT_STOCKED_AT_LOCATION",
              },
            ],
          },
        },
      },
    ]);
    const result = await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/2",
      quantity: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Item is not stocked");
    // Pre-flight + mutation = 2 calls. No post-fetch on error.
    expect(admin.calls).toHaveLength(2);
  });

  it("surfaces error if pre-flight fetch returns missing inventory item", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { inventoryItem: null } },
    ]);
    const result = await transferInventory(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/9999",
      fromLocationId: "gid://shopify/Location/1",
      toLocationId: "gid://shopify/Location/2",
      quantity: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("inventory item not found");
    // Only the pre-flight ran.
    expect(admin.calls).toHaveLength(1);
  });
});
