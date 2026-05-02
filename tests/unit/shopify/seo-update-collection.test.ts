import { describe, expect, it } from "vitest";

import {
  fetchCollectionSeo,
  updateCollectionSeo,
} from "../../../app/lib/shopify/seo.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateCollectionSeo", () => {
  it("happy path — sends both seo fields and returns the after snapshot", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collectionUpdate: {
            collection: {
              id: "gid://shopify/Collection/1",
              title: "Cats",
              seo: {
                title: "Premium Cat Supplies | <Store>",
                description: "Everything for the discerning cat owner.",
              },
              updatedAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateCollectionSeo(admin, {
      collectionId: "gid://shopify/Collection/1",
      seoTitle: "Premium Cat Supplies | <Store>",
      seoDescription: "Everything for the discerning cat owner.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      collectionId: "gid://shopify/Collection/1",
      collectionTitle: "Cats",
      seoTitle: "Premium Cat Supplies | <Store>",
      seoDescription: "Everything for the discerning cat owner.",
    });
    // Note: collectionUpdate uses `input:` not `product:` — different mutation
    // shape from product. The handler should send the right wrapper.
    expect(admin.calls[0].variables).toEqual({
      input: {
        id: "gid://shopify/Collection/1",
        seo: {
          title: "Premium Cat Supplies | <Store>",
          description: "Everything for the discerning cat owner.",
        },
      },
    });
  });

  it("only seoDescription provided — only sends description", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collectionUpdate: {
            collection: {
              id: "gid://shopify/Collection/1",
              title: "Cats",
              seo: {
                title: "old title untouched",
                description: "Brand-new description",
              },
              updatedAt: "2026-05-02T10:00:00Z",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateCollectionSeo(admin, {
      collectionId: "gid://shopify/Collection/1",
      seoDescription: "Brand-new description",
    });

    expect(result.ok).toBe(true);
    const variables = admin.calls[0].variables as {
      input: { id: string; seo: Record<string, unknown> };
    };
    expect(variables.input.seo).toEqual({ description: "Brand-new description" });
    expect("title" in variables.input.seo).toBe(false);
  });

  it("rejects when neither field is provided", async () => {
    const admin = fakeAdmin([]);
    const result = await updateCollectionSeo(admin, {
      collectionId: "gid://shopify/Collection/1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("at least one of seoTitle or seoDescription");
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty collectionId", async () => {
    const admin = fakeAdmin([]);
    const result = await updateCollectionSeo(admin, {
      collectionId: "",
      seoTitle: "anything",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collectionUpdate: {
            collection: null,
            userErrors: [
              { field: ["input", "seo", "description"], message: "Description too long" },
            ],
          },
        },
      },
    ]);
    const result = await updateCollectionSeo(admin, {
      collectionId: "gid://shopify/Collection/1",
      seoDescription: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Description too long");
  });
});

describe("fetchCollectionSeo", () => {
  it("returns the snapshot used for the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collection: {
            id: "gid://shopify/Collection/1",
            title: "Cats",
            seo: {
              title: "Old SEO title",
              description: "Old description",
            },
          },
        },
      },
    ]);
    const result = await fetchCollectionSeo(admin, "gid://shopify/Collection/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      collectionId: "gid://shopify/Collection/1",
      collectionTitle: "Cats",
      seoTitle: "Old SEO title",
      seoDescription: "Old description",
    });
  });

  it("returns null fields when collection has no SEO override", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collection: {
            id: "gid://shopify/Collection/1",
            title: "Cats",
            seo: { title: null, description: null },
          },
        },
      },
    ]);
    const result = await fetchCollectionSeo(admin, "gid://shopify/Collection/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.seoTitle).toBeNull();
    expect(result.data.seoDescription).toBeNull();
  });

  it("returns ok:false if collection is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { collection: null } }]);
    const result = await fetchCollectionSeo(
      admin,
      "gid://shopify/Collection/missing",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("collection not found");
  });
});
