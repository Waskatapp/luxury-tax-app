import IDENTITY_MD from "./ceo-prompt/identity.md?raw";
import DECISION_RULES_MD from "./ceo-prompt/decision-rules.md?raw";
import OUTPUT_FORMAT_MD from "./ceo-prompt/output-format.md?raw";

import { DEPARTMENTS } from "./departments";
import type { WorkflowIndexEntry } from "./workflow-loader.server";

// V2.1 CEO Brain — replaces V1's monolithic buildSystemInstruction with a
// modular assembler. Each prompt block lives in its own .md file so a
// non-coding human can edit the CEO's identity, rules, or output style
// without touching TypeScript. The blocks are inlined at build time via
// Vite's `?raw` import (env.d.ts already references vite/client). At
// runtime this is just string concatenation — no fs, no parsing.
//
// V2.5a — switched from inlining every workflow body (~4,600 tokens per
// turn) to inlining a workflow INDEX (~200 tokens). The CEO now calls
// `read_workflow(name)` on demand to fetch the full SOP. Saves ~4,000
// tokens of system-prompt budget per turn at zero quality cost — the
// workflows are still authoritative when needed; just not pre-loaded.
//
// The departments section is GENERATED from the DEPARTMENTS array (single
// source of truth from departments.ts) plus the workflow index loaded via
// workflow-loader's loadWorkflowIndex(). Guardrails go BEFORE memory so
// the CEO reads operating constraints before reading preference facts.

export type CeoPromptOptions = {
  shopDomain: string;
  memoryMarkdown: string | null;
  guardrailsMarkdown: string | null;
  observationsMarkdown: string | null;
  workflowIndex: WorkflowIndexEntry[];
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

  // 2. Departments + their workflow index (auto-generated, never a static
  //    file). V2.5a — only an index is inlined; full bodies fetched via
  //    read_workflow on demand.
  sections.push(buildDepartmentsSection(opts.workflowIndex));

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
// (single source of truth) plus a workflow INDEX (V2.5a). Each workflow
// shows up as a one-liner: name, summary, owning tool. The CEO calls
// `read_workflow(name)` on demand for the full body.
//
// Workflows tagged `cross-cutting` get their own subsection (apply to
// every department). Workflows without a `department:` frontmatter land
// in `uncategorized` and are appended at the end so they don't silently
// disappear from the prompt.
export function buildDepartmentsSection(
  workflowIndex: WorkflowIndexEntry[],
): string {
  const lines: string[] = ["## Departments and workflows"];
  lines.push(
    "You are the CEO of a small company. Each department below owns a set of tools and a set of operating procedures (workflows). When the merchant asks for something, decide which department(s) handle it, then call the relevant tools. Some requests cross departments — coordinate them yourself; the departments don't talk to each other directly.",
  );
  lines.push(
    "Below each department is an INDEX of the workflows available to you — name, what it covers, owning tool. To read the full SOP for one of them (rules, edge cases, audit details), call `read_workflow` with its name. Don't fetch every workflow up front; only when you actually need the runbook.",
  );

  // Group the index by department once for O(1) per-department lookup.
  const byDept = new Map<string, WorkflowIndexEntry[]>();
  for (const entry of workflowIndex) {
    const key = entry.department ?? "uncategorized";
    const list = byDept.get(key) ?? [];
    list.push(entry);
    byDept.set(key, list);
  }

  for (const dept of DEPARTMENTS) {
    lines.push(`### ${dept.label}`);
    lines.push(dept.description);
    lines.push(`**Tools owned:** ${dept.toolNames.map((t) => `\`${t}\``).join(", ")}`);
    const entries = byDept.get(dept.id) ?? [];
    if (entries.length > 0) {
      lines.push("**Operating procedures available** (call `read_workflow` for the full SOP):");
      lines.push(entries.map((e) => formatIndexLine(e)).join("\n"));
    }
  }

  // Cross-cutting — apply to every department.
  const crossCutting = byDept.get("cross-cutting") ?? [];
  if (crossCutting.length > 0) {
    lines.push("### Cross-cutting (applies to every department)");
    lines.push(crossCutting.map(formatIndexLine).join("\n"));
  }

  // Anything without frontmatter — surface so prompts don't silently
  // disappear if a workflow is missing its tag.
  const uncategorized = byDept.get("uncategorized") ?? [];
  if (uncategorized.length > 0) {
    lines.push("### Uncategorized workflows");
    lines.push(uncategorized.map(formatIndexLine).join("\n"));
  }

  return lines.join("\n\n");
}

function formatIndexLine(e: WorkflowIndexEntry): string {
  const tool = e.toolName ? `; tool: \`${e.toolName}\`` : "";
  return `- \`${e.name}\` — ${e.summary}${tool}`;
}
