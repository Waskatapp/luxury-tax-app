import { describe, expect, it } from "vitest";

import { createPage } from "../../../app/lib/shopify/pages.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function pageResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/Page/1",
    title: "FAQ",
    handle: "faq",
    body: "<p>Q: How? A: Like this.</p>",
    bodySummary: "Q: How? A: Like this.",
    templateSuffix: null,
    isPublished: false,
    publishedAt: null,
    updatedAt: "2026-05-02T10:00:00Z",
    ...overrides,
  };
}

describe("createPage", () => {
  it("happy path — sends required fields, defaults isPublished to false", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pageCreate: { page: pageResult(), userErrors: [] },
        },
      },
    ]);

    const result = await createPage(admin, {
      title: "FAQ",
      body: "<p>Q: How? A: Like this.</p>",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      pageId: "gid://shopify/Page/1",
      title: "FAQ",
      handle: "faq",
      body: "<p>Q: How? A: Like this.</p>",
      isPublished: false,
      templateSuffix: null,
    });
    expect(admin.calls[0].variables).toEqual({
      page: {
        title: "FAQ",
        body: "<p>Q: How? A: Like this.</p>",
        isPublished: false,
      },
    });
  });

  it("templateSuffix included when provided", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pageCreate: {
            page: pageResult({
              title: "Contact",
              handle: "contact",
              templateSuffix: "contact",
            }),
            userErrors: [],
          },
        },
      },
    ]);

    await createPage(admin, {
      title: "Contact",
      body: "<p>Reach us...</p>",
      templateSuffix: "contact",
    });

    expect(admin.calls[0].variables).toEqual({
      page: {
        title: "Contact",
        body: "<p>Reach us...</p>",
        isPublished: false,
        templateSuffix: "contact",
      },
    });
  });

  it("isPublished:true sent verbatim", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pageCreate: {
            page: pageResult({
              isPublished: true,
              publishedAt: "2026-05-02T10:00:00Z",
            }),
            userErrors: [],
          },
        },
      },
    ]);
    const result = await createPage(admin, {
      title: "FAQ",
      body: "<p>B</p>",
      isPublished: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isPublished).toBe(true);
    const vars = admin.calls[0].variables as {
      page: { isPublished: boolean };
    };
    expect(vars.page.isPublished).toBe(true);
  });

  it("rejects empty title via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await createPage(admin, { title: "", body: "<p>B</p>" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty body via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await createPage(admin, { title: "T", body: "" });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pageCreate: {
            page: null,
            userErrors: [
              { field: ["page", "handle"], message: "Handle has already been taken" },
            ],
          },
        },
      },
    ]);
    const result = await createPage(admin, { title: "FAQ", body: "<p>B</p>" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Handle has already been taken");
  });

  it("surfaces error when pageCreate returns null page with no userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: { pageCreate: { page: null, userErrors: [] } },
      },
    ]);
    const result = await createPage(admin, { title: "FAQ", body: "<p>B</p>" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no page");
  });
});
