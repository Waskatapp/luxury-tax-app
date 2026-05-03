import { describe, expect, it } from "vitest";

import { updateSmsMarketingConsent } from "../../../app/lib/shopify/customers.server";
import { fakeAdmin } from "../../helpers/fake-admin";

// SMS consent is intentionally a separate tool from email consent
// because the legal regimes (TCPA for SMS, CAN-SPAM for email) carry
// different audit weight — separate AuditLog entries are non-negotiable.
// These tests verify the SMS-specific mutation shape; the email tests
// cover the parallel path.

describe("updateSmsMarketingConsent", () => {
  it("subscribed:true — maps to SUBSCRIBED + SINGLE_OPT_IN, hits SMS-specific mutation", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerSmsMarketingConsentUpdate: {
            customer: {
              id: "gid://shopify/Customer/1",
              smsMarketingConsent: {
                marketingState: "SUBSCRIBED",
                marketingOptInLevel: "SINGLE_OPT_IN",
                consentUpdatedAt: "2026-05-03T12:00:00.000Z",
              },
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateSmsMarketingConsent(admin, {
      customerId: "gid://shopify/Customer/1",
      subscribed: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.consent.marketingState).toBe("SUBSCRIBED");
    // The mutation input uses `smsMarketingConsent` (not email). Critical
    // — confirms the tool hits the right Shopify mutation surface.
    const vars = admin.calls[0].variables as {
      input: {
        customerId: string;
        smsMarketingConsent: {
          marketingState: string;
          marketingOptInLevel: string;
          consentUpdatedAt: string;
        };
      };
    };
    expect(vars.input.smsMarketingConsent.marketingState).toBe("SUBSCRIBED");
    expect(vars.input.smsMarketingConsent.marketingOptInLevel).toBe("SINGLE_OPT_IN");
    expect(vars.input.smsMarketingConsent.consentUpdatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    // Verify the mutation query is the SMS-specific one (not email).
    expect(admin.calls[0].query).toContain("customerSmsMarketingConsentUpdate");
    expect(admin.calls[0].query).not.toContain("customerEmailMarketingConsentUpdate");
  });

  it("subscribed:false — maps to UNSUBSCRIBED enum", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerSmsMarketingConsentUpdate: {
            customer: {
              id: "gid://shopify/Customer/1",
              smsMarketingConsent: {
                marketingState: "UNSUBSCRIBED",
                marketingOptInLevel: "SINGLE_OPT_IN",
                consentUpdatedAt: "2026-05-03T12:00:00.000Z",
              },
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateSmsMarketingConsent(admin, {
      customerId: "gid://shopify/Customer/1",
      subscribed: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.consent.marketingState).toBe("UNSUBSCRIBED");
  });

  it("rejects empty customerId", async () => {
    const admin = fakeAdmin([]);
    const result = await updateSmsMarketingConsent(admin, {
      customerId: "",
      subscribed: true,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects missing subscribed field", async () => {
    const admin = fakeAdmin([]);
    const result = await updateSmsMarketingConsent(admin, {
      customerId: "gid://shopify/Customer/1",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerSmsMarketingConsentUpdate: {
            customer: null,
            userErrors: [
              { field: ["input", "smsMarketingConsent"], message: "Phone number is required for SMS consent" },
            ],
          },
        },
      },
    ]);
    const result = await updateSmsMarketingConsent(admin, {
      customerId: "gid://shopify/Customer/1",
      subscribed: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Phone number is required for SMS consent");
  });

  it("surfaces error if mutation returns null consent state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerSmsMarketingConsentUpdate: {
            customer: {
              id: "gid://shopify/Customer/1",
              smsMarketingConsent: null,
            },
            userErrors: [],
          },
        },
      },
    ]);
    const result = await updateSmsMarketingConsent(admin, {
      customerId: "gid://shopify/Customer/1",
      subscribed: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no consent state");
  });
});
