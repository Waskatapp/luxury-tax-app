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
        customerSelection: { all: true },
        minimumRequirement: {
          subtotal: { greaterThanOrEqualToSubtotal: "0" },
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
