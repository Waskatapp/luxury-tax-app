import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import { readCacheClearConversation } from "../lib/agent/read-cache.server";

// GET /api/conversations → list conversations scoped to this store
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);

  // Match app.copilot.tsx loader: sidebar lists only conversations whose
  // LLM-generated title is set. Untitled rows are mid-flight (the title
  // generator runs after the first assistant turn) and re-appear via the
  // SSE conversation_titled event.
  const rows = await prisma.conversation.findMany({
    where: { storeId: store.id, title: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, updatedAt: true },
  });

  return {
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt.toISOString(),
    })),
  };
};

// POST   → create
// DELETE → delete (body: { id })
// V2.4 — also clears the read cache for this conversation; see
// app/lib/agent/read-cache.server.ts.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { store, session, userRole } = await requireStoreAccess(request);

  if (request.method === "POST") {
    const userId =
      session.onlineAccessInfo?.associated_user?.id?.toString() ?? "owner";

    const conversation = await prisma.conversation.create({
      data: {
        storeId: store.id,
        userId,
        userRole,
        title: null,
      },
      select: { id: true, title: true, updatedAt: true },
    });

    return {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt.toISOString(),
      },
    };
  }

  if (request.method === "PATCH") {
    const body = (await request.json()) as { id?: unknown; title?: unknown };
    const id = typeof body.id === "string" ? body.id : null;
    const titleRaw = typeof body.title === "string" ? body.title.trim() : null;
    if (!id) return new Response("Missing id", { status: 400 });
    if (!titleRaw) return new Response("Missing title", { status: 400 });
    // 120-char cap matches what the UI reasonably displays in the sidebar.
    const title = titleRaw.slice(0, 120);

    const result = await prisma.conversation.updateMany({
      where: { id, storeId: store.id },
      data: { title },
    });
    if (result.count === 0) return new Response("Not found", { status: 404 });

    const updated = await prisma.conversation.findFirst({
      where: { id, storeId: store.id },
      select: { id: true, title: true, updatedAt: true },
    });
    if (!updated) return new Response("Not found", { status: 404 });

    return {
      conversation: {
        id: updated.id,
        title: updated.title,
        updatedAt: updated.updatedAt.toISOString(),
      },
    };
  }

  if (request.method === "DELETE") {
    const body = (await request.json()) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id : null;
    if (!id) return new Response("Missing id", { status: 400 });

    // Tenant-scoped delete: only rows owned by this store (CLAUDE.md rule #2).
    const result = await prisma.conversation.deleteMany({
      where: { id, storeId: store.id },
    });
    if (result.count === 0) return new Response("Not found", { status: 404 });

    // V2.4 — drop the in-memory read-tool cache for this conversation
    // so its slot doesn't sit there until the 5-min TTL expires. Cheap
    // map-delete; no-op if no entries existed.
    readCacheClearConversation(id);

    return { ok: true };
  }

  return new Response("Method not allowed", { status: 405 });
};
