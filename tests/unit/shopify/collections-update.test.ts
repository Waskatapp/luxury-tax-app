import { describe, expect, it } from "vitest";

import {
  fetchCollectionDetails,
  updateCollection,
} from "../../../app/lib/shopify/collections.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("updateCollection", () => {
  it("happy path — updates title only and returns snapshot", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collectionUpdate: {
            collection: {
              id: "gid://shopify/Collection/1",
              title: "Holiday 2026 — Renamed",
              handle: "holiday-2026",
              descriptionHtml: "<p>Existing</p>",
              sortOrder: "MANUAL",
            },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateCollection(admin, {
      collectionId: "gid://shopify/Collection/1",
      title: "Holiday 2026 — Renamed",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.title).toBe("Holiday 2026 — Renamed");
    expect(admin.calls[0].variables).toEqual({
      input: {
        id: "gid://shopify/Collection/1",
        title: "Holiday 2026 — Renamed",
      },
    });
  });

  it("partial update — descriptionHtml + sortOrder only", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collectionUpdate: {
            collection: {
              id: "gid://shopify/Collection/1",
              title: "Holiday 2026",
              handle: "holiday-2026",
              descriptionHtml: "<p>New copy</p>",
              sortOrder: "PRICE_DESC",
            },
            userErrors: [],
          },
        },
      },
    ]);
    const result = await updateCollection(admin, {
      collectionId: "gid://shopify/Collection/1",
      descriptionHtml: "<p>New copy</p>",
      sortOrder: "PRICE_DESC",
    });
    expect(result.ok).toBe(true);
    expect(admin.calls[0].variables).toEqual({
      input: {
        id: "gid://shopify/Collection/1",
        descriptionHtml: "<p>New copy</p>",
        sortOrder: "PRICE_DESC",
      },
    });
  });

  it("rejects empty update (no optional fields set)", async () => {
    const admin = fakeAdmin([]);
    const result = await updateCollection(admin, {
      collectionId: "gid://shopify/Collection/1",
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
            userErrors: [{ field: ["input", "id"], message: "Collection not found" }],
          },
        },
      },
    ]);
    const result = await updateCollection(admin, {
      collectionId: "gid://shopify/Collection/missing",
      title: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Collection not found");
  });
});

describe("fetchCollectionDetails", () => {
  it("returns the snapshot used for AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          collection: {
            id: "gid://shopify/Collection/1",
            title: "Holiday 2026",
            handle: "holiday-2026",
            descriptionHtml: "<p>Old</p>",
            sortOrder: "MANUAL",
          },
        },
      },
    ]);
    const result = await fetchCollectionDetails(admin, "gid://shopify/Collection/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      collectionId: "gid://shopify/Collection/1",
      title: "Holiday 2026",
      handle: "holiday-2026",
      descriptionHtml: "<p>Old</p>",
      sortOrder: "MANUAL",
    });
  });

  it("returns ok:false if collection is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { collection: null } }]);
    const result = await fetchCollectionDetails(
      admin,
      "gid://shopify/Collection/missing",
    );
    expect(result.ok).toBe(false);
  });
});
