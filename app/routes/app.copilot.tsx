import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Banner,
  BlockStack,
  Button,
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
import { MemoryPill } from "../components/chat/MemoryPill";
import { MessageBubble } from "../components/chat/MessageBubble";
import {
  MemoryToastStack,
  type MemoryToastEntry,
} from "../components/chat/MemoryToast";
import {
  EmptyStateGuide,
  type Suggestion,
} from "../components/chat/EmptyStateGuide";
import { pickSuggestions } from "../lib/agent/suggestions.server";
import { log } from "../lib/log.server";

// Distance from scroll bottom (in px) below which we consider the merchant
// "at the bottom" — auto-scroll on new messages stays on, no pop-up button.
const AT_BOTTOM_THRESHOLD = 80;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store, admin } = await requireStoreAccess(request);

  // Sidebar excludes conversations whose title hasn't been generated yet.
  // The LLM title generator (api.chat.tsx) sets it after the first
  // assistant turn; until then we'd be showing "Chat <cuid>" placeholders
  // which look broken. After the SSE conversation_titled event fires, the
  // client adds the conversation to the sidebar in real time.
  const rows = await prisma.conversation.findMany({
    where: { storeId: store.id, title: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, updatedAt: true },
  });

  const conversations: ConversationSummary[] = rows.map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt.toISOString(),
  }));

  // Welcome-screen suggestions. Failure is non-fatal — pickSuggestions has
  // its own onboarding fallback, but if even that throws we surface an
  // empty array and EmptyStateGuide renders its own static fallback.
  let suggestions: Suggestion[] = [];
  try {
    suggestions = await pickSuggestions(store.id, admin);
  } catch (err) {
    log.warn("copilot loader: pickSuggestions threw (non-fatal)", {
      storeId: store.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return { conversations, suggestions, shopDomain: store.shopDomain };
};

export default function CopilotPage() {
  const {
    conversations: initialConversations,
    suggestions,
    shopDomain,
  } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  const [conversations, setConversations] =
    useState<ConversationSummary[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(
    initialConversations[0]?.id ?? null,
  );
  const [creating, setCreating] = useState(false);
  // V2.5 — sidebar collapse. Default to expanded; useEffect below reads
  // localStorage post-mount so SSR + hydration stay consistent. Persisted
  // so the merchant's preference survives reloads.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("copilot.sidebarCollapsed") === "1") {
        setSidebarCollapsed(true);
      }
    } catch {
      // Storage blocked — fine, sidebar stays expanded.
    }
  }, []);
  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("copilot.sidebarCollapsed", next ? "1" : "0");
      } catch {
        // Storage blocked — preference is per-session, no big deal.
      }
      return next;
    });
  }, []);
  const [state, dispatch] = useReducer(chatReducer, INITIAL_CHAT_STATE);
  const [memoryToasts, setMemoryToasts] = useState<MemoryToastEntry[]>([]);
  // V2.3 — Plan rows for the active conversation, keyed by toolCallId. We
  // keep this OUT of the chat reducer because it's a server-derived sidecar
  // (same shape as pendingByToolCallId) and the reducer cases stay simpler
  // when only the message list + pending statuses live there. Updated in
  // reloadMessages alongside pendingByToolCallId; cleared on conversation
  // switch via the same useEffect.
  const [planByToolCallId, setPlanByToolCallId] = useState<
    Record<
      string,
      {
        id: string;
        summary: string;
        steps: Array<{
          description: string;
          departmentId: string;
          estimatedTool?: string | undefined;
        }>;
        status: "PENDING" | "APPROVED" | "REJECTED";
      }
    >
  >({});

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

  // Suggestion impression tracking. We log one batched impression event when
  // the welcome screen mounts with non-empty suggestions and haven't already
  // logged for this exact set of templateIds. Tracked by a ref of the last
  // logged signature so re-renders don't double-log.
  const lastLoggedImpressionsRef = useRef<string | null>(null);
  const postSuggestionEvents = useCallback(
    (
      events: Array<{
        templateId: string;
        slotPosition: number;
        eventType: "impression" | "click";
        conversationId?: string;
      }>,
    ): void => {
      if (events.length === 0) return;
      const body = JSON.stringify({ events });
      // sendBeacon is queued by the browser and survives navigation — perfect
      // for fire-and-forget telemetry. Falls back to keepalive fetch if the
      // beacon API isn't available or the browser refuses (rare).
      try {
        if (typeof navigator !== "undefined" && navigator.sendBeacon) {
          const blob = new Blob([body], { type: "application/json" });
          if (navigator.sendBeacon("/api/suggestion-event", blob)) return;
        }
      } catch {
        /* fall through */
      }
      void fetch("/api/suggestion-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {
        // Telemetry failures are silent by design.
      });
    },
    [],
  );

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
          planByToolCallId?: Record<
            string,
            {
              id: string;
              summary: string;
              steps: Array<{
                description: string;
                departmentId: string;
                estimatedTool?: string | undefined;
              }>;
              status: "PENDING" | "APPROVED" | "REJECTED";
            }
          >;
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
        setPlanByToolCallId(data.planByToolCallId ?? {});
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
      // Deliberately NOT adding to setConversations here — the new row's
      // title is null until the LLM title generator fires after the first
      // assistant turn. We add it to the sidebar via the SSE
      // conversation_titled handler below, which routes through
      // handleConversationTitled. The chat panel still renders for
      // activeId because the loader returns the conversation by id; the
      // sidebar just doesn't show it yet.
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

  // Inserts a freshly-titled conversation into the sidebar. Fired by the
  // server's `conversation_titled` SSE event the first time it sets a
  // title for a conversation. If the conversation is already in the list
  // (e.g. user renamed via PATCH and a follow-up turn re-emitted the
  // event somehow), the existing entry is updated in place.
  const handleConversationTitled = useCallback(
    (payload: { conversationId: string; title: string }) => {
      const nowIso = new Date().toISOString();
      setConversations((prev) => {
        const exists = prev.some((c) => c.id === payload.conversationId);
        const next = exists
          ? prev.map((c) =>
              c.id === payload.conversationId
                ? { ...c, title: payload.title, updatedAt: nowIso }
                : c,
            )
          : [
              {
                id: payload.conversationId,
                title: payload.title,
                updatedAt: nowIso,
              },
              ...prev,
            ];
        next.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        return next;
      });
    },
    [],
  );

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
      // We used to optimistically set a sidebar title from `text.slice(0,
      // 60)` here, which produced ugly mid-word truncations. The server
      // now generates the title via Gemini Flash-Lite after the first
      // assistant turn and emits `conversation_titled` — handled below
      // via onConversationTitled. For conversations already in the
      // sidebar (i.e. follow-up turns), bump updatedAt so the row sorts
      // to the top. Untitled conversations stay out of the sidebar
      // entirely until the title event fires.
      setConversations((prev) => {
        if (!prev.some((c) => c.id === conversationId)) return prev;
        const nowIso = new Date().toISOString();
        const next = prev.map((c) =>
          c.id === conversationId ? { ...c, updatedAt: nowIso } : c,
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
        onConversationTitled: handleConversationTitled,
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
            onConversationTitled: handleConversationTitled,
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
    [activeId, reloadMessages, handleMemorySaved, handleConversationTitled],
  );

  const handleApprove = useCallback(
    async (toolCallIds: string[]) => {
      if (!activeId || toolCallIds.length === 0) return;
      const conversationId = activeId;
      // Optimistic: mark each as APPROVED while the server runs the writes
      // sequentially. Each row's status is reset to its real terminal value
      // once the response comes back.
      for (const id of toolCallIds) {
        dispatch({ type: "TOOL_STATUS", toolCallId: id, status: "APPROVED" });
      }
      try {
        const res = await fetch("/api/tool-approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolCallIds }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          results?: Array<{
            toolCallId: string;
            status: PendingActionStatus;
            error?: string;
          }>;
          conversationId?: string;
        };
        for (const r of body.results ?? []) {
          dispatch({
            type: "TOOL_STATUS",
            toolCallId: r.toolCallId,
            status: r.status,
          });
        }
        // Surface the FIRST per-row error so the banner is informative;
        // continueChat fires regardless so Gemini summarizes whatever ran.
        const firstError = (body.results ?? []).find((r) => r.error)?.error;
        if (!body.ok && firstError) {
          dispatch({ type: "ERROR", error: firstError });
        }
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
    async (toolCallIds: string[]) => {
      if (!activeId || toolCallIds.length === 0) return;
      const conversationId = activeId;
      for (const id of toolCallIds) {
        dispatch({ type: "TOOL_STATUS", toolCallId: id, status: "REJECTED" });
      }
      try {
        await fetch("/api/tool-reject", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolCallIds }),
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

  // V2.3 — Plan approve/reject. Same pattern as tool approve/reject:
  // POST the decision, then continueChat so the CEO summarizes (and on
  // approval, starts walking through the plan's steps — each WRITE step
  // still hits its own ApprovalCard).
  const handleApprovePlan = useCallback(
    async (toolCallId: string) => {
      if (!activeId) return;
      const conversationId = activeId;
      // Optimistic — flip the sidecar so the card visibly locks while
      // the request is in flight. Reload after continueChat will
      // replace this with server-authoritative state.
      setPlanByToolCallId((prev) => {
        const existing = prev[toolCallId];
        if (!existing) return prev;
        return { ...prev, [toolCallId]: { ...existing, status: "APPROVED" } };
      });
      try {
        const res = await fetch("/api/plan-approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolCallId }),
        });
        if (!res.ok) {
          dispatch({
            type: "ERROR",
            error: `Plan approve failed (${res.status})`,
          });
          return;
        }
        const outcome = await continueChat({ conversationId, dispatch });
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

  const handleRejectPlan = useCallback(
    async (toolCallId: string) => {
      if (!activeId) return;
      const conversationId = activeId;
      setPlanByToolCallId((prev) => {
        const existing = prev[toolCallId];
        if (!existing) return prev;
        return { ...prev, [toolCallId]: { ...existing, status: "REJECTED" } };
      });
      try {
        const res = await fetch("/api/plan-reject", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolCallId }),
        });
        if (!res.ok) {
          dispatch({
            type: "ERROR",
            error: `Plan reject failed (${res.status})`,
          });
          return;
        }
        const outcome = await continueChat({ conversationId, dispatch });
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
        onConversationTitled: handleConversationTitled,
      });
      if (o === "done") {
        retryFnRef.current = null;
        await reloadMessages();
      } else {
        retryFnRef.current = buildRetry();
      }
    };
    await buildRetry()();
  }, [activeId, reloadMessages, handleMemorySaved, handleConversationTitled]);

  const sending = state.phase === "streaming";
  const hasActive = activeId !== null;

  // Click handler for EmptyStateGuide: log click telemetry first (fire-and-
  // forget), then send the prompt through the regular chat path. Telemetry
  // never blocks the chat send.
  const handleSuggestionSelect = useCallback(
    (suggestion: Suggestion, slotPosition: number) => {
      postSuggestionEvents([
        {
          templateId: suggestion.templateId,
          slotPosition,
          eventType: "click",
          conversationId: activeId ?? undefined,
        },
      ]);
      void handleSend(suggestion.prompt);
    },
    [activeId, handleSend, postSuggestionEvents],
  );

  // Refresh suggestions: revalidate the loader, which re-runs pickSuggestions
  // and may rotate the visible set (Flash-Lite picks different members of the
  // heuristic top 8 between calls). The next mount-impression will fire from
  // the impressions effect below once suggestions change.
  const handleRefreshSuggestions = useCallback(() => {
    lastLoggedImpressionsRef.current = null;
    revalidator.revalidate();
  }, [revalidator]);

  const showWelcome =
    hasActive && state.messages.length === 0 && !sending;

  // Log an impression batch the first time the welcome screen renders with
  // a given set of templateIds. The ref-based signature prevents duplicate
  // logging across re-renders while still allowing a fresh log when the
  // merchant clicks Refresh and a different set comes back.
  useEffect(() => {
    if (!showWelcome) return;
    if (suggestions.length === 0) return;
    const signature = suggestions.map((s) => s.templateId).join("|");
    if (lastLoggedImpressionsRef.current === signature) return;
    lastLoggedImpressionsRef.current = signature;
    postSuggestionEvents(
      suggestions.map((s, idx) => ({
        templateId: s.templateId,
        slotPosition: idx,
        eventType: "impression" as const,
      })),
    );
  }, [showWelcome, suggestions, postSuggestionEvents]);

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
      {/*
        V2.5 — Gemini-style two-column shell. The grid itself is viewport-
        height (minus page chrome), so neither column can push the page
        below the fold. Both the sidebar and the chat get their own
        internal overflow:auto, mirroring how Gemini / Claude.ai keep
        the conversation list and the active thread independently
        scrollable while the page itself stays put.
      */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `${sidebarCollapsed ? "64px" : "280px"} minmax(0, 1fr)`,
          gap: "16px",
          height: "calc(100vh - 140px)",
          minHeight: 480,
        }}
      >
        {/* Sidebar column — independent scroll */}
        <div style={{ overflowY: "auto", minHeight: 0 }}>
          <ConversationSidebar
            conversations={conversations}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={handleNew}
            onDelete={handleDelete}
            onRename={handleRename}
            creating={creating}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={handleToggleSidebar}
          />
        </div>

        {/*
          Chat column — fills the column height. Inside, a flex column
          where the messages area gets flex: 1 + overflow-y: auto, so
          messages scroll internally instead of pushing the chat down.
          Card-like visuals via inline styles because Polaris Card
          doesn't expose a way to flex-grow to fill its parent.
        */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              gap: 16,
              background: "#ffffff",
              border: "1px solid var(--p-color-border, #e1e3e5)",
              borderRadius: 12,
              padding: 16,
              boxShadow: "0 1px 0 rgba(0, 0, 0, 0.05)",
            }}
          >
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

            {/* Content area fills available vertical space; min-height: 0
                lets the flex child shrink below content size so overflow
                actually scrolls instead of expanding. */}
            <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
              {!hasActive ? (
                <Text as="p" tone="subdued">
                  Start a new conversation to begin.
                </Text>
              ) : state.messages.length === 0 ? (
                <EmptyStateGuide
                  suggestions={suggestions}
                  onSelect={handleSuggestionSelect}
                  onRefresh={handleRefreshSuggestions}
                  disabled={sending}
                  refreshing={revalidator.state !== "idle"}
                />
              ) : (
                <>
                  <div
                    ref={messagesContainerRef}
                    onScroll={handleScroll}
                    style={{
                      height: "100%",
                      overflowY: "auto",
                      paddingRight: 4,
                    }}
                  >
                    <BlockStack gap="300">
                      {state.messages.map((m, idx) => {
                        // V2.2 — a ClarificationPrompt renders as
                        // "answered" when the merchant has already replied
                        // to it. Heuristic: any later message in the same
                        // conversation means this clarification has been
                        // answered (the merchant's reply is the next user
                        // message). The latest assistant message is still
                        // open for input.
                        const isLastAssistant =
                          m.role === "assistant" &&
                          state.messages
                            .slice(idx + 1)
                            .every((m2) => m2.role !== "user");
                        return (
                          <MessageBubble
                            key={m.id}
                            message={m}
                            pendingByToolCallId={state.pendingByToolCallId}
                            planByToolCallId={planByToolCallId}
                            runningTool={state.runningTool}
                            runningDepartment={state.runningDepartment}
                            shopDomain={shopDomain}
                            answered={!isLastAssistant}
                            onApprove={handleApprove}
                            onReject={handleReject}
                            onClarify={handleSend}
                            onApprovePlan={handleApprovePlan}
                            onRejectPlan={handleRejectPlan}
                          />
                        );
                      })}
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
                </>
              )}
            </div>

            <MemoryPill />
            <ChatInput disabled={!hasActive || sending} onSend={handleSend} />
          </div>
        </div>
      </div>
    </Page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
