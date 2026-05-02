import IDENTITY_MD from "./ceo-prompt/identity.md?raw";
import DECISION_RULES_MD from "./ceo-prompt/decision-rules.md?raw";
import OUTPUT_FORMAT_MD from "./ceo-prompt/output-format.md?raw";

import { DEPARTMENTS } from "./departments";
// V-Sub-5 — registry-entrypoint import populates the registry on module
// load. After Sub-5, all 3 departments (Products, Pricing & Promotions,
// Insights) are migrated; the prompt always renders the
// "delegate_to_department" hint. The legacy isDepartmentMigrated fork
// from Sub-2 is removed.
import "./departments/registry-entrypoint.server";
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
  // V4.3 — Phase 4 Decision Memory & Retrieval. Semantically-similar past
  // decisions injected only on the merchant's first user message in a new
  // conversation. Empty/null skips the section entirely.
  pastDecisionsMarkdown: string | null;
  workflowIndex: WorkflowIndexEntry[];
  now?: Date;
  // V6.8 — IANA timezone string from Shopify (e.g., "America/Los_Angeles").
  // Defaults to "UTC" if null/undefined. Used to format the time block in
  // identity.md so the CEO sees the merchant's LOCAL clock, not UTC.
  timezone?: string | null;
};

// V6.8 — Build the rich time block that gets injected as ${nowHuman},
// ${timezone}, ${today}, and ${nowIso} placeholders in identity.md.
// Day-of-week + minute-level precision in the merchant's local TZ; ISO
// date and ISO timestamp for tool inputs (which require UTC ISO format).
//
// Pure function — exported for tests.
export function buildTimeBlock(now: Date, timezone: string): {
  today: string;        // "2026-04-30" (ISO date, UTC)
  nowHuman: string;     // "Thursday, April 30, 2026 at 2:23 PM"
  timezone: string;     // "America/Los_Angeles" or "UTC"
  nowIso: string;       // "2026-04-30T21:23:15.000Z"
} {
  const tz = timezone || "UTC";
  // ISO date/time stay in UTC for tool input safety. Tool calls expect
  // ISO-8601 with Z suffix; converting to local would break them.
  const todayIso = now.toISOString().slice(0, 10);
  const nowIso = now.toISOString();

  // Human format uses the merchant's local timezone — that's the part
  // that matters for "9am tomorrow" / "end of this week" reasoning.
  let nowHuman: string;
  try {
    nowHuman = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(now);
  } catch {
    // Invalid timezone string (shouldn't happen with Shopify's IANA, but
    // defensive). Fall back to UTC.
    nowHuman = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(now);
  }

  return { today: todayIso, nowHuman, timezone: tz, nowIso };
}

export function buildCeoSystemInstruction(opts: CeoPromptOptions): string {
  const time = buildTimeBlock(opts.now ?? new Date(), opts.timezone ?? "UTC");

  const sections: string[] = [];

  // 1. Identity — interpolate ${shopDomain} and the V6.8 time placeholders
  //    so the CEO knows day-of-week + minute-level local time, not just
  //    a UTC date.
  sections.push(
    IDENTITY_MD
      .replaceAll("${shopDomain}", opts.shopDomain)
      .replaceAll("${nowHuman}", time.nowHuman)
      .replaceAll("${timezone}", time.timezone)
      .replaceAll("${nowIso}", time.nowIso)
      .replaceAll("${today}", time.today),
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

  // 8. Past decisions on similar situations — V4.3 retrieval. Comes
  //    LAST because it's context-specific to this conversation: the CEO
  //    should read identity / rules / memory / observations first, then
  //    consult precedent for this particular question.
  if (
    opts.pastDecisionsMarkdown &&
    opts.pastDecisionsMarkdown.trim().length > 0
  ) {
    sections.push(
      `## Past decisions on similar situations\n\n${opts.pastDecisionsMarkdown.trim()}`,
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
    "You are the CEO of a small company. Each department below owns a set of tools and a set of operating procedures (workflows). When the merchant asks for something, decide which department(s) handle it, then call `delegate_to_department` for each one in turn — the departments don't talk to each other directly, you orchestrate them.",
  );
  lines.push(
    "**Critical: chain delegations to gather data.** Many tasks need data from one department to act in another. Example: 'Lower Cat Food to $19.99' — Pricing & Promotions needs a `variantId` and current price, but only Products can fetch them. The right flow is:\n  1. `delegate_to_department(department='products', task='Find Cat Food and return its variant ID and current price')` — Products manager runs `read_products`, returns the data.\n  2. `delegate_to_department(department='pricing-promotions', task='Update variant gid://shopify/ProductVariant/XYZ price from $24.99 to $19.99')` — P&P manager proposes the write with concrete IDs in scope.\n\n**Never ask the merchant for technical data they don't have** (product IDs, variant IDs, GIDs, internal handles, etc.). Merchants think in product names — fetch the IDs yourself via Products. Asking 'please provide the product ID' is a hard failure mode (rule 24): the merchant's last message says 'lower Cat Food' — they already specified the product, you just need to look it up.",
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
    // V-Sub-5 — every department is registered in the registry; the
    // delegate hint is always rendered. Tools live inside the manager's
    // scope, not the CEO's direct tool list.
    lines.push(
      `**Tools owned:** ${dept.toolNames.map((t) => `\`${t}\``).join(", ")} — these tools live INSIDE the manager's scope, not yours. To use them, call \`delegate_to_department(department="${dept.id}", task="...")\`. The manager will call the right tool and return a summary or a proposed write for the merchant to approve.`,
    );
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
