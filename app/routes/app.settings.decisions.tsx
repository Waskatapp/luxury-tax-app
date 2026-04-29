import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Modal,
  Page,
  Select,
  Text,
} from "@shopify/polaris";

import { requireStoreAccess } from "../lib/auth.server";
import {
  listAllDecisions,
  type DecisionCategory,
  type DecisionRow,
} from "../lib/agent/decisions.server";

const PAGE_SIZE = 100;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);
  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const all = await listAllDecisions(store.id, PAGE_SIZE);
  const filtered =
    category && category !== "ALL"
      ? all.filter((d) => d.category === category)
      : all;
  return {
    decisions: filtered,
    selectedCategory: category ?? "ALL",
  };
};

const CATEGORY_LABEL: Record<DecisionCategory, string> = {
  conversion_rate: "Conversion rate",
  revenue: "Revenue",
  sessions: "Sessions",
  units_sold: "Units sold",
  aov: "AOV",
  inventory_at_risk: "Inventory at risk",
  strategic: "Strategic",
};

function categoryLabel(c: string): string {
  return CATEGORY_LABEL[c as DecisionCategory] ?? c;
}

function statusBadge(d: DecisionRow): React.ReactNode {
  if (d.actualOutcome !== null) {
    return <Badge tone="success">Outcome recorded</Badge>;
  }
  if (d.embeddingPending) {
    return <Badge tone="info">Embedding pending</Badge>;
  }
  return <Badge tone="attention">Awaiting evaluation</Badge>;
}

export default function DecisionsPage() {
  const { decisions, selectedCategory } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeRow, setActiveRow] = useState<DecisionRow | null>(null);

  const onCategoryChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "ALL") next.delete("category");
    else next.set("category", value);
    setSearchParams(next);
  };

  const filterOptions = [
    { label: "All categories", value: "ALL" },
    ...Object.entries(CATEGORY_LABEL).map(([value, label]) => ({
      label,
      value,
    })),
  ];

  const rows = decisions.map((d) => [
    new Date(d.createdAt).toLocaleDateString(),
    <Badge key={`cat-${d.id}`} tone="info">
      {categoryLabel(d.category)}
    </Badge>,
    <Text key={`hyp-${d.id}`} as="span">
      {d.hypothesis.length > 120
        ? d.hypothesis.slice(0, 120) + "…"
        : d.hypothesis}
    </Text>,
    statusBadge(d),
    <Button
      key={`view-${d.id}`}
      variant="plain"
      onClick={() => setActiveRow(d)}
    >
      View
    </Button>,
  ]);

  return (
    <Page
      title="Decision journal"
      subtitle="Every commitment your Copilot made to evaluate an outcome. Filled in by the offline evaluator when the followup matures."
      fullWidth
    >
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Box width="240px">
                <Select
                  label="Category filter"
                  labelHidden
                  options={filterOptions}
                  value={selectedCategory}
                  onChange={onCategoryChange}
                />
              </Box>
              <Text as="span" variant="bodySm" tone="subdued">
                {decisions.length} decision{decisions.length === 1 ? "" : "s"}
              </Text>
            </InlineStack>

            {decisions.length === 0 ? (
              <EmptyState
                heading="No decisions yet"
                image=""
              >
                <p>
                  Decisions are created automatically when your Copilot calls{" "}
                  <code>propose_followup</code> after an outcome-bearing
                  change (a price update, description rewrite, status flip,
                  or discount). The journal grows naturally as you work.
                </p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={[
                  "Created",
                  "Category",
                  "Hypothesis",
                  "Status",
                  "Detail",
                ]}
                rows={rows}
              />
            )}
          </BlockStack>
        </Card>

        <Text as="p" variant="bodySm" tone="subdued">
          The Copilot retrieves semantically-similar past decisions when you
          start a new conversation. Reviewing this list is optional —
          maintenance is automatic.
        </Text>
      </BlockStack>

      {activeRow ? (
        <DecisionDetailModal
          decision={activeRow}
          onClose={() => setActiveRow(null)}
        />
      ) : null}
    </Page>
  );
}

function DecisionDetailModal({
  decision,
  onClose,
}: {
  decision: DecisionRow;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={`${categoryLabel(decision.category)} decision`}
      primaryAction={{ content: "Close", onAction: onClose }}
      size="large"
    >
      <Modal.Section>
        <BlockStack gap="300">
          <Text as="p" variant="bodySm" tone="subdued">
            {new Date(decision.createdAt).toLocaleString()}
            {decision.productId ? ` · ${decision.productId}` : ""}
          </Text>
          <Box>
            <Text as="h3" variant="headingSm">
              Hypothesis
            </Text>
            <Text as="p">{decision.hypothesis}</Text>
          </Box>
          <Box>
            <Text as="h3" variant="headingSm">
              Expected outcome
            </Text>
            <Text as="p">{decision.expectedOutcome}</Text>
          </Box>
          {decision.actualOutcome ? (
            <Box>
              <Text as="h3" variant="headingSm">
                Actual outcome
              </Text>
              <Text as="p">{decision.actualOutcome}</Text>
            </Box>
          ) : (
            <Box>
              <Text as="p" tone="subdued" variant="bodySm">
                Outcome will be filled in when the linked follow-up matures.
              </Text>
            </Box>
          )}
          {decision.lesson ? (
            <Box>
              <Text as="h3" variant="headingSm">
                Lesson
              </Text>
              <Text as="p">{decision.lesson}</Text>
            </Box>
          ) : null}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
