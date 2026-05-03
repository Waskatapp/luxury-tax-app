import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type { DepartmentSpec, ToolHandler } from "../department-spec";

import {
  readOrderDetailHandler,
  readOrdersHandler,
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

const ORDERS_SPEC: DepartmentSpec = {
  id: "orders",
  label: "Orders",
  managerTitle: "Orders manager",
  description:
    "Owns the order book — read order list (with Shopify search syntax for fulfillment / financial status / dates / customer / tags) and read full single-order details (line items, shipping address, fulfillments with tracking, refunds, totals). READ-ONLY in this version; future rounds add note + tag edits, fulfillment writes (send customer email), and cancel + refund (high-risk).",
  systemPrompt: ORDERS_PROMPT,
  toolDeclarations: [
    readOrdersDeclaration,
    readOrderDetailDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["read_orders", readOrdersHandler],
    ["read_order_detail", readOrderDetailHandler],
  ]),
  classification: {
    read: new Set(["read_orders", "read_order_detail"]),
    write: new Set(),
    inlineWrite: new Set(),
  },
};

registerDepartment(ORDERS_SPEC);

export { ORDERS_SPEC };
