import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "../log.server";

// Loads `docs/workflows/*.md` (skipping README.md) and returns them either
// as a single concatenated string (back-compat with V1's
// loadWorkflowsMarkdown) OR grouped by department (new in Phase 2.0, used
// by the CEO prompt assembler in Phase 2.1).
//
// Each workflow file MAY include a YAML-style frontmatter block at the top:
//
//   ---
//   department: products | pricing-promotions | insights | marketing | customers | orders | inventory | cross-cutting
//   ---
//
//   # Workflow: ...
//
// Files without frontmatter (or with malformed frontmatter) load fine — they
// just default to the "uncategorized" bucket. Tolerant by design so editing
// a workflow doc never bricks the system instruction.
//
// Files are read once at first call and cached for the life of the process;
// merchants editing workflow docs see changes after the next deploy.
//
// We resolve paths from process.cwd() because the React Router server runs
// from the project root in both dev (`shopify app dev`) and prod
// (`react-router-serve`).
const WORKFLOWS_DIR = join(process.cwd(), "docs", "workflows");
// Phase Wf Round Wf-B — _FORMAT.md is the authoring spec, not a workflow.
const SKIP_FILES = new Set(["README.md", "_FORMAT.md"]);

export type ParsedWorkflow = {
  filename: string;
  department: string | null; // "products" | "pricing-promotions" | "insights" | "cross-cutting" | null (uncategorized)
  body: string;              // markdown body without the frontmatter block
  // V2.5a — extracted at parse time so the index assembler doesn't re-scan
  // every file. summary comes from `summary:` frontmatter, falling back to
  // the first `# Workflow: ...` H1 line, falling back to filename. toolName
  // comes from a top-of-body `Tool: \`<name>\`` reference if present.
  summary: string;
  toolName: string | null;
  // Phase Wf Round Wf-A — auto-trigger metadata. The matcher tokenizes the
  // merchant's last user message + last assistant message and fires this
  // workflow as a suggestion when any trigger matches as a whole token /
  // adjacent token sequence. Cap at 5 triggers per file (Zod-style guard at
  // parse time; extra entries truncated). priority breaks ties when
  // multiple workflows fire (default 5; range 1-10, higher wins).
  triggers: string[];
  priority: number;
};

export type WorkflowIndexEntry = {
  // Stable name used by the read_workflow tool: the filename without .md.
  // e.g. "price-change", "product-creation". Lowercase + kebab-case
  // matches our markdown file naming convention.
  name: string;
  department: string | null;
  summary: string;
  toolName: string | null;
  // Phase Wf Round Wf-A.
  triggers: string[];
  priority: number;
};

// Phase Wf Round Wf-A — caps. Defined as constants so unit tests can read
// them without depending on internal magic numbers.
export const MAX_TRIGGERS_PER_WORKFLOW = 5;
export const DEFAULT_WORKFLOW_PRIORITY = 5;
export const MIN_WORKFLOW_PRIORITY = 1;
export const MAX_WORKFLOW_PRIORITY = 10;

type Cache = {
  flat: string;
  parsed: ParsedWorkflow[];
};

let cached: Cache | null = null;

function loadAll(): Cache {
  if (cached !== null) return cached;

  if (!existsSync(WORKFLOWS_DIR)) {
    log.warn("workflow-loader: directory missing", { dir: WORKFLOWS_DIR });
    cached = { flat: "", parsed: [] };
    return cached;
  }

  try {
    const files = readdirSync(WORKFLOWS_DIR)
      .filter((f) => f.endsWith(".md") && !SKIP_FILES.has(f))
      .sort();

    const parsed: ParsedWorkflow[] = files.map((filename) => {
      const raw = readFileSync(join(WORKFLOWS_DIR, filename), "utf8");
      return parseWorkflowFile(filename, raw);
    });

    const flat = parsed.map((p) => p.body).join("\n\n---\n\n");
    cached = { flat, parsed };
    return cached;
  } catch (err) {
    log.error("workflow-loader: failed to load workflow docs", { err });
    cached = { flat: "", parsed: [] };
    return cached;
  }
}

// Tolerant frontmatter parser. Recognizes the convention:
//   ---\n key: value \n ... \n ---\n <body>
// at the very top of the file. If the opening `---` isn't on line 1, or the
// closing `---` isn't found, we treat the whole file as body and return
// department: null.
export function parseWorkflowFile(
  filename: string,
  raw: string,
): ParsedWorkflow {
  // Normalize line endings so Windows checkouts behave identically to Unix.
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0]?.trim() !== "---") {
    const body = normalized.trim();
    return {
      filename,
      department: null,
      body,
      summary: deriveSummary(filename, null, body),
      toolName: extractToolName(body),
      triggers: [],
      priority: DEFAULT_WORKFLOW_PRIORITY,
    };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    // Unclosed frontmatter — treat whole thing as body.
    const body = normalized.trim();
    return {
      filename,
      department: null,
      body,
      summary: deriveSummary(filename, null, body),
      toolName: extractToolName(body),
      triggers: [],
      priority: DEFAULT_WORKFLOW_PRIORITY,
    };
  }

  const fmLines = lines.slice(1, endIdx);
  let department: string | null = null;
  let frontmatterSummary: string | null = null;
  let triggers: string[] = [];
  let priority: number = DEFAULT_WORKFLOW_PRIORITY;
  for (const line of fmLines) {
    // Tolerate leading whitespace, padding around `:`, and trailing
    // whitespace on the value.
    const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "department" && value.length > 0) {
      department = value;
    } else if (key === "summary" && value.length > 0) {
      frontmatterSummary = value;
    } else if (key === "triggers" && value.length > 0) {
      // Phase Wf Round Wf-A — accept inline JSON-like array form
      // `[discount, "promo code", sale]`. Tolerant: strips brackets,
      // splits on commas, strips wrapping quotes, lowercases, drops
      // empties, caps at MAX_TRIGGERS_PER_WORKFLOW.
      triggers = parseTriggersValue(value);
    } else if (key === "priority" && value.length > 0) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) {
        priority = Math.max(
          MIN_WORKFLOW_PRIORITY,
          Math.min(MAX_WORKFLOW_PRIORITY, n),
        );
      }
    }
  }

  const body = lines.slice(endIdx + 1).join("\n").trim();
  return {
    filename,
    department,
    body,
    summary: deriveSummary(filename, frontmatterSummary, body),
    toolName: extractToolName(body),
    triggers,
    priority,
  };
}

// Phase Wf Round Wf-A — parse a `triggers:` value into a normalized array.
// Tolerant input shapes:
//   triggers: [discount, promo code, sale]
//   triggers: discount, promo code, sale
//   triggers: ["bundle", 'storefront']
// Strips outer brackets, splits on commas, strips wrapping quotes, lowercases,
// trims, drops empties, dedupes, caps at MAX_TRIGGERS_PER_WORKFLOW.
function parseTriggersValue(raw: string): string[] {
  const inner = raw.replace(/^\s*\[/, "").replace(/\]\s*$/, "");
  const parts = inner.split(",");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    let t = part.trim();
    // Strip wrapping quotes (single or double).
    t = t.replace(/^["']/, "").replace(/["']$/, "");
    t = t.trim().toLowerCase();
    if (t.length === 0) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TRIGGERS_PER_WORKFLOW) break;
  }
  return out;
}

// V2.5a — the index needs a 1-line description per workflow. Source order:
// 1. explicit `summary:` frontmatter (preferred — merchant-controlled)
// 2. first `# Workflow: <X>` H1 → "<X>"
// 3. any first H1 → that H1's text
// 4. filename (without .md) as last resort
function deriveSummary(
  filename: string,
  frontmatterSummary: string | null,
  body: string,
): string {
  if (frontmatterSummary && frontmatterSummary.length > 0) {
    return frontmatterSummary;
  }
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) continue;
    // Strip leading `#`s and whitespace.
    const heading = trimmed.replace(/^#+\s*/, "").trim();
    if (heading.length === 0) continue;
    // "Workflow: Foo" → "Foo"; otherwise return whole heading.
    const m = heading.match(/^Workflow:\s*(.+)$/i);
    return m ? m[1].trim() : heading;
  }
  return filename.replace(/\.md$/, "");
}

// V2.5a — many of our workflow files have a "Tool: `update_product_price`"
// reference near the top. Surfaces in the index so the CEO can correlate
// "I want to call update_product_price" with "read_workflow('price-change')"
// without re-scanning the body.
function extractToolName(body: string): string | null {
  for (const line of body.split("\n")) {
    const m = line.match(/^Tool:\s*`([a-z_][a-z0-9_]*)`/);
    if (m) return m[1];
  }
  return null;
}

export function loadWorkflowsMarkdown(): string {
  return loadAll().flat;
}

// New in Phase 2.0 — used by the CEO prompt assembler in Phase 2.1 to embed
// each department's workflows under its own heading. Workflows with no
// frontmatter (or `department: cross-cutting`) land in their own buckets.
export function loadWorkflowsByDepartment(): Record<string, string> {
  const grouped: Record<string, string[]> = {};
  for (const wf of loadAll().parsed) {
    const key = wf.department ?? "uncategorized";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(wf.body);
  }
  const out: Record<string, string> = {};
  for (const [key, bodies] of Object.entries(grouped)) {
    out[key] = bodies.join("\n\n---\n\n");
  }
  return out;
}

// V2.5a — lazy workflow injection. The CEO prompt now carries only an
// index (filename + summary + owning tool), and the new `read_workflow`
// tool fetches the full body on demand. Saves ~4,000 tokens per turn vs.
// inlining every workflow body.
export function loadWorkflowIndex(): WorkflowIndexEntry[] {
  return loadAll().parsed.map((wf) => ({
    name: wf.filename.replace(/\.md$/, ""),
    department: wf.department,
    summary: wf.summary,
    toolName: wf.toolName,
    triggers: wf.triggers,
    priority: wf.priority,
  }));
}

// Look up a single workflow body by its index name (filename without .md).
// Returns null for unknown names. The read_workflow tool exposes this; the
// regex in the tool's parametersJsonSchema (^[a-z0-9_-]+$) prevents path
// traversal even before this call, but we also defensively reject any
// name that doesn't match that shape here.
export function loadWorkflowBodyByName(name: string): string | null {
  if (!/^[a-z0-9_-]+$/i.test(name)) return null;
  const target = `${name}.md`;
  for (const wf of loadAll().parsed) {
    if (wf.filename === target) return wf.body;
  }
  return null;
}

// Test seam — lets unit tests reset the cache between runs.
export function _resetWorkflowsCacheForTesting(): void {
  cached = null;
}
