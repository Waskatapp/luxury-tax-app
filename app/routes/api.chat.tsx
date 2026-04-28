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
import { buildCeoSystemInstruction } from "../lib/agent/ceo-prompt.server";
import { loadWorkflowsByDepartment } from "../lib/agent/workflow-loader.server";
import { TOOL_DECLARATIONS } from "../lib/agent/tools";
import {
  isApprovalRequiredWrite,
  isInlineWrite,
  isReadTool,
} from "../lib/agent/tool-classifier";
import { executeTool } from "../lib/agent/executor.server";
import {
  formatGuardrailsAsMarkdown,
  formatMemoryAsMarkdown,
  listGuardrails,
  listMemoryForPrompt,
} from "../lib/memory/store-memory.server";
import { extractAndStoreMemory } from "../lib/memory/memory-extractor.server";
import { generateTitle } from "../lib/agent/title-generator.server";
import {
  classifyTurnOutcome,
  recordTurnSignal,
} from "../lib/agent/turn-signals.server";
import { reclassifyOnNewTurn } from "../lib/agent/turn-signals-reclassify.server";
import { log } from "../lib/log.server";
import {
  AssistantTurnAccumulator,
  bareToolCallUuid,
  extractSearchText,
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
  // V2.2 — wall-clock latency captured at action entry. The TurnSignal row
  // recorded at SSE done uses this to track p50/p95 latency by model tier
  // (Phase 2.4 will tier the model; for now always Flash).
  const requestStart = Date.now();

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

  // V2.2 — Reclassify the previous TurnSignal in this conversation if the
  // merchant's new message looks like a rephrase ("no, I meant…"). Cheap
  // (one indexed read + at most one updateMany). Also sweeps stale-24h
  // informational rows to "abandoned". Skipped on continuation-mode
  // requests (no new user input to test against).
  if (typeof text === "string") {
    await reclassifyOnNewTurn({
      storeId: store.id,
      conversationId,
      newUserText: text,
    });
  }

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
            searchText: extractSearchText(userContent),
          },
        }),
        prisma.conversation.update({
          where: { id: conversationId },
          data: {
            // Title is set later by the LLM-based generateTitle() call
            // after the first assistant turn — see "conversation_titled"
            // emit below. Avoid the prior `sanitized.slice(0, 60)` fallback
            // which produced mid-word truncations like "always keep you
            // answers short and to the point add this to y".
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

  // V2.1 — CEO prompt assembler. Three parallel reads (memory, guardrails,
  // workflow markdown) so a slow pull on any one doesn't compound latency.
  // Workflow markdown is process-cached on first call so subsequent turns
  // are essentially free.
  const [memoryEntries, guardrailEntries] = await Promise.all([
    listMemoryForPrompt(store.id),
    listGuardrails(store.id),
  ]);
  const memoryMarkdown = formatMemoryAsMarkdown(memoryEntries);
  const guardrailsMarkdown = formatGuardrailsAsMarkdown(guardrailEntries);
  const systemInstruction = buildCeoSystemInstruction({
    shopDomain: store.shopDomain,
    memoryMarkdown: memoryMarkdown.length > 0 ? memoryMarkdown : null,
    guardrailsMarkdown:
      guardrailsMarkdown.length > 0 ? guardrailsMarkdown : null,
    // Phase 2.6 (Reflection) populates this. Null until that ships.
    observationsMarkdown: null,
    workflowsByDept: loadWorkflowsByDepartment(),
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

      // V2.2 — TurnSignal accumulators. Tracked across the whole agent
      // loop so we can record one signal at SSE done covering the entire
      // user→assistant cycle (which can span multiple Gemini iterations).
      let lastAssistantMessageId: string | null = null;
      let lastAssistantContent: ContentBlock[] = [];
      let totalToolCalls = 0;
      let hadWriteTool = false;
      let hadClarification = false;
      // toolCallIds of approval-required writes minted in this turn — used
      // by classifyTurnOutcome to look at terminal statuses (which at SSE
      // done are still PENDING; tool-approve/reject promote later).
      const writeToolCallIds: string[] = [];

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
          lastAssistantContent = assistantContent;

          // Persist assistant turn verbatim (CLAUDE.md rule #3 — internal shape).
          const assistantRow = await prisma.message.create({
            data: {
              conversationId,
              role: "assistant",
              content: assistantContent as unknown as object,
              searchText: extractSearchText(assistantContent),
              model: GEMINI_CHAT_MODEL,
              ...(lastUsageMetadata
                ? { usage: lastUsageMetadata as unknown as object }
                : {}),
            },
            select: { id: true },
          });
          lastAssistantMessageId = assistantRow.id;

          // Push the assistant turn onto Gemini contents for any next loop.
          contents.push(
            toGeminiContent({ role: "assistant", content: assistantContent }),
          );

          const toolUses = assistantContent.filter(
            (b): b is ToolUseBlock => b.type === "tool_use",
          );
          totalToolCalls += toolUses.length;
          for (const tu of toolUses) {
            if (isApprovalRequiredWrite(tu.name)) {
              hadWriteTool = true;
              writeToolCallIds.push(tu.id);
            }
            if (tu.name === "ask_clarifying_question") {
              hadClarification = true;
            }
          }

          if (toolUses.length === 0) break;

          // Two passes: first execute reads + inline-writes inline; collect
          // approval-required writes for a batched approval gate. This change
          // (V1.8): every write tool_use produces a real PendingAction row +
          // tool_use_start SSE event before we break for approval, so when
          // Gemini emits multiple writes in one turn the client sees them as
          // ONE batched ApprovalCard with one Approve / one Reject. Earlier
          // shape broke after the first write, leaving later writes without
          // backing rows (404 on click) and dropping any read tool_results
          // that had already executed.
          const toolResults: ToolResultBlock[] = [];
          const pendingWrites: ToolUseBlock[] = [];
          // V2.2 — set when ask_clarifying_question fires; we still let the
          // tool execute inline (its tool_result is needed in Gemini's
          // history), but we break the agent loop afterward so the
          // merchant can answer before Gemini speaks again.
          let askedClarification = false;

          for (const tu of toolUses) {
            if (isApprovalRequiredWrite(tu.name)) {
              pendingWrites.push(tu);
              continue;
            }
            if (isReadTool(tu.name) || isInlineWrite(tu.name)) {
              // Inline-execute path: reads + safe writes that don't mutate
              // the store (e.g. update_store_memory, ask_clarifying_question).
              // No approval card. Surface a "running" indicator so the
              // merchant knows we're not frozen during the 1–3s Shopify call.
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

              // V2.2 — clarification: emit the inline-prompt SSE event so
              // the client can render the question with option buttons.
              // The merchant's reply becomes the next user turn via the
              // existing chat flow; Gemini sees the persisted tool_result
              // and continues from there.
              if (tu.name === "ask_clarifying_question" && result.ok) {
                const data = result.data as {
                  question?: string;
                  options?: string[];
                };
                emit("clarification_asked", {
                  tool_call_id: tu.id,
                  question: data.question ?? "",
                  options: Array.isArray(data.options) ? data.options : [],
                });
                askedClarification = true;
              }
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

          if (pendingWrites.length > 0) {
            // Persist any reads we ran first — keeps Gemini's history
            // well-formed across the approval gap (one model turn → one
            // user turn with all functionResponses on continuation).
            if (toolResults.length > 0) {
              await prisma.message.create({
                data: {
                  conversationId,
                  role: "user",
                  content: toolResults as unknown as object,
                },
              });
            }
            // Upsert ALL pending writes + emit one tool_use_start each.
            // toolCallId @unique is the dedupe key (idempotent).
            for (const tu of pendingWrites) {
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
            }
            break; // wait for approval
          }

          if (toolResults.length === 0) break;

          // Pure-reads turn: synthesize a user-turn with the tool_results
          // and continue the agent loop. Filtered from the UI by api.messages.tsx.
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

          // V2.2 — clarification breaks the agent loop AFTER persisting the
          // tool_result so Gemini's history is well-formed when the merchant
          // responds. The CEO must wait for the answer before continuing.
          if (askedClarification) break;

          // continue loop
          void bareToolCallUuid; // imported for future logging; suppress unused-warning
        }

        emit("done", {});

        // V2.2 — record one TurnSignal per merchant→assistant cycle, tied
        // to the LAST assistant Message (the one with the final summary).
        // Outcome at this moment is provisional for write-tool turns: any
        // PendingActions are still PENDING; tool-approve/reject promote
        // the row to "approved"/"rejected" later. The reclassifier handles
        // "rephrased" / "abandoned" downstream.
        if (lastAssistantMessageId) {
          const writeStatuses =
            writeToolCallIds.length > 0
              ? await prisma.pendingAction.findMany({
                  where: {
                    toolCallId: { in: writeToolCallIds },
                    storeId: store.id,
                  },
                  select: { toolCallId: true, status: true },
                })
              : [];
          const outcome = classifyTurnOutcome({
            assistantContent: lastAssistantContent,
            pendingActions: writeStatuses,
          });
          await recordTurnSignal({
            storeId: store.id,
            conversationId,
            messageId: lastAssistantMessageId,
            outcome,
            toolCalls: totalToolCalls,
            hadWriteTool,
            hadClarification,
            latencyMs: Date.now() - requestStart,
            modelUsed: GEMINI_CHAT_MODEL,
          });
        }

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

          // First-turn title generation. Only fires when the conversation
          // was untitled at request entry AND this turn produced assistant
          // text. updateMany with `title: null` prevents two concurrent
          // requests from both setting (and both emitting) — only the
          // first writer wins. Failure is non-fatal; generateTitle never
          // throws and returns a safe fallback.
          if (conversation.title === null) {
            const title = await generateTitle(text, assistantTextBuffer);
            const result = await prisma.conversation.updateMany({
              where: { id: conversationId, title: null },
              data: { title },
            });
            if (result.count > 0) {
              emit("conversation_titled", {
                conversationId,
                title,
              });
            }
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
