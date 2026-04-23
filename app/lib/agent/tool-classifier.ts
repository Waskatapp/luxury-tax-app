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
  "create_product_draft",
  "create_discount",
]);

// update_store_memory is a write tool that executes inline (no approval card)
// because it does not mutate the store. Landed in Phase 8.
export const INLINE_WRITE_TOOLS = new Set<string>(["update_store_memory"]);

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
