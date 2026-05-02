import { describe, expect, it } from "vitest";

import { createArticle } from "../../../app/lib/shopify/articles.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function articleResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/Article/1",
    title: "Cat Care Tips",
    handle: "cat-care-tips",
    body: "<p>Some body.</p>",
    summary: null,
    author: { name: "Jane" },
    tags: [],
    image: null,
    isPublished: false,
    publishedAt: null,
    updatedAt: "2026-05-02T10:00:00Z",
    blog: { id: "gid://shopify/Blog/1", title: "News" },
    ...overrides,
  };
}

describe("createArticle", () => {
  it("happy path with explicit blogId — sends required fields, returns snapshot", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articleCreate: {
            article: articleResult(),
            userErrors: [],
          },
        },
      },
    ]);

    const result = await createArticle(admin, {
      blogId: "gid://shopify/Blog/1",
      title: "Cat Care Tips",
      body: "<p>Some body.</p>",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      articleId: "gid://shopify/Article/1",
      blogId: "gid://shopify/Blog/1",
      blogTitle: "News",
      title: "Cat Care Tips",
      handle: "cat-care-tips",
      body: "<p>Some body.</p>",
      isPublished: false,
    });
    // The mutation input carries blogId + title + body + isPublished:false default.
    // No optional fields populated.
    expect(admin.calls[0].variables).toEqual({
      article: {
        blogId: "gid://shopify/Blog/1",
        title: "Cat Care Tips",
        body: "<p>Some body.</p>",
        isPublished: false,
      },
    });
  });

  it("blogId omitted — falls back to first blog via blogs(first:1) call", async () => {
    const admin = fakeAdmin([
      // First call: getDefaultBlogId
      {
        kind: "data",
        body: {
          blogs: {
            edges: [
              { node: { id: "gid://shopify/Blog/99", title: "News" } },
            ],
          },
        },
      },
      // Second call: articleCreate
      {
        kind: "data",
        body: {
          articleCreate: {
            article: articleResult({ blog: { id: "gid://shopify/Blog/99", title: "News" } }),
            userErrors: [],
          },
        },
      },
    ]);

    const result = await createArticle(admin, {
      title: "Cat Care Tips",
      body: "<p>Body.</p>",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(admin.calls).toHaveLength(2);
    expect(admin.calls[0].variables).toEqual({ first: 1 });
    // articleCreate uses the resolved blog id.
    const createVars = admin.calls[1].variables as { article: { blogId: string } };
    expect(createVars.article.blogId).toBe("gid://shopify/Blog/99");
  });

  it("blogId omitted AND store has zero blogs — surfaces a clear error", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          blogs: { edges: [] },
        },
      },
    ]);

    const result = await createArticle(admin, {
      title: "Anything",
      body: "<p>Body.</p>",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("store has no blogs");
    // No articleCreate call should have been made.
    expect(admin.calls).toHaveLength(1);
  });

  it("all optional fields — sends nested author/image and tags", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articleCreate: {
            article: articleResult({
              summary: "Quick tips for winter cat care.",
              author: { name: "Dr. Cat" },
              tags: ["winter", "cats"],
              image: { url: "https://cdn.shopify.com/img.jpg" },
              isPublished: true,
              publishedAt: "2026-05-02T10:00:00Z",
            }),
            userErrors: [],
          },
        },
      },
    ]);

    const result = await createArticle(admin, {
      blogId: "gid://shopify/Blog/1",
      title: "Cat Care Tips",
      body: "<p>Body.</p>",
      summary: "Quick tips for winter cat care.",
      author: "Dr. Cat",
      tags: ["winter", "cats"],
      imageUrl: "https://cdn.shopify.com/img.jpg",
      isPublished: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      summary: "Quick tips for winter cat care.",
      author: "Dr. Cat",
      tags: ["winter", "cats"],
      imageUrl: "https://cdn.shopify.com/img.jpg",
      isPublished: true,
    });
    expect(admin.calls[0].variables).toEqual({
      article: {
        blogId: "gid://shopify/Blog/1",
        title: "Cat Care Tips",
        body: "<p>Body.</p>",
        isPublished: true,
        summary: "Quick tips for winter cat care.",
        author: { name: "Dr. Cat" },
        tags: ["winter", "cats"],
        image: { url: "https://cdn.shopify.com/img.jpg" },
      },
    });
  });

  it("default isPublished is FALSE when caller omits it", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articleCreate: { article: articleResult(), userErrors: [] },
        },
      },
    ]);
    await createArticle(admin, {
      blogId: "gid://shopify/Blog/1",
      title: "T",
      body: "<p>B</p>",
    });
    const vars = admin.calls[0].variables as {
      article: { isPublished: boolean };
    };
    expect(vars.article.isPublished).toBe(false);
  });

  it("rejects empty title via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await createArticle(admin, {
      blogId: "gid://shopify/Blog/1",
      title: "",
      body: "<p>B</p>",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty body via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await createArticle(admin, {
      blogId: "gid://shopify/Blog/1",
      title: "T",
      body: "",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects invalid imageUrl (not a URL)", async () => {
    const admin = fakeAdmin([]);
    const result = await createArticle(admin, {
      blogId: "gid://shopify/Blog/1",
      title: "T",
      body: "<p>B</p>",
      imageUrl: "not-a-url",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articleCreate: {
            article: null,
            userErrors: [
              { field: ["article", "title"], message: "Title can't be blank" },
            ],
          },
        },
      },
    ]);
    const result = await createArticle(admin, {
      blogId: "gid://shopify/Blog/1",
      title: "anything",
      body: "<p>B</p>",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Title can't be blank");
  });
});
