// V2.0 Department Skeleton — single source of truth for the company
// metaphor introduced in Phase 2.0. Every Shopify tool is owned by exactly
// one department; cross-cutting CEO-level tools (memory, clarification,
// plan proposal) own no department.
//
// Used by:
//   - The reactive routing pill (every tool_use_start / tool_running event
//     looks up departmentForTool() to render "Asking the [manager]…").
//   - The CEO prompt assembler (Phase 2.1) — embeds department descriptions
//     and groups workflows by department.
//   - Future phases (suggestion categorization, settings panel).
//
// New tools MUST be assigned to a department here before being registered
// in tools.ts (or explicitly excluded as cross-cutting). Don't ship a tool
// without picking its home.

export type DepartmentId =
  | "products"
  | "pricing-promotions"
  | "insights"
  | "marketing"
  | "customers"
  | "orders"
  | "inventory";

export type Department = {
  id: DepartmentId;
  label: string;          // "Products" — what the merchant reads in the UI
  managerTitle: string;   // "Products manager" — for the routing pill text
  description: string;    // one sentence; embedded in the CEO prompt
  toolNames: string[];    // tools owned by this department
};

export const DEPARTMENTS: Department[] = [
  {
    id: "products",
    label: "Products",
    managerTitle: "Products manager",
    description:
      "Owns the product catalog: searching products and collections, " +
      "rewriting descriptions, renaming products, managing tags / vendor / " +
      "product type, editing variant details (SKU/barcode/weight/inventory " +
      "policy/shipping/tax), duplicating products, changing status " +
      "(DRAFT/ACTIVE/ARCHIVED), creating new draft products, " +
      "creating / updating manual collections, and managing product " +
      "images (add / remove / reorder).",
    toolNames: [
      "read_products",
      "read_collections",
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
    ],
  },
  {
    id: "pricing-promotions",
    label: "Pricing & Promotions",
    managerTitle: "Pricing & Promotions manager",
    description:
      "Owns prices and discounts: setting variant prices, sale-price " +
      "strikethrough (compareAtPrice), bulk price changes across collections " +
      "or product lists, listing discounts, creating / updating / pausing / " +
      "deleting automatic discounts, compound bundle (Buy-X-Get-Y) " +
      "discounts, and code-based discounts (influencer / partner / email " +
      "campaign codes).",
    toolNames: [
      "update_product_price",
      "create_discount",
      "update_compare_at_price",
      "bulk_update_prices",
      "read_discounts",
      "update_discount",
      "set_discount_status",
      "delete_discount",
      "create_bundle_discount",
      "create_discount_code",
    ],
  },
  {
    id: "insights",
    label: "Insights",
    managerTitle: "Insights manager",
    description:
      "Owns reading the store's pulse: revenue, top sellers / " +
      "underperformers, inventory at risk, per-product performance, " +
      "and period-over-period comparisons. Read-only.",
    toolNames: [
      "get_analytics",
      "get_product_performance",
      "compare_periods",
      "get_top_performers",
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    managerTitle: "Marketing manager",
    description:
      "Owns store findability and merchant-authored content: SEO titles " +
      "and meta descriptions on products and collections, blog articles, " +
      "and static pages (About / FAQ / Shipping / Returns / Privacy etc.).",
    toolNames: [
      "update_product_seo",
      "update_collection_seo",
      "read_articles",
      "create_article",
      "update_article",
      "delete_article",
      "read_pages",
      "create_page",
      "update_page",
      "delete_page",
    ],
  },
  {
    id: "customers",
    label: "Customers",
    managerTitle: "Customers manager",
    description:
      "Owns the customer list: read summaries + drill-in details, edit " +
      "identity (name / email / phone / note), manage tags (replacement " +
      "set), update email + SMS marketing consent (separate per-channel " +
      "audit trails), and read customer segments + their members.",
    toolNames: [
      "read_customers",
      "read_customer_detail",
      "update_customer",
      "update_customer_tags",
      "update_email_marketing_consent",
      "update_sms_marketing_consent",
      "read_segments",
      "read_segment_members",
    ],
  },
  {
    id: "orders",
    label: "Orders",
    managerTitle: "Orders manager",
    description:
      "Owns the order lifecycle end-to-end — read order list (with " +
      "Shopify search syntax), read full single-order details, edit " +
      "admin-only metadata (note + tags), FULFILL orders with or " +
      "without tracking (sends customer email), CANCEL orders " +
      "(voids payment, emails customer; does NOT refund — separate " +
      "tool), and REFUND money to the customer (with confirmAmount + " +
      "currency-match defensive gates).",
    toolNames: [
      "read_orders",
      "read_order_detail",
      "update_order_note",
      "update_order_tags",
      "mark_as_fulfilled",
      "fulfill_order_with_tracking",
      "cancel_order",
      "refund_order",
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    managerTitle: "Inventory manager",
    description:
      "Owns multi-location stock state — listing fulfillment locations, " +
      "reading per-variant stock across locations (with sku / barcode / " +
      "tracked flag / inventoryItemId), and toggling whether Shopify " +
      "tracks inventory for a given item. Round B will add quantity " +
      "mutations: adjust (relative delta), set (absolute, audit-grade), " +
      "and transfer (between two locations, atomic).",
    toolNames: [
      "read_locations",
      "read_inventory_levels",
      "set_inventory_tracking",
    ],
  },
];

// Tool name → department id. Returns null for cross-cutting CEO-level
// tools (update_store_memory today; ask_clarifying_question and
// propose_plan in later phases) — those don't belong to any one
// department and the routing pill renders a generic "CEO" label for them.
export function departmentForTool(toolName: string): DepartmentId | null {
  for (const dept of DEPARTMENTS) {
    if (dept.toolNames.includes(toolName)) return dept.id;
  }
  return null;
}

export function getDepartment(id: DepartmentId): Department {
  const d = DEPARTMENTS.find((x) => x.id === id);
  if (!d) throw new Error(`unknown department: ${id}`);
  return d;
}

// Helper used by the routing pill — given a department id (or null for
// cross-cutting), return the manager title to display.
export function managerTitleForDepartment(
  id: DepartmentId | null,
): string | null {
  if (id === null) return null;
  return getDepartment(id).managerTitle;
}
