import { describe, expect, it } from "vitest";

import { setInventoryTracking } from "../../../app/lib/shopify/inventory.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// setInventoryTracking issues ONE call: inventoryItemUpdate (the
// mutation). No post-mutation snapshot refetch — the mutation result
// itself returns the updated tracked flag, sku, and id, which is enough
// for the AuditLog after-state. (The canonical snapshot used by the
// executor's snapshotBefore is fetchInventoryLevels — separate path.)

describe("setInventoryTracking", () => {
  it("happy path — enable tracking", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          inventoryItemUpdate: {
            inventoryItem: {
              id: "gid://shopify/InventoryItem/1000",
              tracked: true,
              sku: "CAT-001",
            },
            userErrors: [],
          },
        },
      },
    ]);
    const result = await setInventoryTracking(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      tracked: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tracked).toBe(true);
    expect(result.data.inventoryItemId).toBe("gid://shopify/InventoryItem/1000");
    expect(result.data.sku).toBe("CAT-001");
    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0].variables).toEqual({
      id: "gid://shopify/InventoryItem/1000",
      input: { tracked: true },
    });
  });

  it("happy path — disable tracking", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          inventoryItemUpdate: {
            inventoryItem: {
              id: "gid://shopify/InventoryItem/2000",
              tracked: false,
              sku: "DIG-001",
            },
            userErrors: [],
          },
        },
      },
    ]);
    const result = await setInventoryTracking(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/2000",
      tracked: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tracked).toBe(false);
    expect(admin.calls[0].variables).toEqual({
      id: "gid://shopify/InventoryItem/2000",
      input: { tracked: false },
    });
  });

  it("rejects empty inventoryItemId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await setInventoryTracking(admin, {
      inventoryItemId: "",
      tracked: true,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects missing tracked field via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await setInventoryTracking(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects non-boolean tracked via Zod (e.g., string 'true')", async () => {
    const admin = fakeAdmin([]);
    const result = await setInventoryTracking(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      tracked: "true",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors verbatim", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          inventoryItemUpdate: {
            inventoryItem: null,
            userErrors: [
              {
                field: ["input", "tracked"],
                message: "Cannot disable tracking on item with stock",
              },
            ],
          },
        },
      },
    ]);
    const result = await setInventoryTracking(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      tracked: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Cannot disable tracking");
  });

  it("surfaces error if inventoryItemUpdate returns null item with no userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          inventoryItemUpdate: { inventoryItem: null, userErrors: [] },
        },
      },
    ]);
    const result = await setInventoryTracking(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      tracked: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no inventoryItem");
  });

  it("surfaces graphql errors verbatim", async () => {
    const admin = fakeAdmin([
      { kind: "errors", errors: [{ message: "ACCESS_DENIED" }] },
    ]);
    const result = await setInventoryTracking(admin, {
      inventoryItemId: "gid://shopify/InventoryItem/1000",
      tracked: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ACCESS_DENIED");
  });
});
