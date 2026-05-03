import { describe, expect, it } from "vitest";

import { updateCustomer } from "../../../app/lib/shopify/customers.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// updateCustomer issues TWO calls: customerUpdate (the mutation) +
// customer (the post-update snapshot fetch). The second response is
// always present in our test fixtures.

function detailNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/Customer/1",
    firstName: "Cat",
    lastName: "Lover",
    displayName: "Cat Lover",
    email: "cat@cats.com",
    phone: "+1-555-0100",
    state: "ENABLED",
    tags: ["repeat"],
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
    ...overrides,
  };
}

describe("updateCustomer", () => {
  it("happy path — sends only the changed fields, returns post-update snapshot", async () => {
    const admin = fakeAdmin([
      // 1. customerUpdate mutation
      {
        kind: "data",
        body: {
          customerUpdate: {
            customer: { id: "gid://shopify/Customer/1" },
            userErrors: [],
          },
        },
      },
      // 2. fetchCustomerDetail re-read for post-update snapshot
      {
        kind: "data",
        body: { customer: detailNode({ phone: "+1-555-0200" }) },
      },
    ]);

    const result = await updateCustomer(admin, {
      customerId: "gid://shopify/Customer/1",
      phone: "+1-555-0200",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.phone).toBe("+1-555-0200");
    expect(admin.calls).toHaveLength(2);
    // Mutation input only carries id + the changed field.
    expect(admin.calls[0].variables).toEqual({
      input: {
        id: "gid://shopify/Customer/1",
        phone: "+1-555-0200",
      },
    });
  });

  it("multi-field update — all provided fields included in mutation input", async () => {
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
          customer: detailNode({
            firstName: "Catherine",
            email: "catherine@cats.com",
            note: "Updated note",
          }),
        },
      },
    ]);

    await updateCustomer(admin, {
      customerId: "gid://shopify/Customer/1",
      firstName: "Catherine",
      email: "catherine@cats.com",
      note: "Updated note",
    });

    expect(admin.calls[0].variables).toEqual({
      input: {
        id: "gid://shopify/Customer/1",
        firstName: "Catherine",
        email: "catherine@cats.com",
        note: "Updated note",
      },
    });
  });

  it("rejects when no update field provided (Zod refine guard)", async () => {
    const admin = fakeAdmin([]);
    const result = await updateCustomer(admin, {
      customerId: "gid://shopify/Customer/1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("at least one of firstName / lastName / email / phone / note");
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty customerId", async () => {
    const admin = fakeAdmin([]);
    const result = await updateCustomer(admin, {
      customerId: "",
      phone: "+1-555-0200",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects malformed email via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await updateCustomer(admin, {
      customerId: "gid://shopify/Customer/1",
      email: "not-an-email",
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
              { field: ["input", "email"], message: "Email has already been taken" },
            ],
          },
        },
      },
    ]);
    const result = await updateCustomer(admin, {
      customerId: "gid://shopify/Customer/1",
      email: "duplicate@cats.com",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Email has already been taken");
    // Only the mutation call happened — no snapshot refetch on error.
    expect(admin.calls).toHaveLength(1);
  });

  it("surfaces error if customerUpdate returns null customer with no userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: { customerUpdate: { customer: null, userErrors: [] } },
      },
    ]);
    const result = await updateCustomer(admin, {
      customerId: "gid://shopify/Customer/1",
      phone: "+1-555-0200",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no customer");
  });
});
