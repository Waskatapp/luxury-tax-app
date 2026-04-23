import { BlockStack, Button, Card, InlineStack, Text } from "@shopify/polaris";

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
  return (
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
                    onClick={() => onDelete(c.id)}
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
  );
}
