// Phase Ab Round Ab-C-prime — workflow proposal verification loop.
//
// 7 days after an operator approves a WorkflowProposal, this pass compares
// the cluster's current size (most-recent AbandonmentCluster sharing the
// fingerprint) against the baseline snapshot taken at Approve time. ≥50%
// shrink → VERIFIED_FIXED. Less than that → FIX_DIDNT_HELP, increment
// verificationAttempts, let Wf-E re-author. After 3 failed attempts the
// status locks at FIX_DIDNT_HELP_GIVING_UP and the operator owns it.
//
// Runs nightly between clustering (Ab-A) and Wf-E's proposal pass so the
// spam guard sees the latest status transitions.
//
// Constitutional shape:
// - Read-only on conversation data; writes only to WorkflowProposal rows
// - Per-store scoping on every query
// - Fail-soft per proposal — try/catch with lastVerifyError on error
// - Bounded retry: MAX_VERIFICATION_ATTEMPTS = 3
// - Operator-only at every surface

import prisma from "../../../db.server";
import { log } from "../../log.server";

export const VERIFICATION_WINDOW_DAYS = 7;
export const VERIFICATION_WINDOW_MS = VERIFICATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
// ≥50% shrink to call it fixed. If 10 abandoned turns shared a pattern
// before the workflow shipped and 4 share it 7 days later, the fix worked.
export const SHRINK_THRESHOLD = 0.5;
export const MAX_VERIFICATION_ATTEMPTS = 3;

// Pure classifier output. The DB orchestrator below maps each outcome
// to a status update. Exported so tests can construct fixtures directly.
export type VerifyOutcome =
  | {
      kind: "verified_fixed";
      baselineSize: number;
      currentSize: number;
      shrinkPct: number; // 0..1 (0 = no shrink, 1 = vanished entirely)
    }
  | {
      kind: "fix_didnt_help";
      baselineSize: number;
      currentSize: number;
      shrinkPct: number;
      nextAttempt: number; // attempts + 1 — what we'd write back
    }
  | {
      kind: "giving_up";
      baselineSize: number;
      currentSize: number;
      shrinkPct: number;
      attempts: number; // final attempts count (= MAX_VERIFICATION_ATTEMPTS)
    }
  | {
      kind: "no_baseline";
      reason: string;
    }
  | {
      kind: "not_yet_due";
      daysRemaining: number;
    };

// Pure function — given baseline + current sizes + attempts + clock,
// classify the outcome. DB-free; unit-tested directly.
export function classifyVerification(opts: {
  baselineSize: number | null;
  currentSize: number; // 0 if no matching cluster in latest run
  attempts: number; // current verificationAttempts before this run
  shippedAt: Date;
  now: Date;
}): VerifyOutcome {
  // Due check first — proposals shipped <7d ago aren't ready.
  const elapsed = opts.now.getTime() - opts.shippedAt.getTime();
  if (elapsed < VERIFICATION_WINDOW_MS) {
    return {
      kind: "not_yet_due",
      daysRemaining: Math.ceil(
        (VERIFICATION_WINDOW_MS - elapsed) / (24 * 60 * 60 * 1000),
      ),
    };
  }

  if (opts.baselineSize === null || opts.baselineSize <= 0) {
    return {
      kind: "no_baseline",
      reason:
        opts.baselineSize === null
          ? "no baseline snapshot at ship time (likely cluster GC'd before Approve)"
          : "baseline size was 0 or negative — invalid math",
    };
  }

  // Shrink ratio: how much of the original pattern is gone.
  // currentSize=0 (pattern vanished) → shrinkPct = 1.0 → verified.
  // currentSize=baseline (no change) → shrinkPct = 0.0 → didn't help.
  const shrinkPct = 1 - opts.currentSize / opts.baselineSize;

  if (shrinkPct >= SHRINK_THRESHOLD) {
    return {
      kind: "verified_fixed",
      baselineSize: opts.baselineSize,
      currentSize: opts.currentSize,
      shrinkPct,
    };
  }

  // Didn't help. Check attempt budget.
  const nextAttempt = opts.attempts + 1;
  if (nextAttempt >= MAX_VERIFICATION_ATTEMPTS) {
    return {
      kind: "giving_up",
      baselineSize: opts.baselineSize,
      currentSize: opts.currentSize,
      shrinkPct,
      attempts: nextAttempt,
    };
  }
  return {
    kind: "fix_didnt_help",
    baselineSize: opts.baselineSize,
    currentSize: opts.currentSize,
    shrinkPct,
    nextAttempt,
  };
}

export type VerifyPassResult = {
  scanned: number;
  verified: number;
  didntHelp: number;
  givingUp: number;
  errored: number;
};

// DB-touching orchestrator. Pulls FIX_SHIPPED proposals due for
// verification, looks up each proposal's fingerprint in the latest
// AbandonmentCluster for the store, classifies, writes the status flip.
//
// Called from run-abandonment-brain.ts AFTER clustering completes (fresh
// cluster sizes available) and BEFORE runWorkflowProposalPass (Wf-E so
// spam guard sees latest status).
export async function verifyWorkflowProposalFixes(opts: {
  storeId: string;
  now: Date;
}): Promise<VerifyPassResult> {
  const counts: VerifyPassResult = {
    scanned: 0,
    verified: 0,
    didntHelp: 0,
    givingUp: 0,
    errored: 0,
  };

  const dueCutoff = new Date(opts.now.getTime() - VERIFICATION_WINDOW_MS);
  const due = await prisma.workflowProposal.findMany({
    where: {
      storeId: opts.storeId,
      status: "FIX_SHIPPED",
      shippedAt: { lte: dueCutoff },
    },
    select: {
      id: true,
      fingerprint: true,
      baselineClusterSize: true,
      shippedAt: true,
      verificationAttempts: true,
      name: true,
    },
  });

  for (const p of due) {
    counts.scanned += 1;
    try {
      // Look up current cluster size — most-recent cluster matching the
      // fingerprint. If null, the pattern vanished entirely → currentSize=0.
      const currentCluster = await prisma.abandonmentCluster.findFirst({
        where: { storeId: opts.storeId, fingerprint: p.fingerprint },
        orderBy: { createdAt: "desc" },
        select: { size: true },
      });
      const currentSize = currentCluster?.size ?? 0;

      const outcome = classifyVerification({
        baselineSize: p.baselineClusterSize,
        currentSize,
        attempts: p.verificationAttempts,
        shippedAt: p.shippedAt as Date, // status=FIX_SHIPPED ⇒ shippedAt non-null
        now: opts.now,
      });

      if (outcome.kind === "not_yet_due") {
        // Shouldn't happen — we filtered for shippedAt <= now-7d.
        // Defensive: skip + log.
        log.warn("verify: not_yet_due but query was due-filtered", {
          proposalId: p.id,
          daysRemaining: outcome.daysRemaining,
        });
        continue;
      }

      if (outcome.kind === "no_baseline") {
        await prisma.workflowProposal.update({
          where: { id: p.id },
          data: { lastVerifyError: outcome.reason },
        });
        counts.errored += 1;
        log.warn("verify: no_baseline — skipping", {
          proposalId: p.id,
          reason: outcome.reason,
        });
        continue;
      }

      if (outcome.kind === "verified_fixed") {
        await prisma.workflowProposal.update({
          where: { id: p.id },
          data: {
            status: "VERIFIED_FIXED",
            verifiedAt: opts.now,
            lastVerifyError: null,
          },
        });
        counts.verified += 1;
        log.info("verify: VERIFIED_FIXED", {
          proposalId: p.id,
          name: p.name,
          baselineSize: outcome.baselineSize,
          currentSize: outcome.currentSize,
          shrinkPct: outcome.shrinkPct,
        });
        continue;
      }

      if (outcome.kind === "giving_up") {
        await prisma.workflowProposal.update({
          where: { id: p.id },
          data: {
            status: "FIX_DIDNT_HELP_GIVING_UP",
            verificationAttempts: outcome.attempts,
            verifiedAt: opts.now,
            lastVerifyError: null,
          },
        });
        counts.givingUp += 1;
        log.warn("verify: FIX_DIDNT_HELP_GIVING_UP", {
          proposalId: p.id,
          name: p.name,
          baselineSize: outcome.baselineSize,
          currentSize: outcome.currentSize,
          shrinkPct: outcome.shrinkPct,
          attempts: outcome.attempts,
        });
        continue;
      }

      // outcome.kind === "fix_didnt_help"
      await prisma.workflowProposal.update({
        where: { id: p.id },
        data: {
          status: "FIX_DIDNT_HELP",
          verificationAttempts: outcome.nextAttempt,
          lastVerifyError: null,
        },
      });
      counts.didntHelp += 1;
      log.info("verify: FIX_DIDNT_HELP (will re-author)", {
        proposalId: p.id,
        name: p.name,
        baselineSize: outcome.baselineSize,
        currentSize: outcome.currentSize,
        shrinkPct: outcome.shrinkPct,
        nextAttempt: outcome.nextAttempt,
      });
    } catch (err) {
      counts.errored += 1;
      const message = err instanceof Error ? err.message : String(err);
      log.error("verify: per-proposal failure (non-fatal)", {
        proposalId: p.id,
        err: message,
      });
      // Best-effort record the error so operators can see it in the UI.
      try {
        await prisma.workflowProposal.update({
          where: { id: p.id },
          data: { lastVerifyError: message.slice(0, 500) },
        });
      } catch {
        // Swallow — already logged. Don't escalate.
      }
    }
  }

  return counts;
}
