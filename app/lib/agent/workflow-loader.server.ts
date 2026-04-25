import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Loads `docs/workflows/*.md` (skipping README.md) and concatenates them into
// a single string for injection into Gemini's systemInstruction. Files are
// read once at first call and cached for the life of the process; merchants
// editing workflow docs see changes after the next deploy.
//
// We resolve paths from process.cwd() because the React Router server runs
// from the project root in both dev (`shopify app dev`) and prod
// (`react-router-serve`).
const WORKFLOWS_DIR = join(process.cwd(), "docs", "workflows");
const SKIP_FILES = new Set(["README.md"]);

let cached: string | null = null;

export function loadWorkflowsMarkdown(): string {
  if (cached !== null) return cached;

  if (!existsSync(WORKFLOWS_DIR)) {
    console.warn(`[workflow-loader] directory missing: ${WORKFLOWS_DIR}`);
    cached = "";
    return cached;
  }

  try {
    const files = readdirSync(WORKFLOWS_DIR)
      .filter((f) => f.endsWith(".md") && !SKIP_FILES.has(f))
      .sort();

    const sections = files.map((filename) => {
      const body = readFileSync(join(WORKFLOWS_DIR, filename), "utf8").trim();
      return body;
    });

    cached = sections.join("\n\n---\n\n");
    return cached;
  } catch (err) {
    console.error("[workflow-loader] failed to load workflow docs:", err);
    cached = "";
    return cached;
  }
}

// Test seam — lets unit tests reset the cache between runs.
export function _resetWorkflowsCacheForTesting(): void {
  cached = null;
}
