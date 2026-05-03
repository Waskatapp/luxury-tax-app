import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type { DepartmentSpec, ToolHandler } from "../department-spec";

import {
  readOrderDetailHandler,
  readOrdersHandler,
  updateOrderNoteHandler,
  updateOrderTagsHandler,
} from "./handlers";
import ORDERS_PROMPT from "./prompt.md?raw";

// V-Or-A — Phase Orders & Fulfillment Round A. Sixth domain department
// after Customers (shipped 2026-05-03). Round A is read-only — 2 tools.
// Round B adds notes + tags + write_orders scope; Round C adds
// fulfillments (sends customer email); Round D adds cancel + refund
// (HIGH-risk, double-confirm patterns). Each round ships independently.

const readOrdersDeclaration: FunctionDeclaration = {
  name: "read_orders",
  description:
    "List orders with optional Shopify search syntax. Returns slim summary per order (id, name like '#1001', dates, financial + fulfillment status, customer-slim, totalPrice, lineItemsCount, tags) — no line items / shipping address / fulfillments (those come from `read_order_detail`).\n\nSearch syntax examples:\n- `fulfillment_status:unfulfilled` — orders not yet shipped (most common ask)\n- `financial_status:paid` / `financial_status:refunded` / `financial_status:pending`\n- `created_at:>=2026-04-01` — date filter\n- `customer_id:gid://shopify/Customer/123` — orders for one customer\n- `name:#1001` — exact order number\n- `tag:vip` — orders with a tag\n- bare keywords match name + email + order number\n\nUse this when the merchant asks 'show me unfulfilled orders' / 'find Cat Lover's recent orders' / 'list orders this week'. Read-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max orders to return. Defaults to 20. Sorted by processedAt descending (newest first).",
      },
      query: {
        type: "string",
        description:
          "Optional Shopify order search syntax. Combine with spaces (implicit AND): `fulfillment_status:unfulfilled financial_status:paid`.",
      },
    },
  },
};

const readOrderDetailDeclaration: FunctionDeclaration = {
  name: "read_order_detail",
  description:
    "Single order, full picture in one roundtrip. Returns identity (name, dates, financial + fulfillment status) + customer-slim + line items (with productId / variantId / sku for cross-dept drill-in) + pricing breakdown (subtotal / shipping / tax / total / refunded / outstanding-refundable) + shipping address + fulfillments (with tracking info) + refunds + tags + note + sourceName.\n\n**Requires the orderId** (`gid://shopify/Order/...`). If the task only has the order name (`#1001`) or customer name, call `read_orders` FIRST to get the GID — never fabricate.\n\nUse this when the merchant asks 'tell me about #1001' / 'where's John's package?' / 'what's in this order?'. Read-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      orderId: {
        type: "string",
        description:
          "Order GID, e.g. gid://shopify/Order/12345. Get this from a read_orders call first if you only have the order number or customer name.",
      },
    },
    required: ["orderId"],
  },
};

// ----------------------------------------------------------------------------
// V-Or-B — Note + tag writes. Both target orderUpdate. Note is admin-only
// (customer never sees it); tags are internal organization. The lowest-
// risk writes in this department — they don't move money, don't affect
// fulfillment, don't email the customer.
// ----------------------------------------------------------------------------

const updateOrderNoteDeclaration: FunctionDeclaration = {
  name: "update_order_note",
  description:
    "Update the admin-only note on an order. **REQUIRES HUMAN APPROVAL.** The note is visible only to the merchant in Shopify admin — the customer never sees it. Use this for things like 'customer wants gift wrap' / 'fragile, handle with care' / 'wholesale arrangement, do not invoice'.\n\nPass an empty string `\"\"` to CLEAR the note. Pass new text to replace it.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      orderId: {
        type: "string",
        description:
          "Order GID, e.g. gid://shopify/Order/12345. Get this from a read_orders call first.",
      },
      note: {
        type: "string",
        description:
          "New admin note. Empty string clears it. Up to 5000 characters.",
      },
    },
    required: ["orderId", "note"],
  },
};

const updateOrderTagsDeclaration: FunctionDeclaration = {
  name: "update_order_tags",
  description:
    "Replace the order's FULL tag list. **REQUIRES HUMAN APPROVAL.** **NOT a delta — REPLACEMENT semantics** (mirrors update_customer_tags / update_product_tags).\n\nWorkflow: call `read_order_detail` first to get the existing tags, append/remove the changes, then propose this tool with the merged final list. Don't propose tag changes without first reading current state — silently dropping the merchant's existing tags is the worst-case outcome.\n\nUse for 'tag #1001 as vip' / 'add the gift-wrap tag' / 'remove the at-risk tag from this order'. Tags are admin-only; customer never sees them.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "Order GID." },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "FULL replacement tag list. Pass [] to clear all tags (rare — usually you want to merge with existing).",
      },
    },
    required: ["orderId", "tags"],
  },
};

const ORDERS_SPEC: DepartmentSpec = {
  id: "orders",
  label: "Orders",
  managerTitle: "Orders manager",
  description:
    "Owns the order book — read order list (with Shopify search syntax for fulfillment / financial status / dates / customer / tags), read full single-order details (line items, shipping address, fulfillments with tracking, refunds, totals), and edit admin-only metadata (note + tags — NOT visible to the customer). Future rounds will add fulfillment writes (send customer email) and cancel + refund (high-risk, money-moving).",
  systemPrompt: ORDERS_PROMPT,
  toolDeclarations: [
    readOrdersDeclaration,
    readOrderDetailDeclaration,
    updateOrderNoteDeclaration,
    updateOrderTagsDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["read_orders", readOrdersHandler],
    ["read_order_detail", readOrderDetailHandler],
    ["update_order_note", updateOrderNoteHandler],
    ["update_order_tags", updateOrderTagsHandler],
  ]),
  classification: {
    read: new Set(["read_orders", "read_order_detail"]),
    write: new Set(["update_order_note", "update_order_tags"]),
    inlineWrite: new Set(),
  },
};

registerDepartment(ORDERS_SPEC);

export { ORDERS_SPEC };
