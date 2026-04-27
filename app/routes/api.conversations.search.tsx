import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";

import { requireStoreAccess } from "../lib/auth.server";
import { searchConversations } from "../lib/conversations/search.server";

// GET /api/conversations/search?q=<query>&limit=<n>
//
// Tenant-scoped (CLAUDE.md rule #2). Used by ConversationSearch's
// debounced autocomplete: 200ms after the merchant stops typing the
// client fires this and renders the dropdown.
//
// Returns: { hits: SearchHit[] }  (always; empty array if q.length === 0)

const QuerySchema = z.object({
  q: z.string().min(1).max(80),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    q: url.searchParams.get("q") ?? "",
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    // Empty / invalid query → empty result; client-side debounce can call
    // this with q="" briefly during typing, don't 400 on that.
    return { hits: [] };
  }

  const hits = await searchConversations(
    store.id,
    parsed.data.q,
    parsed.data.limit,
  );
  return { hits };
};
