// Phase Ab Round Ab-D — cross-file abandonment lifecycle transitions as
// SystemHealthFinding rows so operators see them in /app/settings/system-
// health alongside other op-time health signals.
//
// Two transitions cross-file:
//   - VERIFIED_FIXED (info, celebratory)  — "this workflow reduced its
//     cluster ≥50% over 7d; this is the kind of pattern Wf-E should keep
//     authoring." No action needed; ack to clear.
//   - FIX_DIDNT_HELP_GIVING_UP (warn)     — "3 workflow attempts couldn't
//     move this cluster. Likely a tool gap, not a prompt-engineering
//     problem. Operator should investigate /app/settings/abandonment-
//     diagnoses for the underlying samples."
//
// Constitutional shape (matches the system-health.server.ts pattern):
//   - Tenant-scoped: every query filters by storeId
//   - Operator-only: SystemHealthFindings are STORE_OWNER-gated; never
//     injected into the CEO prompt
//   - 7-day per-(storeId, component) spam guard via
//     shouldFileSystemHealthFinding — same primitive every other scan uses
//   - Per-proposal component naming (`workflow_proposal:<id>`) so each
//     unique proposal can fire its own finding without one collapsing
//     the next
//   - Fail-soft: try/catch per proposal, errors logged + counted, never
//     blocks the cron

import prisma from "../../../db.server";
import { log } from "../../log.server";
import {
  fileFinding,
  shouldFileSystemHealthFinding,
  type RawFinding,
} from "../system-health.server";

// Look-back window for "recently transitioned" proposals. 48h gives a
// 2-day grace so a skipped nightly run doesn't permanently miss a
// VERIFIED_FIXED transition. The spam guard prevents re-firing.
const TRANSITION_LOOKBACK_MS = 48 * 60 * 60 * 1000;

// Pure builders — testable without Prisma. Each returns the RawFinding
// to file (or null if some required field is missing — defensive).

export function buildVerifiedFixedFinding(opts: {
  proposalId: string;
  name: string;
  baselineClusterSize: number;
  currentClusterSize: number;
  fingerprint: string;
  verifiedAt: Date;
}): RawFinding | null {
  if (opts.baselineClusterSize <= 0) return null;
  const reductionPct = Math.round(
    (1 - opts.currentClusterSize / opts.baselineClusterSize) * 100,
  );
  return {
    component: `workflow_proposal:${opts.proposalId}`,
    scanName: "abandonmentVerifiedFixScan",
    severity: "info",
    message: `Workflow \`${opts.name}\` verified working — reduced its abandonment cluster from ${opts.baselineClusterSize} to ${opts.currentClusterSize} turns (${reductionPct}% reduction) over 7 days.`,
    recommendation: `No action needed — this is the closed-loop success Wf-E is for. The workflow is now part of this store's playbook permanently. Acknowledge to clear from the list. Bonus: this pattern (the prior cluster + the workflow body that fixed it) is a high-quality example for future Wf-E proposals; keep it in mind when reviewing new pending proposals.`,
    evidence: {
      proposalId: opts.proposalId,
      proposalName: opts.name,
      fingerprint: opts.fingerprint,
      baselineClusterSize: opts.baselineClusterSize,
      currentClusterSize: opts.currentClusterSize,
      reductionPct,
      verifiedAt: opts.verifiedAt.toISOString(),
    },
  };
}

export function buildGivingUpFinding(opts: {
  proposalId: string;
  name: string;
  baselineClusterSize: number | null;
  currentClusterSize: number;
  fingerprint: string;
  verificationAttempts: number;
}): RawFinding {
  const sizeNote =
    opts.baselineClusterSize !== null
      ? `baseline ${opts.baselineClusterSize} → current ${opts.currentClusterSize}`
      : `current cluster size ${opts.currentClusterSize}, no baseline snapshot`;
  return {
    component: `workflow_proposal:${opts.proposalId}`,
    scanName: "abandonmentGivingUpScan",
    severity: "warn",
    message: `Wf-E has authored ${opts.verificationAttempts} workflow attempts for the cluster fingerprint \`${opts.fingerprint.slice(0, 8)}…\` and NONE reduced the abandonment by ≥50% over 7 days (${sizeNote}). The CEO can't workflow its way out of this pattern.`,
    recommendation: `This usually means the failure is structural, not prompt-engineerable — a tool is missing, a Shopify API limit is biting, or the merchant's request fundamentally can't be served by the current write tools. Investigate the sample turns at /app/settings/abandonment-diagnoses for fingerprint \`${opts.fingerprint.slice(0, 8)}…\` and look for: (1) tools the agent keeps trying to call that don't exist, (2) merchant intents that hit auth/scope walls, (3) data Shopify doesn't expose. Decide if a NEW tool is warranted or if the pattern is genuinely out-of-scope.`,
    evidence: {
      proposalId: opts.proposalId,
      proposalName: opts.name,
      fingerprint: opts.fingerprint,
      baselineClusterSize: opts.baselineClusterSize,
      currentClusterSize: opts.currentClusterSize,
      verificationAttempts: opts.verificationAttempts,
    },
  };
}

export type CrossFileResult = {
  scanned: number;
  filed: number;
  skippedSpamGuard: number;
  errored: number;
};

// Main pass. Called from run-abandonment-brain.ts after the verify pass
// + Wf-E re-author pass so the latest transitions are visible. Idempotent
// over runs: the 7-day spam guard per `workflow_proposal:<id>` component
// prevents re-firing the same finding.
export async function crossFileAbandonmentFindings(opts: {
  storeId: string;
  now: Date;
}): Promise<CrossFileResult> {
  const result: CrossFileResult = {
    scanned: 0,
    filed: 0,
    skippedSpamGuard: 0,
    errored: 0,
  };

  const recentCutoff = new Date(opts.now.getTime() - TRANSITION_LOOKBACK_MS);

  // VERIFIED_FIXED — proposals whose verify pass ran in the last 48h.
  // verifiedAt is set by verify.server.ts when the status flips.
  try {
    const verifiedFixed = await prisma.workflowProposal.findMany({
      where: {
        storeId: opts.storeId,
        status: "VERIFIED_FIXED",
        verifiedAt: { gte: recentCutoff },
      },
      select: {
        id: true,
        name: true,
        fingerprint: true,
        baselineClusterSize: true,
        verifiedAt: true,
      },
    });

    for (const p of verifiedFixed) {
      result.scanned += 1;
      try {
        if (p.baselineClusterSize === null || p.verifiedAt === null) continue;

        // Current cluster size — same lookup the verify pass used.
        const currentCluster = await prisma.abandonmentCluster.findFirst({
          where: { storeId: opts.storeId, fingerprint: p.fingerprint },
          orderBy: { createdAt: "desc" },
          select: { size: true },
        });
        const currentSize = currentCluster?.size ?? 0;

        const raw = buildVerifiedFixedFinding({
          proposalId: p.id,
          name: p.name,
          baselineClusterSize: p.baselineClusterSize,
          currentClusterSize: currentSize,
          fingerprint: p.fingerprint,
          verifiedAt: p.verifiedAt,
        });
        if (raw === null) continue;

        const eligible = await shouldFileSystemHealthFinding(
          opts.storeId,
          raw.component,
          opts.now,
        );
        if (!eligible) {
          result.skippedSpamGuard += 1;
          continue;
        }
        await fileFinding(opts.storeId, raw);
        result.filed += 1;
        log.info("ab-d: filed VERIFIED_FIXED finding", {
          proposalId: p.id,
          name: p.name,
        });
      } catch (err) {
        result.errored += 1;
        log.error("ab-d: per-proposal verified_fixed filing failed", {
          proposalId: p.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    result.errored += 1;
    log.error("ab-d: VERIFIED_FIXED batch query failed", {
      storeId: opts.storeId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // FIX_DIDNT_HELP_GIVING_UP — proposals whose 3rd verify just failed.
  // verifiedAt is set by verify.server.ts on the giving_up transition too.
  try {
    const givingUp = await prisma.workflowProposal.findMany({
      where: {
        storeId: opts.storeId,
        status: "FIX_DIDNT_HELP_GIVING_UP",
        verifiedAt: { gte: recentCutoff },
      },
      select: {
        id: true,
        name: true,
        fingerprint: true,
        baselineClusterSize: true,
        verificationAttempts: true,
      },
    });

    for (const p of givingUp) {
      result.scanned += 1;
      try {
        const currentCluster = await prisma.abandonmentCluster.findFirst({
          where: { storeId: opts.storeId, fingerprint: p.fingerprint },
          orderBy: { createdAt: "desc" },
          select: { size: true },
        });
        const currentSize = currentCluster?.size ?? 0;

        const raw = buildGivingUpFinding({
          proposalId: p.id,
          name: p.name,
          baselineClusterSize: p.baselineClusterSize,
          currentClusterSize: currentSize,
          fingerprint: p.fingerprint,
          verificationAttempts: p.verificationAttempts,
        });

        const eligible = await shouldFileSystemHealthFinding(
          opts.storeId,
          raw.component,
          opts.now,
        );
        if (!eligible) {
          result.skippedSpamGuard += 1;
          continue;
        }
        await fileFinding(opts.storeId, raw);
        result.filed += 1;
        log.info("ab-d: filed FIX_DIDNT_HELP_GIVING_UP finding", {
          proposalId: p.id,
          name: p.name,
        });
      } catch (err) {
        result.errored += 1;
        log.error("ab-d: per-proposal giving_up filing failed", {
          proposalId: p.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    result.errored += 1;
    log.error("ab-d: FIX_DIDNT_HELP_GIVING_UP batch query failed", {
      storeId: opts.storeId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
