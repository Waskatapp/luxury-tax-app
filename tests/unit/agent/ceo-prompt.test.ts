import { describe, expect, it } from "vitest";

import {
  buildCeoSystemInstruction,
  buildDepartmentsSection,
  buildTimeBlock,
  type CeoPromptOptions,
} from "../../../app/lib/agent/ceo-prompt.server";
import type { WorkflowIndexEntry } from "../../../app/lib/agent/workflow-loader.server";

const FIXED_DATE = new Date("2026-04-27T12:00:00Z");

function baseOpts(over: Partial<CeoPromptOptions> = {}): CeoPromptOptions {
  return {
    shopDomain: "test-store.myshopify.com",
    memoryMarkdown: null,
    guardrailsMarkdown: null,
    observationsMarkdown: null,
    pastDecisionsMarkdown: null,
    workflowIndex: [],
    now: FIXED_DATE,
    ...over,
  };
}

function entry(over: Partial<WorkflowIndexEntry> = {}): WorkflowIndexEntry {
  return {
    name: "price-change",
    department: "pricing-promotions",
    summary: "Changing a product variant's price",
    toolName: "update_product_price",
    ...over,
  };
}

describe("buildTimeBlock", () => {
  // Fixed test moment: 2026-04-30 21:23:15 UTC.
  // Local in America/Los_Angeles is 14:23 (2:23 PM) — 7 hours behind in PDT.
  const NOW = new Date("2026-04-30T21:23:15Z");

  it("returns ISO date in UTC regardless of timezone", () => {
    const utc = buildTimeBlock(NOW, "UTC");
    expect(utc.today).toBe("2026-04-30");
    const la = buildTimeBlock(NOW, "America/Los_Angeles");
    expect(la.today).toBe("2026-04-30");
  });

  it("returns full ISO timestamp in UTC", () => {
    const out = buildTimeBlock(NOW, "America/Los_Angeles");
    expect(out.nowIso).toBe("2026-04-30T21:23:15.000Z");
  });

  it("includes day-of-week in the human format", () => {
    const out = buildTimeBlock(NOW, "UTC");
    // 2026-04-30 was a Thursday.
    expect(out.nowHuman).toMatch(/Thursday/);
  });

  it("formats time in the merchant's local timezone (LA = 7h behind UTC in April)", () => {
    const out = buildTimeBlock(NOW, "America/Los_Angeles");
    // 21:23 UTC → 14:23 LA → 2:23 PM
    expect(out.nowHuman).toMatch(/2:23/);
    expect(out.nowHuman).toMatch(/PM/);
  });

  it("uses UTC time when timezone is UTC", () => {
    const out = buildTimeBlock(NOW, "UTC");
    // 21:23 UTC = 9:23 PM
    expect(out.nowHuman).toMatch(/9:23/);
    expect(out.nowHuman).toMatch(/PM/);
  });

  it("falls back to UTC for invalid timezone strings (defensive)", () => {
    const out = buildTimeBlock(NOW, "Not/A_Real_Timezone");
    // Should still produce a valid time string even for bogus tz input.
    expect(out.nowHuman).toMatch(/Thursday/);
    expect(out.nowHuman).toMatch(/9:23/); // UTC fallback
    expect(out.timezone).toBe("Not/A_Real_Timezone"); // we still report what was passed
  });

  it("treats empty timezone string as UTC (safety net)", () => {
    const out = buildTimeBlock(NOW, "");
    expect(out.timezone).toBe("UTC");
    expect(out.nowHuman).toMatch(/Thursday/);
  });
});

describe("buildCeoSystemInstruction", () => {
  it("interpolates ${shopDomain} and time placeholders in the identity block", () => {
    const out = buildCeoSystemInstruction(baseOpts());
    expect(out).toContain("test-store.myshopify.com");
    expect(out).toContain("2026-04-27"); // ${today} substituted
    expect(out).not.toContain("${shopDomain}");
    expect(out).not.toContain("${today}");
    expect(out).not.toContain("${nowHuman}");
    expect(out).not.toContain("${timezone}");
    expect(out).not.toContain("${nowIso}");
  });

  it("uses the provided timezone in the human time block", () => {
    const out = buildCeoSystemInstruction(
      baseOpts({
        now: new Date("2026-04-30T21:23:15Z"),
        timezone: "America/Los_Angeles",
      }),
    );
    // FIXED_DATE in baseOpts is overridden; this is 21:23 UTC = 14:23 LA = 2:23 PM
    expect(out).toMatch(/2:23/);
    expect(out).toContain("America/Los_Angeles");
  });

  it("falls back to UTC when timezone is null/omitted", () => {
    const out = buildCeoSystemInstruction(
      baseOpts({ now: new Date("2026-04-30T21:23:15Z") }),
    );
    expect(out).toContain("UTC");
  });

  it("includes all four mandatory section blocks (identity / departments / decision-rules / output-format)", () => {
    const out = buildCeoSystemInstruction(baseOpts());
    expect(out).toMatch(/You are the Merchant Copilot's CEO/);
    expect(out).toMatch(/## Departments and workflows/);
    expect(out).toMatch(/## Core decision rules/);
    expect(out).toMatch(/## Output formatting/);
  });

  it("renders the strategic guardrails section BEFORE the store memory section when present", () => {
    const out = buildCeoSystemInstruction(
      baseOpts({
        guardrailsMarkdown: "- never_below_ten_percent: never apply discounts under 10%",
        memoryMarkdown: "### Brand voice\n- brand_voice: casual and witty",
      }),
    );
    const guardIdx = out.indexOf("## Strategic guardrails");
    const memIdx = out.indexOf("## Store memory");
    expect(guardIdx).toBeGreaterThan(0);
    expect(memIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(memIdx);
  });

  it("omits the strategic guardrails section entirely when null/empty", () => {
    const outNull = buildCeoSystemInstruction(baseOpts({ guardrailsMarkdown: null }));
    expect(outNull).not.toContain("## Strategic guardrails");

    const outEmpty = buildCeoSystemInstruction(baseOpts({ guardrailsMarkdown: "   \n  " }));
    expect(outEmpty).not.toContain("## Strategic guardrails");
  });

  it("includes a 'No stored memory yet.' placeholder when memoryMarkdown is null", () => {
    const out = buildCeoSystemInstruction(baseOpts({ memoryMarkdown: null }));
    expect(out).toContain("## Store memory");
    expect(out).toContain("(No stored memory yet.)");
  });

  it("renders memory content under the Store memory heading when present", () => {
    const out = buildCeoSystemInstruction(
      baseOpts({ memoryMarkdown: "### Brand voice\n- brand_voice: casual" }),
    );
    expect(out).toContain("## Store memory");
    expect(out).toContain("- brand_voice: casual");
    expect(out).not.toContain("(No stored memory yet.)");
  });

  it("renders observations under their dedicated heading when present", () => {
    const out = buildCeoSystemInstruction(
      baseOpts({
        observationsMarkdown: "- merchant tends to rephrase pricing questions",
      }),
    );
    expect(out).toContain("## CEO observations");
    expect(out).toContain("merchant tends to rephrase pricing questions");
  });

  it("omits the observations section when null/empty (Phase 2.6 default)", () => {
    const out = buildCeoSystemInstruction(baseOpts({ observationsMarkdown: null }));
    expect(out).not.toContain("## CEO observations");
  });

  it("renders past decisions section when retrieval surfaces matches", () => {
    const out = buildCeoSystemInstruction(
      baseOpts({
        pastDecisionsMarkdown:
          "- (3 days ago, similarity 91%) conversion_rate: rewriting warranty paragraph should lift conversion\n  Outcome: improved: conversion lifted 4.2%",
      }),
    );
    expect(out).toContain("## Past decisions on similar situations");
    expect(out).toContain("warranty paragraph");
  });

  it("omits the past decisions section when null/empty", () => {
    const out = buildCeoSystemInstruction(
      baseOpts({ pastDecisionsMarkdown: null }),
    );
    expect(out).not.toContain("## Past decisions on similar situations");

    const outEmpty = buildCeoSystemInstruction(
      baseOpts({ pastDecisionsMarkdown: "   \n  " }),
    );
    expect(outEmpty).not.toContain("## Past decisions on similar situations");
  });

  it("renders past decisions AFTER observations (context-specific is last)", () => {
    const out = buildCeoSystemInstruction(
      baseOpts({
        observationsMarkdown: "- (some observation)",
        pastDecisionsMarkdown: "- (some past decision)",
      }),
    );
    const obsIdx = out.indexOf("## CEO observations");
    const pastIdx = out.indexOf("## Past decisions");
    expect(obsIdx).toBeGreaterThan(0);
    expect(pastIdx).toBeGreaterThan(0);
    expect(obsIdx).toBeLessThan(pastIdx);
  });

  it("section separator is exactly one blank line (no triple-newline runs)", () => {
    const out = buildCeoSystemInstruction(
      baseOpts({
        memoryMarkdown: "### Brand voice\n- brand_voice: casual",
        guardrailsMarkdown: "- min_discount: never below 10%",
      }),
    );
    expect(out).not.toMatch(/\n\n\n\n/);
  });

  // V5.3 — the realistic-scale test asserts a sane upper bound rather than
  // a hard floor. After Phase 5.3, the prompt is ~33k chars at realistic
  // merchant scale, which CROSSES Gemini's 32k prompt-caching minimum —
  // that's the right shape now. Caching becomes eligible and we get
  // 50–70% input-token discounts on the static prefix. The test floor we
  // care about now is "fits in cache" (≥ 32k) and "isn't bloated past
  // reasonable" (< 60k, which leaves 16x headroom in Flash's 1M context
  // window for retrieved decisions / insights / observations on top).
  it("crosses Gemini's 32k prompt-caching threshold but stays under 60k at realistic merchant scale", () => {
    const fakeMemory = Array.from({ length: 30 }, (_, i) => `- key_${i}: value ${i}`).join("\n");
    const fakeGuardrails = Array.from({ length: 5 }, (_, i) => `- rule_${i}: a strategic guardrail with some prose attached`).join("\n");
    const fakeIndex: WorkflowIndexEntry[] = Array.from({ length: 10 }, (_, i) => ({
      name: `workflow-${i}`,
      department: i % 2 === 0 ? "products" : "pricing-promotions",
      summary: `One-line summary for workflow ${i}`,
      toolName: `tool_${i}`,
    }));
    const out = buildCeoSystemInstruction(
      baseOpts({
        memoryMarkdown: fakeMemory,
        guardrailsMarkdown: fakeGuardrails,
        workflowIndex: fakeIndex,
      }),
    );
    // V5.3 target: prompt should be ≥ 32k (cache-eligible) but well under
    // 62k (room for retrieved decisions/insights/observations on top).
    // Cap bumped 60k→62k 2026-05-10 (Phase Re Round Re-D) for the
    // bulk-missing-IDs decision rule — load-bearing for Phase Re's
    // anti-confabulation thesis.
    expect(out.length).toBeGreaterThanOrEqual(32_000);
    expect(out.length).toBeLessThan(62_000);
  });
});

describe("buildDepartmentsSection (V2.5a — index, not bodies)", () => {
  it("emits one heading per declared department in DEPARTMENTS order", () => {
    const out = buildDepartmentsSection([]);
    const productsIdx = out.indexOf("### Products");
    const pricingIdx = out.indexOf("### Pricing & Promotions");
    const insightsIdx = out.indexOf("### Insights");
    expect(productsIdx).toBeGreaterThan(0);
    expect(pricingIdx).toBeGreaterThan(productsIdx);
    expect(insightsIdx).toBeGreaterThan(pricingIdx);
  });

  it("lists each department's tools in code-fenced inline form", () => {
    const out = buildDepartmentsSection([]);
    expect(out).toContain("`update_product_price`");
    expect(out).toContain("`create_discount`");
    expect(out).toContain("`read_products`");
    expect(out).toContain("`get_analytics`");
  });

  it("renders one index line per workflow under its owning department", () => {
    const out = buildDepartmentsSection([
      entry({ name: "price-change", department: "pricing-promotions", summary: "Changing a product variant's price", toolName: "update_product_price" }),
      entry({ name: "discount-creation", department: "pricing-promotions", summary: "Creating a percentage-off discount", toolName: "create_discount" }),
      entry({ name: "product-creation", department: "products", summary: "Creating a new product (DRAFT)", toolName: "create_product_draft" }),
    ]);
    expect(out).toContain("`price-change`");
    expect(out).toContain("Changing a product variant's price");
    expect(out).toContain("`update_product_price`");
    expect(out).toContain("`discount-creation`");
    expect(out).toContain("`product-creation`");
  });

  it("shows the read_workflow hint so the CEO knows to fetch on demand", () => {
    const out = buildDepartmentsSection([
      entry({ name: "price-change", department: "pricing-promotions", summary: "Changing a product variant's price", toolName: "update_product_price" }),
    ]);
    expect(out).toContain("read_workflow");
  });

  it("renders the Cross-cutting section when workflows have that tag", () => {
    const out = buildDepartmentsSection([
      entry({ name: "store-memory", department: "cross-cutting", summary: "When and how to save durable facts", toolName: null }),
    ]);
    expect(out).toContain("Cross-cutting");
    expect(out).toContain("`store-memory`");
  });

  it("surfaces uncategorized workflows under their own heading (no silent loss)", () => {
    const out = buildDepartmentsSection([
      entry({ name: "stray", department: null, summary: "A workflow with no department tag", toolName: null }),
    ]);
    expect(out).toContain("Uncategorized workflows");
    expect(out).toContain("`stray`");
  });

  it("does not render Cross-cutting / Uncategorized headers when those buckets are absent", () => {
    const out = buildDepartmentsSection([]);
    expect(out).not.toContain("Cross-cutting");
    expect(out).not.toContain("Uncategorized workflows");
  });

  it("omits the toolName segment when an entry has none", () => {
    const out = buildDepartmentsSection([
      entry({ name: "general", department: "products", summary: "A general SOP", toolName: null }),
    ]);
    expect(out).toContain("`general`");
    expect(out).toContain("A general SOP");
    // Shouldn't render an empty `tool: ` clause.
    expect(out).not.toMatch(/tool: ``/);
  });
});
