import { useEffect, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  InlineStack,
  Link,
  Text,
} from "@shopify/polaris";
import type { PendingActionStatus } from "../../hooks/useChat";

// V1.8: ApprovalCard groups N tool_uses from the same assistant turn into
// one card with a single Approve / Reject pair. items.length === 1 is the
// common single-write case; the rendering degrades naturally to "looks like
// the V1.7 single-card UX."
export type ApprovalCardItem = {
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: PendingActionStatus | undefined;
};

type Props = {
  items: ApprovalCardItem[];
  onApprove: (toolCallIds: string[]) => Promise<void> | void;
  onReject: (toolCallIds: string[]) => Promise<void> | void;
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
  productTitle: string | null;
  productId: string | null;
  adminUrl: string | null;
};

// Header pill priority: PENDING wins (any item still awaiting approval keeps
// the "Awaiting your approval" badge). Otherwise FAILED > REJECTED > APPROVED
// > EXECUTED so a partial failure surfaces in the header.
function deriveHeaderStatus(
  items: ApprovalCardItem[],
): PendingActionStatus {
  const statuses = items.map((i) => i.status ?? "PENDING");
  if (statuses.some((s) => s === "PENDING")) return "PENDING";
  const priority: PendingActionStatus[] = [
    "FAILED",
    "REJECTED",
    "APPROVED",
    "EXECUTED",
  ];
  for (const p of priority) {
    if (statuses.includes(p)) return p;
  }
  return "EXECUTED";
}

export function ApprovalCard({ items, onApprove, onReject }: Props) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  const headerStatus = deriveHeaderStatus(items);
  const anyPending = items.some((i) => (i.status ?? "PENDING") === "PENDING");
  const isBatch = items.length > 1;

  const allPendingIds = items
    .filter((i) => (i.status ?? "PENDING") === "PENDING")
    .map((i) => i.toolCallId);

  const handleApprove = async () => {
    if (busy || allPendingIds.length === 0) return;
    setBusy("approve");
    try {
      await onApprove(allPendingIds);
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    if (busy || allPendingIds.length === 0) return;
    setBusy("reject");
    try {
      await onReject(allPendingIds);
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
            {isBatch
              ? `Pending actions (${items.length})`
              : `Pending action: ${TOOL_DISPLAY[items[0].toolName]?.verb ?? items[0].toolName}`}
          </Text>
          <StatusBadge status={headerStatus} />
        </InlineStack>

        <BlockStack gap="200">
          {items.map((item, idx) => (
            <ItemRow key={item.toolCallId} item={item} showHeader={isBatch} index={idx} />
          ))}
        </BlockStack>

        {anyPending ? (
          <InlineStack gap="200">
            <Button
              variant="primary"
              onClick={handleApprove}
              loading={busy === "approve"}
              disabled={busy !== null}
            >
              {isBatch ? `Approve all (${allPendingIds.length})` : "Approve"}
            </Button>
            <Button
              tone="critical"
              onClick={handleReject}
              loading={busy === "reject"}
              disabled={busy !== null}
            >
              {isBatch ? "Reject all" : "Reject"}
            </Button>
          </InlineStack>
        ) : null}
      </BlockStack>
    </Box>
  );
}

function ItemRow({
  item,
  showHeader,
  index,
}: {
  item: ApprovalCardItem;
  showHeader: boolean;
  index: number;
}) {
  const effectiveStatus: PendingActionStatus = item.status ?? "PENDING";
  const isPending = effectiveStatus === "PENDING";
  const display = TOOL_DISPLAY[item.toolName]?.verb ?? item.toolName;

  // Per-row snapshot fetch. V1.9: fetch on mount regardless of pending
  // state — we want the product name on terminal rows too. Each row owns
  // its own request; a failed snapshot on row 1 doesn't blank row 2.
  // Aborts on unmount.
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshotLoading(true);
    setSnapshotFailed(false);
    fetch(
      `/api/tool-snapshot?toolCallId=${encodeURIComponent(item.toolCallId)}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (!res.ok) {
          setSnapshotFailed(true);
          return;
        }
        const data = (await res.json()) as SnapshotResponse;
        setSnapshot(data);
      })
      .catch(() => {
        setSnapshotFailed(true);
      })
      .finally(() => setSnapshotLoading(false));
    return () => controller.abort();
  }, [item.toolCallId]);

  return (
    <Box
      padding={showHeader ? "200" : "0"}
      background={showHeader ? "bg-surface" : undefined}
      borderColor={showHeader ? "border" : undefined}
      borderWidth={showHeader ? "025" : undefined}
      borderRadius={showHeader ? "200" : undefined}
    >
      <BlockStack gap="100">
        {showHeader ? (
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="bodySm" tone="subdued">
              #{index + 1} · {display}
            </Text>
            <StatusBadge status={effectiveStatus} small />
          </InlineStack>
        ) : null}
        <ToolInputSummary
          toolName={item.toolName}
          toolInput={item.toolInput}
          productTitle={snapshot?.productTitle ?? null}
          adminUrl={snapshot?.adminUrl ?? null}
          loading={snapshotLoading && snapshot === null && !snapshotFailed}
        />
        {isPending && DIFF_TOOLS.has(item.toolName) ? (
          <DiffBlock
            toolName={item.toolName}
            toolInput={item.toolInput}
            snapshot={snapshot?.before ?? null}
            loading={snapshotLoading && snapshot === null}
          />
        ) : null}
        <InlineStack gap="100">
          <Button
            variant="plain"
            onClick={() => setShowDetails((s) => !s)}
            ariaExpanded={showDetails}
          >
            {showDetails ? "Hide technical details" : "Show technical details"}
          </Button>
        </InlineStack>
        {showDetails ? (
          <TechnicalDetails toolName={item.toolName} toolInput={item.toolInput} />
        ) : null}
      </BlockStack>
    </Box>
  );
}

function StatusBadge({
  status,
  small,
}: {
  status: PendingActionStatus;
  small?: boolean;
}) {
  void small; // Polaris Badge doesn't have a "size" — kept for future styling.
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

// V1.9: render a friendly product-name-based summary instead of raw GIDs.
// When a productTitle is available from the snapshot, the row reads
// "Set price for [cat food] to $50.00" with the title as a clickable
// admin link. While the snapshot is loading, show "(loading…)" in place.
// If the snapshot fails (no title and not loading), fall back to the
// pre-V1.9 GID line so the merchant still sees what's about to change.
function ToolInputSummary({
  toolName,
  toolInput,
  productTitle,
  adminUrl,
  loading,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
  productTitle: string | null;
  adminUrl: string | null;
  loading: boolean;
}) {
  if (toolName === "update_product_price") {
    const price = stringOr(toolInput.newPrice, "(unknown price)");
    if (productTitle) {
      return (
        <Text as="p" variant="bodyMd" tone="subdued">
          Set price for <ProductRef title={productTitle} url={adminUrl} /> to{" "}
          <strong>${price}</strong>.
        </Text>
      );
    }
    if (loading) {
      return (
        <Text as="p" variant="bodyMd" tone="subdued">
          Set price for <em>(loading…)</em> to <strong>${price}</strong>.
        </Text>
      );
    }
    // Snapshot failed / no title returned — fall back to the GID form.
    const variant = stringOr(toolInput.variantId, "(unknown variant)");
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        Set variant <code>{variant}</code> to <strong>${price}</strong>.
      </Text>
    );
  }

  if (toolName === "update_product_description") {
    if (productTitle) {
      return (
        <Text as="p" variant="bodyMd" tone="subdued">
          Replace description on{" "}
          <ProductRef title={productTitle} url={adminUrl} />.
        </Text>
      );
    }
    if (loading) {
      return (
        <Text as="p" variant="bodyMd" tone="subdued">
          Replace description on <em>(loading…)</em>.
        </Text>
      );
    }
    const productId = stringOr(toolInput.productId, "(unknown)");
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        Replace description on product <code>{productId}</code>.
      </Text>
    );
  }

  if (toolName === "update_product_status") {
    const status = stringOr(toolInput.status, "(unknown)");
    if (productTitle) {
      return (
        <Text as="p" variant="bodyMd" tone="subdued">
          Set <ProductRef title={productTitle} url={adminUrl} /> to{" "}
          <strong>{status}</strong>.
        </Text>
      );
    }
    if (loading) {
      return (
        <Text as="p" variant="bodyMd" tone="subdued">
          Set <em>(loading…)</em> to <strong>{status}</strong>.
        </Text>
      );
    }
    const productId = stringOr(toolInput.productId, "(unknown)");
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        Set product <code>{productId}</code> to <strong>{status}</strong>.
      </Text>
    );
  }

  if (toolName === "create_product_draft") {
    // No admin link — the product doesn't exist yet at approval time.
    const title = stringOr(toolInput.title, "(untitled)");
    const vendor = stringOr(toolInput.vendor, null);
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        Create <strong>{title}</strong>
        {vendor ? <> ({vendor})</> : null} as a DRAFT product.
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

  return (
    <Text as="p" variant="bodySm" tone="subdued">
      <code>{JSON.stringify(toolInput)}</code>
    </Text>
  );
}

// Renders the product title as a clickable admin link when a URL is
// available; otherwise just the bold title. Polaris `Link` with `external`
// opens in a new tab with rel=noopener noreferrer applied automatically,
// which keeps the merchant's chat panel intact.
function ProductRef({
  title,
  url,
}: {
  title: string;
  url: string | null;
}) {
  if (url) {
    return (
      <Link url={url} external removeUnderline={false}>
        {title}
      </Link>
    );
  }
  return <strong>{title}</strong>;
}

// Disclosure panel revealing the raw IDs / input. Closed by default; the
// merchant clicks "Show technical details" to expand. Useful for debugging
// or for a power user who wants to confirm exactly which entity is being
// changed without trusting the rendered product name.
function TechnicalDetails({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
}) {
  return (
    <Box padding="200" background="bg-surface" borderColor="border" borderWidth="025" borderRadius="200">
      <BlockStack gap="050">
        {toolName === "update_product_price" ? (
          <>
            <DetailRow label="Variant" value={stringOr(toolInput.variantId, null)} />
            <DetailRow label="Product" value={stringOr(toolInput.productId, null)} />
            <DetailRow label="New price" value={stringOr(toolInput.newPrice, null)} />
          </>
        ) : toolName === "update_product_description" ? (
          <DetailRow label="Product" value={stringOr(toolInput.productId, null)} />
        ) : toolName === "update_product_status" ? (
          <>
            <DetailRow label="Product" value={stringOr(toolInput.productId, null)} />
            <DetailRow label="New status" value={stringOr(toolInput.status, null)} />
          </>
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            <code style={{ wordBreak: "break-all" }}>
              {JSON.stringify(toolInput, null, 2)}
            </code>
          </Text>
        )}
      </BlockStack>
    </Box>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <Text as="p" variant="bodySm" tone="subdued">
      {label}: <code style={{ wordBreak: "break-all" }}>{value}</code>
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

// Re-export for tests.
export { deriveHeaderStatus };
