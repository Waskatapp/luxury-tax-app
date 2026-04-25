# Manual smoke test

Run this checklist before declaring a release "done". Mirrors CLAUDE.md §16.
Embedded Shopify apps are hostile to automated E2E (live OAuth + tunnel +
dev-store state); this checklist is the pragmatic substitute until we add a
focused Playwright pass.

## Setup

- [ ] Railway has all four env vars set: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
      `GEMINI_API_KEY`, `ENCRYPTION_KEY` (32 bytes hex)
- [ ] App installed on `the-new-waskat-dev-store.myshopify.com` via Partner
      dashboard install link
- [ ] Embedded app loads inside Shopify admin (no white screen, no CSP errors
      in browser console)

## Core chat (Phase 4)

- [ ] Open Copilot → "What products do I have?" → product list streams in
      word-by-word
- [ ] No "Copilot is briefly resting…" message on a fresh conversation
- [ ] Sidebar shows the new conversation; title set to first 60 chars of the
      first message

## Approval flow (Phase 5)

- [ ] "Lower the price of [product] to $19.99" → ApprovalCard appears with
      current vs. new price visible
- [ ] **Approve** → Shopify variant updates → Copilot confirms in a new bubble
- [ ] AuditLog row in `/app/settings/audit` shows the action with non-empty
      `before` and `after`
- [ ] **Reject** another change → Copilot acknowledges → no Shopify mutation →
      AuditLog row has `after: null`

## Read tools (Phase 6)

- [ ] "How is revenue the last 30 days?" → revenue stats card renders inline
      (Total / Orders / Avg order)
- [ ] "What's running low on stock?" → inventory-at-risk DataTable renders, or
      empty-state copy if nothing below 5 units
- [ ] "Show me my top 5 products" — if the dev store has no orders, expect
      "No orders in the last X days, so no products to rank yet" empty state.
      Place a test order to verify the ranking path.

## Rate limiting (Phase 7)

- [ ] Send 11 messages in under a minute → 11th returns "You're sending
      messages too fast. Try again in Ns."
- [ ] No timeouts on a normal-paced conversation; Railway logs show
      `"shopify graphql cost"` JSON lines

## Memory (Phase 8)

- [ ] In a new conversation: "Always use a casual, friendly tone in product
      descriptions." → continue chatting normally
- [ ] Open `/app/settings/memory` → an entry with `category=BRAND_VOICE`
      appears within ~10 seconds
- [ ] Start a new conversation → ask Copilot to write a product description →
      it should match the saved tone without being prompted again
- [ ] Edit an entry inline; key field is disabled (rename = delete + create)

## Dashboard (Phase 9)

- [ ] `/app/dashboard` loads; three tiles render (Top products, Revenue,
      Inventory at risk)
- [ ] Each tile shows either real data or the documented empty state
- [ ] No `BEST_SELLING` GraphQL error in the Top products tile

## Security hardening (Phase 10)

- [ ] Railway DB inspect: `Store.accessToken` row shows `v1:…:…:…` ciphertext,
      not a `shpat_` plaintext token (after the merchant has logged in once
      since `ENCRYPTION_KEY` was set)
- [ ] Audit log viewer at `/app/settings/audit`:
  - [ ] DataTable lists rows newest-first
  - [ ] Action filter dropdown narrows the list
  - [ ] "View diff" opens Modal with formatted before/after JSON
  - [ ] "Next page →" / "← First page" buttons work; disable correctly at edges
- [ ] Webhook HMAC: from a terminal, send a forged `POST /webhooks/app/uninstalled`
      with garbage `X-Shopify-Hmac-Sha256` → expect 401, no DB row written.
      (The vitest unit test pins this contract; spot-check live once.)
- [ ] Railway logs are JSON: `{"ts":"…","level":"info","msg":"webhook received",…}`

## Force-uninstall + reinstall

- [ ] Uninstall app from dev store admin → `Store.uninstalledAt` populated,
      `accessToken` zeroed, AuditLog `app_uninstalled` row created
- [ ] Reinstall → `uninstalledAt` cleared, fresh ciphertext token written

## ASVS Level 2 self-audit (CLAUDE.md §15)

Verified state as of Phase 10 ship:

- [x] Shopify OAuth for all auth (no custom login routes exist)
- [x] Webhook HMAC verification — `authenticate.webhook(request)` in both
      `webhooks.app.uninstalled.tsx` and `webhooks.app.scopes_update.tsx`;
      pinned by `tests/unit/webhooks/webhook-hmac.test.ts`
- [x] `Store.accessToken` AES-256-GCM encrypted at rest with versioned format
      (`v1:iv:tag:ct`); legacy plaintext rows migrate on next admin request
- [x] All DB queries scoped by `storeId` — `requireStoreAccess` is the
      single tenant gate; `deleteMemory(storeId, id)` uses
      `findFirst({id, storeId})` to prevent foreign-id escape
- [x] `PendingAction.toolCallId @unique` + Postgres atomic `updateMany`
      transition in `api.tool-approve.tsx`
- [x] Input sanitization via `sanitize.server.ts` `sanitizeUserInput` before
      reaching Gemini
- [x] Rate limiting — `checkChatRateLimit` (10/min per storeId+userId) and
      `checkGeminiRateLimit` (10/min per storeId) on every `/api/chat` call
- [x] No secrets in logs — `log.server.ts` only emits structured `ctx`;
      `friendlyErrorMessage` strips raw SDK errors before SSE
- [x] CSP headers — `addDocumentResponseHeaders` is invoked in
      `entry.server.tsx:17`; Shopify sets `frame-ancestors`
- [x] RBAC roles available via `requireStoreAccess(request, minRole)`. v1
      doesn't gate the Copilot routes by role (any installed user can chat);
      add `minRole: STORE_ADMIN` if a future tenant has VIEW_ONLY collaborators

## Known deferred items (acceptable for v1)

- 21 high-severity `npm audit` findings: all dev-time only
  (`@shopify/api-codegen-preset`, `@typescript-eslint/*`). Major-version bumps
  required; fix in a focused maintenance PR. Production runtime unaffected.
- No Playwright E2E. Add when CI is worth setting up.
- Online vs offline session token: v1 uses offline only; no per-user
  identity in the chat audit trail.
