import { describe, expect, it } from "vitest";

import { updateEmailMarketingConsent } from "../../../app/lib/shopify/customers.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateEmailMarketingConsent", () => {
  it("subscribed:true — maps to SUBSCRIBED + SINGLE_OPT_IN + consentUpdatedAt:now", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerEmailMarketingConsentUpdate: {
            customer: {
              id: "gid://shopify/Customer/1",
              emailMarketingConsent: {
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

    const result = await updateEmailMarketingConsent(admin, {
      customerId: "gid://shopify/Customer/1",
      subscribed: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.consent.marketingState).toBe("SUBSCRIBED");
    expect(result.data.consent.marketingOptInLevel).toBe("SINGLE_OPT_IN");
    // Mutation input maps `subscribed: true` → SUBSCRIBED enum.
    const vars = admin.calls[0].variables as {
      input: {
        customerId: string;
        emailMarketingConsent: {
          marketingState: string;
          marketingOptInLevel: string;
          consentUpdatedAt: string;
        };
      };
    };
    expect(vars.input.customerId).toBe("gid://shopify/Customer/1");
    expect(vars.input.emailMarketingConsent.marketingState).toBe("SUBSCRIBED");
    expect(vars.input.emailMarketingConsent.marketingOptInLevel).toBe("SINGLE_OPT_IN");
    // consentUpdatedAt is set to now by the handler — must be present and
    // a parseable ISO timestamp.
    expect(vars.input.emailMarketingConsent.consentUpdatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("subscribed:false — maps to UNSUBSCRIBED enum", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerEmailMarketingConsentUpdate: {
            customer: {
              id: "gid://shopify/Customer/1",
              emailMarketingConsent: {
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

    const result = await updateEmailMarketingConsent(admin, {
      customerId: "gid://shopify/Customer/1",
      subscribed: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.consent.marketingState).toBe("UNSUBSCRIBED");
    const vars = admin.calls[0].variables as {
      input: { emailMarketingConsent: { marketingState: string } };
    };
    expect(vars.input.emailMarketingConsent.marketingState).toBe("UNSUBSCRIBED");
  });

  it("rejects empty customerId", async () => {
    const admin = fakeAdmin([]);
    const result = await updateEmailMarketingConsent(admin, {
      customerId: "",
      subscribed: true,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects non-boolean subscribed", async () => {
    const admin = fakeAdmin([]);
    const result = await updateEmailMarketingConsent(admin, {
      customerId: "gid://shopify/Customer/1",
      subscribed: "yes" as unknown as boolean,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects missing subscribed field", async () => {
    const admin = fakeAdmin([]);
    const result = await updateEmailMarketingConsent(admin, {
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
          customerEmailMarketingConsentUpdate: {
            customer: null,
            userErrors: [
              { field: ["input", "emailMarketingConsent"], message: "Customer email is invalid" },
            ],
          },
        },
      },
    ]);
    const result = await updateEmailMarketingConsent(admin, {
      customerId: "gid://shopify/Customer/1",
      subscribed: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Customer email is invalid");
  });

  it("surfaces error if mutation returns null consent state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          customerEmailMarketingConsentUpdate: {
            customer: {
              id: "gid://shopify/Customer/1",
              emailMarketingConsent: null,
            },
            userErrors: [],
          },
        },
      },
    ]);
    const result = await updateEmailMarketingConsent(admin, {
      customerId: "gid://shopify/Customer/1",
      subscribed: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no consent state");
  });
});
