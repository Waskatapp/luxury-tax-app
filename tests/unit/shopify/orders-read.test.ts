import { describe, expect, it } from "vitest";

import { readOrders } from "../../../app/lib/shopify/orders.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function orderEdge(opts: {
  id: string;
  name: string;
  totalPrice?: string;
  fulfillmentStatus?: string | null;
  financialStatus?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  tags?: string[];
  lineItemsQuantity?: number;
}) {
  return {
    cursor: `c-${opts.id}`,
    node: {
      id: opts.id,
      name: opts.name,
      createdAt: "2026-04-25T10:00:00Z",
      processedAt: "2026-04-25T10:00:00Z",
      displayFinancialStatus: opts.financialStatus ?? "PAID",
      displayFulfillmentStatus: opts.fulfillmentStatus ?? "FULFILLED",
      customer:
        opts.customerName === null
          ? null
          : {
              id: "gid://shopify/Customer/1",
              displayName: opts.customerName ?? "Cat Lover",
              email: opts.customerEmail ?? "cat@cats.com",
            },
      totalPriceSet: {
        shopMoney: {
          amount: opts.totalPrice ?? "100.00",
          currencyCode: "USD",
        },
      },
      lineItems: { edges: [{ node: { id: "gid://shopify/LineItem/1" } }] },
      subtotalLineItemsQuantity: opts.lineItemsQuantity ?? 1,
      tags: opts.tags ?? [],
    },
  };
}

describe("readOrders", () => {
  it("happy path — lists orders with default limit", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orders: {
            edges: [
              orderEdge({
                id: "gid://shopify/Order/1001",
                name: "#1001",
                totalPrice: "120.00",
                customerName: "Cat Lover",
                customerEmail: "cat@cats.com",
                lineItemsQuantity: 3,
                tags: ["vip"],
              }),
              orderEdge({
                id: "gid://shopify/Order/1002",
                name: "#1002",
                totalPrice: "45.00",
                customerName: "Dog Lover",
                fulfillmentStatus: "UNFULFILLED",
                financialStatus: "PAID",
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await readOrders(admin, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orders).toHaveLength(2);
    expect(result.data.orders[0]).toEqual({
      orderId: "gid://shopify/Order/1001",
      name: "#1001",
      createdAt: "2026-04-25T10:00:00Z",
      processedAt: "2026-04-25T10:00:00Z",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      customerId: "gid://shopify/Customer/1",
      customerDisplayName: "Cat Lover",
      customerEmail: "cat@cats.com",
      totalPrice: "120.00",
      currencyCode: "USD",
      lineItemsCount: 3,
      tags: ["vip"],
    });
    expect(result.data.orders[1].displayFulfillmentStatus).toBe("UNFULFILLED");
    expect(admin.calls[0].variables).toMatchObject({
      first: 20,
      after: null,
      query: null,
    });
  });

  it("query — passes Shopify order search syntax through verbatim", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orders: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    await readOrders(admin, {
      query: "fulfillment_status:unfulfilled financial_status:paid",
    });

    const vars = admin.calls[0].variables as { query: string };
    expect(vars.query).toBe("fulfillment_status:unfulfilled financial_status:paid");
  });

  it("respects custom limit", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orders: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    await readOrders(admin, { limit: 5 });
    expect(admin.calls[0].variables).toMatchObject({ first: 5 });
  });

  it("rejects limit > 50", async () => {
    const admin = fakeAdmin([]);
    const result = await readOrders(admin, { limit: 100 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects limit < 1", async () => {
    const admin = fakeAdmin([]);
    const result = await readOrders(admin, { limit: 0 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("preserves pageInfo for pagination follow-ups", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orders: {
            edges: [orderEdge({ id: "gid://shopify/Order/1001", name: "#1001" })],
            pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
          },
        },
      },
    ]);
    const result = await readOrders(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: "cursor-abc",
    });
  });

  it("empty result — returns empty array, no error", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orders: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readOrders(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orders).toHaveLength(0);
  });

  it("handles guest orders (customer null)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orders: {
            edges: [
              orderEdge({
                id: "gid://shopify/Order/1099",
                name: "#1099",
                customerName: null, // guest checkout
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readOrders(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orders[0]).toMatchObject({
      customerId: null,
      customerDisplayName: null,
      customerEmail: null,
    });
  });

  it("query is sent as null when not provided (not omitted)", async () => {
    // Verifies the GraphQL variable is explicitly null (matches Shopify's
    // expectation for optional connection filters).
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orders: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    await readOrders(admin, {});
    const vars = admin.calls[0].variables as { query: string | null };
    expect(vars.query).toBeNull();
  });
});
