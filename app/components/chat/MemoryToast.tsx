import { useEffect } from "react";
import { Box, Button, InlineStack, Text } from "@shopify/polaris";

// Custom toast — Polaris <Toast> requires a <Frame> ancestor that conflicts
// with App Bridge's <NavMenu> in our embedded layout. This is the same
// shape (fixed-position, auto-dismiss, undo action) without the Frame
// dependency.

export type MemoryToastEntry = {
  id: string;
  category: string;
  key: string;
  value: string;
};

const AUTO_DISMISS_MS = 6000;
const FRIENDLY_CATEGORY: Record<string, string> = {
  BRAND_VOICE: "brand voice",
  PRICING_RULES: "pricing rules",
  PRODUCT_RULES: "product rules",
  CUSTOMER_RULES: "customer rules",
  STORE_CONTEXT: "store context",
  OPERATOR_PREFS: "preferences",
};

export function MemoryToast({
  entry,
  onUndo,
  onDismiss,
}: {
  entry: MemoryToastEntry;
  onUndo: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(entry.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [entry.id, onDismiss]);

  const friendly = FRIENDLY_CATEGORY[entry.category] ?? entry.category;
  // Truncate long values so the toast stays one line; full text lives in
  // /app/settings/memory.
  const valuePreview =
    entry.value.length > 80 ? entry.value.slice(0, 77) + "…" : entry.value;

  return (
    <Box
      padding="300"
      background="bg-surface"
      borderColor="border"
      borderWidth="025"
      borderRadius="300"
      shadow="200"
    >
      <InlineStack gap="300" blockAlign="center" wrap={false}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text as="p" variant="bodySm">
            <Text as="span" fontWeight="semibold">
              Saved to memory:
            </Text>{" "}
            <Text as="span" tone="subdued">
              {friendly} — {entry.key} = "{valuePreview}"
            </Text>
          </Text>
        </div>
        <Button variant="plain" onClick={() => onUndo(entry.id)}>
          Undo
        </Button>
        <Button
          variant="plain"
          onClick={() => onDismiss(entry.id)}
          accessibilityLabel="Dismiss"
        >
          ×
        </Button>
      </InlineStack>
    </Box>
  );
}

export function MemoryToastStack({
  toasts,
  onUndo,
  onDismiss,
}: {
  toasts: MemoryToastEntry[];
  onUndo: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 420,
      }}
    >
      {toasts.map((t) => (
        <MemoryToast
          key={t.id}
          entry={t}
          onUndo={onUndo}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
