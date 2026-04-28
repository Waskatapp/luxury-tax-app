import { useMemo, useState } from "react";
import {
  ActionList,
  BlockStack,
  Button,
  Card,
  FormLayout,
  InlineStack,
  Modal,
  Popover,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { PlusIcon, MenuIcon } from "@shopify/polaris-icons";

import { ConversationSearch } from "./ConversationSearch";

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
  onRename: (id: string, title: string) => Promise<void> | void;
  creating?: boolean;
  // V2.5 — collapsible sidebar. When true, the sidebar renders an icon-only
  // rail (~64px wide) with just expand + new-chat buttons; the conversation
  // list is hidden until the merchant expands. Persisted at the page level
  // in localStorage so it survives reloads.
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

type Group = {
  label: string;
  items: ConversationSummary[];
};

// Pure derivation from updatedAt — buckets relative to "now" using local
// midnight, so a conversation updated at 23:59 yesterday lands in "Yesterday"
// even if it's currently 00:01 today.
function groupConversations(conversations: ConversationSummary[]): Group[] {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfThisWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;

  const today: ConversationSummary[] = [];
  const yesterday: ConversationSummary[] = [];
  const thisWeek: ConversationSummary[] = [];
  const earlier: ConversationSummary[] = [];

  for (const c of conversations) {
    const t = new Date(c.updatedAt).getTime();
    if (t >= startOfToday) today.push(c);
    else if (t >= startOfYesterday) yesterday.push(c);
    else if (t >= startOfThisWeek) thisWeek.push(c);
    else earlier.push(c);
  }

  const groups: Group[] = [];
  if (today.length) groups.push({ label: "Today", items: today });
  if (yesterday.length) groups.push({ label: "Yesterday", items: yesterday });
  if (thisWeek.length) groups.push({ label: "This week", items: thisWeek });
  if (earlier.length) groups.push({ label: "Earlier", items: earlier });
  return groups;
}

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  creating,
  collapsed = false,
  onToggleCollapsed,
}: Props) {
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(
    null,
  );
  const [pendingRename, setPendingRename] = useState<ConversationSummary | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const groups = useMemo(() => groupConversations(conversations), [conversations]);

  const closeDeleteModal = () => setPendingDelete(null);
  const confirmDelete = () => {
    if (!pendingDelete) return;
    onDelete(pendingDelete.id);
    setPendingDelete(null);
  };

  const closeRenameModal = () => {
    setPendingRename(null);
    setRenameValue("");
  };
  const confirmRename = async () => {
    if (!pendingRename) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    setRenaming(true);
    try {
      await onRename(pendingRename.id, trimmed);
      closeRenameModal();
    } finally {
      setRenaming(false);
    }
  };

  const openMenu = (id: string) => setOpenMenuId(id);
  const closeMenu = () => setOpenMenuId(null);

  const startRename = (c: ConversationSummary) => {
    setPendingRename(c);
    setRenameValue(c.title ?? "");
    closeMenu();
  };

  const startDelete = (c: ConversationSummary) => {
    setPendingDelete(c);
    closeMenu();
  };

  const pendingDeleteTitle =
    pendingDelete?.title ?? `Chat ${pendingDelete?.id.slice(0, 6) ?? ""}`;

  // Collapsed rail: only the toggle (to expand) and a "+" for a new chat.
  // Conversations are hidden — the merchant expands to see the list. Kept
  // intentionally simple to mirror Gemini's slim-rail behavior.
  if (collapsed) {
    return (
      <Card padding="200">
        <BlockStack gap="200" align="start">
          {onToggleCollapsed ? (
            <Tooltip content="Expand conversations">
              <Button
                onClick={onToggleCollapsed}
                variant="tertiary"
                accessibilityLabel="Expand conversations sidebar"
                icon={MenuIcon}
              />
            </Tooltip>
          ) : null}
          <Tooltip content="New conversation">
            <Button
              onClick={onNew}
              variant="primary"
              loading={creating}
              accessibilityLabel="New conversation"
              icon={PlusIcon}
            />
          </Tooltip>
        </BlockStack>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <BlockStack gap="300">
          {onToggleCollapsed ? (
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span" variant="headingSm">
                Conversations
              </Text>
              <Tooltip content="Collapse sidebar">
                <Button
                  onClick={onToggleCollapsed}
                  variant="tertiary"
                  accessibilityLabel="Collapse conversations sidebar"
                  icon={MenuIcon}
                />
              </Tooltip>
            </InlineStack>
          ) : null}
          <ConversationSearch onSelect={onSelect} />
          <Button onClick={onNew} variant="primary" fullWidth loading={creating}>
            New conversation
          </Button>

          {conversations.length === 0 ? (
            <Text as="p" tone="subdued" variant="bodySm">
              No conversations yet.
            </Text>
          ) : (
            <BlockStack gap="300">
              {groups.map((group) => (
                <BlockStack key={group.label} gap="100">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {group.label}
                  </Text>
                  <BlockStack gap="100">
                    {group.items.map((c) => {
                      const isActive = c.id === activeId;
                      const isMenuOpen = openMenuId === c.id;
                      return (
                        <InlineStack key={c.id} gap="100" wrap={false}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Button
                              fullWidth
                              textAlign="start"
                              pressed={isActive}
                              onClick={() => onSelect(c.id)}
                            >
                              {c.title ?? `Chat ${c.id.slice(0, 6)}`}
                            </Button>
                          </div>
                          <Popover
                            active={isMenuOpen}
                            onClose={closeMenu}
                            preferredAlignment="right"
                            activator={
                              <Button
                                accessibilityLabel={`More actions for ${c.title ?? c.id.slice(0, 6)}`}
                                onClick={() =>
                                  isMenuOpen ? closeMenu() : openMenu(c.id)
                                }
                                variant="tertiary"
                              >
                                ⋯
                              </Button>
                            }
                          >
                            <ActionList
                              items={[
                                {
                                  content: "Rename",
                                  onAction: () => startRename(c),
                                },
                                {
                                  content: "Delete",
                                  destructive: true,
                                  onAction: () => startDelete(c),
                                },
                              ]}
                            />
                          </Popover>
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                </BlockStack>
              ))}
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      {pendingRename ? (
        <Modal
          open
          onClose={closeRenameModal}
          title="Rename conversation"
          primaryAction={{
            content: "Save",
            onAction: confirmRename,
            loading: renaming,
            disabled: renaming || renameValue.trim().length === 0,
          }}
          secondaryActions={[
            { content: "Cancel", onAction: closeRenameModal, disabled: renaming },
          ]}
        >
          <Modal.Section>
            <FormLayout>
              <TextField
                label="Title"
                value={renameValue}
                onChange={setRenameValue}
                autoComplete="off"
                maxLength={120}
                showCharacterCount
                disabled={renaming}
              />
            </FormLayout>
          </Modal.Section>
        </Modal>
      ) : null}

      {pendingDelete ? (
        <Modal
          open
          onClose={closeDeleteModal}
          title="Delete this conversation?"
          primaryAction={{
            content: "Yes, delete",
            destructive: true,
            onAction: confirmDelete,
          }}
          secondaryActions={[
            { content: "No, keep it", onAction: closeDeleteModal },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="200">
              <Text as="p">
                You're about to delete{" "}
                <Text as="span" fontWeight="semibold">
                  {pendingDeleteTitle}
                </Text>
                .
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
