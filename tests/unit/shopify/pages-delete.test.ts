import { describe, expect, it } from "vitest";

import { deletePage } from "../../../app/lib/shopify/pages.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function fetchPageResponse(title: string) {
  return {
    kind: "data" as const,
    body: {
      page: {
        id: "gid://shopify/Page/1",
        title,
        handle: "shipping-policy",
        body: "<p>We ship in 1-2 days.</p>",
        bodySummary: "We ship in 1-2 days.",
        templateSuffix: null,
        isPublished: true,
        publishedAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      },
    },
  };
}

describe("deletePage", () => {
  it("happy path — fetches snapshot, confirms title, issues delete", async () => {
    const admin = fakeAdmin([
      fetchPageResponse("Shipping Policy"),
      {
        kind: "data",
        body: {
          pageDelete: {
            deletedPageId: "gid://shopify/Page/1",
            userErrors: [],
          },
        },
      },
    ]);

    const result = await deletePage(admin, {
      pageId: "gid://shopify/Page/1",
      confirmTitle: "Shipping Policy",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      deletedPageId: "gid://shopify/Page/1",
      title: "Shipping Policy",
    });
    expect(admin.calls).toHaveLength(2);
    expect(admin.calls[1].variables).toEqual({ id: "gid://shopify/Page/1" });
  });

  it("confirmTitle case-insensitive — 'shipping policy' matches 'Shipping Policy'", async () => {
    const admin = fakeAdmin([
      fetchPageResponse("Shipping Policy"),
      {
        kind: "data",
        body: {
          pageDelete: {
            deletedPageId: "gid://shopify/Page/1",
            userErrors: [],
          },
        },
      },
    ]);
    const result = await deletePage(admin, {
      pageId: "gid://shopify/Page/1",
      confirmTitle: "shipping policy",
    });
    expect(result.ok).toBe(true);
  });

  it("confirmTitle whitespace-trimmed — '  Shipping Policy  ' matches", async () => {
    const admin = fakeAdmin([
      fetchPageResponse("Shipping Policy"),
      {
        kind: "data",
        body: {
          pageDelete: {
            deletedPageId: "gid://shopify/Page/1",
            userErrors: [],
          },
        },
      },
    ]);
    const result = await deletePage(admin, {
      pageId: "gid://shopify/Page/1",
      confirmTitle: "  Shipping Policy  ",
    });
    expect(result.ok).toBe(true);
  });

  it("confirmTitle mismatch — refuses to delete, no mutation issued", async () => {
    const admin = fakeAdmin([
      // Only the fetchPage call should happen — delete must not fire.
      fetchPageResponse("Shipping Policy"),
    ]);
    const result = await deletePage(admin, {
      pageId: "gid://shopify/Page/1",
      confirmTitle: "Returns Policy", // wrong title
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("confirmTitle mismatch");
    expect(result.error).toContain("Shipping Policy");
    expect(result.error).toContain("Returns Policy");
    // Only the snapshot read happened, no delete mutation.
    expect(admin.calls).toHaveLength(1);
  });

  it("rejects empty confirmTitle via Zod (defensive gate can't be sidestepped with '')", async () => {
    const admin = fakeAdmin([]);
    const result = await deletePage(admin, {
      pageId: "gid://shopify/Page/1",
      confirmTitle: "",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects whitespace-only confirmTitle via Zod refine", async () => {
    const admin = fakeAdmin([]);
    const result = await deletePage(admin, {
      pageId: "gid://shopify/Page/1",
      confirmTitle: "   ",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("confirmTitle");
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty pageId", async () => {
    const admin = fakeAdmin([]);
    const result = await deletePage(admin, {
      pageId: "",
      confirmTitle: "anything",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces error if page doesn't exist (snapshot fetch fails)", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { page: null } }]);
    const result = await deletePage(admin, {
      pageId: "gid://shopify/Page/missing",
      confirmTitle: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("page not found");
    // No delete mutation issued.
    expect(admin.calls).toHaveLength(1);
  });

  it("surfaces shopify userErrors from pageDelete", async () => {
    const admin = fakeAdmin([
      fetchPageResponse("Shipping Policy"),
      {
        kind: "data",
        body: {
          pageDelete: {
            deletedPageId: null,
            userErrors: [
              { field: ["id"], message: "Cannot delete required policy page" },
            ],
          },
        },
      },
    ]);
    const result = await deletePage(admin, {
      pageId: "gid://shopify/Page/1",
      confirmTitle: "Shipping Policy",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Cannot delete required policy page");
  });

  it("surfaces error when pageDelete returns null id with no userErrors", async () => {
    const admin = fakeAdmin([
      fetchPageResponse("Shipping Policy"),
      {
        kind: "data",
        body: {
          pageDelete: {
            deletedPageId: null,
            userErrors: [],
          },
        },
      },
    ]);
    const result = await deletePage(admin, {
      pageId: "gid://shopify/Page/1",
      confirmTitle: "Shipping Policy",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no deletedPageId");
  });
});
