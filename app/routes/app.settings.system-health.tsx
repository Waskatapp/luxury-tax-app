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
  Checkbox,
  DataTable,
  EmptyState,
  InlineStack,
  Modal,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { UserRole } from "@prisma/client";
import { z } from "zod";

import { requireStoreAccess } from "../lib/auth.server";
import {
  acknowledgeFinding,
  listFindings,
  reopenFinding,
  snoozeFinding,
  type FindingRow,
  type Severity,
} from "../lib/agent/system-health.server";

// V6.6 — Phase 6.6 IT Diagnostic settings page. Operator-only — gated to
// STORE_OWNER. Shows SystemHealthFinding rows written by the daily cron's
// diagnostic pass. NEVER injected into the merchant's chat.

const PAGE_SIZE = 100;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request, UserRole.STORE_OWNER);
  const url = new URL(request.url);
  const severity = url.searchParams.get("severity") ?? "ALL";
  const showAcknowledged = url.searchParams.get("showAcknowledged") === "1";
  const all = await listFindings(store.id, {
    includeAcknowledged: showAcknowledged,
    limit: PAGE_SIZE,
  });
  const filtered =
    severity === "ALL"
      ? all
      : all.filter((f) => f.severity === severity);
  return {
    findings: filtered,
    selectedSeverity: severity,
    showAcknowledged,
  };
};

const ActionInput = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("acknowledge"), id: z.string().min(1) }),
  z.object({ intent: z.literal("snooze7"), id: z.string().min(1) }),
  z.object({ intent: z.literal("snooze30"), id: z.string().min(1) }),
  z.object({ intent: z.literal("reopen"), id: z.string().min(1) }),
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { store, session } = await requireStoreAccess(
    request,
    UserRole.STORE_OWNER,
  );
  const fd = await request.formData();
  const parsed = ActionInput.safeParse(Object.fromEntries(fd));
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.message },
      { status: 400 },
    );
  }

  const userEmail =
    session.onlineAccessInfo?.associated_user?.email ?? store.ownerEmail ?? null;

  if (parsed.data.intent === "acknowledge") {
    const ok = await acknowledgeFinding(store.id, parsed.data.id, userEmail);
    return Response.json({ ok });
  }
  if (parsed.data.intent === "snooze7") {
    const ok = await snoozeFinding(store.id, parsed.data.id, 7);
    return Response.json({ ok });
  }
  if (parsed.data.intent === "snooze30") {
    const ok = await snoozeFinding(store.id, parsed.data.id, 30);
    return Response.json({ ok });
  }
  const ok = await reopenFinding(store.id, parsed.data.id);
  return Response.json({ ok });
};

const SEVERITY_LABEL: Record<Severity, string> = {
  info: "Info",
  warn: "Warn",
  critical: "Critical",
};

function severityTone(
  s: Severity,
): "info" | "attention" | "critical" | undefined {
  if (s === "info") return "info";
  if (s === "warn") return "attention";
  return "critical";
}

function statusLabel(f: FindingRow, now: number): string {
  if (f.acknowledgedAt) {
    return `Acknowledged${f.acknowledgedBy ? ` by ${f.acknowledgedBy}` : ""}`;
  }
  if (f.snoozedUntil) {
    const t = new Date(f.snoozedUntil).getTime();
    if (t > now) {
      return `Snoozed until ${new Date(f.snoozedUntil).toLocaleDateString()}`;
    }
  }
  return "Open";
}

export default function SystemHealthSettingsPage() {
  const { findings, selectedSeverity, showAcknowledged } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeRow, setActiveRow] = useState<FindingRow | null>(null);

  const submitting = fetcher.state !== "idle";
  const now = Date.now();

  const onSeverityChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "ALL") next.delete("severity");
    else next.set("severity", value);
    setSearchParams(next);
  };

  const onShowAcknowledgedChange = (value: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("showAcknowledged", "1");
    else next.delete("showAcknowledged");
    setSearchParams(next);
  };

  const submit = (intent: string, id: string) => {
    fetcher.submit({ intent, id }, { method: "post" });
  };

  const filterOptions = [
    { label: "All severities", value: "ALL" },
    { label: "Critical", value: "critical" },
    { label: "Warn", value: "warn" },
    { label: "Info", value: "info" },
  ];

  const rows = findings.map((f) => {
    const isAcknowledged = f.acknowledgedAt !== null;
    return [
      new Date(f.createdAt).toLocaleDateString(),
      <Badge key={`sev-${f.id}`} tone={severityTone(f.severity)}>
        {SEVERITY_LABEL[f.severity]}
      </Badge>,
      <Text key={`comp-${f.id}`} as="span">
        {f.component}
      </Text>,
      <Text key={`scan-${f.id}`} as="span" tone="subdued" variant="bodySm">
        {f.scanName}
      </Text>,
      <Button
        key={`view-${f.id}`}
        variant="plain"
        onClick={() => setActiveRow(f)}
      >
        {f.message.length > 80 ? `${f.message.slice(0, 80)}…` : f.message}
      </Button>,
      <Text key={`status-${f.id}`} as="span" variant="bodySm">
        {statusLabel(f, now)}
      </Text>,
      <ButtonGroup key={`act-${f.id}`}>
        {isAcknowledged ? (
          <Button onClick={() => submit("reopen", f.id)} disabled={submitting}>
            Reopen
          </Button>
        ) : (
          <>
            <Button
              onClick={() => submit("acknowledge", f.id)}
              disabled={submitting}
            >
              Acknowledge
            </Button>
            <Button
              variant="plain"
              onClick={() => submit("snooze7", f.id)}
              disabled={submitting}
            >
              Snooze 7d
            </Button>
            <Button
              variant="plain"
              onClick={() => submit("snooze30", f.id)}
              disabled={submitting}
            >
              Snooze 30d
            </Button>
          </>
        )}
      </ButtonGroup>,
    ];
  });

  return (
    <Page
      title="System health"
      subtitle="Operator-only: anomalies the daily diagnostic cron found in the agent's machinery. Never shown to the merchant."
      fullWidth
    >
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack gap="300" align="space-between" blockAlign="center">
              <InlineStack gap="300" blockAlign="center">
                <Box width="200px">
                  <Select
                    label="Severity filter"
                    labelHidden
                    options={filterOptions}
                    value={selectedSeverity}
                    onChange={onSeverityChange}
                  />
                </Box>
                <Checkbox
                  label="Show acknowledged"
                  checked={showAcknowledged}
                  onChange={onShowAcknowledgedChange}
                />
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Showing {findings.length} finding
                {findings.length === 1 ? "" : "s"}.
              </Text>
            </InlineStack>

            {findings.length === 0 ? (
              <EmptyState heading="No findings" image="">
                <p>
                  The daily diagnostic cron runs at 06:13 UTC. It scans
                  operational tables (decisions, audit log, turn signals,
                  conversations) for anomalies and files findings here. An
                  empty page means the agent's machinery is running clean —
                  or the cron hasn't run yet today.
                </p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                ]}
                headings={[
                  "Created",
                  "Severity",
                  "Component",
                  "Scan",
                  "Message",
                  "Status",
                  "Actions",
                ]}
                rows={rows}
              />
            )}
          </BlockStack>
        </Card>

        <Text as="p" variant="bodySm" tone="subdued">
          Findings are deduplicated per (store, component) on a 7-day spam
          guard — the same component won't refile until either you snooze
          and the snooze expires, or 7 days pass. Acknowledge once you've
          looked into it; snooze if you want to be reminded later. Reopen
          puts it back in the open queue.
        </Text>
      </BlockStack>

      {activeRow ? (
        <FindingModal row={activeRow} onClose={() => setActiveRow(null)} />
      ) : null}
    </Page>
  );
}

function FindingModal({
  row,
  onClose,
}: {
  row: FindingRow;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={row.message}
      primaryAction={{ content: "Close", onAction: onClose }}
      size="large"
    >
      <Modal.Section>
        <BlockStack gap="300">
          <InlineStack gap="200" blockAlign="center">
            <Badge tone={severityTone(row.severity)}>
              {SEVERITY_LABEL[row.severity]}
            </Badge>
            <Text as="span" tone="subdued" variant="bodySm">
              {row.component} · {new Date(row.createdAt).toLocaleString()}
            </Text>
          </InlineStack>
          <BlockStack gap="100">
            <Text as="h3" variant="headingSm">
              Recommendation
            </Text>
            <Text as="p">{row.recommendation}</Text>
          </BlockStack>
          <BlockStack gap="100">
            <Text as="h3" variant="headingSm">
              Evidence
            </Text>
            <Box
              padding="200"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              <pre
                style={{
                  margin: 0,
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: "12px",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {JSON.stringify(row.evidence, null, 2)}
              </pre>
            </Box>
          </BlockStack>
          <Text as="p" tone="subdued" variant="bodySm">
            Scan: {row.scanName}
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
