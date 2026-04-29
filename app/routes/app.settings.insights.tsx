import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Modal,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { z } from "zod";

import { requireStoreAccess } from "../lib/auth.server";
import {
  dismissInsight,
  listAllInsights,
  unsurfaceInsight,
  type InsightCategory,
  type InsightRow,
  type Verdict,
} from "../lib/agent/insights.server";

const PAGE_SIZE = 50;

type InsightDisplay = InsightRow;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);
  const url = new URL(request.url);
  const verdict = url.searchParams.get("verdict");
  const all = await listAllInsights(store.id, PAGE_SIZE);
  const filtered =
    verdict && verdict !== "ALL" ? all.filter((i) => i.verdict === verdict) : all;
  return {
    insights: filtered,
    selectedVerdict: verdict ?? "ALL",
  };
};

const ActionInput = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("dismiss"), id: z.string().min(1) }),
  z.object({ intent: z.literal("unsurface"), id: z.string().min(1) }),
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { store } = await requireStoreAccess(request);
  const fd = await request.formData();
  const parsed = ActionInput.safeParse(Object.fromEntries(fd));
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.message },
      { status: 400 },
    );
  }
  if (parsed.data.intent === "dismiss") {
    const ok = await dismissInsight(store.id, parsed.data.id);
    return Response.json({ ok });
  }
  const ok = await unsurfaceInsight(store.id, parsed.data.id);
  return Response.json({ ok });
};

const VERDICT_LABEL: Record<Verdict, string> = {
  improved: "Improved",
  worsened: "Worsened",
  inconclusive: "Inconclusive",
  insufficient_data: "Insufficient data",
};

const CATEGORY_LABEL: Record<InsightCategory, string> = {
  outcome_postmortem: "Post-mortem",
  lesson: "Lesson",
  anomaly: "Anomaly",
  pattern: "Pattern",
  theme: "Theme",
};

function verdictTone(
  v: Verdict,
): "success" | "critical" | "info" | undefined {
  if (v === "improved") return "success";
  if (v === "worsened") return "critical";
  if (v === "inconclusive") return undefined; // neutral badge
  return "info";
}

export default function InsightsSettingsPage() {
  const { insights, selectedVerdict } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeRow, setActiveRow] = useState<InsightDisplay | null>(null);

  const submitting = fetcher.state !== "idle";

  const onVerdictChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "ALL") next.delete("verdict");
    else next.set("verdict", value);
    setSearchParams(next);
  };

  const handleDismiss = (id: string) => {
    fetcher.submit({ intent: "dismiss", id }, { method: "post" });
  };

  const handleUnsurface = (id: string) => {
    fetcher.submit({ intent: "unsurface", id }, { method: "post" });
  };

  const filterOptions = [
    { label: "All verdicts", value: "ALL" },
    { label: "Improved", value: "improved" },
    { label: "Worsened", value: "worsened" },
    { label: "Inconclusive", value: "inconclusive" },
    { label: "Insufficient data", value: "insufficient_data" },
  ];

  const rows = insights.map((i) => {
    const surfacedLabel = i.surfacedAt
      ? new Date(i.surfacedAt).toLocaleDateString()
      : "—";
    return [
      new Date(i.createdAt).toLocaleDateString(),
      <Text key={`cat-${i.id}`} as="span">
        {CATEGORY_LABEL[i.category] ?? i.category}
      </Text>,
      <Badge key={`v-${i.id}`} tone={verdictTone(i.verdict)}>
        {VERDICT_LABEL[i.verdict]}
      </Badge>,
      i.confidence.toFixed(2),
      surfacedLabel,
      <Button key={`view-${i.id}`} variant="plain" onClick={() => setActiveRow(i)}>
        {i.title.length > 60 ? `${i.title.slice(0, 60)}…` : i.title}
      </Button>,
      <ButtonGroup key={`act-${i.id}`}>
        {i.dismissedAt ? (
          <Text as="span" tone="subdued">
            dismissed
          </Text>
        ) : (
          <>
            {i.surfacedAt ? (
              <Button
                onClick={() => handleUnsurface(i.id)}
                disabled={submitting}
              >
                Re-surface
              </Button>
            ) : null}
            <Button
              tone="critical"
              variant="plain"
              onClick={() => handleDismiss(i.id)}
              disabled={submitting}
            >
              Dismiss
            </Button>
          </>
        )}
      </ButtonGroup>,
    ];
  });

  return (
    <Page
      title="CEO insights"
      subtitle="Post-mortems and lessons your offline brain wrote while you were away."
      fullWidth
    >
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack gap="300" align="space-between" blockAlign="center">
              <Box width="240px">
                <Select
                  label="Verdict filter"
                  labelHidden
                  options={filterOptions}
                  value={selectedVerdict}
                  onChange={onVerdictChange}
                />
              </Box>
              <Text as="p" variant="bodySm" tone="subdued">
                Showing {insights.length} insight{insights.length === 1 ? "" : "s"}.
              </Text>
            </InlineStack>

            {insights.length === 0 ? (
              <EmptyState heading="No insights yet" image="">
                <p>
                  When you queue a follow-up after a meaningful change (a
                  description rewrite, a price change, a discount), the offline
                  evaluator runs daily and writes a post-mortem here when the
                  data is in. Keep using the Copilot — insights show up
                  automatically.
                </p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "numeric",
                  "text",
                  "text",
                  "text",
                ]}
                headings={[
                  "Created",
                  "Category",
                  "Verdict",
                  "Confidence",
                  "Surfaced",
                  "Title",
                  "Actions",
                ]}
                rows={rows}
              />
            )}
          </BlockStack>
        </Card>

        <Text as="p" variant="bodySm" tone="subdued">
          Insights are surfaced into the Copilot's opening on a fresh
          conversation, capped at 2 unique surfaces per UTC day. Dismissed
          entries never surface again.
        </Text>
      </BlockStack>

      {activeRow ? (
        <InsightModal row={activeRow} onClose={() => setActiveRow(null)} />
      ) : null}
    </Page>
  );
}

function InsightModal({
  row,
  onClose,
}: {
  row: InsightDisplay;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={row.title}
      primaryAction={{ content: "Close", onAction: onClose }}
      size="large"
    >
      <Modal.Section>
        <BlockStack gap="200">
          <InlineStack gap="200" blockAlign="center">
            <Badge tone={verdictTone(row.verdict)}>
              {VERDICT_LABEL[row.verdict]}
            </Badge>
            <Text as="span" tone="subdued" variant="bodySm">
              Confidence {row.confidence.toFixed(2)}
              {row.significanceP !== null
                ? ` · p = ${row.significanceP.toFixed(3)}`
                : ""}
              {" · "}
              {new Date(row.createdAt).toLocaleString()}
            </Text>
          </InlineStack>
          <Text as="p">{row.body}</Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
