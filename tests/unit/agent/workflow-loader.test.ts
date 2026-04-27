import { describe, expect, it } from "vitest";

import { parseWorkflowFile } from "../../../app/lib/agent/workflow-loader.server";

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
