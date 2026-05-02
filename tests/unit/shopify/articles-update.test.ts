import { describe, expect, it } from "vitest";

import {
  fetchArticle,
  updateArticle,
} from "../../../app/lib/shopify/articles.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function articleResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/Article/1",
    title: "Cat Care Tips",
    handle: "cat-care-tips",
    body: "<p>Body.</p>",
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

describe("updateArticle", () => {
  it("happy path — updates title only, sends only the changed field", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articleUpdate: {
            article: articleResult({ title: "Winter Cat Care Guide" }),
            userErrors: [],
          },
        },
      },
    ]);

    const result = await updateArticle(admin, {
      articleId: "gid://shopify/Article/1",
      title: "Winter Cat Care Guide",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.title).toBe("Winter Cat Care Guide");
    expect(admin.calls[0].variables).toEqual({
      id: "gid://shopify/Article/1",
      article: { title: "Winter Cat Care Guide" },
    });
  });

  it("publish toggle — isPublished:true sent through verbatim", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articleUpdate: {
            article: articleResult({
              isPublished: true,
              publishedAt: "2026-05-02T10:00:00Z",
            }),
            userErrors: [],
          },
        },
      },
    ]);
    const result = await updateArticle(admin, {
      articleId: "gid://shopify/Article/1",
      isPublished: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isPublished).toBe(true);
    expect(admin.calls[0].variables).toMatchObject({
      article: { isPublished: true },
    });
  });

  it("imageUrl: null clears the image (sends image: null)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articleUpdate: {
            article: articleResult({ image: null }),
            userErrors: [],
          },
        },
      },
    ]);
    await updateArticle(admin, {
      articleId: "gid://shopify/Article/1",
      imageUrl: null,
    });
    const vars = admin.calls[0].variables as {
      article: Record<string, unknown>;
    };
    expect(vars.article).toEqual({ image: null });
  });

  it("imageUrl: '<url>' sets a new image", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articleUpdate: {
            article: articleResult({
              image: { url: "https://cdn.shopify.com/new.jpg" },
            }),
            userErrors: [],
          },
        },
      },
    ]);
    await updateArticle(admin, {
      articleId: "gid://shopify/Article/1",
      imageUrl: "https://cdn.shopify.com/new.jpg",
    });
    const vars = admin.calls[0].variables as {
      article: Record<string, unknown>;
    };
    expect(vars.article).toEqual({
      image: { url: "https://cdn.shopify.com/new.jpg" },
    });
  });

  it("multiple fields — all included in the mutation input", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          articleUpdate: {
            article: articleResult({
              title: "Updated",
              tags: ["a", "b"],
              author: { name: "Dr. New" },
              isPublished: true,
            }),
            userErrors: [],
          },
        },
      },
    ]);
    await updateArticle(admin, {
      articleId: "gid://shopify/Article/1",
      title: "Updated",
      tags: ["a", "b"],
      author: "Dr. New",
      isPublished: true,
    });
    expect(admin.calls[0].variables).toEqual({
      id: "gid://shopify/Article/1",
      article: {
        title: "Updated",
        tags: ["a", "b"],
        author: { name: "Dr. New" },
        isPublished: true,
      },
    });
  });

  it("rejects when no update field provided (Zod refine guard)", async () => {
    const admin = fakeAdmin([]);
    const result = await updateArticle(admin, {
      articleId: "gid://shopify/Article/1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("at least one field to update");
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty articleId", async () => {
    const admin = fakeAdmin([]);
    const result = await updateArticle(admin, {
      articleId: "",
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
          articleUpdate: {
            article: null,
            userErrors: [
              { field: ["article", "body"], message: "Body is too long" },
            ],
          },
        },
      },
    ]);
    const result = await updateArticle(admin, {
      articleId: "gid://shopify/Article/1",
      body: "<p>B</p>",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Body is too long");
  });
});

describe("fetchArticle", () => {
  it("returns the snapshot used for the AuditLog before-state", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          article: articleResult({
            title: "Original",
            body: "<p>Original body.</p>",
            tags: ["original"],
          }),
        },
      },
    ]);
    const result = await fetchArticle(admin, "gid://shopify/Article/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.title).toBe("Original");
    expect(result.data.body).toBe("<p>Original body.</p>");
    expect(result.data.tags).toEqual(["original"]);
    expect(result.data.blogId).toBe("gid://shopify/Blog/1");
  });

  it("returns ok:false if article is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { article: null } }]);
    const result = await fetchArticle(admin, "gid://shopify/Article/missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("article not found");
  });
});
