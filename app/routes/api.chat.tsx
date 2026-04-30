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
import { getOrPopulateTimezone } from "../lib/agent/shop-timezone.server";
import { loadWorkflowIndex } from "../lib/agent/workflow-loader.server";
import { TOOL_DECLARATIONS } from "../lib/agent/tools";
import {
  isApprovalRequiredWrite,
  isInlineWrite,
  isReadTool,
} from "../lib/agent/tool-classifier";
import { executeTool } from "../lib/agent/executor.server";
import { pickModelTier } from "../lib/agent/model-router";
import { parseSlashCommand } from "../lib/agent/slash-commands";
import {
  formatGuardrailsAsMarkdown,
  formatMemoryAsMarkdown,
  listGuardrails,
  listMemoryForPrompt,
} from "../lib/memory/store-memory.server";
import { extractAndStoreMemory } from "../lib/memory/memory-extractor.server";
import {
  formatInsightsAsMarkdown,
  pickInsightsToSurface,
} from "../lib/agent/insights.server";
import { findHallucinations } from "../lib/agent/hallucination-detector.server";
import {
  findSimilarDecisions,
  formatDecisionsAsMarkdown,
  listDecisionsNeedingEmbedding,
  setDecisionEmbedding,
} from "../lib/agent/decisions.server";
import {
  buildDecisionEmbeddingSource,
  embedText,
} from "../lib/agent/embeddings.server";
import { generateTitle } from "../lib/agent/title-generator.server";
import {
  classifyTurnOutcome,
  extractMaxConfidence,
  recordTurnSignal,
} from "../lib/agent/turn-signals.server";
import { reclassifyOnNewTurn } from "../lib/agent/turn-signals-reclassify.server";
import { log } from "../lib/log.server";
import {
  AssistantTurnAccumulator,
  bareToolCallUuid,
  collectProposeArtifactIds,
  compactAppliedArtifacts,
  compactOldToolResults,
  extractSearchText,
  mintToolUseId,
  toGeminiContent,
  toGeminiContents,
  type ContentBlock,
  type StoredMessage,
  type ToolResultBlock,
  type ToolUseBlock,
} from "../lib/agent/translate.server";
import type { SubAgentResult } from "../lib/agent/departments/department-spec";

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

// Translate provider-thrown errors into friendly merchant-facing messages
// instead of leaking raw JSON like
// `{"error":{"message":"{\n \"error\":{\n \"code\":503,...}}}}`.
//
// Bucket order matters — more specific patterns must run BEFORE more general
// ones so a daily-quota error doesn't masquerade as "briefly throttled" (a
// 60-second retry won't fix a daily limit; the merchant needs to know to
// switch keys or wait until midnight UTC).
//
// 1. Schema (400) — persistent build bug, not transient.
// 2. Daily quota — generativelanguage free tier "per day" limits. Recover
//    requires a key swap or 24h wait; "try again in seconds" is wrong.
// 3. Per-minute / general 429 — actually transient; retry in seconds works.
// 4. 503 / UNAVAILABLE — Gemini-side capacity dip; retry in seconds works.
function friendlyErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Schema / payload errors come BEFORE transient buckets so a malformed
  // tool registration doesn't masquerade as "overloaded" and waste the
  // merchant's time clicking Try again. Real 400s are persistent until
  // the deploy is fixed.
  if (
    /400|INVALID_ARGUMENT|FAILED_PRECONDITION|invalid.?json|schema|cannot parse/i.test(
      raw,
    )
  ) {
    return "There's a bug in this build of the Copilot — the request to Gemini is malformed. This will keep failing until we fix it; please report this to your developer.";
  }
  // Daily-quota bucket — Gemini free tier returns 429 with text like
  // "exceeded your current quota" / "free_tier_requests" / "GenerateContentRequestsPerDay" /
  // "PerDay". Retry-in-seconds doesn't help; only a key swap or midnight
  // UTC reset does.
  if (
    /per[\s_-]?day|daily.?(quota|limit)|GenerateContentRequestsPerDay|free_tier_requests|exceeded.+(your)?\s*(current )?quota/i.test(
      raw,
    )
  ) {
    return "Daily Gemini quota hit on this API key. Either wait until midnight UTC for the free-tier limit to reset, or switch GEMINI_API_KEY in Railway to a different account. Retrying in seconds won't help.";
  }
  if (/429|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(raw)) {
    return "Copilot is briefly throttled (per-minute Gemini limit) — try again in 30–60 seconds.";
  }
  if (
    /503|UNAVAILABLE|service unavailable|high demand|temporarily/i.test(raw)
  ) {
    return "Gemini is briefly overloaded — try again in a moment.";
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

  const storedRaw: StoredMessage[] = historyRows.map((row) => ({
    role: row.role === "user" ? "user" : "assistant",
    content: row.content as unknown as ContentBlock[],
  }));

  // V2.5a — pre-compaction pass. Trim applied/discarded propose_artifact
  // bodies before they reach the agent loop. One Prisma round-trip,
  // indexed on (toolCallId, storeId), fans out to N updates of the
  // tool_use input.content field. DRAFT artifacts (panel still open)
  // keep their content because the CEO might still be looking at it.
  // Net effect: each applied description trims ~1-2K tokens permanently
  // from this conversation's history budget.
  const artifactToolCallIds = collectProposeArtifactIds(storedRaw);
  const artifactStatuses = artifactToolCallIds.length > 0
    ? await prisma.artifact.findMany({
        where: {
          toolCallId: { in: artifactToolCallIds },
          storeId: store.id,
        },
        select: { toolCallId: true, status: true },
      })
    : [];
  const stored = compactAppliedArtifacts(storedRaw, artifactStatuses);

  // V2.1 — CEO prompt assembler. Three parallel reads (memory, guardrails,
  // workflow markdown) so a slow pull on any one doesn't compound latency.
  // Workflow markdown is process-cached on first call so subsequent turns
  // are essentially free.
  // V2.4 — also pull a cheap recent-context probe in parallel: any
  // APPROVED Plan that hasn't been REJECTED, plus a quick check on the
  // last assistant turn for write-tool use. Both feed the model-router
  // tier decision; both are tiny indexed reads.
  const [memoryEntries, guardrailEntries, activePlan, lastAssistant] =
    await Promise.all([
      listMemoryForPrompt(store.id),
      listGuardrails(store.id),
      prisma.plan.findFirst({
        where: { conversationId, storeId: store.id, status: "APPROVED" },
        select: { id: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.message.findFirst({
        where: { conversationId, role: "assistant" },
        select: { content: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
  const recentWriteToolUse = ((): boolean => {
    const blocks = (lastAssistant?.content ?? null) as ContentBlock[] | null;
    if (!Array.isArray(blocks)) return false;
    for (const b of blocks) {
      if (b.type === "tool_use" && isApprovalRequiredWrite(b.name)) return true;
    }
    return false;
  })();
  // Continuation mode (text undefined) is always Flash — the merchant
  // just clicked Approve/Reject and Gemini needs to summarize what
  // happened, which often involves reasoning over tool_results.
  const router =
    typeof text === "string"
      ? pickModelTier({
          message: text,
          hasActivePlan: activePlan !== null,
          recentWriteToolUse,
        })
      : { tier: "flash" as const, modelId: GEMINI_CHAT_MODEL, reason: "continuation" };
  // Detect slash commands for the post-turn memory-extraction skip below.
  // Slash commands are templated, so the Flash-Lite extractor never finds
  // new facts in them — saving one extra LLM call per slash invocation.
  const isSlashCommand =
    typeof text === "string" && parseSlashCommand(text) !== null;
  const memoryMarkdown = formatMemoryAsMarkdown(memoryEntries);
  const guardrailsMarkdown = formatGuardrailsAsMarkdown(guardrailEntries);

  // V3.3 — Phase 3.3 proactive insight surfacing. The offline evaluator
  // (.github/workflows/followup-evaluator.yml) writes Insight rows; here
  // we pick 0–2 to weave into the CEO Observations slot of the prompt
  // when the merchant opens a NEW conversation. Strict gates:
  //   - Only on the merchant's FIRST user message (`historyRows.length === 0`
  //     plus a defined `text`). Continuation turns and mid-conversation
  //     turns never re-surface — once an insight is shown it's claimed
  //     for the day.
  //   - Daily rate limit at the (storeId, day) level (≤ 2 unique surfaces
  //     per UTC day across all conversations) — pickInsightsToSurface
  //     enforces this transactionally.
  const isFirstUserMessage =
    historyRows.length === 0 && typeof text === "string";
  const surfacedInsights = isFirstUserMessage
    ? await pickInsightsToSurface(store.id).catch((err) => {
        log.warn("insights: surfacing failed (non-fatal)", {
          err: err instanceof Error ? err.message : String(err),
        });
        return [];
      })
    : [];
  const observationsMarkdown =
    surfacedInsights.length > 0
      ? formatInsightsAsMarkdown(surfacedInsights)
      : null;

  // V4.3 — Phase 4 Decision Memory & Retrieval. Embed the merchant's
  // first user message and pull semantically-similar past decisions
  // from the journal. Only on the FIRST user message of a new
  // conversation (same gate as insight surfacing) — continuation
  // turns reuse what's already in conversation history rather than
  // re-injecting precedent fresh each turn (which would be confusing
  // if the topic shifts mid-thread).
  //
  // findSimilarDecisions enforces minSimilarity=0.90 (V6.7 — bumped from
  // 0.85 after the gemini-embedding-001 model switch; new geometry was
  // matching "hello" against domain-specific decisions at 0.85+) and
  // topN=3. If the embed call fails (rate limit, network) we silently
  // skip the section — chat experience never blocks on retrieval.
  let pastDecisionsMarkdown: string | null = null;
  if (isFirstUserMessage && typeof text === "string") {
    // V5.3 hotfix — skip embedText when there are no embedded decisions
    // for this store yet. embedText is ~500ms-1s on Gemini's API; on a
    // fresh-ish store with zero or pending-only decisions the cosine
    // search would return [] anyway, so the embed call is pure latency
    // with no payoff. Combined with multi-turn agent loops on action
    // requests, that latency was pushing first-message turns past the
    // SSE proxy timeout (yellow "wasn't answered" banner).
    //
    // Count is a single indexed query (~5ms). Once the journal has
    // entries with completed embeddings, the embed call kicks in
    // and retrieval lights up.
    try {
      const embeddedDecisionCount = await prisma.decision.count({
        where: { storeId: store.id, embeddingPending: false },
      });
      if (embeddedDecisionCount > 0) {
        const queryEmbedding = await embedText(text);
        if (queryEmbedding !== null) {
          const similar = await findSimilarDecisions({
            storeId: store.id,
            queryEmbedding,
            topN: 3,
            minSimilarity: 0.9,
          });
          if (similar.length > 0) {
            pastDecisionsMarkdown = formatDecisionsAsMarkdown(
              similar,
              similar.length,
            );
          }
        }
      }
    } catch (err) {
      log.warn("decisions: retrieval failed (non-fatal)", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // V6.8 — resolve the merchant's IANA timezone for the prompt's time
  // block. First chat turn after install does one Shopify GraphQL call
  // (~100-200ms); every subsequent turn reads the cached value off the
  // Store row at zero cost. Falls back to "UTC" on any failure — tool
  // inputs (which use ISO timestamps) remain valid either way.
  const timezone = await getOrPopulateTimezone({
    storeId: store.id,
    currentTimezone: store.ianaTimezone,
    admin,
  });

  const systemInstruction = buildCeoSystemInstruction({
    shopDomain: store.shopDomain,
    memoryMarkdown: memoryMarkdown.length > 0 ? memoryMarkdown : null,
    guardrailsMarkdown:
      guardrailsMarkdown.length > 0 ? guardrailsMarkdown : null,
    observationsMarkdown,
    pastDecisionsMarkdown,
    workflowIndex: loadWorkflowIndex(),
    timezone,
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
      let hadPlan = false;
      // toolCallIds of approval-required writes minted in this turn — used
      // by classifyTurnOutcome to look at terminal statuses (which at SSE
      // done are still PENDING; tool-approve/reject promote later).
      const writeToolCallIds: string[] = [];

      // V6.5 — Phase 6 Hallucination Guard. Collects every grounding
      // string available to verify the CEO's price claims against this
      // request: the merchant's user text + every tool_result content
      // produced during the agent loop. Used in the post-stream block
      // by findHallucinations to flag any $-prefixed price in the
      // assistant response that doesn't appear in the grounding set.
      // V1 logs only — once we observe false-positive rate in
      // production, we can promote to a hard TurnSignal signal.
      const groundingTexts: string[] = [];
      if (typeof text === "string" && text.length > 0) {
        groundingTexts.push(text);
      }

      try {
        const ai = getGeminiClient();
        // V2.5a — compact old tool_results before sending history to
        // Gemini. Tool_results outside the last 10 messages get
        // replaced with a one-line summary; the CEO can re-fetch via
        // the (still-cached) read tool if it needs the full data
        // again. Newly-generated turns inside the agent loop are
        // pushed verbatim to `contents` so the CEO sees its current
        // tool calls in full.
        const contents = toGeminiContents(compactOldToolResults(stored));

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

          // V2.5a — token-budget visibility. Already persisted to
          // Message.usage above (queryable later); also log so we can
          // see per-turn token counts in Railway logs in real time
          // and verify the impact of the lazy-injection / compaction
          // fixes without a Prisma round-trip.
          if (lastUsageMetadata) {
            const usage = lastUsageMetadata as {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              totalTokenCount?: number;
            };
            log.info("ceo turn tokens", {
              storeId: store.id,
              conversationId,
              messageId: assistantRow.id,
              modelUsed: router.modelId,
              modelTier: router.tier,
              routerReason: router.reason,
              promptTokens: usage.promptTokenCount ?? null,
              outputTokens: usage.candidatesTokenCount ?? null,
              totalTokens: usage.totalTokenCount ?? null,
              historyMessages: stored.length,
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
          // V2.3 — same pattern for propose_plan: persist the Plan row,
          // emit the plan_proposed SSE so the client can show PlanCard,
          // then break the agent loop until the merchant approves/rejects.
          let proposedPlan = false;
          // V2.5 — same pattern for propose_artifact: persist the
          // Artifact row, emit the artifact_open SSE so the client opens
          // the side panel, then break until the merchant approves /
          // discards. The actual Shopify write fires later via
          // api.artifact-approve.
          let proposedArtifact = false;

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
                conversationId,
                toolCallId: tu.id,
              });
              const trContent = JSON.stringify(
                result.ok ? result.data : { error: result.error },
              );
              toolResults.push({
                type: "tool_result",
                tool_use_id: tu.id,
                content: trContent,
                is_error: !result.ok,
              });
              // V6.5 — feed grounding for the post-stream hallucination
              // check. Push regardless of error status — error payloads
              // sometimes contain prices the CEO might quote ("we tried
              // to set $19.99 but Shopify rejected it").
              groundingTexts.push(trContent);

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
              // V2.3 — propose_plan: emit the SSE event so the client can
              // render PlanCard during the stream. The persisted tool_use
              // block on the assistant Message handles reload-time render.
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
              // V2.5 — propose_artifact: emit artifact_open so the
              // client opens the side panel with the draft. The full
              // content travels through this event (the client needs
              // it to render the editor); future kinds may need a
              // different shape. Tool input is the canonical source of
              // truth for productId / productTitle / content — we read
              // it directly off the tool_use block rather than the
              // (summarized) tool_result.
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
              // V-Sub-2 hotfix — surface sub-agent's internal read tool
              // calls as synthetic tool_use + tool_result blocks at the
              // CEO level. Without this, get_analytics calls dispatched
              // through delegate_to_department don't render their
              // AnalyticsCard (MessageBubble renders cards from
              // persisted tool_result blocks whose tool_use_id starts
              // with "<toolname>::"). The merchant sees the rich card UX
              // exactly like before the migration, even though the call
              // happened inside a sub-agent.
              //
              // Gemini history coherence: we append matching synthetic
              // tool_use blocks to assistantContent (the sub-agent's
              // internal calls become the CEO's apparent calls from
              // history's POV). Doesn't confuse the model — the next
              // turn just sees a coherent assistant(tool_uses) → user(tool_results)
              // pair, exactly like a direct call.
              if (tu.name === "delegate_to_department" && result.ok) {
                const data = result.data as {
                  department: string;
                  result: SubAgentResult;
                };
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
                    // Feed grounding for the post-stream hallucination
                    // check, same as we do for direct read tool results.
                    groundingTexts.push(syntheticResultContent);
                  }
                  // The assistant message was persisted at line ~528
                  // BEFORE this dispatch ran, with the original
                  // assistantContent (which lacked the synthetic blocks).
                  // Update the persisted row so reload-time UI rendering
                  // sees the synthetic tool_uses too.
                  await prisma.message.update({
                    where: { id: assistantRow.id },
                    data: {
                      content: assistantContent as unknown as object,
                    },
                  });
                  // The contents array (Gemini history for next-iteration
                  // calls) was also pushed BEFORE this dispatch. Replace
                  // the last entry so subsequent generateContent calls
                  // see the synthetic tool_uses paired with their results
                  // (Gemini's function-calling API requires every
                  // functionResponse to have a matching functionCall).
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

          // V2.3 — same pattern for propose_plan: tool_result persists,
          // then we break and wait for merchant approval. On continuation
          // (POST /api/chat with no text), the synthesized tool_result
          // generated by api.plan-approve / api.plan-reject tells Gemini
          // whether the plan was approved.
          if (proposedPlan) break;

          // V2.5 — same pattern for propose_artifact: pause the agent
          // loop until the merchant approves / discards in the panel.
          // api.artifact-approve continues the chat with a synthesized
          // tool_result describing what happened (approved + applied,
          // or discarded).
          if (proposedArtifact) break;

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
            hadPlan,
            latencyMs: Date.now() - requestStart,
            modelUsed: router.modelId,
            // V6.2 — extract `Confidence: 0.X` tag from assistant text per
            // output-format.md. Null when the turn didn't warrant a tag
            // (greetings, lookups, confirmations) — that's the right
            // default for the calibration scoreboard in
            // /app/settings/turn-signals.
            ceoConfidence: extractMaxConfidence(assistantTextBuffer),
          });
        }

        // Memory extraction is now inline (was fire-and-forget) so we can
        // emit `memory_saved` events on the still-open SSE stream — the
        // client surfaces these as Polaris toasts. Skipped on
        // continuation-mode requests (post-approve/reject — merchant didn't
        // say anything new), on pure tool-call turns, AND on slash
        // commands (V2.4 — they're templated text, the extractor will
        // never find new merchant-asserted facts in them; saving one
        // Flash-Lite call per slash invocation). The extractor itself
        // never throws, so a slow/failed Flash-Lite call won't leak
        // into the catch block.
        // Post-stream housekeeping. Three independent passes — each gated
        // on the smallest condition that makes it useful, so abandoned
        // tool-only turns (propose_plan / propose_artifact /
        // ask_clarifying_question with no surrounding text) still get
        // titled and surfaced in the sidebar.
        if (typeof text === "string") {
          // 1. Memory extraction — needs assistant TEXT to learn from.
          //    Tool-only turns produce no prose for the extractor to mine,
          //    so skip. Also skip slash commands (templated, nothing new
          //    in them — saves one Flash-Lite call per invocation).
          if (assistantTextBuffer.trim().length > 0 && !isSlashCommand) {
            const saved = await extractAndStoreMemory({
              storeId: store.id,
              userText: text,
              assistantText: assistantTextBuffer,
            });
            for (const entry of saved) {
              emit("memory_saved", entry);
            }
          }

          // 2. Lazy embedding tick (V4.2) — processes up to 2 unembedded
          //    Decision rows. Runs on every turn regardless of whether
          //    this turn produced text; pending decisions don't care
          //    about this turn's content. Wrapped in try/catch so a
          //    transient embedding outage never leaks.
          try {
            const pending = await listDecisionsNeedingEmbedding(store.id, 2);
            for (const d of pending) {
              const source = buildDecisionEmbeddingSource({
                category: d.category,
                hypothesis: d.hypothesis,
                expectedOutcome: d.expectedOutcome,
                actualOutcome: d.actualOutcome,
              });
              const vec = await embedText(source);
              if (vec !== null) {
                await setDecisionEmbedding({ id: d.id, embedding: vec });
              }
            }
          } catch (err) {
            log.warn("decision embedding tick failed (non-fatal)", {
              err: err instanceof Error ? err.message : String(err),
            });
          }

          // V6.5 — Hallucination guard. Scan the assistant text for
          // price-shaped numbers and check each one against the
          // grounding set (user text + every tool_result this request).
          // Anything that doesn't match the grounding is logged for
          // visibility — v1 is observation-only so we can measure
          // false-positive rate before promoting to a hard signal.
          if (assistantTextBuffer.trim().length > 0) {
            const finding = findHallucinations({
              responseText: assistantTextBuffer,
              groundingTexts,
            });
            if (finding.unverifiedPrices.length > 0) {
              log.warn("hallucination guard: unverified prices in response", {
                conversationId,
                messageId: lastAssistantMessageId,
                unverified: finding.unverifiedPrices,
                groundingSourceCount: groundingTexts.length,
              });
            }
          }

          // 3. First-turn title generation — V5.3 hotfix. Fires when the
          //    conversation is still untitled AND any assistant Message
          //    saved this request (text OR tool-only turn). Previously
          //    this was gated on `assistantTextBuffer > 0`, which meant
          //    propose_plan / propose_artifact / ask_clarifying_question
          //    turns (often pure tool_use, no prose) left the conversation
          //    `title: null` — and api.conversations.tsx filters those out
          //    of the sidebar, so abandoning the merchant before approving
          //    made the conversation invisible.
          //
          //    generateTitle gracefully handles assistantText="" by
          //    falling back to a userText-only synthesis, so this works
          //    even when the CEO emitted no narration.
          //
          //    updateMany with `title: null` prevents two concurrent
          //    requests from both setting (and both emitting) — only
          //    the first writer wins.
          if (conversation.title === null && lastAssistantMessageId !== null) {
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
