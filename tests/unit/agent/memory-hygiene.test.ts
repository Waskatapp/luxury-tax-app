import { describe, expect, it } from "vitest";
import { MemoryCategory } from "@prisma/client";

import {
  buildHygieneUserMessage,
  formatConflictAsInsightBody,
  parseHygieneResponse,
  type MemoryConflict,
} from "../../../app/lib/agent/memory-hygiene.server";

// Helper to fake StoreMemory rows without hitting Prisma. The hygiene
// scanner only reads { category, key, value }; the rest doesn't matter.
function entry(
  category: MemoryCategory,
  key: string,
  value: string,
): {
  id: string;
  storeId: string;
  category: MemoryCategory;
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
} {
  return {
    id: `mem_${key}`,
    storeId: "store_1",
    category,
    key,
    value,
    createdAt: new Date("2026-04-29T00:00:00Z"),
    updatedAt: new Date("2026-04-29T00:00:00Z"),
  };
}

describe("buildHygieneUserMessage", () => {
  it("renders one entry per line with category prefix", () => {
    const entries = [
      entry("OPERATOR_PREFS", "merchant_name", "Sam"),
      entry("BRAND_VOICE", "brand_voice", "casual"),
    ];
    const out = buildHygieneUserMessage(entries);
    expect(out).toContain("[OPERATOR_PREFS] merchant_name: Sam");
    expect(out).toContain("[BRAND_VOICE] brand_voice: casual");
  });

  it("truncates values past 200 chars with an ellipsis (conflicts are in facts, not prose)", () => {
    const long = "x".repeat(300);
    const out = buildHygieneUserMessage([
      entry("BRAND_VOICE", "brand_voice", long),
    ]);
    expect(out).toContain("…");
    expect(out).not.toContain(long);
  });

  it("preserves values shorter than 200 chars verbatim", () => {
    const short = "warm and witty";
    const out = buildHygieneUserMessage([
      entry("BRAND_VOICE", "brand_voice", short),
    ]);
    expect(out).toContain("warm and witty");
    expect(out).not.toContain("…");
  });

  it("handles an empty list", () => {
    const out = buildHygieneUserMessage([]);
    expect(out).toContain("Here are the stored memory entries:");
    expect(out).toContain("Return the conflicts as a JSON array");
  });
});

describe("parseHygieneResponse", () => {
  it("parses a clean JSON array", () => {
    const raw = JSON.stringify([
      {
        type: "value-conflict",
        keyA: "merchant_name",
        keyB: "operator_name",
        reason: "Both name the merchant; only one can be right.",
      },
    ]);
    const out = parseHygieneResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("value-conflict");
    expect(out[0].keyA).toBe("merchant_name");
  });

  it("returns [] for an empty array response", () => {
    expect(parseHygieneResponse("[]")).toEqual([]);
  });

  it("strips ```json code fences (Flash-Lite occasionally adds them)", () => {
    const raw = '```json\n[{"type":"semantic-clash","keyA":"a","keyB":"b","reason":"x"}]\n```';
    const out = parseHygieneResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("semantic-clash");
  });

  it("returns [] for malformed JSON", () => {
    expect(parseHygieneResponse("not json")).toEqual([]);
    expect(parseHygieneResponse("{ broken")).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(parseHygieneResponse("")).toEqual([]);
    expect(parseHygieneResponse("   ")).toEqual([]);
  });

  it("rejects entries with invalid `type` field", () => {
    const raw = JSON.stringify([
      {
        type: "made-up-type",
        keyA: "a",
        keyB: "b",
        reason: "x",
      },
    ]);
    expect(parseHygieneResponse(raw)).toEqual([]);
  });

  it("rejects entries missing required fields", () => {
    const raw = JSON.stringify([
      { type: "value-conflict", keyA: "a" }, // missing keyB and reason
    ]);
    expect(parseHygieneResponse(raw)).toEqual([]);
  });

  it("caps at 10 conflicts (hard ceiling)", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      type: "value-conflict",
      keyA: `a${i}`,
      keyB: `b${i}`,
      reason: "x",
    }));
    const out = parseHygieneResponse(JSON.stringify(many));
    expect(out).toEqual([]); // Zod rejects the whole array if max is exceeded
  });
});

describe("formatConflictAsInsightBody", () => {
  function conflict(over: Partial<MemoryConflict> = {}): MemoryConflict {
    return {
      type: "value-conflict",
      keyA: "merchant_name",
      keyB: "operator_name",
      reason: "Both name the merchant; only one can be right.",
      ...over,
    };
  }

  it("uses the human-readable type label in the title", () => {
    const out = formatConflictAsInsightBody(conflict({ type: "value-conflict" }));
    expect(out.title).toBe("Value conflict: merchant_name vs operator_name");
  });

  it("uses 'Semantic clash' for semantic-clash type", () => {
    const out = formatConflictAsInsightBody(conflict({ type: "semantic-clash" }));
    expect(out.title).toContain("Semantic clash");
  });

  it("uses 'Duplicate intent' for duplicate-intent type", () => {
    const out = formatConflictAsInsightBody(conflict({ type: "duplicate-intent" }));
    expect(out.title).toContain("Duplicate intent");
  });

  it("includes the reason verbatim in the body", () => {
    const out = formatConflictAsInsightBody(
      conflict({ reason: "These contradict on tone." }),
    );
    expect(out.body).toContain("These contradict on tone.");
  });

  it("body points the merchant at /app/settings/memory for resolution", () => {
    const out = formatConflictAsInsightBody(conflict());
    expect(out.body).toContain("/app/settings/memory");
  });
});
