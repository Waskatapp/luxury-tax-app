import { describe, expect, it } from "vitest";

import {
  MAX_VERIFICATION_ATTEMPTS,
  SHRINK_THRESHOLD,
  VERIFICATION_WINDOW_DAYS,
  VERIFICATION_WINDOW_MS,
  classifyVerification,
} from "../../../app/lib/agent/abandonment/verify.server";

// Phase Ab Round Ab-C-prime — pure classifier tests.
// The DB-touching orchestrator `verifyWorkflowProposalFixes` is integration-
// tested implicitly via the nightly cron. Here we lock down the math
// contract: given baseline + current + attempts + clock, the outcome
// classification is deterministic.

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe("Ab-C-prime constants", () => {
  it("exposes verification window as 7 days", () => {
    expect(VERIFICATION_WINDOW_DAYS).toBe(7);
    expect(VERIFICATION_WINDOW_MS).toBe(7 * ONE_DAY_MS);
  });

  it("shrink threshold is 50%", () => {
    expect(SHRINK_THRESHOLD).toBe(0.5);
  });

  it("max verification attempts is 3", () => {
    expect(MAX_VERIFICATION_ATTEMPTS).toBe(3);
  });
});

describe("classifyVerification — not yet due", () => {
  it("returns not_yet_due when shipped < 7d ago", () => {
    const shippedAt = new Date("2026-05-10T00:00:00Z");
    const now = new Date("2026-05-13T00:00:00Z"); // 3 days later
    const result = classifyVerification({
      baselineSize: 10,
      currentSize: 5,
      attempts: 0,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("not_yet_due");
    if (result.kind === "not_yet_due") {
      expect(result.daysRemaining).toBe(4);
    }
  });

  it("returns not_yet_due even when current shrink would qualify", () => {
    // 6 days elapsed — under the 7-day floor.
    const shippedAt = new Date("2026-05-10T00:00:00Z");
    const now = new Date("2026-05-16T00:00:00Z");
    const result = classifyVerification({
      baselineSize: 10,
      currentSize: 0,
      attempts: 0,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("not_yet_due");
  });
});

describe("classifyVerification — verified fixed", () => {
  const shippedAt = new Date("2026-05-01T00:00:00Z");
  const now = new Date("2026-05-09T00:00:00Z"); // 8 days later, past the window

  it("flips to verified_fixed when cluster shrank ≥50% (baseline 10 → current 4)", () => {
    const result = classifyVerification({
      baselineSize: 10,
      currentSize: 4,
      attempts: 0,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("verified_fixed");
    if (result.kind === "verified_fixed") {
      expect(result.baselineSize).toBe(10);
      expect(result.currentSize).toBe(4);
      expect(result.shrinkPct).toBeCloseTo(0.6, 5);
    }
  });

  it("flips to verified_fixed when cluster vanished entirely (currentSize=0)", () => {
    const result = classifyVerification({
      baselineSize: 8,
      currentSize: 0,
      attempts: 1,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("verified_fixed");
    if (result.kind === "verified_fixed") {
      expect(result.shrinkPct).toBe(1);
    }
  });

  it("exactly 50% shrink qualifies (boundary check)", () => {
    const result = classifyVerification({
      baselineSize: 10,
      currentSize: 5,
      attempts: 0,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("verified_fixed");
  });
});

describe("classifyVerification — fix_didnt_help (retry path)", () => {
  const shippedAt = new Date("2026-05-01T00:00:00Z");
  const now = new Date("2026-05-09T00:00:00Z");

  it("flips to fix_didnt_help when shrinkage < 50% and attempts < 2", () => {
    const result = classifyVerification({
      baselineSize: 10,
      currentSize: 7, // only 30% shrink
      attempts: 0,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("fix_didnt_help");
    if (result.kind === "fix_didnt_help") {
      expect(result.nextAttempt).toBe(1);
      expect(result.shrinkPct).toBeCloseTo(0.3, 5);
    }
  });

  it("nextAttempt increments from prior attempts", () => {
    const result = classifyVerification({
      baselineSize: 10,
      currentSize: 8,
      attempts: 1, // already tried once
      shippedAt,
      now,
    });
    expect(result.kind).toBe("fix_didnt_help");
    if (result.kind === "fix_didnt_help") {
      expect(result.nextAttempt).toBe(2);
    }
  });

  it("no change at all (current==baseline) flips to fix_didnt_help", () => {
    const result = classifyVerification({
      baselineSize: 10,
      currentSize: 10,
      attempts: 0,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("fix_didnt_help");
    if (result.kind === "fix_didnt_help") {
      expect(result.shrinkPct).toBe(0);
    }
  });

  it("cluster GREW (current > baseline) — negative shrinkPct, still fix_didnt_help", () => {
    const result = classifyVerification({
      baselineSize: 10,
      currentSize: 15,
      attempts: 0,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("fix_didnt_help");
    if (result.kind === "fix_didnt_help") {
      expect(result.shrinkPct).toBe(-0.5);
    }
  });
});

describe("classifyVerification — giving_up after 3 attempts", () => {
  const shippedAt = new Date("2026-05-01T00:00:00Z");
  const now = new Date("2026-05-09T00:00:00Z");

  it("flips to giving_up when nextAttempt would hit MAX_VERIFICATION_ATTEMPTS", () => {
    const result = classifyVerification({
      baselineSize: 10,
      currentSize: 8,
      attempts: 2, // this would be attempt 3 — the cap
      shippedAt,
      now,
    });
    expect(result.kind).toBe("giving_up");
    if (result.kind === "giving_up") {
      expect(result.attempts).toBe(3);
    }
  });

  it("does NOT flip to giving_up when shrinkage qualifies even at attempts=2", () => {
    // Verified wins even on the last attempt.
    const result = classifyVerification({
      baselineSize: 10,
      currentSize: 3,
      attempts: 2,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("verified_fixed");
  });
});

describe("classifyVerification — no baseline", () => {
  const shippedAt = new Date("2026-05-01T00:00:00Z");
  const now = new Date("2026-05-09T00:00:00Z");

  it("returns no_baseline when baselineSize is null", () => {
    const result = classifyVerification({
      baselineSize: null,
      currentSize: 5,
      attempts: 0,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("no_baseline");
    if (result.kind === "no_baseline") {
      expect(result.reason).toContain("no baseline");
    }
  });

  it("returns no_baseline when baselineSize is 0 (avoid divide-by-zero)", () => {
    const result = classifyVerification({
      baselineSize: 0,
      currentSize: 0,
      attempts: 0,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("no_baseline");
  });

  it("returns no_baseline when baselineSize is negative (defensive)", () => {
    const result = classifyVerification({
      baselineSize: -1,
      currentSize: 5,
      attempts: 0,
      shippedAt,
      now,
    });
    expect(result.kind).toBe("no_baseline");
  });

  it("no_baseline takes precedence ONLY after the not-yet-due check", () => {
    // null baseline but shipped 3d ago → still not_yet_due (verification
    // window check comes first).
    const result = classifyVerification({
      baselineSize: null,
      currentSize: 5,
      attempts: 0,
      shippedAt: new Date("2026-05-06T00:00:00Z"),
      now: new Date("2026-05-09T00:00:00Z"),
    });
    expect(result.kind).toBe("not_yet_due");
  });
});
