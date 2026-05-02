import { describe, expect, it } from "vitest";

import {
  fetchDiscount,
  updateDiscount,
} from "../../../app/lib/shopify/discounts.server";
import { fakeAdmin } from "../../helpers/fake-admin";

const basicSnapshotResponse = {
  kind: "data" as const,
  body: {
    automaticDiscountNode: {
      id: "gid://shopify/DiscountAutomaticNode/1",
      automaticDiscount: {
        __typename: "DiscountAutomaticBasic",
        title: "Holiday Sale",
        status: "ACTIVE",
        startsAt: "2026-12-01T00:00:00Z",
        endsAt: "2026-12-26T00:00:00Z",
        summary: "10% off all products",
        customerGets: { value: { percentage: 0.1 } },
      },
    },
  },
};

describe("updateDiscount", () => {
  it("happy path — updates title + endsAt and returns merged snapshot", async () => {
    const admin = fakeAdmin([
      // 1. fetchDiscount call (verifies type)
      basicSnapshotResponse,
      // 2. update mutation
      {
        kind: "data",
        body: {
          discountAutomaticBasicUpdate: {
            automaticDiscountNode: {
              id: "gid://shopify/DiscountAutomaticNode/1",
              automaticDiscount: {
                title: "Holiday Sale Extended",
                status: "ACTIVE",
                startsAt: "2026-12-01T00:00:00Z",
                endsAt: "2027-01-05T00:00:00Z",
                summary: "10% off all products",
                customerGets: { value: { percentage: 0.1 } },
              },
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateDiscount(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/1",
      title: "Holiday Sale Extended",
      endsAt: "2027-01-05T00:00:00Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.title).toBe("Holiday Sale Extended");
    expect(result.data.endsAt).toBe("2027-01-05T00:00:00Z");
    expect(result.data.percentOff).toBe(10);

    // Mutation payload only contains changed fields (title + endsAt).
    expect(admin.calls[1].variables).toEqual({
      id: "gid://shopify/DiscountAutomaticNode/1",
      automaticBasicDiscount: {
        title: "Holiday Sale Extended",
        endsAt: "2027-01-05T00:00:00Z",
      },
    });
  });

  it("clears endsAt when explicitly passed null", async () => {
    const admin = fakeAdmin([
      basicSnapshotResponse,
      {
        kind: "data",
        body: {
          discountAutomaticBasicUpdate: {
            automaticDiscountNode: {
              id: "gid://shopify/DiscountAutomaticNode/1",
              automaticDiscount: {
                title: "Holiday Sale",
                status: "ACTIVE",
                startsAt: "2026-12-01T00:00:00Z",
                endsAt: null,
                summary: "10% off all products",
                customerGets: { value: { percentage: 0.1 } },
              },
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateDiscount(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/1",
      endsAt: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.endsAt).toBeNull();
    // Mutation explicitly sends endsAt: null (NOT omitted)
    expect(admin.calls[1].variables).toEqual({
      id: "gid://shopify/DiscountAutomaticNode/1",
      automaticBasicDiscount: { endsAt: null },
    });
  });

  it("converts percentOff (1-100) to Shopify decimal in customerGets payload", async () => {
    const admin = fakeAdmin([
      basicSnapshotResponse,
      {
        kind: "data",
        body: {
          discountAutomaticBasicUpdate: {
            automaticDiscountNode: {
              id: "gid://shopify/DiscountAutomaticNode/1",
              automaticDiscount: {
                title: "Holiday Sale",
                status: "ACTIVE",
                startsAt: "2026-12-01T00:00:00Z",
                endsAt: "2026-12-26T00:00:00Z",
                summary: "25% off all products",
                customerGets: { value: { percentage: 0.25 } },
              },
            },
            userErrors: [],
          },
        },
      },
    ]);
    const result = await updateDiscount(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/1",
      percentOff: 25,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.percentOff).toBe(25);
    expect(admin.calls[1].variables).toEqual({
      id: "gid://shopify/DiscountAutomaticNode/1",
      automaticBasicDiscount: {
        customerGets: {
          value: { percentage: 0.25 },
          items: { all: true },
        },
      },
    });
  });

  it("rejects when no fields are set via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await updateDiscount(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/1",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects Bxgy discount type with a clear error", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          automaticDiscountNode: {
            id: "gid://shopify/DiscountAutomaticNode/2",
            automaticDiscount: {
              __typename: "DiscountAutomaticBxgy",
              title: "BOGO Cat Food",
              status: "ACTIVE",
              startsAt: "2026-11-01T00:00:00Z",
              endsAt: null,
              summary: "Buy 2, get 1 free",
            },
          },
        },
      },
    ]);
    const result = await updateDiscount(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/2",
      title: "Renamed",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("automaticBxgy");
    expect(result.error).toContain("create_bundle_discount");
    // No mutation should have fired — only the fetch
    expect(admin.calls).toHaveLength(1);
  });

  it("surfaces userErrors from the update mutation", async () => {
    const admin = fakeAdmin([
      basicSnapshotResponse,
      {
        kind: "data",
        body: {
          discountAutomaticBasicUpdate: {
            automaticDiscountNode: null,
            userErrors: [
              { field: ["startsAt"], message: "Cannot start in the past" },
            ],
          },
        },
      },
    ]);
    const result = await updateDiscount(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/1",
      startsAt: "2020-01-01T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Cannot start in the past");
  });
});

describe("fetchDiscount", () => {
  it("returns snapshot with type='automaticBasic' and percentOff for basic discounts", async () => {
    const admin = fakeAdmin([basicSnapshotResponse]);
    const result = await fetchDiscount(
      admin,
      "gid://shopify/DiscountAutomaticNode/1",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.type).toBe("automaticBasic");
    expect(result.data.percentOff).toBe(10);
    expect(result.data.title).toBe("Holiday Sale");
  });

  it("returns type='automaticBxgy' with null percentOff for bundle discounts", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          automaticDiscountNode: {
            id: "gid://shopify/DiscountAutomaticNode/2",
            automaticDiscount: {
              __typename: "DiscountAutomaticBxgy",
              title: "BOGO",
              status: "ACTIVE",
              startsAt: "2026-11-01T00:00:00Z",
              endsAt: null,
              summary: "Buy 2, get 1 free",
            },
          },
        },
      },
    ]);
    const result = await fetchDiscount(
      admin,
      "gid://shopify/DiscountAutomaticNode/2",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.type).toBe("automaticBxgy");
    expect(result.data.percentOff).toBeNull();
  });

  it("returns ok:false if discount not found", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { automaticDiscountNode: null } },
    ]);
    const result = await fetchDiscount(
      admin,
      "gid://shopify/DiscountAutomaticNode/missing",
    );
    expect(result.ok).toBe(false);
  });
});
