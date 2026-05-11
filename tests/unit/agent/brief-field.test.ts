import { describe, expect, it } from "vitest";
import type { FunctionDeclaration } from "@google/genai";

import {
  BRIEF_MAX_LEN,
  extractBrief,
  injectBriefIntoWriteDeclarations,
  stripBrief,
} from "../../../app/lib/agent/brief-field.server";

// Phase Mn Round Mn-1 — `brief` field plumbing tests.
// The injection helper is the single point where every department's
// FunctionDeclarations get the optional `brief` parameter. Extraction +
// stripping are the boundary handlers between the model's tool_use input
// and the dedicated PendingAction.brief column.

describe("injectBriefIntoWriteDeclarations", () => {
  it("injects `brief` only into declarations whose name is in the write set", () => {
    const decls: FunctionDeclaration[] = [
      {
        name: "update_product_price",
        description: "update price",
        parametersJsonSchema: {
          type: "object",
          properties: {
            productId: { type: "string" },
            price: { type: "string" },
          },
          required: ["productId", "price"],
        },
      },
      {
        name: "read_products",
        description: "read products",
        parametersJsonSchema: {
          type: "object",
          properties: { first: { type: "integer" } },
        },
      },
    ];
    const writeSet = new Set(["update_product_price"]);
    const out = injectBriefIntoWriteDeclarations(decls, writeSet);

    const priced = out.find((d) => d.name === "update_product_price")!;
    const pricedProps =
      (priced.parametersJsonSchema as { properties: Record<string, unknown> })
        .properties;
    expect(pricedProps).toHaveProperty("brief");
    expect(pricedProps).toHaveProperty("productId");
    expect(pricedProps).toHaveProperty("price");
    // The `required` array is unchanged — brief is optional.
    const pricedReq =
      (priced.parametersJsonSchema as { required: string[] }).required;
    expect(pricedReq).toEqual(["productId", "price"]);

    // Read tool is untouched.
    const read = out.find((d) => d.name === "read_products")!;
    const readProps =
      (read.parametersJsonSchema as { properties: Record<string, unknown> })
        .properties;
    expect(readProps).not.toHaveProperty("brief");
  });

  it("returns a new array — inputs are not mutated", () => {
    const decls: FunctionDeclaration[] = [
      {
        name: "update_product_status",
        description: "x",
        parametersJsonSchema: {
          type: "object",
          properties: { productId: { type: "string" } },
        },
      },
    ];
    const out = injectBriefIntoWriteDeclarations(
      decls,
      new Set(["update_product_status"]),
    );
    // Original untouched.
    const origProps =
      (decls[0].parametersJsonSchema as { properties: Record<string, unknown> })
        .properties;
    expect(origProps).not.toHaveProperty("brief");
    // New copy has brief.
    const newProps =
      (out[0].parametersJsonSchema as { properties: Record<string, unknown> })
        .properties;
    expect(newProps).toHaveProperty("brief");
  });

  it("is idempotent — re-running on an already-injected declaration is a no-op", () => {
    const decls: FunctionDeclaration[] = [
      {
        name: "update_product_status",
        description: "x",
        parametersJsonSchema: {
          type: "object",
          properties: {
            productId: { type: "string" },
            brief: { type: "string", description: "existing" },
          },
        },
      },
    ];
    const out = injectBriefIntoWriteDeclarations(
      decls,
      new Set(["update_product_status"]),
    );
    // Same reference — short-circuited.
    expect(out[0]).toBe(decls[0]);
  });

  it("leaves declarations without parametersJsonSchema untouched", () => {
    const decls: FunctionDeclaration[] = [
      {
        name: "weird_tool",
        description: "no schema",
      },
    ];
    const out = injectBriefIntoWriteDeclarations(
      decls,
      new Set(["weird_tool"]),
    );
    expect(out[0]).toBe(decls[0]);
  });
});

describe("extractBrief", () => {
  it("returns trimmed string for a valid brief", () => {
    expect(extractBrief({ brief: "  hello world  " })).toBe("hello world");
  });

  it("returns null when brief is missing", () => {
    expect(extractBrief({ productId: "x" })).toBeNull();
  });

  it("returns null when brief is empty / whitespace", () => {
    expect(extractBrief({ brief: "" })).toBeNull();
    expect(extractBrief({ brief: "   " })).toBeNull();
  });

  it("returns null when brief is non-string", () => {
    expect(extractBrief({ brief: 123 })).toBeNull();
    expect(extractBrief({ brief: null })).toBeNull();
    expect(extractBrief({ brief: { nested: true } })).toBeNull();
  });

  it("truncates briefs that exceed BRIEF_MAX_LEN", () => {
    const long = "x".repeat(BRIEF_MAX_LEN + 50);
    const out = extractBrief({ brief: long });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(BRIEF_MAX_LEN);
  });

  it("returns null when input is not an object", () => {
    expect(extractBrief(null)).toBeNull();
    expect(extractBrief("string")).toBeNull();
    expect(extractBrief(42)).toBeNull();
  });
});

describe("stripBrief", () => {
  it("removes the `brief` key, preserves the rest", () => {
    const stripped = stripBrief({
      productId: "gid://shopify/Product/1",
      price: "19.99",
      brief: "weekend sale",
    });
    expect(stripped).toEqual({
      productId: "gid://shopify/Product/1",
      price: "19.99",
    });
  });

  it("returns the same object reference when no brief present (no-op)", () => {
    const input = { productId: "x", price: "1.00" };
    const out = stripBrief(input);
    expect(out).toBe(input);
  });

  it("returns the input unchanged for non-object values", () => {
    expect(stripBrief(null)).toBeNull();
    expect(stripBrief("hello")).toBe("hello");
  });
});
