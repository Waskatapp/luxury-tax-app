import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 8b — replaces Vite's `?raw` import suffix with a runtime read.
//
// Why: `import X from "./foo.md?raw"` only resolves under Vite's bundler.
// tsx (which runs the eval-harness cron and any other Node-direct script)
// throws ERR_UNKNOWN_FILE_EXTENSION on the `.md` extension. Replacing
// `?raw` with this helper makes the codebase tsx-compatible without
// losing any behavior — the resulting string is the same.
//
// Why cwd-relative (not import.meta.url-relative): in Vite SSR
// production, compiled JS lives in build/server/ but source .md
// files stay at their original app/lib/.../prompt.md paths. An
// import.meta.url-based resolution would look for the .md NEXT to
// the compiled JS (build/server/.../prompt.md) and fail with
// ENOENT, crashing the app at startup. process.cwd() is always the
// repo root (set by `npm start`, `npm test`, `tsx`, and Vite dev),
// and Railway's Node runtime image preserves the source tree
// alongside the build/ directory.
//
// Performance: each call does ONE fs.readFileSync at module-load time.
// Modules load once per process; per-file overhead is sub-millisecond.
//
// Trade-off: in Vite dev mode, edits to a .md file no longer trigger
// HMR (Vite has no static dependency edge from the .ts module to the
// .md file). The dev workflow now requires a server restart after
// editing a prompt block. Acceptable for now; revisit if it becomes
// painful for non-coding humans editing prompt.md files frequently.
//
// Usage:
//   const IDENTITY_MD = loadRaw("app/lib/agent/ceo-prompt/identity.md");

export function loadRaw(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}
