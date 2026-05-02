import { describe, expect, it } from "vitest";

import { readArticles } from "../../../app/lib/shopify/articles.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function articleEdge(opts: {
  id: string;
  title: string;
  blogId?: string;
  blogTitle?: string;
  isPublished?: boolean;
  tags?: string[];
}) {
  return {
    cursor: `c-${opts.id}`,
    node: {
      id: opts.id,
      title: opts.title,
      handle: opts.title.toLowerCase().replace(/\s+/g, "-"),
      summary: null,
      author: { name: "Jane" },
      tags: opts.tags ?? [],
      image: null,
      isPublished: opts.isPublished ?? true,
      publishedAt: opts.isPublished ?? true ? "2026-04-01T00:00:00Z" : null,
      updatedAt: "2026-05-01T00:00:00Z",
      blog: {
        id: opts.blogId ?? "gid://shopify/Blog/1",
        title: opts.blogTitle ?? "News",
      },
    },
  };
}

describe("readArticles", () => {
  it("happy path — lists articles with default limit", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articles: {
            edges: [
              articleEdge({ id: "gid://shopify/Article/1", title: "Cat Care 101", tags: ["cats", "guide"] }),
              articleEdge({ id: "gid://shopify/Article/2", title: "Winter Tips", tags: ["winter"] }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await readArticles(admin, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.articles).toHaveLength(2);
    expect(result.data.articles[0]).toMatchObject({
      articleId: "gid://shopify/Article/1",
      title: "Cat Care 101",
      handle: "cat-care-101",
      blogId: "gid://shopify/Blog/1",
      blogTitle: "News",
      author: "Jane",
      tags: ["cats", "guide"],
      isPublished: true,
    });
    // Default limit is 20.
    expect(admin.calls[0].variables).toMatchObject({ first: 20, after: null, query: null });
  });

  it("blogId filter — appends blog_id:<numeric> to the query string", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articles: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    await readArticles(admin, { blogId: "gid://shopify/Blog/42" });

    const vars = admin.calls[0].variables as { query: string };
    // The numeric id is extracted from the GID.
    expect(vars.query).toBe("blog_id:42");
  });

  it("blogId + query — joins both clauses with a space", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articles: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    await readArticles(admin, {
      blogId: "gid://shopify/Blog/42",
      query: "tag:winter",
    });

    const vars = admin.calls[0].variables as { query: string };
    expect(vars.query).toBe("blog_id:42 tag:winter");
  });

  it("query only — no blog filter, just the merchant's search syntax", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articles: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    await readArticles(admin, { query: "author:Jane" });

    const vars = admin.calls[0].variables as { query: string };
    expect(vars.query).toBe("author:Jane");
  });

  it("respects custom limit", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articles: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    await readArticles(admin, { limit: 5 });
    expect(admin.calls[0].variables).toMatchObject({ first: 5 });
  });

  it("rejects limit > 50", async () => {
    const admin = fakeAdmin([]);
    const result = await readArticles(admin, { limit: 100 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects limit < 1", async () => {
    const admin = fakeAdmin([]);
    const result = await readArticles(admin, { limit: 0 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("preserves pageInfo for pagination follow-ups", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articles: {
            edges: [articleEdge({ id: "gid://shopify/Article/1", title: "A" })],
            pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
          },
        },
      },
    ]);
    const result = await readArticles(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: "cursor-abc",
    });
  });

  it("handles articles with missing optional fields", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articles: {
            edges: [
              {
                cursor: "c1",
                node: {
                  id: "gid://shopify/Article/1",
                  title: "Bare Article",
                  handle: "bare-article",
                  summary: null,
                  author: null,
                  tags: [],
                  image: null,
                  isPublished: false,
                  publishedAt: null,
                  updatedAt: "2026-05-01T00:00:00Z",
                  blog: null,
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readArticles(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.articles[0]).toMatchObject({
      articleId: "gid://shopify/Article/1",
      title: "Bare Article",
      summary: null,
      author: null,
      tags: [],
      imageUrl: null,
      isPublished: false,
      publishedAt: null,
      blogId: "",
      blogTitle: "",
    });
  });

  it("empty result — returns empty array, no error", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articles: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);
    const result = await readArticles(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.articles).toHaveLength(0);
  });
});
