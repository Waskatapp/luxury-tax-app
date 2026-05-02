import { describe, expect, it } from "vitest";

import { setDiscountStatus } from "../../../app/lib/shopify/discounts.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("setDiscountStatus", () => {
  it("ACTIVE → calls discountAutomaticActivate", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticActivate: {
            automaticDiscountNode: {
              id: "gid://shopify/DiscountAutomaticNode/1",
              automaticDiscount: { title: "Holiday Sale", status: "ACTIVE" },
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await setDiscountStatus(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/1",
      status: "ACTIVE",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      id: "gid://shopify/DiscountAutomaticNode/1",
      title: "Holiday Sale",
      newStatus: "ACTIVE",
    });
    expect(admin.calls[0].query).toContain("discountAutomaticActivate");
    expect(admin.calls[0].variables).toEqual({
      id: "gid://shopify/DiscountAutomaticNode/1",
    });
  });

  it("PAUSED → calls discountAutomaticDeactivate", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticDeactivate: {
            automaticDiscountNode: {
              id: "gid://shopify/DiscountAutomaticNode/1",
              automaticDiscount: { title: "Holiday Sale", status: "EXPIRED" },
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await setDiscountStatus(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/1",
      status: "PAUSED",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.newStatus).toBe("EXPIRED");
    expect(admin.calls[0].query).toContain("discountAutomaticDeactivate");
  });

  it("rejects invalid status via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await setDiscountStatus(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/1",
      status: "ARCHIVED",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty discountId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await setDiscountStatus(admin, {
      discountId: "",
      status: "ACTIVE",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces userErrors from activate path", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticActivate: {
            automaticDiscountNode: null,
            userErrors: [
              { field: ["id"], message: "Discount has expired and cannot be reactivated" },
            ],
          },
        },
      },
    ]);
    const result = await setDiscountStatus(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/1",
      status: "ACTIVE",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Discount has expired");
  });

  it("surfaces userErrors from deactivate path", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountAutomaticDeactivate: {
            automaticDiscountNode: null,
            userErrors: [{ field: ["id"], message: "Discount not found" }],
          },
        },
      },
    ]);
    const result = await setDiscountStatus(admin, {
      discountId: "gid://shopify/DiscountAutomaticNode/missing",
      status: "PAUSED",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Discount not found");
  });
});
