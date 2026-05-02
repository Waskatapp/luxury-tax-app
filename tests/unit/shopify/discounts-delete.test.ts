import { describe, expect, it } from "vitest";

import { deleteDiscount } from "../../../app/lib/shopify/discounts.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("deleteDiscount", () => {
  it("happy path — returns the deleted discount id", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticDelete: {
            deletedAutomaticDiscountId: "gid://shopify/DiscountAutomaticNode/1",
            userErrors: [],
          },
        },
      },
    ]);

    const result = await deleteDiscount(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      deletedDiscountId: "gid://shopify/DiscountAutomaticNode/1",
    });
    expect(admin.calls[0].variables).toEqual({
      id: "gid://shopify/DiscountAutomaticNode/1",
    });
  });

  it("rejects empty discountId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await deleteDiscount(admin, { discountId: "" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticDelete: {
            deletedAutomaticDiscountId: null,
            userErrors: [{ field: ["id"], message: "Discount not found" }],
          },
        },
      },
    ]);
    const result = await deleteDiscount(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/missing",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Discount not found");
  });

  it("returns error when no deletedId is returned (defensive)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticDelete: {
            deletedAutomaticDiscountId: null,
            userErrors: [],
          },
        },
      },
    ]);
    const result = await deleteDiscount(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("deletedAutomaticDiscountId");
  });
});
