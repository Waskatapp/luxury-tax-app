import type { ShopifyAdmin } from "../../app/lib/shopify/graphql-client.server";

export type FakeGraphQLCall = {
  query: string;
  variables: Record<string, unknown> | undefined;
};

export type FakeAdminResponse =
  | { kind: "data"; body: unknown }
  | { kind: "errors"; errors: Array<{ message: string }> }
  | { kind: "http-error"; status: number; statusText?: string; bodyText?: string }
  | { kind: "throw"; message: string };

// Build a fake Shopify admin whose `graphql()` method returns canned responses
// in order. Each call captures the query+variables in `calls` for assertions.
//
// Usage:
//   const admin = fakeAdmin([
//     { kind: "data", body: { productVariantsBulkUpdate: { ... } } },
//   ]);
//   const r = await updateProductPrice(admin, { ... });
//   expect(admin.calls[0].variables).toEqual({ ... });
export function fakeAdmin(responses: FakeAdminResponse[]): ShopifyAdmin & {
  calls: FakeGraphQLCall[];
} {
  const calls: FakeGraphQLCall[] = [];
  let index = 0;

  const graphql = async (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response> => {
    calls.push({ query, variables: options?.variables });
    const r = responses[index++];
    if (!r) {
      throw new Error(
        `fakeAdmin: graphql called more times than responses provided (call #${index})`,
      );
    }

    if (r.kind === "throw") {
      throw new Error(r.message);
    }

    if (r.kind === "http-error") {
      return new Response(r.bodyText ?? "", {
        status: r.status,
        statusText: r.statusText,
      });
    }

    if (r.kind === "errors") {
      return new Response(JSON.stringify({ errors: r.errors }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // r.kind === "data"
    return new Response(
      JSON.stringify({
        data: r.body,
        extensions: {
          cost: { throttleStatus: { currentlyAvailable: 998, maximumAvailable: 1000 } },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  return Object.assign({ graphql }, { calls });
}
