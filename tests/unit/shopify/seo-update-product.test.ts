import { describe, expect, it } from "vitest";

import {
  fetchProductSeo,
  updateProductSeo,
} from "../../../app/lib/shopify/seo.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateProductSeo", () => {
  it("happy path — sends both seo fields and returns the after snapshot", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Cat Food",
              seo: {
                title: "Premium Cat Food — High-Protein Kibble",
                description: "High-protein dry kibble. Real chicken, no fillers.",
              },
              updatedAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateProductSeo(admin, {
      productId: "gid://shopify/Product/1",
      seoTitle: "Premium Cat Food — High-Protein Kibble",
      seoDescription: "High-protein dry kibble. Real chicken, no fillers.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      productId: "gid://shopify/Product/1",
      productTitle: "Cat Food",
      seoTitle: "Premium Cat Food — High-Protein Kibble",
      seoDescription: "High-protein dry kibble. Real chicken, no fillers.",
    });
    // The mutation input should carry exactly the fields we set — undefined
    // fields are omitted so Shopify leaves them alone.
    expect(admin.calls[0].variables).toEqual({
      product: {
        id: "gid://shopify/Product/1",
        seo: {
          title: "Premium Cat Food — High-Protein Kibble",
          description: "High-protein dry kibble. Real chicken, no fillers.",
        },
      },
    });
  });

  it("only seoTitle provided — only sends title, leaves description unchanged", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Cat Food",
              seo: {
                title: "Brand-new title",
                description: "old description that wasn't touched",
              },
              updatedAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateProductSeo(admin, {
      productId: "gid://shopify/Product/1",
      seoTitle: "Brand-new title",
    });

    expect(result.ok).toBe(true);
    const variables = admin.calls[0].variables as {
      product: { id: string; seo: Record<string, unknown> };
    };
    expect(variables.product.seo).toEqual({ title: "Brand-new title" });
    expect("description" in variables.product.seo).toBe(false);
  });

  it("empty string clears the field — passes through to Shopify as ''", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Cat Food",
              seo: { title: null, description: null },
              updatedAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateProductSeo(admin, {
      productId: "gid://shopify/Product/1",
      seoTitle: "",
      seoDescription: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.seoTitle).toBeNull();
    expect(result.data.seoDescription).toBeNull();
    // We send "" — Shopify treats empty string as "no override, fall back".
    expect(admin.calls[0].variables).toEqual({
      product: {
        id: "gid://shopify/Product/1",
        seo: { title: "", description: "" },
      },
    });
  });

  it("rejects when neither field is provided (Zod refine guard)", async () => {
    const admin = fakeAdmin([]);
    const result = await updateProductSeo(admin, {
      productId: "gid://shopify/Product/1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("at least one of seoTitle or seoDescription");
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty productId via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await updateProductSeo(admin, {
      productId: "",
      seoTitle: "anything",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects seoTitle longer than 255 chars (loose hard cap)", async () => {
    const admin = fakeAdmin([]);
    const result = await updateProductSeo(admin, {
      productId: "gid://shopify/Product/1",
      seoTitle: "x".repeat(256),
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects seoDescription longer than 320 chars", async () => {
    const admin = fakeAdmin([]);
    const result = await updateProductSeo(admin, {
      productId: "gid://shopify/Product/1",
      seoDescription: "x".repeat(321),
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: null,
            userErrors: [
              { field: ["product", "seo", "title"], message: "SEO title is invalid" },
            ],
          },
        },
      },
    ]);
    const result = await updateProductSeo(admin, {
      productId: "gid://shopify/Product/1",
      seoTitle: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("SEO title is invalid");
  });

  it("surfaces error when productUpdate returns no product", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productUpdate: {
            product: null,
            userErrors: [],
          },
        },
      },
    ]);
    const result = await updateProductSeo(admin, {
      productId: "gid://shopify/Product/1",
      seoTitle: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no product");
  });
});

describe("fetchProductSeo", () => {
  it("returns the snapshot used for the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
            seo: {
              title: "Old SEO title",
              description: "Old SEO description",
            },
          },
        },
      },
    ]);
    const result = await fetchProductSeo(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      productId: "gid://shopify/Product/1",
      productTitle: "Cat Food",
      seoTitle: "Old SEO title",
      seoDescription: "Old SEO description",
    });
  });

  it("returns null fields when product has no SEO override", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
            seo: { title: null, description: null },
          },
        },
      },
    ]);
    const result = await fetchProductSeo(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.seoTitle).toBeNull();
    expect(result.data.seoDescription).toBeNull();
  });

  it("returns ok:false if product is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { product: null } }]);
    const result = await fetchProductSeo(admin, "gid://shopify/Product/missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("product not found");
  });
});
