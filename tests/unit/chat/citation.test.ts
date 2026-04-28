import { describe, expect, it } from "vitest";

import { parseCitationHref } from "../../../app/components/chat/citation";

const SHOP = "test-store.myshopify.com";

describe("parseCitationHref", () => {
  it("returns null for nullish/empty hrefs", () => {
    expect(parseCitationHref(null, SHOP)).toBeNull();
    expect(parseCitationHref(undefined, SHOP)).toBeNull();
    expect(parseCitationHref("", SHOP)).toBeNull();
    expect(parseCitationHref("   ", SHOP)).toBeNull();
  });

  it("passes http(s) links through as external", () => {
    const r = parseCitationHref("https://shopify.dev/docs", SHOP);
    expect(r).toEqual({
      kind: "external",
      url: "https://shopify.dev/docs",
      external: true,
    });
  });

  it("passes mailto links through as external", () => {
    const r = parseCitationHref("mailto:owner@store.com", SHOP);
    expect(r?.kind).toBe("external");
    expect(r?.external).toBe(true);
  });

  it("passes anchor-only links through as internal", () => {
    const r = parseCitationHref("#summary", SHOP);
    expect(r).toEqual({
      kind: "external",
      url: "#summary",
      external: false,
    });
  });

  it("returns null for unrecognized scheme", () => {
    expect(parseCitationHref("bogus:xyz", SHOP)).toBeNull();
  });

  describe("analytics:", () => {
    it("routes to /app/dashboard with sanitized hash", () => {
      const r = parseCitationHref("analytics:revenue-30d", SHOP);
      expect(r).toEqual({
        kind: "analytics",
        url: "/app/dashboard#revenue-30d",
        external: false,
      });
    });

    it("strips unsafe characters from the ref", () => {
      const r = parseCitationHref("analytics:rev<script>", SHOP);
      expect(r?.url).toBe("/app/dashboard#revscript");
    });

    it("falls back to no hash when ref sanitizes to empty", () => {
      const r = parseCitationHref("analytics:!!!", SHOP);
      expect(r?.url).toBe("/app/dashboard");
    });
  });

  describe("product:", () => {
    it("builds an admin URL when shopDomain + GID are valid", () => {
      const r = parseCitationHref(
        "product:gid://shopify/Product/12345",
        SHOP,
      );
      expect(r).toEqual({
        kind: "product",
        url: "https://admin.shopify.com/store/test-store/products/12345",
        external: true,
      });
    });

    it("returns null when shopDomain is missing", () => {
      const r = parseCitationHref(
        "product:gid://shopify/Product/12345",
        null,
      );
      expect(r).toBeNull();
    });

    it("returns null for malformed GID", () => {
      expect(
        parseCitationHref("product:not-a-gid", SHOP),
      ).toBeNull();
      expect(
        parseCitationHref("product:gid://shopify/ProductVariant/9", SHOP),
      ).toBeNull();
    });
  });

  describe("memory:", () => {
    it("routes to /app/settings/memory with the entry id as hash", () => {
      const r = parseCitationHref("memory:cmwxyz123", SHOP);
      expect(r).toEqual({
        kind: "memory",
        url: "/app/settings/memory#cmwxyz123",
        external: false,
      });
    });

    it("strips unsafe characters", () => {
      const r = parseCitationHref("memory:abc<script>", SHOP);
      expect(r?.url).toBe("/app/settings/memory#abcscript");
    });

    it("returns null when id sanitizes to empty", () => {
      expect(parseCitationHref("memory:!!!", SHOP)).toBeNull();
    });
  });

  it("schemes are case-insensitive", () => {
    expect(parseCitationHref("ANALYTICS:revenue", SHOP)?.kind).toBe(
      "analytics",
    );
    expect(parseCitationHref("Memory:abc123", SHOP)?.kind).toBe("memory");
  });
});
