import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Phase 8b — replaces Vite's `?raw` import suffix with a runtime read.
//
// Why: `import X from "./foo.md?raw"` only resolves under Vite's bundler.
// tsx (which runs the eval-harness cron and any other Node-direct script)
// throws ERR_UNKNOWN_FILE_EXTENSION on the `.md` extension. Replacing
// `?raw` with this helper makes the codebase tsx-compatible without
// losing any behavior — the resulting string is the same.
//
// Performance: each call does ONE fs.readFileSync at module-load time.
// Modules load once per process; per-file overhead is sub-millisecond.
// Vite still inlines the source at build time when the dev server
// pre-bundles, so production hot-path latency is unchanged.
//
// Usage:
//   const IDENTITY_MD = loadRaw(import.meta.url, "./ceo-prompt/identity.md");

export function loadRaw(callerUrl: string, relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, callerUrl)),
    "utf8",
  );
}
