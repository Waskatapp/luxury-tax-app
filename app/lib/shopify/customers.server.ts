// V-Cu-A — Customers department core. Reads + writes for the merchant's
// customer list. Today owns: list+filter, single-customer detail (incl.
// LTV stats + recent orders + marketing consent state), partial identity
// edits (name/email/phone/note), tag replacement, and email + SMS
// marketing-consent updates.
//
// Scopes required: read_customers (read), write_customers (mutations).
// Both added to shopify.app.toml in Round Cu-A; the dev store must be
// re-installed before any of these calls succeed.
//
// Marketing-consent writes are doubly-careful: each consent change
// produces its own AuditLog entry. Email and SMS are SEPARATE tools
// because CAN-SPAM / TCPA / GDPR carry different legal weight per
// channel — merging them would muddle the audit trail.

import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ----------------------------------------------------------------------------
// Snapshot shapes
// ----------------------------------------------------------------------------

// Used in list results — slim, no order history, no addresses.
export type CustomerSummary = {
  customerId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  state: string; // ENABLED | DISABLED | INVITED | DECLINED
  numberOfOrders: number;
  amountSpent: string; // decimal string
  currencyCode: string;
  tags: string[];
  createdAt: string;
};

export type ReadCustomersResult = {
  customers: CustomerSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

// Marketing-consent shape returned everywhere consent shows up.
export type MarketingConsentState = {
  marketingState: string; // SUBSCRIBED | UNSUBSCRIBED | NOT_SUBSCRIBED | PENDING | REDACTED | INVALID
  marketingOptInLevel: string | null; // CONFIRMED_OPT_IN | SINGLE_OPT_IN | UNKNOWN
  consentUpdatedAt: string | null;
};

export type RecentOrderSummary = {
  orderId: string;
  name: string;
  totalPrice: string;
  currencyCode: string;
  processedAt: string | null;
  displayFinancialStatus: string | null;
};

export type DefaultAddressSummary = {
  address1: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  zip: string | null;
} | null;

// Full single-customer snapshot — used by read_customer_detail AND by
// snapshotBefore() for AuditLog before-state on every customer write.
// Kept in one shape so the snapshot helper is reused across all 4 writes
// without per-tool customization.
export type CustomerDetail = {
  customerId: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  state: string;
  tags: string[];
  note: string | null;
  numberOfOrders: number;
  amountSpent: string;
  currencyCode: string;
  emailMarketingConsent: MarketingConsentState | null;
  smsMarketingConsent: MarketingConsentState | null;
  defaultAddress: DefaultAddressSummary;
  recentOrders: RecentOrderSummary[];
  lastOrder: { orderId: string; name: string; processedAt: string | null } | null;
  createdAt: string;
  updatedAt: string;
};

// ----------------------------------------------------------------------------
// Input schemas
// ----------------------------------------------------------------------------

const TAG_MAX = 250;

export const ReadCustomersInput = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  query: z.string().optional(),
});

export const ReadCustomerDetailInput = z.object({
  customerId: z.string().min(1),
});

export const UpdateCustomerInput = z
  .object({
    customerId: z.string().min(1),
    firstName: z.string().max(255).optional(),
    lastName: z.string().max(255).optional(),
    email: z.string().email().max(255).optional(),
    phone: z.string().max(50).optional(),
    note: z.string().max(5000).optional(),
  })
  .refine(
    (v) =>
      v.firstName !== undefined ||
      v.lastName !== undefined ||
      v.email !== undefined ||
      v.phone !== undefined ||
      v.note !== undefined,
    { message: "must provide at least one of firstName / lastName / email / phone / note" },
  );

export const UpdateCustomerTagsInput = z.object({
  customerId: z.string().min(1),
  // FULL replacement list — not delta. The Customers manager prompt
  // teaches the merge-first workflow (read existing tags, append/remove,
  // pass full final list).
  tags: z.array(z.string().min(1).max(TAG_MAX)).max(250),
});

export const UpdateEmailMarketingConsentInput = z.object({
  customerId: z.string().min(1),
  subscribed: z.boolean(),
});

export const UpdateSmsMarketingConsentInput = z.object({
  customerId: z.string().min(1),
  subscribed: z.boolean(),
});

// ----------------------------------------------------------------------------
// GraphQL
// ----------------------------------------------------------------------------

const READ_CUSTOMERS_QUERY = `#graphql
  query ReadCustomers($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          displayName
          email
          phone
          state
          numberOfOrders
          amountSpent { amount currencyCode }
          tags
          createdAt
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Single-customer fetch: identity + consent + lifetime stats + recent
// orders + default address. One round-trip; small fields. Used by both
// read_customer_detail and snapshotBefore() for write tools.
const FETCH_CUSTOMER_DETAIL_QUERY = `#graphql
  query FetchCustomerDetail($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      displayName
      email
      phone
      state
      tags
      note
      numberOfOrders
      amountSpent { amount currencyCode }
      emailMarketingConsent {
        marketingState
        marketingOptInLevel
        consentUpdatedAt
      }
      smsMarketingConsent {
        marketingState
        marketingOptInLevel
        consentUpdatedAt
      }
      defaultAddress {
        address1
        city
        province
        country
        zip
      }
      lastOrder { id name processedAt }
      orders(first: 10, sortKey: PROCESSED_AT, reverse: true) {
        edges {
          node {
            id
            name
            totalPriceSet { shopMoney { amount currencyCode } }
            processedAt
            displayFinancialStatus
          }
        }
      }
      createdAt
      updatedAt
    }
  }
`;

const CUSTOMER_UPDATE_MUTATION = `#graphql
  mutation CustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const CUSTOMER_EMAIL_CONSENT_MUTATION = `#graphql
  mutation CustomerEmailConsent($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) {
      customer {
        id
        emailMarketingConsent {
          marketingState
          marketingOptInLevel
          consentUpdatedAt
        }
      }
      userErrors { field message }
    }
  }
`;

const CUSTOMER_SMS_CONSENT_MUTATION = `#graphql
  mutation CustomerSmsConsent($input: CustomerSmsMarketingConsentUpdateInput!) {
    customerSmsMarketingConsentUpdate(input: $input) {
      customer {
        id
        smsMarketingConsent {
          marketingState
          marketingOptInLevel
          consentUpdatedAt
        }
      }
      userErrors { field message }
    }
  }
`;

// ----------------------------------------------------------------------------
// GraphQL response types
// ----------------------------------------------------------------------------

type CustomerListNode = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  state: string;
  numberOfOrders: string | number; // Shopify returns UnsignedInt64 as string
  amountSpent: { amount: string; currencyCode: string };
  tags: string[];
  createdAt: string;
};

type CustomerDetailNode = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  state: string;
  tags: string[];
  note: string | null;
  numberOfOrders: string | number;
  amountSpent: { amount: string; currencyCode: string };
  emailMarketingConsent: {
    marketingState: string;
    marketingOptInLevel: string | null;
    consentUpdatedAt: string | null;
  } | null;
  smsMarketingConsent: {
    marketingState: string;
    marketingOptInLevel: string | null;
    consentUpdatedAt: string | null;
  } | null;
  defaultAddress: {
    address1: string | null;
    city: string | null;
    province: string | null;
    country: string | null;
    zip: string | null;
  } | null;
  lastOrder: { id: string; name: string; processedAt: string | null } | null;
  orders: {
    edges: Array<{
      node: {
        id: string;
        name: string;
        totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        processedAt: string | null;
        displayFinancialStatus: string | null;
      };
    }>;
  };
  createdAt: string;
  updatedAt: string;
};

type ReadCustomersResponse = {
  customers: {
    edges: Array<{ cursor: string; node: CustomerListNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type FetchCustomerDetailResponse = { customer: CustomerDetailNode | null };

type CustomerUpdateResponse = {
  customerUpdate: {
    customer: { id: string } | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
};

type CustomerEmailConsentResponse = {
  customerEmailMarketingConsentUpdate: {
    customer: {
      id: string;
      emailMarketingConsent: {
        marketingState: string;
        marketingOptInLevel: string | null;
        consentUpdatedAt: string | null;
      } | null;
    } | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
};

type CustomerSmsConsentResponse = {
  customerSmsMarketingConsentUpdate: {
    customer: {
      id: string;
      smsMarketingConsent: {
        marketingState: string;
        marketingOptInLevel: string | null;
        consentUpdatedAt: string | null;
      } | null;
    } | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
};

// ----------------------------------------------------------------------------
// Mappers
// ----------------------------------------------------------------------------

// numberOfOrders comes back as UnsignedInt64 (string) in Shopify's GraphQL
// schema; coerce defensively in case some versions return a number.
function toInt(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function listNodeToSummary(node: CustomerListNode): CustomerSummary {
  return {
    customerId: node.id,
    displayName: node.displayName,
    email: node.email,
    phone: node.phone,
    state: node.state,
    numberOfOrders: toInt(node.numberOfOrders),
    amountSpent: node.amountSpent.amount,
    currencyCode: node.amountSpent.currencyCode,
    tags: node.tags,
    createdAt: node.createdAt,
  };
}

function detailNodeToSnapshot(node: CustomerDetailNode): CustomerDetail {
  return {
    customerId: node.id,
    firstName: node.firstName,
    lastName: node.lastName,
    displayName: node.displayName,
    email: node.email,
    phone: node.phone,
    state: node.state,
    tags: node.tags,
    note: node.note,
    numberOfOrders: toInt(node.numberOfOrders),
    amountSpent: node.amountSpent.amount,
    currencyCode: node.amountSpent.currencyCode,
    emailMarketingConsent: node.emailMarketingConsent
      ? {
          marketingState: node.emailMarketingConsent.marketingState,
          marketingOptInLevel: node.emailMarketingConsent.marketingOptInLevel,
          consentUpdatedAt: node.emailMarketingConsent.consentUpdatedAt,
        }
      : null,
    smsMarketingConsent: node.smsMarketingConsent
      ? {
          marketingState: node.smsMarketingConsent.marketingState,
          marketingOptInLevel: node.smsMarketingConsent.marketingOptInLevel,
          consentUpdatedAt: node.smsMarketingConsent.consentUpdatedAt,
        }
      : null,
    defaultAddress: node.defaultAddress
      ? {
          address1: node.defaultAddress.address1,
          city: node.defaultAddress.city,
          province: node.defaultAddress.province,
          country: node.defaultAddress.country,
          zip: node.defaultAddress.zip,
        }
      : null,
    recentOrders: node.orders.edges.map((e) => ({
      orderId: e.node.id,
      name: e.node.name,
      totalPrice: e.node.totalPriceSet.shopMoney.amount,
      currencyCode: e.node.totalPriceSet.shopMoney.currencyCode,
      processedAt: e.node.processedAt,
      displayFinancialStatus: e.node.displayFinancialStatus,
    })),
    lastOrder: node.lastOrder
      ? {
          orderId: node.lastOrder.id,
          name: node.lastOrder.name,
          processedAt: node.lastOrder.processedAt,
        }
      : null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

// ----------------------------------------------------------------------------
// fetchCustomerDetail — snapshot helper used by snapshotBefore() in
// executor.server.ts AND by readCustomerDetail() (the user-facing read).
// One canonical query; one canonical shape.
// ----------------------------------------------------------------------------

export async function fetchCustomerDetail(
  admin: ShopifyAdmin,
  customerId: string,
): Promise<ToolModuleResult<CustomerDetail>> {
  const result = await graphqlRequest<FetchCustomerDetailResponse>(
    admin,
    FETCH_CUSTOMER_DETAIL_QUERY,
    { id: customerId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.customer) {
    return { ok: false, error: `customer not found: ${customerId}` };
  }
  return { ok: true, data: detailNodeToSnapshot(result.data.customer) };
}

// ----------------------------------------------------------------------------
// readCustomers — list + search
// ----------------------------------------------------------------------------

export async function readCustomers(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadCustomersResult>> {
  const parsed = ReadCustomersInput.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ReadCustomersResponse>(
    admin,
    READ_CUSTOMERS_QUERY,
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
      customers: result.data.customers.edges.map((e) =>
        listNodeToSummary(e.node),
      ),
      pageInfo: result.data.customers.pageInfo,
    },
  };
}

// ----------------------------------------------------------------------------
// readCustomerDetail — single customer full snapshot
// ----------------------------------------------------------------------------

export async function readCustomerDetail(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<CustomerDetail>> {
  const parsed = ReadCustomerDetailInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }
  return fetchCustomerDetail(admin, parsed.data.customerId);
}

// ----------------------------------------------------------------------------
// updateCustomer — partial identity edit. Only fields the caller sets are
// included in the mutation input; omitted fields stay untouched.
// ----------------------------------------------------------------------------

export async function updateCustomer(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<CustomerDetail>> {
  const parsed = UpdateCustomerInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const input: Record<string, unknown> = { id: parsed.data.customerId };
  if (parsed.data.firstName !== undefined) input.firstName = parsed.data.firstName;
  if (parsed.data.lastName !== undefined) input.lastName = parsed.data.lastName;
  if (parsed.data.email !== undefined) input.email = parsed.data.email;
  if (parsed.data.phone !== undefined) input.phone = parsed.data.phone;
  if (parsed.data.note !== undefined) input.note = parsed.data.note;

  const result = await graphqlRequest<CustomerUpdateResponse>(
    admin,
    CUSTOMER_UPDATE_MUTATION,
    { input },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.customerUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  if (!result.data.customerUpdate.customer) {
    return { ok: false, error: "customerUpdate returned no customer" };
  }

  // Fetch the post-update snapshot so the result + AuditLog after-state
  // are complete. customerUpdate's own return shape is sparse (no consent,
  // no orders); refetch keeps the invariant "result.data === full
  // CustomerDetail snapshot" stable across every customer write tool.
  return fetchCustomerDetail(admin, parsed.data.customerId);
}

// ----------------------------------------------------------------------------
// updateCustomerTags — replacement-set semantics (FULL list, not delta).
// The manager's prompt teaches the merge-first workflow.
// ----------------------------------------------------------------------------

export async function updateCustomerTags(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<CustomerDetail>> {
  const parsed = UpdateCustomerTagsInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<CustomerUpdateResponse>(
    admin,
    CUSTOMER_UPDATE_MUTATION,
    { input: { id: parsed.data.customerId, tags: parsed.data.tags } },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.customerUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }

  return fetchCustomerDetail(admin, parsed.data.customerId);
}

// ----------------------------------------------------------------------------
// updateEmailMarketingConsent — sensitive (CAN-SPAM / GDPR).
// Maps friendly `subscribed: bool` to Shopify's enum. v1 always sends
// SINGLE_OPT_IN — double opt-in workflows can be exposed in a later
// round if a merchant's compliance setup needs CONFIRMED_OPT_IN.
// ----------------------------------------------------------------------------

export async function updateEmailMarketingConsent(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<{ customerId: string; consent: MarketingConsentState }>> {
  const parsed = UpdateEmailMarketingConsentInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const consentUpdatedAt = new Date().toISOString();
  const input = {
    customerId: parsed.data.customerId,
    emailMarketingConsent: {
      marketingState: parsed.data.subscribed ? "SUBSCRIBED" : "UNSUBSCRIBED",
      marketingOptInLevel: "SINGLE_OPT_IN",
      consentUpdatedAt,
    },
  };

  const result = await graphqlRequest<CustomerEmailConsentResponse>(
    admin,
    CUSTOMER_EMAIL_CONSENT_MUTATION,
    { input },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.customerEmailMarketingConsentUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const customer = result.data.customerEmailMarketingConsentUpdate.customer;
  if (!customer || !customer.emailMarketingConsent) {
    return {
      ok: false,
      error: "customerEmailMarketingConsentUpdate returned no consent state",
    };
  }

  return {
    ok: true,
    data: {
      customerId: customer.id,
      consent: {
        marketingState: customer.emailMarketingConsent.marketingState,
        marketingOptInLevel: customer.emailMarketingConsent.marketingOptInLevel,
        consentUpdatedAt: customer.emailMarketingConsent.consentUpdatedAt,
      },
    },
  };
}

// ----------------------------------------------------------------------------
// updateSmsMarketingConsent — sensitive (TCPA / GDPR). Same shape as the
// email version; separate tool because the legal regimes differ per
// channel and merging would muddle the AuditLog trail.
// ----------------------------------------------------------------------------

export async function updateSmsMarketingConsent(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<{ customerId: string; consent: MarketingConsentState }>> {
  const parsed = UpdateSmsMarketingConsentInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const consentUpdatedAt = new Date().toISOString();
  const input = {
    customerId: parsed.data.customerId,
    smsMarketingConsent: {
      marketingState: parsed.data.subscribed ? "SUBSCRIBED" : "UNSUBSCRIBED",
      marketingOptInLevel: "SINGLE_OPT_IN",
      consentUpdatedAt,
    },
  };

  const result = await graphqlRequest<CustomerSmsConsentResponse>(
    admin,
    CUSTOMER_SMS_CONSENT_MUTATION,
    { input },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.customerSmsMarketingConsentUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const customer = result.data.customerSmsMarketingConsentUpdate.customer;
  if (!customer || !customer.smsMarketingConsent) {
    return {
      ok: false,
      error: "customerSmsMarketingConsentUpdate returned no consent state",
    };
  }

  return {
    ok: true,
    data: {
      customerId: customer.id,
      consent: {
        marketingState: customer.smsMarketingConsent.marketingState,
        marketingOptInLevel: customer.smsMarketingConsent.marketingOptInLevel,
        consentUpdatedAt: customer.smsMarketingConsent.consentUpdatedAt,
      },
    },
  };
}
