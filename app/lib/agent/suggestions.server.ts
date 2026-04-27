import type { MemoryCategory } from "@prisma/client";

import prisma from "../../db.server";
import { log } from "../log.server";
import { getAnalytics } from "../shopify/analytics.server";
import type { ShopifyAdmin } from "../shopify/graphql-client.server";
import { readProducts } from "../shopify/products.server";
import { curateWithFlashLite } from "./suggestion-curator.server";

// Welcome-screen suggestion engine. Picks 3-4 contextual prompts per
// merchant/per page-load using:
//   1) signals gathered from Prisma + Shopify (stock, drafts, recent
//      activity, store memory, install age, time of day)
//   2) heuristic scoring against a fixed candidate pool (~28 templates)
//   3) optional Gemini Flash-Lite curation (rephrases labels in the
//      merchant's brand voice)
//
// The Flash-Lite curator is enrichment, NEVER load-bearing. On any failure
// the orchestrator falls back to the heuristic top 4. Same posture as
// memory-extractor.server.ts.
//
// Stable IDs: every candidate has a `templateId` that NEVER changes across
// phrasing variations. This is what we log to SuggestionEvent for telemetry.
// The curator may rewrite `label` but never `prompt` or `templateId`.

const FINAL_COUNT = 4;
const HEURISTIC_TOP_N = 8;

export type Suggestion = {
  templateId: string;
  label: string;
  prompt: string;
};

export type Signals = {
  storeAgeHours: number;
  recentTools: { name: string; hoursAgo: number }[];
  recentApprovedCount: number;
  memoryCount: number;
  memoryCategories: Set<MemoryCategory>;
  brandVoiceText: string | null;
  draftCount: number;
  lowStockCount: number;
  productCount: number;
  recentClickedTemplates: Set<string>;
  hourOfDay: number;
  dayOfWeek: number;
  isWeekend: boolean;
  isBusinessHours: boolean;
};

type SignalGuard =
  | "new_store"
  | "old_store"
  | "empty_memory"
  | "has_brand_voice_memory"
  | "has_pricing_rules_memory"
  | "has_drafts"
  | "no_drafts"
  | "low_stock"
  | "has_products"
  | "no_products"
  | "recently_updated_prices"
  | "recently_updated_descriptions"
  | "recently_created_discount"
  | "no_recent_activity"
  | "business_hours_weekday"
  | "weekend_or_friday_evening"
  | "morning"
  | "evening";

// V2.0 — categories aligned with DepartmentId in app/lib/agent/departments.ts.
// "onboarding" stays separate (welcome-flow only, not a department), "memory"
// is cross-cutting, "general" is for catch-all suggestions that don't fit a
// department. The diversity penalty in scoreCandidates() is category-agnostic
// — renaming category values doesn't change ranking behavior.
export type Candidate = {
  id: string;
  label: string;
  prompt: string;
  category:
    | "onboarding"
    | "insights"            // was "analytics"
    | "products"            // unchanged + absorbs "drafts"
    | "pricing-promotions"  // was "promotions"
    | "memory"
    | "general";
  baseScore: number;
  requires?: SignalGuard[];
  boostWhen?: SignalGuard[];
  suppressWhen?: SignalGuard[];
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function pickSuggestions(
  storeId: string,
  admin: ShopifyAdmin,
): Promise<Suggestion[]> {
  let signals: Signals;
  try {
    signals = await gatherSignals(storeId, admin);
  } catch (err) {
    log.warn("suggestions: gatherSignals failed; using onboarding fallback", {
      storeId,
      err: err instanceof Error ? err.message : String(err),
    });
    return ONBOARDING_FALLBACK;
  }

  const scored = scoreCandidates(signals, CANDIDATE_POOL);
  const top = scored.slice(0, HEURISTIC_TOP_N);
  if (top.length === 0) return ONBOARDING_FALLBACK;

  // Flash-Lite curation. On failure, fall back to heuristic top 4.
  try {
    const curated = await curateWithFlashLite(top, signals);
    if (curated && curated.length >= 3) {
      return curated.slice(0, FINAL_COUNT);
    }
  } catch (err) {
    log.warn("suggestions: curator threw (non-fatal)", {
      storeId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return top.slice(0, FINAL_COUNT).map((c) => ({
    templateId: c.id,
    label: c.label,
    prompt: c.prompt,
  }));
}

// ---------------------------------------------------------------------------
// Signal gathering
// ---------------------------------------------------------------------------

async function gatherSignals(
  storeId: string,
  admin: ShopifyAdmin,
): Promise<Signals> {
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const oneDayAgo = new Date(now.getTime() - dayMs);
  const sessionWindow = new Date(now.getTime() - 30 * 60 * 1000);

  // Run all reads in parallel; tolerate failures via Promise.allSettled.
  const [
    storeRes,
    auditRes,
    pendingRes,
    memoryRes,
    draftsRes,
    lowStockRes,
    productsRes,
    clickedRes,
  ] = await Promise.allSettled([
    prisma.store.findUnique({
      where: { id: storeId },
      select: { installedAt: true },
    }),
    prisma.auditLog.findMany({
      where: { storeId },
      take: 20,
      orderBy: { createdAt: "desc" },
      select: { toolName: true, action: true, createdAt: true },
    }),
    prisma.pendingAction.count({
      where: { storeId, status: "EXECUTED", createdAt: { gte: oneDayAgo } },
    }),
    prisma.storeMemory.findMany({
      where: { storeId },
      select: { category: true, key: true, value: true },
    }),
    readProducts(admin, { first: 50, query: "status:DRAFT" }),
    getAnalytics(admin, { metric: "inventory_at_risk", threshold: 5, days: 30 }),
    readProducts(admin, { first: 1 }),
    prisma.suggestionEvent.findMany({
      where: {
        storeId,
        eventType: "click",
        createdAt: { gte: sessionWindow },
      },
      take: 50,
      select: { templateId: true },
    }),
  ]);

  // Store age
  const installedAt =
    storeRes.status === "fulfilled" && storeRes.value
      ? storeRes.value.installedAt
      : new Date();
  const storeAgeHours =
    (now.getTime() - installedAt.getTime()) / (60 * 60 * 1000);

  // Recent tools (from audit log — both tool_executed and memory_saved)
  const recentTools: { name: string; hoursAgo: number }[] =
    auditRes.status === "fulfilled"
      ? auditRes.value
          .filter((r) => r.toolName !== null)
          .map((r) => ({
            name: r.toolName as string,
            hoursAgo: (now.getTime() - r.createdAt.getTime()) / (60 * 60 * 1000),
          }))
      : [];

  const recentApprovedCount =
    pendingRes.status === "fulfilled" ? pendingRes.value : 0;

  // Memory
  const memoryRows =
    memoryRes.status === "fulfilled" ? memoryRes.value : [];
  const memoryCategories = new Set<MemoryCategory>(
    memoryRows.map((r) => r.category),
  );
  const brandVoiceRow = memoryRows.find(
    (r) => r.category === "BRAND_VOICE" && r.key === "brand_voice",
  );
  const brandVoiceText = brandVoiceRow?.value ?? null;

  // Drafts: count from product list filtered by status:DRAFT
  const draftCount =
    draftsRes.status === "fulfilled" && draftsRes.value.ok
      ? draftsRes.value.data.products.length
      : 0;

  // Low stock
  const lowStockCount =
    lowStockRes.status === "fulfilled" &&
    lowStockRes.value.ok &&
    lowStockRes.value.data.metric === "inventory_at_risk"
      ? lowStockRes.value.data.variants.length
      : 0;

  // Has any products at all (for the "no_products" guard)
  const productCount =
    productsRes.status === "fulfilled" && productsRes.value.ok
      ? productsRes.value.data.products.length
      : 0;

  const recentClickedTemplates = new Set<string>(
    clickedRes.status === "fulfilled"
      ? clickedRes.value.map((r) => r.templateId)
      : [],
  );

  const hourOfDay = now.getHours();
  const dayOfWeek = now.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isBusinessHours =
    !isWeekend && hourOfDay >= 9 && hourOfDay < 17;

  return {
    storeAgeHours,
    recentTools,
    recentApprovedCount,
    memoryCount: memoryRows.length,
    memoryCategories,
    brandVoiceText,
    draftCount,
    lowStockCount,
    productCount,
    recentClickedTemplates,
    hourOfDay,
    dayOfWeek,
    isWeekend,
    isBusinessHours,
  };
}

// ---------------------------------------------------------------------------
// Predicate switch — single source of truth for guard interpretation
// ---------------------------------------------------------------------------

export function match(guard: SignalGuard, s: Signals): boolean {
  switch (guard) {
    case "new_store":
      return s.storeAgeHours < 24;
    case "old_store":
      return s.storeAgeHours >= 48;
    case "empty_memory":
      return s.memoryCount === 0;
    case "has_brand_voice_memory":
      return s.memoryCategories.has("BRAND_VOICE");
    case "has_pricing_rules_memory":
      return s.memoryCategories.has("PRICING_RULES");
    case "has_drafts":
      return s.draftCount > 0;
    case "no_drafts":
      return s.draftCount === 0;
    case "low_stock":
      return s.lowStockCount > 0;
    case "has_products":
      return s.productCount > 0;
    case "no_products":
      return s.productCount === 0;
    case "recently_updated_prices":
      return s.recentTools.some(
        (t) => t.name === "update_product_price" && t.hoursAgo < 24,
      );
    case "recently_updated_descriptions":
      return s.recentTools.some(
        (t) => t.name === "update_product_description" && t.hoursAgo < 24,
      );
    case "recently_created_discount":
      return s.recentTools.some(
        (t) => t.name === "create_discount" && t.hoursAgo < 48,
      );
    case "no_recent_activity":
      return s.recentApprovedCount === 0 && s.storeAgeHours > 48;
    case "business_hours_weekday":
      return s.isBusinessHours;
    case "weekend_or_friday_evening":
      return s.isWeekend || (s.dayOfWeek === 5 && s.hourOfDay >= 17);
    case "morning":
      return s.hourOfDay >= 6 && s.hourOfDay < 12;
    case "evening":
      return s.hourOfDay >= 18 || s.hourOfDay < 6;
  }
}

// ---------------------------------------------------------------------------
// Heuristic scorer
// ---------------------------------------------------------------------------

const BOOST_PER_GUARD = 3;
const SUPPRESS_PER_GUARD = 3;
const STRONG_REQUIRES_FAIL = -1000; // effectively unreachable
const SESSION_DEDUPE_PENALTY = 4;
const DIVERSITY_PENALTY = 2;

export function scoreCandidates(
  signals: Signals,
  pool: readonly Candidate[],
): Candidate[] {
  // 1) Score every candidate.
  const scored = pool.map((c) => ({
    candidate: c,
    score: rawScore(c, signals),
  }));

  // 2) Drop any with scores below the floor (failed `requires`) and sort.
  const ranked = scored
    .filter((s) => s.score > -100)
    .sort((a, b) => b.score - a.score);

  // 3) Apply a diversity penalty post-sort: walk in order, deduct from any
  //    candidate whose category already appeared earlier. Re-sort by the
  //    adjusted score. This keeps the top 4 from being all-analytics or
  //    all-products even when one category dominates raw scores.
  const seenCategories = new Set<Candidate["category"]>();
  const adjusted = ranked.map((s) => {
    const penalty = seenCategories.has(s.candidate.category)
      ? DIVERSITY_PENALTY
      : 0;
    seenCategories.add(s.candidate.category);
    return { candidate: s.candidate, score: s.score - penalty };
  });
  adjusted.sort((a, b) => b.score - a.score);

  return adjusted.map((s) => s.candidate);
}

function rawScore(c: Candidate, signals: Signals): number {
  // Hard requirement: any unmet `requires` guard sinks the score.
  if (c.requires && c.requires.length > 0) {
    for (const g of c.requires) {
      if (!match(g, signals)) return STRONG_REQUIRES_FAIL;
    }
  }

  let score = c.baseScore;
  if (c.boostWhen) {
    for (const g of c.boostWhen) {
      if (match(g, signals)) score += BOOST_PER_GUARD;
    }
  }
  if (c.suppressWhen) {
    for (const g of c.suppressWhen) {
      if (match(g, signals)) score -= SUPPRESS_PER_GUARD;
    }
  }
  // Session de-dupe: don't re-suggest what they just clicked.
  if (signals.recentClickedTemplates.has(c.id)) {
    score -= SESSION_DEDUPE_PENALTY;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Candidate pool — 28 entries across 7 categories
// ---------------------------------------------------------------------------

export const CANDIDATE_POOL: readonly Candidate[] = [
  // ---- Onboarding ----
  {
    id: "tell_me_about_your_store",
    label: "Get to know my store",
    prompt:
      "Take a look at my store and tell me what stands out — products, pricing, anything you'd flag.",
    category: "onboarding",
    baseScore: 2,
    boostWhen: ["new_store"],
  },
  {
    id: "welcome_introduction",
    label: "What can you do?",
    prompt:
      "I'm new here — give me a quick rundown of what you can help me with on my Shopify store.",
    category: "onboarding",
    baseScore: 2,
    boostWhen: ["new_store"],
  },
  {
    id: "whats_safe_to_try_first",
    label: "What should I try first?",
    prompt:
      "What's a safe, useful thing to try first? Something low-risk that shows me how the approval flow works.",
    category: "onboarding",
    baseScore: 1,
    boostWhen: ["new_store", "no_recent_activity"],
  },
  {
    id: "tour_my_catalog",
    label: "Walk me through my catalog",
    prompt: "Walk me through my product catalog — what's there, what's missing.",
    category: "onboarding",
    baseScore: 1,
    requires: ["has_products"],
    boostWhen: ["new_store"],
  },

  // ---- Analytics ----
  {
    id: "show_me_my_products",
    label: "Show me my products",
    prompt: "Show me my products.",
    category: "insights",
    baseScore: 4,
    requires: ["has_products"],
  },
  {
    id: "list_my_collections",
    label: "List my collections",
    prompt: "List my collections.",
    category: "insights",
    baseScore: 3,
  },
  {
    id: "whats_low_on_stock",
    label: "What's running low on stock?",
    prompt: "What's running low on stock?",
    category: "insights",
    baseScore: 4,
    boostWhen: ["low_stock"],
  },
  {
    id: "which_skus_to_reorder",
    label: "Which SKUs should I reorder?",
    prompt:
      "Which SKUs should I reorder soon? Show me the most at-risk ones first.",
    category: "insights",
    baseScore: 2,
    requires: ["low_stock"],
  },
  {
    id: "revenue_this_week",
    label: "How's revenue this week?",
    prompt: "How is revenue this week compared to last week?",
    category: "insights",
    baseScore: 5,
    boostWhen: ["business_hours_weekday"],
    suppressWhen: ["new_store"],
  },
  {
    id: "revenue_last_30",
    label: "How's revenue the last 30 days?",
    prompt: "How is revenue the last 30 days?",
    category: "insights",
    baseScore: 4,
    suppressWhen: ["new_store"],
  },
  {
    id: "top_products_this_week",
    label: "Top sellers this week",
    prompt: "Show me my top 5 products by units sold this week.",
    category: "insights",
    baseScore: 4,
    boostWhen: ["business_hours_weekday"],
    suppressWhen: ["new_store"],
  },
  {
    id: "top_products_30d",
    label: "Top 5 products (30 days)",
    prompt: "Show me my top 5 products by units sold in the last 30 days.",
    category: "insights",
    baseScore: 3,
    suppressWhen: ["new_store"],
  },

  // ---- Products ----
  {
    id: "help_update_a_price",
    label: "Update a product's price",
    prompt: "Help me update a product's price.",
    category: "products",
    baseScore: 4,
    requires: ["has_products"],
    suppressWhen: ["recently_updated_prices"],
  },
  {
    id: "rewrite_a_product_description",
    label: "Rewrite a product description",
    prompt:
      "Rewrite a product description for me — pick a product and improve the description.",
    category: "products",
    baseScore: 4,
    requires: ["has_products"],
    suppressWhen: ["recently_updated_descriptions"],
  },
  {
    id: "find_products_missing_descriptions",
    label: "Find products missing descriptions",
    prompt:
      "Find products that are missing descriptions or have weak ones, and tell me which to fix first.",
    category: "products",
    baseScore: 2,
    requires: ["has_products"],
  },
  {
    id: "list_one_product_full_specs",
    label: "Inspect one product in detail",
    prompt: "List one of my products with all of its specifications.",
    category: "products",
    baseScore: 2,
    requires: ["has_products"],
  },
  {
    id: "bulk_price_review_within_my_rules",
    label: "Review prices against my rules",
    prompt:
      "Review my product prices against my pricing rules and flag anything that doesn't match.",
    category: "products",
    baseScore: 2,
    requires: ["has_pricing_rules_memory", "has_products"],
  },

  // ---- Drafts ----
  {
    id: "review_my_drafts",
    label: "Review my draft products",
    prompt:
      "I have draft products — can you review them with me and help me decide which to publish?",
    category: "products",
    baseScore: 3,
    requires: ["has_drafts"],
  },
  {
    id: "help_publish_draft",
    label: "Help me publish a draft",
    prompt: "Help me publish a draft product.",
    category: "products",
    baseScore: 3,
    requires: ["has_drafts"],
  },
  {
    id: "create_a_new_draft",
    label: "Create a new product draft",
    prompt: "Help me create a new product draft from scratch.",
    category: "products",
    baseScore: 2,
  },

  // ---- Promotions ----
  {
    id: "create_15_off_discount",
    label: "Create a 15% off discount",
    prompt: "Create a 15% off discount.",
    category: "pricing-promotions",
    baseScore: 3,
    suppressWhen: ["recently_created_discount"],
  },
  {
    id: "create_weekend_discount",
    label: "Run a weekend promo",
    prompt:
      "Help me create a weekend discount — suggest a percentage and which collection to apply it to.",
    category: "pricing-promotions",
    baseScore: 2,
    boostWhen: ["weekend_or_friday_evening"],
    suppressWhen: ["recently_created_discount"],
  },
  {
    id: "quick_promo_for_slow_movers",
    label: "Promo for slow movers",
    prompt:
      "Help me set up a small discount for products that haven't been selling well lately.",
    category: "pricing-promotions",
    baseScore: 2,
    requires: ["has_products"],
    boostWhen: ["weekend_or_friday_evening"],
    suppressWhen: ["recently_created_discount"],
  },

  // ---- Memory ----
  {
    id: "set_brand_voice",
    label: "Teach me your brand voice",
    prompt:
      "I'd like to set the brand voice you should use when writing product descriptions. Walk me through a few examples.",
    category: "memory",
    baseScore: 2,
    boostWhen: ["empty_memory", "new_store"],
    suppressWhen: ["has_brand_voice_memory"],
  },
  {
    id: "what_should_i_remember",
    label: "What should I tell you to remember?",
    prompt:
      "What kinds of things would be useful for me to tell you to remember about my store and how I work?",
    category: "memory",
    baseScore: 2,
    boostWhen: ["empty_memory"],
  },
  {
    id: "set_pricing_rules",
    label: "Set my pricing rules",
    prompt:
      "I'd like to set pricing rules you should always follow — like never discounting below a certain margin.",
    category: "memory",
    baseScore: 1,
    suppressWhen: ["has_pricing_rules_memory"],
  },

  // ---- General ----
  {
    id: "what_did_we_change_yesterday",
    label: "What did we change yesterday?",
    prompt: "What did we change in my store in the last 24 hours?",
    category: "general",
    baseScore: 1,
    requires: ["old_store"],
  },
  {
    id: "what_should_i_focus_on_today",
    label: "What should I focus on today?",
    prompt:
      "Based on my store right now, what's the one thing I should focus on today?",
    category: "general",
    baseScore: 2,
    boostWhen: ["business_hours_weekday", "morning"],
  },
];

// ---------------------------------------------------------------------------
// Onboarding fallback — shown only when signal gathering fails entirely.
// Picked to be useful for any store regardless of state.
// ---------------------------------------------------------------------------

const ONBOARDING_FALLBACK: Suggestion[] = [
  {
    templateId: "fallback_show_products",
    label: "Show me my products",
    prompt: "Show me my products.",
  },
  {
    templateId: "fallback_revenue",
    label: "How's revenue this week?",
    prompt: "How is revenue this week compared to last week?",
  },
  {
    templateId: "fallback_low_stock",
    label: "What's running low on stock?",
    prompt: "What's running low on stock?",
  },
];
