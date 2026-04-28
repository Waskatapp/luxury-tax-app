import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { requireStoreAccess } from "../lib/auth.server";
import {
  deleteMemory,
  listAllMemory,
} from "../lib/memory/store-memory.server";

// V2.3 — GET /api/memory → all memory entries for the store, grouped by
// category. Used by the chat-page MemoryPill drawer ("🧠 I remember N
// things") so the merchant can see what the Copilot has stored without
// leaving the chat. Settings page has its own loader; this is the
// chat-side equivalent.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);
  const entries = await listAllMemory(store.id);
  return Response.json({
    entries: entries.map((e) => ({
      id: e.id,
      category: e.category,
      key: e.key,
      value: e.value,
      updatedAt: e.updatedAt.toISOString(),
    })),
  });
};

// DELETE /api/memory  body: { id }
//
// Programmatic endpoint for the chat-page "Undo" toast that fires after
// memory extraction (and the MemoryPill drawer's per-row delete). The
// settings-page UI uses /app/settings/memory's own action — that route
// is locked to its loader's data shape and fetcher form, not safe to
// call from elsewhere.
//
// Tenant-scoped: deleteMemory does findFirst(id, storeId) before deleting,
// so a stale id from another store can't cause a leak.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "DELETE") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { store } = await requireStoreAccess(request);

  const body = (await request.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id : null;
  if (!id) return new Response("Missing id", { status: 400 });

  const ok = await deleteMemory(store.id, id);
  if (!ok) return new Response("Not found", { status: 404 });

  return Response.json({ ok: true });
};
