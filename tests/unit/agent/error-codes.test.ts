import { describe, expect, it } from "vitest";

import {
  classifyError,
  errorMessage,
} from "../../../app/lib/agent/error-codes";

describe("classifyError — pattern matching", () => {
  it("classifies Gemini RPD daily-quota errors as RATE_LIMITED_DAILY (not retryable)", () => {
    const r = classifyError(
      "GoogleGenerativeAIError: quota exceeded for metric 'generativelanguage.googleapis.com/generate_content_requests' per day",
    );
    expect(r.code).toBe("RATE_LIMITED_DAILY");
    expect(r.retryable).toBe(false);
  });

  it("classifies generic 429 as RATE_LIMITED_BURST (retryable)", () => {
    const r = classifyError("HTTP 429 Too Many Requests");
    expect(r.code).toBe("RATE_LIMITED_BURST");
    expect(r.retryable).toBe(true);
  });

  it("classifies 'throttled' as RATE_LIMITED_BURST", () => {
    const r = classifyError("request was throttled");
    expect(r.code).toBe("RATE_LIMITED_BURST");
    expect(r.retryable).toBe(true);
  });

  it("classifies Gemini 'RESOURCE_EXHAUSTED' as RATE_LIMITED_BURST", () => {
    const r = classifyError("RESOURCE_EXHAUSTED: model quota for the minute");
    expect(r.code).toBe("RATE_LIMITED_BURST");
    expect(r.retryable).toBe(true);
  });

  it("classifies 'product not found' as ID_NOT_FOUND (not retryable)", () => {
    const r = classifyError("product not found: gid://shopify/Product/999");
    expect(r.code).toBe("ID_NOT_FOUND");
    expect(r.retryable).toBe(false);
  });

  it("classifies 'unknown workflow' as ID_NOT_FOUND", () => {
    const r = classifyError("unknown workflow: 'foo'");
    expect(r.code).toBe("ID_NOT_FOUND");
    expect(r.retryable).toBe(false);
  });

  it("classifies access-denied as PERMISSION_DENIED", () => {
    const r = classifyError("Access denied: missing read_orders scope");
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(r.retryable).toBe(false);
  });

  it("classifies forbidden as PERMISSION_DENIED", () => {
    const r = classifyError("403 Forbidden");
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(r.retryable).toBe(false);
  });

  it("classifies Zod-shaped error as INVALID_INPUT", () => {
    const r = classifyError(
      "invalid input: ZodError: [{path: ['title'], message: 'required'}]",
    );
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.retryable).toBe(false);
  });

  it("classifies Shopify userErrors as UPSTREAM_ERROR", () => {
    const r = classifyError(
      "shopify userErrors: Cannot archive product with active subscriptions",
    );
    expect(r.code).toBe("UPSTREAM_ERROR");
    expect(r.retryable).toBe(false);
  });

  it("classifies network errors as NETWORK (retryable)", () => {
    const r = classifyError("ECONNRESET: socket hang up");
    expect(r.code).toBe("NETWORK");
    expect(r.retryable).toBe(true);
  });

  it("classifies fetch-failed as NETWORK", () => {
    const r = classifyError("fetch failed");
    expect(r.code).toBe("NETWORK");
    expect(r.retryable).toBe(true);
  });

  it("classifies timeout as NETWORK", () => {
    const r = classifyError("Request timeout after 30s");
    expect(r.code).toBe("NETWORK");
    expect(r.retryable).toBe(true);
  });

  it("falls back to UNKNOWN for unmatched messages", () => {
    const r = classifyError("something weird happened");
    expect(r.code).toBe("UNKNOWN");
    expect(r.retryable).toBe(false);
  });

  it("accepts Error objects, not just strings", () => {
    const r = classifyError(new Error("HTTP 429"));
    expect(r.code).toBe("RATE_LIMITED_BURST");
    expect(r.retryable).toBe(true);
  });

  it("accepts arbitrary objects with a message field", () => {
    const r = classifyError({ message: "product not found" });
    expect(r.code).toBe("ID_NOT_FOUND");
  });

  it("daily-quota match wins over generic 429 (order matters)", () => {
    // The message has both "429" AND "per day" — RATE_LIMITED_DAILY should win
    // because it's more specific (no retry today vs. retry in seconds).
    const r = classifyError(
      "429 quota exceeded per day for generative API",
    );
    expect(r.code).toBe("RATE_LIMITED_DAILY");
    expect(r.retryable).toBe(false);
  });
});

describe("errorMessage — extraction", () => {
  it("extracts .message from Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns string as-is", () => {
    expect(errorMessage("plain string")).toBe("plain string");
  });

  it("returns .message from object with message field", () => {
    expect(errorMessage({ message: "obj msg" })).toBe("obj msg");
  });

  it("returns .error from object with error field", () => {
    expect(errorMessage({ error: "e msg" })).toBe("e msg");
  });

  it("falls back to String() for primitive non-strings", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
  });
});
