import type { MemoryCategory, StoreMemory } from "@prisma/client";

import prisma from "../../db.server";

// Every function takes storeId as a required argument and scopes the query by
// it. CLAUDE.md rule #2 — no cross-tenant leakage. Deletes use findFirst-with-
// storeId then delete-by-id (NOT delete-by-id-only), so a malicious id from a
// stale form submission can never delete another tenant's row.

const MEMORY_PROMPT_LIMIT = 20;

export type MemoryUpsertInput = {
  category: MemoryCategory;
  key: string;
  value: string;
};

export async function listMemoryForPrompt(
  storeId: string,
  limit: number = MEMORY_PROMPT_LIMIT,
): Promise<StoreMemory[]> {
  return prisma.storeMemory.findMany({
    where: { storeId },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
}

export async function listAllMemory(storeId: string): Promise<StoreMemory[]> {
  return prisma.storeMemory.findMany({
    where: { storeId },
    orderBy: [{ category: "asc" }, { key: "asc" }],
  });
}

export async function upsertMemory(
  storeId: string,
  input: MemoryUpsertInput,
): Promise<StoreMemory> {
  return prisma.storeMemory.upsert({
    where: { storeId_key: { storeId, key: input.key } },
    create: {
      storeId,
      category: input.category,
      key: input.key,
      value: input.value,
    },
    update: {
      category: input.category,
      value: input.value,
    },
  });
}

// Tenant-scoped delete: refuses to delete a row that doesn't belong to this
// store. Returns true on delete, false if the row didn't exist for this store.
export async function deleteMemory(
  storeId: string,
  id: string,
): Promise<boolean> {
  const row = await prisma.storeMemory.findFirst({
    where: { id, storeId },
    select: { id: true },
  });
  if (!row) return false;
  await prisma.storeMemory.delete({ where: { id: row.id } });
  return true;
}

const CATEGORY_HEADINGS: Record<MemoryCategory, string> = {
  BRAND_VOICE: "Brand voice",
  PRICING_RULES: "Pricing rules",
  PRODUCT_RULES: "Product rules",
  CUSTOMER_RULES: "Customer rules",
  STORE_CONTEXT: "Store context",
  OPERATOR_PREFS: "Operator preferences",
};

// Group entries by category for the systemInstruction injection.
export function formatMemoryAsMarkdown(entries: StoreMemory[]): string {
  if (entries.length === 0) return "";

  const byCategory = new Map<MemoryCategory, StoreMemory[]>();
  for (const e of entries) {
    const arr = byCategory.get(e.category) ?? [];
    arr.push(e);
    byCategory.set(e.category, arr);
  }

  const sections: string[] = [];
  for (const [category, items] of byCategory) {
    const heading = `### ${CATEGORY_HEADINGS[category]}`;
    const lines = items.map((it) => `- ${it.key}: ${it.value}`);
    sections.push([heading, ...lines].join("\n"));
  }
  return sections.join("\n\n");
}
