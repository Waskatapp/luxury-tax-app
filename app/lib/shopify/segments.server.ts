// V-Cu-B — Customer segments (read-only). Two tools: list the merchant's
// segments + drill into a single segment's member list. Segment WRITES
// (create/update/delete) are intentionally deferred — segments use a
// query DSL (`customer_tags = 'vip' AND amount_spent > 100`) that
// Shopify's visual segment editor handles much better than chat.
//
// Scopes: read_customers (already added in Round Cu-A). No manifest
// changes for Round Cu-B.

import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ----------------------------------------------------------------------------
// Result shapes
// ----------------------------------------------------------------------------

export type SegmentSummary = {
  segmentId: string;
  name: string;
  // The segment's DSL query string (e.g. "customer_tags CONTAINS 'vip'").
  // Useful context for the manager — the CEO usually just surfaces
  // `name` to the merchant.
  query: string;
  creationDate: string;
  lastEditDate: string;
};

export type ReadSegmentsResult = {
  segments: SegmentSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export type SegmentMember = {
  customerId: string;
  displayName: string;
  email: string | null;
  numberOfOrders: number;
  amountSpent: string;
  currencyCode: string;
};

export type ReadSegmentMembersResult = {
  segmentId: string;
  members: SegmentMember[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

// ----------------------------------------------------------------------------
// Input schemas
// ----------------------------------------------------------------------------

export const ReadSegmentsInput = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  query: z.string().optional(),
});

export const ReadSegmentMembersInput = z.object({
  segmentId: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(20),
});

// ----------------------------------------------------------------------------
// GraphQL
// ----------------------------------------------------------------------------

const READ_SEGMENTS_QUERY = `#graphql
  query ReadSegments($first: Int!, $after: String, $query: String) {
    segments(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          name
          query
          creationDate
          lastEditDate
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// customerSegmentMembers takes a segmentId and returns the synchronous
// list of members. CustomerSegmentMember.id is the underlying
// Customer.id GID. Field set kept slim — name + email + lifetime stats
// is enough for "show me the customers in this segment" context; the
// merchant can drill into a specific customer via read_customer_detail
// from the Customers dept.
const READ_SEGMENT_MEMBERS_QUERY = `#graphql
  query ReadSegmentMembers($segmentId: ID!, $first: Int!) {
    customerSegmentMembers(segmentId: $segmentId, first: $first) {
      edges {
        cursor
        node {
          id
          displayName
          defaultEmailAddress { emailAddress }
          numberOfOrders
          amountSpent { amount currencyCode }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ----------------------------------------------------------------------------
// GraphQL response types
// ----------------------------------------------------------------------------

type SegmentNode = {
  id: string;
  name: string;
  query: string;
  creationDate: string;
  lastEditDate: string;
};

type SegmentMemberNode = {
  id: string;
  displayName: string;
  defaultEmailAddress: { emailAddress: string | null } | null;
  numberOfOrders: string | number;
  amountSpent: { amount: string; currencyCode: string };
};

type ReadSegmentsResponse = {
  segments: {
    edges: Array<{ cursor: string; node: SegmentNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type ReadSegmentMembersResponse = {
  customerSegmentMembers: {
    edges: Array<{ cursor: string; node: SegmentMemberNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function toInt(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// ----------------------------------------------------------------------------
// readSegments
// ----------------------------------------------------------------------------

export async function readSegments(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadSegmentsResult>> {
  const parsed = ReadSegmentsInput.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ReadSegmentsResponse>(
    admin,
    READ_SEGMENTS_QUERY,
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
      segments: result.data.segments.edges.map((e) => ({
        segmentId: e.node.id,
        name: e.node.name,
        query: e.node.query,
        creationDate: e.node.creationDate,
        lastEditDate: e.node.lastEditDate,
      })),
      pageInfo: result.data.segments.pageInfo,
    },
  };
}

// ----------------------------------------------------------------------------
// readSegmentMembers
// ----------------------------------------------------------------------------

export async function readSegmentMembers(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadSegmentMembersResult>> {
  const parsed = ReadSegmentMembersInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ReadSegmentMembersResponse>(
    admin,
    READ_SEGMENT_MEMBERS_QUERY,
    {
      segmentId: parsed.data.segmentId,
      first: parsed.data.limit,
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    data: {
      segmentId: parsed.data.segmentId,
      members: result.data.customerSegmentMembers.edges.map((e) => ({
        customerId: e.node.id,
        displayName: e.node.displayName,
        email: e.node.defaultEmailAddress?.emailAddress ?? null,
        numberOfOrders: toInt(e.node.numberOfOrders),
        amountSpent: e.node.amountSpent.amount,
        currencyCode: e.node.amountSpent.currencyCode,
      })),
      pageInfo: result.data.customerSegmentMembers.pageInfo,
    },
  };
}
