import { describe, expect, it } from "vitest";

import type { MemoryCategory } from "@prisma/client";

import {
  CANDIDATE_POOL,
  match,
  scoreCandidates,
  type Candidate,
  type Signals,
} from "../../../app/lib/agent/suggestions.server";

// Build a baseline-neutral Signals object so tests can flip individual
// fields without re-stating the rest.
function makeSignals(overrides: Partial<Signals> = {}): Signals {
  return {
    storeAgeHours: 720, // ~30 days, established
    recentTools: [],
    recentApprovedCount: 0,
    memoryCount: 0,
    memoryCategories: new Set<MemoryCategory>(),
    brandVoiceText: null,
    draftCount: 0,
    lowStockCount: 0,
    productCount: 10,
    recentClickedTemplates: new Set<string>(),
    hourOfDay: 10, // 10am
    dayOfWeek: 2, // Tuesday
    isWeekend: false,
    isBusinessHours: true,
    ...overrides,
  };
}

describe("match (predicate switch)", () => {
  it("new_store fires when store age < 24h", () => {
    expect(match("new_store", makeSignals({ storeAgeHours: 12 }))).toBe(true);
    expect(match("new_store", makeSignals({ storeAgeHours: 24 }))).toBe(false);
    expect(match("new_store", makeSignals({ storeAgeHours: 100 }))).toBe(false);
  });

  it("old_store fires when store age >= 48h", () => {
    expect(match("old_store", makeSignals({ storeAgeHours: 47 }))).toBe(false);
    expect(match("old_store", makeSignals({ storeAgeHours: 48 }))).toBe(true);
    expect(match("old_store", makeSignals({ storeAgeHours: 200 }))).toBe(true);
  });

  it("empty_memory + has_brand_voice_memory mirror memoryCategories", () => {
    const empty = makeSignals({ memoryCount: 0 });
    expect(match("empty_memory", empty)).toBe(true);
    expect(match("has_brand_voice_memory", empty)).toBe(false);

    const withBV = makeSignals({
      memoryCount: 1,
      memoryCategories: new Set<MemoryCategory>(["BRAND_VOICE"]),
    });
    expect(match("empty_memory", withBV)).toBe(false);
    expect(match("has_brand_voice_memory", withBV)).toBe(true);
  });

  it("has_drafts / no_drafts toggle on draftCount", () => {
    expect(match("has_drafts", makeSignals({ draftCount: 0 }))).toBe(false);
    expect(match("no_drafts", makeSignals({ draftCount: 0 }))).toBe(true);
    expect(match("has_drafts", makeSignals({ draftCount: 3 }))).toBe(true);
    expect(match("no_drafts", makeSignals({ draftCount: 3 }))).toBe(false);
  });

  it("low_stock fires when lowStockCount > 0", () => {
    expect(match("low_stock", makeSignals({ lowStockCount: 0 }))).toBe(false);
    expect(match("low_stock", makeSignals({ lowStockCount: 5 }))).toBe(true);
  });

  it("has_products / no_products toggle on productCount", () => {
    expect(match("has_products", makeSignals({ productCount: 0 }))).toBe(false);
    expect(match("no_products", makeSignals({ productCount: 0 }))).toBe(true);
    expect(match("has_products", makeSignals({ productCount: 1 }))).toBe(true);
  });

  it("recently_updated_prices only fires for the matching tool name within 24h", () => {
    const recent = makeSignals({
      recentTools: [{ name: "update_product_price", hoursAgo: 2 }],
    });
    expect(match("recently_updated_prices", recent)).toBe(true);

    const old = makeSignals({
      recentTools: [{ name: "update_product_price", hoursAgo: 30 }],
    });
    expect(match("recently_updated_prices", old)).toBe(false);

    const wrongTool = makeSignals({
      recentTools: [{ name: "update_product_description", hoursAgo: 1 }],
    });
    expect(match("recently_updated_prices", wrongTool)).toBe(false);
  });

  it("no_recent_activity requires both 0 approved actions AND old store", () => {
    expect(
      match(
        "no_recent_activity",
        makeSignals({ recentApprovedCount: 0, storeAgeHours: 100 }),
      ),
    ).toBe(true);
    expect(
      match(
        "no_recent_activity",
        makeSignals({ recentApprovedCount: 0, storeAgeHours: 12 }),
      ),
    ).toBe(false);
    expect(
      match(
        "no_recent_activity",
        makeSignals({ recentApprovedCount: 5, storeAgeHours: 100 }),
      ),
    ).toBe(false);
  });

  it("business_hours_weekday vs weekend_or_friday_evening are mutually exclusive in their windows", () => {
    const tueMorning = makeSignals({
      dayOfWeek: 2,
      hourOfDay: 10,
      isBusinessHours: true,
      isWeekend: false,
    });
    expect(match("business_hours_weekday", tueMorning)).toBe(true);
    expect(match("weekend_or_friday_evening", tueMorning)).toBe(false);

    const fridayEvening = makeSignals({
      dayOfWeek: 5,
      hourOfDay: 19,
      isBusinessHours: false,
      isWeekend: false,
    });
    expect(match("weekend_or_friday_evening", fridayEvening)).toBe(true);
    expect(match("business_hours_weekday", fridayEvening)).toBe(false);

    const saturday = makeSignals({
      dayOfWeek: 6,
      hourOfDay: 14,
      isBusinessHours: false,
      isWeekend: true,
    });
    expect(match("weekend_or_friday_evening", saturday)).toBe(true);
  });
});

describe("scoreCandidates", () => {
  // Minimal pool for deterministic ranking without the full 28-entry pool.
  const pool: Candidate[] = [
    {
      id: "a_analytics",
      label: "A — analytics",
      prompt: "A",
      category: "analytics",
      baseScore: 5,
    },
    {
      id: "b_analytics_boosted",
      label: "B — analytics boosted",
      prompt: "B",
      category: "analytics",
      baseScore: 3,
      boostWhen: ["business_hours_weekday"],
    },
    {
      id: "c_drafts_required",
      label: "C — drafts required",
      prompt: "C",
      category: "drafts",
      baseScore: 4,
      requires: ["has_drafts"],
    },
    {
      id: "d_memory",
      label: "D — memory",
      prompt: "D",
      category: "memory",
      baseScore: 3,
      boostWhen: ["empty_memory"],
    },
    {
      id: "e_general",
      label: "E — general",
      prompt: "E",
      category: "general",
      baseScore: 2,
    },
  ];

  it("drops candidates whose `requires` guards aren't satisfied", () => {
    const result = scoreCandidates(makeSignals({ draftCount: 0 }), pool);
    expect(result.find((c) => c.id === "c_drafts_required")).toBeUndefined();
  });

  it("includes a `requires`d candidate when its guard is met", () => {
    const result = scoreCandidates(makeSignals({ draftCount: 2 }), pool);
    expect(result.find((c) => c.id === "c_drafts_required")).toBeDefined();
  });

  it("boostWhen lifts a candidate above its baseline rivals", () => {
    // Baseline a_analytics=5; b_analytics_boosted=3+3 (business_hours
    // match)=6 → wins. d_memory=3+3 (empty_memory match)=6 also ties.
    // Pool order is [a, b, d, ...] so the stable-sort tiebreak puts b
    // ahead of d. Diversity penalty pushes a (second analytics) down
    // to 3. End result: b first.
    const result = scoreCandidates(
      makeSignals({ isBusinessHours: true, dayOfWeek: 2 }),
      pool,
    );
    expect(result[0].id).toBe("b_analytics_boosted");
    // Confirm the boost actually mattered — without it, a would win.
    const noBoost = scoreCandidates(
      makeSignals({
        isBusinessHours: false,
        dayOfWeek: 2,
        // also turn off the empty_memory boost so d doesn't take the top
        memoryCount: 1,
        memoryCategories: new Set<MemoryCategory>(["BRAND_VOICE"]),
      }),
      pool,
    );
    expect(noBoost[0].id).toBe("a_analytics");
  });

  it("diversity penalty pushes a same-category second pick below cross-category alternatives", () => {
    // Two analytics candidates and one general. After diversity penalty,
    // b_analytics_boosted (3 + 3 boost − 2 penalty = 4) loses to e_general
    // (baseScore 2, no boost, no penalty = 2)? No, 4 > 2. Use a different
    // construction: increase e_general's base to compete with the penalized
    // analytics second-pick.
    const localPool: Candidate[] = [
      {
        id: "first_analytics",
        label: "first",
        prompt: "x",
        category: "analytics",
        baseScore: 5,
      },
      {
        id: "second_analytics",
        label: "second",
        prompt: "y",
        category: "analytics",
        baseScore: 4,
      },
      {
        id: "first_general",
        label: "general",
        prompt: "z",
        category: "general",
        baseScore: 3,
      },
    ];
    const result = scoreCandidates(makeSignals(), localPool);
    // first_analytics keeps 5, second_analytics is penalized 4 - 2 = 2,
    // first_general is unpenalized 3. Expected order:
    //   first_analytics (5) → first_general (3) → second_analytics (2)
    expect(result.map((c) => c.id)).toEqual([
      "first_analytics",
      "first_general",
      "second_analytics",
    ]);
  });

  it("session de-dupe penalty deprioritizes a recently-clicked candidate", () => {
    const baseline = scoreCandidates(makeSignals(), pool);
    const baselineIdx = baseline.findIndex((c) => c.id === "a_analytics");

    const dedup = scoreCandidates(
      makeSignals({
        recentClickedTemplates: new Set(["a_analytics"]),
      }),
      pool,
    );
    const dedupIdx = dedup.findIndex((c) => c.id === "a_analytics");
    expect(dedupIdx).toBeGreaterThan(baselineIdx);
  });

  it("suppressWhen subtracts from a candidate that would otherwise win", () => {
    const localPool: Candidate[] = [
      {
        id: "would_win",
        label: "w",
        prompt: "w",
        category: "products",
        baseScore: 5,
        suppressWhen: ["recently_updated_prices"],
      },
      {
        id: "rival",
        label: "r",
        prompt: "r",
        category: "general",
        baseScore: 4,
      },
    ];
    const result = scoreCandidates(
      makeSignals({
        recentTools: [{ name: "update_product_price", hoursAgo: 2 }],
      }),
      localPool,
    );
    // would_win: 5 - 3 = 2, rival: 4. Expect rival first.
    expect(result[0].id).toBe("rival");
  });

  it("returns pool members sorted by descending adjusted score", () => {
    const result = scoreCandidates(makeSignals(), pool);
    // Default signals: business_hours=true, empty_memory=true.
    //   a_analytics: 5
    //   b_analytics_boosted: 3 + 3 (business_hours) = 6
    //   c_drafts_required: requires has_drafts (false) → filtered
    //   d_memory: 3 + 3 (empty_memory) = 6
    //   e_general: 2
    // Pre-diversity sort (stable, pool-order tiebreak): b, d, a, e.
    // Diversity walk: b (analytics first) 6 → d (memory first) 6 →
    // a (analytics second, -2) 3 → e (general first) 2.
    // Final: b, d, a, e.
    const ids = result.map((c) => c.id);
    expect(ids).toEqual([
      "b_analytics_boosted",
      "d_memory",
      "a_analytics",
      "e_general",
    ]);
    expect(ids).not.toContain("c_drafts_required");
  });
});

describe("CANDIDATE_POOL invariants", () => {
  it("every entry has a unique stable id", () => {
    const ids = CANDIDATE_POOL.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has a non-empty prompt", () => {
    for (const c of CANDIDATE_POOL) {
      expect(c.prompt.length).toBeGreaterThan(0);
    }
  });

  it("contains at least 20 entries spanning multiple categories", () => {
    expect(CANDIDATE_POOL.length).toBeGreaterThanOrEqual(20);
    const cats = new Set(CANDIDATE_POOL.map((c) => c.category));
    expect(cats.size).toBeGreaterThanOrEqual(5);
  });
});
