import IDENTITY_MD from "./ceo-prompt/identity.md?raw";
import DECISION_RULES_MD from "./ceo-prompt/decision-rules.md?raw";
import OUTPUT_FORMAT_MD from "./ceo-prompt/output-format.md?raw";

import { DEPARTMENTS } from "./departments";

// V2.1 CEO Brain — replaces V1's monolithic buildSystemInstruction with a
// modular assembler. Each prompt block lives in its own .md file so a
// non-coding human can edit the CEO's identity, rules, or output style
// without touching TypeScript. The blocks are inlined at build time via
// Vite's `?raw` import (env.d.ts already references vite/client). At
// runtime this is just string concatenation — no fs, no parsing.
//
// The departments section is GENERATED from the DEPARTMENTS array (single
// source of truth from departments.ts) plus the workflow markdown grouped
// by department (loaded via workflow-loader's loadWorkflowsByDepartment()).
// Guardrails go BEFORE memory so the CEO reads operating constraints
// before reading preference facts.

export type CeoPromptOptions = {
  shopDomain: string;
  memoryMarkdown: string | null;
  guardrailsMarkdown: string | null;
  observationsMarkdown: string | null;
  workflowsByDept: Record<string, string>;
  now?: Date;
};

export function buildCeoSystemInstruction(opts: CeoPromptOptions): string {
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);

  const sections: string[] = [];

  // 1. Identity — interpolate ${shopDomain} and ${today} placeholders.
  sections.push(
    IDENTITY_MD
      .replaceAll("${shopDomain}", opts.shopDomain)
      .replaceAll("${today}", today),
  );

  // 2. Departments + their workflows (auto-generated, never a static file).
  sections.push(buildDepartmentsSection(opts.workflowsByDept));

  // 3. Decision rules.
  sections.push(DECISION_RULES_MD);

  // 4. Output format conventions.
  sections.push(OUTPUT_FORMAT_MD);

  // 5. Strategic guardrails BEFORE memory — they are operating
  //    constraints, not just preferences. The CEO must check every
  //    action against them per decision-rule #8.
  if (opts.guardrailsMarkdown && opts.guardrailsMarkdown.trim().length > 0) {
    sections.push(`## Strategic guardrails\n\n${opts.guardrailsMarkdown.trim()}`);
  }

  // 6. General store memory (brand voice, pricing rules, etc.).
  const mem = opts.memoryMarkdown?.trim() ?? "";
  if (mem.length > 0) {
    sections.push(`## Store memory\n\n${mem}`);
  } else {
    sections.push(`## Store memory\n\n(No stored memory yet.)`);
  }

  // 7. CEO observations — populated by Phase 2.6's reflection job.
  //    Empty for now; the section header only renders when data exists.
  if (
    opts.observationsMarkdown &&
    opts.observationsMarkdown.trim().length > 0
  ) {
    sections.push(
      `## CEO observations (what I learned about how you work)\n\n${opts.observationsMarkdown.trim()}`,
    );
  }

  return sections.join("\n\n");
}

// Builds the "Departments" section dynamically from the DEPARTMENTS array
// (single source of truth) plus the loaded workflow markdown grouped by
// department. Workflows tagged `cross-cutting` get their own subsection
// because they apply to every department (e.g. store memory). Workflows
// without a `department:` frontmatter end up in `uncategorized` and are
// appended at the end so the CEO still sees them.
export function buildDepartmentsSection(
  workflowsByDept: Record<string, string>,
): string {
  const lines: string[] = ["## Departments and workflows"];
  lines.push(
    "You are the CEO of a small company. Each department below owns a set of tools and a set of operating procedures (workflows). When the merchant asks for something, decide which department(s) handle it, then call the relevant tools. Some requests cross departments — coordinate them yourself; the departments don't talk to each other directly.",
  );

  for (const dept of DEPARTMENTS) {
    lines.push(`### ${dept.label}`);
    lines.push(dept.description);
    lines.push(`**Tools owned:** ${dept.toolNames.map((t) => `\`${t}\``).join(", ")}`);
    const wf = workflowsByDept[dept.id]?.trim();
    if (wf && wf.length > 0) {
      lines.push("**Operating procedures:**");
      lines.push(wf);
    }
  }

  // Cross-cutting workflows — apply to every department.
  const crossCutting = workflowsByDept["cross-cutting"]?.trim();
  if (crossCutting && crossCutting.length > 0) {
    lines.push("### Cross-cutting (applies to every department)");
    lines.push(crossCutting);
  }

  // Anything without frontmatter — surface so prompts don't silently
  // disappear if a workflow is missing its tag.
  const uncategorized = workflowsByDept["uncategorized"]?.trim();
  if (uncategorized && uncategorized.length > 0) {
    lines.push("### Uncategorized workflows");
    lines.push(uncategorized);
  }

  return lines.join("\n\n");
}
