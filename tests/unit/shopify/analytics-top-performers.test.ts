import { describe, expect, it } from "vitest";

import { getTopPerformers } from "../../../app/lib/shopify/analytics.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// Build a fake top_performers response with multiple orders + line items.
// Each line item carries a product id, quantity, and unit price so we
// exercise both unit-based and revenue-based ranking from the same data.
type LineItem = {
  productId: string;
  productTitle: string;
  productHandle?: string;
  quantity: number;
  unitPrice: string;
};

function ordersResponse(orders: Array<{ id: string; lineItems: LineItem[] }>) {
  return {
    kind: "data" as const,
    body: {
      orders: {
        edges: orders.map((o, i) => ({
          cursor: `c${i}`,
          node: {
            id: o.id,
            lineItems: {
              edges: o.lineItems.map((li) => ({
                node: {
                  quantity: li.quantity,
                  originalUnitPriceSet: {
                    shopMoney: { amount: li.unitPrice, currencyCode: "USD" },
                  },
                  product: {
                    id: li.productId,
                    title: li.productTitle,
                    handle: li.productHandle ?? li.productTitle.toLowerCase(),
                  },
                },
              })),
            },
          },
        })),
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

describe("getTopPerformers — happy paths", () => {
  it("default — top 10 by units, descending; tallies across orders", async () => {
    // Cat Food: 5+3 = 8 units, 8 × $20 = $160
    // Cat Treat: 10 units (1 order), 10 × $5 = $50
    // Snowboard: 1 unit, 1 × $500 = $500
    const admin = fakeAdmin([
      ordersResponse([
        {
          id: "gid://shopify/Order/1",
          lineItems: [
            { productId: "p:cat-food", productTitle: "Cat Food", quantity: 5, unitPrice: "20.00" },
            { productId: "p:snowboard", productTitle: "Snowboard", quantity: 1, unitPrice: "500.00" },
          ],
        },
        {
          id: "gid://shopify/Order/2",
          lineItems: [
            { productId: "p:cat-food", productTitle: "Cat Food", quantity: 3, unitPrice: "20.00" },
            { productId: "p:cat-treat", productTitle: "Cat Treat", quantity: 10, unitPrice: "5.00" },
          ],
        },
      ]),
    ]);

    const result = await getTopPerformers(admin, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.direction).toBe("top");
    expect(result.data.sortBy).toBe("units");
    expect(result.data.limit).toBe(10);
    expect(result.data.rangeDays).toBe(30);
    expect(result.data.products).toHaveLength(3);

    // Sorted by units desc: cat-treat (10), cat-food (8), snowboard (1)
    expect(result.data.products[0].id).toBe("p:cat-treat");
    expect(result.data.products[0].unitsSold).toBe(10);
    expect(result.data.products[0].revenue).toBe("50.00");
    expect(result.data.products[1].id).toBe("p:cat-food");
    expect(result.data.products[1].unitsSold).toBe(8);
    expect(result.data.products[1].revenue).toBe("160.00");
    expect(result.data.products[1].orderCount).toBe(2);
    expect(result.data.products[2].id).toBe("p:snowboard");
  });

  it("sortBy=revenue — same data, different ranking", async () => {
    const admin = fakeAdmin([
      ordersResponse([
        {
          id: "gid://shopify/Order/1",
          lineItems: [
            { productId: "p:cat-food", productTitle: "Cat Food", quantity: 5, unitPrice: "20.00" },
            { productId: "p:snowboard", productTitle: "Snowboard", quantity: 1, unitPrice: "500.00" },
          ],
        },
        {
          id: "gid://shopify/Order/2",
          lineItems: [
            { productId: "p:cat-food", productTitle: "Cat Food", quantity: 3, unitPrice: "20.00" },
            { productId: "p:cat-treat", productTitle: "Cat Treat", quantity: 10, unitPrice: "5.00" },
          ],
        },
      ]),
    ]);

    const result = await getTopPerformers(admin, { sortBy: "revenue" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // By revenue: snowboard ($500), cat-food ($160), cat-treat ($50)
    // — opposite of the units ranking!
    expect(result.data.products[0].id).toBe("p:snowboard");
    expect(result.data.products[0].revenue).toBe("500.00");
    expect(result.data.products[1].id).toBe("p:cat-food");
    expect(result.data.products[1].revenue).toBe("160.00");
    expect(result.data.products[2].id).toBe("p:cat-treat");
    expect(result.data.products[2].revenue).toBe("50.00");
  });

  it("direction=bottom — ascending; products with 0 units excluded", async () => {
    // Cat Food: 1 unit (low). Cat Treat: 10 units (high).
    // (Products with 0 units never appear in the order data anyway,
    // so the filter is exercised by ordering-by-ascending only when
    // there ARE multiple products with sales.)
    const admin = fakeAdmin([
      ordersResponse([
        {
          id: "gid://shopify/Order/1",
          lineItems: [
            { productId: "p:cat-food", productTitle: "Cat Food", quantity: 1, unitPrice: "20.00" },
            { productId: "p:cat-treat", productTitle: "Cat Treat", quantity: 10, unitPrice: "5.00" },
          ],
        },
      ]),
    ]);

    const result = await getTopPerformers(admin, { direction: "bottom" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.direction).toBe("bottom");
    // Cat Food (1 unit) before Cat Treat (10 units) when sorted ascending.
    expect(result.data.products[0].id).toBe("p:cat-food");
    expect(result.data.products[0].unitsSold).toBe(1);
    expect(result.data.products[1].id).toBe("p:cat-treat");
    expect(result.data.note).toContain("excluding products that didn't sell");
  });

  it("limit — slices to the configured count", async () => {
    const admin = fakeAdmin([
      ordersResponse([
        {
          id: "gid://shopify/Order/1",
          lineItems: [
            { productId: "p:a", productTitle: "A", quantity: 5, unitPrice: "10.00" },
            { productId: "p:b", productTitle: "B", quantity: 4, unitPrice: "10.00" },
            { productId: "p:c", productTitle: "C", quantity: 3, unitPrice: "10.00" },
            { productId: "p:d", productTitle: "D", quantity: 2, unitPrice: "10.00" },
          ],
        },
      ]),
    ]);

    const result = await getTopPerformers(admin, { limit: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.products).toHaveLength(2);
    expect(result.data.products[0].id).toBe("p:a");
    expect(result.data.products[1].id).toBe("p:b");
  });

  it("days param — passes the right window into the GraphQL query", async () => {
    const admin = fakeAdmin([emptyOrdersResponse()]);
    await getTopPerformers(admin, { days: 7 });

    const vars = admin.calls[0].variables as { query: string };
    expect(vars.query).toMatch(/created_at:>=/);
    // Window should be roughly 7 days ago
    const m = vars.query.match(/created_at:>=(\S+)/);
    expect(m).not.toBeNull();
    if (!m) return;
    const start = new Date(m[1]).getTime();
    const ago = (Date.now() - start) / (24 * 60 * 60 * 1000);
    expect(ago).toBeCloseTo(7, 1);
  });

  it("ignores line items from deleted products (product: null)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orders: {
            edges: [
              {
                cursor: "c0",
                node: {
                  id: "gid://shopify/Order/1",
                  lineItems: {
                    edges: [
                      {
                        node: {
                          quantity: 5,
                          originalUnitPriceSet: {
                            shopMoney: { amount: "20.00", currencyCode: "USD" },
                          },
                          product: { id: "p:cat-food", title: "Cat Food", handle: "cat-food" },
                        },
                      },
                      {
                        node: {
                          quantity: 100,
                          originalUnitPriceSet: {
                            shopMoney: { amount: "999.00", currencyCode: "USD" },
                          },
                          product: null, // deleted product — should be skipped
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

    const result = await getTopPerformers(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only cat-food (5 units, $100) — the deleted product line is skipped.
    expect(result.data.products).toHaveLength(1);
    expect(result.data.products[0].id).toBe("p:cat-food");
    expect(result.data.products[0].unitsSold).toBe(5);
    expect(result.data.products[0].revenue).toBe("100.00");
  });

  it("empty orders — returns an empty list with a friendly note", async () => {
    const admin = fakeAdmin([emptyOrdersResponse()]);
    const result = await getTopPerformers(admin, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.products).toHaveLength(0);
    expect(result.data.note).toContain("No qualifying products");
  });
});

describe("getTopPerformers — Zod rejections", () => {
  it("rejects invalid direction", async () => {
    const admin = fakeAdmin([]);
    const result = await getTopPerformers(admin, { direction: "middle" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects invalid sortBy", async () => {
    const admin = fakeAdmin([]);
    const result = await getTopPerformers(admin, { sortBy: "alphabetical" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects limit > 50", async () => {
    const admin = fakeAdmin([]);
    const result = await getTopPerformers(admin, { limit: 100 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects limit < 1", async () => {
    const admin = fakeAdmin([]);
    const result = await getTopPerformers(admin, { limit: 0 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects days > 365", async () => {
    const admin = fakeAdmin([]);
    const result = await getTopPerformers(admin, { days: 400 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });
});
