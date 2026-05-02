import { describe, expect, it } from "vitest";

import { deleteArticle } from "../../../app/lib/shopify/articles.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function fetchArticleResponse(title: string) {
  return {
    kind: "data" as const,
    body: {
      article: {
        id: "gid://shopify/Article/1",
        title,
        handle: "cat-care-tips",
        body: "<p>Some body.</p>",
        summary: null,
        author: { name: "Jane" },
        tags: [],
        image: null,
        isPublished: true,
        publishedAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
        blog: { id: "gid://shopify/Blog/1", title: "News" },
      },
    },
  };
}

describe("deleteArticle", () => {
  it("happy path — fetches snapshot, confirms title, issues delete", async () => {
    const admin = fakeAdmin([
      fetchArticleResponse("Cat Care Tips"),
      {
        kind: "data",
        body: {
          articleDelete: {
            deletedArticleId: "gid://shopify/Article/1",
            userErrors: [],
          },
        },
      },
    ]);

    const result = await deleteArticle(admin, {
      articleId: "gid://shopify/Article/1",
      confirmTitle: "Cat Care Tips",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      deletedArticleId: "gid://shopify/Article/1",
      title: "Cat Care Tips",
    });
    // Two calls: snapshot fetch, then delete mutation.
    expect(admin.calls).toHaveLength(2);
    expect(admin.calls[1].variables).toEqual({
      id: "gid://shopify/Article/1",
    });
  });

  it("confirmTitle case-insensitive — 'cat care tips' matches 'Cat Care Tips'", async () => {
    const admin = fakeAdmin([
      fetchArticleResponse("Cat Care Tips"),
      {
        kind: "data",
        body: {
          articleDelete: {
            deletedArticleId: "gid://shopify/Article/1",
            userErrors: [],
          },
        },
      },
    ]);
    const result = await deleteArticle(admin, {
      articleId: "gid://shopify/Article/1",
      confirmTitle: "cat care tips",
    });
    expect(result.ok).toBe(true);
  });

  it("confirmTitle whitespace-trimmed — '  Cat Care Tips  ' matches", async () => {
    const admin = fakeAdmin([
      fetchArticleResponse("Cat Care Tips"),
      {
        kind: "data",
        body: {
          articleDelete: {
            deletedArticleId: "gid://shopify/Article/1",
            userErrors: [],
          },
        },
      },
    ]);
    const result = await deleteArticle(admin, {
      articleId: "gid://shopify/Article/1",
      confirmTitle: "  Cat Care Tips  ",
    });
    expect(result.ok).toBe(true);
  });

  it("confirmTitle mismatch — refuses to delete, no mutation issued", async () => {
    const admin = fakeAdmin([
      // Only the fetchArticle call should happen — delete must not fire.
      fetchArticleResponse("Cat Care Tips"),
    ]);
    const result = await deleteArticle(admin, {
      articleId: "gid://shopify/Article/1",
      confirmTitle: "Winter Tips", // wrong title
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("confirmTitle mismatch");
    expect(result.error).toContain("Cat Care Tips");
    expect(result.error).toContain("Winter Tips");
    // Only the snapshot read happened, no delete mutation.
    expect(admin.calls).toHaveLength(1);
  });

  it("rejects empty confirmTitle via Zod (defensive gate can't be sidestepped with '')", async () => {
    const admin = fakeAdmin([]);
    const result = await deleteArticle(admin, {
      articleId: "gid://shopify/Article/1",
      confirmTitle: "",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects whitespace-only confirmTitle via Zod refine", async () => {
    const admin = fakeAdmin([]);
    const result = await deleteArticle(admin, {
      articleId: "gid://shopify/Article/1",
      confirmTitle: "   ",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("confirmTitle");
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty articleId", async () => {
    const admin = fakeAdmin([]);
    const result = await deleteArticle(admin, {
      articleId: "",
      confirmTitle: "anything",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces error if article doesn't exist (snapshot fetch fails)", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { article: null } }]);
    const result = await deleteArticle(admin, {
      articleId: "gid://shopify/Article/missing",
      confirmTitle: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("article not found");
    // No delete mutation issued.
    expect(admin.calls).toHaveLength(1);
  });

  it("surfaces shopify userErrors from articleDelete", async () => {
    const admin = fakeAdmin([
      fetchArticleResponse("Cat Care Tips"),
      {
        kind: "data",
        body: {
          articleDelete: {
            deletedArticleId: null,
            userErrors: [
              { field: ["id"], message: "Cannot delete published article" },
            ],
          },
        },
      },
    ]);
    const result = await deleteArticle(admin, {
      articleId: "gid://shopify/Article/1",
      confirmTitle: "Cat Care Tips",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Cannot delete published article");
  });

  it("surfaces error when articleDelete returns null id with no userErrors", async () => {
    const admin = fakeAdmin([
      fetchArticleResponse("Cat Care Tips"),
      {
        kind: "data",
        body: {
          articleDelete: {
            deletedArticleId: null,
            userErrors: [],
          },
        },
      },
    ]);
    const result = await deleteArticle(admin, {
      articleId: "gid://shopify/Article/1",
      confirmTitle: "Cat Care Tips",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no deletedArticleId");
  });
});
