// Tool classification per CLAUDE.md §6. Exported without `.server.` suffix so
// client code (MessageBubble) can distinguish "internal plumbing" read tools
// from write tools that need an approval card.

export const READ_TOOLS = new Set<string>([
  "read_products",
  "read_collections",
  "get_analytics",
]);

export const APPROVAL_REQUIRED_WRITE_TOOLS = new Set<string>([
  "update_product_price",
  "update_product_description",
  "update_product_status",
  "create_product_draft",
  "create_discount",
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
export const INLINE_WRITE_TOOLS = new Set<string>([
  "update_store_memory",
  "ask_clarifying_question",
  "propose_plan",
  "propose_artifact",
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
