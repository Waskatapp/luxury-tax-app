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
// Test seam — exported only for unit tests.
// ----------------------------------------------------------------------------

export const _testing = {
  subtractMoney,
};
