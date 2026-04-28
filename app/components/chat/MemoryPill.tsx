import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  EmptyState,
  InlineStack,
  Modal,
  Text,
} from "@shopify/polaris";
import { Link, useNavigate } from "react-router";

// V2.3 — small pill rendered above ChatInput, showing the count of
// stored memory entries. Clicking opens a Modal listing all entries
// grouped by category. Each entry has a Delete button. Edits route the
// merchant to /app/settings/memory (full CRUD UI lives there; the pill
// is a quick-glance + quick-delete affordance, not a second editor).
//
// Polaris Sheet would be the natural choice for a slide-in drawer, but
// Sheet requires a Frame ancestor that conflicts with App Bridge NavMenu
// (same constraint that blocks Polaris Toast — see MemoryToast.tsx).
// Modal works fine in the embedded layout.

type Entry = {
  id: string;
  category: string;
  key: string;
  value: string;
  updatedAt: string;
};

const CATEGORY_LABEL: Record<string, string> = {
  BRAND_VOICE: "Brand voice",
  PRICING_RULES: "Pricing rules",
  PRODUCT_RULES: "Product rules",
  CUSTOMER_RULES: "Customer rules",
  STORE_CONTEXT: "Store context",
  OPERATOR_PREFS: "Operator preferences",
  STRATEGIC_GUARDRAILS: "Strategic guardrails",
};

// Stable display order: guardrails first (load-bearing), then context,
// then voice/style, then operator prefs at the bottom.
const CATEGORY_ORDER = [
  "STRATEGIC_GUARDRAILS",
  "STORE_CONTEXT",
  "BRAND_VOICE",
  "PRICING_RULES",
  "PRODUCT_RULES",
  "CUSTOMER_RULES",
  "OPERATOR_PREFS",
];

export function MemoryPill() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState<number>(0);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/memory");
      if (!res.ok) {
        setEntries([]);
        setCount(0);
        return;
      }
      const data = (await res.json()) as { entries: Entry[] };
      setEntries(data.entries);
      setCount(data.entries.length);
    } catch {
      setEntries([]);
      setCount(0);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch the count on mount so the pill can show "🧠 N things" without
  // requiring a click. Cheap (one indexed query).
  useEffect(() => {
    void fetchEntries();
  }, [fetchEntries]);

  // Refetch on open so the merchant sees fresh state if the CEO saved a
  // memory mid-conversation.
  const handleOpen = useCallback(() => {
    setOpen(true);
    void fetchEntries();
  }, [fetchEntries]);

  const handleDelete = useCallback(
    async (id: string) => {
      // Optimistic — remove locally immediately. Server is source of
      // truth on the next refetch.
      setEntries((prev) => (prev ? prev.filter((e) => e.id !== id) : prev));
      setCount((c) => Math.max(0, c - 1));
      await fetch("/api/memory", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }).catch(() => {
        // Failure → refetch to recover authoritative state.
        void fetchEntries();
      });
    },
    [fetchEntries],
  );

  // Compact pill text. Hidden when count === 0 to avoid clutter on a
  // brand-new store. Once the CEO saves the first fact, it appears.
  if (count === 0 && !loading) return null;

  const grouped = new Map<string, Entry[]>();
  if (entries) {
    for (const e of entries) {
      const arr = grouped.get(e.category) ?? [];
      arr.push(e);
      grouped.set(e.category, arr);
    }
  }

  return (
    <>
      <InlineStack align="start">
        <Button
          variant="tertiary"
          onClick={handleOpen}
          accessibilityLabel="View what the Copilot remembers about your store"
        >
          {`🧠 I remember ${count} thing${count === 1 ? "" : "s"}`}
        </Button>
      </InlineStack>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Store memory"
        primaryAction={{
          content: "Manage in settings",
          onAction: () => {
            // Polaris primaryAction doesn't accept an href in this
            // version, so we close the modal AND navigate
            // programmatically. useNavigate keeps the merchant inside
            // the embedded app (full-page reload would drop the
            // App Bridge session).
            setOpen(false);
            navigate("/app/settings/memory");
          },
        }}
        secondaryActions={[
          { content: "Close", onAction: () => setOpen(false) },
        ]}
      >
        <Modal.Section>
          {loading && entries === null ? (
            <Text as="p" tone="subdued">
              Loading…
            </Text>
          ) : entries && entries.length === 0 ? (
            <EmptyState
              heading="Nothing stored yet"
              image=""
            >
              <p>
                As you chat, the Copilot quietly saves durable facts about
                your brand, pricing rules, and preferences. You can also{" "}
                <Link to="/app/settings/memory">add entries manually</Link>.
              </p>
            </EmptyState>
          ) : (
            <BlockStack gap="400">
              {CATEGORY_ORDER.filter((c) => grouped.has(c)).map((c) => (
                <BlockStack key={c} gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      {CATEGORY_LABEL[c] ?? c}
                    </Text>
                    <Badge tone={c === "STRATEGIC_GUARDRAILS" ? "warning" : "info"}>
                      {String(grouped.get(c)?.length ?? 0)}
                    </Badge>
                  </InlineStack>
                  <BlockStack gap="100">
                    {grouped.get(c)!.map((e) => (
                      <Box
                        key={e.id}
                        padding="200"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        <InlineStack
                          align="space-between"
                          blockAlign="start"
                          wrap={false}
                          gap="200"
                        >
                          <BlockStack gap="050">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              {e.key}
                            </Text>
                            <Text as="p" variant="bodyMd">
                              {e.value}
                            </Text>
                          </BlockStack>
                          <ButtonGroup>
                            <Button
                              tone="critical"
                              variant="plain"
                              onClick={() => handleDelete(e.id)}
                            >
                              Delete
                            </Button>
                          </ButtonGroup>
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                </BlockStack>
              ))}
              <Text as="p" tone="subdued" variant="bodySm">
                To rename, edit, or add entries,{" "}
                <Link to="/app/settings/memory">open the memory settings</Link>.
              </Text>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </>
  );
}
