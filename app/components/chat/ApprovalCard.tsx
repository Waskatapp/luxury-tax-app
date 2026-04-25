import { useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  InlineStack,
  Text,
} from "@shopify/polaris";
import type { PendingActionStatus } from "../../hooks/useChat";

type Props = {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: PendingActionStatus | undefined;
  onApprove: (toolCallId: string) => Promise<void> | void;
  onReject: (toolCallId: string) => Promise<void> | void;
};

const TOOL_DISPLAY: Record<string, { verb: string; emoji?: string }> = {
  update_product_price: { verb: "Update product price" },
  update_product_description: { verb: "Update product description" },
  update_product_status: { verb: "Change product status" },
  create_product_draft: { verb: "Create product (draft)" },
  create_discount: { verb: "Create discount" },
};

export function ApprovalCard({
  toolCallId,
  toolName,
  toolInput,
  status,
  onApprove,
  onReject,
}: Props) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  const display = TOOL_DISPLAY[toolName]?.verb ?? toolName;
  const effectiveStatus: PendingActionStatus = status ?? "PENDING";
  const isPending = effectiveStatus === "PENDING";

  const handleApprove = async () => {
    if (busy) return;
    setBusy("approve");
    try {
      await onApprove(toolCallId);
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    if (busy) return;
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
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            Pending action: {display}
          </Text>
          <StatusBadge status={effectiveStatus} />
        </InlineStack>

        <ToolInputSummary toolName={toolName} toolInput={toolInput} />

        {isPending ? (
          <InlineStack gap="200">
            <Button
              variant="primary"
              onClick={handleApprove}
              loading={busy === "approve"}
              disabled={busy !== null}
            >
              Approve
            </Button>
            <Button
              tone="critical"
              onClick={handleReject}
              loading={busy === "reject"}
              disabled={busy !== null}
            >
              Reject
            </Button>
          </InlineStack>
        ) : null}
      </BlockStack>
    </Box>
  );
}

function StatusBadge({ status }: { status: PendingActionStatus }) {
  switch (status) {
    case "EXECUTED":
      return <Badge tone="success">Approved & applied</Badge>;
    case "APPROVED":
      return <Badge tone="info">Approved (working…)</Badge>;
    case "REJECTED":
      return <Badge>Rejected</Badge>;
    case "FAILED":
      return <Badge tone="critical">Failed</Badge>;
    case "PENDING":
    default:
      return <Badge tone="warning">Awaiting your approval</Badge>;
  }
}

function ToolInputSummary({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
}) {
  // Compact, human-friendly preview per tool. Keep it minimal — Phase 6 will
  // enrich with proper before/after diffs once we fetch the before-state for
  // the card preview (currently we only fetch on approve).
  if (toolName === "update_product_price") {
    const variant = stringOr(toolInput.variantId, "(unknown variant)");
    const price = stringOr(toolInput.newPrice, "(unknown price)");
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        Set variant <code>{variant}</code> to <strong>{price}</strong>.
      </Text>
    );
  }
  if (toolName === "create_discount") {
    const title = stringOr(toolInput.title, "(untitled)");
    const percent = numberOr(toolInput.percentOff, 0);
    const startsAt = stringOr(toolInput.startsAt, "(today)");
    const endsAt = stringOr(toolInput.endsAt, null);
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        <strong>{title}</strong> — {percent}% off, starts {startsAt}
        {endsAt ? <> , ends {endsAt}</> : null}.
      </Text>
    );
  }
  if (toolName === "create_product_draft") {
    const title = stringOr(toolInput.title, "(untitled)");
    const vendor = stringOr(toolInput.vendor, null);
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        Create <strong>{title}</strong>
        {vendor ? <> ({vendor})</> : null} as a DRAFT product.
      </Text>
    );
  }
  if (toolName === "update_product_description") {
    const productId = stringOr(toolInput.productId, "(unknown)");
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        Replace description on product <code>{productId}</code>.
      </Text>
    );
  }
  if (toolName === "update_product_status") {
    const productId = stringOr(toolInput.productId, "(unknown)");
    const status = stringOr(toolInput.status, "(unknown)");
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        Set product <code>{productId}</code> to <strong>{status}</strong>.
      </Text>
    );
  }
  // Fallback: show raw JSON in case Gemini calls a tool we haven't styled.
  return (
    <Text as="p" variant="bodySm" tone="subdued">
      <code>{JSON.stringify(toolInput)}</code>
    </Text>
  );
}

function stringOr(value: unknown, fallback: string): string;
function stringOr(value: unknown, fallback: null): string | null;
function stringOr(value: unknown, fallback: string | null): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
