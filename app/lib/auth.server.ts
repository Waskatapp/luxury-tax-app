import { UserRole } from "@prisma/client";
import type { Store } from "@prisma/client";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { encrypt } from "./security/encrypt.server";

const ROLE_RANK: Record<UserRole, number> = {
  VIEW_ONLY: 0,
  STORE_ADMIN: 1,
  STORE_OWNER: 2,
};

export type StoreAccess = {
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"];
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"];
  store: Store;
  userRole: UserRole;
};

// Shopify-authenticates the request, upserts the tenant Store row (idempotent),
// derives the user's role, and enforces an optional minimum role.
// Every authenticated admin loader/action should call this instead of authenticate.admin directly.
//
// TODO(phase-2): once we add online tokens for multi-user stores, derive role from
// session.onlineAccessInfo?.associated_user (account_owner / collaborator). v1 is
// owner-only per CLAUDE.md; we default to STORE_OWNER here.
export async function requireStoreAccess(
  request: Request,
  minRole?: UserRole,
): Promise<StoreAccess> {
  const { admin, session } = await authenticate.admin(request);

  const associatedUser = session.onlineAccessInfo?.associated_user;
  const userRole: UserRole = associatedUser?.collaborator
    ? UserRole.VIEW_ONLY
    : UserRole.STORE_OWNER;

  if (minRole && ROLE_RANK[userRole] < ROLE_RANK[minRole]) {
    throw new Response("Forbidden", { status: 403 });
  }

  const store = await prisma.store.upsert({
    where: { shopDomain: session.shop },
    create: {
      shopDomain: session.shop,
      accessToken: encrypt(session.accessToken ?? ""),
      scopes: session.scope ?? null,
      ownerEmail: associatedUser?.email ?? null,
    },
    update: {
      accessToken: encrypt(session.accessToken ?? ""),
      scopes: session.scope ?? null,
      ownerEmail: associatedUser?.email ?? null,
      uninstalledAt: null,
    },
  });

  return { admin, session, store, userRole };
}
