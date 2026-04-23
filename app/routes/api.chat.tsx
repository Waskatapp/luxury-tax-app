import type { ActionFunctionArgs } from "react-router";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import { sanitizeUserInput } from "../lib/security/sanitize.server";
import { CLAUDE_CHAT_MODEL, getAnthropicClient } from "../lib/agent/claude.server";
import { buildSystemBlocks } from "../lib/agent/system-prompt";
import { TOOL_DEFINITIONS } from "../lib/agent/tools";
import {
  isApprovalRequiredWrite,
  isReadTool,
} from "../lib/agent/tool-classifier";
import { executeTool } from "../lib/agent/executor.server";

const BodySchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1).max(4000),
});

const HISTORY_LIMIT = 40; // CLAUDE.md §5 & Phase 4 plan
const MAX_TURNS = 8; // safety cap on the tool-use loop within a single user message
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

  // Persist user turn BEFORE streaming so reload shows it even if the stream
  // errors mid-flight.
  const userContent: Anthropic.ContentBlockParam[] = [
    { type: "text", text: sanitized },
  ];
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

  // Load last N messages (reversed to chronological order) as Claude context.
  const historyRows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, content: true },
  });
  historyRows.reverse();

  const messages: Anthropic.MessageParam[] = historyRows.map((row) => ({
    role: row.role === "user" ? "user" : "assistant",
    content: row.content as unknown as Anthropic.MessageParam["content"],
  }));

  const systemBlocks = buildSystemBlocks({
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
          // controller already closed — ignore
        }
      };

      try {
        const anthropic = getAnthropicClient();

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const claudeStream = anthropic.messages.stream({
            model: CLAUDE_CHAT_MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: systemBlocks,
            messages,
            tools: TOOL_DEFINITIONS,
          });

          claudeStream.on("text", (delta: string) => {
            if (delta) emit("text_delta", { delta });
          });

          const finalMessage = await claudeStream.finalMessage();

          // Persist the assistant turn verbatim (CLAUDE.md rule #3 — no translation).
          await prisma.message.create({
            data: {
              conversationId,
              role: "assistant",
              content: finalMessage.content as unknown as object,
              model: finalMessage.model,
              usage: finalMessage.usage as unknown as object,
            },
          });
          messages.push({ role: "assistant", content: finalMessage.content });

          const toolUses = finalMessage.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
          );

          if (toolUses.length === 0) break;

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          let stoppedForApproval = false;

          for (const tu of toolUses) {
            if (isApprovalRequiredWrite(tu.name)) {
              // Create PendingAction row; approval UI + execution land in Phase 5.
              // toolCallId @unique makes this idempotent (CLAUDE.md rule #10).
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

            // Unknown tool (shouldn't happen — TOOL_DEFINITIONS lists only classified tools).
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `Tool ${tu.name} is not registered.`,
              is_error: true,
            });
          }

          if (stoppedForApproval) break;
          if (toolResults.length === 0) break;

          // Synthesize the user-turn with tool_results so Claude can continue.
          // api.messages filters these rows from the UI — they're internal plumbing.
          await prisma.message.create({
            data: {
              conversationId,
              role: "user",
              content: toolResults as unknown as object,
            },
          });
          messages.push({ role: "user", content: toolResults });
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
