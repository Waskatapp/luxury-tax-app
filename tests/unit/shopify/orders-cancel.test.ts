import { describe, expect, it } from "vitest";

import {
  _testing,
  cancelOrder,
} from "../../../app/lib/shopify/orders.server";
import { fakeAdmin } from "../../helpers/fake-admin";

const { ORDER_CANCEL_MUTATION } = _testing;

// cancelOrder issues TWO calls in the happy path:
// 1. orderCancel mutation
// 2. fetchOrderDetail post-cancel snapshot

function detailNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/Order/1001",
    name: "#1001",
    createdAt: "2026-04-25T10:00:00Z",
    processedAt: "2026-04-25T10:00:00Z",
    cancelledAt: "2026-05-04T12:00:00Z",
    closedAt: null,
    displayFinancialStatus: "VOIDED",
    displayFulfillmentStatus: "UNFULFILLED",
    sourceName: "web",
    tags: [],
    note: null,
    updatedAt: "2026-05-04T12:00:00Z",
    customer: {
      id: "gid://shopify/Customer/1",
      displayName: "Cat Lover",
      email: "cat@cats.com",
      phone: null,
    },
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

function cancelSuccessResponse() {
  return {
    kind: "data" as const,
    body: {
      orderCancel: {
        job: { id: "gid://shopify/Job/8001", done: false },
        orderCancelUserErrors: [],
        userErrors: [],
      },
    },
  };
}

describe("cancelOrder", () => {
  it("happy path — sends mutation with reason + notifyCustomer + refund:false hardcoded", async () => {
    const admin = fakeAdmin([
      cancelSuccessResponse(),
      { kind: "data", body: { order: detailNode() } },
    ]);

    const result = await cancelOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      reason: "CUSTOMER",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.cancelledAt).toBeTruthy();
    expect(result.data.displayFinancialStatus).toBe("VOIDED");
    expect(admin.calls).toHaveLength(2);

    // Mutation input must include orderId, reason, notifyCustomer:true (default).
    expect(admin.calls[0].variables).toEqual({
      orderId: "gid://shopify/Order/1001",
      reason: "CUSTOMER",
      notifyCustomer: true,
    });
  });

  it("hard-codes refund:false + restock:false in the mutation query string (NOT in variables)", async () => {
    // The defensive design: refund + restock are LITERALS in the
    // mutation body, not configurable inputs. This test asserts that
    // the query string contains them and that variables don't.
    const admin = fakeAdmin([
      cancelSuccessResponse(),
      { kind: "data", body: { order: detailNode() } },
    ]);
    await cancelOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      reason: "CUSTOMER",
    });

    expect(admin.calls[0].query).toContain("refund: false");
    expect(admin.calls[0].query).toContain("restock: false");
    // Match the canonical mutation literal.
    expect(admin.calls[0].query).toBe(ORDER_CANCEL_MUTATION);

    const vars = admin.calls[0].variables as Record<string, unknown>;
    expect(vars.refund).toBeUndefined();
    expect(vars.restock).toBeUndefined();
  });

  it("notifyCustomer:false is passed through verbatim", async () => {
    const admin = fakeAdmin([
      cancelSuccessResponse(),
      { kind: "data", body: { order: detailNode() } },
    ]);
    await cancelOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      reason: "CUSTOMER",
      notifyCustomer: false,
    });
    expect(admin.calls[0].variables).toMatchObject({ notifyCustomer: false });
  });

  it("staffNote is included when provided", async () => {
    const admin = fakeAdmin([
      cancelSuccessResponse(),
      { kind: "data", body: { order: detailNode() } },
    ]);
    await cancelOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      reason: "FRAUD",
      staffNote: "suspected fraud — multiple chargebacks from this email",
    });
    const vars = admin.calls[0].variables as { staffNote?: string };
    expect(vars.staffNote).toBe(
      "suspected fraud — multiple chargebacks from this email",
    );
  });

  it("staffNote is omitted from variables when not provided", async () => {
    const admin = fakeAdmin([
      cancelSuccessResponse(),
      { kind: "data", body: { order: detailNode() } },
    ]);
    await cancelOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      reason: "CUSTOMER",
    });
    const vars = admin.calls[0].variables as Record<string, unknown>;
    expect("staffNote" in vars).toBe(false);
  });

  it.each([
    "CUSTOMER",
    "FRAUD",
    "INVENTORY",
    "DECLINED",
    "STAFF",
    "OTHER",
  ])("accepts %s as a valid reason enum", async (reason) => {
    const admin = fakeAdmin([
      cancelSuccessResponse(),
      { kind: "data", body: { order: detailNode() } },
    ]);
    const result = await cancelOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      reason,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid reason via Zod enum", async () => {
    const admin = fakeAdmin([]);
    const result = await cancelOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      reason: "BECAUSE_REASONS",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects missing reason", async () => {
    const admin = fakeAdmin([]);
    const result = await cancelOrder(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty orderId", async () => {
    const admin = fakeAdmin([]);
    const result = await cancelOrder(admin, {
      orderId: "",
      reason: "CUSTOMER",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects staffNote longer than 500 chars", async () => {
    const admin = fakeAdmin([]);
    const result = await cancelOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      reason: "OTHER",
      staffNote: "x".repeat(501),
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces typed orderCancelUserErrors verbatim", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orderCancel: {
            job: null,
            orderCancelUserErrors: [
              {
                field: ["orderId"],
                message: "Order has already been cancelled",
                code: "ORDER_ALREADY_CANCELLED",
              },
            ],
            userErrors: [],
          },
        },
      },
    ]);
    const result = await cancelOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      reason: "CUSTOMER",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Order has already been cancelled");
    // Only the mutation call happened — no snapshot refetch on error.
    expect(admin.calls).toHaveLength(1);
  });

  it("surfaces generic userErrors as fallback", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orderCancel: {
            job: null,
            orderCancelUserErrors: [],
            userErrors: [
              { field: ["orderId"], message: "Generic error" },
            ],
          },
        },
      },
    ]);
    const result = await cancelOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      reason: "CUSTOMER",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Generic error");
  });
});
