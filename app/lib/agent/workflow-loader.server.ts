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
//   department: products | pricing-promotions | insights | cross-cutting
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
const SKIP_FILES = new Set(["README.md"]);

export type ParsedWorkflow = {
  filename: string;
  department: string | null; // "products" | "pricing-promotions" | "insights" | "cross-cutting" | null (uncategorized)
  body: string;              // markdown body without the frontmatter block
};

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
    return { filename, department: null, body: normalized.trim() };
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
    return { filename, department: null, body: normalized.trim() };
  }

  const fmLines = lines.slice(1, endIdx);
  let department: string | null = null;
  for (const line of fmLines) {
    // Tolerate leading whitespace, padding around `:`, and trailing
    // whitespace on the value.
    const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "department" && value.length > 0) {
      department = value;
    }
  }

  const body = lines.slice(endIdx + 1).join("\n").trim();
  return { filename, department, body };
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

// Test seam — lets unit tests reset the cache between runs.
export function _resetWorkflowsCacheForTesting(): void {
  cached = null;
}
