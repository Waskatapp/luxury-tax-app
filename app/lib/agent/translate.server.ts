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

// Denormalized lowercased plain-text projection of a Message's content
// blocks. Used by V1.7 conversation search (Message.searchText column).
// Returns null when there is no user-visible text — typically tool_use-only
// assistant turns or tool_result-only synthesized user turns. The search
// engine treats null as "skip this row".
export function extractSearchText(blocks: ContentBlock[]): string | null {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text.trim().length > 0) {
      parts.push(block.text);
    }
  }
  if (parts.length === 0) return null;
  return parts.join(" ").toLowerCase();
}

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

// Strip the "<name>::" prefix to get just the encoded tool name. Returns
// null if the id doesn't follow the convention (defensive — older messages
// might predate the encoding).
export function bareToolName(toolUseId: string): string | null {
  const sep = toolUseId.indexOf("::");
  return sep > 0 ? toolUseId.slice(0, sep) : null;
}

// ---- V2.5a: history compaction ---------------------------------------------
//
// Old tool_result bodies are the single biggest source of token waste in
// long conversations. A `read_products` result from 10 turns ago can be
// 2-3K tokens — the merchant has clearly moved past it, but Gemini sees
// the full payload on every continuation. We summarize tool_results
// outside a recent window to a one-liner so Gemini still knows what
// happened without paying for the full body.
//
// Recent window: by default the last 10 stored messages. Anything before
// that gets compacted. Short conversations (≤ window) are no-ops.
//
// Successful tool_results get a per-tool summary; error tool_results are
// kept verbatim because the CEO genuinely needs the error text on
// continuation. Non-tool_result blocks (text, tool_use) pass through.

const DEFAULT_RECENT_WINDOW = 10;

export type CompactOldToolResultsOptions = {
  recentWindow?: number;
};

export function compactOldToolResults(
  stored: StoredMessage[],
  opts: CompactOldToolResultsOptions = {},
): StoredMessage[] {
  const window = opts.recentWindow ?? DEFAULT_RECENT_WINDOW;
  if (stored.length <= window) return stored;

  const cutoff = stored.length - window; // indices [0, cutoff) are "old"
  return stored.map((msg, idx) => {
    if (idx >= cutoff) return msg;
    let touched = false;
    const nextContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;
      if (block.is_error) return block; // errors stay verbatim
      const toolName = bareToolName(block.tool_use_id);
      if (!toolName) return block; // can't resolve → stay verbatim
      const summary = summarizeToolResultContent(toolName, block.content);
      if (summary === null) return block; // tool not summarizable → verbatim
      touched = true;
      return { ...block, content: summary };
    });
    return touched ? { ...msg, content: nextContent } : msg;
  });
}

// Per-tool summary formatter. Returns null when the tool's result isn't
// worth summarizing (already small, or unknown shape). All summaries are
// short ASCII strings the CEO can read to decide whether to re-fetch.
function summarizeToolResultContent(
  toolName: string,
  contentJson: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return null; // not JSON — leave it alone
  }
  switch (toolName) {
    case "read_products":
      return summarizeReadProducts(parsed);
    case "read_collections":
      return summarizeReadCollections(parsed);
    case "get_analytics":
      return summarizeGetAnalytics(parsed);
    case "read_workflow":
      return summarizeReadWorkflow(parsed);
    default:
      return null;
  }
}

function summarizeReadProducts(parsed: unknown): string {
  const obj = (parsed ?? {}) as { products?: unknown };
  const products = Array.isArray(obj.products) ? obj.products : [];
  const titles = products
    .slice(0, 5)
    .map((p) => {
      const t = (p as { title?: unknown })?.title;
      return typeof t === "string" ? t : null;
    })
    .filter((t): t is string => t !== null);
  const more = products.length > 5 ? `, +${products.length - 5} more` : "";
  const titleList = titles.length > 0 ? `: ${titles.join(", ")}${more}` : "";
  return `(read_products result, summarized: ${products.length} product${products.length === 1 ? "" : "s"}${titleList}. Re-call read_products if you need the full details again.)`;
}

function summarizeReadCollections(parsed: unknown): string {
  const obj = (parsed ?? {}) as { collections?: unknown };
  const collections = Array.isArray(obj.collections) ? obj.collections : [];
  const titles = collections
    .slice(0, 5)
    .map((c) => {
      const t = (c as { title?: unknown })?.title;
      return typeof t === "string" ? t : null;
    })
    .filter((t): t is string => t !== null);
  const more = collections.length > 5 ? `, +${collections.length - 5} more` : "";
  const titleList = titles.length > 0 ? `: ${titles.join(", ")}${more}` : "";
  return `(read_collections result, summarized: ${collections.length} collection${collections.length === 1 ? "" : "s"}${titleList}. Re-call read_collections if you need the full details.)`;
}

function summarizeGetAnalytics(parsed: unknown): string {
  // Analytics results vary by metric. Best-effort: pull a few stable keys
  // if present. The exact shape is in app/lib/shopify/analytics.server.ts;
  // we don't want to import it (keeps translate.server.ts pure).
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of ["metric", "days", "amount", "currency"]) {
    const v = obj[key];
    if (typeof v === "string" || typeof v === "number") {
      fields.push(`${key}=${v}`);
    }
  }
  if (Array.isArray(obj.products)) {
    fields.push(`top_products_count=${obj.products.length}`);
  }
  if (Array.isArray(obj.variants)) {
    fields.push(`at_risk_count=${obj.variants.length}`);
  }
  const tail = fields.length > 0 ? `: ${fields.join(", ")}` : "";
  return `(get_analytics result, summarized${tail}. Re-call get_analytics if you need the full numbers.)`;
}

function summarizeReadWorkflow(parsed: unknown): string {
  const obj = (parsed ?? {}) as { name?: unknown };
  const name = typeof obj.name === "string" ? obj.name : "?";
  return `(read_workflow result, summarized: '${name}' SOP body — re-call read_workflow if you need it again.)`;
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
