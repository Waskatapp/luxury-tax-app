import { useReducer } from "react";

// ContentBlock mirrors @anthropic-ai/sdk message content block shapes.
// We persist messages verbatim (CLAUDE.md rule #3) so this type doubles
// as the on-disk schema and the UI's render shape.
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  status: "streaming" | "complete" | "error";
};

export type ChatPhase = "idle" | "streaming" | "awaitingApproval" | "error";

export type ChatState = {
  phase: ChatPhase;
  messages: ChatMessage[];
  error: string | null;
};

export type ChatAction =
  | { type: "LOAD_MESSAGES"; messages: ChatMessage[] }
  | { type: "SEND_START"; userMessage: ChatMessage; assistantId: string }
  | { type: "TEXT_DELTA"; messageId: string; delta: string }
  | {
      type: "TOOL_USE_START";
      messageId: string;
      toolCallId: string;
      toolName: string;
      toolInput: unknown;
    }
  | { type: "DONE"; messageId: string }
  | { type: "ERROR"; error: string }
  | { type: "RESET" };

export const INITIAL_CHAT_STATE: ChatState = {
  phase: "idle",
  messages: [],
  error: null,
};

function appendTextDelta(message: ChatMessage, delta: string): ChatMessage {
  const last = message.content[message.content.length - 1];
  if (last && last.type === "text") {
    const updated = message.content.slice(0, -1);
    updated.push({ type: "text", text: last.text + delta });
    return { ...message, content: updated };
  }
  return { ...message, content: [...message.content, { type: "text", text: delta }] };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "LOAD_MESSAGES":
      return { phase: "idle", messages: action.messages, error: null };

    case "SEND_START": {
      const placeholder: ChatMessage = {
        id: action.assistantId,
        role: "assistant",
        content: [],
        status: "streaming",
      };
      return {
        phase: "streaming",
        messages: [...state.messages, action.userMessage, placeholder],
        error: null,
      };
    }

    case "TEXT_DELTA":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? appendTextDelta(m, action.delta) : m,
        ),
      };

    case "TOOL_USE_START":
      return {
        phase: "awaitingApproval",
        messages: state.messages.map((m) =>
          m.id === action.messageId
            ? {
                ...m,
                content: [
                  ...m.content,
                  {
                    type: "tool_use",
                    id: action.toolCallId,
                    name: action.toolName,
                    input: action.toolInput,
                  },
                ],
              }
            : m,
        ),
        error: null,
      };

    case "DONE":
      return {
        ...state,
        phase: state.phase === "awaitingApproval" ? "awaitingApproval" : "idle",
        messages: state.messages.map((m) =>
          m.id === action.messageId ? { ...m, status: "complete" } : m,
        ),
      };

    case "ERROR":
      return {
        phase: "error",
        messages: state.messages.map((m) =>
          m.status === "streaming" ? { ...m, status: "error" } : m,
        ),
        error: action.error,
      };

    case "RESET":
      return INITIAL_CHAT_STATE;
  }
}

export function useChat(initial?: ChatState) {
  return useReducer(chatReducer, initial ?? INITIAL_CHAT_STATE);
}
