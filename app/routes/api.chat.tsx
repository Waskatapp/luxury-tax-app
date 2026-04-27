import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import {
  checkChatRateLimit,
  checkGeminiRateLimit,
} from "../lib/security/rate-limit.server";
import { sanitizeUserInput } from "../lib/security/sanitize.server";
import { GEMINI_CHAT_MODEL, getGeminiClient } from "../lib/agent/gemini.server";
import { buildSystemInstruction } from "../lib/agent/system-prompt";
import { TOOL_DECLARATIONS } from "../lib/agent/tools";
import {
  isApprovalRequiredWrite,
  isInlineWrite,
  isReadTool,
} from "../lib/agent/tool-classifier";
import { executeTool } from "../lib/agent/executor.server";
import {
  formatMemoryAsMarkdown,
  listMemoryForPrompt,
} from "../lib/memory/store-memory.server";
import { extractAndStoreMemory } from "../lib/memory/memory-extractor.server";
import { log } from "../lib/log.server";
import {
  AssistantTurnAccumulator,
  bareToolCallUuid,
  toGeminiContent,
  toGeminiContents,
  type ContentBlock,
  type StoredMessage,
  type ToolResultBlock,
  type ToolUseBlock,
} from "../lib/agent/translate.server";

// `text` is optional: when absent, the request is a "continuation" triggered
// by the client after an approve/reject roundtrip. The server then streams
// the assistant summary based on history (which already contains the
// synthesized tool_result Message persisted by api.tool-approve / api.tool-reject).
const BodySchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1).max(4000).optional(),
});

const HISTORY_LIMIT = 40;
const MAX_TURNS = 8;
const MAX_OUTPUT_TOKENS = 4096;

// Translate provider-thrown rate-limit errors into the same friendly message
// the local guard emits, so the merchant doesn't see "RESOURCE_EXHAUSTED".
function friendlyErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/429|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(raw)) {
    return "Copilot is briefly resting — try again in a few seconds.";
  }
  return raw;
}

function sseErrorResponse(message: string): Response {
  const body =
    `event: error\ndata: ${JSON.stringify({ message })}\n\n` +
    `event: done\ndata: {}\n\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, store } = await requireStoreAccess(request);

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid body", { status: 400 });
  const { conversationId, text } = parsed.data;

  // Per-(storeId,userId) chat rate limit. Stops the request before any DB
  // writes or Gemini calls. Surfaced as a one-shot SSE error stream so the
  // existing client error handler renders it like any other failure.
  const chatLimit = checkChatRateLimit(store.id, null);
  if (!chatLimit.ok) {
    const seconds = Math.max(1, Math.ceil(chatLimit.retryAfterMs / 1000));
    return sseErrorResponse(
      `You're sending messages too fast. Try again in ${seconds}s.`,
    );
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, storeId: store.id },
    select: { id: true, title: true },
  });
  if (!conversation) return new Response("Not found", { status: 404 });

  // Continuation mode (no text): skip user-message persistence; history
  // already includes the synthesized tool_result row from approve/reject.
  if (typeof text === "string") {
    const sanitized = sanitizeUserInput(text);
    // Idempotent retry guard: if the immediately-previous user message in
    // this conversation is identical, this is a re-send of a failed turn
    // (rate limit, network blip). Skip persistence so the DB doesn't grow
    // a duplicate row each time the merchant clicks "Try again".
    const lastUserRow = await prisma.message.findFirst({
      where: { conversationId, role: "user" },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    });
    const lastUserText = ((): string | null => {
      const blocks = lastUserRow?.content as ContentBlock[] | null;
      if (!Array.isArray(blocks)) return null;
      for (const b of blocks) {
        if (b?.type === "text" && typeof (b as { text?: unknown }).text === "string") {
          return (b as { text: string }).text;
        }
      }
      return null;
    })();

    if (lastUserText === sanitized) {
      // Same message already on disk — bump conversation activity for
      // sidebar sort, but don't double-persist.
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
    } else {
      const userContent: ContentBlock[] = [{ type: "text", text: sanitized }];
      await prisma.$transaction([
        prisma.message.create({
          data: {
            conversationId,
            role: "user",
            content: userContent as unknown as object,
          },
        }),
        prisma.conversation.update({
          where: { id: conversationId },
          data: {
            title: conversation.title ?? sanitized.slice(0, 60),
            updatedAt: new Date(),
          },
        }),
      ]);
    }
  }

  // Load last N messages for context (chronological).
  const historyRows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, content: true },
  });
  historyRows.reverse();

  const stored: StoredMessage[] = historyRows.map((row) => ({
    role: row.role === "user" ? "user" : "assistant",
    content: row.content as unknown as ContentBlock[],
  }));

  const memoryEntries = await listMemoryForPrompt(store.id);
  const memoryMarkdown = formatMemoryAsMarkdown(memoryEntries);
  const systemInstruction = buildSystemInstruction({
    shopDomain: store.shopDomain,
    memoryMarkdown: memoryMarkdown.length > 0 ? memoryMarkdown : null,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // controller already closed
        }
      };

      // Accumulates every text_delta across the whole user→assistant cycle
      // (multiple Gemini turns when tools run). Used to feed the post-stream
      // memory extractor with the merchant's full reply context.
      let assistantTextBuffer = "";

      try {
        const ai = getGeminiClient();
        const contents = toGeminiContents(stored);

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          // Per-storeId Gemini RPM guard. Free-tier 2.5 Flash is 10 RPM;
          // a single chat message can fan out to multiple Gemini calls when
          // tools run, so we check on every loop iteration. Defense-in-depth
          // for SDK-thrown 429s lives in the catch block below.
          const geminiLimit = checkGeminiRateLimit(store.id);
          if (!geminiLimit.ok) {
            const seconds = Math.max(1, Math.ceil(geminiLimit.retryAfterMs / 1000));
            emit("error", {
              message: `Copilot is briefly resting — try again in ${seconds}s.`,
            });
            break;
          }

          const accumulator = new AssistantTurnAccumulator();

          const responseStream = await ai.models.generateContentStream({
            model: GEMINI_CHAT_MODEL,
            contents,
            config: {
              systemInstruction,
              tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            },
          });

          let lastUsageMetadata: unknown = null;
          for await (const chunk of responseStream) {
            const candidate = chunk.candidates?.[0];
            const delta = accumulator.consumeChunkParts(candidate?.content?.parts);
            if (delta.length > 0) {
              emit("text_delta", { delta });
              assistantTextBuffer += delta;
            }
            if (chunk.usageMetadata) lastUsageMetadata = chunk.usageMetadata;
          }

          const assistantContent = accumulator.finalize();

          // Persist assistant turn verbatim (CLAUDE.md rule #3 — internal shape).
          await prisma.message.create({
            data: {
              conversationId,
              role: "assistant",
              content: assistantContent as unknown as object,
              model: GEMINI_CHAT_MODEL,
              ...(lastUsageMetadata
                ? { usage: lastUsageMetadata as unknown as object }
                : {}),
            },
          });

          // Push the assistant turn onto Gemini contents for any next loop.
          contents.push(
            toGeminiContent({ role: "assistant", content: assistantContent }),
          );

          const toolUses = assistantContent.filter(
            (b): b is ToolUseBlock => b.type === "tool_use",
          );

          if (toolUses.length === 0) break;

          const toolResults: ToolResultBlock[] = [];
          let stoppedForApproval = false;

          for (const tu of toolUses) {
            if (isApprovalRequiredWrite(tu.name)) {
              // Idempotent upsert; toolCallId @unique is the dedupe key.
              await prisma.pendingAction.upsert({
                where: { toolCallId: tu.id },
                create: {
                  toolCallId: tu.id,
                  toolName: tu.name,
                  toolInput: tu.input as object,
                  storeId: store.id,
                  conversationId,
                  status: "PENDING",
                },
                update: {},
              });
              emit("tool_use_start", {
                tool_call_id: tu.id,
                tool_name: tu.name,
                tool_input: tu.input,
              });
              stoppedForApproval = true;
              break;
            }

            if (isReadTool(tu.name) || isInlineWrite(tu.name)) {
              // Inline-execute path: reads + safe writes that don't mutate
              // the store (e.g. update_store_memory). No approval card.
              // Surface a "running" indicator so the merchant knows we're
              // not frozen during the 1–3s Shopify call.
              emit("tool_running", { tool_name: tu.name });
              const result = await executeTool(tu.name, tu.input, {
                admin,
                storeId: store.id,
              });
              toolResults.push({
                type: "tool_result",
                tool_use_id: tu.id,
                content: JSON.stringify(
                  result.ok ? result.data : { error: result.error },
                ),
                is_error: !result.ok,
              });
              continue;
            }

            // Unknown / not-yet-wired
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `Tool ${tu.name} is not registered.`,
              is_error: true,
            });
          }

          if (stoppedForApproval) break;
          if (toolResults.length === 0) break;

          // Synthesize a user-turn with the tool_results. This row is filtered
          // from the UI by api.messages.tsx (internal plumbing, not user-visible).
          await prisma.message.create({
            data: {
              conversationId,
              role: "user",
              content: toolResults as unknown as object,
            },
          });
          contents.push(
            toGeminiContent({ role: "user", content: toolResults }),
          );

          // continue loop
          void bareToolCallUuid; // imported for future logging; suppress unused-warning
        }

        emit("done", {});

        // Memory extraction is now inline (was fire-and-forget) so we can
        // emit `memory_saved` events on the still-open SSE stream — the
        // client surfaces these as Polaris toasts. Skipped on
        // continuation-mode requests (post-approve/reject — merchant didn't
        // say anything new) and on pure tool-call turns. The extractor
        // itself never throws, so a slow/failed Flash-Lite call won't
        // leak into the catch block.
        if (typeof text === "string" && assistantTextBuffer.trim().length > 0) {
          const saved = await extractAndStoreMemory({
            storeId: store.id,
            userText: text,
            assistantText: assistantTextBuffer,
          });
          for (const entry of saved) {
            emit("memory_saved", entry);
          }
        }
      } catch (err) {
        log.error("api.chat stream error", { err });
        emit("error", { message: friendlyErrorMessage(err) });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defeat Railway/Nginx edge buffering (CLAUDE.md risk #5).
      "X-Accel-Buffering": "no",
    },
  });
};
