import { describe, expect, it } from "vitest";

import { updateOrderTags } from "../../../app/lib/shopify/orders.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function detailNode(tags: string[]) {
  return {
    id: "gid://shopify/Order/1001",
    name: "#1001",
    createdAt: "2026-04-25T10:00:00Z",
    processedAt: "2026-04-25T10:00:00Z",
    cancelledAt: null,
    closedAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    sourceName: "web",
    tags,
    note: null,
    updatedAt: "2026-05-03T10:00:00Z",
    customer: null,
    lineItems: { edges: [] },
    subtotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
    totalShippingPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    totalTaxSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
    totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    shippingAddress: null,
    fulfillments: [],
    refunds: [],
  };
}

describe("updateOrderTags", () => {
  it("happy path — sends FULL replacement tag list (not delta)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orderUpdate: {
            order: { id: "gid://shopify/Order/1001" },
            userErrors: [],
          },
        },
      },
      {
        kind: "data",
        body: { order: detailNode(["express", "vip", "gift-wrap"]) },
      },
    ]);

    // Caller passes the FULL merged list — manager prompt teaches this
    // workflow: read first, append, propose with full list.
    const result = await updateOrderTags(admin, {
      orderId: "gid://shopify/Order/1001",
      tags: ["express", "vip", "gift-wrap"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tags).toEqual(["express", "vip", "gift-wrap"]);
    // Mutation input is REPLACEMENT — Shopify stores exactly this list.
    expect(admin.calls[0].variables).toEqual({
      input: {
        id: "gid://shopify/Order/1001",
        tags: ["express", "vip", "gift-wrap"],
      },
    });
  });

  it("empty tag list — clears all tags", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orderUpdate: {
            order: { id: "gid://shopify/Order/1001" },
            userErrors: [],
          },
        },
      },
      {
        kind: "data",
        body: { order: detailNode([]) },
      },
    ]);
    const result = await updateOrderTags(admin, {
      orderId: "gid://shopify/Order/1001",
      tags: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tags).toEqual([]);
    expect(admin.calls[0].variables).toEqual({
      input: { id: "gid://shopify/Order/1001", tags: [] },
    });
  });

  it("rejects empty orderId", async () => {
    const admin = fakeAdmin([]);
    const result = await updateOrderTags(admin, {
      orderId: "",
      tags: ["vip"],
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects when tags is not an array", async () => {
    const admin = fakeAdmin([]);
    const result = await updateOrderTags(admin, {
      orderId: "gid://shopify/Order/1001",
      tags: "vip" as unknown as string[],
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects > 250 tags (Zod max)", async () => {
    const admin = fakeAdmin([]);
    const tooMany = Array.from({ length: 251 }, (_, i) => `tag-${i}`);
    const result = await updateOrderTags(admin, {
      orderId: "gid://shopify/Order/1001",
      tags: tooMany,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty tag string in array", async () => {
    const admin = fakeAdmin([]);
    const result = await updateOrderTags(admin, {
      orderId: "gid://shopify/Order/1001",
      tags: ["vip", ""],
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          orderUpdate: {
            order: null,
            userErrors: [
              { field: ["input", "tags"], message: "Tag is too long" },
            ],
          },
        },
      },
    ]);
    const result = await updateOrderTags(admin, {
      orderId: "gid://shopify/Order/1001",
      tags: ["x".repeat(250)],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Tag is too long");
  });
});
