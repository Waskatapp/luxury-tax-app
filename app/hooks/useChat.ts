import { useReducer } from "react";

// ContentBlock is our internal, provider-agnostic shape (mirrors what is
// persisted in Message.content). The translate.server.ts boundary handles
// converting to/from Gemini Part[].
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

// PendingAction status values mirrored on the client. Server is authoritative.
export type PendingActionStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXECUTED"
  | "FAILED";

export type ChatState = {
  phase: ChatPhase;
  messages: ChatMessage[];
  pendingByToolCallId: Record<string, PendingActionStatus>;
  error: string | null;
  // Ephemeral name of the read/inline-write tool currently executing on the
  // server. Set by TOOL_RUNNING; cleared by the next TEXT_DELTA / DONE /
  // ERROR / RESET / LOAD_MESSAGES. Not persisted.
  runningTool: string | null;
};

export type ChatAction =
  | {
      type: "LOAD_MESSAGES";
      messages: ChatMessage[];
      pendingByToolCallId: Record<string, PendingActionStatus>;
    }
  | { type: "SEND_START"; userMessage: ChatMessage; assistantId: string }
  | { type: "CONTINUE_START"; assistantId: string }
  | { type: "TEXT_DELTA"; messageId: string; delta: string }
  | {
      type: "TOOL_USE_START";
      messageId: string;
      toolCallId: string;
      toolName: string;
      toolInput: unknown;
    }
  | { type: "TOOL_RUNNING"; toolName: string }
  | { type: "DONE"; messageId: string }
  | { type: "ERROR"; error: string }
  | {
      type: "TOOL_STATUS";
      toolCallId: string;
      status: PendingActionStatus;
    }
  | { type: "RESET" };

export const INITIAL_CHAT_STATE: ChatState = {
  phase: "idle",
  messages: [],
  pendingByToolCallId: {},
  error: null,
  runningTool: null,
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
      return {
        phase: "idle",
        messages: action.messages,
        pendingByToolCallId: action.pendingByToolCallId,
        error: null,
        runningTool: null,
      };

    case "SEND_START": {
      const placeholder: ChatMessage = {
        id: action.assistantId,
        role: "assistant",
        content: [],
        status: "streaming",
      };
      return {
        ...state,
        phase: "streaming",
        messages: [...state.messages, action.userMessage, placeholder],
        error: null,
      };
    }

    case "CONTINUE_START": {
      const placeholder: ChatMessage = {
        id: action.assistantId,
        role: "assistant",
        content: [],
        status: "streaming",
      };
      return {
        ...state,
        phase: "streaming",
        messages: [...state.messages, placeholder],
        error: null,
      };
    }

    case "TEXT_DELTA":
      return {
        ...state,
        // Text resuming means whichever read tool was running has finished.
        runningTool: null,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? appendTextDelta(m, action.delta) : m,
        ),
      };

    case "TOOL_RUNNING":
      return { ...state, runningTool: action.toolName };

    case "TOOL_USE_START":
      return {
        ...state,
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
        pendingByToolCallId: {
          ...state.pendingByToolCallId,
          [action.toolCallId]: "PENDING",
        },
        error: null,
      };

    case "DONE":
      return {
        ...state,
        phase: state.phase === "awaitingApproval" ? "awaitingApproval" : "idle",
        runningTool: null,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? { ...m, status: "complete" } : m,
        ),
      };

    case "TOOL_STATUS":
      return {
        ...state,
        pendingByToolCallId: {
          ...state.pendingByToolCallId,
          [action.toolCallId]: action.status,
        },
        // Once any pending action moves out of PENDING, we leave the
        // awaitingApproval phase. The continuation stream will move us back to
        // streaming via CONTINUE_START.
        phase: action.status === "PENDING" ? state.phase : "idle",
      };

    case "ERROR":
      return {
        ...state,
        phase: "error",
        runningTool: null,
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
