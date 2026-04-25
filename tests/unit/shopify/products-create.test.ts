import { describe, expect, it } from "vitest";

import { createProductDraft } from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("createProductDraft", () => {
  it("happy path — creates a DRAFT and returns the default variant for follow-up tools", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productCreate: {
            product: {
              id: "gid://shopify/Product/99",
              title: "Eco Bottle",
              handle: "eco-bottle",
              status: "DRAFT",
              descriptionHtml: null,
              vendor: null,
              productType: null,
              createdAt: "2026-04-25T10:00:00Z",
              variants: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/ProductVariant/990",
                      title: "Default Title",
                      price: "0.00",
                    },
                  },
                ],
              },
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await createProductDraft(admin, { title: "Eco Bottle" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("DRAFT");
    // Default variant must be returned so the agent can call update_product_price
    // on the next turn without a separate read_products lookup.
    expect(result.data.defaultVariant).toEqual({
      id: "gid://shopify/ProductVariant/990",
      title: "Default Title",
      price: "0.00",
    });

    const variables = admin.calls[0].variables as { product: Record<string, unknown> };
    expect(variables.product).toEqual({ title: "Eco Bottle", status: "DRAFT" });
  });

  it("forwards optional fields when provided", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productCreate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "T-shirt",
              handle: "t-shirt",
              status: "DRAFT",
              descriptionHtml: "<p>cotton</p>",
              vendor: "ACME",
              productType: "Apparel",
              createdAt: "2026-04-25T10:00:00Z",
              variants: { edges: [] },
            },
            userErrors: [],
          },
        },
      },
    ]);

    await createProductDraft(admin, {
      title: "T-shirt",
      descriptionHtml: "<p>cotton</p>",
      vendor: "ACME",
      productType: "Apparel",
    });

    const variables = admin.calls[0].variables as { product: Record<string, unknown> };
    expect(variables.product).toEqual({
      title: "T-shirt",
      status: "DRAFT",
      descriptionHtml: "<p>cotton</p>",
      vendor: "ACME",
      productType: "Apparel",
    });
  });

  it("preserves vendor casing exactly (no Title-Case auto-correct)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productCreate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "X",
              handle: "x",
              status: "DRAFT",
              descriptionHtml: null,
              vendor: "ACME",
              productType: null,
              createdAt: "2026-04-25T10:00:00Z",
              variants: { edges: [] },
            },
            userErrors: [],
          },
        },
      },
    ]);

    await createProductDraft(admin, { title: "X", vendor: "ACME" });
    const variables = admin.calls[0].variables as { product: { vendor: string } };
    expect(variables.product.vendor).toBe("ACME");
  });

  it("rejects empty title via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await createProductDraft(admin, { title: "" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("returns null defaultVariant if Shopify returned no variants", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productCreate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "X",
              handle: "x",
              status: "DRAFT",
              descriptionHtml: null,
              vendor: null,
              productType: null,
              createdAt: "2026-04-25T10:00:00Z",
              variants: { edges: [] },
            },
            userErrors: [],
          },
        },
      },
    ]);
    const result = await createProductDraft(admin, { title: "X" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.defaultVariant).toBeNull();
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productCreate: {
            product: null,
            userErrors: [
              { field: ["product", "title"], message: "Title can't be blank" },
            ],
          },
        },
      },
    ]);
    const result = await createProductDraft(admin, { title: "valid" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Title can't be blank");
  });
});
