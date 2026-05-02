import { describe, expect, it } from "vitest";

import {
  addProductImage,
  fetchProductMedia,
  removeProductImage,
  reorderProductImages,
} from "../../../app/lib/shopify/products.server";
import { fakeAdmin } from "../../helpers/fake-admin";

describe("addProductImage", () => {
  it("happy path — uploads from HTTPS URL with alt text", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productCreateMedia: {
            media: [
              {
                id: "gid://shopify/MediaImage/1",
                alt: "A photo of cat food",
                mediaContentType: "IMAGE",
                status: "PROCESSING",
                preview: { image: { url: "https://cdn.shopify.com/preview1.jpg" } },
              },
            ],
            mediaUserErrors: [],
          },
        },
      },
    ]);

    const result = await addProductImage(admin, {
      productId: "gid://shopify/Product/1",
      imageUrl: "https://example.com/cat.jpg",
      altText: "A photo of cat food",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      productId: "gid://shopify/Product/1",
      mediaId: "gid://shopify/MediaImage/1",
      alt: "A photo of cat food",
      status: "PROCESSING",
      previewUrl: "https://cdn.shopify.com/preview1.jpg",
    });
    expect(admin.calls[0].variables).toEqual({
      productId: "gid://shopify/Product/1",
      media: [
        {
          originalSource: "https://example.com/cat.jpg",
          mediaContentType: "IMAGE",
          alt: "A photo of cat food",
        },
      ],
    });
  });

  it("omits alt when not provided", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productCreateMedia: {
            media: [
              {
                id: "gid://shopify/MediaImage/2",
                alt: null,
                mediaContentType: "IMAGE",
                status: "READY",
                preview: { image: { url: "https://cdn.shopify.com/preview2.jpg" } },
              },
            ],
            mediaUserErrors: [],
          },
        },
      },
    ]);
    const result = await addProductImage(admin, {
      productId: "gid://shopify/Product/1",
      imageUrl: "https://example.com/cat2.jpg",
    });
    expect(result.ok).toBe(true);
    expect(admin.calls[0].variables).toEqual({
      productId: "gid://shopify/Product/1",
      media: [
        {
          originalSource: "https://example.com/cat2.jpg",
          mediaContentType: "IMAGE",
        },
      ],
    });
  });

  it("rejects http:// URLs (Shopify requires HTTPS)", async () => {
    const admin = fakeAdmin([]);
    const result = await addProductImage(admin, {
      productId: "gid://shopify/Product/1",
      imageUrl: "http://example.com/cat.jpg",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify mediaUserErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productCreateMedia: {
            media: [],
            mediaUserErrors: [{ field: ["media", "0", "originalSource"], message: "Unable to download image" }],
          },
        },
      },
    ]);
    const result = await addProductImage(admin, {
      productId: "gid://shopify/Product/1",
      imageUrl: "https://broken.example.com/missing.jpg",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Unable to download image");
  });
});

describe("removeProductImage", () => {
  it("happy path — deletes a single media id", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productDeleteMedia: {
            deletedMediaIds: ["gid://shopify/MediaImage/1"],
            mediaUserErrors: [],
          },
        },
      },
    ]);

    const result = await removeProductImage(admin, {
      productId: "gid://shopify/Product/1",
      mediaId: "gid://shopify/MediaImage/1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      productId: "gid://shopify/Product/1",
      removedMediaId: "gid://shopify/MediaImage/1",
    });
    expect(admin.calls[0].variables).toEqual({
      productId: "gid://shopify/Product/1",
      mediaIds: ["gid://shopify/MediaImage/1"],
    });
  });

  it("returns an error when no media was deleted (mediaId mismatch)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productDeleteMedia: {
            deletedMediaIds: [],
            mediaUserErrors: [],
          },
        },
      },
    ]);
    const result = await removeProductImage(admin, {
      productId: "gid://shopify/Product/1",
      mediaId: "gid://shopify/MediaImage/wrong",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no deletedMediaIds");
  });

  it("surfaces shopify mediaUserErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productDeleteMedia: {
            deletedMediaIds: null,
            mediaUserErrors: [{ field: ["mediaIds", "0"], message: "Media not found" }],
          },
        },
      },
    ]);
    const result = await removeProductImage(admin, {
      productId: "gid://shopify/Product/1",
      mediaId: "gid://shopify/MediaImage/missing",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Media not found");
  });
});

describe("reorderProductImages", () => {
  it("happy path — converts orderedMediaIds to moves[] with stringified positions", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productReorderMedia: {
            job: { id: "gid://shopify/Job/1", done: false },
            mediaUserErrors: [],
          },
        },
      },
    ]);

    const result = await reorderProductImages(admin, {
      productId: "gid://shopify/Product/1",
      orderedMediaIds: [
        "gid://shopify/MediaImage/B",
        "gid://shopify/MediaImage/A",
        "gid://shopify/MediaImage/C",
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      productId: "gid://shopify/Product/1",
      jobId: "gid://shopify/Job/1",
      done: false,
      newOrder: [
        "gid://shopify/MediaImage/B",
        "gid://shopify/MediaImage/A",
        "gid://shopify/MediaImage/C",
      ],
    });
    expect(admin.calls[0].variables).toEqual({
      id: "gid://shopify/Product/1",
      moves: [
        { id: "gid://shopify/MediaImage/B", newPosition: "0" },
        { id: "gid://shopify/MediaImage/A", newPosition: "1" },
        { id: "gid://shopify/MediaImage/C", newPosition: "2" },
      ],
    });
  });

  it("rejects empty orderedMediaIds via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await reorderProductImages(admin, {
      productId: "gid://shopify/Product/1",
      orderedMediaIds: [],
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("surfaces shopify mediaUserErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productReorderMedia: {
            job: null,
            mediaUserErrors: [{ field: ["moves", "0", "id"], message: "Media not found on product" }],
          },
        },
      },
    ]);
    const result = await reorderProductImages(admin, {
      productId: "gid://shopify/Product/1",
      orderedMediaIds: ["gid://shopify/MediaImage/wrong"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Media not found on product");
  });

  it("handles missing job gracefully (jobId null, done false)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          productReorderMedia: {
            job: null,
            mediaUserErrors: [],
          },
        },
      },
    ]);
    const result = await reorderProductImages(admin, {
      productId: "gid://shopify/Product/1",
      orderedMediaIds: ["gid://shopify/MediaImage/A"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.jobId).toBeNull();
    expect(result.data.done).toBe(false);
  });
});

describe("fetchProductMedia", () => {
  it("returns the AuditLog before-state with full media listing", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
            media: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/MediaImage/1",
                    alt: "First image",
                    mediaContentType: "IMAGE",
                    status: "READY",
                    preview: { image: { url: "https://cdn.shopify.com/p1.jpg" } },
                  },
                },
                {
                  node: {
                    id: "gid://shopify/MediaImage/2",
                    alt: null,
                    mediaContentType: "IMAGE",
                    status: "READY",
                    preview: { image: { url: "https://cdn.shopify.com/p2.jpg" } },
                  },
                },
              ],
            },
          },
        },
      },
    ]);
    const result = await fetchProductMedia(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.media).toHaveLength(2);
    expect(result.data.media[0]).toEqual({
      mediaId: "gid://shopify/MediaImage/1",
      alt: "First image",
      mediaContentType: "IMAGE",
      status: "READY",
      previewUrl: "https://cdn.shopify.com/p1.jpg",
    });
    expect(result.data.media[1].previewUrl).toBe("https://cdn.shopify.com/p2.jpg");
  });

  it("normalizes missing preview/image to null previewUrl", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cat Food",
            media: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/MediaImage/3",
                    alt: null,
                    mediaContentType: "IMAGE",
                    status: "PROCESSING",
                    preview: null,
                  },
                },
              ],
            },
          },
        },
      },
    ]);
    const result = await fetchProductMedia(admin, "gid://shopify/Product/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.media[0].previewUrl).toBeNull();
  });

  it("returns ok:false if product is null", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { product: null } }]);
    const result = await fetchProductMedia(admin, "gid://shopify/Product/missing");
    expect(result.ok).toBe(false);
  });
});
