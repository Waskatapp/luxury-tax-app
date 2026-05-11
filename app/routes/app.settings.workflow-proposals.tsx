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
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import { UserRole } from "@prisma/client";
import { useState } from "react";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import {
  buildTimelineEvents,
  verificationSummary as verificationSummaryHelper,
} from "../lib/agent/abandonment/lifecycle";

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
  // Phase Ab Round Ab-C-prime — verification loop fields.
  shippedAt: string | null;
  baselineClusterSize: number | null;
  verifiedAt: string | null;
  verificationAttempts: number;
  lastVerifyError: string | null;
  currentClusterSize: number | null; // computed at loader time
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

  // Phase Ab Round Ab-C-prime — fetch current cluster size per fingerprint
  // so the verification math can render in the UI. One query, grouped by
  // fingerprint; we pick the most-recent cluster row per fingerprint.
  const fingerprints = Array.from(new Set(rows.map((r) => r.fingerprint)));
  const currentClusters =
    fingerprints.length > 0
      ? await prisma.abandonmentCluster.findMany({
          where: { storeId: store.id, fingerprint: { in: fingerprints } },
          orderBy: { createdAt: "desc" },
          select: { fingerprint: true, size: true, createdAt: true },
        })
      : [];
  const currentSizeByFingerprint = new Map<string, number>();
  for (const c of currentClusters) {
    if (!currentSizeByFingerprint.has(c.fingerprint)) {
      currentSizeByFingerprint.set(c.fingerprint, c.size);
    }
  }

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
    shippedAt: r.shippedAt ? r.shippedAt.toISOString() : null,
    baselineClusterSize: r.baselineClusterSize,
    verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
    verificationAttempts: r.verificationAttempts,
    lastVerifyError: r.lastVerifyError,
    currentClusterSize: currentSizeByFingerprint.get(r.fingerprint) ?? null,
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
    select: { id: true, status: true, fingerprint: true },
  });
  if (!existing) {
    return { ok: false, error: "not found" };
  }
  const now = new Date();
  const userEmail =
    session.onlineAccessInfo?.associated_user?.email ?? store.ownerEmail ?? null;

  if (parsed.data.intent === "reject") {
    await prisma.workflowProposal.update({
      where: { id: existing.id },
      data: {
        status: "REJECTED",
        reviewedBy: userEmail,
        reviewedAt: now,
      },
    });
    return { ok: true, intent: "reject" };
  }

  // Phase Ab Round Ab-C-prime — Approve. Snapshot the baseline cluster
  // size so 7d later the verify pass has something to compare against.
  // Look up the most-recent AbandonmentCluster matching the proposal's
  // fingerprint. May return null if the cluster was GC'd between
  // proposal creation and approval (14-day TTL on ClusterRun) — in that
  // case we ship with baselineClusterSize=null and the verify pass will
  // flag it as `no_baseline` to the operator.
  const baseline = await prisma.abandonmentCluster.findFirst({
    where: { storeId: store.id, fingerprint: existing.fingerprint },
    orderBy: { createdAt: "desc" },
    select: { size: true },
  });
  await prisma.workflowProposal.update({
    where: { id: existing.id },
    data: {
      status: "FIX_SHIPPED",
      reviewedBy: userEmail,
      reviewedAt: now,
      shippedAt: now,
      baselineClusterSize: baseline?.size ?? null,
    },
  });
  return { ok: true, intent: "approve" };
};

export const headers: HeadersFunction = (args) => boundary.headers(args);

function statusTone(
  status: string,
): "warning" | "success" | "critical" | "info" | "attention" | undefined {
  if (status === "PENDING") return "warning";
  if (status === "ACCEPTED") return "success"; // legacy
  if (status === "REJECTED") return "critical";
  if (status === "REVISED") return "info";
  if (status === "FIX_SHIPPED") return "warning";
  if (status === "VERIFIED_FIXED") return "success";
  if (status === "FIX_DIDNT_HELP") return "attention";
  if (status === "FIX_DIDNT_HELP_GIVING_UP") return "critical";
  return undefined;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

// Phase Ab Round Ab-C-prime — compute verification math for display.
// Returns null when the data isn't there yet (still pending, or no
// baseline captured at ship time). Implementation lives in the pure
// lifecycle helper module; this is a thin route-level adapter.
function verificationSummary(p: ProposalRow): string | null {
  return verificationSummaryHelper(p);
}

// Days remaining until verification fires (negative = overdue, which
// should only show transiently between when shippedAt+7d hits and when
// the cron sweeps).
function daysUntilVerify(shippedAt: string): number {
  const elapsed = Date.now() - new Date(shippedAt).getTime();
  const remainingMs = 7 * 24 * 60 * 60 * 1000 - elapsed;
  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}

export default function WorkflowProposalsPage() {
  const { proposals } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  // Phase Ab Round Ab-C-prime — group by lifecycle stage.
  const pending = proposals.filter((p) => p.status === "PENDING");
  const shipped = proposals.filter((p) => p.status === "FIX_SHIPPED");
  const verified = proposals.filter((p) => p.status === "VERIFIED_FIXED");
  const didntHelp = proposals.filter((p) => p.status === "FIX_DIDNT_HELP");
  const givingUp = proposals.filter(
    (p) => p.status === "FIX_DIDNT_HELP_GIVING_UP",
  );
  const rejected = proposals.filter((p) => p.status === "REJECTED");
  const legacyAccepted = proposals.filter(
    (p) => p.status === "ACCEPTED" || p.status === "REVISED",
  );

  // Ab-E — for the verification timeline, each proposal needs its
  // re-authored siblings (other proposals matching the same fingerprint).
  // These already live in the loader's flat list — group once here.
  const siblingsByFingerprint = new Map<string, ProposalRow[]>();
  for (const p of proposals) {
    const arr = siblingsByFingerprint.get(p.fingerprint) ?? [];
    arr.push(p);
    siblingsByFingerprint.set(p.fingerprint, arr);
  }
  const siblingsFor = (p: ProposalRow): ProposalRow[] =>
    (siblingsByFingerprint.get(p.fingerprint) ?? []).filter(
      (s) => s.id !== p.id,
    );

  return (
    <Page title="Workflow proposals">
      <BlockStack gap="400">
        <Card>
          <Box padding="400">
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">
                Phase Wf Round Wf-E — Skill Creator + Ab-C-prime verification
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Operator-only. The nightly Abandonment Brain pass authors
                workflow SOPs from recurring failure clusters (size ≥ 5).
                Approving merges a proposal into THIS store's playbook
                AND snapshots the cluster's baseline size. 7 days later,
                the verify pass compares the cluster's current size to
                the baseline — ≥50% shrink → <strong>verified working</strong>;
                less than that → <strong>didn't help</strong> and Wf-E
                re-authors a different shape (up to 3 attempts).
                Rejecting permanently blocks the cluster fingerprint.
                Cost-bounded: 5 LLM calls per store per nightly run.
              </Text>
            </BlockStack>
          </Box>
        </Card>

        {proposals.length === 0 && (
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
                    siblings={siblingsFor(p)}
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

        {shipped.length > 0 && (
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">
                  Shipped — awaiting verification ({shipped.length})
                </Text>
                {shipped.map((p) => (
                  <ProposalRowView
                    key={p.id}
                    proposal={p}
                    siblings={siblingsFor(p)}
                    readOnly
                  />
                ))}
              </BlockStack>
            </Box>
          </Card>
        )}

        {verified.length > 0 && (
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">
                  Verified working ({verified.length})
                </Text>
                {verified.map((p) => (
                  <ProposalRowView
                    key={p.id}
                    proposal={p}
                    siblings={siblingsFor(p)}
                    readOnly
                  />
                ))}
              </BlockStack>
            </Box>
          </Card>
        )}

        {didntHelp.length > 0 && (
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">
                  Didn't help — re-author scheduled ({didntHelp.length})
                </Text>
                {didntHelp.map((p) => (
                  <ProposalRowView
                    key={p.id}
                    proposal={p}
                    siblings={siblingsFor(p)}
                    readOnly
                  />
                ))}
              </BlockStack>
            </Box>
          </Card>
        )}

        {givingUp.length > 0 && (
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">
                  Locked — gave up after 3 attempts ({givingUp.length})
                </Text>
                {givingUp.map((p) => (
                  <ProposalRowView
                    key={p.id}
                    proposal={p}
                    siblings={siblingsFor(p)}
                    readOnly
                  />
                ))}
              </BlockStack>
            </Box>
          </Card>
        )}

        {rejected.length > 0 && (
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">
                  Rejected ({rejected.length})
                </Text>
                {rejected.map((p) => (
                  <ProposalRowView
                    key={p.id}
                    proposal={p}
                    siblings={siblingsFor(p)}
                    readOnly
                  />
                ))}
              </BlockStack>
            </Box>
          </Card>
        )}

        {legacyAccepted.length > 0 && (
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">
                  Legacy accepted (pre-Ab-C-prime, no verification math) ({legacyAccepted.length})
                </Text>
                {legacyAccepted.map((p) => (
                  <ProposalRowView
                    key={p.id}
                    proposal={p}
                    siblings={siblingsFor(p)}
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
  siblings,
  onApprove,
  onReject,
  busy,
  readOnly,
}: {
  proposal: ProposalRow;
  siblings?: ProposalRow[];
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  busy?: boolean;
  readOnly?: boolean;
}) {
  const [showBody, setShowBody] = useState(false);
  return (
    <Box
      id={`proposal-${proposal.id}`}
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
        <InlineStack gap="300">
          <Link
            url={`/app/settings/abandonment-diagnoses#cluster-${proposal.fingerprint}`}
          >
            View cluster samples →
          </Link>
        </InlineStack>
        <VerificationInfo proposal={proposal} />
        <ProposalTimeline proposal={proposal} siblings={siblings ?? []} />
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
            {proposal.status === "REJECTED" ? "Rejected" : "Approved"} by{" "}
            {proposal.reviewedBy} on {formatDate(proposal.reviewedAt)}
          </Text>
        )}
      </BlockStack>
    </Box>
  );
}

// Phase Ab Round Ab-C-prime — per-row verification status display.
// Renders different things per lifecycle state: shipped (countdown),
// verified (math + verifiedAt), didn't help (math + attempt counter),
// giving up (math + final attempt count). Returns null for PENDING /
// REJECTED / legacy ACCEPTED where there's no verification math to show.
function VerificationInfo({ proposal }: { proposal: ProposalRow }) {
  const summary = verificationSummary(proposal);

  if (proposal.status === "FIX_SHIPPED" && proposal.shippedAt) {
    const days = daysUntilVerify(proposal.shippedAt);
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        Shipped {formatDate(proposal.shippedAt)}
        {summary ? ` · baseline ${proposal.baselineClusterSize ?? "?"}` : ""}
        {" · "}
        {days > 0 ? `verifies in ${days} day${days === 1 ? "" : "s"}` : "verification due — runs at next 07:13 UTC cron"}
        {proposal.lastVerifyError ? ` · error: ${proposal.lastVerifyError}` : ""}
      </Text>
    );
  }

  if (proposal.status === "VERIFIED_FIXED") {
    return (
      <Text as="p" variant="bodySm" tone="success">
        ✓ Verified working — {summary ?? "math unavailable"}
        {proposal.verifiedAt ? ` · verified ${formatDate(proposal.verifiedAt)}` : ""}
      </Text>
    );
  }

  if (proposal.status === "FIX_DIDNT_HELP") {
    return (
      <Text as="p" variant="bodySm" tone="caution">
        Didn't help — {summary ?? "math unavailable"} · attempt{" "}
        {proposal.verificationAttempts}/3 — Wf-E will re-author on next nightly run
      </Text>
    );
  }

  if (proposal.status === "FIX_DIDNT_HELP_GIVING_UP") {
    return (
      <Text as="p" variant="bodySm" tone="critical">
        Locked after {proposal.verificationAttempts} failed attempt
        {proposal.verificationAttempts === 1 ? "" : "s"} — {summary ?? "math unavailable"}
      </Text>
    );
  }

  return null;
}

function ProposalTimeline({
  proposal,
  siblings,
}: {
  proposal: ProposalRow;
  siblings: ProposalRow[];
}) {
  const events = buildTimelineEvents(proposal, siblings);
  // For PENDING with no siblings, the timeline is just "Proposed …" —
  // VerificationInfo already returns null and the row's createdAt is
  // already shown at the top, so suppress to avoid duplication.
  if (
    events.length === 1 &&
    proposal.status === "PENDING" &&
    siblings.length === 0
  ) {
    return null;
  }
  return (
    <Box paddingBlockStart="100">
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued" fontWeight="medium">
          Lifecycle timeline
        </Text>
        {events.map((e, idx) => (
          <Text
            key={`${e.when}-${idx}`}
            as="p"
            variant="bodySm"
            tone={e.tone === "subdued" ? "subdued" : e.tone}
          >
            • {formatDate(e.when)} — {e.what}
          </Text>
        ))}
      </BlockStack>
    </Box>
  );
}

export function ErrorBoundary() {
  return boundary.error;
}
