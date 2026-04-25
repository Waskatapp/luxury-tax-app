import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import { sanitizeUserInput } from "../lib/security/sanitize.server";
import { GEMINI_CHAT_MODEL, getGeminiClient } from "../lib/agent/gemini.server";
import { buildSystemInstruction } from "../lib/agent/system-prompt";
import { TOOL_DECLARATIONS } from "../lib/agent/tools";
import {
  isApprovalRequiredWrite,
  isReadTool,
} from "../lib/agent/tool-classifier";
import { executeTool } from "../lib/agent/executor.server";
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

const BodySchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1).max(4000),
});

const HISTORY_LIMIT = 40;
const MAX_TURNS = 8;
const MAX_OUTPUT_TOKENS = 4096;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, store } = await requireStoreAccess(request);

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid body", { status: 400 });
  const { conversationId, text } = parsed.data;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, storeId: store.id },
    select: { id: true, title: true },
  });
  if (!conversation) return new Response("Not found", { status: 404 });

  const sanitized = sanitizeUserInput(text);

  // Persist user turn before streaming so reload shows it even on stream error.
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

  const systemInstruction = buildSystemInstruction({
    shopDomain: store.shopDomain,
    memoryMarkdown: null, // Phase 8 wires real memory
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

      try {
        const ai = getGeminiClient();
        const contents = toGeminiContents(stored);

        for (let turn = 0; turn < MAX_TURNS; turn++) {
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
            if (delta.length > 0) emit("text_delta", { delta });
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

            if (isReadTool(tu.name)) {
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
      } catch (err) {
        console.error("[api.chat] stream error:", err);
        emit("error", {
          message: err instanceof Error ? err.message : String(err),
        });
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
