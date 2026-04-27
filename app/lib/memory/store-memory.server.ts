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

// Where the memory mutation came from. Drives the audit-log toolName so the
// merchant can tell apart "I told the agent to remember this" from "the agent
// inferred this from our chat" from "I edited it directly in settings".
export type MemorySource = "tool" | "extracted" | "manual";

function sourceToToolName(source: MemorySource): string {
  switch (source) {
    case "tool":
      return "update_store_memory";
    case "extracted":
      return "memory_extracted";
    case "manual":
      return "manual_edit";
  }
}

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

// Upserts and writes an `memory_saved` AuditLog row in the same transaction so
// the audit log truly reflects every memory change, regardless of which path
// triggered it (explicit tool call, post-turn extraction, or settings page).
export async function upsertMemory(
  storeId: string,
  input: MemoryUpsertInput,
  source: MemorySource = "manual",
): Promise<StoreMemory> {
  // Capture prior state for the audit row's `before` field. Null = newly
  // created entry (so the diff modal shows "(none) → new value").
  const before = await prisma.storeMemory.findUnique({
    where: { storeId_key: { storeId, key: input.key } },
    select: { category: true, key: true, value: true },
  });

  const [saved] = await prisma.$transaction([
    prisma.storeMemory.upsert({
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
    }),
    prisma.auditLog.create({
      data: {
        storeId,
        action: "memory_saved",
        toolName: sourceToToolName(source),
        before: (before ?? null) as never,
        after: {
          category: input.category,
          key: input.key,
          value: input.value,
        } as never,
      },
    }),
  ]);
  return saved;
}

// Tenant-scoped delete: refuses to delete a row that doesn't belong to this
// store. Returns true on delete, false if the row didn't exist for this store.
// On delete: writes an `memory_deleted` AuditLog row with the deleted entry
// captured in `before` (so the diff modal shows what was removed).
export async function deleteMemory(
  storeId: string,
  id: string,
  source: MemorySource = "manual",
): Promise<boolean> {
  const row = await prisma.storeMemory.findFirst({
    where: { id, storeId },
    select: { id: true, category: true, key: true, value: true },
  });
  if (!row) return false;
  await prisma.$transaction([
    prisma.storeMemory.delete({ where: { id: row.id } }),
    prisma.auditLog.create({
      data: {
        storeId,
        action: "memory_deleted",
        toolName: sourceToToolName(source),
        before: {
          category: row.category,
          key: row.key,
          value: row.value,
        } as never,
        after: null as never,
      },
    }),
  ]);
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
