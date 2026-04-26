import type { ActionFunctionArgs } from "react-router";

import { requireStoreAccess } from "../lib/auth.server";
import { deleteMemory } from "../lib/memory/store-memory.server";

// DELETE /api/memory  body: { id }
//
// Programmatic endpoint for the chat-page "Undo" toast that fires after
// memory extraction. The settings-page UI uses /app/settings/memory's
// own action — that route is locked to its loader's data shape and
// fetcher form, not safe to call from elsewhere.
//
// Tenant-scoped: deleteMemory does findFirst(id, storeId) before deleting,
// so a stale toolCallId from another store can't cause a leak.
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
