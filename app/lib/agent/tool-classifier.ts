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
