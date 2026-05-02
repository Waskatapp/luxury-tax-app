import { describe, expect, it } from "vitest";

import { getProductPerformance } from "../../../app/lib/shopify/analytics.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// Build a fake AnalyticsProductWindow response with a single order. The
// helper at the heart of getProductPerformance (getProductWindowAnalytics)
// scans line items and tallies; one order with one matching line item is
// enough to exercise the happy path.
function singleOrderResponse(opts: {
  productId: string;
  unitPrice: string;
  quantity: number;
}) {
  return {
    kind: "data" as const,
    body: {
      orders: {
        edges: [
          {
            cursor: "c1",
            node: {
              id: "gid://shopify/Order/1",
              createdAt: "2026-04-15T12:00:00Z",
              totalPriceSet: {
                shopMoney: {
                  amount: (parseFloat(opts.unitPrice) * opts.quantity).toFixed(
                    2,
                  ),
                  currencyCode: "USD",
                },
              },
              lineItems: {
                edges: [
                  {
                    node: {
                      quantity: opts.quantity,
                      originalUnitPriceSet: {
                        shopMoney: {
                          amount: opts.unitPrice,
                          currencyCode: "USD",
                        },
                      },
                      product: { id: opts.productId },
                    },
                  },
                ],
              },
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

function emptyOrdersResponse() {
  return {
    kind: "data" as const,
    body: {
      orders: {
        edges: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

describe("getProductPerformance", () => {
  it("happy path — sums line items for the target product over default 30-day window", async () => {
    const admin = fakeAdmin([
      singleOrderResponse({
        productId: "gid://shopify/Product/cat-food",
        unitPrice: "24.99",
        quantity: 3,
      }),
    ]);

    const result = await getProductPerformance(admin, {
      productId: "gid://shopify/Product/cat-food",
      productTitle: "Cat Food",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.productId).toBe("gid://shopify/Product/cat-food");
    expect(result.data.productTitle).toBe("Cat Food");
    expect(result.data.unitsSold).toBe(3);
    expect(result.data.orderCount).toBe(1);
    // 24.99 × 3 = 74.97
    expect(result.data.revenue).toBe("74.97");
    expect(result.data.currencyCode).toBe("USD");
    expect(result.data.rangeDays).toBe(30);
    expect(result.data.cappedAtPageLimit).toBe(false);
  });

  it("respects custom days parameter — passes the right query window", async () => {
    const admin = fakeAdmin([
      singleOrderResponse({
        productId: "gid://shopify/Product/cat-food",
        unitPrice: "10.00",
        quantity: 1,
      }),
    ]);

    const result = await getProductPerformance(admin, {
      productId: "gid://shopify/Product/cat-food",
      days: 7,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rangeDays).toBe(7);

    // The query string in the GraphQL variables embeds startsAt and
    // endsAt — verify the window length is roughly 7 days.
    const vars = admin.calls[0].variables as { query: string };
    const match = vars.query.match(
      /created_at:>=(\S+) AND created_at:<(\S+)/,
    );
    expect(match).not.toBeNull();
    if (!match) return;
    const start = new Date(match[1]).getTime();
    const end = new Date(match[2]).getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    const span = (end - start) / dayMs;
    expect(span).toBeCloseTo(7, 1);
  });

  it("zero-sales product — returns 0s with a friendly note", async () => {
    const admin = fakeAdmin([emptyOrdersResponse()]);

    const result = await getProductPerformance(admin, {
      productId: "gid://shopify/Product/dead-stock",
      days: 30,
      productTitle: "Dead Stock",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.unitsSold).toBe(0);
    expect(result.data.orderCount).toBe(0);
    expect(result.data.revenue).toBe("0.00");
    expect(result.data.note).toContain("No sales");
  });

  it("filters out line items for OTHER products in the same order", async () => {
    // Order with two line items: one for the target product, one for
    // a different product. Only the target should be tallied.
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orders: {
            edges: [
              {
                cursor: "c1",
                node: {
                  id: "gid://shopify/Order/1",
                  createdAt: "2026-04-15T12:00:00Z",
                  totalPriceSet: {
                    shopMoney: { amount: "100.00", currencyCode: "USD" },
                  },
                  lineItems: {
                    edges: [
                      {
                        node: {
                          quantity: 2,
                          originalUnitPriceSet: {
                            shopMoney: { amount: "20.00", currencyCode: "USD" },
                          },
                          product: { id: "gid://shopify/Product/cat-food" },
                        },
                      },
                      {
                        node: {
                          quantity: 4,
                          originalUnitPriceSet: {
                            shopMoney: { amount: "15.00", currencyCode: "USD" },
                          },
                          product: { id: "gid://shopify/Product/cat-treat" },
                        },
                      },
                    ],
                  },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await getProductPerformance(admin, {
      productId: "gid://shopify/Product/cat-food",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only Cat Food's 2 units × $20 = $40 — the cat-treat line is excluded.
    expect(result.data.unitsSold).toBe(2);
    expect(result.data.revenue).toBe("40.00");
  });

  it("rejects empty productId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await getProductPerformance(admin, {
      productId: "",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects days > 365 via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await getProductPerformance(admin, {
      productId: "gid://shopify/Product/1",
      days: 400,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("returns null productTitle when caller didn't pass one", async () => {
    const admin = fakeAdmin([emptyOrdersResponse()]);
    const result = await getProductPerformance(admin, {
      productId: "gid://shopify/Product/1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.productTitle).toBeNull();
  });
});
