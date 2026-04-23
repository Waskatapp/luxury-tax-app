import type { Dispatch } from "react";
import type { ChatAction, ChatMessage } from "./useChat";

// Raw-fetch SSE consumer. useFetcher buffers until complete; EventSource is
// GET-only. Both are wrong for streaming chat (CLAUDE.md rule #4).
export async function sendChatMessage(params: {
  conversationId: string;
  text: string;
  dispatch: Dispatch<ChatAction>;
  signal?: AbortSignal;
}): Promise<void> {
  const { conversationId, text, dispatch, signal } = params;

  const assistantId = generateId("assistant");
  const userMessage: ChatMessage = {
    id: generateId("user"),
    role: "user",
    content: [{ type: "text", text }],
    status: "complete",
  };

  dispatch({ type: "SEND_START", userMessage, assistantId });

  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, text }),
      signal,
    });
  } catch (err) {
    dispatch({ type: "ERROR", error: errorMessage(err) });
    return;
  }

  if (!response.ok || !response.body) {
    dispatch({
      type: "ERROR",
      error: `Stream request failed (${response.status} ${response.statusText})`,
    });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handleFrame(rawFrame, assistantId, dispatch);
        sep = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    dispatch({ type: "ERROR", error: errorMessage(err) });
  }
}

function handleFrame(raw: string, messageId: string, dispatch: Dispatch<ChatAction>) {
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
    case "error":
      dispatch({
        type: "ERROR",
        error: String(data.message ?? "Stream error"),
      });
      return;
    case "done":
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
