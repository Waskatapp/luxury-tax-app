import { describe, expect, it } from "vitest";

import {
  loadWorkflowBodyByName,
  loadWorkflowIndex,
  parseWorkflowFile,
} from "../../../app/lib/agent/workflow-loader.server";

describe("parseWorkflowFile (frontmatter parser)", () => {
  it("extracts department from a well-formed frontmatter block", () => {
    const raw = "---\ndepartment: products\n---\n\n# Workflow: foo\n\nbody here";
    const r = parseWorkflowFile("price-change.md", raw);
    expect(r.filename).toBe("price-change.md");
    expect(r.department).toBe("products");
    expect(r.body).toBe("# Workflow: foo\n\nbody here");
  });

  it("handles hyphenated department values (V2.0 alignment)", () => {
    const raw = "---\ndepartment: pricing-promotions\n---\n\n# Workflow: foo";
    const r = parseWorkflowFile("price-change.md", raw);
    expect(r.department).toBe("pricing-promotions");
  });

  it("handles cross-cutting marker", () => {
    const raw = "---\ndepartment: cross-cutting\n---\n\n# Memory";
    const r = parseWorkflowFile("store-memory.md", raw);
    expect(r.department).toBe("cross-cutting");
  });

  it("returns department=null when there is no frontmatter at all", () => {
    const raw = "# Workflow: just markdown\n\nNo frontmatter here.";
    const r = parseWorkflowFile("plain.md", raw);
    expect(r.department).toBeNull();
    expect(r.body).toBe("# Workflow: just markdown\n\nNo frontmatter here.");
  });

  it("returns department=null when frontmatter is unclosed", () => {
    const raw = "---\ndepartment: products\n# Forgot to close\n\nBody";
    const r = parseWorkflowFile("broken.md", raw);
    expect(r.department).toBeNull();
    // The unclosed frontmatter block becomes part of the body; we don't
    // try to recover. Body stays trimmed.
    expect(r.body).toBe(raw.trim());
  });

  it("returns department=null when frontmatter block exists but lacks the key", () => {
    const raw = "---\ntitle: Something else\n---\n\n# Workflow";
    const r = parseWorkflowFile("untagged.md", raw);
    expect(r.department).toBeNull();
    expect(r.body).toBe("# Workflow");
  });

  it("handles Windows CRLF line endings", () => {
    const raw = "---\r\ndepartment: insights\r\n---\r\n\r\n# Analytics";
    const r = parseWorkflowFile("analytics.md", raw);
    expect(r.department).toBe("insights");
    expect(r.body).toBe("# Analytics");
  });

  it("ignores extra whitespace around the key/value", () => {
    const raw = "---\n  department  :   products   \n---\n\n# Body";
    const r = parseWorkflowFile("padded.md", raw);
    expect(r.department).toBe("products");
  });

  it("does not treat '---' inside the body as a frontmatter delimiter", () => {
    const raw = "---\ndepartment: products\n---\n\n# Workflow\n\n---\n\nMore body";
    const r = parseWorkflowFile("hr-in-body.md", raw);
    expect(r.department).toBe("products");
    expect(r.body).toContain("More body");
    expect(r.body).toContain("---");
  });
});

describe("parseWorkflowFile (V2.5a — summary + toolName extraction)", () => {
  it("uses the explicit `summary:` frontmatter field when present", () => {
    const raw =
      "---\n" +
      "department: pricing-promotions\n" +
      "summary: Changing a product variant's price\n" +
      "---\n\n# Workflow: stale h1 we should not pick up";
    const r = parseWorkflowFile("price-change.md", raw);
    expect(r.summary).toBe("Changing a product variant's price");
  });

  it("falls back to the first `# Workflow: X` H1 when no summary in frontmatter", () => {
    const raw =
      "---\ndepartment: products\n---\n\n# Workflow: Creating a new product (DRAFT)\n\nbody";
    const r = parseWorkflowFile("product-creation.md", raw);
    expect(r.summary).toBe("Creating a new product (DRAFT)");
  });

  it("falls back to the first H1 (any heading) when no `Workflow:` prefix", () => {
    const raw = "---\ndepartment: products\n---\n\n# Inventory dashboard\n\nbody";
    const r = parseWorkflowFile("inv.md", raw);
    expect(r.summary).toBe("Inventory dashboard");
  });

  it("falls back to filename when no frontmatter and no H1", () => {
    const raw = "Just plain text with no headings.";
    const r = parseWorkflowFile("misc.md", raw);
    expect(r.summary).toBe("misc");
  });

  it("extracts toolName from a top-of-body `Tool:` reference", () => {
    const raw =
      "---\ndepartment: pricing-promotions\n---\n\n# Workflow: Price\n\nTool: `update_product_price`\n\nrest";
    const r = parseWorkflowFile("price-change.md", raw);
    expect(r.toolName).toBe("update_product_price");
  });

  it("returns toolName=null when no `Tool:` line present", () => {
    const raw = "---\ndepartment: products\n---\n\n# Workflow: Misc\n\nNo tool here.";
    const r = parseWorkflowFile("misc.md", raw);
    expect(r.toolName).toBeNull();
  });
});

describe("loadWorkflowIndex (real docs/workflows directory)", () => {
  it("returns one entry per workflow file (excluding README.md)", () => {
    const idx = loadWorkflowIndex();
    expect(idx.length).toBeGreaterThanOrEqual(8);
    // No README.md in the index.
    expect(idx.find((e) => e.name === "README")).toBeUndefined();
  });

  it("populates name (filename without .md), department, and summary for known workflows", () => {
    const idx = loadWorkflowIndex();
    const priceChange = idx.find((e) => e.name === "price-change");
    expect(priceChange).toBeDefined();
    expect(priceChange?.department).toBe("pricing-promotions");
    expect(priceChange?.summary).toBeTruthy();
    expect(priceChange?.summary.length).toBeGreaterThan(5);
  });

  it("populates toolName from `Tool:` references in the body", () => {
    const idx = loadWorkflowIndex();
    const priceChange = idx.find((e) => e.name === "price-change");
    expect(priceChange?.toolName).toBe("update_product_price");
  });
});

describe("loadWorkflowBodyByName", () => {
  it("returns the full body for a known workflow", () => {
    const body = loadWorkflowBodyByName("price-change");
    expect(body).not.toBeNull();
    // The body contains the canonical workflow content; check a stable fragment.
    expect(body).toContain("update_product_price");
  });

  it("returns null for an unknown workflow", () => {
    expect(loadWorkflowBodyByName("does-not-exist")).toBeNull();
  });

  it("returns null for path-traversal-shaped names (defensive)", () => {
    expect(loadWorkflowBodyByName("../secrets")).toBeNull();
    expect(loadWorkflowBodyByName("a/b")).toBeNull();
    expect(loadWorkflowBodyByName("a.md")).toBeNull();
  });

  it("is case-sensitive on the filename (matches our kebab-case convention)", () => {
    // Our files are all lowercase kebab-case. Mixed-case lookups don't match.
    expect(loadWorkflowBodyByName("Price-Change")).toBeNull();
  });
});
