import { describe, expect, it } from "vitest";

import {
  buildCeoSystemInstruction,
  buildDepartmentsSection,
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

describe("buildCeoSystemInstruction", () => {
  it("interpolates ${shopDomain} and ${today} in the identity block", () => {
    const out = buildCeoSystemInstruction(baseOpts());
    expect(out).toContain("test-store.myshopify.com");
    expect(out).toContain("2026-04-27");
    expect(out).not.toContain("${shopDomain}");
    expect(out).not.toContain("${today}");
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

  it("section separator is exactly one blank line (no triple-newline runs)", () => {
    const out = buildCeoSystemInstruction(
      baseOpts({
        memoryMarkdown: "### Brand voice\n- brand_voice: casual",
        guardrailsMarkdown: "- min_discount: never below 10%",
      }),
    );
    expect(out).not.toMatch(/\n\n\n\n/);
  });

  // V2.5a — the realistic-scale test now uses an INDEX (one line per workflow)
  // instead of full bodies. Realistic merchant scale = ~30 memory lines + ~5
  // guardrails + ~10 workflows in the index. The base prompt should now stay
  // well under 30k chars (was previously bumping toward 60k).
  it("stays well under Gemini Flash's 32k context budget at realistic merchant scale", () => {
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
    // V2.5a target: lazy injection should keep base prompt well under 30k chars.
    expect(out.length).toBeLessThan(30_000);
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
