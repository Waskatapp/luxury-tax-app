import { PrismaClient } from "@prisma/client";

// Phase Ab Round Ab-E — synthetic seed for the lifecycle UI smoke test.
//
// Creates a small demo set so you can navigate /app/settings/system-health,
// /app/settings/workflow-proposals, and /app/settings/abandonment-diagnoses
// without waiting for the real loop to produce VERIFIED_FIXED or
// FIX_DIDNT_HELP_GIVING_UP transitions.
//
// Per-store. Picks the first non-uninstalled store. Idempotent: deletes
// any prior demo rows (matched by fingerprint prefix `ab_e_demo_`) before
// inserting, so re-running just refreshes the demo.
//
// Run:
//   npx tsx scripts/seed-ab-e-demo.ts
//
// To clean up afterward:
//   npx tsx scripts/seed-ab-e-demo.ts --cleanup

const prisma = new PrismaClient();

const DEMO_FINGERPRINT_PREFIX = "ab_e_demo_";

async function cleanup(storeId: string): Promise<void> {
  // Delete proposals + clusters + findings matching demo fingerprints.
  const proposals = await prisma.workflowProposal.findMany({
    where: { storeId, fingerprint: { startsWith: DEMO_FINGERPRINT_PREFIX } },
    select: { id: true },
  });
  const proposalIds = proposals.map((p) => p.id);
  const componentSet = proposalIds.map((id) => `workflow_proposal:${id}`);
  await prisma.systemHealthFinding.deleteMany({
    where: { storeId, component: { in: componentSet } },
  });
  await prisma.workflowProposal.deleteMany({
    where: { storeId, fingerprint: { startsWith: DEMO_FINGERPRINT_PREFIX } },
  });
  await prisma.abandonmentCluster.deleteMany({
    where: { storeId, fingerprint: { startsWith: DEMO_FINGERPRINT_PREFIX } },
  });
  console.log(
    `[ab-e-demo] cleanup: deleted demo proposals + clusters + findings for store ${storeId}`,
  );
}

async function seed(storeId: string, now: Date): Promise<void> {
  // First clean up any prior run (idempotent).
  await cleanup(storeId);

  // We need a ClusterRun to anchor the AbandonmentClusters. Find or
  // create one for today.
  let clusterRun = await prisma.clusterRun.findFirst({
    where: { storeId },
    orderBy: { runAt: "desc" },
  });
  if (clusterRun === null) {
    clusterRun = await prisma.clusterRun.create({
      data: {
        storeId,
        runAt: now,
        totalAbandonedTurns: 0,
        totalClarifiedTurns: 0,
        clusterCount: 0,
        durationMs: 0,
      },
    });
    console.log(`[ab-e-demo] created synthetic ClusterRun ${clusterRun.id}`);
  }

  const fpVerified = `${DEMO_FINGERPRINT_PREFIX}verified_001`;
  const fpGivingUp = `${DEMO_FINGERPRINT_PREFIX}givingup_002`;

  // --- VERIFIED_FIXED scenario ---
  // A workflow that reduced its cluster from 10 → 3 over 7 days.
  await prisma.abandonmentCluster.create({
    data: {
      clusterRunId: clusterRun.id,
      storeId,
      size: 3, // current cluster size — small (verified the fix shrunk it)
      sampleTurnIds: [],
      commonTools: ["update_product_status"],
      commonRouterReason: "products",
      dominantOutcome: "abandoned",
      centroidEmbedding: [],
      fingerprint: fpVerified,
    },
  });
  const verifiedProposal = await prisma.workflowProposal.create({
    data: {
      storeId,
      name: "ab-e-demo-handle-bulk-archive",
      summary:
        "Demo proposal — when merchant asks to archive products with stale IDs, partition rather than fail",
      body: [
        "# When this runs",
        "Demo workflow body for the Ab-E lifecycle UI smoke test.",
        "",
        "## Decision tree",
        "1. Read the product IDs the merchant supplied",
        "2. Partition into resolvable + missing IDs",
        "3. Surface the missing count to the merchant before proceeding",
      ].join("\n"),
      triggers: ["archive products", "bulk archive"],
      evidence: {
        clusterIds: [],
        sampleTurnIds: [],
        commonTools: ["update_product_status"],
        commonRouterReason: "products",
      },
      status: "VERIFIED_FIXED",
      fingerprint: fpVerified,
      reviewedBy: "ab-e-demo@waskat.app",
      reviewedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      shippedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      baselineClusterSize: 10,
      verifiedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000),
      verificationAttempts: 1,
    },
  });
  // Cross-file finding (mirrors what Ab-D would write).
  await prisma.systemHealthFinding.create({
    data: {
      storeId,
      component: `workflow_proposal:${verifiedProposal.id}`,
      severity: "info",
      scanName: "abandonmentVerifiedFixScan",
      message: `Workflow \`${verifiedProposal.name}\` verified working — reduced its abandonment cluster from 10 to 3 turns (70% reduction) over 7 days.`,
      recommendation:
        "No action needed — this is the closed-loop success Wf-E is for. The workflow is now part of this store's playbook permanently. Acknowledge to clear from the list. Bonus: this pattern (the prior cluster + the workflow body that fixed it) is a high-quality example for future Wf-E proposals; keep it in mind when reviewing new pending proposals.",
      evidence: {
        proposalId: verifiedProposal.id,
        proposalName: verifiedProposal.name,
        fingerprint: fpVerified,
        baselineClusterSize: 10,
        currentClusterSize: 3,
        reductionPct: 70,
        verifiedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      },
    },
  });

  // --- FIX_DIDNT_HELP_GIVING_UP scenario with two re-author siblings ---
  // Cluster still size 11 after 3 attempts — tool gap, not prompt-fixable.
  await prisma.abandonmentCluster.create({
    data: {
      clusterRunId: clusterRun.id,
      storeId,
      size: 11,
      sampleTurnIds: [],
      commonTools: ["create_discount"],
      commonRouterReason: "pricing-promotions",
      dominantOutcome: "abandoned",
      centroidEmbedding: [],
      fingerprint: fpGivingUp,
    },
  });
  // First attempt — FIX_DIDNT_HELP_GIVING_UP (the latest, the one with the finding).
  const givingUpProposal = await prisma.workflowProposal.create({
    data: {
      storeId,
      name: "ab-e-demo-stacked-discount-attempt-3",
      summary:
        "Demo: third attempt at the stacked-discount cluster — locked after failing to reduce.",
      body: "# Demo body — third re-author attempt.\nWf-E gave up here.",
      triggers: ["stack discounts", "combine discounts"],
      evidence: {
        clusterIds: [],
        sampleTurnIds: [],
        commonTools: ["create_discount"],
        commonRouterReason: "pricing-promotions",
      },
      status: "FIX_DIDNT_HELP_GIVING_UP",
      fingerprint: fpGivingUp,
      reviewedBy: "ab-e-demo@waskat.app",
      reviewedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      shippedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      baselineClusterSize: 12,
      verifiedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      verificationAttempts: 3,
    },
  });
  // Sibling: earlier attempt 2 — FIX_DIDNT_HELP.
  await prisma.workflowProposal.create({
    data: {
      storeId,
      name: "ab-e-demo-stacked-discount-attempt-2",
      summary: "Demo: second attempt — also didn't help.",
      body: "# Demo body — second attempt.",
      triggers: ["stack discounts"],
      evidence: {
        clusterIds: [],
        sampleTurnIds: [],
        commonTools: ["create_discount"],
        commonRouterReason: "pricing-promotions",
      },
      status: "FIX_DIDNT_HELP",
      fingerprint: fpGivingUp,
      reviewedBy: "ab-e-demo@waskat.app",
      reviewedAt: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000),
      shippedAt: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000),
      baselineClusterSize: 12,
      verifiedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      verificationAttempts: 2,
    },
  });
  // Sibling: earlier attempt 1 — FIX_DIDNT_HELP.
  await prisma.workflowProposal.create({
    data: {
      storeId,
      name: "ab-e-demo-stacked-discount-attempt-1",
      summary: "Demo: first attempt — didn't help.",
      body: "# Demo body — first attempt.",
      triggers: ["stack discounts"],
      evidence: {
        clusterIds: [],
        sampleTurnIds: [],
        commonTools: ["create_discount"],
        commonRouterReason: "pricing-promotions",
      },
      status: "FIX_DIDNT_HELP",
      fingerprint: fpGivingUp,
      reviewedBy: "ab-e-demo@waskat.app",
      reviewedAt: new Date(now.getTime() - 22 * 24 * 60 * 60 * 1000),
      shippedAt: new Date(now.getTime() - 22 * 24 * 60 * 60 * 1000),
      baselineClusterSize: 12,
      verifiedAt: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000),
      verificationAttempts: 1,
    },
  });
  // Cross-file finding for the giving-up locked proposal.
  await prisma.systemHealthFinding.create({
    data: {
      storeId,
      component: `workflow_proposal:${givingUpProposal.id}`,
      severity: "warn",
      scanName: "abandonmentGivingUpScan",
      message: `Wf-E has authored 3 workflow attempts for the cluster fingerprint \`${fpGivingUp.slice(0, 8)}…\` and NONE reduced the abandonment by ≥50% over 7 days (baseline 12 → current 11). The CEO can't workflow its way out of this pattern.`,
      recommendation: `This usually means the failure is structural, not prompt-engineerable — a tool is missing, a Shopify API limit is biting, or the merchant's request fundamentally can't be served by the current write tools. Investigate the sample turns at /app/settings/abandonment-diagnoses for fingerprint \`${fpGivingUp.slice(0, 8)}…\` and look for: (1) tools the agent keeps trying to call that don't exist, (2) merchant intents that hit auth/scope walls, (3) data Shopify doesn't expose. Decide if a NEW tool is warranted or if the pattern is genuinely out-of-scope.`,
      evidence: {
        proposalId: givingUpProposal.id,
        proposalName: givingUpProposal.name,
        fingerprint: fpGivingUp,
        baselineClusterSize: 12,
        currentClusterSize: 11,
        verificationAttempts: 3,
      },
    },
  });

  console.log(`[ab-e-demo] seeded:`);
  console.log(`  - 1 VERIFIED_FIXED proposal + cluster + finding`);
  console.log(`    fingerprint: ${fpVerified}`);
  console.log(`  - 1 FIX_DIDNT_HELP_GIVING_UP proposal + 2 sibling attempts + cluster + finding`);
  console.log(`    fingerprint: ${fpGivingUp}`);
  console.log(`  - 5 rows total across SystemHealthFinding/WorkflowProposal/AbandonmentCluster`);
  console.log();
  console.log(`Now visit:`);
  console.log(`  /app/settings/system-health  (filter: Abandonment lifecycle)`);
  console.log(`  /app/settings/workflow-proposals`);
  console.log(`  /app/settings/abandonment-diagnoses`);
  console.log();
  console.log(`To remove demo rows: npx tsx scripts/seed-ab-e-demo.ts --cleanup`);
}

async function main(): Promise<void> {
  const isCleanup = process.argv.includes("--cleanup");

  const store = await prisma.store.findFirst({
    where: { uninstalledAt: null },
    select: { id: true, shopDomain: true },
  });
  if (store === null) {
    console.error("[ab-e-demo] no active store found in the database");
    process.exit(1);
  }
  console.log(`[ab-e-demo] target store: ${store.shopDomain} (${store.id})`);

  if (isCleanup) {
    await cleanup(store.id);
  } else {
    await seed(store.id, new Date());
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[ab-e-demo] fatal", err);
    await prisma.$disconnect();
    process.exit(1);
  });
