import { describe, expect, it } from "vitest";

import {
  fetchCustomerDetail,
  readCustomerDetail,
} from "../../../app/lib/shopify/customers.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function detailNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/Customer/1",
    firstName: "Cat",
    lastName: "Lover",
    displayName: "Cat Lover",
    email: "cat@cats.com",
    phone: "+1-555-0100",
    state: "ENABLED",
    tags: ["repeat", "loyal"],
    note: "VIP wholesale customer",
    numberOfOrders: "12",
    amountSpent: { amount: "1200.00", currencyCode: "USD" },
    emailMarketingConsent: {
      marketingState: "SUBSCRIBED",
      marketingOptInLevel: "SINGLE_OPT_IN",
      consentUpdatedAt: "2026-03-01T00:00:00Z",
    },
    smsMarketingConsent: {
      marketingState: "UNSUBSCRIBED",
      marketingOptInLevel: null,
      consentUpdatedAt: "2026-03-01T00:00:00Z",
    },
    defaultAddress: {
      address1: "123 Main St",
      city: "Springfield",
      province: "IL",
      country: "United States",
      zip: "62701",
    },
    lastOrder: {
      id: "gid://shopify/Order/9001",
      name: "#9001",
      processedAt: "2026-04-25T10:00:00Z",
    },
    orders: {
      edges: [
        {
          node: {
            id: "gid://shopify/Order/9001",
            name: "#9001",
            totalPriceSet: {
              shopMoney: { amount: "120.00", currencyCode: "USD" },
            },
            processedAt: "2026-04-25T10:00:00Z",
            displayFinancialStatus: "PAID",
          },
        },
        {
          node: {
            id: "gid://shopify/Order/9000",
            name: "#9000",
            totalPriceSet: {
              shopMoney: { amount: "80.00", currencyCode: "USD" },
            },
            processedAt: "2026-04-10T10:00:00Z",
            displayFinancialStatus: "PAID",
          },
        },
      ],
    },
    createdAt: "2025-11-15T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

describe("readCustomerDetail", () => {
  it("happy path — returns the full single-customer snapshot", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { customer: detailNode() } },
    ]);

    const result = await readCustomerDetail(admin, {
      customerId: "gid://shopify/Customer/1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      customerId: "gid://shopify/Customer/1",
      firstName: "Cat",
      lastName: "Lover",
      displayName: "Cat Lover",
      email: "cat@cats.com",
      phone: "+1-555-0100",
      state: "ENABLED",
      tags: ["repeat", "loyal"],
      note: "VIP wholesale customer",
      numberOfOrders: 12,
      amountSpent: "1200.00",
      currencyCode: "USD",
    });
    expect(result.data.emailMarketingConsent).toEqual({
      marketingState: "SUBSCRIBED",
      marketingOptInLevel: "SINGLE_OPT_IN",
      consentUpdatedAt: "2026-03-01T00:00:00Z",
    });
    expect(result.data.smsMarketingConsent).toEqual({
      marketingState: "UNSUBSCRIBED",
      marketingOptInLevel: null,
      consentUpdatedAt: "2026-03-01T00:00:00Z",
    });
    expect(result.data.defaultAddress).toEqual({
      address1: "123 Main St",
      city: "Springfield",
      province: "IL",
      country: "United States",
      zip: "62701",
    });
    expect(result.data.recentOrders).toHaveLength(2);
    expect(result.data.recentOrders[0]).toEqual({
      orderId: "gid://shopify/Order/9001",
      name: "#9001",
      totalPrice: "120.00",
      currencyCode: "USD",
      processedAt: "2026-04-25T10:00:00Z",
      displayFinancialStatus: "PAID",
    });
    expect(result.data.lastOrder).toEqual({
      orderId: "gid://shopify/Order/9001",
      name: "#9001",
      processedAt: "2026-04-25T10:00:00Z",
    });
  });

  it("rejects empty customerId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await readCustomerDetail(admin, { customerId: "" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("returns ok:false if customer is null (not found)", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { customer: null } }]);
    const result = await readCustomerDetail(admin, {
      customerId: "gid://shopify/Customer/missing",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("customer not found");
  });

  it("handles customer with no consent state (null)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customer: detailNode({
            emailMarketingConsent: null,
            smsMarketingConsent: null,
          }),
        },
      },
    ]);
    const result = await readCustomerDetail(admin, {
      customerId: "gid://shopify/Customer/1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.emailMarketingConsent).toBeNull();
    expect(result.data.smsMarketingConsent).toBeNull();
  });

  it("handles customer with no default address (null)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: { customer: detailNode({ defaultAddress: null }) },
      },
    ]);
    const result = await readCustomerDetail(admin, {
      customerId: "gid://shopify/Customer/1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.defaultAddress).toBeNull();
  });

  it("handles customer with no orders (empty edges + lastOrder null)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customer: detailNode({
            lastOrder: null,
            orders: { edges: [] },
            numberOfOrders: 0,
          }),
        },
      },
    ]);
    const result = await readCustomerDetail(admin, {
      customerId: "gid://shopify/Customer/1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.recentOrders).toHaveLength(0);
    expect(result.data.lastOrder).toBeNull();
    expect(result.data.numberOfOrders).toBe(0);
  });
});

describe("fetchCustomerDetail (snapshot helper used by snapshotBefore)", () => {
  it("returns the same shape as readCustomerDetail", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { customer: detailNode() } },
    ]);
    const result = await fetchCustomerDetail(
      admin,
      "gid://shopify/Customer/1",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Same canonical CustomerDetail shape — used by all 4 customer
    // writes' snapshotBefore() so the AuditLog before-state stays
    // consistent across tools.
    expect(result.data.customerId).toBe("gid://shopify/Customer/1");
    expect(result.data.tags).toEqual(["repeat", "loyal"]);
  });

  it("returns ok:false if customer is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { customer: null } }]);
    const result = await fetchCustomerDetail(
      admin,
      "gid://shopify/Customer/missing",
    );
    expect(result.ok).toBe(false);
  });
});
