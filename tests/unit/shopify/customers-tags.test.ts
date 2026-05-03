import { describe, expect, it } from "vitest";

import { updateCustomerTags } from "../../../app/lib/shopify/customers.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function detailNode(tags: string[]) {
  return {
    id: "gid://shopify/Customer/1",
    firstName: "Cat",
    lastName: "Lover",
    displayName: "Cat Lover",
    email: "cat@cats.com",
    phone: null,
    state: "ENABLED",
    tags,
    note: null,
    numberOfOrders: 5,
    amountSpent: { amount: "100.00", currencyCode: "USD" },
    emailMarketingConsent: null,
    smsMarketingConsent: null,
    defaultAddress: null,
    lastOrder: null,
    orders: { edges: [] },
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-05-03T10:00:00Z",
  };
}

describe("updateCustomerTags", () => {
  it("happy path — sends FULL replacement tag list (not delta)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerUpdate: {
            customer: { id: "gid://shopify/Customer/1" },
            userErrors: [],
          },
        },
      },
      {
        kind: "data",
        body: {
          customer: detailNode(["repeat", "loyal", "wholesale"]),
        },
      },
    ]);

    // Caller passes the FULL merged list (manager prompt teaches this
    // workflow: read existing tags first, append/remove, pass full list).
    const result = await updateCustomerTags(admin, {
      customerId: "gid://shopify/Customer/1",
      tags: ["repeat", "loyal", "wholesale"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tags).toEqual(["repeat", "loyal", "wholesale"]);
    // Mutation input is REPLACEMENT — Shopify stores exactly this list.
    expect(admin.calls[0].variables).toEqual({
      input: {
        id: "gid://shopify/Customer/1",
        tags: ["repeat", "loyal", "wholesale"],
      },
    });
  });

  it("empty tag list — clears all tags (rare but supported)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerUpdate: {
            customer: { id: "gid://shopify/Customer/1" },
            userErrors: [],
          },
        },
      },
      {
        kind: "data",
        body: { customer: detailNode([]) },
      },
    ]);
    const result = await updateCustomerTags(admin, {
      customerId: "gid://shopify/Customer/1",
      tags: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tags).toEqual([]);
    expect(admin.calls[0].variables).toEqual({
      input: { id: "gid://shopify/Customer/1", tags: [] },
    });
  });

  it("rejects empty customerId", async () => {
    const admin = fakeAdmin([]);
    const result = await updateCustomerTags(admin, {
      customerId: "",
      tags: ["vip"],
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects when tags is not an array", async () => {
    const admin = fakeAdmin([]);
    const result = await updateCustomerTags(admin, {
      customerId: "gid://shopify/Customer/1",
      tags: "vip" as unknown as string[],
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects > 250 tags (Zod max)", async () => {
    const admin = fakeAdmin([]);
    const tooMany = Array.from({ length: 251 }, (_, i) => `tag-${i}`);
    const result = await updateCustomerTags(admin, {
      customerId: "gid://shopify/Customer/1",
      tags: tooMany,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerUpdate: {
            customer: null,
            userErrors: [
              { field: ["input", "tags"], message: "Tag is too long" },
            ],
          },
        },
      },
    ]);
    const result = await updateCustomerTags(admin, {
      customerId: "gid://shopify/Customer/1",
      tags: ["x".repeat(250)],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Tag is too long");
  });
});
