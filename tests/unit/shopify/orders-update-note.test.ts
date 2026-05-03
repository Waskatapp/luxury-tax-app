import { describe, expect, it } from "vitest";

import { updateOrderNote } from "../../../app/lib/shopify/orders.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// updateOrderNote issues TWO calls: orderUpdate (the mutation) +
// fetchOrderDetail (post-update snapshot). Test fixtures provide both.

function detailNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/Order/1001",
    name: "#1001",
    createdAt: "2026-04-25T10:00:00Z",
    processedAt: "2026-04-25T10:00:00Z",
    cancelledAt: null,
    closedAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    sourceName: "web",
    tags: ["vip"],
    note: "Customer wants gift wrap",
    updatedAt: "2026-05-03T10:00:00Z",
    customer: null,
    lineItems: { edges: [] },
    subtotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
    totalShippingPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    totalTaxSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
    totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    shippingAddress: null,
    fulfillments: [],
    refunds: [],
    ...overrides,
  };
}

describe("updateOrderNote", () => {
  it("happy path — sends new note, returns post-update snapshot", async () => {
    const admin = fakeAdmin([
      // 1. orderUpdate mutation
      {
        kind: "data",
        body: {
          orderUpdate: {
            order: { id: "gid://shopify/Order/1001" },
            userErrors: [],
          },
        },
      },
      // 2. fetchOrderDetail post-update
      {
        kind: "data",
        body: { order: detailNode({ note: "Customer wants gift wrap" }) },
      },
    ]);

    const result = await updateOrderNote(admin, {
      orderId: "gid://shopify/Order/1001",
      note: "Customer wants gift wrap",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.note).toBe("Customer wants gift wrap");
    expect(admin.calls).toHaveLength(2);
    expect(admin.calls[0].variables).toEqual({
      input: {
        id: "gid://shopify/Order/1001",
        note: "Customer wants gift wrap",
      },
    });
  });

  it("empty string clears the note", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orderUpdate: {
            order: { id: "gid://shopify/Order/1001" },
            userErrors: [],
          },
        },
      },
      {
        kind: "data",
        body: { order: detailNode({ note: null }) },
      },
    ]);

    const result = await updateOrderNote(admin, {
      orderId: "gid://shopify/Order/1001",
      note: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Mutation input passes empty string verbatim — Shopify treats it as clear.
    expect(admin.calls[0].variables).toEqual({
      input: { id: "gid://shopify/Order/1001", note: "" },
    });
  });

  it("rejects empty orderId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await updateOrderNote(admin, {
      orderId: "",
      note: "anything",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects missing note field via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await updateOrderNote(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects note longer than 5000 chars (Zod max)", async () => {
    const admin = fakeAdmin([]);
    const result = await updateOrderNote(admin, {
      orderId: "gid://shopify/Order/1001",
      note: "x".repeat(5001),
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orderUpdate: {
            order: null,
            userErrors: [
              { field: ["input", "note"], message: "Note is too long" },
            ],
          },
        },
      },
    ]);
    const result = await updateOrderNote(admin, {
      orderId: "gid://shopify/Order/1001",
      note: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Note is too long");
    // Only the mutation call happened — no snapshot refetch on error.
    expect(admin.calls).toHaveLength(1);
  });

  it("surfaces error if orderUpdate returns null order with no userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: { orderUpdate: { order: null, userErrors: [] } },
      },
    ]);
    const result = await updateOrderNote(admin, {
      orderId: "gid://shopify/Order/1001",
      note: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no order");
  });
});
