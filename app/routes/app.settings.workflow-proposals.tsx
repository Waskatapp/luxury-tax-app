import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Collapsible,
  EmptyState,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { UserRole } from "@prisma/client";
import { useState } from "react";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";

// Phase Wf Round Wf-E — operator UI for autonomously-authored workflow
// proposals. STORE_OWNER-gated. Shows PENDING proposals from the
// nightly Skill Creator pass; operator approves to merge into the
// CEO's playbook for THIS store, or rejects to permanently block the
// fingerprint from re-proposing.
//
// Mirrors /app/settings/system-health pattern (operator-only, never
// injected into merchant chat).

const PAGE_SIZE = 50;

type ProposalRow = {
  id: string;
  name: string;
  summary: string;
  body: string;
  triggers: string[];
  status: string;
  fingerprint: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  evidence: {
    clusterIds: string[];
    sampleTurnIds: string[];
    commonTools: string[];
    commonRouterReason: string | null;
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request, UserRole.STORE_OWNER);
  const rows = await prisma.workflowProposal.findMany({
    where: { storeId: store.id },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: PAGE_SIZE,
  });
  const proposals: ProposalRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    summary: r.summary,
    body: r.body,
    triggers: r.triggers,
    status: r.status,
    fingerprint: r.fingerprint,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    evidence: r.evidence as ProposalRow["evidence"],
  }));
  return { proposals };
};

const ActionInput = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("approve"), id: z.string().min(1) }),
  z.object({ intent: z.literal("reject"), id: z.string().min(1) }),
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { store, session } = await requireStoreAccess(
    request,
    UserRole.STORE_OWNER,
  );
  const fd = await request.formData();
  const parsed = ActionInput.safeParse({
    intent: fd.get("intent"),
    id: fd.get("id"),
  });
  if (!parsed.success) {
    return { ok: false, error: "invalid input" };
  }
  // Verify the proposal belongs to this store before flipping.
  const existing = await prisma.workflowProposal.findFirst({
    where: { id: parsed.data.id, storeId: store.id },
    select: { id: true, status: true },
  });
  if (!existing) {
    return { ok: false, error: "not found" };
  }
  const newStatus =
    parsed.data.intent === "approve" ? "ACCEPTED" : "REJECTED";
  const userEmail =
    session.onlineAccessInfo?.associated_user?.email ?? store.ownerEmail ?? null;
  await prisma.workflowProposal.update({
    where: { id: existing.id },
    data: {
      status: newStatus,
      reviewedBy: userEmail,
      reviewedAt: new Date(),
    },
  });
  return { ok: true, intent: parsed.data.intent };
};

export const headers: HeadersFunction = (args) => boundary.headers(args);

function statusTone(
  status: string,
): "warning" | "success" | "critical" | "info" | undefined {
  if (status === "PENDING") return "warning";
  if (status === "ACCEPTED") return "success";
  if (status === "REJECTED") return "critical";
  if (status === "REVISED") return "info";
  return undefined;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function WorkflowProposalsPage() {
  const { proposals } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const pending = proposals.filter((p) => p.status === "PENDING");
  const reviewed = proposals.filter((p) => p.status !== "PENDING");

  return (
    <Page title="Workflow proposals">
      <BlockStack gap="400">
        <Card>
          <Box padding="400">
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">
                Phase Wf Round Wf-E — Skill Creator
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Operator-only. The nightly Abandonment Brain pass authors
                workflow SOPs from recurring failure clusters (size ≥ 5).
                Approving merges a proposal into THIS store's playbook —
                the CEO sees the new workflow on the next conversation
                via <code>read_workflow</code>. Rejecting permanently
                blocks the cluster fingerprint from re-proposing.
                Cost-bounded: 5 LLM calls per store per nightly run.
              </Text>
            </BlockStack>
          </Box>
        </Card>

        {pending.length === 0 && reviewed.length === 0 && (
          <Card>
            <EmptyState heading="No proposals yet" image="">
              <p>
                The Skill Creator authors proposals from recurring abandonment
                clusters (size ≥ 5, dominantOutcome IN
                ('abandoned','errored_unrecovered')). It runs nightly with the
                rest of the Abandonment Brain at 07:13 UTC. Trigger manually
                with <code>npm run run:ab-brain</code> if you have qualifying
                clusters.
              </p>
            </EmptyState>
          </Card>
        )}

        {pending.length > 0 && (
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">
                  Pending review ({pending.length})
                </Text>
                {pending.map((p) => (
                  <ProposalRowView
                    key={p.id}
                    proposal={p}
                    onApprove={(id) =>
                      fetcher.submit(
                        { intent: "approve", id },
                        { method: "post" },
                      )
                    }
                    onReject={(id) =>
                      fetcher.submit(
                        { intent: "reject", id },
                        { method: "post" },
                      )
                    }
                    busy={fetcher.state !== "idle"}
                  />
                ))}
              </BlockStack>
            </Box>
          </Card>
        )}

        {reviewed.length > 0 && (
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">
                  Reviewed ({reviewed.length})
                </Text>
                {reviewed.map((p) => (
                  <ProposalRowView
                    key={p.id}
                    proposal={p}
                    readOnly
                  />
                ))}
              </BlockStack>
            </Box>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}

function ProposalRowView({
  proposal,
  onApprove,
  onReject,
  busy,
  readOnly,
}: {
  proposal: ProposalRow;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  busy?: boolean;
  readOnly?: boolean;
}) {
  const [showBody, setShowBody] = useState(false);
  return (
    <Box
      padding="300"
      background="bg-surface-secondary"
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
    >
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {proposal.name}
            </Text>
            <Badge tone={statusTone(proposal.status)}>{proposal.status}</Badge>
          </InlineStack>
          <Text as="span" variant="bodySm" tone="subdued">
            {formatDate(proposal.createdAt)}
          </Text>
        </InlineStack>
        <Text as="p" variant="bodySm">
          {proposal.summary}
        </Text>
        <InlineStack gap="100">
          {proposal.triggers.map((t) => (
            <Badge key={t} tone="info">
              {t}
            </Badge>
          ))}
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">
          Evidence: {proposal.evidence.clusterIds.length} cluster(s),{" "}
          {proposal.evidence.sampleTurnIds.length} sample turn(s)
          {proposal.evidence.commonTools.length > 0 &&
            ` · common tools: ${proposal.evidence.commonTools.join(", ")}`}
        </Text>
        <InlineStack gap="200">
          <Button
            onClick={() => setShowBody((v) => !v)}
            variant="plain"
            disclosure={showBody ? "up" : "down"}
          >
            {showBody ? "Hide body" : "View body"}
          </Button>
          {!readOnly && proposal.status === "PENDING" && (
            <ButtonGroup>
              <Button
                tone="critical"
                variant="plain"
                onClick={() => onReject?.(proposal.id)}
                disabled={busy}
              >
                Reject (block fingerprint)
              </Button>
              <Button
                variant="primary"
                onClick={() => onApprove?.(proposal.id)}
                disabled={busy}
              >
                Approve
              </Button>
            </ButtonGroup>
          )}
        </InlineStack>
        <Collapsible
          id={`proposal-body-${proposal.id}`}
          open={showBody}
          transition={{ duration: "150ms" }}
        >
          <Box
            padding="300"
            background="bg-surface"
            borderColor="border"
            borderWidth="025"
            borderRadius="100"
          >
            <pre
              style={{
                whiteSpace: "pre-wrap",
                fontFamily: "monospace",
                fontSize: 12,
                margin: 0,
              }}
            >
              {proposal.body}
            </pre>
          </Box>
        </Collapsible>
        {proposal.reviewedBy && proposal.reviewedAt && (
          <Text as="p" variant="bodySm" tone="subdued">
            {proposal.status === "ACCEPTED" ? "Approved" : "Rejected"} by{" "}
            {proposal.reviewedBy} on {formatDate(proposal.reviewedAt)}
          </Text>
        )}
      </BlockStack>
    </Box>
  );
}

export function ErrorBoundary() {
  return boundary.error;
}
