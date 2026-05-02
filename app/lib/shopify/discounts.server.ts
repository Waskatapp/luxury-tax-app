import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> = { ok: true; data: T } | { ok: false; error: string };

// Percent-off automatic discount, store-wide. Phase 6 will add scoped variants
// (collection-only, product-only, customer-segment, etc.).
const CreateDiscountInput = z.object({
  title: z.string().min(1).max(255),
  percentOff: z.number().int().min(1).max(100),
  startsAt: z.string().min(10), // ISO-8601 date or date-time
  endsAt: z.string().min(10).optional(),
});

const DISCOUNT_AUTOMATIC_BASIC_CREATE_MUTATION = `#graphql
  mutation DiscountAutomaticBasicCreate($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
      automaticDiscountNode {
        id
        automaticDiscount {
          ... on DiscountAutomaticBasic {
            title
            startsAt
            endsAt
            status
            customerGets {
              value {
                ... on DiscountPercentage { percentage }
              }
            }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

type DiscountCreateResponse = {
  discountAutomaticBasicCreate: {
    automaticDiscountNode: {
      id: string;
      automaticDiscount: {
        title?: string;
        startsAt?: string;
        endsAt?: string | null;
        status?: string;
        customerGets?: {
          value?: { percentage?: number };
        };
      };
    } | null;
    userErrors: Array<{ field: string[] | null; message: string; code?: string }>;
  };
};

export type CreatedDiscountSummary = {
  id: string;
  title: string;
  percentOff: number;
  startsAt: string;
  endsAt: string | null;
  status: string;
};

export async function createDiscount(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<CreatedDiscountSummary>> {
  const parsed = CreateDiscountInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Shopify expects percentage as a decimal between 0 and 1 (e.g. 0.10 for 10%).
  const percentageDecimal = parsed.data.percentOff / 100;

  // DiscountAutomaticBasicInput does NOT accept customerSelection (that's
  // only on DiscountCodeBasicInput) or minimumRequirement at this level.
  // Automatic discounts apply to all customers by default; no minimum needed.
  const result = await graphqlRequest<DiscountCreateResponse>(
    admin,
    DISCOUNT_AUTOMATIC_BASIC_CREATE_MUTATION,
    {
      automaticBasicDiscount: {
        title: parsed.data.title,
        startsAt: parsed.data.startsAt,
        ...(parsed.data.endsAt ? { endsAt: parsed.data.endsAt } : {}),
        customerGets: {
          value: { percentage: percentageDecimal },
          items: { all: true },
        },
      },
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const payload = result.data.discountAutomaticBasicCreate;
  if (payload.userErrors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${payload.userErrors.map((e) => e.message).join("; ")}`,
    };
  }
  const node = payload.automaticDiscountNode;
  if (!node) {
    return {
      ok: false,
      error: "discountAutomaticBasicCreate returned no automaticDiscountNode",
    };
  }

  const inner = node.automaticDiscount ?? {};
  const apiPercentage = inner.customerGets?.value?.percentage ?? percentageDecimal;
  return {
    ok: true,
    data: {
      id: node.id,
      title: inner.title ?? parsed.data.title,
      percentOff: Math.round(apiPercentage * 100),
      startsAt: inner.startsAt ?? parsed.data.startsAt,
      endsAt: inner.endsAt ?? null,
      status: inner.status ?? "ACTIVE",
    },
  };
}

// ----------------------------------------------------------------------------
// read_discounts (read — runs inline during sub-agent turn)
//
// Lists every discount on the store: automatic + code, basic + Bxgy +
// free-shipping. Returns a normalized shape so the CEO can format the
// list without knowing Shopify's discount-type taxonomy.
//
// Pagination: default 20, max 50. `query` parameter for filtering; same
// agentic-search treatment as readProducts / readCollections — bare
// keywords match across title; `field:value` narrows.
// ----------------------------------------------------------------------------

const ReadDiscountsInput = z.object({
  first: z.number().int().min(1).max(50).default(20),
  after: z.string().optional(),
  query: z.string().optional(),
});

const READ_DISCOUNTS_QUERY = `#graphql
  query ReadDiscounts($first: Int!, $after: String, $query: String) {
    discountNodes(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          discount {
            __typename
            ... on DiscountAutomaticBasic {
              title
              status
              startsAt
              endsAt
              summary
            }
            ... on DiscountAutomaticBxgy {
              title
              status
              startsAt
              endsAt
              summary
            }
            ... on DiscountAutomaticFreeShipping {
              title
              status
              startsAt
              endsAt
              summary
            }
            ... on DiscountCodeBasic {
              title
              status
              startsAt
              endsAt
              summary
              codes(first: 1) {
                edges { node { code } }
              }
              asyncUsageCount
            }
            ... on DiscountCodeBxgy {
              title
              status
              startsAt
              endsAt
              summary
              codes(first: 1) {
                edges { node { code } }
              }
              asyncUsageCount
            }
            ... on DiscountCodeFreeShipping {
              title
              status
              startsAt
              endsAt
              summary
              codes(first: 1) {
                edges { node { code } }
              }
              asyncUsageCount
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type RawDiscountNode = {
  id: string;
  discount: {
    __typename?: string;
    title?: string;
    status?: string;
    startsAt?: string;
    endsAt?: string | null;
    summary?: string;
    codes?: {
      edges: Array<{ node: { code: string } }>;
    };
    asyncUsageCount?: number;
  };
};

type RawDiscountsResponse = {
  discountNodes: {
    edges: Array<{ cursor: string; node: RawDiscountNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export type DiscountSummary = {
  id: string;
  title: string;
  type:
    | "automaticBasic"
    | "automaticBxgy"
    | "automaticFreeShipping"
    | "codeBasic"
    | "codeBxgy"
    | "codeFreeShipping"
    | "unknown";
  status: string;
  startsAt: string;
  endsAt: string | null;
  summary: string;
  // For code discounts only — null on automatic discounts.
  code: string | null;
  usageCount: number | null;
};

export type ReadDiscountsResult = {
  discounts: DiscountSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

function mapDiscountTypename(
  typename: string | undefined,
): DiscountSummary["type"] {
  switch (typename) {
    case "DiscountAutomaticBasic":
      return "automaticBasic";
    case "DiscountAutomaticBxgy":
      return "automaticBxgy";
    case "DiscountAutomaticFreeShipping":
      return "automaticFreeShipping";
    case "DiscountCodeBasic":
      return "codeBasic";
    case "DiscountCodeBxgy":
      return "codeBxgy";
    case "DiscountCodeFreeShipping":
      return "codeFreeShipping";
    default:
      return "unknown";
  }
}

export async function readDiscounts(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadDiscountsResult>> {
  const parsed = ReadDiscountsInput.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<RawDiscountsResponse>(
    admin,
    READ_DISCOUNTS_QUERY,
    {
      first: parsed.data.first,
      after: parsed.data.after ?? null,
      query: parsed.data.query ?? null,
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const discounts: DiscountSummary[] = result.data.discountNodes.edges.map(
    (edge) => {
      const node = edge.node;
      const d = node.discount;
      const code = d.codes?.edges?.[0]?.node?.code ?? null;
      return {
        id: node.id,
        title: d.title ?? "(untitled)",
        type: mapDiscountTypename(d.__typename),
        status: d.status ?? "UNKNOWN",
        startsAt: d.startsAt ?? "",
        endsAt: d.endsAt ?? null,
        summary: d.summary ?? "",
        code,
        usageCount: d.asyncUsageCount ?? null,
      };
    },
  );

  return {
    ok: true,
    data: {
      discounts,
      pageInfo: result.data.discountNodes.pageInfo,
    },
  };
}

// ----------------------------------------------------------------------------
// fetchDiscount + lifecycle (Round PP-B)
//
// One snapshot helper shared by update / set_status / delete. Returns
// the discount's identifying info + type so callers can distinguish
// basic from Bxgy. Round PP-B only touches BASIC discounts via these
// lifecycle tools — Bxgy updates require a different mutation
// (discountAutomaticBxgyUpdate) and a much larger input shape; deferred.
// Bxgy discounts CAN still be paused / activated / deleted via the
// shared automatic lifecycle mutations — those are type-agnostic.
// ----------------------------------------------------------------------------

const FETCH_DISCOUNT_QUERY = `#graphql
  query FetchDiscount($id: ID!) {
    automaticDiscountNode(id: $id) {
      id
      automaticDiscount {
        __typename
        ... on DiscountAutomaticBasic {
          title
          status
          startsAt
          endsAt
          summary
          customerGets {
            value {
              ... on DiscountPercentage { percentage }
            }
          }
        }
        ... on DiscountAutomaticBxgy {
          title
          status
          startsAt
          endsAt
          summary
        }
        ... on DiscountAutomaticFreeShipping {
          title
          status
          startsAt
          endsAt
          summary
        }
      }
    }
  }
`;

type FetchDiscountResponse = {
  automaticDiscountNode: {
    id: string;
    automaticDiscount: {
      __typename?: string;
      title?: string;
      status?: string;
      startsAt?: string;
      endsAt?: string | null;
      summary?: string;
      customerGets?: { value?: { percentage?: number } };
    };
  } | null;
};

export type DiscountSnapshot = {
  id: string;
  title: string;
  type:
    | "automaticBasic"
    | "automaticBxgy"
    | "automaticFreeShipping"
    | "unknown";
  status: string;
  startsAt: string;
  endsAt: string | null;
  summary: string;
  // Only present for automaticBasic — null for other types.
  percentOff: number | null;
};

function mapAutomaticDiscountTypename(
  typename: string | undefined,
): DiscountSnapshot["type"] {
  switch (typename) {
    case "DiscountAutomaticBasic":
      return "automaticBasic";
    case "DiscountAutomaticBxgy":
      return "automaticBxgy";
    case "DiscountAutomaticFreeShipping":
      return "automaticFreeShipping";
    default:
      return "unknown";
  }
}

export async function fetchDiscount(
  admin: ShopifyAdmin,
  discountId: string,
): Promise<ToolModuleResult<DiscountSnapshot>> {
  const result = await graphqlRequest<FetchDiscountResponse>(
    admin,
    FETCH_DISCOUNT_QUERY,
    { id: discountId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  const node = result.data.automaticDiscountNode;
  if (!node) {
    return { ok: false, error: `discount not found: ${discountId}` };
  }
  const inner = node.automaticDiscount ?? {};
  const type = mapAutomaticDiscountTypename(inner.__typename);
  const apiPercentage = inner.customerGets?.value?.percentage;
  return {
    ok: true,
    data: {
      id: node.id,
      title: inner.title ?? "(untitled)",
      type,
      status: inner.status ?? "UNKNOWN",
      startsAt: inner.startsAt ?? "",
      endsAt: inner.endsAt ?? null,
      summary: inner.summary ?? "",
      percentOff:
        type === "automaticBasic" && typeof apiPercentage === "number"
          ? Math.round(apiPercentage * 100)
          : null,
    },
  };
}

// ----------------------------------------------------------------------------
// update_discount (write — runs from approval route, never inline)
//
// Updates an existing automatic BASIC discount's title, dates, and/or
// percent off. Bxgy update is intentionally NOT exposed in v1 — different
// mutation, much larger input schema. The handler fetches the discount
// first and rejects if it's not basic; the merchant should delete and
// recreate via create_bundle_discount instead.
//
// endsAt has explicit-null semantics: passing `null` (not `undefined`)
// CLEARS an existing endsAt (makes the discount run indefinitely).
// Zod's `.nullable().optional()` distinguishes: missing key = no change;
// explicit null = clear.
// ----------------------------------------------------------------------------

const UpdateDiscountInput = z
  .object({
    discountId: z.string().min(1),
    title: z.string().min(1).max(255).optional(),
    percentOff: z.number().int().min(1).max(100).optional(),
    startsAt: z.string().min(10).optional(),
    endsAt: z.string().min(10).nullable().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.percentOff !== undefined ||
      v.startsAt !== undefined ||
      v.endsAt !== undefined,
    {
      message:
        "at least one of title/percentOff/startsAt/endsAt must be set",
    },
  );

const DISCOUNT_AUTOMATIC_BASIC_UPDATE_MUTATION = `#graphql
  mutation DiscountAutomaticBasicUpdate(
    $id: ID!
    $automaticBasicDiscount: DiscountAutomaticBasicInput!
  ) {
    discountAutomaticBasicUpdate(
      id: $id
      automaticBasicDiscount: $automaticBasicDiscount
    ) {
      automaticDiscountNode {
        id
        automaticDiscount {
          ... on DiscountAutomaticBasic {
            title
            status
            startsAt
            endsAt
            summary
            customerGets {
              value {
                ... on DiscountPercentage { percentage }
              }
            }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

type DiscountUpdateResponse = {
  discountAutomaticBasicUpdate: {
    automaticDiscountNode: {
      id: string;
      automaticDiscount: {
        title?: string;
        status?: string;
        startsAt?: string;
        endsAt?: string | null;
        summary?: string;
        customerGets?: { value?: { percentage?: number } };
      };
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type UpdatedDiscountSummary = {
  id: string;
  title: string;
  percentOff: number;
  startsAt: string;
  endsAt: string | null;
  status: string;
  summary: string;
};

export async function updateDiscount(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<UpdatedDiscountSummary>> {
  const parsed = UpdateDiscountInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Fetch first to verify the discount is basic. Bxgy updates require
  // a different mutation; reject with a clear message so the CEO can
  // route the merchant to delete + recreate.
  const snapshot = await fetchDiscount(admin, parsed.data.discountId);
  if (!snapshot.ok) return { ok: false, error: snapshot.error };
  if (snapshot.data.type !== "automaticBasic") {
    return {
      ok: false,
      error: `cannot update discount of type '${snapshot.data.type}' — update_discount only supports automaticBasic. To change a bundle (Bxgy) discount, delete it and create a new one via create_bundle_discount.`,
    };
  }

  // Build the input payload. Only include fields the merchant actually
  // changed — omitting a field tells Shopify to keep the existing value.
  // For endsAt, distinguish "didn't change" (omit) from "wants to clear"
  // (explicit null in payload). Zod's `.nullable().optional()` keeps
  // these two states separate via `parsed.data.endsAt === null`.
  const automaticBasicDiscount: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) {
    automaticBasicDiscount.title = parsed.data.title;
  }
  if (parsed.data.percentOff !== undefined) {
    automaticBasicDiscount.customerGets = {
      value: { percentage: parsed.data.percentOff / 100 },
      items: { all: true },
    };
  }
  if (parsed.data.startsAt !== undefined) {
    automaticBasicDiscount.startsAt = parsed.data.startsAt;
  }
  if (parsed.data.endsAt !== undefined) {
    automaticBasicDiscount.endsAt = parsed.data.endsAt; // could be string or null
  }

  const result = await graphqlRequest<DiscountUpdateResponse>(
    admin,
    DISCOUNT_AUTOMATIC_BASIC_UPDATE_MUTATION,
    {
      id: parsed.data.discountId,
      automaticBasicDiscount,
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const payload = result.data.discountAutomaticBasicUpdate;
  if (payload.userErrors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${payload.userErrors.map((e) => e.message).join("; ")}`,
    };
  }
  const node = payload.automaticDiscountNode;
  if (!node) {
    return {
      ok: false,
      error: "discountAutomaticBasicUpdate returned no automaticDiscountNode",
    };
  }
  const inner = node.automaticDiscount ?? {};
  const apiPercentage = inner.customerGets?.value?.percentage ?? null;
  return {
    ok: true,
    data: {
      id: node.id,
      title: inner.title ?? snapshot.data.title,
      percentOff:
        apiPercentage !== null
          ? Math.round(apiPercentage * 100)
          : (snapshot.data.percentOff ?? 0),
      startsAt: inner.startsAt ?? snapshot.data.startsAt,
      endsAt: inner.endsAt ?? null,
      status: inner.status ?? snapshot.data.status,
      summary: inner.summary ?? snapshot.data.summary,
    },
  };
}

// ----------------------------------------------------------------------------
// set_discount_status (write — runs from approval route, never inline)
//
// One tool, two underlying mutations. status="ACTIVE" → activate;
// status="PAUSED" → deactivate. Works for both basic and Bxgy
// automatic discounts (the underlying Shopify mutations are
// type-agnostic at this level).
// ----------------------------------------------------------------------------

const SetDiscountStatusInput = z.object({
  discountId: z.string().min(1),
  status: z.enum(["ACTIVE", "PAUSED"]),
});

const DISCOUNT_AUTOMATIC_ACTIVATE_MUTATION = `#graphql
  mutation DiscountAutomaticActivate($id: ID!) {
    discountAutomaticActivate(id: $id) {
      automaticDiscountNode {
        id
        automaticDiscount {
          ... on DiscountAutomaticBasic { title status }
          ... on DiscountAutomaticBxgy { title status }
          ... on DiscountAutomaticFreeShipping { title status }
        }
      }
      userErrors { field message }
    }
  }
`;

const DISCOUNT_AUTOMATIC_DEACTIVATE_MUTATION = `#graphql
  mutation DiscountAutomaticDeactivate($id: ID!) {
    discountAutomaticDeactivate(id: $id) {
      automaticDiscountNode {
        id
        automaticDiscount {
          ... on DiscountAutomaticBasic { title status }
          ... on DiscountAutomaticBxgy { title status }
          ... on DiscountAutomaticFreeShipping { title status }
        }
      }
      userErrors { field message }
    }
  }
`;

type DiscountActivateResponse = {
  discountAutomaticActivate: {
    automaticDiscountNode: {
      id: string;
      automaticDiscount: { title?: string; status?: string };
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

type DiscountDeactivateResponse = {
  discountAutomaticDeactivate: {
    automaticDiscountNode: {
      id: string;
      automaticDiscount: { title?: string; status?: string };
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type DiscountStatusChangeResult = {
  id: string;
  title: string;
  newStatus: string;
};

export async function setDiscountStatus(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<DiscountStatusChangeResult>> {
  const parsed = SetDiscountStatusInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  if (parsed.data.status === "ACTIVE") {
    const result = await graphqlRequest<DiscountActivateResponse>(
      admin,
      DISCOUNT_AUTOMATIC_ACTIVATE_MUTATION,
      { id: parsed.data.discountId },
    );
    if (!result.ok) return { ok: false, error: result.error };
    const payload = result.data.discountAutomaticActivate;
    if (payload.userErrors.length > 0) {
      return {
        ok: false,
        error: `shopify userErrors: ${payload.userErrors.map((e) => e.message).join("; ")}`,
      };
    }
    const node = payload.automaticDiscountNode;
    if (!node) {
      return { ok: false, error: "discountAutomaticActivate returned no node" };
    }
    return {
      ok: true,
      data: {
        id: node.id,
        title: node.automaticDiscount?.title ?? "(untitled)",
        newStatus: node.automaticDiscount?.status ?? "ACTIVE",
      },
    };
  }

  // PAUSED path
  const result = await graphqlRequest<DiscountDeactivateResponse>(
    admin,
    DISCOUNT_AUTOMATIC_DEACTIVATE_MUTATION,
    { id: parsed.data.discountId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  const payload = result.data.discountAutomaticDeactivate;
  if (payload.userErrors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${payload.userErrors.map((e) => e.message).join("; ")}`,
    };
  }
  const node = payload.automaticDiscountNode;
  if (!node) {
    return { ok: false, error: "discountAutomaticDeactivate returned no node" };
  }
  return {
    ok: true,
    data: {
      id: node.id,
      title: node.automaticDiscount?.title ?? "(untitled)",
      newStatus: node.automaticDiscount?.status ?? "EXPIRED",
    },
  };
}

// ----------------------------------------------------------------------------
// delete_discount (write — runs from approval route, never inline)
//
// Permanent removal. Distinct from set_discount_status PAUSED — that
// keeps the discount in the list (just not running); delete_discount
// removes it entirely. The CEO should default to suggesting pause for
// reversibility unless the merchant explicitly says "delete".
// ----------------------------------------------------------------------------

const DeleteDiscountInput = z.object({
  discountId: z.string().min(1),
});

const DISCOUNT_AUTOMATIC_DELETE_MUTATION = `#graphql
  mutation DiscountAutomaticDelete($id: ID!) {
    discountAutomaticDelete(id: $id) {
      deletedAutomaticDiscountId
      userErrors { field message }
    }
  }
`;

type DiscountDeleteResponse = {
  discountAutomaticDelete: {
    deletedAutomaticDiscountId: string | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type DeletedDiscountResult = {
  deletedDiscountId: string;
};

export async function deleteDiscount(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<DeletedDiscountResult>> {
  const parsed = DeleteDiscountInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<DiscountDeleteResponse>(
    admin,
    DISCOUNT_AUTOMATIC_DELETE_MUTATION,
    { id: parsed.data.discountId },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const payload = result.data.discountAutomaticDelete;
  if (payload.userErrors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${payload.userErrors.map((e) => e.message).join("; ")}`,
    };
  }
  const deletedId = payload.deletedAutomaticDiscountId;
  if (!deletedId) {
    return {
      ok: false,
      error: "discountAutomaticDelete returned no deletedAutomaticDiscountId",
    };
  }
  return {
    ok: true,
    data: { deletedDiscountId: deletedId },
  };
}

// ============================================================================
// create_bundle_discount (Round PP-C — the headliner)
//
// Wraps Shopify's discountAutomaticBxgyCreate. Bxgy = "Buy X, Get Y at
// discount" — covers BOGO, compound bundles, tiered offers like
// "Buy 2 cat food bags, get 1 treat 50% off".
//
// Input is a merchant-friendly FLAT shape; the handler maps to Shopify's
// nested DiscountAutomaticBxgyInput shape internally. Mapping is the
// highest-value behavior to test — see tests/unit/shopify/discounts-bundle.test.ts.
//
// Currency: only required for fixed_amount discounts. Percentage discounts
// don't need it (Shopify's percentage field is unitless 0-1). For
// fixed_amount the handler interprets discountValue in store currency
// directly — Shopify's Decimal scalar is currency-agnostic, the store's
// configured currency applies at render time.
// ============================================================================

const CreateBundleDiscountInput = z
  .object({
    title: z.string().min(1).max(255),
    startsAt: z.string().min(10),
    endsAt: z.string().min(10).optional(),

    // What the customer must buy to qualify
    buyType: z.enum(["products", "collections"]),
    buyItemIds: z.array(z.string().min(1)).min(1),
    buyQuantity: z.number().int().min(1),

    // What the customer gets at a discount
    getType: z.enum(["products", "collections"]),
    getItemIds: z.array(z.string().min(1)).min(1),
    getQuantity: z.number().int().min(1),

    // The discount to apply on the "get" items
    discountType: z.enum(["percentage", "fixed_amount"]),
    discountValue: z.number().positive(),

    usesPerOrderLimit: z.number().int().min(1).optional(),
  })
  .refine(
    (v) =>
      v.discountType === "percentage"
        ? v.discountValue >= 1 && v.discountValue <= 100
        : true,
    { message: "percentage discountValue must be between 1 and 100" },
  )
  .refine(
    (v) => {
      if (!v.endsAt) return true;
      const start = new Date(v.startsAt).getTime();
      const end = new Date(v.endsAt).getTime();
      if (Number.isNaN(start) || Number.isNaN(end)) return false;
      return end > start;
    },
    { message: "endsAt must be after startsAt (and both must be valid ISO-8601)" },
  );

const DISCOUNT_AUTOMATIC_BXGY_CREATE_MUTATION = `#graphql
  mutation BundleDiscountCreate($automaticBxgyDiscount: DiscountAutomaticBxgyInput!) {
    discountAutomaticBxgyCreate(automaticBxgyDiscount: $automaticBxgyDiscount) {
      automaticDiscountNode {
        id
        automaticDiscount {
          ... on DiscountAutomaticBxgy {
            title
            startsAt
            endsAt
            status
            summary
            usesPerOrderLimit
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

type BundleDiscountCreateResponse = {
  discountAutomaticBxgyCreate: {
    automaticDiscountNode: {
      id: string;
      automaticDiscount: {
        title?: string;
        startsAt?: string;
        endsAt?: string | null;
        status?: string;
        summary?: string;
        usesPerOrderLimit?: number | null;
      };
    } | null;
    userErrors: Array<{ field: string[] | null; message: string; code?: string }>;
  };
};

export type CreatedBundleDiscount = {
  id: string;
  title: string;
  status: string;
  startsAt: string;
  endsAt: string | null;
  // Shopify's own rendering of the bundle ("Buy 2, get 1 free", etc.).
  // The CEO should relay this verbatim to the merchant — it's the most
  // honest description of what was actually configured.
  summary: string;
  usesPerOrderLimit: number | null;
};

// Build the nested DiscountItemsInput payload for either side of the
// Bxgy. Pure mapping; tested directly via the bundle suite.
function buildItemsInput(
  itemType: "products" | "collections",
  itemIds: string[],
): Record<string, unknown> {
  if (itemType === "products") {
    return { products: { productsToAdd: itemIds } };
  }
  return { collections: { add: itemIds } };
}

// Build the customerGets.value payload — Bxgy uses discountOnQuantity
// with a `quantity` (how many "get" items qualify) and an `effect`
// (percentage or amount). Pure mapping for testability.
function buildCustomerGetsValue(
  getQuantity: number,
  discountType: "percentage" | "fixed_amount",
  discountValue: number,
): Record<string, unknown> {
  if (discountType === "percentage") {
    return {
      discountOnQuantity: {
        quantity: String(getQuantity),
        // Shopify wants 0-1 decimal: 50% off → 0.5
        effect: { percentage: discountValue / 100 },
      },
    };
  }
  return {
    discountOnQuantity: {
      quantity: String(getQuantity),
      // Decimal scalar — pass as 2-decimal string in store currency.
      effect: { amount: discountValue.toFixed(2) },
    },
  };
}

export async function createBundleDiscount(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<CreatedBundleDiscount>> {
  const parsed = CreateBundleDiscountInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Map merchant-friendly flat input → Shopify's nested input shape.
  const automaticBxgyDiscount: Record<string, unknown> = {
    title: parsed.data.title,
    startsAt: parsed.data.startsAt,
    customerBuys: {
      items: buildItemsInput(parsed.data.buyType, parsed.data.buyItemIds),
      value: { quantity: String(parsed.data.buyQuantity) },
    },
    customerGets: {
      items: buildItemsInput(parsed.data.getType, parsed.data.getItemIds),
      value: buildCustomerGetsValue(
        parsed.data.getQuantity,
        parsed.data.discountType,
        parsed.data.discountValue,
      ),
    },
  };
  if (parsed.data.endsAt) {
    automaticBxgyDiscount.endsAt = parsed.data.endsAt;
  }
  if (parsed.data.usesPerOrderLimit !== undefined) {
    automaticBxgyDiscount.usesPerOrderLimit = String(parsed.data.usesPerOrderLimit);
  }

  const result = await graphqlRequest<BundleDiscountCreateResponse>(
    admin,
    DISCOUNT_AUTOMATIC_BXGY_CREATE_MUTATION,
    { automaticBxgyDiscount },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const payload = result.data.discountAutomaticBxgyCreate;
  if (payload.userErrors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${payload.userErrors.map((e) => e.message).join("; ")}`,
    };
  }
  const node = payload.automaticDiscountNode;
  if (!node) {
    return {
      ok: false,
      error: "discountAutomaticBxgyCreate returned no automaticDiscountNode",
    };
  }
  const inner = node.automaticDiscount ?? {};
  return {
    ok: true,
    data: {
      id: node.id,
      title: inner.title ?? parsed.data.title,
      status: inner.status ?? "ACTIVE",
      startsAt: inner.startsAt ?? parsed.data.startsAt,
      endsAt: inner.endsAt ?? null,
      summary: inner.summary ?? "",
      usesPerOrderLimit:
        typeof inner.usesPerOrderLimit === "number"
          ? inner.usesPerOrderLimit
          : null,
    },
  };
}

// ============================================================================
// create_discount_code (Round PP-D — code-based percentage discount)
//
// Wraps Shopify's discountCodeBasicCreate. Same merchant-facing shape
// as create_discount (the automatic basic discount) but with a `code`
// the customer types at checkout. Useful for:
//   - Influencer / partner codes (each gets a unique code)
//   - Email-list exclusives (SUMMER20)
//   - First-purchase incentives (limit 1 per customer)
//
// V1 keeps it store-wide (customerGets.items: all). Per-collection or
// per-product code discounts require a different input shape; defer
// until a merchant asks.
// ============================================================================

const CreateDiscountCodeInput = z.object({
  code: z
    .string()
    .max(255)
    // Shopify treats codes as case-insensitive for redemption but stores
    // them as the merchant typed. No format restrictions; merchants
    // sometimes use spaces or symbols. Trim first, then enforce
    // non-empty so "   " is rejected, not silently accepted as "".
    .trim()
    .refine((s) => s.length > 0, {
      message: "code cannot be empty or whitespace-only",
    }),
  title: z.string().min(1).max(255).optional(),
  percentOff: z.number().int().min(1).max(100),
  startsAt: z.string().min(10),
  endsAt: z.string().min(10).optional(),
  usageLimit: z.number().int().min(1).optional(),
  appliesOncePerCustomer: z.boolean().optional(),
});

const DISCOUNT_CODE_BASIC_CREATE_MUTATION = `#graphql
  mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            status
            startsAt
            endsAt
            summary
            usageLimit
            appliesOncePerCustomer
            codes(first: 1) {
              edges { node { code } }
            }
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

type DiscountCodeBasicCreateResponse = {
  discountCodeBasicCreate: {
    codeDiscountNode: {
      id: string;
      codeDiscount: {
        title?: string;
        status?: string;
        startsAt?: string;
        endsAt?: string | null;
        summary?: string;
        usageLimit?: number | null;
        appliesOncePerCustomer?: boolean;
        codes?: {
          edges: Array<{ node: { code: string } }>;
        };
      };
    } | null;
    userErrors: Array<{ field: string[] | null; message: string; code?: string }>;
  };
};

export type CreatedDiscountCode = {
  id: string;
  code: string;
  title: string;
  percentOff: number;
  status: string;
  startsAt: string;
  endsAt: string | null;
  summary: string;
  usageLimit: number | null;
  appliesOncePerCustomer: boolean;
};

export async function createDiscountCode(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<CreatedDiscountCode>> {
  const parsed = CreateDiscountCodeInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Default the title to the code itself when the merchant didn't
  // provide one. The title is what the merchant sees in their discount
  // list; the code is what the customer types at checkout. Different
  // values are fine and common but if not specified the code is the
  // best fallback.
  const title = parsed.data.title ?? parsed.data.code;
  const percentageDecimal = parsed.data.percentOff / 100;

  const basicCodeDiscount: Record<string, unknown> = {
    title,
    code: parsed.data.code,
    startsAt: parsed.data.startsAt,
    customerSelection: { all: true },
    customerGets: {
      value: { percentage: percentageDecimal },
      items: { all: true },
    },
  };
  if (parsed.data.endsAt) {
    basicCodeDiscount.endsAt = parsed.data.endsAt;
  }
  if (parsed.data.usageLimit !== undefined) {
    basicCodeDiscount.usageLimit = parsed.data.usageLimit;
  }
  if (parsed.data.appliesOncePerCustomer !== undefined) {
    basicCodeDiscount.appliesOncePerCustomer = parsed.data.appliesOncePerCustomer;
  }

  const result = await graphqlRequest<DiscountCodeBasicCreateResponse>(
    admin,
    DISCOUNT_CODE_BASIC_CREATE_MUTATION,
    { basicCodeDiscount },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const payload = result.data.discountCodeBasicCreate;
  if (payload.userErrors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${payload.userErrors.map((e) => e.message).join("; ")}`,
    };
  }
  const node = payload.codeDiscountNode;
  if (!node) {
    return {
      ok: false,
      error: "discountCodeBasicCreate returned no codeDiscountNode",
    };
  }
  const inner = node.codeDiscount ?? {};
  const returnedCode = inner.codes?.edges?.[0]?.node?.code ?? parsed.data.code;
  return {
    ok: true,
    data: {
      id: node.id,
      code: returnedCode,
      title: inner.title ?? title,
      percentOff: parsed.data.percentOff,
      status: inner.status ?? "ACTIVE",
      startsAt: inner.startsAt ?? parsed.data.startsAt,
      endsAt: inner.endsAt ?? null,
      summary: inner.summary ?? "",
      usageLimit:
        typeof inner.usageLimit === "number" ? inner.usageLimit : null,
      appliesOncePerCustomer:
        typeof inner.appliesOncePerCustomer === "boolean"
          ? inner.appliesOncePerCustomer
          : (parsed.data.appliesOncePerCustomer ?? false),
    },
  };
}
