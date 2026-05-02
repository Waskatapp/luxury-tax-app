import { describe, expect, it } from "vitest";

import { readDiscounts } from "../../../app/lib/shopify/discounts.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("readDiscounts", () => {
  it("happy path — returns a normalized list of mixed-type discounts", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountNodes: {
            edges: [
              {
                cursor: "c1",
                node: {
                  id: "gid://shopify/DiscountAutomaticNode/1",
                  discount: {
                    __typename: "DiscountAutomaticBasic",
                    title: "Holiday Sale",
                    status: "ACTIVE",
                    startsAt: "2026-12-01T00:00:00Z",
                    endsAt: "2026-12-26T00:00:00Z",
                    summary: "10% off all products",
                  },
                },
              },
              {
                cursor: "c2",
                node: {
                  id: "gid://shopify/DiscountAutomaticNode/2",
                  discount: {
                    __typename: "DiscountAutomaticBxgy",
                    title: "BOGO Cat Food",
                    status: "ACTIVE",
                    startsAt: "2026-11-01T00:00:00Z",
                    endsAt: null,
                    summary: "Buy 2 Cat Food, get 1 free",
                  },
                },
              },
              {
                cursor: "c3",
                node: {
                  id: "gid://shopify/DiscountCodeNode/3",
                  discount: {
                    __typename: "DiscountCodeBasic",
                    title: "SUMMER20",
                    status: "EXPIRED",
                    startsAt: "2026-06-01T00:00:00Z",
                    endsAt: "2026-08-31T00:00:00Z",
                    summary: "20% off with code SUMMER20",
                    codes: { edges: [{ node: { code: "SUMMER20" } }] },
                    asyncUsageCount: 47,
                  },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: "c3" },
          },
        },
      },
    ]);

    const result = await readDiscounts(admin, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.discounts).toHaveLength(3);

    expect(result.data.discounts[0]).toEqual({
      id: "gid://shopify/DiscountAutomaticNode/1",
      title: "Holiday Sale",
      type: "automaticBasic",
      status: "ACTIVE",
      startsAt: "2026-12-01T00:00:00Z",
      endsAt: "2026-12-26T00:00:00Z",
      summary: "10% off all products",
      code: null,
      usageCount: null,
    });

    expect(result.data.discounts[1].type).toBe("automaticBxgy");
    expect(result.data.discounts[1].endsAt).toBeNull();

    expect(result.data.discounts[2]).toEqual({
      id: "gid://shopify/DiscountCodeNode/3",
      title: "SUMMER20",
      type: "codeBasic",
      status: "EXPIRED",
      startsAt: "2026-06-01T00:00:00Z",
      endsAt: "2026-08-31T00:00:00Z",
      summary: "20% off with code SUMMER20",
      code: "SUMMER20",
      usageCount: 47,
    });
  });

  it("respects pagination defaults (first=20, query=null) when input is empty", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountNodes: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readDiscounts(admin, {});
    expect(result.ok).toBe(true);
    expect(admin.calls[0].variables).toEqual({
      first: 20,
      after: null,
      query: null,
    });
  });

  it("forwards query and pagination params", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountNodes: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readDiscounts(admin, {
      first: 10,
      after: "cursor-x",
      query: "status:active",
    });
    expect(result.ok).toBe(true);
    expect(admin.calls[0].variables).toEqual({
      first: 10,
      after: "cursor-x",
      query: "status:active",
    });
  });

  it("rejects first > 50 via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await readDiscounts(admin, { first: 100 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("maps unknown __typename to type='unknown' (forward compatibility)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountNodes: {
            edges: [
              {
                cursor: "c1",
                node: {
                  id: "gid://shopify/DiscountX/1",
                  discount: {
                    __typename: "DiscountFutureNewType",
                    title: "Mystery",
                    status: "ACTIVE",
                    startsAt: "2026-01-01T00:00:00Z",
                    endsAt: null,
                    summary: "?",
                  },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: "c1" },
          },
        },
      },
    ]);
    const result = await readDiscounts(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.discounts[0].type).toBe("unknown");
  });

  it("surfaces top-level shopify graphql errors", async () => {
    const admin = fakeAdmin([
      { kind: "errors", errors: [{ message: "Field 'discountNodes' does not exist" }] },
    ]);
    const result = await readDiscounts(admin, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("discountNodes");
  });
});
