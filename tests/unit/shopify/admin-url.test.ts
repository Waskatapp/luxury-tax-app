import { describe, expect, it } from "vitest";

import {
  buildProductAdminUrl,
  extractProductIdFromSnapshot,
  extractProductTitleFromSnapshot,
  numericProductId,
  shopHandle,
} from "../../../app/lib/shopify/admin-url";

describe("shopHandle", () => {
  it("returns the subdomain part of a normal myshopify domain", () => {
    expect(shopHandle("my-store.myshopify.com")).toBe("my-store");
    expect(shopHandle("luxurytax.myshopify.com")).toBe("luxurytax");
  });

  it("strips http:// or https:// prefix if present", () => {
    expect(shopHandle("https://shop.myshopify.com")).toBe("shop");
    expect(shopHandle("http://shop.myshopify.com")).toBe("shop");
  });

  it("lowercases the handle", () => {
    expect(shopHandle("MyStore.myshopify.com")).toBe("mystore");
  });

  it("returns null for non-myshopify domains", () => {
    expect(shopHandle("example.com")).toBeNull();
    expect(shopHandle("admin.shopify.com")).toBeNull();
    expect(shopHandle("not-a-domain")).toBeNull();
  });

  it("returns null for empty / null / undefined input", () => {
    expect(shopHandle("")).toBeNull();
    expect(shopHandle(null)).toBeNull();
    expect(shopHandle(undefined)).toBeNull();
  });
});

describe("numericProductId", () => {
  it("extracts the numeric tail from a Product GID", () => {
    expect(numericProductId("gid://shopify/Product/12345")).toBe("12345");
    expect(numericProductId("gid://shopify/Product/7636073939057")).toBe(
      "7636073939057",
    );
  });

  it("returns null for non-Product GIDs", () => {
    expect(numericProductId("gid://shopify/ProductVariant/1")).toBeNull();
    expect(numericProductId("gid://shopify/Order/1")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(numericProductId("12345")).toBeNull();
    expect(numericProductId("gid://shopify/Product/")).toBeNull();
    expect(numericProductId("gid://shopify/Product/abc")).toBeNull();
    expect(numericProductId("")).toBeNull();
    expect(numericProductId(null)).toBeNull();
  });
});

describe("buildProductAdminUrl", () => {
  it("returns the modern admin URL when both pieces are valid", () => {
    expect(
      buildProductAdminUrl(
        "luxurytax.myshopify.com",
        "gid://shopify/Product/777",
      ),
    ).toBe("https://admin.shopify.com/store/luxurytax/products/777");
  });

  it("returns null when shop handle is missing/malformed", () => {
    expect(
      buildProductAdminUrl("example.com", "gid://shopify/Product/1"),
    ).toBeNull();
    expect(
      buildProductAdminUrl(null, "gid://shopify/Product/1"),
    ).toBeNull();
    expect(
      buildProductAdminUrl("", "gid://shopify/Product/1"),
    ).toBeNull();
  });

  it("returns null when product GID is missing/malformed", () => {
    expect(
      buildProductAdminUrl("shop.myshopify.com", null),
    ).toBeNull();
    expect(
      buildProductAdminUrl("shop.myshopify.com", "gid://shopify/Variant/1"),
    ).toBeNull();
  });
});

describe("extractProductIdFromSnapshot", () => {
  it("pulls productId from a price snapshot", () => {
    const before = {
      variantId: "gid://shopify/ProductVariant/1",
      productId: "gid://shopify/Product/9",
      productTitle: "cat food",
      price: "20.00",
    };
    expect(
      extractProductIdFromSnapshot("update_product_price", before, null),
    ).toBe("gid://shopify/Product/9");
  });

  it("pulls productId from a description snapshot", () => {
    const before = {
      productId: "gid://shopify/Product/42",
      title: "cat food",
      descriptionHtml: "<p>Tasty.</p>",
    };
    expect(
      extractProductIdFromSnapshot("update_product_description", before, null),
    ).toBe("gid://shopify/Product/42");
  });

  it("falls back to toolInput.productId when snapshot is null", () => {
    expect(
      extractProductIdFromSnapshot(
        "update_product_status",
        null,
        { productId: "gid://shopify/Product/1", status: "DRAFT" },
      ),
    ).toBe("gid://shopify/Product/1");
  });

  it("returns null for create_discount even if toolInput has fields", () => {
    expect(
      extractProductIdFromSnapshot("create_discount", null, {
        title: "Summer 20%",
        percentOff: 20,
      }),
    ).toBeNull();
  });

  it("returns null for create_product_draft (product doesn't exist yet)", () => {
    expect(
      extractProductIdFromSnapshot("create_product_draft", null, {
        title: "New product",
      }),
    ).toBeNull();
  });

  it("returns null when neither snapshot nor toolInput has a productId", () => {
    expect(
      extractProductIdFromSnapshot("update_product_status", null, null),
    ).toBeNull();
    expect(
      extractProductIdFromSnapshot("update_product_description", {}, {}),
    ).toBeNull();
  });
});

describe("extractProductTitleFromSnapshot", () => {
  it("prefers productTitle (used by price snapshots)", () => {
    expect(
      extractProductTitleFromSnapshot({
        productTitle: "cat food",
        title: "wrong",
      }),
    ).toBe("cat food");
  });

  it("falls back to title (used by description/status snapshots)", () => {
    expect(
      extractProductTitleFromSnapshot({
        title: "dog food",
        descriptionHtml: "<p>woof</p>",
      }),
    ).toBe("dog food");
  });

  it("returns null when neither is present", () => {
    expect(extractProductTitleFromSnapshot({})).toBeNull();
    expect(extractProductTitleFromSnapshot(null)).toBeNull();
    expect(extractProductTitleFromSnapshot(undefined)).toBeNull();
    expect(extractProductTitleFromSnapshot("not an object")).toBeNull();
  });

  it("treats empty-string title as missing", () => {
    expect(
      extractProductTitleFromSnapshot({ productTitle: "", title: "" }),
    ).toBeNull();
  });
});
