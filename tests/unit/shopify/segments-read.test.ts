import { describe, expect, it } from "vitest";

import { readSegments } from "../../../app/lib/shopify/segments.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function segmentEdge(opts: {
  id: string;
  name: string;
  query?: string;
}) {
  return {
    cursor: `c-${opts.id}`,
    node: {
      id: opts.id,
      name: opts.name,
      query: opts.query ?? "customer_tags CONTAINS 'vip'",
      creationDate: "2026-04-01T00:00:00Z",
      lastEditDate: "2026-05-01T00:00:00Z",
    },
  };
}

describe("readSegments", () => {
  it("happy path — lists segments with default limit", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          segments: {
            edges: [
              segmentEdge({
                id: "gid://shopify/Segment/1",
                name: "VIP Customers",
                query: "customer_tags CONTAINS 'vip'",
              }),
              segmentEdge({
                id: "gid://shopify/Segment/2",
                name: "Repeat Buyers",
                query: "number_of_orders >= 3",
              }),
              segmentEdge({
                id: "gid://shopify/Segment/3",
                name: "At-Risk",
                query: "last_order_date < '90_days_ago'",
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await readSegments(admin, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.segments).toHaveLength(3);
    expect(result.data.segments[0]).toEqual({
      segmentId: "gid://shopify/Segment/1",
      name: "VIP Customers",
      query: "customer_tags CONTAINS 'vip'",
      creationDate: "2026-04-01T00:00:00Z",
      lastEditDate: "2026-05-01T00:00:00Z",
    });
    expect(admin.calls[0].variables).toMatchObject({
      first: 20,
      after: null,
      query: null,
    });
  });

  it("query — passes the merchant's search term through verbatim", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          segments: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    await readSegments(admin, { query: "VIP" });

    const vars = admin.calls[0].variables as { query: string };
    expect(vars.query).toBe("VIP");
  });

  it("respects custom limit", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          segments: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    await readSegments(admin, { limit: 5 });
    expect(admin.calls[0].variables).toMatchObject({ first: 5 });
  });

  it("rejects limit > 50", async () => {
    const admin = fakeAdmin([]);
    const result = await readSegments(admin, { limit: 100 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects limit < 1", async () => {
    const admin = fakeAdmin([]);
    const result = await readSegments(admin, { limit: 0 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("preserves pageInfo for pagination follow-ups", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          segments: {
            edges: [
              segmentEdge({ id: "gid://shopify/Segment/1", name: "VIP" }),
            ],
            pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
          },
        },
      },
    ]);
    const result = await readSegments(admin, {});
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
          segments: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readSegments(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.segments).toHaveLength(0);
  });
});
