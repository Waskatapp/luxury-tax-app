import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type { DepartmentSpec, ToolHandler } from "../department-spec";

import {
  cancelOrderHandler,
  fulfillOrderWithTrackingHandler,
  markAsFulfilledHandler,
  readOrderDetailHandler,
  readOrdersHandler,
  refundOrderHandler,
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

// ----------------------------------------------------------------------------
// V-Or-C — Fulfillment writes. Both target fulfillmentCreateV2 and SEND
// THE CUSTOMER A SHIPPING-CONFIRMATION EMAIL unless notifyCustomer:false.
// Medium-risk: no money moves, but the customer sees the result. The
// merchant should never approve a fulfillment thinking "this just records
// internally." The descriptions below state the email behavior in the
// first sentence — the manager prompt repeats it.
// ----------------------------------------------------------------------------

const markAsFulfilledDeclaration: FunctionDeclaration = {
  name: "mark_as_fulfilled",
  description:
    "Mark an order as fulfilled WITHOUT tracking info. **REQUIRES HUMAN APPROVAL. THIS WILL EMAIL THE CUSTOMER A SHIPPING-CONFIRMATION** unless `notifyCustomer: false`.\n\nUse this for stores that ship before adding tracking, or for digital / non-tracked goods. Fulfills ALL open line items in one shot — internally calls `fulfillmentCreateV2` against every open FulfillmentOrder for the order.\n\nUse only after the merchant explicitly says the order has shipped (or is shipping today). Don't propose this from inferred intent — the customer email is sent on approval.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      orderId: {
        type: "string",
        description:
          "Order GID, e.g. gid://shopify/Order/12345. Get this from a read_orders call first.",
      },
      notifyCustomer: {
        type: "boolean",
        description:
          "Whether Shopify emails the customer a shipping confirmation. Defaults to true. Pass false ONLY when the merchant explicitly says 'don't email them' or this is internal bookkeeping.",
      },
    },
    required: ["orderId"],
  },
};

const fulfillOrderWithTrackingDeclaration: FunctionDeclaration = {
  name: "fulfill_order_with_tracking",
  description:
    "Mark an order as fulfilled WITH carrier + tracking number. **REQUIRES HUMAN APPROVAL. THIS WILL EMAIL THE CUSTOMER A SHIPPING-CONFIRMATION WITH THE TRACKING LINK** unless `notifyCustomer: false`.\n\nFulfills all open line items in one shot. Shopify auto-generates a tracking URL for known carriers (USPS, FedEx, UPS, DHL); pass `trackingUrl` explicitly to override or for unknown carriers.\n\nUse only when the merchant explicitly says the order has shipped with a specific tracking number. Don't fabricate tracking numbers — if the merchant didn't provide one, ask, or use `mark_as_fulfilled` instead.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      orderId: {
        type: "string",
        description: "Order GID. Get from read_orders first.",
      },
      trackingNumber: {
        type: "string",
        description:
          "Carrier tracking number, e.g. '1Z9999W99999999999' or '9400111202555842761024'. Up to 100 chars.",
      },
      trackingCompany: {
        type: "string",
        description:
          "Carrier name. Common values: 'USPS', 'FedEx', 'UPS', 'DHL', 'Other'. Free text — Shopify accepts any string but auto-URL-generation only works for known carriers.",
      },
      trackingUrl: {
        type: "string",
        description:
          "Optional tracking URL. Shopify auto-generates for known carriers; pass this when the merchant has a specific URL or the carrier is custom.",
      },
      notifyCustomer: {
        type: "boolean",
        description:
          "Whether Shopify emails the customer a shipping confirmation with the tracking link. Defaults to true. Pass false ONLY when the merchant explicitly says 'don't email them'.",
      },
    },
    required: ["orderId", "trackingNumber", "trackingCompany"],
  },
};

// ----------------------------------------------------------------------------
// V-Or-D — HIGH-RISK writes. Cancel voids payment; refund MOVES MONEY
// to the customer's payment method. The descriptions below are the
// firmest in the codebase — they exist to prevent the LLM from
// proposing these writes from inferred intent. Always require explicit
// merchant wording ("cancel" / "refund" / "give them their money back").
//
// refund_order specifically uses a TRIPLE-CONFIRM pattern at the
// implementation layer (Zod refine on confirmAmount, handler verifies
// currency match + amount cap) AND surfaces those gates in the
// description so the LLM understands why the input shape is unusual.
// ----------------------------------------------------------------------------

const cancelOrderDeclaration: FunctionDeclaration = {
  name: "cancel_order",
  description:
    "Cancel an order. **REQUIRES HUMAN APPROVAL. THIS PERMANENTLY VOIDS THE ORDER and EMAILS THE CUSTOMER** about the cancellation unless `notifyCustomer: false`. Once cancelled, the order CANNOT be uncancelled — only refunded if it was paid.\n\nThis tool does NOT issue a refund — refunds go through `refund_order` separately so they get their own audit trail. If the merchant says \"cancel and refund this order\", that's TWO writes (two ApprovalCards), one for the cancel and one for the refund.\n\nThis tool does NOT restock inventory — restock belongs to inventory management (future round). Hard-coded `restock: false` for v1.\n\n**Use ONLY when the merchant explicitly says cancel / void / kill this order.** Never propose from inferred intent (e.g. don't 'just cancel' if the merchant only said the customer is unhappy — they may want a refund without canceling, or a partial refund, or just a discount on their next order).",
  parametersJsonSchema: {
    type: "object",
    properties: {
      orderId: {
        type: "string",
        description:
          "Order GID, e.g. gid://shopify/Order/12345. Get this from a read_orders call first.",
      },
      reason: {
        type: "string",
        enum: [
          "CUSTOMER",
          "FRAUD",
          "INVENTORY",
          "DECLINED",
          "STAFF",
          "OTHER",
        ],
        description:
          "Why the order is being cancelled. CUSTOMER = customer changed mind / requested cancel. FRAUD = suspected fraud. INVENTORY = out of stock / can't fulfill. DECLINED = payment declined. STAFF = staff-initiated for non-customer reason. OTHER = catch-all.",
      },
      notifyCustomer: {
        type: "boolean",
        description:
          "Whether Shopify emails the customer about the cancellation. Defaults to true. Pass false ONLY when the merchant explicitly says 'don't email them'.",
      },
      staffNote: {
        type: "string",
        description:
          "Optional admin-only note attached to the cancel. Visible only to merchant in Shopify admin. Up to 500 chars.",
      },
    },
    required: ["orderId", "reason"],
  },
};

const refundOrderDeclaration: FunctionDeclaration = {
  name: "refund_order",
  description:
    "Issue a refund on an order. **REQUIRES HUMAN APPROVAL. THIS REFUNDS REAL MONEY to the customer's payment method and EMAILS THE CUSTOMER** unless `notifyCustomer: false`. Highest-blast-radius write in the toolkit.\n\n**Triple-confirm pattern — read this carefully**:\n\n1. `confirmAmount` MUST exactly equal `amount` (Zod refine, 1¢ tolerance). This is a defensive gate against typos — if you read \"$5\" as \"$50\" anywhere in the chain, both fields would have to be wrong the same way to slip through. Always set `confirmAmount` to whatever you set `amount` to.\n\n2. `currencyCode` MUST match the order's currency. The handler refuses with a clean error if there's a mismatch (Shopify won't auto-convert). When in doubt, call `read_order_detail` first to get the order's currency.\n\n3. `amount` MUST be ≤ the order's outstanding-refundable amount (the snapshot's `totalRefundable` field). The handler refuses if you try to refund more than what's left.\n\n**Decimal string format** for `amount` and `confirmAmount`: positive value, up to 2 decimal places, e.g. `\"29.99\"`, `\"5\"`, `\"100.50\"`. No leading zeros, no negatives, no scientific notation.\n\n**Use ONLY when the merchant explicitly says refund / give them their money back / process a refund / return X dollars.** Never propose from inferred intent. If the merchant only complained about a delivery delay, that's not consent for a refund — they may want an apology, a discount on the next order, or just acknowledgment.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      orderId: {
        type: "string",
        description:
          "Order GID, e.g. gid://shopify/Order/12345. Get this from a read_orders call first.",
      },
      amount: {
        type: "string",
        description:
          "Decimal string in the order's currency, e.g. '29.99'. Must be positive, ≤ 2 decimal places, ≤ the order's outstanding-refundable amount.",
      },
      confirmAmount: {
        type: "string",
        description:
          "Defensive duplicate of `amount`. MUST equal `amount` exactly (Zod refine, 1¢ tolerance). Set this to the same value you set `amount` to. If they differ, the refund refuses.",
      },
      currencyCode: {
        type: "string",
        description:
          "ISO 4217 currency code (3 letters, e.g. 'USD', 'EUR', 'CAD'). Must match the order's currency. Call read_order_detail first if you don't know the order's currency.",
      },
      reason: {
        type: "string",
        description:
          "Optional admin-only note attached to the refund record. e.g. 'damaged in shipping' / 'item out of stock' / 'customer changed mind'. Up to 500 chars.",
      },
      notifyCustomer: {
        type: "boolean",
        description:
          "Whether Shopify emails the customer about the refund. Defaults to true. Pass false ONLY when the merchant explicitly says 'don't email them'.",
      },
    },
    required: ["orderId", "amount", "confirmAmount", "currencyCode"],
  },
};

const ORDERS_SPEC: DepartmentSpec = {
  id: "orders",
  label: "Orders",
  managerTitle: "Orders manager",
  description:
    "Owns the order lifecycle end-to-end — read order list (with Shopify search syntax for fulfillment / financial status / dates / customer / tags), read full single-order details (line items, shipping address, fulfillments with tracking, refunds, totals), edit admin-only metadata (note + tags), FULFILL orders with or without tracking (sends customer a shipping confirmation email), CANCEL orders (voids payment, emails customer; does NOT refund — separate tool), and REFUND money to the customer's payment method (with confirmAmount + currency-match defensive gates).",
  systemPrompt: ORDERS_PROMPT,
  toolDeclarations: [
    readOrdersDeclaration,
    readOrderDetailDeclaration,
    updateOrderNoteDeclaration,
    updateOrderTagsDeclaration,
    markAsFulfilledDeclaration,
    fulfillOrderWithTrackingDeclaration,
    cancelOrderDeclaration,
    refundOrderDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["read_orders", readOrdersHandler],
    ["read_order_detail", readOrderDetailHandler],
    ["update_order_note", updateOrderNoteHandler],
    ["update_order_tags", updateOrderTagsHandler],
    ["mark_as_fulfilled", markAsFulfilledHandler],
    ["fulfill_order_with_tracking", fulfillOrderWithTrackingHandler],
    ["cancel_order", cancelOrderHandler],
    ["refund_order", refundOrderHandler],
  ]),
  classification: {
    read: new Set(["read_orders", "read_order_detail"]),
    write: new Set([
      "update_order_note",
      "update_order_tags",
      "mark_as_fulfilled",
      "fulfill_order_with_tracking",
      "cancel_order",
      "refund_order",
    ]),
    inlineWrite: new Set(),
  },
};

registerDepartment(ORDERS_SPEC);

export { ORDERS_SPEC };
