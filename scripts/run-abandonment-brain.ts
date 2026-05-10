import { PrismaClient } from "@prisma/client";

import {
  gcOldClusterRuns,
  runAbandonmentBrainForStore,
} from "../app/lib/agent/abandonment/cluster.server";
import { runWorkflowProposalPass } from "../app/lib/agent/workflows/propose.server";

// Phase Ab Round Ab-A — Abandonment Brain cron entrypoint.
// Invoked nightly by .github/workflows/abandonment-brain.yml.
//
// Per-store pipeline (~5-15s for 200 turns at v1 scale):
//   1. Pull last 30 days of TurnSignal where outcome IN
//      ('abandoned', 'clarified')
//   2. Embed each user message via gemini-embedding-001
//   3. DBSCAN cluster (eps=0.15, minPts=3)
//   4. Persist as one ClusterRun + N AbandonmentCluster rows
//
// Required env:
//   - DATABASE_URL    Railway Postgres URL
//   - GEMINI_API_KEY  Google AI Studio key (for embeddings; cheaper
//                     quota bucket than chat-mode generation, but
//                     still fail-soft)
//
// Exit code 0 on success (per-store errors are logged + counted, not
// fatal). Exit code 1 only on infra failure (DB unreachable, etc.).
//
// Garbage collection: ClusterRun rows older than 14 days are deleted
// at the top of every run. Cascades to AbandonmentCluster.

const prisma = new PrismaClient();

const LOOKBACK_DAYS = 30;
const TTL_DAYS = 14;
const MAX_RUN_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const now = new Date();
  const startedAt = Date.now();
  console.log(`[ab-brain] starting run at ${now.toISOString()}`);

  const deadline = setTimeout(() => {
    console.error(`[ab-brain] exceeded ${MAX_RUN_MS}ms budget — aborting`);
    process.exit(1);
  }, MAX_RUN_MS);

  // GC first — cheap, runs even if no stores need processing.
  try {
    const gcCount = await gcOldClusterRuns({ now, ttlDays: TTL_DAYS });
    if (gcCount > 0) {
      console.log(`[ab-brain] gc: removed ${gcCount} ClusterRun(s) older than ${TTL_DAYS}d`);
    }
  } catch (err) {
    console.error("[ab-brain] gc failed (non-fatal)", err);
  }

  const stores = await prisma.store.findMany({
    where: { uninstalledAt: null },
    select: { id: true, shopDomain: true },
  });
  console.log(`[ab-brain] ${stores.length} active store(s) to process`);

  const counts = {
    processed: 0,
    errored: 0,
    totalTurnsScanned: 0,
    totalClusters: 0,
    proposalsScanned: 0,
    proposalsCreated: 0,
    proposalsSkipped: 0,
    proposalsErrored: 0,
  };

  for (const s of stores) {
    try {
      const result = await runAbandonmentBrainForStore({
        storeId: s.id,
        now,
        lookbackDays: LOOKBACK_DAYS,
      });
      const turnsScanned =
        result.totalAbandonedTurns + result.totalClarifiedTurns;
      counts.processed += 1;
      counts.totalTurnsScanned += turnsScanned;
      counts.totalClusters += result.clusters.length;
      console.log(
        `[ab-brain] ${s.shopDomain}: ${result.clusters.length} cluster(s) from ${turnsScanned} turns (${result.durationMs}ms)`,
      );

      // Phase Wf Round Wf-E — Skill Creator pass. Authors workflow
      // proposals from the largest abandonment clusters. Cost-bounded
      // to 5 LLM calls per store per nightly run; spam-guard skips
      // fingerprints already proposed in the last 7 days. Fail-soft
      // per cluster — never blocks the rest of the cron.
      try {
        const proposals = await runWorkflowProposalPass({
          storeId: s.id,
          now,
        });
        counts.proposalsScanned += proposals.scanned;
        counts.proposalsCreated += proposals.proposed;
        counts.proposalsSkipped += proposals.skipped;
        counts.proposalsErrored += proposals.errored;
        if (proposals.proposed > 0 || proposals.errored > 0) {
          console.log(
            `[ab-brain] ${s.shopDomain}: workflow proposals — scanned:${proposals.scanned} proposed:${proposals.proposed} skipped:${proposals.skipped} errored:${proposals.errored}`,
          );
        }
      } catch (err) {
        // Defensive — runWorkflowProposalPass already swallows internally,
        // but a bug could escape. Don't let it fail the whole cron.
        console.error(`[ab-brain] proposal pass non-fatal for ${s.id}`, err);
        counts.proposalsErrored += 1;
      }
    } catch (err) {
      counts.errored += 1;
      console.error(`[ab-brain] fatal for ${s.id}`, err);
    }
  }

  clearTimeout(deadline);
  const totalDurationMs = Date.now() - startedAt;
  console.log(
    `[ab-brain] done — processed:${counts.processed} errored:${counts.errored} turnsScanned:${counts.totalTurnsScanned} totalClusters:${counts.totalClusters} proposals(scanned:${counts.proposalsScanned} created:${counts.proposalsCreated} skipped:${counts.proposalsSkipped} errored:${counts.proposalsErrored}) | total:${totalDurationMs}ms`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[ab-brain] fatal", err);
    await prisma.$disconnect();
    process.exit(1);
  });
