import { PrismaClient } from "@prisma/client";

import {
  analyzeRoutingForStore,
} from "../app/lib/eval/router-analyzer.server";
import {
  shouldFileSystemHealthFinding,
} from "../app/lib/agent/system-health.server";
import { recordEvalRun } from "../app/lib/eval/persistence.server";
import { SCENARIOS } from "../app/lib/eval/scenarios";
import type { EvalScenarioResult } from "../app/lib/eval/types";

// runner.server.ts is dynamically imported below — it transitively
// pulls in ceo-prompt.server.ts which uses Vite's `?raw` syntax to
// embed markdown prompt files. That syntax only resolves under Vite;
// tsx (which runs this script) sees `.md?raw` and throws
// ERR_UNKNOWN_FILE_EXTENSION. Until commit 3 lands a tsx-compatible
// path (likely a non-Vite CEO prompt assembler for the harness, or
// an esbuild prebuild step), we lazy-import only when SCENARIOS has
// entries. With SCENARIOS = [] the runner is never imported.

// Phase 8 — eval harness cron entrypoint. Invoked nightly by
// .github/workflows/eval-harness.yml. Two passes:
//
//   1. Curated scenarios — runs each fixture in app/lib/eval/scenarios
//      against the live agent stack with fakeAdmin substituted, scores
//      against the scenario's expectations, and aggregates into one
//      EvalRun row.
//
//   2. Routing analyzer — walks all installed stores, reads the last
//      7 days of TurnSignal rows, runs 4 pattern detectors, files
//      operator-only RawFinding rows via SystemHealthFinding (with
//      the existing 7-day spam guard).
//
// Exit code 0 on success (scenario failures count as "data, not infra
// errors" — the harness's whole job is to surface them). Exit code 1
// only on fatal infra failure (DB unreachable, etc.).
//
// Run-time budget: 5 minutes per CLAUDE.md guarantee. With zero
// scenarios in commit 5 the run is dominated by analyzer queries —
// each is one indexed read of TurnSignal, ~50ms per store.

const prisma = new PrismaClient();

// Hard timeout — if the run blows past this twice in a row, the
// operator should trim the corpus. We exit 1 (infra failure) so
// the GitHub Action surfaces red.
const MAX_RUN_MS = 5 * 60 * 1000;

async function runScenarios(now: Date): Promise<{
  results: EvalScenarioResult[];
  durationMs: number;
}> {
  const startedAt = Date.now();

  if (SCENARIOS.length === 0) {
    console.log("[eval-harness] no scenarios registered — skipping pass 1");
    return { results: [], durationMs: Date.now() - startedAt };
  }

  console.log(`[eval-harness] running ${SCENARIOS.length} scenario(s)`);

  // Lazy-import — see top-of-file note. Pulls in ceo-prompt.server.ts
  // which uses Vite ?raw imports. Until those are tsx-compatible this
  // import will throw ERR_UNKNOWN_FILE_EXTENSION; we surface that as
  // a clean infra error rather than a silent test-pass.
  const { runEvalScenario } = await import("../app/lib/eval/runner.server");

  // Scenarios run against a synthetic Conversation seeded under a
  // dedicated harness store. We pick the FIRST installed store as
  // the context; if none exist (fresh DB), skip pass 1 and log.
  // The harness conversations leave a small audit trail in this
  // store; that's intentional — the operator can scroll the chat
  // UI to see what the agent did.
  const harnessStore = await prisma.store.findFirst({
    where: { uninstalledAt: null },
    orderBy: { installedAt: "asc" },
    select: { id: true, shopDomain: true },
  });
  if (harnessStore === null) {
    console.log("[eval-harness] no installed stores — skipping pass 1");
    return { results: [], durationMs: Date.now() - startedAt };
  }

  const results: EvalScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    try {
      const result = await runEvalScenario({
        scenario,
        storeId: harnessStore.id,
        shopDomain: harnessStore.shopDomain,
      });
      results.push(result);
      console.log(
        `[eval-harness] ${scenario.id}: ${result.passed ? "PASS" : "FAIL"} (${result.durationMs}ms)`,
      );
      if (!result.passed) {
        for (const f of result.failedExpectations) {
          console.log(`[eval-harness]   ↳ ${f}`);
        }
      }
    } catch (err) {
      console.error(`[eval-harness] scenario ${scenario.id} crashed`, err);
      // Don't push a synthetic "passed: false" — the runner already
      // catches loop errors and surfaces them via observation.loopError.
      // A crash here means the runner ITSELF threw, which is rare
      // but we don't want it to kill the whole pass.
    }
    void now;
  }

  return { results, durationMs: Date.now() - startedAt };
}

async function runRouterAnalyzer(now: Date): Promise<{
  storesScanned: number;
  findingsFiled: number;
  skippedSpamGuard: number;
  errors: number;
}> {
  const counts = {
    storesScanned: 0,
    findingsFiled: 0,
    skippedSpamGuard: 0,
    errors: 0,
  };

  const stores = await prisma.store.findMany({
    where: { uninstalledAt: null },
    select: { id: true },
  });
  console.log(
    `[eval-harness] router-analyzer: ${stores.length} active store(s)`,
  );

  for (const s of stores) {
    try {
      const findings = await analyzeRoutingForStore({
        storeId: s.id,
        now,
      });
      counts.storesScanned += 1;

      for (const f of findings) {
        const eligible = await shouldFileSystemHealthFinding(
          s.id,
          f.component,
          now,
        );
        if (!eligible) {
          counts.skippedSpamGuard += 1;
          continue;
        }
        await prisma.systemHealthFinding.create({
          data: {
            storeId: s.id,
            component: f.component,
            severity: f.severity,
            scanName: f.scanName,
            message: f.message,
            recommendation: f.recommendation,
            evidence: f.evidence as unknown as object,
          },
        });
        counts.findingsFiled += 1;
      }
    } catch (err) {
      console.error(`[eval-harness] router-analyzer fatal for ${s.id}`, err);
      counts.errors += 1;
    }
  }

  return counts;
}

async function main(): Promise<void> {
  const now = new Date();
  const startedAt = Date.now();
  console.log(`[eval-harness] starting run at ${now.toISOString()}`);

  // Hard timeout — if we take longer than MAX_RUN_MS the GitHub
  // Action job timeout (10 min by default) would kill us; we'd
  // rather log and exit 1 cleanly so the operator sees a red run
  // instead of a mystery timeout.
  const deadline = setTimeout(() => {
    console.error(`[eval-harness] exceeded ${MAX_RUN_MS}ms budget — aborting`);
    process.exit(1);
  }, MAX_RUN_MS);

  const scenarioPass = await runScenarios(now);
  const passed = scenarioPass.results.filter((r) => r.passed).length;
  const failed = scenarioPass.results.length - passed;

  const analyzerPass = await runRouterAnalyzer(now);

  const totalDurationMs = Date.now() - startedAt;
  clearTimeout(deadline);

  await recordEvalRun({
    runAt: now,
    totalScenarios: scenarioPass.results.length,
    passed,
    failed,
    durationMs: totalDurationMs,
    results: scenarioPass.results,
  });

  console.log(
    `[eval-harness] done — scenarios: ${passed}/${scenarioPass.results.length} passed | analyzer: scanned:${analyzerPass.storesScanned} filed:${analyzerPass.findingsFiled} skipped:${analyzerPass.skippedSpamGuard} errors:${analyzerPass.errors} | total:${totalDurationMs}ms`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[eval-harness] fatal", err);
    await prisma.$disconnect();
    process.exit(1);
  });
