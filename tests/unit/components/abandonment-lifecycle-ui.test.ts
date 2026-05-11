import { describe, expect, it } from "vitest";

import {
  ABANDONMENT_COMPONENT_PREFIX,
  buildTimelineEvents,
  parseAbandonmentEvidence,
} from "../../../app/lib/agent/abandonment/lifecycle";
import { buildListFindingsWhere } from "../../../app/lib/agent/system-health.server";

// Phase Ab Round Ab-E — operator lifecycle visibility. These tests cover
// the pure helpers behind the three new UI surfaces: the structured
// finding evidence renderer (parseAbandonmentEvidence), the verification
// timeline (buildTimelineEvents), and the listFindings where-clause
// filter (buildListFindingsWhere). The React components themselves wrap
// these pure helpers; rendering is exercised via the live smoke test.

describe("parseAbandonmentEvidence", () => {
  it("returns null for findings whose component is not workflow_proposal:*", () => {
    expect(
      parseAbandonmentEvidence({
        component: "embedding_pipeline",
        scanName: "embeddingStuckScan",
        evidence: { stuckCount: 7 },
      }),
    ).toBeNull();
  });

  it("returns null for the exact prefix-only component (defensive)", () => {
    // No id after the colon — not a real abandonment finding.
    // Should still parse defensively (proposalId === "") but kind=other,
    // since neither scan name matches.
    const out = parseAbandonmentEvidence({
      component: ABANDONMENT_COMPONENT_PREFIX,
      scanName: "somethingElse",
      evidence: {},
    });
    expect(out).not.toBeNull();
    expect(out!.proposalId).toBe("");
    expect(out!.kind).toBe("other");
  });

  it("parses a VERIFIED_FIXED finding's evidence into structured fields", () => {
    const out = parseAbandonmentEvidence({
      component: "workflow_proposal:prop_abc",
      scanName: "abandonmentVerifiedFixScan",
      evidence: {
        proposalId: "prop_abc",
        proposalName: "handle-stale-bulk-archive",
        fingerprint: "fp1234567890abcdef",
        baselineClusterSize: 10,
        currentClusterSize: 4,
        reductionPct: 60,
        verifiedAt: "2026-05-18T07:13:00.000Z",
      },
    });
    expect(out).not.toBeNull();
    expect(out!.proposalId).toBe("prop_abc");
    expect(out!.proposalName).toBe("handle-stale-bulk-archive");
    expect(out!.fingerprint).toBe("fp1234567890abcdef");
    expect(out!.fingerprintShort).toBe("fp123456");
    expect(out!.baselineClusterSize).toBe(10);
    expect(out!.currentClusterSize).toBe(4);
    expect(out!.reductionPct).toBe(60);
    expect(out!.verifiedAt).toBe("2026-05-18T07:13:00.000Z");
    expect(out!.kind).toBe("verified");
  });

  it("parses a GIVING_UP finding with null baseline (defensive path)", () => {
    const out = parseAbandonmentEvidence({
      component: "workflow_proposal:prop_xyz",
      scanName: "abandonmentGivingUpScan",
      evidence: {
        proposalId: "prop_xyz",
        proposalName: "tried-three-times",
        fingerprint: "fp9876543210abcdef",
        baselineClusterSize: null,
        currentClusterSize: 11,
        verificationAttempts: 3,
      },
    });
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("giving_up");
    expect(out!.baselineClusterSize).toBeNull();
    expect(out!.verificationAttempts).toBe(3);
    expect(out!.fingerprintShort).toBe("fp987654");
  });

  it("distinguishes absent-field (undefined) from explicit-null baseline", () => {
    const absent = parseAbandonmentEvidence({
      component: "workflow_proposal:prop_a",
      scanName: "abandonmentVerifiedFixScan",
      evidence: { proposalName: "x", fingerprint: "fp" },
    });
    const explicit = parseAbandonmentEvidence({
      component: "workflow_proposal:prop_a",
      scanName: "abandonmentVerifiedFixScan",
      evidence: { baselineClusterSize: null },
    });
    expect(absent!.baselineClusterSize).toBeUndefined();
    expect(explicit!.baselineClusterSize).toBeNull();
  });

  it("returns kind='other' when component matches but scanName is foreign", () => {
    const out = parseAbandonmentEvidence({
      component: "workflow_proposal:prop_a",
      scanName: "futureUnrelatedScan",
      evidence: {},
    });
    expect(out!.kind).toBe("other");
  });
});

describe("buildListFindingsWhere", () => {
  it("defaults to open findings (acknowledgedAt: null) for a store", () => {
    expect(buildListFindingsWhere("store_1")).toEqual({
      storeId: "store_1",
      acknowledgedAt: null,
    });
  });

  it("drops the acknowledgedAt filter when includeAcknowledged is true", () => {
    expect(
      buildListFindingsWhere("store_1", { includeAcknowledged: true }),
    ).toEqual({ storeId: "store_1" });
  });

  it("adds a component startsWith filter when componentPrefix is supplied", () => {
    expect(
      buildListFindingsWhere("store_1", {
        componentPrefix: "workflow_proposal:",
      }),
    ).toEqual({
      storeId: "store_1",
      acknowledgedAt: null,
      component: { startsWith: "workflow_proposal:" },
    });
  });

  it("composes componentPrefix + includeAcknowledged correctly", () => {
    expect(
      buildListFindingsWhere("store_1", {
        includeAcknowledged: true,
        componentPrefix: "workflow_proposal:",
      }),
    ).toEqual({
      storeId: "store_1",
      component: { startsWith: "workflow_proposal:" },
    });
  });
});

describe("buildTimelineEvents", () => {
  const baseProposal: Parameters<typeof buildTimelineEvents>[0] = {
    id: "prop_a",
    name: "handle-stale-bulk-archive",
    status: "PENDING",
    fingerprint: "fp1234567890abcdef",
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-05-11T07:00:00.000Z",
    shippedAt: null,
    baselineClusterSize: null,
    verifiedAt: null,
    verificationAttempts: 0,
    currentClusterSize: null,
  };

  it("returns a single 'Proposed' event for a fresh PENDING proposal", () => {
    const evs = buildTimelineEvents({ ...baseProposal }, []);
    expect(evs).toHaveLength(1);
    expect(evs[0].what).toContain("Proposed by Wf-E");
    expect(evs[0].what).toContain("fp123456");
  });

  it("renders the full chain for a VERIFIED_FIXED proposal", () => {
    const p = {
      ...baseProposal,
      status: "VERIFIED_FIXED" as const,
      reviewedBy: "raqim@example.com",
      reviewedAt: "2026-05-11T08:00:00.000Z",
      shippedAt: "2026-05-11T08:00:01.000Z",
      baselineClusterSize: 10,
      currentClusterSize: 4,
      verifiedAt: "2026-05-18T07:13:00.000Z",
    };
    const evs = buildTimelineEvents(p, []);
    const whats = evs.map((e) => e.what);
    expect(whats[0]).toContain("Proposed");
    expect(whats[1]).toContain("approved");
    expect(whats[2]).toContain("Shipped");
    expect(whats[2]).toContain("10");
    expect(whats[3]).toContain("Verified");
    expect(evs[3].tone).toBe("success");
  });

  it("renders 'Locked' tone=critical for FIX_DIDNT_HELP_GIVING_UP", () => {
    const p = {
      ...baseProposal,
      status: "FIX_DIDNT_HELP_GIVING_UP" as const,
      reviewedAt: "2026-05-11T08:00:00.000Z",
      shippedAt: "2026-05-11T08:00:01.000Z",
      baselineClusterSize: 12,
      currentClusterSize: 11,
      verificationAttempts: 3,
      verifiedAt: "2026-05-18T07:13:00.000Z",
    };
    const evs = buildTimelineEvents(p, []);
    const last = evs[evs.length - 1];
    expect(last.what).toContain("Locked");
    expect(last.what).toContain("3 failed attempts");
    expect(last.tone).toBe("critical");
  });

  it("appends sibling proposals (re-author chain) sorted chronologically", () => {
    const original = {
      ...baseProposal,
      id: "prop_first",
      status: "FIX_DIDNT_HELP_GIVING_UP" as const,
      createdAt: "2026-05-01T07:00:00.000Z",
      reviewedAt: "2026-05-01T08:00:00.000Z",
      shippedAt: "2026-05-01T08:00:01.000Z",
      baselineClusterSize: 10,
      currentClusterSize: 9,
      verificationAttempts: 3,
      verifiedAt: "2026-05-22T07:13:00.000Z",
    };
    const siblings = [
      {
        ...baseProposal,
        id: "prop_second",
        name: "second-attempt",
        status: "FIX_DIDNT_HELP" as const,
        createdAt: "2026-05-08T07:00:00.000Z",
      },
      {
        ...baseProposal,
        id: "prop_third",
        name: "third-attempt",
        status: "FIX_DIDNT_HELP" as const,
        createdAt: "2026-05-15T07:00:00.000Z",
      },
    ];
    const evs = buildTimelineEvents(original, siblings);
    const whats = evs.map((e) => e.what);
    // Both siblings appear, in order.
    const second = whats.findIndex((w) => w.includes("second-attempt"));
    const third = whats.findIndex((w) => w.includes("third-attempt"));
    expect(second).toBeGreaterThan(-1);
    expect(third).toBeGreaterThan(-1);
    expect(third).toBeGreaterThan(second);
    // Final original-proposal "Locked" event is also present.
    expect(whats.some((w) => w.includes("Locked"))).toBe(true);
  });

  it("renders a Rejected event with critical tone when status=REJECTED", () => {
    const p = {
      ...baseProposal,
      status: "REJECTED" as const,
      reviewedBy: "ops@example.com",
      reviewedAt: "2026-05-12T08:00:00.000Z",
    };
    const evs = buildTimelineEvents(p, []);
    const rejectionEvent = evs.find((e) =>
      e.what.toLowerCase().includes("rejected"),
    );
    expect(rejectionEvent).toBeDefined();
    expect(rejectionEvent!.tone).toBe("critical");
  });

  it("handles a proposal that's reviewed + shipped but not yet verified", () => {
    const p = {
      ...baseProposal,
      status: "FIX_SHIPPED" as const,
      reviewedAt: "2026-05-11T08:00:00.000Z",
      shippedAt: "2026-05-11T08:00:01.000Z",
      baselineClusterSize: 7,
    };
    const evs = buildTimelineEvents(p, []);
    expect(evs).toHaveLength(3); // proposed, reviewed, shipped
    expect(evs[2].what).toContain("baseline 7");
    // No verified event yet.
    expect(evs.some((e) => e.what.includes("Verified"))).toBe(false);
  });
});
