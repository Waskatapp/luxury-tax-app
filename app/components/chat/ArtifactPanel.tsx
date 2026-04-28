import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  ButtonGroup,
  InlineStack,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";

// V2.5 — Artifacts Canvas. The editable side panel for the CEO's prose
// drafts. Today only `description` (product description HTML), but the
// per-kind editor switch + content shape is structured so future kinds
// (discount-config, promo-copy) drop into a new case without rewriting
// the panel shell.
//
// Why not Polaris Sheet: Sheet requires a Frame ancestor that conflicts
// with App Bridge NavMenu — same constraint that blocks Polaris Toast
// (see MemoryToast.tsx) and the Memory pill drawer (which became a
// Modal). The panel renders as a third grid column in app.copilot.tsx
// so it sits side-by-side with the chat without needing Frame.

export type ArtifactPanelData = {
  id: string;
  toolCallId: string;
  kind: string; // "description" today
  productId: string;
  productTitle: string;
  content: string; // HTML for description kind
};

type Props = {
  artifact: ArtifactPanelData;
  // Called with the latest content. Parent debounces / awaits the PATCH —
  // ArtifactPanel just reports edits.
  onSave: (content: string) => Promise<void> | void;
  onApprove: () => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
  // Closes the panel without flipping artifact status. Used when the
  // merchant just wants to collapse the panel and decide later. The
  // artifact stays DRAFT in the DB so reload reopens it.
  onCollapse: () => void;
  busy?: boolean;
};

const AUTOSAVE_DEBOUNCE_MS = 800;

export function ArtifactPanel({
  artifact,
  onSave,
  onApprove,
  onDiscard,
  onCollapse,
  busy,
}: Props) {
  // Local content so the textarea is responsive — the parent only sees
  // saved snapshots (debounced). Reset whenever the artifact id changes
  // (new draft from a different propose_artifact call).
  const [content, setContent] = useState(artifact.content);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved">(
    "saved",
  );
  const lastSavedRef = useRef(artifact.content);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const artifactIdRef = useRef(artifact.id);

  // When the panel switches to a new artifact (CEO drafted another one),
  // wipe local edit state so we don't accidentally save the old artifact's
  // edits to the new one.
  useEffect(() => {
    if (artifactIdRef.current !== artifact.id) {
      artifactIdRef.current = artifact.id;
      setContent(artifact.content);
      lastSavedRef.current = artifact.content;
      setSavingState("saved");
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    }
  }, [artifact.id, artifact.content]);

  const flushSave = useCallback(
    async (next: string) => {
      if (next === lastSavedRef.current) {
        setSavingState("saved");
        return;
      }
      setSavingState("saving");
      try {
        await onSave(next);
        lastSavedRef.current = next;
        setSavingState("saved");
      } catch {
        // Surface as "idle" so the merchant knows it didn't save and can
        // edit again to retry. The parent should also surface a toast or
        // banner on PATCH failure.
        setSavingState("idle");
      }
    },
    [onSave],
  );

  const handleChange = useCallback(
    (next: string) => {
      setContent(next);
      setSavingState("idle");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void flushSave(next);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [flushSave],
  );

  // Make sure we save on unmount (panel close mid-edit) so changes aren't lost.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        // Best-effort sync flush — the parent's onSave is async fetch,
        // which is fine since the browser keeps it alive briefly. If
        // the merchant fully navigates away, that's their call.
        if (content !== lastSavedRef.current) {
          void onSave(content);
        }
      }
    };
    // We deliberately don't depend on `content` here — only the unmount
    // cleanup path matters. Re-running on every keystroke would cancel
    // the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleApprove = useCallback(async () => {
    // Flush any pending edit so the approval uses the latest content.
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (content !== lastSavedRef.current) {
      await flushSave(content);
    }
    await onApprove();
  }, [content, flushSave, onApprove]);

  const charCount = content.length;
  const charBadge =
    charCount === 0
      ? "Empty"
      : `${charCount.toLocaleString()} char${charCount === 1 ? "" : "s"}`;

  const savingLabel =
    savingState === "saving"
      ? "Saving…"
      : savingState === "saved"
        ? "Saved"
        : "Unsaved changes";
  const savingTone: "success" | "attention" | "info" =
    savingState === "saved"
      ? "success"
      : savingState === "saving"
        ? "info"
        : "attention";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        background: "#ffffff",
        border: "1px solid var(--p-color-border, #e1e3e5)",
        borderRadius: 12,
        padding: 16,
        boxShadow: "0 1px 0 rgba(0, 0, 0, 0.05)",
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* Header */}
      <BlockStack gap="100">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <Text as="h2" variant="headingMd">
            Editing draft
          </Text>
          <Tooltip content="Close panel (draft is saved — Approve or Discard from chat to finalize)">
            <Button onClick={onCollapse} variant="tertiary" size="slim">
              ✕
            </Button>
          </Tooltip>
        </InlineStack>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Text as="span" variant="bodySm" tone="subdued">
            {artifact.productTitle}
          </Text>
          <Badge tone={savingTone}>{savingLabel}</Badge>
          <Text as="span" variant="bodySm" tone="subdued">
            {charBadge}
          </Text>
        </InlineStack>
      </BlockStack>

      {/* Editor — fills available vertical space */}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TextField
            label="Description HTML"
            labelHidden
            value={content}
            onChange={handleChange}
            multiline={20}
            autoComplete="off"
            placeholder="The CEO's draft will appear here. Edit freely; changes auto-save."
            disabled={busy}
          />
        </div>
      </div>

      {/* Footer actions */}
      <InlineStack align="space-between" blockAlign="center" wrap={false}>
        <Text as="span" variant="bodySm" tone="subdued">
          On approve: this content replaces the product&apos;s description in
          Shopify.
        </Text>
        <ButtonGroup>
          <Button
            onClick={() => void onDiscard()}
            tone="critical"
            variant="tertiary"
            disabled={busy}
          >
            Discard
          </Button>
          <Button
            onClick={() => void handleApprove()}
            variant="primary"
            loading={busy}
            disabled={content.trim().length === 0}
          >
            Approve &amp; apply
          </Button>
        </ButtonGroup>
      </InlineStack>
    </div>
  );
}
