import { buildProductAdminUrl } from "../../lib/shopify/admin-url";

// V2.3 — Citation link parser. The CEO emits inline markdown links with
// custom URL schemes to point at sources of truth: analytics dashboards,
// individual products in Shopify admin, or stored memory entries. We
// parse the href, validate it, and return the route the renderer should
// link to.
//
// Design: keep the parser totally pure so unit tests don't need a DOM
// or React. The renderer (MarkdownContent.tsx) wraps the result in
// react-router's Link (internal nav) or Polaris Link with target=_blank
// (external Shopify admin) based on the kind.
//
// Schemes (case-insensitive prefix):
//   `analytics:<key>`  → /app/dashboard               (internal)
//   `product:<gid>`    → admin.shopify.com/store/...  (external)
//   `memory:<id>`      → /app/settings/memory#<id>    (internal)
//
// Anything else (http(s):// or unrecognized) falls through unchanged so
// the existing markdown-link behavior keeps working.

export type CitationKind = "analytics" | "product" | "memory" | "external";

// Discriminator is `kind`; `external` is an independent flag. Anchor-only
// links (#foo) are kind="external" with external=false (in-page nav).
// True external links (http(s), mailto) are external=true.
export type CitationLink =
  | { kind: "analytics"; url: string; external: false }
  | { kind: "product"; url: string; external: true }
  | { kind: "memory"; url: string; external: false }
  | { kind: "external"; url: string; external: boolean }
  | null; // unresolvable — renderer should render plain bold text

const SCHEME_RE = /^([a-z]+):(.+)$/i;

export function parseCitationHref(
  href: string | null | undefined,
  shopDomain: string | null | undefined,
): CitationLink {
  if (!href || typeof href !== "string") return null;
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;

  // Pass-through for true external links (http/https/mailto/etc.). Polaris
  // Link with target=_blank handles them; markdown's existing default.
  if (/^(https?|mailto):/i.test(trimmed)) {
    return { kind: "external", url: trimmed, external: true };
  }

  // Anchor-only links (#foo) — pass-through. The renderer handles them
  // as same-page nav.
  if (trimmed.startsWith("#")) {
    return { kind: "external", url: trimmed, external: false };
  }

  const m = trimmed.match(SCHEME_RE);
  if (!m) return null;

  const scheme = m[1].toLowerCase();
  const ref = m[2];

  if (scheme === "analytics") {
    // The dashboard renders all three metrics on one page. We don't
    // currently honor `ref` (e.g. "revenue-30d") as a deep-link anchor,
    // but we keep it in the URL hash so the dashboard can grow that
    // affordance without changing the citation contract.
    const safeRef = ref.replace(/[^a-z0-9_-]/gi, "");
    return {
      kind: "analytics",
      url: safeRef ? `/app/dashboard#${safeRef}` : "/app/dashboard",
      external: false,
    };
  }

  if (scheme === "product") {
    const url = buildProductAdminUrl(shopDomain, ref);
    if (!url) return null; // Malformed GID or missing shopDomain → no link
    return { kind: "product", url, external: true };
  }

  if (scheme === "memory") {
    // Memory ids are cuids (alphanumeric). Strip anything else defensively.
    const safeId = ref.replace(/[^a-z0-9_-]/gi, "");
    if (!safeId) return null;
    return {
      kind: "memory",
      url: `/app/settings/memory#${safeId}`,
      external: false,
    };
  }

  return null;
}
