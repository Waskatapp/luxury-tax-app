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
// Every authenticated admin loader/action must call this instead of authenticate.admin directly.
export async function requireStoreAccess(
  request: Request,
  minRole?: UserRole,
): Promise<StoreAccess> {
  const { admin, session } = await authenticate.admin(request);

  // Role derivation:
  // - Online session: use onlineAccessInfo.associated_user (populated during OAuth).
  //   account_owner → STORE_OWNER, collaborator → VIEW_ONLY, otherwise STORE_ADMIN.
  // - Offline session (v1 default): no per-request user identity. The app-level
  //   token was obtained during install by the shop owner, so default STORE_OWNER.
  const associatedUser = session.onlineAccessInfo?.associated_user;
  let userRole: UserRole = UserRole.STORE_OWNER;
  if (associatedUser) {
    if (associatedUser.collaborator) userRole = UserRole.VIEW_ONLY;
    else if (associatedUser.account_owner) userRole = UserRole.STORE_OWNER;
    else userRole = UserRole.STORE_ADMIN;
  }

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
