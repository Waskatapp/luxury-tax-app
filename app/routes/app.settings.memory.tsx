import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  DataTable,
  EmptyState,
  FormLayout,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { MemoryCategory } from "@prisma/client";
import { z } from "zod";

import { requireStoreAccess } from "../lib/auth.server";
import {
  deleteMemory,
  listAllMemory,
  upsertMemory,
} from "../lib/memory/store-memory.server";

type EntryRow = {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  updatedAt: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);
  const entries = await listAllMemory(store.id);
  return {
    entries: entries.map<EntryRow>((e) => ({
      id: e.id,
      category: e.category,
      key: e.key,
      value: e.value,
      updatedAt: e.updatedAt.toISOString(),
    })),
  };
};

const CATEGORY_VALUES = [
  "BRAND_VOICE",
  "PRICING_RULES",
  "PRODUCT_RULES",
  "CUSTOMER_RULES",
  "STORE_CONTEXT",
  "OPERATOR_PREFS",
  "STRATEGIC_GUARDRAILS",
] as const;

const ActionInput = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("upsert"),
    category: z.enum(CATEGORY_VALUES),
    key: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9_]+$/, "key must be snake_case (a-z, 0-9, underscore)"),
    value: z.string().min(1).max(500),
  }),
  z.object({
    intent: z.literal("delete"),
    id: z.string().min(1),
  }),
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { store } = await requireStoreAccess(request);
  const fd = await request.formData();
  const obj = Object.fromEntries(fd);
  const parsed = ActionInput.safeParse(obj);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.message },
      { status: 400 },
    );
  }
  if (parsed.data.intent === "upsert") {
    await upsertMemory(store.id, {
      category: parsed.data.category as MemoryCategory,
      key: parsed.data.key,
      value: parsed.data.value,
    });
    return Response.json({ ok: true });
  }
  // delete
  const ok = await deleteMemory(store.id, parsed.data.id);
  return Response.json({ ok });
};

const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  BRAND_VOICE: "Brand voice",
  PRICING_RULES: "Pricing rules",
  PRODUCT_RULES: "Product rules",
  CUSTOMER_RULES: "Customer rules",
  STORE_CONTEXT: "Store context",
  OPERATOR_PREFS: "Merchant preferences",
  STRATEGIC_GUARDRAILS: "Strategic guardrails",
};

const CATEGORY_OPTIONS = CATEGORY_VALUES.map((v) => ({
  label: CATEGORY_LABEL[v],
  value: v,
}));

export default function MemorySettingsPage() {
  const { entries } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const submitting = fetcher.state !== "idle";

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EntryRow | null>(null);
  const [category, setCategory] = useState<MemoryCategory>("BRAND_VOICE");
  const [keyText, setKeyText] = useState("");
  const [valueText, setValueText] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);

  // Close modal once a successful upsert lands.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && modalOpen) {
      setModalOpen(false);
      setEditing(null);
      setKeyText("");
      setValueText("");
      setKeyError(null);
    }
  }, [fetcher.state, fetcher.data, modalOpen]);

  const openCreate = () => {
    setEditing(null);
    setCategory("BRAND_VOICE");
    setKeyText("");
    setValueText("");
    setKeyError(null);
    setModalOpen(true);
  };

  const openEdit = (row: EntryRow) => {
    setEditing(row);
    setCategory(row.category);
    setKeyText(row.key);
    setValueText(row.value);
    setKeyError(null);
    setModalOpen(true);
  };

  const handleSubmit = () => {
    if (!/^[a-z0-9_]+$/.test(keyText)) {
      setKeyError("Key must be snake_case (a-z, 0-9, underscore).");
      return;
    }
    fetcher.submit(
      {
        intent: "upsert",
        category,
        key: keyText,
        value: valueText,
      },
      { method: "post" },
    );
  };

  const handleDelete = (id: string) => {
    fetcher.submit({ intent: "delete", id }, { method: "post" });
  };

  // V2.1 — render guardrails in their own table above the regular memory.
  // They're load-bearing for CEO behavior (the CEO checks every action
  // against them and warns before violating), so the merchant should see
  // them as a distinct category, not buried in the general memory list.
  const guardrailEntries = entries.filter(
    (e) => e.category === "STRATEGIC_GUARDRAILS",
  );
  const memoryEntries = entries.filter(
    (e) => e.category !== "STRATEGIC_GUARDRAILS",
  );

  const buildRow = (e: EntryRow): React.ReactNode[] => [
    <Badge
      key={`cat-${e.id}`}
      tone={e.category === "STRATEGIC_GUARDRAILS" ? "warning" : "info"}
    >
      {CATEGORY_LABEL[e.category]}
    </Badge>,
    <Text key={`key-${e.id}`} as="span" fontWeight="semibold">
      {e.key}
    </Text>,
    <Text key={`val-${e.id}`} as="span">
      {e.value}
    </Text>,
    new Date(e.updatedAt).toLocaleDateString(),
    <ButtonGroup key={`act-${e.id}`}>
      <Button onClick={() => openEdit(e)} disabled={submitting}>
        Edit
      </Button>
      <Button
        tone="critical"
        variant="plain"
        onClick={() => handleDelete(e.id)}
        disabled={submitting}
      >
        Delete
      </Button>
    </ButtonGroup>,
  ];

  const guardrailRows = guardrailEntries.map(buildRow);
  const memoryRows = memoryEntries.map(buildRow);

  return (
    <Page
      title="Store memory"
      subtitle="Durable facts the Copilot remembers about your store across conversations."
      primaryAction={{
        content: "Add memory",
        onAction: openCreate,
      }}
    >
      <BlockStack gap="400">
        {fetcher.data && fetcher.data.ok === false && fetcher.data.error ? (
          <Banner tone="critical" title="Save failed">
            <p>{fetcher.data.error}</p>
          </Banner>
        ) : null}

        {guardrailEntries.length > 0 ? (
          <Card padding="400">
            <BlockStack gap="200">
              <BlockStack gap="050">
                <Text as="h2" variant="headingMd">
                  Strategic guardrails
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Load-bearing rules the Copilot checks against every action.
                  Before doing anything that would violate one of these, the
                  Copilot warns you and asks for an explicit override.
                </Text>
              </BlockStack>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["Category", "Key", "Value", "Updated", ""]}
                rows={guardrailRows}
              />
            </BlockStack>
          </Card>
        ) : null}

        <Card padding={memoryEntries.length === 0 ? "0" : "400"}>
          {entries.length === 0 ? (
            <div style={{ padding: 24 }}>
              <EmptyState
                heading="No memory yet"
                action={{ content: "Add memory", onAction: openCreate }}
                image=""
              >
                <p>
                  As you chat with the Copilot, it will quietly save durable
                  facts about your brand, pricing rules, and preferences here.
                  You can also add entries manually.
                </p>
              </EmptyState>
            </div>
          ) : memoryEntries.length === 0 ? (
            // Edge case: guardrails exist but no regular memory yet — keep
            // the section visible so adding regular entries stays one click
            // away.
            <div style={{ padding: 24 }}>
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Memory
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  No general memory entries yet. As you chat, the Copilot will
                  save durable facts here.
                </Text>
              </BlockStack>
            </div>
          ) : (
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Memory
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["Category", "Key", "Value", "Updated", ""]}
                rows={memoryRows}
              />
            </BlockStack>
          )}
        </Card>
      </BlockStack>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit memory" : "Add memory"}
        primaryAction={{
          content: editing ? "Save" : "Add",
          onAction: handleSubmit,
          loading: submitting,
          disabled: !keyText.trim() || !valueText.trim(),
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setModalOpen(false) },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <Select
              label="Category"
              options={CATEGORY_OPTIONS}
              value={category}
              onChange={(v) => setCategory(v as MemoryCategory)}
            />
            <TextField
              label="Key"
              value={keyText}
              onChange={(v) => {
                setKeyText(v);
                setKeyError(null);
              }}
              autoComplete="off"
              error={keyError ?? undefined}
              helpText="snake_case identifier — same key overwrites existing value (e.g. brand_voice)"
              disabled={editing !== null}
            />
            <TextField
              label="Value"
              value={valueText}
              onChange={setValueText}
              autoComplete="off"
              multiline={3}
              maxLength={500}
              showCharacterCount
            />
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
