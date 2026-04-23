import { readProducts } from "../shopify/products.server";
import type { ShopifyAdmin } from "../shopify/graphql-client.server";

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export type ToolContext = {
  admin: ShopifyAdmin;
  storeId: string;
};

// Dispatch a tool call by name. Tools return typed result tuples; unknown or
// not-yet-wired tools return a user-visible "not implemented" error rather
// than throwing (CLAUDE.md WAT: "never throw raw errors to the agent").
export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_products":
        return await readProducts(ctx.admin, input);

      case "read_collections":
        return {
          ok: false,
          error: "read_collections is not implemented yet (planned for Phase 6).",
        };

      case "get_analytics":
        return {
          ok: false,
          error: "get_analytics is not implemented yet (planned for Phase 9).",
        };

      case "update_product_price":
      case "update_product_description":
      case "create_product_draft":
      case "create_discount":
        // Write tools execute via the approval flow in Phase 5, not inline here.
        return {
          ok: false,
          error: `${name} must route through the approval flow (Phase 5). executeTool should not be called for write tools in v1.`,
        };

      default:
        return { ok: false, error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
