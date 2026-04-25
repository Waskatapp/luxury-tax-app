// Structural type for the Shopify Admin context returned by
// authenticate.admin(request). Kept minimal (only the graphql method) so we
// don't couple to a specific SDK version's type naming.
export type ShopifyAdmin = {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response>;
};

export type GraphQLResult<T> =
  | { ok: true; data: T; costAvailable: number | null }
  | { ok: false; error: string };

// Thin wrapper over admin.graphql that:
//  - unwraps the JSON body
//  - surfaces Shopify `errors` as a typed failure (never throws)
//  - logs `extensions.cost.throttleStatus.currentlyAvailable` for visibility
// Per-store throttling lives in lib/shopify/rate-limiter.server.ts and is
// applied transparently when admin is wrapped in requireStoreAccess.
export async function graphqlRequest<T>(
  admin: ShopifyAdmin,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphQLResult<T>> {
  let response: Response;
  try {
    response = await admin.graphql(query, { variables });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `graphql request failed: ${String(err)}`,
    };
  }

  let body: {
    data?: T;
    errors?: Array<{ message?: string }>;
    extensions?: {
      cost?: {
        throttleStatus?: {
          currentlyAvailable?: number;
          maximumAvailable?: number;
        };
      };
    };
  };

  try {
    body = await response.json();
  } catch (err) {
    return {
      ok: false,
      error: `graphql response not JSON (${response.status}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const cost = body.extensions?.cost?.throttleStatus?.currentlyAvailable ?? null;
  if (cost !== null) {
    console.log(`[shopify] graphql cost: ${cost}/1000 available`);
  }

  if (body.errors && body.errors.length > 0) {
    const msg = body.errors.map((e) => e.message ?? "unknown").join("; ");
    return { ok: false, error: `shopify graphql errors: ${msg}` };
  }

  if (!body.data) {
    return { ok: false, error: `shopify returned no data (status ${response.status})` };
  }

  return { ok: true, data: body.data, costAvailable: cost };
}
