import { useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  InlineStack,
  Text,
} from "@shopify/polaris";

// V2.3 — Renders a `propose_plan` tool_use as an interactive plan
// approval card. Lives between an ApprovalCard (for individual writes)
// and a passive checklist: one Approve / one Reject for the whole plan,
// then the CEO walks the merchant through the steps one at a time.

// Phase Re Round Re-C1 — per-step state machine. Plans now track which
// step the agent is on and what state each step is in. Re-C2 surfaces
// the per-step status visually (green check on completed, red on
// failed, blue on in_progress, grey on pending/skipped).
export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";

export type PlanStep = {
  description: string;
  departmentId: string;
  estimatedTool?: string | undefined;
  status?: PlanStepStatus | undefined;
  completedAt?: string | undefined;
  failureCode?: string | undefined;
};

// Phase Re Round Re-C2 — Plan.status gains EXPIRED for plans whose
// last activity is older than the resume TTL (24h). Expired plans
// don't auto-resume; the merchant has to start fresh.
export type PlanStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

// Pure helper exported for unit testing. Decides whether the plan card
// should render at all, given what the message bubble knows: the
// server-side sidecar (Plan row keyed by toolCallId, present iff the
// plan was successfully persisted) and the steps extracted from the
// tool_use input.
//
// The classifier guards against a regression we hit in live testing:
// when Gemini sends propose_plan with > 8 steps (or some other
// validation failure), the executor rejects it and no Plan row is
// created. Without this guard the bubble would happily render a
// phantom approve/reject card backed by nothing — confusing the
// merchant because the CEO's follow-up text already says the plan was
// rejected.
export function shouldRenderPlanCard(opts: {
  hasSidecar: boolean;
  inputStepCount: number;
}): boolean {
  if (opts.hasSidecar) return true;
  // No sidecar — toolInput is the only source. Server-side cap is 2–8;
  // anything else means validation failed.
  return opts.inputStepCount >= 2 && opts.inputStepCount <= 8;
}

type Props = {
  toolCallId: string;
  summary: string;
  steps: PlanStep[];
  status: PlanStatus | undefined; // undefined = treat as PENDING (just-streamed)
  onApprove: (toolCallId: string) => Promise<void> | void;
  onReject: (toolCallId: string) => Promise<void> | void;
};

const DEPT_LABEL: Record<string, string> = {
  products: "Products",
  "pricing-promotions": "Pricing & Promotions",
  insights: "Insights",
  marketing: "Marketing",
  customers: "Customers",
  orders: "Orders",
  inventory: "Inventory",
  "cross-cutting": "Cross-cutting",
};

const DEPT_TONE: Record<
  string,
  "info" | "success" | "attention" | "warning"
> = {
  products: "info",
  "pricing-promotions": "warning",
  insights: "success",
  marketing: "info",
  customers: "success",
  orders: "warning",
  inventory: "info",
  "cross-cutting": "attention",
};

function statusTone(
  status: PlanStatus,
): "warning" | "success" | "attention" | "info" {
  if (status === "PENDING") return "warning";
  if (status === "APPROVED") return "success";
  if (status === "EXPIRED") return "info";
  return "attention"; // REJECTED
}

function statusLabel(status: PlanStatus): string {
  if (status === "PENDING") return "Awaiting your approval";
  if (status === "APPROVED") return "Plan approved";
  if (status === "EXPIRED") return "Plan expired";
  return "Plan rejected";
}

// Phase Re Round Re-C2 — per-step badge. Five-state visual mapping:
// pending = subdued; in_progress = info pulse (handled by Polaris
// Spinner upstream); completed = green check; failed = red; skipped =
// strikethrough subdued.
function stepStatusBadge(
  status: PlanStepStatus,
): { tone: "info" | "success" | "warning" | "critical" | undefined; label: string } {
  if (status === "in_progress") return { tone: "info", label: "in progress" };
  if (status === "completed") return { tone: "success", label: "done" };
  if (status === "failed") return { tone: "critical", label: "failed" };
  if (status === "skipped") return { tone: undefined, label: "skipped" };
  return { tone: undefined, label: "pending" };
}

export function PlanCard({
  toolCallId,
  summary,
  steps,
  status,
  onApprove,
  onReject,
}: Props) {
  const effectiveStatus: PlanStatus = status ?? "PENDING";
  const isPending = effectiveStatus === "PENDING";
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  const handleApprove = async () => {
    if (!isPending || busy) return;
    setBusy("approve");
    try {
      await onApprove(toolCallId);
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    if (!isPending || busy) return;
    setBusy("reject");
    try {
      await onReject(toolCallId);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box
      padding="300"
      background="bg-surface-secondary"
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
    >
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="bodySm" tone="subdued">
              Proposed plan
            </Text>
            <Badge tone={statusTone(effectiveStatus)}>
              {statusLabel(effectiveStatus)}
            </Badge>
          </InlineStack>
        </InlineStack>

        <Text as="p" variant="bodyMd" fontWeight="semibold">
          {summary}
        </Text>

        <BlockStack gap="200">
          {steps.map((step, idx) => {
            const stepStatus: PlanStepStatus = step.status ?? "pending";
            const sb = stepStatusBadge(stepStatus);
            const isFailed = stepStatus === "failed";
            const isSkipped = stepStatus === "skipped";
            return (
              <InlineStack
                key={`${toolCallId}-${idx}`}
                gap="200"
                blockAlign="start"
                wrap={false}
              >
                <Box minWidth="22px">
                  <Text
                    as="span"
                    variant="bodyMd"
                    fontWeight="semibold"
                    tone="subdued"
                    textDecorationLine={isSkipped ? "line-through" : undefined}
                  >
                    {idx + 1}.
                  </Text>
                </Box>
                <BlockStack gap="050">
                  <Text
                    as="p"
                    variant="bodyMd"
                    textDecorationLine={isSkipped ? "line-through" : undefined}
                    tone={isSkipped ? "subdued" : undefined}
                  >
                    {step.description}
                  </Text>
                  <InlineStack gap="100" blockAlign="center">
                    <Badge tone={DEPT_TONE[step.departmentId] ?? "info"}>
                      {DEPT_LABEL[step.departmentId] ?? step.departmentId}
                    </Badge>
                    <Badge tone={sb.tone}>{sb.label}</Badge>
                    {isFailed && step.failureCode ? (
                      <Text as="span" variant="bodySm" tone="critical">
                        ({step.failureCode})
                      </Text>
                    ) : null}
                    {step.estimatedTool ? (
                      <Text as="span" variant="bodySm" tone="subdued">
                        {step.estimatedTool}
                      </Text>
                    ) : null}
                  </InlineStack>
                </BlockStack>
              </InlineStack>
            );
          })}
        </BlockStack>

        {isPending ? (
          <InlineStack align="end">
            <ButtonGroup>
              <Button
                tone="critical"
                variant="plain"
                onClick={handleReject}
                disabled={busy !== null}
                loading={busy === "reject"}
              >
                Reject plan
              </Button>
              <Button
                variant="primary"
                onClick={handleApprove}
                disabled={busy !== null}
                loading={busy === "approve"}
              >
                Approve plan
              </Button>
            </ButtonGroup>
          </InlineStack>
        ) : null}
      </BlockStack>
    </Box>
  );
}
