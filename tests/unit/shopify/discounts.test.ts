import { describe, expect, it } from "vitest";

import { createDiscount } from "../../../app/lib/shopify/discounts.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("createDiscount", () => {
  it("happy path — creates a 20% off automatic discount", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticBasicCreate: {
            automaticDiscountNode: {
              id: "gid://shopify/DiscountAutomaticNode/123",
              automaticDiscount: {
                title: "Spring Sale",
                startsAt: "2026-05-01T00:00:00Z",
                endsAt: "2026-05-08T00:00:00Z",
                status: "ACTIVE",
                customerGets: { value: { percentage: 0.2 } },
              },
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await createDiscount(admin, {
      title: "Spring Sale",
      percentOff: 20,
      startsAt: "2026-05-01T00:00:00Z",
      endsAt: "2026-05-08T00:00:00Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      id: "gid://shopify/DiscountAutomaticNode/123",
      title: "Spring Sale",
      percentOff: 20,
      startsAt: "2026-05-01T00:00:00Z",
      endsAt: "2026-05-08T00:00:00Z",
      status: "ACTIVE",
    });

    // Critical: payload must NOT include customerSelection or minimumRequirement
    // (those are invalid on DiscountAutomaticBasicInput; they were the cause
    // of the "doesn't support customer selection criteria" error in Phase 5).
    const variables = admin.calls[0].variables as { automaticBasicDiscount: Record<string, unknown> };
    const sent = variables.automaticBasicDiscount;
    expect(sent).not.toHaveProperty("customerSelection");
    expect(sent).not.toHaveProperty("minimumRequirement");
    expect(sent.customerGets).toEqual({
      value: { percentage: 0.2 },
      items: { all: true },
    });
  });

  it("converts percentOff (1-100) to Shopify's 0-1 decimal", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticBasicCreate: {
            automaticDiscountNode: {
              id: "gid://shopify/DiscountAutomaticNode/1",
              automaticDiscount: {
                title: "Half Off",
                startsAt: "2026-05-01T00:00:00Z",
                customerGets: { value: { percentage: 0.5 } },
              },
            },
            userErrors: [],
          },
        },
      },
    ]);

    await createDiscount(admin, {
      title: "Half Off",
      percentOff: 50,
      startsAt: "2026-05-01T00:00:00Z",
    });

    const variables = admin.calls[0].variables as { automaticBasicDiscount: { customerGets: { value: { percentage: number } } } };
    expect(variables.automaticBasicDiscount.customerGets.value.percentage).toBe(0.5);
  });

  it("rejects percentOff outside 1-100", async () => {
    const admin = fakeAdmin([]);
    const tooLow = await createDiscount(admin, {
      title: "Bad",
      percentOff: 0,
      startsAt: "2026-05-01T00:00:00Z",
    });
    expect(tooLow.ok).toBe(false);

    const tooHigh = await createDiscount(admin, {
      title: "Bad",
      percentOff: 101,
      startsAt: "2026-05-01T00:00:00Z",
    });
    expect(tooHigh.ok).toBe(false);

    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors as ok:false", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticBasicCreate: {
            automaticDiscountNode: null,
            userErrors: [
              { field: ["automaticBasicDiscount", "endsAt"], message: "endsAt must be after startsAt" },
            ],
          },
        },
      },
    ]);
    const result = await createDiscount(admin, {
      title: "Backwards",
      percentOff: 10,
      startsAt: "2026-05-08T00:00:00Z",
      endsAt: "2026-05-01T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("endsAt must be after startsAt");
  });

  it("omits endsAt from the mutation when not provided", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticBasicCreate: {
            automaticDiscountNode: {
              id: "gid://shopify/DiscountAutomaticNode/2",
              automaticDiscount: { title: "Ongoing", startsAt: "2026-05-01T00:00:00Z" },
            },
            userErrors: [],
          },
        },
      },
    ]);

    await createDiscount(admin, {
      title: "Ongoing",
      percentOff: 10,
      startsAt: "2026-05-01T00:00:00Z",
    });

    const variables = admin.calls[0].variables as { automaticBasicDiscount: Record<string, unknown> };
    expect(variables.automaticBasicDiscount).not.toHaveProperty("endsAt");
  });
});
