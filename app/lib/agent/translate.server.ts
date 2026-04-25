import type { Content, Part } from "@google/genai";

// Our internal ContentBlock shape (mirrors useChat.ts; provider-agnostic).
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// One persisted Message row's role + content.
export type StoredMessage = {
  role: "user" | "assistant";
  content: ContentBlock[];
};

// ---- ContentBlock[] → Gemini Content (one per persisted Message) ----
//
// Role mapping: our "assistant" → Gemini "model"; "user" stays "user".
export function toGeminiContent(message: StoredMessage): Content {
  const parts: Part[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ text: block.text });
    } else if (block.type === "tool_use") {
      parts.push({
        functionCall: {
          name: block.name,
          args: block.input,
        },
      });
    } else if (block.type === "tool_result") {
      // Gemini expects functionResponse.response to be an object. Our
      // tool_result.content is a JSON string — try to parse it back; if it
      // isn't valid JSON, wrap it under {"content": ...}.
      let response: Record<string, unknown>;
      try {
        const parsed = JSON.parse(block.content);
        response =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { value: parsed };
      } catch {
        response = { content: block.content };
      }
      if (block.is_error) response = { error: response };
      // Gemini matches functionResponse to the prior functionCall by name
      // within a turn. We don't need to forward our internal UUID id.
      parts.push({
        functionResponse: {
          name: tool_use_id_to_name(block.tool_use_id, message),
          response,
        },
      });
    }
  }
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts,
  };
}

// Helper: given a tool_use_id, look up the matching tool name in the message.
// In practice we only need this for the synthesized user-with-tool_results turn,
// where we built it ourselves and know the names. We also fall back to looking
// across the messages array if needed; to keep this function self-contained,
// it accepts the same message and assumes tool_use_id IS the name when no
// tool_use block is found (defensive — should never happen).
function tool_use_id_to_name(toolUseId: string, message: StoredMessage): string {
  // The synthesized user-with-tool_results turn does not contain tool_use
  // blocks itself (those are on the prior assistant turn). The caller of
  // toGeminiContents knows the tool name and can supply it via a side map,
  // but for simplicity we encode the name into our internal tool_use_id at
  // mint time. See translateUserToolResultsTurn below.
  void message;
  // Convention: tool_use_id starts with "<name>::<uuid>" for Gemini turns.
  const sep = toolUseId.indexOf("::");
  if (sep > 0) return toolUseId.slice(0, sep);
  return toolUseId;
}

export function toGeminiContents(messages: StoredMessage[]): Content[] {
  return messages.map(toGeminiContent);
}

// Mint an internal tool_use_id that encodes the function name so we can map
// back to a functionResponse.name later without an extra lookup.
export function mintToolUseId(functionName: string): string {
  const c = globalThis.crypto;
  const uuid =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${functionName}::${uuid}`;
}

// Strip the "<name>::" prefix to get the bare UUID portion.
export function bareToolCallUuid(toolUseId: string): string {
  const sep = toolUseId.indexOf("::");
  return sep > 0 ? toolUseId.slice(sep + 2) : toolUseId;
}

// ---- Gemini stream chunk → our ContentBlock[] for one assistant turn ----
//
// Call accumulateChunk() inside the streaming loop; call finalize() once the
// stream ends to get the assembled ContentBlock[] for persistence.
export class AssistantTurnAccumulator {
  private blocks: ContentBlock[] = [];
  private currentText = "";

  // Returns the text delta to emit to the SSE stream (empty string if none).
  consumeChunkParts(parts: Part[] | undefined): string {
    if (!parts) return "";
    let deltaOut = "";
    for (const part of parts) {
      if (typeof part.text === "string" && part.text.length > 0) {
        deltaOut += part.text;
        this.currentText += part.text;
      } else if (part.functionCall) {
        if (this.currentText.length > 0) {
          this.blocks.push({ type: "text", text: this.currentText });
          this.currentText = "";
        }
        const name = part.functionCall.name ?? "";
        const args = (part.functionCall.args ?? {}) as Record<string, unknown>;
        if (name) {
          this.blocks.push({
            type: "tool_use",
            id: mintToolUseId(name),
            name,
            input: args,
          });
        }
      }
      // Ignore inlineData / fileData / executable for v1.
    }
    return deltaOut;
  }

  finalize(): ContentBlock[] {
    if (this.currentText.length > 0) {
      this.blocks.push({ type: "text", text: this.currentText });
      this.currentText = "";
    }
    return this.blocks;
  }
}
