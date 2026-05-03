import { describe, expect, it } from "vitest";

import { readCustomers } from "../../../app/lib/shopify/customers.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function customerEdge(opts: {
  id: string;
  displayName: string;
  email?: string | null;
  numberOfOrders?: number | string;
  amountSpent?: string;
  tags?: string[];
  state?: string;
}) {
  return {
    cursor: `c-${opts.id}`,
    node: {
      id: opts.id,
      displayName: opts.displayName,
      email: opts.email ?? null,
      phone: null,
      state: opts.state ?? "ENABLED",
      // Shopify returns UnsignedInt64 as string; we test both shapes.
      numberOfOrders: opts.numberOfOrders ?? 0,
      amountSpent: { amount: opts.amountSpent ?? "0.00", currencyCode: "USD" },
      tags: opts.tags ?? [],
      createdAt: "2026-04-01T00:00:00Z",
    },
  };
}

describe("readCustomers", () => {
  it("happy path — lists customers with default limit", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customers: {
            edges: [
              customerEdge({
                id: "gid://shopify/Customer/1",
                displayName: "Cat Lover",
                email: "cat@cats.com",
                numberOfOrders: "12",
                amountSpent: "1200.00",
                tags: ["repeat", "loyal"],
              }),
              customerEdge({
                id: "gid://shopify/Customer/2",
                displayName: "Dog Lover",
                email: "dog@dogs.com",
                numberOfOrders: 3,
                amountSpent: "150.00",
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await readCustomers(admin, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.customers).toHaveLength(2);
    expect(result.data.customers[0]).toMatchObject({
      customerId: "gid://shopify/Customer/1",
      displayName: "Cat Lover",
      email: "cat@cats.com",
      numberOfOrders: 12, // string coerced to number
      amountSpent: "1200.00",
      currencyCode: "USD",
      tags: ["repeat", "loyal"],
      state: "ENABLED",
    });
    expect(result.data.customers[1].numberOfOrders).toBe(3); // raw number passes through
    expect(admin.calls[0].variables).toMatchObject({
      first: 20,
      after: null,
      query: null,
    });
  });

  it("query — passes Shopify customer search syntax through verbatim", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customers: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    await readCustomers(admin, { query: "tag:vip total_spent:>500" });

    const vars = admin.calls[0].variables as { query: string };
    expect(vars.query).toBe("tag:vip total_spent:>500");
  });

  it("respects custom limit", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customers: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    await readCustomers(admin, { limit: 5 });
    expect(admin.calls[0].variables).toMatchObject({ first: 5 });
  });

  it("rejects limit > 50", async () => {
    const admin = fakeAdmin([]);
    const result = await readCustomers(admin, { limit: 100 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects limit < 1", async () => {
    const admin = fakeAdmin([]);
    const result = await readCustomers(admin, { limit: 0 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("preserves pageInfo for pagination follow-ups", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customers: {
            edges: [
              customerEdge({ id: "gid://shopify/Customer/1", displayName: "A" }),
            ],
            pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
          },
        },
      },
    ]);
    const result = await readCustomers(admin, {});
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
          customers: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readCustomers(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.customers).toHaveLength(0);
  });

  it("handles customers with missing optional fields (email/phone null)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customers: {
            edges: [
              {
                cursor: "c1",
                node: {
                  id: "gid://shopify/Customer/1",
                  displayName: "Anonymous",
                  email: null,
                  phone: null,
                  state: "DISABLED",
                  numberOfOrders: 0,
                  amountSpent: { amount: "0.00", currencyCode: "USD" },
                  tags: [],
                  createdAt: "2026-04-01T00:00:00Z",
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readCustomers(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.customers[0]).toMatchObject({
      email: null,
      phone: null,
      state: "DISABLED",
      numberOfOrders: 0,
    });
  });
});
