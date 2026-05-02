import { describe, expect, it } from "vitest";

import {
  fetchPage,
  updatePage,
} from "../../../app/lib/shopify/pages.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function pageResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/Page/1",
    title: "Shipping Policy",
    handle: "shipping-policy",
    body: "<p>We ship in 1-2 days.</p>",
    bodySummary: "We ship in 1-2 days.",
    templateSuffix: null,
    isPublished: true,
    publishedAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-05-02T10:00:00Z",
    ...overrides,
  };
}

describe("updatePage", () => {
  it("happy path — updates body only, sends only the changed field", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pageUpdate: {
            page: pageResult({
              body: "<p>Updated shipping copy.</p>",
              bodySummary: "Updated shipping copy.",
            }),
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updatePage(admin, {
      pageId: "gid://shopify/Page/1",
      body: "<p>Updated shipping copy.</p>",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.body).toBe("<p>Updated shipping copy.</p>");
    expect(admin.calls[0].variables).toEqual({
      id: "gid://shopify/Page/1",
      page: { body: "<p>Updated shipping copy.</p>" },
    });
  });

  it("publish toggle — isPublished:false sent verbatim", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pageUpdate: {
            page: pageResult({ isPublished: false, publishedAt: null }),
            userErrors: [],
          },
        },
      },
    ]);
    const result = await updatePage(admin, {
      pageId: "gid://shopify/Page/1",
      isPublished: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isPublished).toBe(false);
    expect(admin.calls[0].variables).toMatchObject({
      page: { isPublished: false },
    });
  });

  it("templateSuffix: null clears it (sends null verbatim)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pageUpdate: {
            page: pageResult({ templateSuffix: null }),
            userErrors: [],
          },
        },
      },
    ]);
    await updatePage(admin, {
      pageId: "gid://shopify/Page/1",
      templateSuffix: null,
    });
    const vars = admin.calls[0].variables as {
      page: Record<string, unknown>;
    };
    expect(vars.page).toEqual({ templateSuffix: null });
  });

  it("templateSuffix: '<value>' sets a new suffix", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pageUpdate: {
            page: pageResult({ templateSuffix: "contact" }),
            userErrors: [],
          },
        },
      },
    ]);
    await updatePage(admin, {
      pageId: "gid://shopify/Page/1",
      templateSuffix: "contact",
    });
    const vars = admin.calls[0].variables as {
      page: Record<string, unknown>;
    };
    expect(vars.page).toEqual({ templateSuffix: "contact" });
  });

  it("multiple fields — all included in the mutation input", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pageUpdate: {
            page: pageResult({
              title: "Shipping & Returns",
              isPublished: true,
            }),
            userErrors: [],
          },
        },
      },
    ]);
    await updatePage(admin, {
      pageId: "gid://shopify/Page/1",
      title: "Shipping & Returns",
      body: "<p>Combined policy.</p>",
      isPublished: true,
    });
    expect(admin.calls[0].variables).toEqual({
      id: "gid://shopify/Page/1",
      page: {
        title: "Shipping & Returns",
        body: "<p>Combined policy.</p>",
        isPublished: true,
      },
    });
  });

  it("rejects when no update field provided (Zod refine guard)", async () => {
    const admin = fakeAdmin([]);
    const result = await updatePage(admin, {
      pageId: "gid://shopify/Page/1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("at least one field to update");
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty pageId", async () => {
    const admin = fakeAdmin([]);
    const result = await updatePage(admin, {
      pageId: "",
      title: "anything",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pageUpdate: {
            page: null,
            userErrors: [
              { field: ["page", "title"], message: "Title can't be blank" },
            ],
          },
        },
      },
    ]);
    const result = await updatePage(admin, {
      pageId: "gid://shopify/Page/1",
      title: "ok",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Title can't be blank");
  });
});

describe("fetchPage", () => {
  it("returns the snapshot used for the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          page: pageResult({
            title: "Shipping Policy",
            body: "<p>Original shipping copy.</p>",
          }),
        },
      },
    ]);
    const result = await fetchPage(admin, "gid://shopify/Page/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.title).toBe("Shipping Policy");
    expect(result.data.body).toBe("<p>Original shipping copy.</p>");
  });

  it("returns ok:false if page is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { page: null } }]);
    const result = await fetchPage(admin, "gid://shopify/Page/missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("page not found");
  });
});
