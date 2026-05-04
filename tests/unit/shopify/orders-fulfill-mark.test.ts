import { describe, expect, it } from "vitest";

import { markAsFulfilled } from "../../../app/lib/shopify/orders.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// markAsFulfilled issues THREE GraphQL calls in the happy path:
// 1. fetchOpenFulfillmentOrders — get list of FOs to fulfill
// 2. fulfillmentCreateV2 — the actual mutation
// 3. fetchOrderDetail — post-update snapshot
// Test fixtures provide all three.

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
    tags: [],
    note: null,
    updatedAt: "2026-05-03T12:00:00Z",
    customer: null,
    lineItems: { edges: [] },
    subtotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
    totalShippingPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    totalTaxSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
    totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    shippingAddress: null,
    fulfillments: [
      {
        id: "gid://shopify/Fulfillment/8001",
        status: "SUCCESS",
        createdAt: "2026-05-03T12:00:00Z",
        trackingInfo: [],
      },
    ],
    refunds: [],
    ...overrides,
  };
}

function fulfillmentOrdersResponse(fos: Array<{ id: string; status: string }>) {
  return {
    kind: "data" as const,
    body: {
      order: {
        id: "gid://shopify/Order/1001",
        fulfillmentOrders: {
          edges: fos.map((fo) => ({ node: fo })),
        },
      },
    },
  };
}

function fulfillmentSuccessResponse() {
  return {
    kind: "data" as const,
    body: {
      fulfillmentCreateV2: {
        fulfillment: {
          id: "gid://shopify/Fulfillment/8001",
          status: "SUCCESS",
          trackingInfo: [],
        },
        userErrors: [],
      },
    },
  };
}

describe("markAsFulfilled", () => {
  it("happy path — fetches FOs, fulfills all open ones, refetches snapshot", async () => {
    const admin = fakeAdmin([
      // 1. Fetch FOs
      fulfillmentOrdersResponse([
        { id: "gid://shopify/FulfillmentOrder/9001", status: "OPEN" },
      ]),
      // 2. fulfillmentCreateV2
      fulfillmentSuccessResponse(),
      // 3. fetchOrderDetail post-update
      { kind: "data", body: { order: detailNode() } },
    ]);

    const result = await markAsFulfilled(admin, {
      orderId: "gid://shopify/Order/1001",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.displayFulfillmentStatus).toBe("FULFILLED");
    expect(admin.calls).toHaveLength(3);

    // Mutation input must include the FO id and notifyCustomer:true (default).
    expect(admin.calls[1].variables).toEqual({
      fulfillment: {
        lineItemsByFulfillmentOrder: [
          { fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001" },
        ],
        notifyCustomer: true,
      },
    });
  });

  it("filters out CLOSED and CANCELLED FOs — only fulfills OPEN/IN_PROGRESS/INCOMPLETE", async () => {
    const admin = fakeAdmin([
      fulfillmentOrdersResponse([
        { id: "gid://shopify/FulfillmentOrder/9001", status: "OPEN" },
        { id: "gid://shopify/FulfillmentOrder/9002", status: "CLOSED" }, // filtered
        { id: "gid://shopify/FulfillmentOrder/9003", status: "IN_PROGRESS" },
        { id: "gid://shopify/FulfillmentOrder/9004", status: "CANCELLED" }, // filtered
      ]),
      fulfillmentSuccessResponse(),
      { kind: "data", body: { order: detailNode() } },
    ]);

    await markAsFulfilled(admin, {
      orderId: "gid://shopify/Order/1001",
    });

    const vars = admin.calls[1].variables as {
      fulfillment: {
        lineItemsByFulfillmentOrder: Array<{ fulfillmentOrderId: string }>;
      };
    };
    expect(vars.fulfillment.lineItemsByFulfillmentOrder).toEqual([
      { fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001" },
      { fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9003" },
    ]);
  });

  it("notifyCustomer:false is passed through verbatim", async () => {
    const admin = fakeAdmin([
      fulfillmentOrdersResponse([
        { id: "gid://shopify/FulfillmentOrder/9001", status: "OPEN" },
      ]),
      fulfillmentSuccessResponse(),
      { kind: "data", body: { order: detailNode() } },
    ]);

    await markAsFulfilled(admin, {
      orderId: "gid://shopify/Order/1001",
      notifyCustomer: false,
    });

    const vars = admin.calls[1].variables as {
      fulfillment: { notifyCustomer: boolean };
    };
    expect(vars.fulfillment.notifyCustomer).toBe(false);
  });

  it("no open FOs — clean error, no mutation issued", async () => {
    const admin = fakeAdmin([
      // Only CLOSED FOs — nothing to fulfill.
      fulfillmentOrdersResponse([
        { id: "gid://shopify/FulfillmentOrder/9001", status: "CLOSED" },
        { id: "gid://shopify/FulfillmentOrder/9002", status: "CANCELLED" },
      ]),
    ]);
    const result = await markAsFulfilled(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no open fulfillment orders");
    // Only the FO fetch happened — no mutation, no refetch.
    expect(admin.calls).toHaveLength(1);
  });

  it("zero FOs (e.g. order with no fulfillable items) — clean error", async () => {
    const admin = fakeAdmin([fulfillmentOrdersResponse([])]);
    const result = await markAsFulfilled(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no open fulfillment orders");
    expect(admin.calls).toHaveLength(1);
  });

  it("order not found — clean error", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { order: null } }]);
    const result = await markAsFulfilled(admin, {
      orderId: "gid://shopify/Order/missing",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("order not found");
  });

  it("rejects empty orderId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await markAsFulfilled(admin, { orderId: "" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors from fulfillmentCreateV2", async () => {
    const admin = fakeAdmin([
      fulfillmentOrdersResponse([
        { id: "gid://shopify/FulfillmentOrder/9001", status: "OPEN" },
      ]),
      {
        kind: "data",
        body: {
          fulfillmentCreateV2: {
            fulfillment: null,
            userErrors: [
              {
                field: ["fulfillment", "lineItemsByFulfillmentOrder"],
                message: "Fulfillment order not found",
              },
            ],
          },
        },
      },
    ]);
    const result = await markAsFulfilled(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Fulfillment order not found");
    // FO fetch + mutation only — no refetch on error.
    expect(admin.calls).toHaveLength(2);
  });

  it("surfaces error if fulfillmentCreateV2 returns null fulfillment with no userErrors", async () => {
    const admin = fakeAdmin([
      fulfillmentOrdersResponse([
        { id: "gid://shopify/FulfillmentOrder/9001", status: "OPEN" },
      ]),
      {
        kind: "data",
        body: {
          fulfillmentCreateV2: { fulfillment: null, userErrors: [] },
        },
      },
    ]);
    const result = await markAsFulfilled(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no fulfillment");
  });
});
