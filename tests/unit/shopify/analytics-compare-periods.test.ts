import { describe, expect, it } from "vitest";

import { comparePeriods } from "../../../app/lib/shopify/analytics.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// Helper: build a one-order response with the given totalPrice and one
// line item. comparePeriods makes TWO calls (current + prior) so we
// usually need two of these per test, in order.
function orderResponse(opts: {
  totalPrice: string;
  lineItem: { quantity: number; unitPrice: string; productId: string | null };
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
                  amount: opts.totalPrice,
                  currencyCode: "USD",
                },
              },
              lineItems: {
                edges: [
                  {
                    node: {
                      quantity: opts.lineItem.quantity,
                      originalUnitPriceSet: {
                        shopMoney: {
                          amount: opts.lineItem.unitPrice,
                          currencyCode: "USD",
                        },
                      },
                      product: opts.lineItem.productId
                        ? { id: opts.lineItem.productId }
                        : null,
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

describe("comparePeriods", () => {
  it("happy path — store-wide growth, deltas + percentages computed correctly", async () => {
    // Current window: $200 revenue, 1 order, 5 units
    // Prior window: $100 revenue, 1 order, 4 units
    // Expected deltas: +$100 (+100%), +1 unit (+25%), +0 orders (+0%)
    const admin = fakeAdmin([
      orderResponse({
        totalPrice: "200.00",
        lineItem: { quantity: 5, unitPrice: "40.00", productId: "p1" },
      }),
      orderResponse({
        totalPrice: "100.00",
        lineItem: { quantity: 4, unitPrice: "25.00", productId: "p1" },
      }),
    ]);

    const result = await comparePeriods(admin, { days: 30 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.productId).toBeNull();
    expect(result.data.current.unitsSold).toBe(5);
    expect(result.data.current.revenue).toBe("200.00");
    expect(result.data.prior.unitsSold).toBe(4);
    expect(result.data.prior.revenue).toBe("100.00");
    expect(result.data.delta.unitsSold).toBe(1);
    expect(result.data.delta.revenue).toBe("100.00");
    // 1/4 = 25%, (200-100)/100 = 100%
    expect(result.data.delta.unitsSoldPct).toBe(25);
    expect(result.data.delta.revenuePct).toBe(100);
  });

  it("decline scenario — negative deltas and negative percentages", async () => {
    // Current: $50, 1 order, 2 units
    // Prior:   $200, 1 order, 8 units
    // Deltas: -$150 (-75%), -6 units (-75%)
    const admin = fakeAdmin([
      orderResponse({
        totalPrice: "50.00",
        lineItem: { quantity: 2, unitPrice: "25.00", productId: "p1" },
      }),
      orderResponse({
        totalPrice: "200.00",
        lineItem: { quantity: 8, unitPrice: "25.00", productId: "p1" },
      }),
    ]);

    const result = await comparePeriods(admin, { days: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.delta.unitsSold).toBe(-6);
    expect(result.data.delta.revenue).toBe("-150.00");
    expect(result.data.delta.unitsSoldPct).toBe(-75);
    expect(result.data.delta.revenuePct).toBe(-75);
  });

  it("divide-by-zero — prior had 0, percentages are null with explanatory note", async () => {
    // Current: 1 order, $50, 2 units
    // Prior:   no orders
    const admin = fakeAdmin([
      orderResponse({
        totalPrice: "50.00",
        lineItem: { quantity: 2, unitPrice: "25.00", productId: "p1" },
      }),
      emptyOrdersResponse(),
    ]);

    const result = await comparePeriods(admin, { days: 30 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.current.orderCount).toBe(1);
    expect(result.data.prior.orderCount).toBe(0);
    // Critical: percentages are NULL not Infinity / NaN
    expect(result.data.delta.unitsSoldPct).toBeNull();
    expect(result.data.delta.revenuePct).toBeNull();
    expect(result.data.note).toContain("Prior window had no orders");
  });

  it("both windows empty — note flags it; no error", async () => {
    const admin = fakeAdmin([emptyOrdersResponse(), emptyOrdersResponse()]);

    const result = await comparePeriods(admin, { days: 30 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.current.orderCount).toBe(0);
    expect(result.data.prior.orderCount).toBe(0);
    expect(result.data.delta.unitsSold).toBe(0);
    expect(result.data.delta.unitsSoldPct).toBeNull();
    expect(result.data.note).toContain("No orders in either window");
  });

  it("product-specific comparison — only tallies the target product's line items", async () => {
    // Each window has 1 order with 2 line items: target + non-target.
    // Only target should contribute.
    const orderWithTwoLineItems = (targetUnits: number) => ({
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
                  shopMoney: { amount: "999.00", currencyCode: "USD" },
                },
                lineItems: {
                  edges: [
                    {
                      node: {
                        quantity: targetUnits,
                        originalUnitPriceSet: {
                          shopMoney: { amount: "20.00", currencyCode: "USD" },
                        },
                        product: { id: "gid://shopify/Product/cat-food" },
                      },
                    },
                    {
                      node: {
                        quantity: 100,
                        originalUnitPriceSet: {
                          shopMoney: { amount: "50.00", currencyCode: "USD" },
                        },
                        product: { id: "gid://shopify/Product/other" },
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
    });

    const admin = fakeAdmin([
      orderWithTwoLineItems(5), // current: 5 cat-food units
      orderWithTwoLineItems(3), // prior:   3 cat-food units
    ]);

    const result = await comparePeriods(admin, {
      productId: "gid://shopify/Product/cat-food",
      productTitle: "Cat Food",
      days: 30,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only cat-food contributed. 5 vs 3 units; revenue = 5×$20 vs 3×$20.
    expect(result.data.productId).toBe("gid://shopify/Product/cat-food");
    expect(result.data.productTitle).toBe("Cat Food");
    expect(result.data.current.unitsSold).toBe(5);
    expect(result.data.prior.unitsSold).toBe(3);
    expect(result.data.current.revenue).toBe("100.00");
    expect(result.data.prior.revenue).toBe("60.00");
    expect(result.data.delta.revenue).toBe("40.00");
  });

  it("issues two GraphQL calls (current + prior) with different windows", async () => {
    const admin = fakeAdmin([emptyOrdersResponse(), emptyOrdersResponse()]);
    await comparePeriods(admin, { days: 30 });

    expect(admin.calls).toHaveLength(2);

    // Each call's query embeds the window. The two windows should be
    // adjacent and equal-length — i.e., prior.endsAt == current.startsAt.
    const extractWindow = (q: string) => {
      const m = q.match(/created_at:>=(\S+) AND created_at:<(\S+)/);
      if (!m) throw new Error("query did not match expected window pattern");
      return {
        start: new Date(m[1]).getTime(),
        end: new Date(m[2]).getTime(),
      };
    };
    const current = extractWindow(
      (admin.calls[0].variables as { query: string }).query,
    );
    const prior = extractWindow(
      (admin.calls[1].variables as { query: string }).query,
    );

    const dayMs = 24 * 60 * 60 * 1000;
    expect((current.end - current.start) / dayMs).toBeCloseTo(30, 1);
    expect((prior.end - prior.start) / dayMs).toBeCloseTo(30, 1);
    // Prior ends where current begins (back-to-back windows).
    expect(prior.end).toBe(current.start);
  });

  it("rejects days > 365 via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await comparePeriods(admin, { days: 400 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects days < 1 via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await comparePeriods(admin, { days: 0 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });
});
