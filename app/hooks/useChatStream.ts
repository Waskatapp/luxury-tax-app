import type { Dispatch } from "react";
import type { ChatAction, ChatMessage } from "./useChat";

// Final outcome of a streamed turn. Callers use this to decide whether to
// reload persisted messages (only on "done" — reloading after "error" would
// clobber the just-set state.error and the merchant would see nothing).
export type StreamOutcome = "done" | "error" | "truncated";

// Raw-fetch SSE consumer. useFetcher buffers until complete; EventSource is
// GET-only. Both are wrong for streaming chat (CLAUDE.md rule #4).
export async function sendChatMessage(params: {
  conversationId: string;
  text: string;
  dispatch: Dispatch<ChatAction>;
  signal?: AbortSignal;
}): Promise<StreamOutcome> {
  const { conversationId, text, dispatch, signal } = params;

  const assistantId = generateId("assistant");
  const userMessage: ChatMessage = {
    id: generateId("user"),
    role: "user",
    content: [{ type: "text", text }],
    status: "complete",
  };

  dispatch({ type: "SEND_START", userMessage, assistantId });

  return streamChatTurn({
    body: { conversationId, text },
    assistantId,
    dispatch,
    signal,
  });
}

// Triggered by the client after a Phase 5 approve/reject roundtrip. The server
// reads history (which now contains the synthesized tool_result Message) and
// streams the human-readable summary into a NEW assistant bubble.
export async function continueChat(params: {
  conversationId: string;
  dispatch: Dispatch<ChatAction>;
  signal?: AbortSignal;
}): Promise<StreamOutcome> {
  const { conversationId, dispatch, signal } = params;

  const assistantId = generateId("assistant");
  dispatch({ type: "CONTINUE_START", assistantId });

  return streamChatTurn({
    body: { conversationId },
    assistantId,
    dispatch,
    signal,
  });
}

async function streamChatTurn(params: {
  body: { conversationId: string; text?: string };
  assistantId: string;
  dispatch: Dispatch<ChatAction>;
  signal?: AbortSignal;
}): Promise<StreamOutcome> {
  const { body, assistantId, dispatch, signal } = params;

  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    dispatch({ type: "ERROR", error: errorMessage(err) });
    return "error";
  }

  if (!response.ok || !response.body) {
    dispatch({
      type: "ERROR",
      error: `Stream request failed (${response.status} ${response.statusText})`,
    });
    return "error";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // handleFrame mutates this via the closure when it sees done/error.
  const tracker: { outcome: StreamOutcome } = { outcome: "truncated" };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handleFrame(rawFrame, assistantId, dispatch, tracker);
        sep = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    dispatch({ type: "ERROR", error: errorMessage(err) });
    return "error";
  }
  return tracker.outcome;
}

function handleFrame(
  raw: string,
  messageId: string,
  dispatch: Dispatch<ChatAction>,
  tracker: { outcome: StreamOutcome },
) {
  let event: string | null = null;
  let dataStr: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:"))
      dataStr = dataStr === null ? line.slice(5).trimStart() : dataStr + "\n" + line.slice(5).trimStart();
  }
  if (!event || dataStr === null) return;

  let data: {
    delta?: string;
    tool_call_id?: string;
    tool_name?: string;
    tool_input?: unknown;
    message?: string;
  };
  try {
    data = JSON.parse(dataStr);
  } catch {
    return;
  }

  switch (event) {
    case "text_delta":
      dispatch({ type: "TEXT_DELTA", messageId, delta: String(data.delta ?? "") });
      return;
    case "tool_use_start":
      dispatch({
        type: "TOOL_USE_START",
        messageId,
        toolCallId: String(data.tool_call_id ?? ""),
        toolName: String(data.tool_name ?? ""),
        toolInput: data.tool_input,
      });
      return;
    case "tool_running":
      dispatch({
        type: "TOOL_RUNNING",
        toolName: String(data.tool_name ?? ""),
      });
      return;
    case "error":
      tracker.outcome = "error";
      dispatch({
        type: "ERROR",
        error: String(data.message ?? "Stream error"),
      });
      return;
    case "done":
      tracker.outcome = "done";
      dispatch({ type: "DONE", messageId });
      return;
  }
}

function generateId(prefix: string): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `${prefix}_${c.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
