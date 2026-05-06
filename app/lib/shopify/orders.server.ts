// V-Or-A — Orders & Fulfillment department core. Reads only in Round A;
// writes (notes/tags, fulfillments, cancel, refund) added in Or-B/C/D.
//
// Single canonical snapshot: fetchOrderDetail(admin, orderId) is the
// shape returned by readOrderDetail AND will be reused by snapshotBefore()
// in executor.server.ts for every order write tool. Same pattern as
// Customers' fetchCustomerDetail — one query, one shape, no per-tool drift.
//
// Scopes: read_orders (already in shopify.app.toml — added during Insights
// Phase 3 for analytics). Round A ships with ZERO scope friction. Round B
// adds write_orders.

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ----------------------------------------------------------------------------
// Snapshot shapes
// ----------------------------------------------------------------------------

// Slim list-shape — id + name + dates + statuses + customer-slim + total
// + lineItemsCount + tags. No body / line items / addresses / fulfillments
// (those come from readOrderDetail).
export type OrderSummary = {
  orderId: string;
  name: string; // e.g. "#1001"
  createdAt: string;
  processedAt: string | null;
  displayFinancialStatus: string | null; // PAID / PENDING / REFUNDED / etc.
  displayFulfillmentStatus: string | null; // FULFILLED / UNFULFILLED / PARTIALLY_FULFILLED / etc.
  customerId: string | null;
  customerDisplayName: string | null;
  customerEmail: string | null;
  totalPrice: string;
  currencyCode: string;
  lineItemsCount: number;
  tags: string[];
};

export type ReadOrdersResult = {
  orders: OrderSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

// Full single-order detail shape. Returned by readOrderDetail and reused
// by future snapshotBefore() for write tools.
export type LineItemSummary = {
  lineItemId: string;
  title: string;
  variantTitle: string | null;
  quantity: number;
  originalUnitPrice: string;
  discountedUnitPrice: string;
  sku: string | null;
  productId: string | null;
  variantId: string | null;
};

export type FulfillmentTrackingSummary = {
  number: string | null;
  url: string | null;
  company: string | null;
};

export type FulfillmentSummary = {
  fulfillmentId: string;
  status: string; // SUCCESS / IN_PROGRESS / OPEN / CANCELLED / ERROR / FAILURE
  createdAt: string;
  trackingInfo: FulfillmentTrackingSummary[];
};

export type RefundSummary = {
  refundId: string;
  totalRefunded: string;
  currencyCode: string;
  createdAt: string;
  note: string | null;
};

export type ShippingAddressSummary = {
  name: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  zip: string | null;
  phone: string | null;
} | null;

export type OrderDetail = {
  orderId: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  closedAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  sourceName: string | null;
  // Customer is intentionally slim here. For full customer detail (LTV
  // stats, recent orders, consent state, default address), the merchant
  // chains to read_customer_detail in the Customers dept using customerId.
  customerId: string | null;
  customerDisplayName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  lineItems: LineItemSummary[];
  // Pricing — all decimal strings in the order's currency.
  subtotalPrice: string;
  totalShippingPrice: string;
  totalTax: string;
  totalPrice: string;
  totalRefunded: string;
  // Outstanding-refundable amount the merchant could still refund. Computed
  // from totalPrice - totalRefunded (Shopify's totalOutstandingSet exists
  // but is the unpaid amount — different concept). Used by refund_order's
  // amount-cap check in Round Or-D.
  totalRefundable: string;
  currencyCode: string;
  shippingAddress: ShippingAddressSummary;
  fulfillments: FulfillmentSummary[];
  refunds: RefundSummary[];
  tags: string[];
  note: string | null;
  updatedAt: string;
};

// ----------------------------------------------------------------------------
// Input schemas
// ----------------------------------------------------------------------------

export const ReadOrdersInput = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  query: z.string().optional(),
});

export const ReadOrderDetailInput = z.object({
  orderId: z.string().min(1),
});

// V-Or-B — Note + tag writes. Both target orderUpdate(input: OrderInput!).
// Note: empty string is a valid value (clears the note). Tags: FULL
// replacement list, mirroring update_customer_tags / update_product_tags.

const NOTE_MAX = 5000;
const TAG_MAX = 250;

export const UpdateOrderNoteInput = z.object({
  orderId: z.string().min(1),
  note: z.string().max(NOTE_MAX),
});

export const UpdateOrderTagsInput = z.object({
  orderId: z.string().min(1),
  tags: z.array(z.string().min(1).max(TAG_MAX)).max(250),
});

// V-Or-C — Fulfillment writes. Both target fulfillmentCreateV2 under
// the hood. SHOPIFY EMAILS THE CUSTOMER A SHIPPING-CONFIRMATION when a
// fulfillment is created — the FunctionDeclaration descriptions and
// the manager prompt surface this fact prominently. Pass
// notifyCustomer:false to suppress the email (rare).
//
// Both tools are MEDIUM-risk: no money moves, but the customer sees
// the result. The merchant should never approve a fulfillment thinking
// "this just records internally."

const TRACKING_NUMBER_MAX = 100;
const TRACKING_COMPANY_MAX = 50;
const TRACKING_URL_MAX = 500;

export const MarkAsFulfilledInput = z.object({
  orderId: z.string().min(1),
  // Default true matches Shopify's own default. We pass it through
  // explicitly so the AuditLog before/after captures the value the
  // merchant approved.
  notifyCustomer: z.boolean().default(true),
});

export const FulfillOrderWithTrackingInput = z.object({
  orderId: z.string().min(1),
  trackingNumber: z.string().min(1).max(TRACKING_NUMBER_MAX),
  // Free-text carrier name. Shopify accepts "USPS", "FedEx", "UPS",
  // "DHL", "Other", or a custom string. For known carriers Shopify
  // auto-generates the tracking URL; otherwise the merchant must pass
  // trackingUrl explicitly.
  trackingCompany: z.string().min(1).max(TRACKING_COMPANY_MAX),
  trackingUrl: z.string().url().max(TRACKING_URL_MAX).optional(),
  notifyCustomer: z.boolean().default(true),
});

// V-Or-D — Cancel + refund. THE highest-blast-radius writes in the
// codebase. Cancel voids payment and emails the customer; refund
// MOVES MONEY back to the customer's payment method.
//
// Defensive design:
// - cancel hard-codes refund:false + restock:false (refunds go through
//   the dedicated tool with its own audit trail; restock is the future
//   Inventory dept's concern)
// - refund uses a TRIPLE-CONFIRM pattern:
//     1. Zod refine: confirmAmount === amount (1¢ tolerance)
//     2. Handler verifies: currencyCode matches the order's currency
//     3. Handler verifies: requested amount ≤ outstanding-refundable
// - refund mutation includes Shopify 2026-04's required @idempotent
//   directive with a per-call UUID to prevent double-charging on retry

const ORDER_CANCEL_REASONS = [
  "CUSTOMER",
  "FRAUD",
  "INVENTORY",
  "DECLINED",
  "STAFF",
  "OTHER",
] as const;

export const CancelOrderInput = z.object({
  orderId: z.string().min(1),
  reason: z.enum(ORDER_CANCEL_REASONS),
  notifyCustomer: z.boolean().default(true),
  // staffNote attached to the cancel — only visible to merchant in
  // Shopify admin. Useful audit context ("customer changed mind", etc.).
  staffNote: z.string().max(500).optional(),
});

// Decimal-string regex: positive amounts with up to 2 decimal places.
// Rejects "0", "0.00", negatives, scientific notation, leading zeros.
// Currency precision is stored as decimal strings throughout the
// codebase (matches Shopify's Decimal scalar) — never as float.
const POSITIVE_AMOUNT_REGEX = /^(?!0+(?:\.0+)?$)\d+(?:\.\d{1,2})?$/;

export const RefundOrderInput = z
  .object({
    orderId: z.string().min(1),
    // Decimal string in order's currency. Must be positive (refunding $0
    // makes no sense). Up to 2 decimal places (currency precision).
    amount: z
      .string()
      .regex(POSITIVE_AMOUNT_REGEX, "amount must be a positive decimal with up to 2 decimal places (e.g. '29.99')"),
    // MUST exactly match `amount` — Zod refine below. Cross-field guard
    // against an LLM misreading "$5" as "$50" or vice versa. The Zod
    // failure message is on the refine, not on the field, so the LLM
    // can't sidestep by passing only confirmAmount.
    confirmAmount: z
      .string()
      .regex(POSITIVE_AMOUNT_REGEX, "confirmAmount must match amount exactly"),
    // ISO 4217 currency code. Must match the order's currency — handler
    // re-verifies after fetch (defensive gate 2).
    currencyCode: z.string().length(3),
    // Optional admin-only note attached to the refund record.
    reason: z.string().max(500).optional(),
    notifyCustomer: z.boolean().default(true),
  })
  .refine(
    (v) => {
      // Compare in cents to avoid float drift on equality check.
      const a = Math.round(parseFloat(v.amount) * 100);
      const b = Math.round(parseFloat(v.confirmAmount) * 100);
      return a === b;
    },
    {
      message:
        "confirmAmount must equal amount exactly (defensive gate against amount typos)",
      path: ["confirmAmount"],
    },
  );

// ----------------------------------------------------------------------------
// GraphQL
// ----------------------------------------------------------------------------

const READ_ORDERS_QUERY = `#graphql
  query ReadOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          name
          createdAt
          processedAt
          displayFinancialStatus
          displayFulfillmentStatus
          customer { id displayName email }
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 1) { edges { node { id } } }
          subtotalLineItemsQuantity
          tags
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// V-Or-B — orderUpdate mutation. Used by both update_order_note and
// update_order_tags. The OrderInput type accepts `id` plus optional
// note / tags / email / metafields / etc. — we only send the fields the
// caller set. After the mutation we refetch via fetchOrderDetail so the
// result + AuditLog after-state share the canonical OrderDetail shape.
const ORDER_UPDATE_MUTATION = `#graphql
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

// V-Or-C — Fulfill the order's open FulfillmentOrders. Shopify's modern
// fulfillment model uses a FulfillmentOrder as the unit of fulfillment
// (each FO can be at a different location, with different statuses).
// To "mark this order as shipped" we fetch all open FOs first, then
// pass them to fulfillmentCreateV2. Omitting fulfillmentOrderLineItems
// means "fulfill ALL remaining items in this FO" — exactly what we
// want for a blanket fulfillment.
const FETCH_FULFILLMENT_ORDERS_QUERY = `#graphql
  query FetchFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 50) {
        edges { node { id status } }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `#graphql
  mutation FulfillmentCreate($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo { number url company }
      }
      userErrors { field message }
    }
  }
`;

// V-Or-D — orderCancel. Hard-codes refund:false + restock:false for
// audit clarity (refund routes through refund_order; restock will
// route through future Inventory dept). The mutation returns a Job
// because Shopify processes cancel asynchronously; we surface job.id
// and rely on the post-cancel snapshot fetch to reflect final state.
const ORDER_CANCEL_MUTATION = `#graphql
  mutation OrderCancel(
    $orderId: ID!
    $reason: OrderCancelReason!
    $notifyCustomer: Boolean!
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      refund: false
      restock: false
      notifyCustomer: $notifyCustomer
      staffNote: $staffNote
    ) {
      job { id done }
      orderCancelUserErrors { field message code }
      userErrors { field message }
    }
  }
`;

// V-Or-D — Fetch the order's transactions to find the parent SALE/CAPTURE
// to refund against. transactions on Order returns an array directly
// (not a connection). We pick the first SUCCESS sale/capture as the
// parent — split-payment orders are rare in v1 territory.
const FETCH_ORDER_TRANSACTIONS_QUERY = `#graphql
  query FetchOrderTransactions($id: ID!) {
    order(id: $id) {
      id
      transactions(first: 10) {
        id
        kind
        status
        gateway
        amountSet { shopMoney { amount currencyCode } }
        parentTransaction { id }
      }
    }
  }
`;

// V-Or-D — refundCreate. Shopify 2026-04 REQUIRES the @idempotent
// directive on this mutation. The key is a per-call UUID so retries
// (network glitches, lambda re-runs) don't double-charge. Variables
// in directive arguments are valid GraphQL since 2018.
//
// RefundInput shape: orderId + transactions (parentId + amount + gateway
// + kind:REFUND). For "flat $X refund" we issue a transaction-only
// refund with no shipping/lineItem allocation — Shopify treats it as
// a generic refund against the parent transaction.
const REFUND_CREATE_MUTATION = `#graphql
  mutation RefundCreate($input: RefundInput!, $idempotencyKey: String!)
  @idempotent(key: $idempotencyKey)
  {
    refundCreate(input: $input) {
      refund {
        id
        createdAt
        note
        totalRefundedSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

// Single-order fetch — full picture in one round-trip. Field set chosen so
// "tell me about this order" answers without chained calls.
const FETCH_ORDER_DETAIL_QUERY = `#graphql
  query FetchOrderDetail($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      processedAt
      cancelledAt
      closedAt
      displayFinancialStatus
      displayFulfillmentStatus
      sourceName
      tags
      note
      updatedAt
      customer { id displayName email phone }
      lineItems(first: 50) {
        edges {
          node {
            id
            title
            variantTitle
            quantity
            sku
            originalUnitPriceSet { shopMoney { amount currencyCode } }
            discountedUnitPriceSet { shopMoney { amount currencyCode } }
            product { id }
            variant { id }
          }
        }
      }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      shippingAddress {
        name
        address1
        address2
        city
        province
        country
        zip
        phone
      }
      fulfillments(first: 20) {
        id
        status
        createdAt
        trackingInfo {
          number
          url
          company
        }
      }
      refunds(first: 20) {
        id
        createdAt
        note
        totalRefundedSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

// ----------------------------------------------------------------------------
// GraphQL response types
// ----------------------------------------------------------------------------

type Money = { amount: string; currencyCode: string };
type ShopMoney = { shopMoney: Money };

type OrderListNode = {
  id: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  customer: { id: string; displayName: string; email: string | null } | null;
  totalPriceSet: ShopMoney;
  lineItems: { edges: Array<{ node: { id: string } }> };
  subtotalLineItemsQuantity: number;
  tags: string[];
};

type OrderDetailNode = {
  id: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  closedAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  sourceName: string | null;
  tags: string[];
  note: string | null;
  updatedAt: string;
  customer: {
    id: string;
    displayName: string;
    email: string | null;
    phone: string | null;
  } | null;
  lineItems: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        variantTitle: string | null;
        quantity: number;
        sku: string | null;
        originalUnitPriceSet: ShopMoney;
        discountedUnitPriceSet: ShopMoney;
        product: { id: string } | null;
        variant: { id: string } | null;
      };
    }>;
  };
  subtotalPriceSet: ShopMoney;
  totalShippingPriceSet: ShopMoney;
  totalTaxSet: ShopMoney;
  totalPriceSet: ShopMoney;
  totalRefundedSet: ShopMoney;
  shippingAddress: {
    name: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    country: string | null;
    zip: string | null;
    phone: string | null;
  } | null;
  fulfillments: Array<{
    id: string;
    status: string;
    createdAt: string;
    trackingInfo: Array<{
      number: string | null;
      url: string | null;
      company: string | null;
    }>;
  }>;
  refunds: Array<{
    id: string;
    createdAt: string;
    note: string | null;
    totalRefundedSet: ShopMoney;
  }>;
};

type ReadOrdersResponse = {
  orders: {
    edges: Array<{ cursor: string; node: OrderListNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type FetchOrderDetailResponse = { order: OrderDetailNode | null };

type OrderUpdateResponse = {
  orderUpdate: {
    order: { id: string } | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
};

type FulfillmentOrderListResponse = {
  order: {
    id: string;
    fulfillmentOrders: {
      edges: Array<{ node: { id: string; status: string } }>;
    };
  } | null;
};

type FulfillmentCreateResponse = {
  fulfillmentCreateV2: {
    fulfillment: {
      id: string;
      status: string;
      trackingInfo: Array<{
        number: string | null;
        url: string | null;
        company: string | null;
      }>;
    } | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
};

type OrderCancelResponse = {
  orderCancel: {
    job: { id: string; done: boolean } | null;
    orderCancelUserErrors: Array<{
      field?: string[];
      message: string;
      code?: string;
    }>;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
};

type OrderTransactionNode = {
  id: string;
  kind: string;
  status: string;
  gateway: string | null;
  amountSet: { shopMoney: { amount: string; currencyCode: string } };
  parentTransaction: { id: string } | null;
};

type FetchOrderTransactionsResponse = {
  order: {
    id: string;
    transactions: OrderTransactionNode[];
  } | null;
};

type RefundCreateResponse = {
  refundCreate: {
    refund: {
      id: string;
      createdAt: string;
      note: string | null;
      totalRefundedSet: { shopMoney: { amount: string; currencyCode: string } };
    } | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// Subtract two decimal strings ("totalPrice" - "totalRefunded") with cent-
// precision to compute the order's outstanding-refundable amount. Done in
// integer cents to avoid float drift; the result is normalized to two
// decimal places. Negative results clamp to "0.00" (refunds can technically
// exceed totalPrice in edge cases — e.g. tip refunds — but for the
// merchant-facing "how much is left to refund" the floor is 0).
function subtractMoney(total: string, refunded: string): string {
  const totalCents = Math.round(parseFloat(total) * 100);
  const refundedCents = Math.round(parseFloat(refunded) * 100);
  const remainingCents = Math.max(0, totalCents - refundedCents);
  const dollars = Math.floor(remainingCents / 100);
  const cents = remainingCents % 100;
  return `${dollars}.${cents.toString().padStart(2, "0")}`;
}

// ----------------------------------------------------------------------------
// Mappers
// ----------------------------------------------------------------------------

function listNodeToSummary(node: OrderListNode): OrderSummary {
  return {
    orderId: node.id,
    name: node.name,
    createdAt: node.createdAt,
    processedAt: node.processedAt,
    displayFinancialStatus: node.displayFinancialStatus,
    displayFulfillmentStatus: node.displayFulfillmentStatus,
    customerId: node.customer?.id ?? null,
    customerDisplayName: node.customer?.displayName ?? null,
    customerEmail: node.customer?.email ?? null,
    totalPrice: node.totalPriceSet.shopMoney.amount,
    currencyCode: node.totalPriceSet.shopMoney.currencyCode,
    lineItemsCount: node.subtotalLineItemsQuantity,
    tags: node.tags,
  };
}

function detailNodeToSnapshot(node: OrderDetailNode): OrderDetail {
  const totalPrice = node.totalPriceSet.shopMoney.amount;
  const totalRefunded = node.totalRefundedSet.shopMoney.amount;
  return {
    orderId: node.id,
    name: node.name,
    createdAt: node.createdAt,
    processedAt: node.processedAt,
    cancelledAt: node.cancelledAt,
    closedAt: node.closedAt,
    displayFinancialStatus: node.displayFinancialStatus,
    displayFulfillmentStatus: node.displayFulfillmentStatus,
    sourceName: node.sourceName,
    customerId: node.customer?.id ?? null,
    customerDisplayName: node.customer?.displayName ?? null,
    customerEmail: node.customer?.email ?? null,
    customerPhone: node.customer?.phone ?? null,
    lineItems: node.lineItems.edges.map((e) => ({
      lineItemId: e.node.id,
      title: e.node.title,
      variantTitle: e.node.variantTitle,
      quantity: e.node.quantity,
      originalUnitPrice: e.node.originalUnitPriceSet.shopMoney.amount,
      discountedUnitPrice: e.node.discountedUnitPriceSet.shopMoney.amount,
      sku: e.node.sku,
      productId: e.node.product?.id ?? null,
      variantId: e.node.variant?.id ?? null,
    })),
    subtotalPrice: node.subtotalPriceSet.shopMoney.amount,
    totalShippingPrice: node.totalShippingPriceSet.shopMoney.amount,
    totalTax: node.totalTaxSet.shopMoney.amount,
    totalPrice,
    totalRefunded,
    totalRefundable: subtractMoney(totalPrice, totalRefunded),
    currencyCode: node.totalPriceSet.shopMoney.currencyCode,
    shippingAddress: node.shippingAddress
      ? {
          name: node.shippingAddress.name,
          address1: node.shippingAddress.address1,
          address2: node.shippingAddress.address2,
          city: node.shippingAddress.city,
          province: node.shippingAddress.province,
          country: node.shippingAddress.country,
          zip: node.shippingAddress.zip,
          phone: node.shippingAddress.phone,
        }
      : null,
    fulfillments: node.fulfillments.map((f) => ({
      fulfillmentId: f.id,
      status: f.status,
      createdAt: f.createdAt,
      trackingInfo: f.trackingInfo.map((t) => ({
        number: t.number,
        url: t.url,
        company: t.company,
      })),
    })),
    refunds: node.refunds.map((r) => ({
      refundId: r.id,
      totalRefunded: r.totalRefundedSet.shopMoney.amount,
      currencyCode: r.totalRefundedSet.shopMoney.currencyCode,
      createdAt: r.createdAt,
      note: r.note,
    })),
    tags: node.tags,
    note: node.note,
    updatedAt: node.updatedAt,
  };
}

// ----------------------------------------------------------------------------
// fetchOrderDetail — canonical snapshot helper. Used by readOrderDetail
// (the merchant-facing read) and by snapshotBefore() in executor.server.ts
// for every order write tool added in Or-B/C/D. Single source of truth
// for "what's the state of this order."
// ----------------------------------------------------------------------------

export async function fetchOrderDetail(
  admin: ShopifyAdmin,
  orderId: string,
): Promise<ToolModuleResult<OrderDetail>> {
  const result = await graphqlRequest<FetchOrderDetailResponse>(
    admin,
    FETCH_ORDER_DETAIL_QUERY,
    { id: orderId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.order) {
    return { ok: false, error: `order not found: ${orderId}` };
  }
  return { ok: true, data: detailNodeToSnapshot(result.data.order) };
}

// ----------------------------------------------------------------------------
// readOrders — list with Shopify search syntax
// ----------------------------------------------------------------------------

export async function readOrders(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadOrdersResult>> {
  const parsed = ReadOrdersInput.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ReadOrdersResponse>(
    admin,
    READ_ORDERS_QUERY,
    {
      first: parsed.data.limit,
      after: null,
      query: parsed.data.query ?? null,
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    data: {
      orders: result.data.orders.edges.map((e) => listNodeToSummary(e.node)),
      pageInfo: result.data.orders.pageInfo,
    },
  };
}

// ----------------------------------------------------------------------------
// readOrderDetail — single order, full picture
// ----------------------------------------------------------------------------

export async function readOrderDetail(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<OrderDetail>> {
  const parsed = ReadOrderDetailInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }
  return fetchOrderDetail(admin, parsed.data.orderId);
}

// ----------------------------------------------------------------------------
// updateOrderNote — admin-only note (customer never sees it). Empty string
// clears the note; null is rejected by Zod. Returns the post-update full
// snapshot so the result + AuditLog after-state stay canonical across all
// order writes.
// ----------------------------------------------------------------------------

export async function updateOrderNote(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<OrderDetail>> {
  const parsed = UpdateOrderNoteInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<OrderUpdateResponse>(
    admin,
    ORDER_UPDATE_MUTATION,
    { input: { id: parsed.data.orderId, note: parsed.data.note } },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.orderUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  if (!result.data.orderUpdate.order) {
    return { ok: false, error: "orderUpdate returned no order" };
  }

  return fetchOrderDetail(admin, parsed.data.orderId);
}

// ----------------------------------------------------------------------------
// updateOrderTags — REPLACEMENT semantics. Caller passes the FULL desired
// tag list; the manager prompt teaches the merge-first workflow (read
// existing tags, append/remove, propose with full final list). Mirrors
// update_customer_tags / update_product_tags exactly.
// ----------------------------------------------------------------------------

export async function updateOrderTags(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<OrderDetail>> {
  const parsed = UpdateOrderTagsInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<OrderUpdateResponse>(
    admin,
    ORDER_UPDATE_MUTATION,
    { input: { id: parsed.data.orderId, tags: parsed.data.tags } },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.orderUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  if (!result.data.orderUpdate.order) {
    return { ok: false, error: "orderUpdate returned no order" };
  }

  return fetchOrderDetail(admin, parsed.data.orderId);
}

// ----------------------------------------------------------------------------
// V-Or-C — Fetch the order's open FulfillmentOrders. Used by both
// markAsFulfilled and fulfillOrderWithTracking. Filters client-side
// to FOs that can actually be fulfilled (OPEN, IN_PROGRESS,
// INCOMPLETE) — CLOSED and CANCELLED FOs would error if we tried to
// fulfill them.
// ----------------------------------------------------------------------------

const FULFILLABLE_FO_STATUSES = new Set(["OPEN", "IN_PROGRESS", "INCOMPLETE"]);

async function fetchOpenFulfillmentOrders(
  admin: ShopifyAdmin,
  orderId: string,
): Promise<ToolModuleResult<{ fulfillmentOrderIds: string[] }>> {
  const result = await graphqlRequest<FulfillmentOrderListResponse>(
    admin,
    FETCH_FULFILLMENT_ORDERS_QUERY,
    { id: orderId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.order) {
    return { ok: false, error: `order not found: ${orderId}` };
  }
  const ids = result.data.order.fulfillmentOrders.edges
    .filter((e) => FULFILLABLE_FO_STATUSES.has(e.node.status))
    .map((e) => e.node.id);
  return { ok: true, data: { fulfillmentOrderIds: ids } };
}

// ----------------------------------------------------------------------------
// markAsFulfilled — fulfill all open FulfillmentOrders without tracking.
// For stores that ship before adding tracking, or for digital/non-tracked
// goods. SHOPIFY EMAILS THE CUSTOMER unless notifyCustomer:false.
// ----------------------------------------------------------------------------

export async function markAsFulfilled(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<OrderDetail>> {
  const parsed = MarkAsFulfilledInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const fos = await fetchOpenFulfillmentOrders(admin, parsed.data.orderId);
  if (!fos.ok) return fos;
  if (fos.data.fulfillmentOrderIds.length === 0) {
    return {
      ok: false,
      error:
        "no open fulfillment orders — order is already fulfilled, cancelled, or has no items to fulfill",
    };
  }

  const result = await graphqlRequest<FulfillmentCreateResponse>(
    admin,
    FULFILLMENT_CREATE_MUTATION,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: fos.data.fulfillmentOrderIds.map((id) => ({
          fulfillmentOrderId: id,
        })),
        notifyCustomer: parsed.data.notifyCustomer,
      },
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.fulfillmentCreateV2.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  if (!result.data.fulfillmentCreateV2.fulfillment) {
    return { ok: false, error: "fulfillmentCreateV2 returned no fulfillment" };
  }

  return fetchOrderDetail(admin, parsed.data.orderId);
}

// ----------------------------------------------------------------------------
// fulfillOrderWithTracking — same as markAsFulfilled but with carrier +
// tracking number + (optional) tracking URL. Shopify auto-generates the
// URL for known carriers (USPS / FedEx / UPS / DHL etc.); merchant can
// override with trackingUrl. The customer gets a shipping confirmation
// email with the tracking link unless notifyCustomer:false.
// ----------------------------------------------------------------------------

export async function fulfillOrderWithTracking(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<OrderDetail>> {
  const parsed = FulfillOrderWithTrackingInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const fos = await fetchOpenFulfillmentOrders(admin, parsed.data.orderId);
  if (!fos.ok) return fos;
  if (fos.data.fulfillmentOrderIds.length === 0) {
    return {
      ok: false,
      error:
        "no open fulfillment orders — order is already fulfilled, cancelled, or has no items to fulfill",
    };
  }

  const trackingInfo: Record<string, unknown> = {
    number: parsed.data.trackingNumber,
    company: parsed.data.trackingCompany,
  };
  if (parsed.data.trackingUrl !== undefined) {
    trackingInfo.url = parsed.data.trackingUrl;
  }

  const result = await graphqlRequest<FulfillmentCreateResponse>(
    admin,
    FULFILLMENT_CREATE_MUTATION,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: fos.data.fulfillmentOrderIds.map((id) => ({
          fulfillmentOrderId: id,
        })),
        trackingInfo,
        notifyCustomer: parsed.data.notifyCustomer,
      },
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.fulfillmentCreateV2.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  if (!result.data.fulfillmentCreateV2.fulfillment) {
    return { ok: false, error: "fulfillmentCreateV2 returned no fulfillment" };
  }

  return fetchOrderDetail(admin, parsed.data.orderId);
}

// ----------------------------------------------------------------------------
// V-Or-D — Order cancellation. Hard-codes refund:false + restock:false at
// the GraphQL layer (mutation literal includes those values, not as
// inputs) — refunds route through refund_order with their own audit
// trail; restock is the future Inventory dept's domain. SHOPIFY EMAILS
// THE CUSTOMER on cancel unless notifyCustomer:false.
// ----------------------------------------------------------------------------

export async function cancelOrder(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<OrderDetail>> {
  const parsed = CancelOrderInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const variables: Record<string, unknown> = {
    orderId: parsed.data.orderId,
    reason: parsed.data.reason,
    notifyCustomer: parsed.data.notifyCustomer,
  };
  if (parsed.data.staffNote !== undefined) {
    variables.staffNote = parsed.data.staffNote;
  }

  const result = await graphqlRequest<OrderCancelResponse>(
    admin,
    ORDER_CANCEL_MUTATION,
    variables,
  );
  if (!result.ok) return { ok: false, error: result.error };

  // orderCancel surfaces errors in TWO buckets — the typed
  // orderCancelUserErrors with a code, AND the generic userErrors. We
  // surface both verbatim to preserve the typed error code (per CEO
  // rule 7).
  const cancelErrors = result.data.orderCancel.orderCancelUserErrors;
  if (cancelErrors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${cancelErrors.map((e) => e.message).join("; ")}`,
    };
  }
  const errors = result.data.orderCancel.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }

  // orderCancel returns a Job (async). Refetch the order to get the
  // post-cancel snapshot — Shopify usually completes the cancel
  // synchronously enough that the next read reflects it. If not,
  // displayFinancialStatus / cancelledAt will lag for a moment but
  // the AuditLog after-state still captures whatever Shopify shows.
  return fetchOrderDetail(admin, parsed.data.orderId);
}

// ----------------------------------------------------------------------------
// V-Or-D — Order refund. The most defensive write in the codebase. Three
// independent gates BEFORE the mutation fires:
//   1. Zod refine (already enforced) — confirmAmount equals amount.
//   2. fetchOrderDetail snapshot — verify currencyCode matches the
//      order's actual currency.
//   3. Same snapshot — verify amount ≤ totalRefundable. Refunding more
//      than what's outstanding silently or via Shopify error is a
//      worse experience than a clean upfront refusal.
//
// Then a SEPARATE fetch of the order's transactions to find the parent
// SALE/CAPTURE — refundCreate's transactions[].parentId must reference
// a real successful payment transaction. No parent ⇒ refund refusal
// (e.g. authorized-but-uncaptured orders, fully voided orders).
//
// Mutation includes the @idempotent directive with a per-call UUID so
// retries (network glitches, lambda re-runs) don't double-refund. The
// idempotency key is generated server-side; the merchant doesn't see it.
// ----------------------------------------------------------------------------

async function findRefundParentTransaction(
  admin: ShopifyAdmin,
  orderId: string,
): Promise<
  ToolModuleResult<{ parentId: string; gateway: string }>
> {
  const result = await graphqlRequest<FetchOrderTransactionsResponse>(
    admin,
    FETCH_ORDER_TRANSACTIONS_QUERY,
    { id: orderId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.order) {
    return { ok: false, error: `order not found: ${orderId}` };
  }
  // Find the first successful sale/capture. Split-payment orders are
  // rare in v1 territory; we refund against the primary payment.
  const parent = result.data.order.transactions.find(
    (t) =>
      (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS",
  );
  if (!parent) {
    return {
      ok: false,
      error:
        "no successful sale/capture transaction found on this order — cannot refund (the order may be authorized-but-uncaptured, voided, or fully refunded already)",
    };
  }
  if (!parent.gateway) {
    return {
      ok: false,
      error: "parent transaction has no gateway — cannot construct refund",
    };
  }
  return { ok: true, data: { parentId: parent.id, gateway: parent.gateway } };
}

export async function refundOrder(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<OrderDetail>> {
  // Gate 1: Zod refine on confirmAmount === amount, plus regex on amount
  // shape. Already happens here.
  const parsed = RefundOrderInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Gate 2 + 3: fetch the order, verify currency match + amount cap.
  const orderSnap = await fetchOrderDetail(admin, parsed.data.orderId);
  if (!orderSnap.ok) return orderSnap;
  const order = orderSnap.data;

  if (order.currencyCode !== parsed.data.currencyCode) {
    return {
      ok: false,
      error: `currency mismatch: order is ${order.currencyCode}, refund requested as ${parsed.data.currencyCode} — refusing to refund (Shopify wouldn't auto-convert; the merchant must confirm the order's actual currency)`,
    };
  }

  // Compare in cents to avoid float drift.
  const amountCents = Math.round(parseFloat(parsed.data.amount) * 100);
  const refundableCents = Math.round(parseFloat(order.totalRefundable) * 100);
  if (amountCents > refundableCents) {
    return {
      ok: false,
      error: `requested refund $${parsed.data.amount} exceeds outstanding-refundable $${order.totalRefundable} — refusing (the order may be partially or fully refunded already)`,
    };
  }

  // Gate 4 (implicit): find the parent SALE/CAPTURE to refund against.
  // No successful payment ⇒ nothing to refund.
  const parent = await findRefundParentTransaction(admin, parsed.data.orderId);
  if (!parent.ok) return parent;

  // Build the refund input. transactions array specifies WHICH
  // transaction to refund against and HOW MUCH. No shipping/lineItem
  // allocation in v1 — Shopify treats this as a generic refund.
  const idempotencyKey = randomUUID();
  const refundInput: Record<string, unknown> = {
    orderId: parsed.data.orderId,
    notify: parsed.data.notifyCustomer,
    transactions: [
      {
        orderId: parsed.data.orderId,
        parentId: parent.data.parentId,
        gateway: parent.data.gateway,
        amount: parsed.data.amount,
        kind: "REFUND",
      },
    ],
  };
  if (parsed.data.reason !== undefined) {
    refundInput.note = parsed.data.reason;
  }

  const result = await graphqlRequest<RefundCreateResponse>(
    admin,
    REFUND_CREATE_MUTATION,
    {
      input: refundInput,
      idempotencyKey,
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.refundCreate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  if (!result.data.refundCreate.refund) {
    return { ok: false, error: "refundCreate returned no refund" };
  }

  // Refetch the order so the post-refund snapshot reflects the new
  // totalRefunded / totalRefundable / refunds[] state. Same canonical-
  // snapshot pattern as every other order write.
  return fetchOrderDetail(admin, parsed.data.orderId);
}

// ----------------------------------------------------------------------------
// Test seam — exported only for unit tests.
// ----------------------------------------------------------------------------

export const _testing = {
  subtractMoney,
  // V-Or-D — Surfaced so tests can verify the @idempotent directive is
  // present in the mutation query string (Shopify 2026-04 requirement).
  REFUND_CREATE_MUTATION,
  ORDER_CANCEL_MUTATION,
};
