import { describe, expect, it } from "vitest";

import {
  ARTIFACT_KIND_VALUES,
  DescriptionArtifactContentSchema,
  ProposeArtifactInputSchema,
  artifactSummary,
  isArtifactStatus,
  type ArtifactRow,
} from "../../../app/lib/agent/artifacts.server";

describe("DescriptionArtifactContentSchema", () => {
  it("accepts a minimal valid description content", () => {
    const r = DescriptionArtifactContentSchema.safeParse({
      productId: "gid://shopify/Product/123",
      productTitle: "Cat Food",
      html: "<p>Premium cat food.</p>",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty productId", () => {
    const r = DescriptionArtifactContentSchema.safeParse({
      productId: "",
      productTitle: "Cat Food",
      html: "<p>x</p>",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty productTitle", () => {
    const r = DescriptionArtifactContentSchema.safeParse({
      productId: "gid://shopify/Product/123",
      productTitle: "",
      html: "<p>x</p>",
    });
    expect(r.success).toBe(false);
  });

  it("accepts an empty html body (merchant cleared the draft)", () => {
    // The Approve button is disabled in the panel when html is empty,
    // but the schema itself shouldn't reject — autosave should still
    // persist the empty state so the merchant doesn't lose their wipe.
    const r = DescriptionArtifactContentSchema.safeParse({
      productId: "gid://shopify/Product/123",
      productTitle: "Cat Food",
      html: "",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an oversize html body (>50k chars)", () => {
    const r = DescriptionArtifactContentSchema.safeParse({
      productId: "gid://shopify/Product/123",
      productTitle: "Cat Food",
      html: "x".repeat(50_001),
    });
    expect(r.success).toBe(false);
  });
});

describe("ProposeArtifactInputSchema", () => {
  it("accepts a valid description input", () => {
    const r = ProposeArtifactInputSchema.safeParse({
      kind: "description",
      productId: "gid://shopify/Product/123",
      productTitle: "Cat Food",
      content: "<p>Premium cat food.</p>",
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown kinds", () => {
    const r = ProposeArtifactInputSchema.safeParse({
      kind: "discount-config",
      productId: "gid://shopify/Product/123",
      productTitle: "Cat Food",
      content: "<p>x</p>",
    });
    expect(r.success).toBe(false);
  });

  it("requires all fields", () => {
    const r = ProposeArtifactInputSchema.safeParse({
      kind: "description",
      productId: "gid://shopify/Product/123",
      // missing productTitle + content
    });
    expect(r.success).toBe(false);
  });
});

describe("ARTIFACT_KIND_VALUES", () => {
  it("ships with description as the only kind in V2.5", () => {
    expect(ARTIFACT_KIND_VALUES).toEqual(["description"]);
  });
});

describe("isArtifactStatus", () => {
  it.each(["DRAFT", "APPROVED", "REJECTED", "DISCARDED"])(
    "accepts %s",
    (s) => {
      expect(isArtifactStatus(s)).toBe(true);
    },
  );

  it("rejects unknown statuses", () => {
    expect(isArtifactStatus("PENDING")).toBe(false);
    expect(isArtifactStatus("draft")).toBe(false); // case-sensitive
    expect(isArtifactStatus("")).toBe(false);
  });
});

describe("artifactSummary", () => {
  function makeRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
    return {
      id: "art_1",
      storeId: "store_1",
      conversationId: "conv_1",
      messageId: null,
      toolCallId: "tc_1",
      kind: "description",
      content: {
        productId: "gid://shopify/Product/123",
        productTitle: "Cat Food",
        html: "<p>Premium cat food made fresh daily.</p>",
      },
      status: "DRAFT",
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z",
      ...overrides,
    };
  }

  it("returns artifact id, kind, status, productTitle, charCount, preview", () => {
    const s = artifactSummary(makeRow());
    expect(s).toEqual({
      artifactId: "art_1",
      kind: "description",
      status: "DRAFT",
      productTitle: "Cat Food",
      charCount: "<p>Premium cat food made fresh daily.</p>".length,
      preview: "<p>Premium cat food made fresh daily.</p>",
    });
  });

  it("truncates preview at 200 chars and adds an ellipsis", () => {
    const long = "x".repeat(250);
    const s = artifactSummary(
      makeRow({
        content: {
          productId: "gid://shopify/Product/1",
          productTitle: "T",
          html: long,
        },
      }),
    );
    expect(s.preview).toBe(long.slice(0, 200) + "…");
    expect(s.charCount).toBe(250);
  });

  it("does NOT add ellipsis at exactly 200 chars", () => {
    const exact = "x".repeat(200);
    const s = artifactSummary(
      makeRow({
        content: {
          productId: "gid://shopify/Product/1",
          productTitle: "T",
          html: exact,
        },
      }),
    );
    expect(s.preview).toBe(exact);
    expect(s.charCount).toBe(200);
  });
});
