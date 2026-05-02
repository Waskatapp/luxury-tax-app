import { describe, expect, it } from "vitest";

import { readPages } from "../../../app/lib/shopify/pages.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function pageEdge(opts: {
  id: string;
  title: string;
  isPublished?: boolean;
  templateSuffix?: string | null;
  bodySummary?: string | null;
}) {
  return {
    cursor: `c-${opts.id}`,
    node: {
      id: opts.id,
      title: opts.title,
      handle: opts.title.toLowerCase().replace(/\s+/g, "-"),
      bodySummary: opts.bodySummary ?? null,
      templateSuffix: opts.templateSuffix ?? null,
      isPublished: opts.isPublished ?? true,
      publishedAt: opts.isPublished ?? true ? "2026-04-01T00:00:00Z" : null,
      updatedAt: "2026-05-01T00:00:00Z",
    },
  };
}

describe("readPages", () => {
  it("happy path — lists pages with default limit", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pages: {
            edges: [
              pageEdge({ id: "gid://shopify/Page/1", title: "About Us", bodySummary: "Our story." }),
              pageEdge({ id: "gid://shopify/Page/2", title: "FAQ", bodySummary: "Common questions." }),
              pageEdge({
                id: "gid://shopify/Page/3",
                title: "Contact",
                templateSuffix: "contact",
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await readPages(admin, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pages).toHaveLength(3);
    expect(result.data.pages[0]).toMatchObject({
      pageId: "gid://shopify/Page/1",
      title: "About Us",
      handle: "about-us",
      bodySummary: "Our story.",
      isPublished: true,
      templateSuffix: null,
    });
    expect(result.data.pages[2]).toMatchObject({
      title: "Contact",
      templateSuffix: "contact",
    });
    expect(admin.calls[0].variables).toMatchObject({
      first: 20,
      after: null,
      query: null,
    });
  });

  it("query — passes the merchant's search syntax through verbatim", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pages: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    await readPages(admin, { query: "title:shipping" });

    const vars = admin.calls[0].variables as { query: string };
    expect(vars.query).toBe("title:shipping");
  });

  it("respects custom limit", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pages: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    await readPages(admin, { limit: 5 });
    expect(admin.calls[0].variables).toMatchObject({ first: 5 });
  });

  it("rejects limit > 50", async () => {
    const admin = fakeAdmin([]);
    const result = await readPages(admin, { limit: 100 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects limit < 1", async () => {
    const admin = fakeAdmin([]);
    const result = await readPages(admin, { limit: 0 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("preserves pageInfo for pagination follow-ups", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pages: {
            edges: [pageEdge({ id: "gid://shopify/Page/1", title: "A" })],
            pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
          },
        },
      },
    ]);
    const result = await readPages(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: "cursor-abc",
    });
  });

  it("empty result — returns empty array, no error", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pages: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readPages(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pages).toHaveLength(0);
  });

  it("handles unpublished page (publishedAt: null)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          pages: {
            edges: [
              pageEdge({
                id: "gid://shopify/Page/1",
                title: "Draft Page",
                isPublished: false,
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readPages(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pages[0]).toMatchObject({
      isPublished: false,
      publishedAt: null,
    });
  });
});
