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
