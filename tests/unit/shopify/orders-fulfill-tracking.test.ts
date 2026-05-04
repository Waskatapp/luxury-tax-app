import { describe, expect, it } from "vitest";

import { fulfillOrderWithTracking } from "../../../app/lib/shopify/orders.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function detailNode() {
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
        trackingInfo: [
          {
            number: "9400111202555842761024",
            url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111202555842761024",
            company: "USPS",
          },
        ],
      },
    ],
    refunds: [],
  };
}

function fulfillmentOrdersResponse() {
  return {
    kind: "data" as const,
    body: {
      order: {
        id: "gid://shopify/Order/1001",
        fulfillmentOrders: {
          edges: [
            {
              node: { id: "gid://shopify/FulfillmentOrder/9001", status: "OPEN" },
            },
          ],
        },
      },
    },
  };
}

function fulfillmentSuccessResponse(opts: {
  trackingNumber: string;
  trackingCompany: string;
  trackingUrl?: string | null;
}) {
  return {
    kind: "data" as const,
    body: {
      fulfillmentCreateV2: {
        fulfillment: {
          id: "gid://shopify/Fulfillment/8001",
          status: "SUCCESS",
          trackingInfo: [
            {
              number: opts.trackingNumber,
              url: opts.trackingUrl ?? null,
              company: opts.trackingCompany,
            },
          ],
        },
        userErrors: [],
      },
    },
  };
}

describe("fulfillOrderWithTracking", () => {
  it("happy path with tracking — sends number + company, refetches snapshot", async () => {
    const admin = fakeAdmin([
      fulfillmentOrdersResponse(),
      fulfillmentSuccessResponse({
        trackingNumber: "9400111202555842761024",
        trackingCompany: "USPS",
      }),
      { kind: "data", body: { order: detailNode() } },
    ]);

    const result = await fulfillOrderWithTracking(admin, {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "9400111202555842761024",
      trackingCompany: "USPS",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(admin.calls).toHaveLength(3);

    // Mutation input includes trackingInfo with number + company (no url —
    // omitted, Shopify auto-generates for known carriers).
    const vars = admin.calls[1].variables as {
      fulfillment: {
        lineItemsByFulfillmentOrder: Array<{ fulfillmentOrderId: string }>;
        trackingInfo: { number: string; company: string; url?: string };
        notifyCustomer: boolean;
      };
    };
    expect(vars.fulfillment.lineItemsByFulfillmentOrder).toEqual([
      { fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001" },
    ]);
    expect(vars.fulfillment.trackingInfo).toEqual({
      number: "9400111202555842761024",
      company: "USPS",
    });
    expect("url" in vars.fulfillment.trackingInfo).toBe(false);
    expect(vars.fulfillment.notifyCustomer).toBe(true);
  });

  it("trackingUrl provided — included in mutation input", async () => {
    const admin = fakeAdmin([
      fulfillmentOrdersResponse(),
      fulfillmentSuccessResponse({
        trackingNumber: "ABC123",
        trackingCompany: "Custom Carrier",
        trackingUrl: "https://custom.example.com/track/ABC123",
      }),
      { kind: "data", body: { order: detailNode() } },
    ]);

    await fulfillOrderWithTracking(admin, {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "ABC123",
      trackingCompany: "Custom Carrier",
      trackingUrl: "https://custom.example.com/track/ABC123",
    });

    const vars = admin.calls[1].variables as {
      fulfillment: { trackingInfo: { number: string; company: string; url: string } };
    };
    expect(vars.fulfillment.trackingInfo).toEqual({
      number: "ABC123",
      company: "Custom Carrier",
      url: "https://custom.example.com/track/ABC123",
    });
  });

  it("notifyCustomer:false is passed through verbatim", async () => {
    const admin = fakeAdmin([
      fulfillmentOrdersResponse(),
      fulfillmentSuccessResponse({
        trackingNumber: "1Z999",
        trackingCompany: "UPS",
      }),
      { kind: "data", body: { order: detailNode() } },
    ]);

    await fulfillOrderWithTracking(admin, {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "1Z999",
      trackingCompany: "UPS",
      notifyCustomer: false,
    });

    const vars = admin.calls[1].variables as {
      fulfillment: { notifyCustomer: boolean };
    };
    expect(vars.fulfillment.notifyCustomer).toBe(false);
  });

  it("rejects empty orderId", async () => {
    const admin = fakeAdmin([]);
    const result = await fulfillOrderWithTracking(admin, {
      orderId: "",
      trackingNumber: "1Z999",
      trackingCompany: "UPS",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty trackingNumber", async () => {
    const admin = fakeAdmin([]);
    const result = await fulfillOrderWithTracking(admin, {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "",
      trackingCompany: "UPS",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty trackingCompany", async () => {
    const admin = fakeAdmin([]);
    const result = await fulfillOrderWithTracking(admin, {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "1Z999",
      trackingCompany: "",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects malformed trackingUrl (not a URL)", async () => {
    const admin = fakeAdmin([]);
    const result = await fulfillOrderWithTracking(admin, {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "1Z999",
      trackingCompany: "UPS",
      trackingUrl: "not-a-url",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("no open FOs — clean error, no mutation issued", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          order: {
            id: "gid://shopify/Order/1001",
            fulfillmentOrders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/FulfillmentOrder/9001",
                    status: "CLOSED",
                  },
                },
              ],
            },
          },
        },
      },
    ]);
    const result = await fulfillOrderWithTracking(admin, {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "1Z999",
      trackingCompany: "UPS",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no open fulfillment orders");
    expect(admin.calls).toHaveLength(1);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      fulfillmentOrdersResponse(),
      {
        kind: "data",
        body: {
          fulfillmentCreateV2: {
            fulfillment: null,
            userErrors: [
              {
                field: ["fulfillment", "trackingInfo"],
                message: "Tracking number is invalid",
              },
            ],
          },
        },
      },
    ]);
    const result = await fulfillOrderWithTracking(admin, {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "BAD",
      trackingCompany: "UPS",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Tracking number is invalid");
  });
});
