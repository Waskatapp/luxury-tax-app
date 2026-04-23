import { UserRole } from "@prisma/client";

// ABAC-ready signature. v1 only checks role; resource/action stay for future expansion.
export type Resource =
  | "product"
  | "price"
  | "discount"
  | "analytics"
  | "memory"
  | "audit";

export type Action = "read" | "write" | "approve";

export type AuthorizeInput = {
  role: UserRole;
  resource: Resource;
  action: Action;
};

const ROLE_RANK: Record<UserRole, number> = {
  VIEW_ONLY: 0,
  STORE_ADMIN: 1,
  STORE_OWNER: 2,
};

export function authorize({ role, action }: AuthorizeInput): boolean {
  if (action === "read") return true;
  return ROLE_RANK[role] >= ROLE_RANK.STORE_ADMIN;
}

export function requireAuthorized(input: AuthorizeInput): void {
  if (!authorize(input)) {
    throw new Response("Forbidden", { status: 403 });
  }
}
