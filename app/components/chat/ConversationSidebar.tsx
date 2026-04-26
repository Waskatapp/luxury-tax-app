import { useState } from "react";
import {
  BlockStack,
  Button,
  Card,
  InlineStack,
  Modal,
  Text,
} from "@shopify/polaris";

export type ConversationSummary = {
  id: string;
  title: string | null;
  updatedAt: string;
};

type Props = {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  creating?: boolean;
};

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  creating,
}: Props) {
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(
    null,
  );

  const closeModal = () => setPendingDelete(null);

  const confirmDelete = () => {
    if (!pendingDelete) return;
    onDelete(pendingDelete.id);
    setPendingDelete(null);
  };

  const pendingTitle =
    pendingDelete?.title ?? `Chat ${pendingDelete?.id.slice(0, 6) ?? ""}`;

  return (
    <>
      <Card>
        <BlockStack gap="300">
          <Button onClick={onNew} variant="primary" fullWidth loading={creating}>
            New conversation
          </Button>

          {conversations.length === 0 ? (
            <Text as="p" tone="subdued" variant="bodySm">
              No conversations yet.
            </Text>
          ) : (
            <BlockStack gap="150">
              {conversations.map((c) => {
                const isActive = c.id === activeId;
                return (
                  <InlineStack key={c.id} gap="100" wrap={false}>
                    <div style={{ flex: 1 }}>
                      <Button
                        fullWidth
                        textAlign="start"
                        pressed={isActive}
                        onClick={() => onSelect(c.id)}
                      >
                        {c.title ?? `Chat ${c.id.slice(0, 6)}`}
                      </Button>
                    </div>
                    <Button
                      accessibilityLabel={`Delete chat ${c.id.slice(0, 6)}`}
                      onClick={() => setPendingDelete(c)}
                      variant="tertiary"
                      tone="critical"
                    >
                      Delete
                    </Button>
                  </InlineStack>
                );
              })}
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      {pendingDelete ? (
        <Modal
          open
          onClose={closeModal}
          title="Delete this conversation?"
          primaryAction={{
            content: "Yes, delete",
            destructive: true,
            onAction: confirmDelete,
          }}
          secondaryActions={[
            {
              content: "No, keep it",
              onAction: closeModal,
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="200">
              <Text as="p">
                You're about to delete <Text as="span" fontWeight="semibold">{pendingTitle}</Text>.
              </Text>
              <Text as="p" tone="subdued">
                This can't be undone. The whole chat history and any approved
                actions will stay in your audit log, but the conversation
                disappears from this list.
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      ) : null}
    </>
  );
}
