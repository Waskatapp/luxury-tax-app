// Phase 8 — eval scenario runner. Stitches: scenario → fakeAdmin →
// runAgentLoop → classifyTurnOutcome → scorer → EvalScenarioResult.
//
// The runner is the SECOND-most-careful piece in this phase (after
// the agent-loop extraction itself). It seeds a Conversation row +
// user Message, invokes runAgentLoop with a fakeAdmin substituted
// for the real Shopify admin, captures the structured emit() events,
// and scores against the scenario's expectations.

import prisma from "../../db.server";

import { runAgentLoop } from "../agent/agent-loop.server";
import { GEMINI_CHAT_MODEL } from "../agent/gemini.server";
import { buildCeoSystemInstruction } from "../agent/ceo-prompt.server";
import { loadWorkflowIndex } from "../agent/workflow-loader.server";
import {
  classifyTurnOutcome,
  extractMaxConfidence,
} from "../agent/turn-signals.server";
import {
  toGeminiContents,
  type ContentBlock,
  type StoredMessage,
} from "../agent/translate.server";
import { fakeAdmin, type FakeAdminResponse } from "../../../tests/helpers/fake-admin";

import { scoreScenario } from "./scorer";
import type { EvalObservation, EvalScenario, EvalScenarioResult } from "./types";

export type RunEvalScenarioOptions = {
  scenario: EvalScenario;
  // Test-store credentials. The runner creates a transient Conversation
  // under this storeId, runs the scenario, leaves the rows in place
  // (so the operator can inspect what the agent did via the chat UI
  // by scrolling to the Conversation if they want).
  storeId: string;
  shopDomain: string;
};

export async function runEvalScenario(
  opts: RunEvalScenarioOptions,
): Promise<EvalScenarioResult> {
  const { scenario, storeId, shopDomain } = opts;
  const startedAt = Date.now();

  // Capture every emit() event from the agent loop into a structured
  // log so the runner can inspect what happened post-run.
  const emittedEvents: Array<{ name: string; payload: unknown }> = [];
  let assistantTextBuffer = "";

  // Seed a Conversation + user Message so the loop has somewhere to
  // persist its assistant turn(s). Title is left null — generateTitle
  // never fires inside the harness because we don't run post-loop
  // housekeeping.
  const conversation = await prisma.conversation.create({
    data: {
      storeId,
      userId: `eval-harness:${scenario.id}`,
      userRole: "STORE_OWNER",
    },
    select: { id: true },
  });
  const userContent: ContentBlock[] = [
    { type: "text", text: scenario.userMessage },
  ];
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: userContent as unknown as object,
    },
  });

  const stored: StoredMessage[] = [{ role: "user", content: userContent }];
  const contents = toGeminiContents(stored);

  // Build the CEO prompt with empty memory/guardrails/insights/decisions
  // — scenarios test the agent's BEHAVIOR independent of any specific
  // store's accumulated context. Future fixtures can override this if
  // we want to test memory-conditioned behavior.
  const systemInstruction = buildCeoSystemInstruction({
    shopDomain,
    memoryMarkdown: null,
    guardrailsMarkdown: null,
    observationsMarkdown: null,
    pastDecisionsMarkdown: null,
    workflowIndex: loadWorkflowIndex(),
    timezone: "UTC",
  });

  const admin = fakeAdmin(scenario.adminResponses as FakeAdminResponse[]);

  let loopError: string | null = null;
  let ranOutOfAdminResponses = false;
  let lastAssistantContent: ContentBlock[] = [];
  let lastAssistantMessageId: string | null = null;
  let writeToolCallIds: string[] = [];

  try {
    const result = await runAgentLoop({
      admin,
      storeId,
      conversationId: conversation.id,
      systemInstruction,
      router: {
        tier: "flash",
        modelId: GEMINI_CHAT_MODEL,
        reason: "eval-harness",
      },
      contents,
      storedSize: stored.length,
      emit: (name, payload) => {
        emittedEvents.push({ name, payload });
        if (name === "text_delta") {
          const p = payload as { delta?: string };
          if (typeof p.delta === "string") assistantTextBuffer += p.delta;
        }
      },
    });
    lastAssistantContent = result.lastAssistantContent;
    lastAssistantMessageId = result.lastAssistantMessageId;
    writeToolCallIds = result.writeToolCallIds;
    assistantTextBuffer = result.assistantTextBuffer;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("fakeAdmin: graphql called more times than responses")) {
      ranOutOfAdminResponses = true;
    } else {
      loopError = msg;
    }
  }

  // Pull terminal PendingAction statuses for outcome classification —
  // matches what api.chat.tsx does at SSE done. In the harness, all
  // writes stay PENDING (no tool-approve pass), so the classifier
  // returns "informational" for write-proposing turns. Scenarios
  // expect that.
  const writeStatuses =
    writeToolCallIds.length > 0
      ? await prisma.pendingAction.findMany({
          where: {
            toolCallId: { in: writeToolCallIds },
            storeId,
          },
          select: { toolCallId: true, status: true },
        })
      : [];
  const outcome = classifyTurnOutcome({
    assistantContent: lastAssistantContent,
    pendingActions: writeStatuses,
  });

  const toolNamesUsed: string[] = [];
  for (const block of lastAssistantContent) {
    if (block.type === "tool_use") {
      toolNamesUsed.push(block.name);
    }
  }

  const observation: EvalObservation = {
    assistantText: assistantTextBuffer,
    toolNamesUsed,
    outcome,
    ceoConfidence: extractMaxConfidence(assistantTextBuffer),
    ranOutOfAdminResponses,
    loopError,
  };

  const score = scoreScenario(scenario.expectations, observation);

  // Touch lastAssistantMessageId to keep it referenced (future commit
  // will surface it in the UI for click-through to the conversation).
  void lastAssistantMessageId;

  return {
    scenarioId: scenario.id,
    description: scenario.description,
    passed: score.passed,
    failedExpectations: score.failedExpectations,
    observation,
    durationMs: Date.now() - startedAt,
  };
}
