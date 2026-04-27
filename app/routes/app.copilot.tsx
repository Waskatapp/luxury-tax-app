import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Banner,
  BlockStack,
  Button,
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
  type PendingActionStatus,
} from "../hooks/useChat";
import { continueChat, sendChatMessage } from "../hooks/useChatStream";
import {
  ConversationSidebar,
  type ConversationSummary,
} from "../components/chat/ConversationSidebar";
import { ChatInput } from "../components/chat/ChatInput";
import { MessageBubble } from "../components/chat/MessageBubble";
import {
  MemoryToastStack,
  type MemoryToastEntry,
} from "../components/chat/MemoryToast";
import { EmptyStateGuide } from "../components/chat/EmptyStateGuide";

// Distance from scroll bottom (in px) below which we consider the merchant
// "at the bottom" — auto-scroll on new messages stays on, no pop-up button.
const AT_BOTTOM_THRESHOLD = 80;

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
  const [memoryToasts, setMemoryToasts] = useState<MemoryToastEntry[]>([]);

  const handleMemorySaved = useCallback((entry: MemoryToastEntry) => {
    // Append; auto-dismiss inside the toast component manages its own
    // lifetime, but a 4-toast cap keeps the stack readable.
    setMemoryToasts((prev) => [...prev, entry].slice(-4));
  }, []);

  const handleMemoryDismiss = useCallback((id: string) => {
    setMemoryToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const handleMemoryUndo = useCallback(async (id: string) => {
    setMemoryToasts((prev) => prev.filter((t) => t.id !== id));
    await fetch("/api/memory", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {
      // If undo fails, the toast is already gone — surface nothing.
      // The merchant can re-delete from /app/settings/memory.
    });
  }, []);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // The retry function for the most recent failed stream. Banner shows
  // "Try again" only when this is set + state.error is set. Cleared on
  // success, on conversation change, on user dismiss.
  const retryFnRef = useRef<(() => Promise<void>) | null>(null);

  // Auto-scroll on new messages only when the merchant is already at the
  // bottom — don't yank them down if they scrolled up to read history.
  useEffect(() => {
    if (isAtBottom) {
      messagesEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
  }, [state.messages, state.runningTool, isAtBottom]);

  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsAtBottom(distanceFromBottom < AT_BOTTOM_THRESHOLD);
  }, []);

  const scrollToBottom = useCallback(() => {
    setIsAtBottom(true);
    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, []);

  const reloadMessages = useCallback(
    async (signal?: AbortSignal): Promise<ChatMessage[] | null> => {
      if (!activeId) return null;
      try {
        const res = await fetch(
          `/api/messages?conversationId=${encodeURIComponent(activeId)}`,
          { signal },
        );
        if (!res.ok) {
          dispatch({ type: "ERROR", error: `Load failed (${res.status})` });
          return null;
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
        return messages;
      } catch (err) {
        if ((err as Error).name === "AbortError") return null;
        dispatch({
          type: "ERROR",
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
    [activeId],
  );

  // Reads the most recent user-text from a loaded message list. Used by the
  // retry path to decide whether the failed turn was already persisted on
  // the server (→ continueChat) or needs to be re-sent (→ handleSend).
  function findLastUserText(messages: ChatMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user") continue;
      for (const b of m.content) {
        if (b.type === "text") return b.text;
      }
      return null;
    }
    return null;
  }

  // Load messages + pending action statuses when active conversation changes.
  useEffect(() => {
    retryFnRef.current = null;
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

  const handleRename = useCallback(
    async (id: string, title: string): Promise<void> => {
      const res = await fetch("/api/conversations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, title }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { conversation: ConversationSummary };
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? data.conversation : c)),
      );
    },
    [],
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (!activeId) return;
      const conversationId = activeId;
      // Mirror the server-side title logic optimistically.
      const nowIso = new Date().toISOString();
      setConversations((prev) => {
        const next = prev.map((c) =>
          c.id === conversationId
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
      // Sending takes the merchant back to the bottom; clear retry state.
      setIsAtBottom(true);
      retryFnRef.current = null;
      const outcome = await sendChatMessage({
        conversationId,
        text,
        dispatch,
        onMemorySaved: handleMemorySaved,
      });
      // Replace streamed bubbles with persisted state ONLY on success.
      // LOAD_MESSAGES clears state.error, so reloading after an error would
      // wipe the banner the merchant needs to see.
      if (outcome === "done") {
        retryFnRef.current = null;
        await reloadMessages();
        return;
      }

      // "error" or "truncated" — set up an unlimited-retry loop. The retry
      // function picks its path based on whether the user message reached
      // the DB on the failed attempt:
      //   - already persisted (Gemini RPM mid-stream) → continueChat
      //     (no optimistic SEND_START, so no duplicate user bubble)
      //   - not persisted (chat rate limit pre-stream) → handleSend
      //     (re-sends; server-side dedupe protects the DB)
      const captured = text;
      const buildRetry = (): (() => Promise<void>) => async () => {
        dispatch({ type: "RESET" });
        const loaded = await reloadMessages();
        if (loaded === null) return;
        const lastUser = findLastUserText(loaded);
        // Server truncates user input to 4000 chars; replicate so a long
        // message that was sliced in the DB still matches its captured form.
        const alreadyPersisted =
          lastUser !== null && lastUser === captured.slice(0, 4000);
        if (alreadyPersisted) {
          const o = await continueChat({
            conversationId,
            dispatch,
            onMemorySaved: handleMemorySaved,
          });
          if (o === "done") {
            retryFnRef.current = null;
            await reloadMessages();
          } else {
            // Failed again — keep the merchant able to retry until it works.
            retryFnRef.current = buildRetry();
          }
        } else {
          await handleSend(captured);
        }
      };
      retryFnRef.current = buildRetry();
    },
    [activeId, reloadMessages, handleMemorySaved],
  );

  const handleApprove = useCallback(
    async (toolCallId: string) => {
      if (!activeId) return;
      const conversationId = activeId;
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
          conversationId,
          dispatch,
        });
        if (outcome === "done") {
          retryFnRef.current = null;
          await reloadMessages();
        } else {
          // "error" or "truncated" — keep retry available indefinitely.
          // RESET + reloadMessages each attempt so we don't stack
          // placeholder "Something went wrong" bubbles when continueChat
          // fails repeatedly.
          const buildRetry = (): (() => Promise<void>) => async () => {
            dispatch({ type: "RESET" });
            const loaded = await reloadMessages();
            if (loaded === null) return;
            const o = await continueChat({ conversationId, dispatch });
            if (o === "done") {
              retryFnRef.current = null;
              await reloadMessages();
            } else {
              retryFnRef.current = buildRetry();
            }
          };
          retryFnRef.current = buildRetry();
        }
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
      const conversationId = activeId;
      dispatch({ type: "TOOL_STATUS", toolCallId, status: "REJECTED" });
      try {
        await fetch("/api/tool-reject", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolCallId }),
        });
        const outcome = await continueChat({
          conversationId,
          dispatch,
        });
        if (outcome === "done") {
          retryFnRef.current = null;
          await reloadMessages();
        } else {
          const buildRetry = (): (() => Promise<void>) => async () => {
            const o = await continueChat({ conversationId, dispatch });
            if (o === "done") {
              retryFnRef.current = null;
              await reloadMessages();
            } else {
              retryFnRef.current = buildRetry();
            }
          };
          retryFnRef.current = buildRetry();
        }
      } catch (err) {
        dispatch({
          type: "ERROR",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [activeId, reloadMessages],
  );

  const handleRetry = useCallback(async () => {
    if (!activeId) return;
    const conversationId = activeId;
    const fn = retryFnRef.current;
    retryFnRef.current = null;

    // In-memory retry path: handleSend / handleApprove / handleReject set
    // this on stream failure so they can re-send the right thing (with
    // dedupe + correct outcome handling). Use it if available.
    if (fn) {
      await fn();
      return;
    }

    // Data-derived fallback: we get here when the merchant switched
    // conversations and came back, refreshed the page, OR the in-memory
    // retry function was somehow cleared but the conversation still has
    // unfinished business. RESET + reloadMessages BEFORE continueChat is
    // critical — otherwise each retry appends a new placeholder to
    // state.messages, stacking "Something went wrong" bubbles.
    const buildRetry = (): (() => Promise<void>) => async () => {
      dispatch({ type: "RESET" });
      const loaded = await reloadMessages();
      if (loaded === null) return;
      const o = await continueChat({
        conversationId,
        dispatch,
        onMemorySaved: handleMemorySaved,
      });
      if (o === "done") {
        retryFnRef.current = null;
        await reloadMessages();
      } else {
        retryFnRef.current = buildRetry();
      }
    };
    await buildRetry()();
  }, [activeId, reloadMessages, handleMemorySaved]);

  const sending = state.phase === "streaming";
  const hasActive = activeId !== null;

  // Detect "stuck" conversation states — when the in-memory error is gone
  // (e.g. after switching conversations and coming back) but the DB shows
  // the merchant is owed a response.
  const lastMessage =
    state.messages.length > 0
      ? state.messages[state.messages.length - 1]
      : null;
  const lastIsUnansweredUser =
    !sending && lastMessage?.role === "user";
  const lastIsUnsummarizedAssistant =
    !sending &&
    lastMessage?.role === "assistant" &&
    (() => {
      const toolUses = lastMessage.content.filter(
        (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
          b.type === "tool_use",
      );
      if (toolUses.length === 0) return false;
      // All write-tool decisions reached a terminal state (executed / rejected
      // / failed) but no summarizing assistant turn followed.
      return toolUses.every((tu) => {
        const status = state.pendingByToolCallId[tu.id];
        return (
          status === "EXECUTED" ||
          status === "REJECTED" ||
          status === "FAILED"
        );
      });
    })();
  const dataDerivedStuck = lastIsUnansweredUser || lastIsUnsummarizedAssistant;

  // canRetry intentionally does NOT depend on retryFnRef.current — that ref
  // is in-memory-only and any stale-ref / fast-click / fallback edge case can
  // null it while state.error is still set. Whenever an error banner is
  // visible (or the conversation looks stuck from data alone), the merchant
  // must be able to click Try again. handleRetry handles both the in-memory
  // and the no-ref case via its data-derived fallback.
  const canRetry =
    !sending && (state.error !== null || dataDerivedStuck);

  return (
    <Page title="Copilot" fullWidth>
      <MemoryToastStack
        toasts={memoryToasts}
        onUndo={handleMemoryUndo}
        onDismiss={handleMemoryDismiss}
      />
      <Layout>
        <Layout.Section variant="oneThird">
          <ConversationSidebar
            conversations={conversations}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={handleNew}
            onDelete={handleDelete}
            onRename={handleRename}
            creating={creating}
          />
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {state.error ? (
                <Banner
                  tone="critical"
                  title="Something went wrong"
                  action={
                    canRetry
                      ? { content: "Try again", onAction: handleRetry }
                      : undefined
                  }
                >
                  <p>{state.error}</p>
                </Banner>
              ) : dataDerivedStuck ? (
                // No in-memory error but the conversation is owed a response —
                // typical after switching conversations / refreshing during a
                // rate-limited turn. Surface a softer banner so the merchant
                // can pick up where they left off.
                <Banner
                  tone="warning"
                  title="Awaiting Copilot's response"
                  action={{ content: "Try again", onAction: handleRetry }}
                >
                  <p>
                    Your last message wasn't answered — likely a brief
                    rate-limit hiccup. Click "Try again" to continue.
                  </p>
                </Banner>
              ) : null}

              {!hasActive ? (
                <Text as="p" tone="subdued">
                  Start a new conversation to begin.
                </Text>
              ) : state.messages.length === 0 ? (
                <EmptyStateGuide onSelect={handleSend} disabled={sending} />
              ) : (
                <div style={{ position: "relative" }}>
                  <div
                    ref={messagesContainerRef}
                    onScroll={handleScroll}
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
                          runningTool={state.runningTool}
                          onApprove={handleApprove}
                          onReject={handleReject}
                        />
                      ))}
                      <div ref={messagesEndRef} />
                    </BlockStack>
                  </div>
                  {!isAtBottom ? (
                    <div
                      style={{
                        position: "absolute",
                        bottom: 12,
                        right: 16,
                        zIndex: 1,
                      }}
                    >
                      <Button onClick={scrollToBottom} variant="primary">
                        ↓ Latest
                      </Button>
                    </div>
                  ) : null}
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
