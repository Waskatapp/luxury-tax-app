// Tool classification per CLAUDE.md §6. Exported without `.server.` suffix so
// client code (MessageBubble) can distinguish "internal plumbing" read tools
// from write tools that need an approval card.

// V-Sub-2 — get_analytics MIGRATED to the Insights department.
// V-Sub-3 — read_products, read_collections MIGRATED to the Products
// department. Migrated tools are classified inside their department
// module's `classification` field; central sets cover only tools the
// CEO still calls directly.
export const READ_TOOLS = new Set<string>([
  // V2.5a — read_workflow fetches the full body of a workflow SOP on
  // demand. The system prompt only carries an index; this tool is how
  // the CEO opens a specific runbook when it actually needs one.
  "read_workflow",
]);

// V-Sub-3 / V-Sub-4 — IMPORTANT: even after department migration, we
// keep ALL write tool names in this set. Reason: this set is consumed
// by client-side MessageBubble (`isApprovalRequiredWrite`) to decide
// which tool_use blocks render as ApprovalCards. Sub-agent's PROPOSED
// writes are surfaced as synthetic tool_use blocks at the CEO level
// (see api.chat.tsx proposed-writes wiring); for the merchant's UI to
// render an ApprovalCard, the tool name must pass this filter
// regardless of whether dispatch is registry-driven or central-switch.
// The DISPATCH side (executeApprovedWrite) is fully registry-driven
// after Sub-4; the UI side stays a flat list.
export const APPROVAL_REQUIRED_WRITE_TOOLS = new Set<string>([
  "update_product_price",
  "update_product_description",
  "update_product_status",
  "create_product_draft",
  "update_product_title",
  "update_product_tags",
  "update_product_vendor",
  "update_product_type",
  "update_variant",
  "duplicate_product",
  "create_collection",
  "update_collection",
  "add_product_image",
  "remove_product_image",
  "reorder_product_images",
  "create_discount",
  "update_compare_at_price",
  "bulk_update_prices",
  "update_discount",
  "set_discount_status",
  "delete_discount",
  "create_bundle_discount",
  "create_discount_code",
  // V-Mkt-A — Marketing department SEO writes. Both go through the
  // standard ApprovalCard flow (PendingAction → approve → executor).
  "update_product_seo",
  "update_collection_seo",
  // V-Mkt-B — Blog article writes. delete_article runs a defensive
  // confirmTitle check inside its handler before issuing the destructive
  // mutation.
  "create_article",
  "update_article",
  "delete_article",
  // V-Mkt-C — Static page writes. Same shape as articles; delete_page
  // also runs a confirmTitle gate before the destructive mutation.
  "create_page",
  "update_page",
  "delete_page",
  // V-Cu-A — Customers writes. update_customer is partial-identity (Zod
  // refine: at least one field). update_customer_tags is replacement-
  // set semantics (manager prompt teaches merge-first workflow). The
  // two consent writes are intentionally split per-channel because
  // CAN-SPAM (email) and TCPA (SMS) carry different legal weight and
  // separate AuditLog entries are non-negotiable.
  "update_customer",
  "update_customer_tags",
  "update_email_marketing_consent",
  "update_sms_marketing_consent",
  // V-Or-B — Orders note + tag writes. Lowest-risk writes in the
  // Orders dept — both target orderUpdate and only touch admin-only
  // metadata (customer never sees them). Tags follow replacement-set
  // semantics like other tag writes.
  "update_order_note",
  "update_order_tags",
  // V-Or-C — Fulfillment writes. Both target fulfillmentCreateV2 and
  // SEND THE CUSTOMER A SHIPPING-CONFIRMATION EMAIL on approval unless
  // notifyCustomer:false. Medium-risk (no money, but customer-facing).
  // The FunctionDeclaration descriptions + manager prompt make the
  // email behavior prominent so the merchant doesn't approve thinking
  // this is internal-only.
  "mark_as_fulfilled",
  "fulfill_order_with_tracking",
  // V-Or-D — HIGH-RISK writes. Cancel voids payment + emails customer;
  // refund MOVES MONEY to the customer's payment method. refund_order
  // runs a triple-confirm pattern (Zod refine on confirmAmount, handler
  // verifies currency match + amount cap) BEFORE the mutation fires,
  // and includes Shopify 2026-04's required @idempotent directive with
  // a per-call UUID to prevent double-charging on retry.
  "cancel_order",
  "refund_order",
  // V-Inv-A — Inventory tracking flag. Lowest-risk write in the
  // codebase: flips a boolean (whether Shopify counts stock for an
  // inventory item); no quantities change. Still gets an ApprovalCard
  // because the merchant should explicitly confirm the change in
  // tracking semantics.
  "set_inventory_tracking",
  // V-Inv-B — Quantity mutations. adjust = relative delta (medium-risk;
  // reversible by opposite-sign adjust). set = absolute write (high-risk;
  // destructive — Zod-requires referenceDocumentUri for audit trail).
  // transfer = atomic paired delta (one inventoryAdjustQuantities call
  // with two changes — pre-flight from-quantity check in the handler
  // refuses the mutation if it would drive the source location negative).
  "adjust_inventory_quantity",
  "set_inventory_quantity",
  "transfer_inventory",
  // V-Bulk-A — Per-entity bulk-write tools. Modeled byte-for-byte on the
  // canonical bulk_update_prices exemplar (P&P): XOR scope (collectionId |
  // productIds), per-product sequential mutations, partial-failure
  // resilient, snapshot skipped (result carries the diff). Caps: 50
  // products per call. bulk_update_status is HIGH-risk (DRAFT removes
  // from storefront; ARCHIVED removes from search + storefront).
  "bulk_update_titles",
  "bulk_update_tags",
  "bulk_update_status",
]);

// update_store_memory is a write tool that executes inline (no approval card)
// because it does not mutate the store. Landed in Phase 8.
//
// ask_clarifying_question (V2.2) is a CEO-level orchestration tool: it
// produces no store mutation, just a question rendered in the chat UI.
// Treated as inline so api.chat.tsx routes it through executeTool.
//
// propose_plan (V2.3) is also CEO-level: it persists a Plan row and
// renders a PlanCard for the merchant to approve, but doesn't touch
// Shopify. Each step's WRITE still goes through the regular approval
// flow when the CEO executes the plan after approval.
//
// propose_artifact (V2.5) persists an Artifact row and opens the side
// panel for the merchant to edit. The Shopify write fires later when the
// merchant clicks Approve in the panel, via api.artifact-approve which
// creates a fresh PendingAction with the merchant's edited content and
// runs it through the regular approval flow. So this tool is inline by
// the same rationale as propose_plan — the meta-tool itself doesn't
// mutate Shopify.
//
// propose_followup (V3.1) persists an ActionFollowup row — the CEO's
// "I'll check this later" queue for outcome-bearing writes. The offline
// evaluator (.github/workflows/followup-evaluator.yml) reads these rows
// and writes Insights when criteria are met. No Shopify mutation; inline.
// Unlike propose_plan / propose_artifact, this tool does NOT pause the
// agent loop — the CEO queues a followup and continues responding.
// V-Sub-1 — delegate_to_department is the CEO's meta-tool for invoking
// a department sub-agent (see app/lib/agent/sub-agent.server.ts). It's
// classified as INLINE_WRITE because the CALL itself doesn't mutate
// Shopify — it dispatches to a sub-agent which either returns a summary
// (no mutation) OR proposes writes that get queued as PendingActions
// for merchant approval. The proposed-writes integration in
// api.chat.tsx handles the queueing path; the inline classification
// here just makes sure the tool result flows back to the CEO without
// triggering an approval card.
export const INLINE_WRITE_TOOLS = new Set<string>([
  "update_store_memory",
  "ask_clarifying_question",
  "propose_plan",
  "propose_artifact",
  "propose_followup",
  "delegate_to_department",
]);

// Phase Re Round Re-B — idempotency registry for the auto-retry harness.
// A tool is idempotent when re-running it with the same inputs yields the
// same end state (NOT necessarily the same return value). Idempotent
// tools are safe to auto-retry on transient errors (RATE_LIMITED_BURST,
// NETWORK). Non-idempotent tools (creates) bail to merchant on transient
// failure — auto-retry could create a duplicate if the first call
// actually succeeded but the response was lost.
//
// Rules of thumb for adding a tool to this set:
//   - Updates / sets / archives — YES (re-setting the same value is a no-op)
//   - Creates — NO (each call creates a NEW entity)
//   - Refunds / cancels — NO (Shopify's idempotency-key pattern is
//     out-of-scope for v1; treat as non-idempotent until we wire it).
//   - Reads — implicitly idempotent; this set covers WRITES only since
//     reads don't go through the approval flow.
//
// IMPORTANT: a tool here being marked idempotent does NOT mean it auto-
// retries — the retry harness ALSO requires `result.retryable === true`
// (which means the error code says it was transient, not permanent).
// Both must be true.
export const IDEMPOTENT_TOOLS = new Set<string>([
  // Reads (covered for completeness — read tools may be retried inline).
  "read_workflow",
  "read_products",
  "read_collections",
  "get_analytics",
  "get_product_performance",
  "compare_periods",
  "get_top_performers",
  "read_discounts",
  "read_articles",
  "read_pages",
  "read_customers",
  "read_customer_detail",
  "read_segments",
  "read_segment_members",
  "read_orders",
  "read_order_detail",
  "read_inventory_levels",
  "read_locations",
  // Updates / sets — re-setting the same value is a no-op at Shopify.
  "update_product_price",
  "update_product_description",
  "update_product_status",
  "update_product_title",
  "update_product_tags",
  "update_product_vendor",
  "update_product_type",
  "update_variant",
  "update_compare_at_price",
  "update_collection",
  "update_discount",
  "set_discount_status",
  "update_product_seo",
  "update_collection_seo",
  "update_article",
  "update_page",
  "update_customer",
  "update_customer_tags",
  "update_email_marketing_consent",
  "update_sms_marketing_consent",
  "update_order_note",
  "update_order_tags",
  "set_inventory_tracking",
  // Bulk updates — inner loop is partial-failure resilient and re-applying
  // an already-applied state is a no-op per product.
  "bulk_update_titles",
  "bulk_update_tags",
  "bulk_update_status",
  "bulk_update_prices",
  // Memory / orchestration writes — pure DB upsert, idempotent.
  "update_store_memory",
]);

// Explicitly NON-idempotent (listed for clarity; not actually checked at
// runtime — anything missing from IDEMPOTENT_TOOLS is treated as such):
//   - create_product_draft, create_collection, create_discount,
//     create_discount_code, create_bundle_discount, duplicate_product
//   - create_article, create_page
//   - mark_as_fulfilled, fulfill_order_with_tracking
//   - cancel_order, refund_order (high-risk; NEVER auto-retry)
//   - adjust_inventory_quantity (relative delta — re-applying doubles!)
//   - set_inventory_quantity (theoretically idempotent but Zod requires
//     referenceDocumentUri — re-running re-references the same doc; we
//     err on the side of NOT retrying to keep the audit trail clean).
//   - transfer_inventory (paired delta — same reason as adjust)
//   - delete_article, delete_page, delete_discount (delete-then-redelete
//     surfaces "not found" the second time — surface to the merchant).
//   - add_product_image, remove_product_image, reorder_product_images
//     (image-list mutations carry positional semantics; safer to skip).
//   - propose_plan / propose_artifact / propose_followup (each call
//     creates a fresh row).
//   - delegate_to_department, ask_clarifying_question (no mutation, but
//     re-running triggers another sub-agent or another card).

export function isIdempotent(name: string): boolean {
  return IDEMPOTENT_TOOLS.has(name);
}

export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}

export function isApprovalRequiredWrite(name: string): boolean {
  return APPROVAL_REQUIRED_WRITE_TOOLS.has(name);
}

export function isInlineWrite(name: string): boolean {
  return INLINE_WRITE_TOOLS.has(name);
}

export function isKnownTool(name: string): boolean {
  return (
    READ_TOOLS.has(name) ||
    APPROVAL_REQUIRED_WRITE_TOOLS.has(name) ||
    INLINE_WRITE_TOOLS.has(name)
  );
}
