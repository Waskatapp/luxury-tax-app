import { PrismaClient } from "@prisma/client";

import { recordOutcomeOnDecision } from "../app/lib/agent/decisions.server";
import { evaluateFollowup } from "../app/lib/agent/evaluator.server";
import {
  listDueFollowupsAcrossStores,
  type FollowupRow,
} from "../app/lib/agent/followups.server";
import { decrypt } from "../app/lib/security/encrypt.server";
import type { ShopifyAdmin } from "../app/lib/shopify/graphql-client.server";

// V3.2 — Phase 3 Autonomous Reasoning Loop. Daily cron runner. Invoked by
// .github/workflows/followup-evaluator.yml.
//
// Required env: DATABASE_URL (Railway Postgres), ENCRYPTION_KEY (for
// Store.accessToken decrypt), GEMINI_API_KEY (for Flash-Lite narrative).
//
// What it does:
//   1. Pulls ActionFollowup rows where status='PENDING' AND dueAt<=now.
//   2. Groups by storeId.
//   3. For each store: decrypts the Shopify access token, builds a
//      minimal ShopifyAdmin client, and walks each followup.
//   4. evaluateFollowup → "evaluated" / "abandoned" → write Insight,
//      flip status, set insightId.
//   5. evaluateFollowup → "not_yet_due" → leave the row for tomorrow.
//
// Exit code 0 on success (zero-followup runs are also success).
// Exit code 1 on fatal failure (DB unreachable, etc.). Per-followup
// errors are logged + skipped — one bad row doesn't fail the run.

const SHOPIFY_API_VERSION = "2026-04";

const prisma = new PrismaClient();

function buildAdminClientForStore(opts: {
  shopDomain: string;
  accessToken: string;
}): ShopifyAdmin {
  return {
    async graphql(query, options) {
      const url = `https://${opts.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
      return fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": opts.accessToken,
        },
        body: JSON.stringify({
          query,
          variables: options?.variables ?? {},
        }),
      });
    },
  };
}

async function processFollowup(opts: {
  followup: FollowupRow;
  admin: ShopifyAdmin;
  now: Date;
}): Promise<"evaluated" | "abandoned" | "not_yet_due" | "error"> {
  const { followup, admin, now } = opts;
  try {
    const outcome = await evaluateFollowup({ admin, followup, now });
    if (outcome.kind === "not_yet_due") {
      console.log(
        `[evaluator] ${followup.id} not_yet_due — ${outcome.reason}`,
      );
      return "not_yet_due";
    }

    const insight = await prisma.insight.create({
      data: {
        storeId: followup.storeId,
        followupId: followup.id,
        category: outcome.insight.category,
        title: outcome.insight.title,
        body: outcome.insight.body,
        verdict: outcome.insight.verdict,
        confidence: outcome.insight.confidence,
        significanceP: outcome.insight.significanceP,
      },
    });

    await prisma.actionFollowup.update({
      where: { id: followup.id },
      data: {
        status: outcome.kind === "evaluated" ? "EVALUATED" : "ABANDONED",
        evaluatedAt: now,
        insightId: insight.id,
      },
    });

    // V4.1 — fill in the linked Decision's actualOutcome so retrieval
    // surfaces "we tried X, here's what happened" instead of just
    // "we tried X." Best-effort: failures here don't block the
    // evaluator run since the Insight is the user-visible thing.
    try {
      await recordOutcomeOnDecision({
        followupId: followup.id,
        actualOutcome: `${outcome.insight.verdict}: ${outcome.insight.title}. ${outcome.insight.body}`,
      });
    } catch (err) {
      console.warn(
        `[evaluator] ${followup.id} decision update failed (non-fatal)`,
        err,
      );
    }

    console.log(
      `[evaluator] ${followup.id} → ${outcome.kind} (${outcome.insight.verdict}, conf ${outcome.insight.confidence.toFixed(2)})`,
    );
    return outcome.kind;
  } catch (err) {
    console.error(`[evaluator] ${followup.id} failed`, err);
    return "error";
  }
}

async function main(): Promise<void> {
  const now = new Date();
  console.log(`[evaluator] starting run at ${now.toISOString()}`);

  const followups = await listDueFollowupsAcrossStores(now, 500);
  console.log(`[evaluator] ${followups.length} due followup(s) to consider`);
  if (followups.length === 0) return;

  // Group by store so we build one admin client per store.
  const byStore = new Map<string, FollowupRow[]>();
  for (const f of followups) {
    const arr = byStore.get(f.storeId) ?? [];
    arr.push(f);
    byStore.set(f.storeId, arr);
  }

  const counts = {
    evaluated: 0,
    abandoned: 0,
    not_yet_due: 0,
    error: 0,
    skipped: 0,
  };

  for (const [storeId, batch] of byStore) {
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) {
      console.warn(
        `[evaluator] store ${storeId} no longer exists; skipping ${batch.length} followups`,
      );
      counts.skipped += batch.length;
      continue;
    }
    if (store.uninstalledAt) {
      console.log(
        `[evaluator] store ${storeId} uninstalled; skipping ${batch.length} followups`,
      );
      counts.skipped += batch.length;
      continue;
    }

    let accessToken: string;
    try {
      accessToken = decrypt(store.accessToken);
    } catch (err) {
      console.error(`[evaluator] decrypt failed for ${storeId}`, err);
      counts.skipped += batch.length;
      continue;
    }

    const admin = buildAdminClientForStore({
      shopDomain: store.shopDomain,
      accessToken,
    });

    for (const followup of batch) {
      const outcome = await processFollowup({ followup, admin, now });
      counts[outcome] += 1;
    }
  }

  console.log(
    `[evaluator] done — evaluated:${counts.evaluated} abandoned:${counts.abandoned} not_yet_due:${counts.not_yet_due} skipped:${counts.skipped} error:${counts.error}`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[evaluator] fatal", err);
    await prisma.$disconnect();
    process.exit(1);
  });
