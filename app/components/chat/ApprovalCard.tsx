import { useEffect, useState } from "react";
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

// Tools that have a meaningful "before" state worth fetching.
const DIFF_TOOLS = new Set([
  "update_product_price",
  "update_product_description",
  "update_product_status",
]);

type SnapshotResponse = {
  toolName: string;
  before: unknown;
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
  const [snapshot, setSnapshot] = useState<unknown>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  const display = TOOL_DISPLAY[toolName]?.verb ?? toolName;
  const effectiveStatus: PendingActionStatus = status ?? "PENDING";
  const isPending = effectiveStatus === "PENDING";

  // Fetch the before-snapshot once when the card mounts in PENDING state,
  // for tools where it's meaningful. We don't refetch on status changes —
  // once the merchant has approved/rejected, the diff is no longer the
  // useful framing. Aborts cleanly if the card unmounts mid-fetch.
  useEffect(() => {
    if (!isPending || !DIFF_TOOLS.has(toolName)) return;
    const controller = new AbortController();
    setSnapshotLoading(true);
    fetch(
      `/api/tool-snapshot?toolCallId=${encodeURIComponent(toolCallId)}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as SnapshotResponse;
        setSnapshot(data.before);
      })
      .catch(() => {
        // Network error / abort — leave snapshot null, diff block hides.
      })
      .finally(() => {
        setSnapshotLoading(false);
      });
    return () => controller.abort();
  }, [isPending, toolName, toolCallId]);

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

        {isPending && DIFF_TOOLS.has(toolName) ? (
          <DiffBlock
            toolName={toolName}
            toolInput={toolInput}
            snapshot={snapshot}
            loading={snapshotLoading}
          />
        ) : null}

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

function DiffBlock({
  toolName,
  toolInput,
  snapshot,
  loading,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
  snapshot: unknown;
  loading: boolean;
}) {
  if (loading) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        Loading current value…
      </Text>
    );
  }
  // No snapshot — silently hide the block; ToolInputSummary already shows
  // the new value above.
  if (snapshot === null || typeof snapshot !== "object") return null;

  const snap = snapshot as Record<string, unknown>;

  if (toolName === "update_product_price") {
    const oldPrice = stringOr(snap.price, null);
    const newPrice = stringOr(toolInput.newPrice, null);
    if (!oldPrice || !newPrice) return null;
    const productTitle = stringOr(snap.productTitle, null);
    const oldNum = parseFloat(oldPrice);
    const newNum = parseFloat(newPrice);
    const direction =
      Number.isFinite(oldNum) && Number.isFinite(newNum)
        ? newNum > oldNum
          ? "up"
          : newNum < oldNum
            ? "down"
            : "same"
        : "same";
    return (
      <DiffShell title={productTitle ? `Price for ${productTitle}` : "Price"}>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Text as="span" variant="bodyMd" tone="subdued">
            ${oldPrice}
          </Text>
          <Text as="span" variant="bodyMd" tone="subdued">
            →
          </Text>
          <Text
            as="span"
            variant="bodyMd"
            fontWeight="semibold"
            tone={
              direction === "up"
                ? "critical"
                : direction === "down"
                  ? "success"
                  : undefined
            }
          >
            ${newPrice}
          </Text>
        </InlineStack>
      </DiffShell>
    );
  }

  if (toolName === "update_product_status") {
    const oldStatus = stringOr(snap.status, null);
    const newStatus = stringOr(toolInput.status, null);
    if (!oldStatus || !newStatus) return null;
    const productTitle = stringOr(snap.title, null);
    return (
      <DiffShell title={productTitle ? `Status for ${productTitle}` : "Status"}>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Badge tone={statusTone(oldStatus)}>{oldStatus}</Badge>
          <Text as="span" variant="bodyMd" tone="subdued">
            →
          </Text>
          <Badge tone={statusTone(newStatus)}>{newStatus}</Badge>
        </InlineStack>
      </DiffShell>
    );
  }

  if (toolName === "update_product_description") {
    const oldDesc = stringOr(snap.descriptionHtml, "");
    const newDesc = stringOr(toolInput.descriptionHtml, "");
    if (oldDesc === null || newDesc === null) return null;
    const oldLen = oldDesc.length;
    const newLen = newDesc.length;
    const delta = newLen - oldLen;
    const productTitle = stringOr(snap.title, null);
    return (
      <DiffShell
        title={
          productTitle
            ? `Description for ${productTitle}`
            : "Description"
        }
      >
        <Text as="p" variant="bodyMd">
          <Text as="span" tone="subdued">
            {oldLen.toLocaleString()} chars
          </Text>{" "}
          →{" "}
          <Text as="span" fontWeight="semibold">
            {newLen.toLocaleString()} chars
          </Text>{" "}
          <Text
            as="span"
            tone={delta < 0 ? "critical" : delta > 0 ? "success" : "subdued"}
          >
            ({delta > 0 ? "+" : ""}
            {delta.toLocaleString()})
          </Text>
        </Text>
      </DiffShell>
    );
  }

  return null;
}

function DiffShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      padding="200"
      background="bg-surface"
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
    >
      <BlockStack gap="100">
        <Text as="span" variant="bodySm" tone="subdued">
          {title}
        </Text>
        {children}
      </BlockStack>
    </Box>
  );
}

function statusTone(status: string): "success" | "info" | "warning" | undefined {
  if (status === "ACTIVE") return "success";
  if (status === "DRAFT") return "info";
  if (status === "ARCHIVED") return "warning";
  return undefined;
}

function ToolInputSummary({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
}) {
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
