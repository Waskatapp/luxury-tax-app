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

export type PlanStep = {
  description: string;
  departmentId: string;
  estimatedTool?: string | undefined;
};

export type PlanStatus = "PENDING" | "APPROVED" | "REJECTED";

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
  "cross-cutting": "Cross-cutting",
};

const DEPT_TONE: Record<
  string,
  "info" | "success" | "attention" | "warning"
> = {
  products: "info",
  "pricing-promotions": "warning",
  insights: "success",
  "cross-cutting": "attention",
};

function statusTone(
  status: PlanStatus,
): "warning" | "success" | "attention" {
  if (status === "PENDING") return "warning";
  if (status === "APPROVED") return "success";
  return "attention"; // REJECTED
}

function statusLabel(status: PlanStatus): string {
  if (status === "PENDING") return "Awaiting your approval";
  if (status === "APPROVED") return "Plan approved";
  return "Plan rejected";
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
          {steps.map((step, idx) => (
            <InlineStack
              key={`${toolCallId}-${idx}`}
              gap="200"
              blockAlign="start"
              wrap={false}
            >
              <Box minWidth="22px">
                <Text as="span" variant="bodyMd" fontWeight="semibold" tone="subdued">
                  {idx + 1}.
                </Text>
              </Box>
              <BlockStack gap="050">
                <Text as="p" variant="bodyMd">
                  {step.description}
                </Text>
                <InlineStack gap="100" blockAlign="center">
                  <Badge tone={DEPT_TONE[step.departmentId] ?? "info"}>
                    {DEPT_LABEL[step.departmentId] ?? step.departmentId}
                  </Badge>
                  {step.estimatedTool ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                      {step.estimatedTool}
                    </Text>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </InlineStack>
          ))}
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
