import { describe, expect, it } from "vitest";

import { createCollection } from "../../../app/lib/shopify/collections.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("createCollection", () => {
  it("happy path — creates a manual collection with title only", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collectionCreate: {
            collection: {
              id: "gid://shopify/Collection/1",
              title: "Holiday 2026",
              handle: "holiday-2026",
              sortOrder: "MANUAL",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await createCollection(admin, { title: "Holiday 2026" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      collectionId: "gid://shopify/Collection/1",
      title: "Holiday 2026",
      handle: "holiday-2026",
      sortOrder: "MANUAL",
    });
    expect(admin.calls[0].variables).toEqual({
      input: { title: "Holiday 2026" },
    });
  });

  it("includes optional descriptionHtml and sortOrder when provided", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collectionCreate: {
            collection: {
              id: "gid://shopify/Collection/2",
              title: "Bestsellers",
              handle: "bestsellers",
              sortOrder: "BEST_SELLING",
            },
            userErrors: [],
          },
        },
      },
    ]);
    const result = await createCollection(admin, {
      title: "Bestsellers",
      descriptionHtml: "<p>Our top picks</p>",
      sortOrder: "BEST_SELLING",
    });
    expect(result.ok).toBe(true);
    expect(admin.calls[0].variables).toEqual({
      input: {
        title: "Bestsellers",
        descriptionHtml: "<p>Our top picks</p>",
        sortOrder: "BEST_SELLING",
      },
    });
  });

  it("rejects empty title via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await createCollection(admin, { title: "" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects invalid sortOrder via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await createCollection(admin, {
      title: "X",
      sortOrder: "RANDOM",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collectionCreate: {
            collection: null,
            userErrors: [
              { field: ["input", "title"], message: "Title has already been taken" },
            ],
          },
        },
      },
    ]);
    const result = await createCollection(admin, { title: "Duplicate" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Title has already been taken");
  });
});
