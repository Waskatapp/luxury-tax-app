// Phase 8 — agent-loop extraction. The for-turn body that used to live
// inline inside api.chat.tsx's ReadableStream.start(controller) callback.
//
// Extracted so the eval harness can run scenarios end-to-end with a
// `fakeAdmin` and a stub Gemini client, capturing structured events
// instead of writing SSE to a network stream.
//
// SSE byte-identity: the route forwards every (eventName, payload)
// pair from this loop to `controller.enqueue` using the same format
// as before — `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`.
// The loop never touches the controller directly, but because the
// emit signature is identical and the payload object literals are
// byte-for-byte the same, the SSE output is byte-identical.

import type { Content } from "@google/genai";

import prisma from "../../db.server";
import { getGeminiClient } from "./gemini.server";
import { TOOL_DECLARATIONS } from "./tools";
import {
  isApprovalRequiredWrite,
  isInlineWrite,
  isReadTool,
} from "./tool-classifier";
import { executeTool, withRetry } from "./executor.server";
import { classifyError } from "./error-codes";
import type { ModelRouterDecision } from "./model-router";
import { checkGeminiRateLimit } from "../security/rate-limit.server";
import { log } from "../log.server";
import {
  AssistantTurnAccumulator,
  bareToolCallUuid,
  extractSearchText,
  mintToolUseId,
  toGeminiContent,
  type ContentBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./translate.server";
import type { SubAgentResult } from "./departments/department-spec";
import type { ShopifyAdmin } from "../shopify/graphql-client.server";

const MAX_TURNS = 8;
const MAX_OUTPUT_TOKENS = 4096;

// Mirrors the inline `emit` helper that used to live in api.chat.tsx.
// Signature stays string-based so SSE byte-identity is trivially
// preserved — the route's wrapper does the JSON.stringify exactly the
// same way as before.
export type AgentEmit = (eventName: string, payload: unknown) => void;

export type RunAgentLoopInput = {
  admin: ShopifyAdmin;
  storeId: string;
  conversationId: string;
  systemInstruction: string;
  router: ModelRouterDecision;
  // Mutable Gemini history. The loop pushes the assistant turn + (when
  // applicable) the synthesized user-turn-of-tool-results into this
  // array. Caller seeds it with the persisted history.
  contents: Content[];
  // For log metadata only — the loop reports the persisted history
  // size with each ceo-turn-tokens log line.
  storedSize: number;
  emit: AgentEmit;
};

export type RunAgentLoopResult = {
  lastAssistantContent: ContentBlock[];
  lastAssistantMessageId: string | null;
  totalToolCalls: number;
  hadWriteTool: boolean;
  hadClarification: boolean;
  hadPlan: boolean;
  writeToolCallIds: string[];
  assistantTextBuffer: string;
  groundingTexts: string[];
  // True if the loop broke for an early-stop reason (rate limit hit at
  // the top of an iteration). The route uses this to decide whether to
  // record a TurnSignal — at the moment we always record one, but the
  // signal is here in case future tuning wants to skip the record on
  // a rate-limit short-circuit.
  rateLimitedEarly: boolean;
};

export async function runAgentLoop(
  opts: RunAgentLoopInput,
): Promise<RunAgentLoopResult> {
  const { admin, storeId, conversationId, systemInstruction, router, contents, storedSize, emit } = opts;

  let assistantTextBuffer = "";
  let lastAssistantMessageId: string | null = null;
  let lastAssistantContent: ContentBlock[] = [];
  let totalToolCalls = 0;
  let hadWriteTool = false;
  let hadClarification = false;
  let hadPlan = false;
  let rateLimitedEarly = false;
  const writeToolCallIds: string[] = [];
  const groundingTexts: string[] = [];

  const ai = getGeminiClient();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Per-storeId Gemini RPM guard. Free-tier 2.5 Flash is 10 RPM;
    // a single chat message can fan out to multiple Gemini calls when
    // tools run, so we check on every loop iteration.
    const geminiLimit = checkGeminiRateLimit(storeId);
    if (!geminiLimit.ok) {
      const seconds = Math.max(1, Math.ceil(geminiLimit.retryAfterMs / 1000));
      emit("error", {
        message: `Copilot is briefly resting — try again in ${seconds}s.`,
      });
      rateLimitedEarly = true;
      break;
    }

    const accumulator = new AssistantTurnAccumulator();

    // Phase Re Round Re-B — Gemini RPM 429 retry at the loop level.
    // Wrap the stream-creation call in a try/catch; on classified
    // RATE_LIMITED_BURST, sleep 60s + retry once. RPD → no retry, surface
    // a clean message to the merchant. Any other error → bubble.
    let responseStream;
    try {
      responseStream = await ai.models.generateContentStream({
        // V2.4 — tiered model routing. router.modelId is Flash for
        // complex/planning turns and Flash-Lite for read-only summary
        // turns. The router defaults to Flash so quality is the floor.
        model: router.modelId,
        contents,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      });
    } catch (err) {
      const c = classifyError(err);
      if (c.code === "RATE_LIMITED_DAILY") {
        emit("error", {
          message:
            "Daily AI quota reached — we'll resume tomorrow at 06:00 UTC.",
          code: c.code,
        });
        rateLimitedEarly = true;
        break;
      }
      if (c.code === "RATE_LIMITED_BURST" || c.code === "NETWORK") {
        const delayMs = c.code === "RATE_LIMITED_BURST" ? 60_000 : 5_000;
        emit("tool_retry_pending", {
          tool_call_id: "",
          tool_name: "gemini",
          delay_seconds: Math.ceil(delayMs / 1000),
          reason_code: c.code,
        });
        log.warn("agent-loop: Gemini stream failed, retrying once", {
          storeId,
          conversationId,
          turn,
          code: c.code,
          delayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          responseStream = await ai.models.generateContentStream({
            model: router.modelId,
            contents,
            config: {
              systemInstruction,
              tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            },
          });
        } catch (retryErr) {
          const c2 = classifyError(retryErr);
          emit("error", {
            message:
              c2.code === "RATE_LIMITED_DAILY"
                ? "Daily AI quota reached — we'll resume tomorrow at 06:00 UTC."
                : "AI is unavailable right now — try again in a moment.",
            code: c2.code,
          });
          rateLimitedEarly = true;
          break;
        }
      } else {
        throw err;
      }
    }

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
        model: router.modelId,
        ...(lastUsageMetadata
          ? { usage: lastUsageMetadata as unknown as object }
          : {}),
      },
      select: { id: true },
    });
    lastAssistantMessageId = assistantRow.id;

    // V2.5a — token-budget visibility.
    if (lastUsageMetadata) {
      const usage = lastUsageMetadata as {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
      log.info("ceo turn tokens", {
        storeId,
        conversationId,
        messageId: assistantRow.id,
        modelUsed: router.modelId,
        modelTier: router.tier,
        routerReason: router.reason,
        promptTokens: usage.promptTokenCount ?? null,
        outputTokens: usage.candidatesTokenCount ?? null,
        totalTokens: usage.totalTokenCount ?? null,
        historyMessages: storedSize,
        loopTurn: turn,
      });
    }

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
      if (tu.name === "propose_plan") {
        hadPlan = true;
      }
    }

    if (toolUses.length === 0) break;

    // Two passes: first execute reads + inline-writes inline; collect
    // approval-required writes for a batched approval gate.
    const toolResults: ToolResultBlock[] = [];
    const pendingWrites: ToolUseBlock[] = [];
    let askedClarification = false;
    let proposedPlan = false;
    let proposedArtifact = false;

    for (const tu of toolUses) {
      if (isApprovalRequiredWrite(tu.name)) {
        pendingWrites.push(tu);
        continue;
      }
      if (isReadTool(tu.name) || isInlineWrite(tu.name)) {
        emit("tool_running", { tool_name: tu.name });
        // Phase Re Round Re-B — auto-retry on transient errors when the
        // tool is in IDEMPOTENT_TOOLS. The notify callback emits a
        // `tool_retry_pending` SSE event so the UI can show "retrying
        // in Ns…" instead of silence during the backoff window.
        const result = await withRetry(
          tu.name,
          () =>
            executeTool(tu.name, tu.input, {
              admin,
              storeId,
              conversationId,
              toolCallId: tu.id,
            }),
          {
            notify: ({ delaySeconds, reasonCode }) => {
              emit("tool_retry_pending", {
                tool_call_id: tu.id,
                tool_name: tu.name,
                delay_seconds: delaySeconds,
                reason_code: reasonCode,
              });
            },
          },
        );
        const trContent = JSON.stringify(
          result.ok
            ? result.data
            : {
                // Phase Re Round Re-A — surface code + retryable to the
                // agent. Decision-rules.md teaches it how to react per
                // code (don't confabulate on RATE_LIMITED_BURST, don't
                // pivot on ID_NOT_FOUND, etc.).
                error: result.error,
                code: result.code,
                retryable: result.retryable,
              },
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: trContent,
          is_error: !result.ok,
        });
        groundingTexts.push(trContent);

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
        if (tu.name === "propose_plan" && result.ok) {
          const data = result.data as {
            planId?: string;
            summary?: string;
            steps?: unknown[];
          };
          emit("plan_proposed", {
            tool_call_id: tu.id,
            plan_id: data.planId ?? "",
            summary: data.summary ?? "",
            steps: Array.isArray(data.steps) ? data.steps : [],
          });
          proposedPlan = true;
        }
        if (tu.name === "propose_artifact" && result.ok) {
          const data = result.data as { artifactId?: string };
          const input = tu.input as {
            kind?: string;
            productId?: string;
            productTitle?: string;
            content?: string;
          };
          emit("artifact_open", {
            tool_call_id: tu.id,
            artifact_id: data.artifactId ?? "",
            kind: input.kind ?? "description",
            product_id: input.productId ?? "",
            product_title: input.productTitle ?? "",
            content: input.content ?? "",
          });
          proposedArtifact = true;
        }
        // V-Sub-2 — surface sub-agent's internal read tool calls + V-Sub-3
        // proposed writes as synthetic blocks so the merchant's UI cards
        // render exactly like before the migration.
        if (tu.name === "delegate_to_department" && result.ok) {
          const data = result.data as {
            department: string;
            result: SubAgentResult;
          };
          let appendedSyntheticBlocks = false;

          if (
            data.result.kind === "completed" &&
            data.result.readsExecuted.length > 0
          ) {
            for (const read of data.result.readsExecuted) {
              const syntheticId = mintToolUseId(read.toolName);
              const syntheticToolUse: ToolUseBlock = {
                type: "tool_use",
                id: syntheticId,
                name: read.toolName,
                input: read.toolInput,
              };
              const syntheticResultContent = JSON.stringify(
                read.toolResult,
              );
              const syntheticToolResult: ToolResultBlock = {
                type: "tool_result",
                tool_use_id: syntheticId,
                content: syntheticResultContent,
                is_error: read.isError,
              };
              assistantContent.push(syntheticToolUse);
              toolResults.push(syntheticToolResult);
              groundingTexts.push(syntheticResultContent);
            }
            appendedSyntheticBlocks = true;
          }

          if (
            data.result.kind === "proposed_writes" &&
            data.result.writes.length > 0
          ) {
            for (const write of data.result.writes) {
              const syntheticId = mintToolUseId(write.toolName);
              const syntheticToolUse: ToolUseBlock = {
                type: "tool_use",
                id: syntheticId,
                name: write.toolName,
                input: write.toolInput,
              };
              assistantContent.push(syntheticToolUse);
              pendingWrites.push(syntheticToolUse);
              hadWriteTool = true;
              writeToolCallIds.push(syntheticId);
            }
            appendedSyntheticBlocks = true;
          }

          if (appendedSyntheticBlocks) {
            // The assistant message was persisted above with the original
            // assistantContent (which lacked the synthetic blocks).
            // Update the persisted row so reload-time UI rendering sees
            // the synthetic tool_uses too.
            await prisma.message.update({
              where: { id: assistantRow.id },
              data: {
                content: assistantContent as unknown as object,
              },
            });
            // The contents array (Gemini history for next-iteration calls)
            // was also pushed above. Replace the last entry so subsequent
            // generateContent calls see the synthetic tool_uses paired
            // with their results.
            contents[contents.length - 1] = toGeminiContent({
              role: "assistant",
              content: assistantContent,
            });
          }
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
      // well-formed across the approval gap.
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
            storeId,
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
      lastAssistantContent = assistantContent;
      break; // wait for approval
    }

    if (toolResults.length === 0) break;

    // Pure-reads turn: synthesize a user-turn with the tool_results
    // and continue the agent loop.
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

    if (askedClarification) {
      lastAssistantContent = assistantContent;
      break;
    }

    if (proposedPlan) {
      lastAssistantContent = assistantContent;
      break;
    }

    if (proposedArtifact) {
      lastAssistantContent = assistantContent;
      break;
    }

    // continue loop — reflect any synthetic-block updates back into
    // lastAssistantContent before the next iteration overwrites it
    lastAssistantContent = assistantContent;
    void bareToolCallUuid; // imported for future logging; suppress unused-warning
  }

  return {
    lastAssistantContent,
    lastAssistantMessageId,
    totalToolCalls,
    hadWriteTool,
    hadClarification,
    hadPlan,
    writeToolCallIds,
    assistantTextBuffer,
    groundingTexts,
    rateLimitedEarly,
  };
}
