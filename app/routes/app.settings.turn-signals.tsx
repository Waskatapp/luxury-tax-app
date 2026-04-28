import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  BlockStack,
  Box,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";

const PAGE_SIZE = 200;
const ROLLUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000; // last 30 days

type Row = {
  id: string;
  conversationId: string;
  outcome: string;
  toolCalls: number;
  hadWriteTool: boolean;
  hadClarification: boolean;
  latencyMs: number | null;
  modelUsed: string | null;
  createdAt: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);

  const rows = await prisma.turnSignal.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
    select: {
      id: true,
      conversationId: true,
      outcome: true,
      toolCalls: true,
      hadWriteTool: true,
      hadClarification: true,
      latencyMs: true,
      modelUsed: true,
      createdAt: true,
    },
  });

  // 30-day outcome distribution. One groupBy keeps it cheap.
  const since = new Date(Date.now() - ROLLUP_WINDOW_MS);
  const recent = await prisma.turnSignal.groupBy({
    by: ["outcome"],
    where: { storeId: store.id, createdAt: { gte: since } },
    _count: { _all: true },
  });

  const distribution: Record<string, number> = {};
  let total = 0;
  for (const r of recent) {
    distribution[r.outcome] = r._count._all;
    total += r._count._all;
  }

  return {
    entries: rows.map<Row>((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      outcome: r.outcome,
      toolCalls: r.toolCalls,
      hadWriteTool: r.hadWriteTool,
      hadClarification: r.hadClarification,
      latencyMs: r.latencyMs,
      modelUsed: r.modelUsed,
      createdAt: r.createdAt.toISOString(),
    })),
    distribution,
    total,
  };
};

function outcomeTone(
  outcome: string,
): "success" | "info" | "attention" | "critical" | "warning" {
  switch (outcome) {
    case "approved":
      return "success";
    case "rejected":
      return "critical";
    case "clarified":
      return "warning";
    case "rephrased":
      return "attention";
    case "abandoned":
      return "attention";
    case "informational":
    default:
      return "info";
  }
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

export default function TurnSignalsPage() {
  const { entries, distribution, total } = useLoaderData<typeof loader>();

  // Stable display order of outcome buckets in the rollup line — matches
  // the conceptual reading order (good outcomes first, learning signals
  // next, drop-offs last).
  const outcomeOrder: string[] = [
    "approved",
    "informational",
    "clarified",
    "rephrased",
    "rejected",
    "abandoned",
  ];

  const tableRows = entries.map((e) => [
    new Date(e.createdAt).toLocaleString(),
    <Badge key={`o-${e.id}`} tone={outcomeTone(e.outcome)}>
      {e.outcome}
    </Badge>,
    String(e.toolCalls),
    <InlineStack key={`f-${e.id}`} gap="100">
      {e.hadWriteTool ? <Badge tone="info">write</Badge> : null}
      {e.hadClarification ? <Badge tone="warning">clarify</Badge> : null}
    </InlineStack>,
    e.latencyMs == null ? "—" : `${e.latencyMs} ms`,
    e.modelUsed ?? "—",
    <Link key={`c-${e.id}`} to={`/app/copilot?cid=${e.conversationId}`}>
      Open
    </Link>,
  ]);

  return (
    <Page
      title="CEO turn signals"
      subtitle="Outcome of every assistant turn — what the Copilot is learning from your replies."
      fullWidth
    >
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Last 30 days
            </Text>
            {total === 0 ? (
              <Text as="p" tone="subdued" variant="bodySm">
                No turns recorded yet in the last 30 days.
              </Text>
            ) : (
              <InlineStack gap="300" wrap>
                {outcomeOrder
                  .filter((o) => (distribution[o] ?? 0) > 0)
                  .map((o) => (
                    <Box
                      key={o}
                      padding="200"
                      background="bg-surface-secondary"
                      borderRadius="200"
                    >
                      <InlineStack gap="200" blockAlign="center">
                        <Badge tone={outcomeTone(o)}>{o}</Badge>
                        <Text as="span" variant="bodySm" fontWeight="semibold">
                          {pct(distribution[o] ?? 0, total)}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          ({distribution[o] ?? 0})
                        </Text>
                      </InlineStack>
                    </Box>
                  ))}
                <Text as="span" variant="bodySm" tone="subdued">
                  total: {total}
                </Text>
              </InlineStack>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Recent turns
            </Text>
            {entries.length === 0 ? (
              <EmptyState heading="No turns recorded yet" image="">
                <p>
                  Each completed assistant turn gets one row here. Start a
                  conversation in the <Link to="/app/copilot">Copilot</Link>{" "}
                  and it will appear shortly after.
                </p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "numeric",
                  "text",
                  "text",
                  "text",
                  "text",
                ]}
                headings={[
                  "When",
                  "Outcome",
                  "Tools",
                  "Flags",
                  "Latency",
                  "Model",
                  "Conversation",
                ]}
                rows={tableRows}
              />
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              Showing the most recent {Math.min(entries.length, PAGE_SIZE)}{" "}
              turns. Outcomes can be re-classified after the fact —
              "informational" turns whose merchant rephrases within 60s
              become "rephrased"; idle write turns older than 24h become
              "abandoned".
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
