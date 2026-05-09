// Phase 8 — persists one EvalRun row per nightly cron invocation.
// The full per-scenario diff goes into `summary` JSON so the operator
// UI can render a per-row breakdown without needing a separate table.

import prisma from "../../db.server";

import type { EvalRunSummary } from "./types";

export async function recordEvalRun(summary: EvalRunSummary): Promise<void> {
  await prisma.evalRun.create({
    data: {
      runAt: summary.runAt,
      totalScenarios: summary.totalScenarios,
      passed: summary.passed,
      failed: summary.failed,
      durationMs: summary.durationMs,
      summary: summary.results as unknown as object,
    },
  });
}
