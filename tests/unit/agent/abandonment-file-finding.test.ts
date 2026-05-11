import { describe, expect, it } from "vitest";

import {
  buildGivingUpFinding,
  buildVerifiedFixedFinding,
} from "../../../app/lib/agent/abandonment/file-finding.server";

// Phase Ab Round Ab-D — pure builder tests. The DB-touching orchestrator
// `crossFileAbandonmentFindings` is integration-tested implicitly via
// the nightly cron. Here we lock down the message + recommendation
// shape so operators always see consistent text.

describe("buildVerifiedFixedFinding", () => {
  const base = {
    proposalId: "prop_abc",
    name: "handle-stale-bulk-archive",
    baselineClusterSize: 10,
    currentClusterSize: 4,
    fingerprint: "fp1234567890abcdef",
    verifiedAt: new Date("2026-05-18T07:13:00Z"),
  };

  it("returns a finding with info severity + per-proposal component", () => {
    const f = buildVerifiedFixedFinding(base);
    expect(f).not.toBeNull();
    expect(f!.severity).toBe("info");
    expect(f!.component).toBe("workflow_proposal:prop_abc");
    expect(f!.scanName).toBe("abandonmentVerifiedFixScan");
  });

  it("includes the reduction percent in the message", () => {
    const f = buildVerifiedFixedFinding(base);
    expect(f!.message).toContain("handle-stale-bulk-archive");
    expect(f!.message).toContain("10");
    expect(f!.message).toContain("4");
    expect(f!.message).toContain("60% reduction");
  });

  it("rounds the reduction percent (baseline 10 → current 3 = 70%)", () => {
    const f = buildVerifiedFixedFinding({ ...base, currentClusterSize: 3 });
    expect(f!.message).toContain("70% reduction");
  });

  it("100% reduction when cluster vanished entirely", () => {
    const f = buildVerifiedFixedFinding({ ...base, currentClusterSize: 0 });
    expect(f!.message).toContain("100% reduction");
  });

  it("evidence carries proposalId + reduction math for operator drill-in", () => {
    const f = buildVerifiedFixedFinding(base);
    expect(f!.evidence.proposalId).toBe("prop_abc");
    expect(f!.evidence.proposalName).toBe("handle-stale-bulk-archive");
    expect(f!.evidence.baselineClusterSize).toBe(10);
    expect(f!.evidence.currentClusterSize).toBe(4);
    expect(f!.evidence.reductionPct).toBe(60);
    expect(f!.evidence.verifiedAt).toBe("2026-05-18T07:13:00.000Z");
  });

  it("returns null when baselineClusterSize is 0 (avoid divide-by-zero)", () => {
    expect(
      buildVerifiedFixedFinding({ ...base, baselineClusterSize: 0 }),
    ).toBeNull();
  });

  it("returns null when baselineClusterSize is negative (defensive)", () => {
    expect(
      buildVerifiedFixedFinding({ ...base, baselineClusterSize: -1 }),
    ).toBeNull();
  });

  it("recommendation guides the operator to acknowledge + reinforces the pattern", () => {
    const f = buildVerifiedFixedFinding(base);
    expect(f!.recommendation).toContain("Acknowledge");
    expect(f!.recommendation).toContain("Wf-E");
  });
});

describe("buildGivingUpFinding", () => {
  const base = {
    proposalId: "prop_xyz",
    name: "tried-three-times",
    baselineClusterSize: 12,
    currentClusterSize: 11,
    fingerprint: "fp9876543210abcdef",
    verificationAttempts: 3,
  };

  it("returns a finding with warn severity + per-proposal component", () => {
    const f = buildGivingUpFinding(base);
    expect(f.severity).toBe("warn");
    expect(f.component).toBe("workflow_proposal:prop_xyz");
    expect(f.scanName).toBe("abandonmentGivingUpScan");
  });

  it("includes the attempt count in the message", () => {
    const f = buildGivingUpFinding(base);
    expect(f.message).toContain("3 workflow attempts");
    expect(f.message).toContain("baseline 12");
    expect(f.message).toContain("current 11");
  });

  it("truncates the fingerprint to 8 chars for readability", () => {
    const f = buildGivingUpFinding(base);
    // First 8 chars of the fingerprint.
    expect(f.message).toContain("fp987654");
    // Should NOT show the full 18-char fingerprint in the message text.
    expect(f.message).not.toContain("fp9876543210abcdef");
  });

  it("handles missing baseline gracefully", () => {
    const f = buildGivingUpFinding({ ...base, baselineClusterSize: null });
    expect(f.message).toContain("no baseline snapshot");
    expect(f.evidence.baselineClusterSize).toBeNull();
  });

  it("recommendation suggests checking for tool gaps, not prompt fixes", () => {
    const f = buildGivingUpFinding(base);
    expect(f.recommendation).toContain("tool");
    expect(f.recommendation).toContain("abandonment-diagnoses");
  });

  it("evidence carries verificationAttempts + fingerprint for operator drill-in", () => {
    const f = buildGivingUpFinding(base);
    expect(f.evidence.proposalId).toBe("prop_xyz");
    expect(f.evidence.fingerprint).toBe("fp9876543210abcdef");
    expect(f.evidence.verificationAttempts).toBe(3);
  });
});
