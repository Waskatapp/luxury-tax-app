import { describe, expect, it } from "vitest";

import { readSegmentMembers } from "../../../app/lib/shopify/segments.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function memberEdge(opts: {
  id: string;
  displayName: string;
  email?: string | null;
  numberOfOrders?: number | string;
  amountSpent?: string;
}) {
  return {
    cursor: `c-${opts.id}`,
    node: {
      id: opts.id,
      displayName: opts.displayName,
      defaultEmailAddress:
        opts.email !== null && opts.email !== undefined
          ? { emailAddress: opts.email }
          : null,
      numberOfOrders: opts.numberOfOrders ?? 0,
      amountSpent: { amount: opts.amountSpent ?? "0.00", currencyCode: "USD" },
    },
  };
}

describe("readSegmentMembers", () => {
  it("happy path — lists members for the given segment", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerSegmentMembers: {
            edges: [
              memberEdge({
                id: "gid://shopify/Customer/1",
                displayName: "Cat Lover",
                email: "cat@cats.com",
                numberOfOrders: "12",
                amountSpent: "1200.00",
              }),
              memberEdge({
                id: "gid://shopify/Customer/2",
                displayName: "Dog Lover",
                email: "dog@dogs.com",
                numberOfOrders: 8,
                amountSpent: "800.00",
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await readSegmentMembers(admin, {
      segmentId: "gid://shopify/Segment/1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.segmentId).toBe("gid://shopify/Segment/1");
    expect(result.data.members).toHaveLength(2);
    expect(result.data.members[0]).toEqual({
      customerId: "gid://shopify/Customer/1",
      displayName: "Cat Lover",
      email: "cat@cats.com",
      numberOfOrders: 12, // string coerced to number
      amountSpent: "1200.00",
      currencyCode: "USD",
    });
    expect(admin.calls[0].variables).toEqual({
      segmentId: "gid://shopify/Segment/1",
      first: 20,
    });
  });

  it("respects custom limit", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerSegmentMembers: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    await readSegmentMembers(admin, {
      segmentId: "gid://shopify/Segment/1",
      limit: 5,
    });
    expect(admin.calls[0].variables).toMatchObject({ first: 5 });
  });

  it("rejects empty segmentId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await readSegmentMembers(admin, { segmentId: "" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects missing segmentId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await readSegmentMembers(admin, {});
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects limit > 50", async () => {
    const admin = fakeAdmin([]);
    const result = await readSegmentMembers(admin, {
      segmentId: "gid://shopify/Segment/1",
      limit: 100,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("preserves pageInfo for pagination follow-ups", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerSegmentMembers: {
            edges: [
              memberEdge({ id: "gid://shopify/Customer/1", displayName: "A" }),
            ],
            pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
          },
        },
      },
    ]);
    const result = await readSegmentMembers(admin, {
      segmentId: "gid://shopify/Segment/1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: "cursor-abc",
    });
  });

  it("empty result — returns empty members array, no error", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerSegmentMembers: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readSegmentMembers(admin, {
      segmentId: "gid://shopify/Segment/1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.members).toHaveLength(0);
    expect(result.data.segmentId).toBe("gid://shopify/Segment/1");
  });

  it("handles members with no email (defaultEmailAddress null)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerSegmentMembers: {
            edges: [
              memberEdge({
                id: "gid://shopify/Customer/1",
                displayName: "Anonymous",
                email: null,
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readSegmentMembers(admin, {
      segmentId: "gid://shopify/Segment/1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.members[0].email).toBeNull();
  });
});
