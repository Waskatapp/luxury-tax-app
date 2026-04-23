import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Banner,
  BlockStack,
  Card,
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
} from "../hooks/useChat";
import { sendChatMessage } from "../hooks/useChatStream";
import {
  ConversationSidebar,
  type ConversationSummary,
} from "../components/chat/ConversationSidebar";
import { ChatInput } from "../components/chat/ChatInput";
import { MessageBubble } from "../components/chat/MessageBubble";

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

  // Load messages when active conversation changes.
  useEffect(() => {
    if (!activeId) {
      dispatch({ type: "RESET" });
      return;
    }

    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/messages?conversationId=${encodeURIComponent(activeId)}`,
          { signal: controller.signal },
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
        };
        const messages: ChatMessage[] = data.messages.map((m) => ({
          id: m.id,
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
          status: "complete",
        }));
        dispatch({ type: "LOAD_MESSAGES", messages });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        dispatch({
          type: "ERROR",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => controller.abort();
  }, [activeId]);

  const handleNew = useCallback(async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/conversations", { method: "POST" });
      if (!res.ok) return;
      const data = (await res.json()) as { conversation: ConversationSummary };
      setConversations((prev) => [data.conversation, ...prev]);
      setActiveId(data.conversation.id);
      dispatch({ type: "LOAD_MESSAGES", messages: [] });
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
    (text: string) => {
      if (!activeId) return;
      sendChatMessage({ conversationId: activeId, text, dispatch });
    },
    [activeId],
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
                <Text as="p" tone="subdued">
                  Tell the Copilot what you want to change — pricing, product
                  descriptions, discounts, analytics.
                </Text>
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
                      <MessageBubble key={m.id} message={m} />
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
