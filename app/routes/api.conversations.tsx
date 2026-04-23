import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";

// GET /api/conversations → list conversations scoped to this store
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);

  const rows = await prisma.conversation.findMany({
    where: { storeId: store.id },
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

  if (request.method === "DELETE") {
    const body = (await request.json()) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id : null;
    if (!id) return new Response("Missing id", { status: 400 });

    // Tenant-scoped delete: only rows owned by this store (CLAUDE.md rule #2).
    const result = await prisma.conversation.deleteMany({
      where: { id, storeId: store.id },
    });
    if (result.count === 0) return new Response("Not found", { status: 404 });

    return { ok: true };
  }

  return new Response("Method not allowed", { status: 405 });
};
