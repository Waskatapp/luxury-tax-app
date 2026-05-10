import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  BlockStack,
  Box,
  Card,
  EmptyState,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { UserRole } from "@prisma/client";

import { requireStoreAccess } from "../lib/auth.server";
import prisma from "../db.server";
import type { ContentBlock } from "../lib/agent/translate.server";

// Phase Ab Round Ab-A — operator UI for the Abandonment Brain.
// STORE_OWNER-gated. Shows:
//   - The latest nightly clustering run summary
//   - Each cluster (size desc) with sample messages, common tools,
//     dominant outcome
//
// Round Ab-B will add hypothesis text per cluster + accept/reject.
// Round Ab-C will add lifecycle status + timeline view.
// Round Ab-D will add cross-file findings.
//
// For Ab-A this is intentionally read-only and observational. The
// operator's job here is to LOOK at the clusters and recognize
// patterns; no actions yet.

const SAMPLE_TEXT_TRUNC = 140;

type SerializedSample = {
  turnSignalId: string;
  userMessage: string;
  outcome: string;
  conversationId: string;
};

type SerializedCluster = {
  id: string;
  size: number;
  dominantOutcome: string;
  commonTools: string[];
  commonRouterReason: string | null;
  samples: SerializedSample[];
};

type SerializedRun = {
  id: string;
  runAt: string;
  totalAbandonedTurns: number;
  totalClarifiedTurns: number;
  clusterCount: number;
  durationMs: number;
  clusters: SerializedCluster[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request, UserRole.STORE_OWNER);

  // Latest run for this store.
  const latestRun = await prisma.clusterRun.findFirst({
    where: { storeId: store.id },
    orderBy: { runAt: "desc" },
    include: {
      clusters: {
        orderBy: { size: "desc" },
      },
    },
  });

  if (latestRun === null) {
    return { run: null };
  }

  // Pull sample TurnSignal + their user messages for inline display.
  const allSampleTurnIds = latestRun.clusters.flatMap((c) => c.sampleTurnIds);
  const sampleTurnSignals =
    allSampleTurnIds.length > 0
      ? await prisma.turnSignal.findMany({
          where: { id: { in: allSampleTurnIds }, storeId: store.id },
          select: {
            id: true,
            conversationId: true,
            outcome: true,
            message: { select: { createdAt: true } },
          },
        })
      : [];

  // Pull user messages for those conversations to find the user text
  // that prompted each sample turn. Same pairing logic as in cluster.server.ts.
  const conversationIds = Array.from(
    new Set(sampleTurnSignals.map((ts) => ts.conversationId)),
  );
  const userMessages =
    conversationIds.length > 0
      ? await prisma.message.findMany({
          where: {
            conversationId: { in: conversationIds },
            role: "user",
          },
          select: { conversationId: true, content: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        })
      : [];

  const userMsgsByConv = new Map<
    string,
    Array<{ content: unknown; createdAt: Date }>
  >();
  for (const m of userMessages) {
    const arr = userMsgsByConv.get(m.conversationId) ?? [];
    arr.push({ content: m.content, createdAt: m.createdAt });
    userMsgsByConv.set(m.conversationId, arr);
  }

  const userTextByTurnSignalId = new Map<string, string>();
  for (const ts of sampleTurnSignals) {
    const userMsgs = userMsgsByConv.get(ts.conversationId) ?? [];
    let bestText: string | null = null;
    for (const um of userMsgs) {
      if (um.createdAt >= ts.message.createdAt) break;
      const text = extractFirstText(um.content);
      if (text !== null) bestText = text;
    }
    if (bestText !== null) {
      userTextByTurnSignalId.set(ts.id, bestText);
    }
  }

  const tsByID = new Map(sampleTurnSignals.map((ts) => [ts.id, ts]));

  const run: SerializedRun = {
    id: latestRun.id,
    runAt: latestRun.runAt.toISOString(),
    totalAbandonedTurns: latestRun.totalAbandonedTurns,
    totalClarifiedTurns: latestRun.totalClarifiedTurns,
    clusterCount: latestRun.clusterCount,
    durationMs: latestRun.durationMs,
    clusters: latestRun.clusters.map((c) => ({
      id: c.id,
      size: c.size,
      dominantOutcome: c.dominantOutcome,
      commonTools: c.commonTools,
      commonRouterReason: c.commonRouterReason,
      samples: c.sampleTurnIds
        .map((id): SerializedSample | null => {
          const ts = tsByID.get(id);
          if (ts === undefined) return null;
          const text = userTextByTurnSignalId.get(id) ?? "(text unavailable)";
          return {
            turnSignalId: id,
            userMessage:
              text.length > SAMPLE_TEXT_TRUNC
                ? text.slice(0, SAMPLE_TEXT_TRUNC) + "…"
                : text,
            outcome: ts.outcome,
            conversationId: ts.conversationId,
          };
        })
        .filter((x): x is SerializedSample => x !== null),
    })),
  };

  return { run };
};

export const headers: HeadersFunction = (args) =>
  boundary.headers(args);

function extractFirstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content as ContentBlock[]) {
    if (block?.type === "text" && typeof block.text === "string") {
      return block.text.trim();
    }
  }
  return null;
}

function formatRunAt(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function outcomeBadge(outcome: string) {
  if (outcome === "abandoned") return <Badge tone="critical">abandoned</Badge>;
  if (outcome === "clarified") return <Badge tone="warning">clarified</Badge>;
  return <Badge>{outcome}</Badge>;
}

export default function AbandonmentDiagnosesPage() {
  const { run } = useLoaderData<typeof loader>();

  if (run === null) {
    return (
      <Page title="Abandonment diagnoses">
        <Card>
          <EmptyState heading="No clustering runs yet" image="">
            <p>
              The Abandonment Brain runs nightly via{" "}
              <code>.github/workflows/abandonment-brain.yml</code>. Trigger
              manually with <code>npm run run:ab-brain</code> or{" "}
              <code>workflow_dispatch</code> from the Actions tab. The first
              run needs at least 3 abandoned/clarified turns in the last 30
              days to produce a cluster.
            </p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const turnsScanned = run.totalAbandonedTurns + run.totalClarifiedTurns;

  return (
    <Page title="Abandonment diagnoses">
      <BlockStack gap="400">
        <Card>
          <Box padding="400">
            <BlockStack gap="200">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">
                  Latest run
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {formatRunAt(run.runAt)} · {formatDuration(run.durationMs)}
                </Text>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Operator-only. The brain reads the last 30 days of
                abandoned/clarified turns, clusters them by user-message
                similarity (DBSCAN, eps=0.15, minPts=3), and surfaces
                recurring failure patterns. Hypothesis + lifecycle land in
                the next round.
              </Text>
              <InlineStack gap="400">
                <Text as="span" variant="bodyMd">
                  <strong>{turnsScanned}</strong> turns scanned
                </Text>
                <Text as="span" variant="bodyMd">
                  <strong>{run.totalAbandonedTurns}</strong> abandoned
                </Text>
                <Text as="span" variant="bodyMd">
                  <strong>{run.totalClarifiedTurns}</strong> clarified
                </Text>
                <Text as="span" variant="bodyMd">
                  <strong>{run.clusterCount}</strong>{" "}
                  cluster{run.clusterCount === 1 ? "" : "s"} found
                </Text>
              </InlineStack>
            </BlockStack>
          </Box>
        </Card>

        {run.clusters.length === 0 && (
          <Card>
            <Box padding="400">
              <Text as="p" variant="bodyMd">
                No recurring patterns found this run. Either there aren't
                enough abandoned/clarified turns yet (need ≥ 3 with similar
                user messages), or the failures are scattered across diverse
                phrasings — let it accumulate for a few more days.
              </Text>
            </Box>
          </Card>
        )}

        {run.clusters.map((c, i) => (
          <Card key={c.id}>
            <Box padding="400">
              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <InlineStack gap="200" align="start">
                    <Text variant="headingSm" as="h3">
                      Cluster {i + 1}
                    </Text>
                    <Badge tone="info">{`${c.size} turn${c.size === 1 ? "" : "s"}`}</Badge>
                    {outcomeBadge(c.dominantOutcome)}
                  </InlineStack>
                </InlineStack>
                {c.commonTools.length > 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Common tools: {c.commonTools.join(", ")}
                  </Text>
                )}
                {c.commonRouterReason !== null && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Common router reason: <code>{c.commonRouterReason}</code>
                  </Text>
                )}
                <Box paddingBlockStart="200">
                  <Text as="p" variant="bodySm">
                    <strong>Sample messages:</strong>
                  </Text>
                  <BlockStack gap="100">
                    {c.samples.length === 0 ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        (no samples available)
                      </Text>
                    ) : (
                      c.samples.map((s) => (
                        <Box
                          key={s.turnSignalId}
                          padding="200"
                          borderColor="border"
                          borderWidth="025"
                          borderRadius="100"
                          background="bg-surface-secondary"
                        >
                          <Text as="p" variant="bodySm">
                            "{s.userMessage}"
                          </Text>
                        </Box>
                      ))
                    )}
                  </BlockStack>
                </Box>
              </BlockStack>
            </Box>
          </Card>
        ))}
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error;
}
