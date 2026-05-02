import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> = { ok: true; data: T } | { ok: false; error: string };

const ReadCollectionsInput = z.object({
  first: z.number().int().min(1).max(50).default(20),
  after: z.string().optional(),
  // Same agentic search treatment as read_products: bare keywords match
  // across collection title, description, and rule set.
  query: z.string().optional(),
});

// description (server-truncated) + ruleSet preview let the agent
// disambiguate "the new arrivals collection" from "new sale items"
// without scanning every collection.
const READ_COLLECTIONS_QUERY = `#graphql
  query ReadCollections($first: Int!, $after: String, $query: String) {
    collections(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          title
          handle
          updatedAt
          description
          sortOrder
          productsCount { count }
          ruleSet {
            appliedDisjunctively
            rules {
              column
              relation
              condition
            }
          }
          seo {
            title
            description
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const DESCRIPTION_PREVIEW_CHARS = 300;

export type CollectionRuleSummary = {
  column: string;
  relation: string;
  condition: string;
};

export type CollectionSummary = {
  id: string;
  title: string;
  handle: string;
  productsCount: number | null;
  updatedAt: string;
  descriptionPreview: string | null;
  sortOrder: string | null;
  // Smart collections only — manual collections return null. The agent uses
  // this to explain WHY a product is in the collection (or to suggest
  // adding one to a smart rule).
  rules: {
    matchAny: boolean;
    items: CollectionRuleSummary[];
  } | null;
  seoTitle: string | null;
  seoDescription: string | null;
};

export type ReadCollectionsResult = {
  collections: CollectionSummary[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

type RawResponse = {
  collections: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        title: string;
        handle: string;
        updatedAt: string;
        description: string | null;
        sortOrder: string | null;
        productsCount: { count: number } | null;
        ruleSet: {
          appliedDisjunctively: boolean;
          rules: Array<{ column: string; relation: string; condition: string }>;
        } | null;
        seo: { title: string | null; description: string | null } | null;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export async function readCollections(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadCollectionsResult>> {
  const parsed = ReadCollectionsInput.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<RawResponse>(admin, READ_COLLECTIONS_QUERY, {
    first: parsed.data.first,
    after: parsed.data.after ?? null,
    query: parsed.data.query ?? null,
  });
  if (!result.ok) return { ok: false, error: result.error };

  const collections: CollectionSummary[] = result.data.collections.edges.map(
    (edge) => {
      const desc = edge.node.description?.trim() ?? "";
      const descPreview =
        desc.length > DESCRIPTION_PREVIEW_CHARS
          ? desc.slice(0, DESCRIPTION_PREVIEW_CHARS) + "…"
          : desc.length > 0
            ? desc
            : null;
      return {
        id: edge.node.id,
        title: edge.node.title,
        handle: edge.node.handle,
        productsCount: edge.node.productsCount?.count ?? null,
        updatedAt: edge.node.updatedAt,
        descriptionPreview: descPreview,
        sortOrder: edge.node.sortOrder,
        rules: edge.node.ruleSet
          ? {
              matchAny: edge.node.ruleSet.appliedDisjunctively,
              items: edge.node.ruleSet.rules,
            }
          : null,
        seoTitle: edge.node.seo?.title ?? null,
        seoDescription: edge.node.seo?.description ?? null,
      };
    },
  );

  return {
    ok: true,
    data: { collections, pageInfo: result.data.collections.pageInfo },
  };
}

// ----------------------------------------------------------------------------
// Sort-order enum (shared by create + update)
//
// Manual sort lets the merchant drag products into a custom order. The
// other values let Shopify auto-sort the storefront listing. We don't
// expose COLLECTION_DEFAULT (smart-collection only).
// ----------------------------------------------------------------------------
const CollectionSortOrderEnum = z.enum([
  "MANUAL",
  "BEST_SELLING",
  "ALPHA_ASC",
  "ALPHA_DESC",
  "PRICE_DESC",
  "PRICE_ASC",
  "CREATED",
  "CREATED_DESC",
]);

// ----------------------------------------------------------------------------
// create_collection (write — runs from approval route, never inline)
//
// Manual collections only in v1. Smart (rule-based) collections need a
// ruleSet schema — substantial design work; deferred until merchants ask.
// ----------------------------------------------------------------------------

const CreateCollectionInput = z.object({
  title: z.string().min(1).max(255),
  descriptionHtml: z.string().optional(),
  sortOrder: CollectionSortOrderEnum.optional(),
});

const COLLECTION_CREATE_MUTATION = `#graphql
  mutation CollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        title
        handle
        sortOrder
      }
      userErrors { field message }
    }
  }
`;

type CollectionCreateResponse = {
  collectionCreate: {
    collection: {
      id: string;
      title: string;
      handle: string;
      sortOrder: string | null;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type CreatedCollection = {
  collectionId: string;
  title: string;
  handle: string;
  sortOrder: string | null;
};

export async function createCollection(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<CreatedCollection>> {
  const parsed = CreateCollectionInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<CollectionCreateResponse>(
    admin,
    COLLECTION_CREATE_MUTATION,
    {
      input: {
        title: parsed.data.title,
        ...(parsed.data.descriptionHtml
          ? { descriptionHtml: parsed.data.descriptionHtml }
          : {}),
        ...(parsed.data.sortOrder ? { sortOrder: parsed.data.sortOrder } : {}),
      },
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.collectionCreate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const created = result.data.collectionCreate.collection;
  if (!created) {
    return { ok: false, error: "collectionCreate returned no collection" };
  }

  return {
    ok: true,
    data: {
      collectionId: created.id,
      title: created.title,
      handle: created.handle,
      sortOrder: created.sortOrder,
    },
  };
}

// ----------------------------------------------------------------------------
// update_collection (write — runs from approval route, never inline)
//
// At least one of title/descriptionHtml/sortOrder must be set. Smart
// collections (with ruleSet) and manual collections (with explicit
// product IDs) are both updatable here — we just don't accept rule
// changes or product-list changes in v1.
// ----------------------------------------------------------------------------

const UpdateCollectionInput = z
  .object({
    collectionId: z.string().min(1),
    title: z.string().min(1).max(255).optional(),
    descriptionHtml: z.string().optional(),
    sortOrder: CollectionSortOrderEnum.optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.descriptionHtml !== undefined ||
      v.sortOrder !== undefined,
    {
      message: "at least one of title/descriptionHtml/sortOrder must be set",
    },
  );

const FETCH_COLLECTION_DETAILS_QUERY = `#graphql
  query FetchCollectionDetails($id: ID!) {
    collection(id: $id) {
      id
      title
      handle
      descriptionHtml
      sortOrder
    }
  }
`;

const COLLECTION_UPDATE_MUTATION = `#graphql
  mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        title
        handle
        descriptionHtml
        sortOrder
      }
      userErrors { field message }
    }
  }
`;

type FetchCollectionDetailsResponse = {
  collection: {
    id: string;
    title: string;
    handle: string;
    descriptionHtml: string | null;
    sortOrder: string | null;
  } | null;
};

type CollectionUpdateResponse = {
  collectionUpdate: {
    collection: {
      id: string;
      title: string;
      handle: string;
      descriptionHtml: string | null;
      sortOrder: string | null;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

export type CollectionDetailsSnapshot = {
  collectionId: string;
  title: string;
  handle: string;
  descriptionHtml: string | null;
  sortOrder: string | null;
};

export async function fetchCollectionDetails(
  admin: ShopifyAdmin,
  collectionId: string,
): Promise<ToolModuleResult<CollectionDetailsSnapshot>> {
  const result = await graphqlRequest<FetchCollectionDetailsResponse>(
    admin,
    FETCH_COLLECTION_DETAILS_QUERY,
    { id: collectionId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.collection) {
    return { ok: false, error: `collection not found: ${collectionId}` };
  }
  return {
    ok: true,
    data: {
      collectionId: result.data.collection.id,
      title: result.data.collection.title,
      handle: result.data.collection.handle,
      descriptionHtml: result.data.collection.descriptionHtml,
      sortOrder: result.data.collection.sortOrder,
    },
  };
}

export async function updateCollection(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<CollectionDetailsSnapshot>> {
  const parsed = UpdateCollectionInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const input: Record<string, unknown> = { id: parsed.data.collectionId };
  if (parsed.data.title !== undefined) input.title = parsed.data.title;
  if (parsed.data.descriptionHtml !== undefined) {
    input.descriptionHtml = parsed.data.descriptionHtml;
  }
  if (parsed.data.sortOrder !== undefined) input.sortOrder = parsed.data.sortOrder;

  const result = await graphqlRequest<CollectionUpdateResponse>(
    admin,
    COLLECTION_UPDATE_MUTATION,
    { input },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.collectionUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  const updated = result.data.collectionUpdate.collection;
  if (!updated) {
    return { ok: false, error: "collectionUpdate returned no collection" };
  }

  return {
    ok: true,
    data: {
      collectionId: updated.id,
      title: updated.title,
      handle: updated.handle,
      descriptionHtml: updated.descriptionHtml,
      sortOrder: updated.sortOrder,
    },
  };
}
