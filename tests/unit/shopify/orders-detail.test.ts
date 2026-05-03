import { describe, expect, it } from "vitest";

import {
  _testing,
  fetchOrderDetail,
  readOrderDetail,
} from "../../../app/lib/shopify/orders.server";
import { fakeAdmin } from "../../helpers/fake-admin";

const { subtractMoney } = _testing;

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
    tags: ["vip", "express"],
    note: "Customer wants gift wrap",
    updatedAt: "2026-04-26T08:00:00Z",
    customer: {
      id: "gid://shopify/Customer/1",
      displayName: "Cat Lover",
      email: "cat@cats.com",
      phone: "+1-555-0100",
    },
    lineItems: {
      edges: [
        {
          node: {
            id: "gid://shopify/LineItem/9001",
            title: "Cat Food Premium",
            variantTitle: "5lb",
            quantity: 2,
            sku: "CF-PREM-5LB",
            originalUnitPriceSet: {
              shopMoney: { amount: "30.00", currencyCode: "USD" },
            },
            discountedUnitPriceSet: {
              shopMoney: { amount: "25.00", currencyCode: "USD" },
            },
            product: { id: "gid://shopify/Product/100" },
            variant: { id: "gid://shopify/ProductVariant/200" },
          },
        },
        {
          node: {
            id: "gid://shopify/LineItem/9002",
            title: "Cat Treat",
            variantTitle: null,
            quantity: 4,
            sku: "CT-001",
            originalUnitPriceSet: {
              shopMoney: { amount: "5.00", currencyCode: "USD" },
            },
            discountedUnitPriceSet: {
              shopMoney: { amount: "5.00", currencyCode: "USD" },
            },
            product: { id: "gid://shopify/Product/101" },
            variant: null,
          },
        },
      ],
    },
    subtotalPriceSet: {
      shopMoney: { amount: "70.00", currencyCode: "USD" },
    },
    totalShippingPriceSet: {
      shopMoney: { amount: "5.00", currencyCode: "USD" },
    },
    totalTaxSet: {
      shopMoney: { amount: "6.00", currencyCode: "USD" },
    },
    totalPriceSet: {
      shopMoney: { amount: "81.00", currencyCode: "USD" },
    },
    totalRefundedSet: {
      shopMoney: { amount: "0.00", currencyCode: "USD" },
    },
    shippingAddress: {
      name: "Cat Lover",
      address1: "123 Main St",
      address2: "Apt 4",
      city: "Springfield",
      province: "IL",
      country: "United States",
      zip: "62701",
      phone: "+1-555-0100",
    },
    fulfillments: [
      {
        id: "gid://shopify/Fulfillment/8001",
        status: "SUCCESS",
        createdAt: "2026-04-25T15:00:00Z",
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
    ...overrides,
  };
}

describe("readOrderDetail", () => {
  it("happy path — returns the full single-order snapshot", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { order: detailNode() } },
    ]);

    const result = await readOrderDetail(admin, {
      orderId: "gid://shopify/Order/1001",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      orderId: "gid://shopify/Order/1001",
      name: "#1001",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      sourceName: "web",
      customerId: "gid://shopify/Customer/1",
      customerDisplayName: "Cat Lover",
      customerEmail: "cat@cats.com",
      customerPhone: "+1-555-0100",
      subtotalPrice: "70.00",
      totalShippingPrice: "5.00",
      totalTax: "6.00",
      totalPrice: "81.00",
      totalRefunded: "0.00",
      totalRefundable: "81.00", // computed = 81 - 0
      currencyCode: "USD",
      tags: ["vip", "express"],
      note: "Customer wants gift wrap",
    });
    expect(result.data.lineItems).toHaveLength(2);
    expect(result.data.lineItems[0]).toEqual({
      lineItemId: "gid://shopify/LineItem/9001",
      title: "Cat Food Premium",
      variantTitle: "5lb",
      quantity: 2,
      originalUnitPrice: "30.00",
      discountedUnitPrice: "25.00",
      sku: "CF-PREM-5LB",
      productId: "gid://shopify/Product/100",
      variantId: "gid://shopify/ProductVariant/200",
    });
    expect(result.data.shippingAddress).toEqual({
      name: "Cat Lover",
      address1: "123 Main St",
      address2: "Apt 4",
      city: "Springfield",
      province: "IL",
      country: "United States",
      zip: "62701",
      phone: "+1-555-0100",
    });
    expect(result.data.fulfillments).toHaveLength(1);
    expect(result.data.fulfillments[0]).toMatchObject({
      fulfillmentId: "gid://shopify/Fulfillment/8001",
      status: "SUCCESS",
    });
    expect(result.data.fulfillments[0].trackingInfo[0]).toEqual({
      number: "9400111202555842761024",
      url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111202555842761024",
      company: "USPS",
    });
  });

  it("totalRefundable computed correctly when partial refund exists", async () => {
    // 81.00 total - 25.00 refunded = 56.00 refundable.
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          order: detailNode({
            totalRefundedSet: {
              shopMoney: { amount: "25.00", currencyCode: "USD" },
            },
            refunds: [
              {
                id: "gid://shopify/Refund/7001",
                createdAt: "2026-04-26T10:00:00Z",
                note: "Damaged in shipping",
                totalRefundedSet: {
                  shopMoney: { amount: "25.00", currencyCode: "USD" },
                },
              },
            ],
          }),
        },
      },
    ]);
    const result = await readOrderDetail(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalRefundable).toBe("56.00");
    expect(result.data.refunds).toHaveLength(1);
    expect(result.data.refunds[0]).toMatchObject({
      refundId: "gid://shopify/Refund/7001",
      totalRefunded: "25.00",
      note: "Damaged in shipping",
    });
  });

  it("totalRefundable clamps to 0 when refunded exceeds total (edge case)", async () => {
    // Edge case: refunds can technically exceed totalPrice in some Shopify
    // configurations (tip refunds, currency rounding). Floor to 0.00 to
    // avoid surfacing a negative refundable amount to the merchant.
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          order: detailNode({
            totalPriceSet: {
              shopMoney: { amount: "10.00", currencyCode: "USD" },
            },
            totalRefundedSet: {
              shopMoney: { amount: "12.00", currencyCode: "USD" },
            },
          }),
        },
      },
    ]);
    const result = await readOrderDetail(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalRefundable).toBe("0.00");
  });

  it("rejects empty orderId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await readOrderDetail(admin, { orderId: "" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("returns ok:false if order is null (not found)", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { order: null } }]);
    const result = await readOrderDetail(admin, {
      orderId: "gid://shopify/Order/missing",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("order not found");
  });

  it("handles guest order (customer null)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: { order: detailNode({ customer: null }) },
      },
    ]);
    const result = await readOrderDetail(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.customerId).toBeNull();
    expect(result.data.customerDisplayName).toBeNull();
    expect(result.data.customerEmail).toBeNull();
    expect(result.data.customerPhone).toBeNull();
  });

  it("handles digital order (no shipping address)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: { order: detailNode({ shippingAddress: null }) },
      },
    ]);
    const result = await readOrderDetail(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.shippingAddress).toBeNull();
  });

  it("handles order with no fulfillments (unfulfilled)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          order: detailNode({
            displayFulfillmentStatus: "UNFULFILLED",
            fulfillments: [],
          }),
        },
      },
    ]);
    const result = await readOrderDetail(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.fulfillments).toHaveLength(0);
    expect(result.data.displayFulfillmentStatus).toBe("UNFULFILLED");
  });

  it("handles cancelled order (cancelledAt populated)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          order: detailNode({
            cancelledAt: "2026-04-26T11:00:00Z",
            displayFinancialStatus: "VOIDED",
          }),
        },
      },
    ]);
    const result = await readOrderDetail(admin, {
      orderId: "gid://shopify/Order/1001",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.cancelledAt).toBe("2026-04-26T11:00:00Z");
    expect(result.data.displayFinancialStatus).toBe("VOIDED");
  });
});

describe("fetchOrderDetail (snapshot helper used by future writes)", () => {
  it("returns the same OrderDetail shape as readOrderDetail", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { order: detailNode() } },
    ]);
    const result = await fetchOrderDetail(admin, "gid://shopify/Order/1001");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orderId).toBe("gid://shopify/Order/1001");
    expect(result.data.totalPrice).toBe("81.00");
    expect(result.data.totalRefundable).toBe("81.00");
  });

  it("returns ok:false if order is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { order: null } }]);
    const result = await fetchOrderDetail(admin, "gid://shopify/Order/missing");
    expect(result.ok).toBe(false);
  });
});

describe("subtractMoney (cent-precision helper)", () => {
  it("simple subtraction", () => {
    expect(subtractMoney("100.00", "25.00")).toBe("75.00");
  });

  it("zero refunded — returns total unchanged", () => {
    expect(subtractMoney("100.00", "0.00")).toBe("100.00");
  });

  it("equal — returns 0.00", () => {
    expect(subtractMoney("50.00", "50.00")).toBe("0.00");
  });

  it("refunded > total — clamps to 0.00", () => {
    expect(subtractMoney("10.00", "12.00")).toBe("0.00");
  });

  it("cent-level precision — no float drift on 0.10 + 0.20 style cases", () => {
    // Classic float-arithmetic trap: 0.10 + 0.20 in float = 0.30000000000000004.
    // The cent-rounding pattern avoids that — we round to integer cents
    // before subtraction.
    expect(subtractMoney("0.30", "0.10")).toBe("0.20");
    expect(subtractMoney("19.99", "5.00")).toBe("14.99");
  });

  it("pads single-digit cents — '1.05' not '1.5'", () => {
    expect(subtractMoney("10.00", "8.95")).toBe("1.05");
  });

  it("zero-cent results pad to '.00'", () => {
    expect(subtractMoney("10.00", "5.00")).toBe("5.00");
  });
});
