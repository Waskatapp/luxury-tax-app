import { useState } from "react";
import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useLoaderData, useSearchParams } from "react-router";
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

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";

const PAGE_SIZE = 20;

type AuditRow = {
  id: string;
  action: string;
  toolName: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const action = url.searchParams.get("action");

  const where = {
    storeId: store.id,
    ...(action && action !== "ALL" ? { action } : {}),
  };

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      action: true,
      toolName: true,
      before: true,
      after: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  // Distinct action values for the filter dropdown — small list, fine to query.
  const distinctActions = await prisma.auditLog.findMany({
    where: { storeId: store.id },
    distinct: ["action"],
    select: { action: true },
    orderBy: { action: "asc" },
  });

  return {
    entries: page.map<AuditRow>((r) => ({
      id: r.id,
      action: r.action,
      toolName: r.toolName,
      before: r.before,
      after: r.after,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
    actions: distinctActions.map((d) => d.action),
    selectedAction: action ?? "ALL",
  };
};

function actionTone(action: string): "success" | "info" | "attention" | "critical" {
  if (action === "app_uninstalled") return "critical";
  if (action === "memory_deleted") return "attention";
  if (action === "memory_saved") return "info";
  if (action.startsWith("scopes_")) return "info";
  if (action.endsWith("_rejected")) return "attention";
  return "success";
}

export default function AuditPage() {
  const { entries, nextCursor, actions, selectedAction } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeRow, setActiveRow] = useState<AuditRow | null>(null);

  const onActionChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "ALL") next.delete("action");
    else next.set("action", value);
    next.delete("cursor"); // reset pagination when filter changes
    setSearchParams(next);
  };

  const onNextPage = () => {
    if (!nextCursor) return;
    const next = new URLSearchParams(searchParams);
    next.set("cursor", nextCursor);
    setSearchParams(next);
  };

  const onFirstPage = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("cursor");
    setSearchParams(next);
  };

  const cursor = searchParams.get("cursor");

  const filterOptions = [
    { label: "All actions", value: "ALL" },
    ...actions.map((a) => ({ label: a, value: a })),
  ];

  const rows = entries.map((e) => [
    new Date(e.createdAt).toLocaleString(),
    <Badge key={`b-${e.id}`} tone={actionTone(e.action)}>
      {e.action}
    </Badge>,
    e.toolName ?? "—",
    <Button key={`d-${e.id}`} variant="plain" onClick={() => setActiveRow(e)}>
      View diff
    </Button>,
  ]);

  return (
    <Page title="Audit log" fullWidth>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack gap="300" align="space-between" blockAlign="center">
              <Box width="240px">
                <Select
                  label="Action filter"
                  labelHidden
                  options={filterOptions}
                  value={selectedAction}
                  onChange={onActionChange}
                />
              </Box>
              <ButtonGroup>
                <Button onClick={onFirstPage} disabled={!cursor}>
                  ← First page
                </Button>
                <Button onClick={onNextPage} disabled={!nextCursor}>
                  Next page →
                </Button>
              </ButtonGroup>
            </InlineStack>

            {entries.length === 0 ? (
              <EmptyState
                heading="No audit entries yet"
                image=""
              >
                <p>
                  Every approved write tool, rejection, and webhook lifecycle
                  event creates a row here. Start by approving a price change
                  or product update from the{" "}
                  <Link to="/app/copilot">Copilot</Link>.
                </p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["When", "Action", "Tool", "Diff"]}
                rows={rows}
              />
            )}
          </BlockStack>
        </Card>

        <Text as="p" variant="bodySm" tone="subdued">
          Audit entries are immutable and never deleted (CLAUDE.md Rule #10).
          Page size: {PAGE_SIZE}.
        </Text>
      </BlockStack>

      {activeRow ? (
        <DiffModal entry={activeRow} onClose={() => setActiveRow(null)} />
      ) : null}
    </Page>
  );
}

function DiffModal({
  entry,
  onClose,
}: {
  entry: AuditRow;
  onClose: () => void;
}) {
  const beforeText = formatJson(entry.before);
  const afterText = formatJson(entry.after);

  return (
    <Modal
      open
      onClose={onClose}
      title={`${entry.action}${entry.toolName ? " — " + entry.toolName : ""}`}
      primaryAction={{ content: "Close", onAction: onClose }}
      size="large"
    >
      <Modal.Section>
        <Text as="p" variant="bodySm" tone="subdued">
          {new Date(entry.createdAt).toLocaleString()}
        </Text>
      </Modal.Section>
      <Modal.Section>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Before
          </Text>
          <CodeBlock text={beforeText} />
          <Text as="h3" variant="headingSm">
            After
          </Text>
          <CodeBlock text={afterText} />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <Box
      padding="300"
      background="bg-surface-secondary"
      borderRadius="200"
      borderColor="border"
      borderWidth="025"
    >
      <pre
        style={{
          margin: 0,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: 12,
          lineHeight: 1.4,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text}
      </pre>
    </Box>
  );
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
