import { describe, expect, it } from "vitest";

import { createBundleDiscount } from "../../../app/lib/shopify/discounts.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// A canned successful Bxgy create response. Reused across happy-path tests.
function bxgySuccessResponse(overrides?: Partial<{
  title: string;
  status: string;
  startsAt: string;
  endsAt: string | null;
  summary: string;
  usesPerOrderLimit: number | null;
}>) {
  return {
    kind: "data" as const,
    body: {
      discountAutomaticBxgyCreate: {
        automaticDiscountNode: {
          id: "gid://shopify/DiscountAutomaticNode/bundle-1",
          automaticDiscount: {
            title: overrides?.title ?? "Cat Food + Treat Bundle",
            startsAt: overrides?.startsAt ?? "2026-11-01T00:00:00Z",
            endsAt: overrides?.endsAt ?? null,
            status: overrides?.status ?? "ACTIVE",
            summary:
              overrides?.summary ??
              "Buy 2 of Cat Food bags, get 1 of Cat Treats 50% off",
            usesPerOrderLimit: overrides?.usesPerOrderLimit ?? null,
          },
        },
        userErrors: [],
      },
    },
  };
}

describe("createBundleDiscount — happy paths", () => {
  it("percentage discount on products — full input, mapping is correct", async () => {
    const admin = fakeAdmin([bxgySuccessResponse()]);

    const result = await createBundleDiscount(admin, {
      title: "Cat Food + Treat Bundle",
      startsAt: "2026-11-01T00:00:00Z",
      endsAt: "2026-12-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/cat-food"],
      buyQuantity: 2,
      getType: "products",
      getItemIds: ["gid://shopify/Product/cat-treat"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 50,
      usesPerOrderLimit: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.id).toBe("gid://shopify/DiscountAutomaticNode/bundle-1");
    expect(result.data.summary).toContain("Cat Food");
    expect(result.data.status).toBe("ACTIVE");

    // The mapping check — the highest-value assertion in this file.
    // Verifies the flat input shape lands as the exact nested shape
    // Shopify's DiscountAutomaticBxgyInput expects.
    expect(admin.calls[0].variables).toEqual({
      automaticBxgyDiscount: {
        title: "Cat Food + Treat Bundle",
        startsAt: "2026-11-01T00:00:00Z",
        endsAt: "2026-12-01T00:00:00Z",
        customerBuys: {
          items: { products: { productsToAdd: ["gid://shopify/Product/cat-food"] } },
          value: { quantity: "2" },
        },
        customerGets: {
          items: { products: { productsToAdd: ["gid://shopify/Product/cat-treat"] } },
          value: {
            discountOnQuantity: {
              quantity: "1",
              effect: { percentage: 0.5 },
            },
          },
        },
        usesPerOrderLimit: "1",
      },
    });
  });

  it("percentage discount on collections — items use { collections: { add } }", async () => {
    const admin = fakeAdmin([
      bxgySuccessResponse({
        title: "Holiday bundle",
        summary: "Buy 3 from Holiday, get 1 from Holiday 25% off",
      }),
    ]);

    const result = await createBundleDiscount(admin, {
      title: "Holiday bundle",
      startsAt: "2026-12-01T00:00:00Z",
      buyType: "collections",
      buyItemIds: ["gid://shopify/Collection/holiday-2026"],
      buyQuantity: 3,
      getType: "collections",
      getItemIds: ["gid://shopify/Collection/holiday-2026"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 25,
    });

    expect(result.ok).toBe(true);
    const vars = admin.calls[0].variables as {
      automaticBxgyDiscount: {
        customerBuys: { items: unknown };
        customerGets: { items: unknown };
      };
    };
    expect(vars.automaticBxgyDiscount.customerBuys.items).toEqual({
      collections: { add: ["gid://shopify/Collection/holiday-2026"] },
    });
    expect(vars.automaticBxgyDiscount.customerGets.items).toEqual({
      collections: { add: ["gid://shopify/Collection/holiday-2026"] },
    });
  });

  it("BOGO — discountValue=100 produces effect.percentage=1 (100% off)", async () => {
    const admin = fakeAdmin([
      bxgySuccessResponse({
        title: "BOGO Cat Food",
        summary: "Buy 1, get 1 free",
      }),
    ]);

    const result = await createBundleDiscount(admin, {
      title: "BOGO Cat Food",
      startsAt: "2026-12-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/cat-food"],
      buyQuantity: 1,
      getType: "products",
      getItemIds: ["gid://shopify/Product/cat-food"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 100,
    });

    expect(result.ok).toBe(true);
    const vars = admin.calls[0].variables as {
      automaticBxgyDiscount: {
        customerGets: {
          value: { discountOnQuantity: { effect: { percentage: number } } };
        };
      };
    };
    expect(
      vars.automaticBxgyDiscount.customerGets.value.discountOnQuantity.effect
        .percentage,
    ).toBe(1);
  });

  it("fixed_amount discount — uses effect.amount as 2-decimal string", async () => {
    const admin = fakeAdmin([
      bxgySuccessResponse({ summary: "Buy 2, get 1 at $5 off" }),
    ]);

    const result = await createBundleDiscount(admin, {
      title: "Five Off",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/cat-food"],
      buyQuantity: 2,
      getType: "products",
      getItemIds: ["gid://shopify/Product/cat-treat"],
      getQuantity: 1,
      discountType: "fixed_amount",
      discountValue: 5.0,
    });

    expect(result.ok).toBe(true);
    const vars = admin.calls[0].variables as {
      automaticBxgyDiscount: {
        customerGets: {
          value: { discountOnQuantity: { effect: { amount: string } } };
        };
      };
    };
    expect(
      vars.automaticBxgyDiscount.customerGets.value.discountOnQuantity.effect
        .amount,
    ).toBe("5.00");
  });

  it("fixed_amount with cents — preserves precision via toFixed(2)", async () => {
    const admin = fakeAdmin([bxgySuccessResponse()]);

    await createBundleDiscount(admin, {
      title: "Test",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/1"],
      buyQuantity: 1,
      getType: "products",
      getItemIds: ["gid://shopify/Product/2"],
      getQuantity: 1,
      discountType: "fixed_amount",
      discountValue: 2.5,
    });

    const vars = admin.calls[0].variables as {
      automaticBxgyDiscount: {
        customerGets: {
          value: { discountOnQuantity: { effect: { amount: string } } };
        };
      };
    };
    expect(
      vars.automaticBxgyDiscount.customerGets.value.discountOnQuantity.effect
        .amount,
    ).toBe("2.50");
  });

  it("omits endsAt and usesPerOrderLimit when not provided", async () => {
    const admin = fakeAdmin([bxgySuccessResponse()]);

    await createBundleDiscount(admin, {
      title: "Minimal bundle",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/1"],
      buyQuantity: 1,
      getType: "products",
      getItemIds: ["gid://shopify/Product/2"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 25,
    });

    const vars = admin.calls[0].variables as {
      automaticBxgyDiscount: Record<string, unknown>;
    };
    expect("endsAt" in vars.automaticBxgyDiscount).toBe(false);
    expect("usesPerOrderLimit" in vars.automaticBxgyDiscount).toBe(false);
  });

  it("buy and get can target different scope types (products vs collections)", async () => {
    const admin = fakeAdmin([bxgySuccessResponse()]);

    await createBundleDiscount(admin, {
      title: "Cross-type bundle",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "collections",
      buyItemIds: ["gid://shopify/Collection/sale"],
      buyQuantity: 2,
      getType: "products",
      getItemIds: ["gid://shopify/Product/free-gift"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 100,
    });

    const vars = admin.calls[0].variables as {
      automaticBxgyDiscount: {
        customerBuys: { items: unknown };
        customerGets: { items: unknown };
      };
    };
    expect(vars.automaticBxgyDiscount.customerBuys.items).toEqual({
      collections: { add: ["gid://shopify/Collection/sale"] },
    });
    expect(vars.automaticBxgyDiscount.customerGets.items).toEqual({
      products: { productsToAdd: ["gid://shopify/Product/free-gift"] },
    });
  });

  it("response: surfaces the Shopify-rendered summary verbatim", async () => {
    const admin = fakeAdmin([
      bxgySuccessResponse({
        summary: "Buy 2 Cat Food bags, get 1 Cat Treats free",
      }),
    ]);

    const result = await createBundleDiscount(admin, {
      title: "Cat bundle",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/cat-food"],
      buyQuantity: 2,
      getType: "products",
      getItemIds: ["gid://shopify/Product/cat-treat"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 100,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.summary).toBe(
      "Buy 2 Cat Food bags, get 1 Cat Treats free",
    );
  });
});

describe("createBundleDiscount — Zod rejections", () => {
  it("rejects empty buyItemIds", async () => {
    const admin = fakeAdmin([]);
    const result = await createBundleDiscount(admin, {
      title: "Test",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: [],
      buyQuantity: 1,
      getType: "products",
      getItemIds: ["gid://shopify/Product/2"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 50,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty getItemIds", async () => {
    const admin = fakeAdmin([]);
    const result = await createBundleDiscount(admin, {
      title: "Test",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/1"],
      buyQuantity: 1,
      getType: "products",
      getItemIds: [],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 50,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects buyQuantity < 1", async () => {
    const admin = fakeAdmin([]);
    const result = await createBundleDiscount(admin, {
      title: "Test",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/1"],
      buyQuantity: 0,
      getType: "products",
      getItemIds: ["gid://shopify/Product/2"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 50,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects percentage discountValue > 100", async () => {
    const admin = fakeAdmin([]);
    const result = await createBundleDiscount(admin, {
      title: "Test",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/1"],
      buyQuantity: 1,
      getType: "products",
      getItemIds: ["gid://shopify/Product/2"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 150,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects percentage discountValue < 1", async () => {
    const admin = fakeAdmin([]);
    const result = await createBundleDiscount(admin, {
      title: "Test",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/1"],
      buyQuantity: 1,
      getType: "products",
      getItemIds: ["gid://shopify/Product/2"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 0.5,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects discountValue <= 0 (positive guard)", async () => {
    const admin = fakeAdmin([]);
    const result = await createBundleDiscount(admin, {
      title: "Test",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/1"],
      buyQuantity: 1,
      getType: "products",
      getItemIds: ["gid://shopify/Product/2"],
      getQuantity: 1,
      discountType: "fixed_amount",
      discountValue: 0,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects endsAt <= startsAt", async () => {
    const admin = fakeAdmin([]);
    const result = await createBundleDiscount(admin, {
      title: "Test",
      startsAt: "2026-12-01T00:00:00Z",
      endsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/1"],
      buyQuantity: 1,
      getType: "products",
      getItemIds: ["gid://shopify/Product/2"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 50,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects invalid enum values", async () => {
    const admin = fakeAdmin([]);
    const result = await createBundleDiscount(admin, {
      title: "Test",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "variants", // invalid
      buyItemIds: ["gid://shopify/Product/1"],
      buyQuantity: 1,
      getType: "products",
      getItemIds: ["gid://shopify/Product/2"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 50,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });
});

describe("createBundleDiscount — error surfacing", () => {
  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticBxgyCreate: {
            automaticDiscountNode: null,
            userErrors: [
              {
                field: ["customerBuys", "items"],
                message: "At least one item must be specified",
                code: "INVALID",
              },
            ],
          },
        },
      },
    ]);
    const result = await createBundleDiscount(admin, {
      title: "Test",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/missing"],
      buyQuantity: 1,
      getType: "products",
      getItemIds: ["gid://shopify/Product/2"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 50,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("At least one item");
  });

  it("returns error when Shopify returns no automaticDiscountNode (defensive)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticBxgyCreate: {
            automaticDiscountNode: null,
            userErrors: [],
          },
        },
      },
    ]);
    const result = await createBundleDiscount(admin, {
      title: "Test",
      startsAt: "2026-11-01T00:00:00Z",
      buyType: "products",
      buyItemIds: ["gid://shopify/Product/1"],
      buyQuantity: 1,
      getType: "products",
      getItemIds: ["gid://shopify/Product/2"],
      getQuantity: 1,
      discountType: "percentage",
      discountValue: 50,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("automaticDiscountNode");
  });
});
