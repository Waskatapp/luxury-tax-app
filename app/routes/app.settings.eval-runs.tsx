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
  DataTable,
  EmptyState,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { UserRole } from "@prisma/client";

import { requireStoreAccess } from "../lib/auth.server";
import prisma from "../db.server";
import type { EvalScenarioResult } from "../lib/eval/types";

// Phase 8 — Eval harness operator UI. STORE_OWNER-gated. Surfaces the
// last 14 nightly EvalRun rows + per-scenario diff. The harness is
// global (not tenant-scoped) but we still gate on STORE_OWNER for
// operator-only access — only the dev-store owner needs to see this.

const PAGE_SIZE = 14;

type SerializedRun = {
  id: string;
  runAt: string;
  totalScenarios: number;
  passed: number;
  failed: number;
  durationMs: number;
  summary: EvalScenarioResult[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireStoreAccess(request, UserRole.STORE_OWNER);
  const rows = await prisma.evalRun.findMany({
    orderBy: { runAt: "desc" },
    take: PAGE_SIZE,
  });
  const runs: SerializedRun[] = rows.map((r) => ({
    id: r.id,
    runAt: r.runAt.toISOString(),
    totalScenarios: r.totalScenarios,
    passed: r.passed,
    failed: r.failed,
    durationMs: r.durationMs,
    summary: (r.summary as unknown as EvalScenarioResult[]) ?? [],
  }));
  return { runs };
};

export const headers: HeadersFunction = (args) =>
  boundary.headers(args);

function formatRunAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export default function EvalRunsPage() {
  const { runs } = useLoaderData<typeof loader>();

  if (runs.length === 0) {
    return (
      <Page title="Eval runs">
        <Card>
          <EmptyState
            heading="No eval runs yet"
            image=""
          >
            <p>
              The eval harness runs nightly at 06:43 UTC via{" "}
              <code>.github/workflows/eval-harness.yml</code>. Trigger it
              manually with <code>npm run run:eval-harness</code> or{" "}
              <code>workflow_dispatch</code> from the Actions tab.
            </p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const rows = runs.map((r) => {
    const passRate =
      r.totalScenarios > 0
        ? `${Math.round((r.passed / r.totalScenarios) * 100)}%`
        : "—";
    const status =
      r.totalScenarios === 0
        ? <Badge tone="info">analyzer-only</Badge>
        : r.failed === 0
        ? <Badge tone="success">all pass</Badge>
        : <Badge tone="warning">{`${r.failed} failed`}</Badge>;
    return [
      formatRunAt(r.runAt),
      status,
      r.totalScenarios.toString(),
      r.passed.toString(),
      r.failed.toString(),
      passRate,
      formatDuration(r.durationMs),
    ];
  });

  // Find the most recent run with failures, surface its per-scenario
  // diff at the bottom so the operator sees which scenarios are red
  // without clicking through. (Per-row drill-in is a UI follow-up.)
  const latestWithFailures = runs.find((r) => r.failed > 0);

  return (
    <Page title="Eval runs">
      <BlockStack gap="400">
        <Card>
          <Box padding="400">
            <Text variant="headingMd" as="h2">
              Recent runs
            </Text>
            <Box paddingBlockStart="200">
              <Text as="p" variant="bodySm" tone="subdued">
                Operator-only. Last {runs.length} nightly runs of the eval
                harness ({" "}
                <code>scripts/run-eval-harness.ts</code>). Failures are{" "}
                <em>data, not infra errors</em> — the harness's whole job is
                to surface them. Investigate by looking at the per-scenario
                breakdown below or in the EvalRun.summary JSON.
              </Text>
            </Box>
          </Box>
          <DataTable
            columnContentTypes={[
              "text",
              "text",
              "numeric",
              "numeric",
              "numeric",
              "text",
              "text",
            ]}
            headings={[
              "When",
              "Status",
              "Scenarios",
              "Passed",
              "Failed",
              "Pass rate",
              "Duration",
            ]}
            rows={rows}
          />
        </Card>

        {latestWithFailures !== undefined && (
          <Card>
            <Box padding="400">
              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <Text variant="headingMd" as="h2">
                    Latest run with failures
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {formatRunAt(latestWithFailures.runAt)}
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodySm">
                  {latestWithFailures.failed} of{" "}
                  {latestWithFailures.totalScenarios} scenarios failed.
                </Text>
              </BlockStack>
            </Box>
            <BlockStack gap="200">
              {latestWithFailures.summary.map((s) => (
                <Box key={s.scenarioId} padding="400" borderBlockStartWidth="025" borderColor="border">
                  <BlockStack gap="100">
                    <InlineStack gap="200" align="start">
                      {s.passed ? (
                        <Badge tone="success">PASS</Badge>
                      ) : (
                        <Badge tone="critical">FAIL</Badge>
                      )}
                      <Text variant="headingSm" as="h3">
                        {s.scenarioId}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {formatDuration(s.durationMs)}
                      </Text>
                    </InlineStack>
                    <Text as="p" variant="bodySm">
                      {s.description}
                    </Text>
                    {!s.passed && s.failedExpectations.length > 0 && (
                      <Box paddingBlockStart="100">
                        <BlockStack gap="050">
                          {s.failedExpectations.map((reason, i) => (
                            <Text key={i} as="p" variant="bodySm" tone="critical">
                              ↳ {reason}
                            </Text>
                          ))}
                        </BlockStack>
                      </Box>
                    )}
                  </BlockStack>
                </Box>
              ))}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error;
}
