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
  it("happy path with explicit blogId + author — single mutation call (no shop fallback)", async () => {
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
      author: "Jane",
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
    // Only the articleCreate mutation runs — explicit author skips the shop
    // owner fallback fetch, blogId provided skips the blogs(first:1) fetch.
    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0].variables).toEqual({
      article: {
        blogId: "gid://shopify/Blog/1",
        title: "Cat Care Tips",
        body: "<p>Some body.</p>",
        isPublished: false,
        author: { name: "Jane" },
      },
    });
  });

  it("author omitted — falls back to shop name via shop { name } query", async () => {
    // Shopify's ArticleCreateInput.author is REQUIRED (AuthorInput!). When
    // the caller doesn't pass one we fetch shop.name and use it. The bug
    // we're guarding against: omitting author entirely caused
    // "Variable $article ... Expected value to not be null" GraphQL errors.
    const admin = fakeAdmin([
      {
        kind: "data",
        body: { shop: { name: "MyStore" } },
      },
      {
        kind: "data",
        body: {
          articleCreate: {
            article: articleResult({ author: { name: "MyStore" } }),
            userErrors: [],
          },
        },
      },
    ]);

    const result = await createArticle(admin, {
      blogId: "gid://shopify/Blog/1",
      title: "Cat Care Tips",
      body: "<p>Body.</p>",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.author).toBe("MyStore");
    expect(admin.calls).toHaveLength(2);
    // Second call (articleCreate) must include the resolved author.
    const createVars = admin.calls[1].variables as {
      article: { author: { name: string } };
    };
    expect(createVars.article.author).toEqual({ name: "MyStore" });
  });

  it("blogId AND author omitted — chains blogs lookup, shop lookup, then create", async () => {
    const admin = fakeAdmin([
      // 1. getDefaultBlogId — blogs(first:1)
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
      // 2. getDefaultAuthorName — shop { name }
      {
        kind: "data",
        body: { shop: { name: "MyStore" } },
      },
      // 3. articleCreate
      {
        kind: "data",
        body: {
          articleCreate: {
            article: articleResult({
              blog: { id: "gid://shopify/Blog/99", title: "News" },
              author: { name: "MyStore" },
            }),
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
    expect(admin.calls).toHaveLength(3);
    expect(admin.calls[0].variables).toEqual({ first: 1 });
    // articleCreate uses the resolved blog id and author.
    const createVars = admin.calls[2].variables as {
      article: { blogId: string; author: { name: string } };
    };
    expect(createVars.article.blogId).toBe("gid://shopify/Blog/99");
    expect(createVars.article.author).toEqual({ name: "MyStore" });
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
      author: "Jane",
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
      author: "Jane",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Title can't be blank");
  });
});
