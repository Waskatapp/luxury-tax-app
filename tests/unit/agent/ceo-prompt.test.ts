import { describe, expect, it } from "vitest";

import {
  buildCeoSystemInstruction,
  buildDepartmentsSection,
  type CeoPromptOptions,
} from "../../../app/lib/agent/ceo-prompt.server";

const FIXED_DATE = new Date("2026-04-27T12:00:00Z");

function baseOpts(over: Partial<CeoPromptOptions> = {}): CeoPromptOptions {
  return {
    shopDomain: "test-store.myshopify.com",
    memoryMarkdown: null,
    guardrailsMarkdown: null,
    observationsMarkdown: null,
    workflowsByDept: {},
    now: FIXED_DATE,
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
    // Identity is first; merchant-facing strings unique to it.
    expect(out).toMatch(/You are the Merchant Copilot's CEO/);
    // Departments header.
    expect(out).toMatch(/## Departments and workflows/);
    // Decision rules header.
    expect(out).toMatch(/## Core decision rules/);
    // Output format header.
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

  it("stays under Gemini Flash's 32k context budget at realistic merchant scale", () => {
    // ~30 memory lines + ~5 guardrails + all 7 V1 workflows worth of markdown.
    const fakeMemory = Array.from({ length: 30 }, (_, i) => `- key_${i}: value ${i}`).join("\n");
    const fakeGuardrails = Array.from({ length: 5 }, (_, i) => `- rule_${i}: a strategic guardrail with some prose attached`).join("\n");
    const out = buildCeoSystemInstruction(
      baseOpts({
        memoryMarkdown: fakeMemory,
        guardrailsMarkdown: fakeGuardrails,
        workflowsByDept: {
          products: "# Products workflow\n\nLong workflow text ".repeat(50),
          "pricing-promotions": "# Pricing workflow\n\nLong workflow text ".repeat(50),
          insights: "# Insights workflow\n\nLong workflow text ".repeat(50),
        },
      }),
    );
    // ~4 chars/token → ~32k tokens ≈ 128k chars. Stay well under that.
    expect(out.length).toBeLessThan(60_000);
  });
});

describe("buildDepartmentsSection", () => {
  it("emits one heading per declared department in DEPARTMENTS order", () => {
    const out = buildDepartmentsSection({});
    const productsIdx = out.indexOf("### Products");
    const pricingIdx = out.indexOf("### Pricing & Promotions");
    const insightsIdx = out.indexOf("### Insights");
    expect(productsIdx).toBeGreaterThan(0);
    expect(pricingIdx).toBeGreaterThan(productsIdx);
    expect(insightsIdx).toBeGreaterThan(pricingIdx);
  });

  it("lists each department's tools in code-fenced inline form", () => {
    const out = buildDepartmentsSection({});
    expect(out).toContain("`update_product_price`");
    expect(out).toContain("`create_discount`");
    expect(out).toContain("`read_products`");
    expect(out).toContain("`get_analytics`");
  });

  it("embeds workflow markdown when provided per-department", () => {
    const out = buildDepartmentsSection({
      products: "# Products workflow body",
      "pricing-promotions": "# Pricing workflow body",
    });
    expect(out).toContain("# Products workflow body");
    expect(out).toContain("# Pricing workflow body");
  });

  it("renders the Cross-cutting section when workflows have that tag", () => {
    const out = buildDepartmentsSection({
      "cross-cutting": "# Memory rules apply everywhere",
    });
    expect(out).toContain("Cross-cutting");
    expect(out).toContain("# Memory rules apply everywhere");
  });

  it("surfaces uncategorized workflows under their own heading (no silent loss)", () => {
    const out = buildDepartmentsSection({
      uncategorized: "# Stray workflow with no department tag",
    });
    expect(out).toContain("Uncategorized workflows");
    expect(out).toContain("Stray workflow with no department tag");
  });

  it("does not render Cross-cutting / Uncategorized headers when those buckets are absent", () => {
    const out = buildDepartmentsSection({});
    expect(out).not.toContain("Cross-cutting");
    expect(out).not.toContain("Uncategorized workflows");
  });
});
