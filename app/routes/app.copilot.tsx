import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import {
  chatReducer,
  INITIAL_CHAT_STATE,
  type ChatMessage,
  type ContentBlock,
  type PendingActionStatus,
} from "../hooks/useChat";
import { continueChat, sendChatMessage } from "../hooks/useChatStream";
import {
  ConversationSidebar,
  type ConversationSummary,
} from "../components/chat/ConversationSidebar";
import { ChatInput } from "../components/chat/ChatInput";
import { MessageBubble } from "../components/chat/MessageBubble";

const SEEDED_PROMPTS = [
  "Show me my top 5 products",
  "How is revenue the last 30 days?",
  "What's running low on stock?",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store } = await requireStoreAccess(request);

  const rows = await prisma.conversation.findMany({
    where: { storeId: store.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, updatedAt: true },
  });

  const conversations: ConversationSummary[] = rows.map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt.toISOString(),
  }));

  return { conversations };
};

export default function CopilotPage() {
  const { conversations: initialConversations } = useLoaderData<typeof loader>();

  const [conversations, setConversations] =
    useState<ConversationSummary[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(
    initialConversations[0]?.id ?? null,
  );
  const [creating, setCreating] = useState(false);
  const [state, dispatch] = useReducer(chatReducer, INITIAL_CHAT_STATE);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.messages]);

  const reloadMessages = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!activeId) return;
      try {
        const res = await fetch(
          `/api/messages?conversationId=${encodeURIComponent(activeId)}`,
          { signal },
        );
        if (!res.ok) {
          dispatch({ type: "ERROR", error: `Load failed (${res.status})` });
          return;
        }
        const data = (await res.json()) as {
          messages: Array<{
            id: string;
            role: string;
            content: ContentBlock[];
            status: "complete";
          }>;
          pendingByToolCallId?: Record<string, PendingActionStatus>;
        };
        const messages: ChatMessage[] = data.messages.map((m) => ({
          id: m.id,
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
          status: "complete",
        }));
        dispatch({
          type: "LOAD_MESSAGES",
          messages,
          pendingByToolCallId: data.pendingByToolCallId ?? {},
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        dispatch({
          type: "ERROR",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeId],
  );

  // Load messages + pending action statuses when active conversation changes.
  useEffect(() => {
    if (!activeId) {
      dispatch({ type: "RESET" });
      return;
    }
    const controller = new AbortController();
    void reloadMessages(controller.signal);
    return () => controller.abort();
  }, [activeId, reloadMessages]);

  const handleNew = useCallback(async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/conversations", { method: "POST" });
      if (!res.ok) return;
      const data = (await res.json()) as { conversation: ConversationSummary };
      setConversations((prev) => [data.conversation, ...prev]);
      setActiveId(data.conversation.id);
      dispatch({
        type: "LOAD_MESSAGES",
        messages: [],
        pendingByToolCallId: {},
      });
    } finally {
      setCreating(false);
    }
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      const res = await fetch("/api/conversations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return;
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) {
        setActiveId(null);
        dispatch({ type: "RESET" });
      }
    },
    [activeId],
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (!activeId) return;
      // Mirror the server-side title logic optimistically.
      const nowIso = new Date().toISOString();
      setConversations((prev) => {
        const next = prev.map((c) =>
          c.id === activeId
            ? {
                ...c,
                title: c.title ?? text.slice(0, 60),
                updatedAt: nowIso,
              }
            : c,
        );
        next.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        return next;
      });
      const outcome = await sendChatMessage({
        conversationId: activeId,
        text,
        dispatch,
      });
      // Replace streamed bubbles with persisted state ONLY on success.
      // LOAD_MESSAGES clears state.error, so reloading after an error would
      // wipe the banner the merchant needs to see.
      if (outcome === "done") await reloadMessages();
    },
    [activeId, reloadMessages],
  );

  const handleApprove = useCallback(
    async (toolCallId: string) => {
      if (!activeId) return;
      // Optimistic: mark APPROVED while the server runs the mutation.
      dispatch({ type: "TOOL_STATUS", toolCallId, status: "APPROVED" });
      try {
        const res = await fetch("/api/tool-approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolCallId }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          status?: PendingActionStatus;
          error?: string;
          conversationId?: string;
        };
        const finalStatus: PendingActionStatus =
          body.status ?? (body.ok ? "EXECUTED" : "FAILED");
        dispatch({ type: "TOOL_STATUS", toolCallId, status: finalStatus });
        if (!body.ok && body.error) {
          dispatch({ type: "ERROR", error: body.error });
        }
        // Trigger continuation either way — Gemini summarizes success or
        // explains the error from the synthesized tool_result row.
        const outcome = await continueChat({
          conversationId: activeId,
          dispatch,
        });
        if (outcome === "done") await reloadMessages();
      } catch (err) {
        dispatch({
          type: "ERROR",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeId, reloadMessages],
  );

  const handleReject = useCallback(
    async (toolCallId: string) => {
      if (!activeId) return;
      dispatch({ type: "TOOL_STATUS", toolCallId, status: "REJECTED" });
      try {
        await fetch("/api/tool-reject", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolCallId }),
        });
        const outcome = await continueChat({
          conversationId: activeId,
          dispatch,
        });
        if (outcome === "done") await reloadMessages();
      } catch (err) {
        dispatch({
          type: "ERROR",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeId, reloadMessages],
  );

  const sending = state.phase === "streaming";
  const hasActive = activeId !== null;

  return (
    <Page title="Copilot" fullWidth>
      <Layout>
        <Layout.Section variant="oneThird">
          <ConversationSidebar
            conversations={conversations}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={handleNew}
            onDelete={handleDelete}
            creating={creating}
          />
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {state.error ? (
                <Banner tone="critical" title="Something went wrong">
                  <p>{state.error}</p>
                </Banner>
              ) : null}

              {!hasActive ? (
                <Text as="p" tone="subdued">
                  Start a new conversation to begin.
                </Text>
              ) : state.messages.length === 0 ? (
                <BlockStack gap="300">
                  <Text as="p" tone="subdued">
                    Tell the Copilot what you want to change — pricing, product
                    descriptions, discounts, analytics. Or try one of these:
                  </Text>
                  <InlineStack gap="200" wrap>
                    {SEEDED_PROMPTS.map((prompt) => (
                      <Button
                        key={prompt}
                        onClick={() => handleSend(prompt)}
                        disabled={sending}
                      >
                        {prompt}
                      </Button>
                    ))}
                  </InlineStack>
                </BlockStack>
              ) : (
                <div
                  style={{
                    maxHeight: 520,
                    overflowY: "auto",
                    paddingRight: 4,
                  }}
                >
                  <BlockStack gap="300">
                    {state.messages.map((m) => (
                      <MessageBubble
                        key={m.id}
                        message={m}
                        pendingByToolCallId={state.pendingByToolCallId}
                        onApprove={handleApprove}
                        onReject={handleReject}
                      />
                    ))}
                    <div ref={messagesEndRef} />
                  </BlockStack>
                </div>
              )}

              <ChatInput disabled={!hasActive || sending} onSend={handleSend} />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
