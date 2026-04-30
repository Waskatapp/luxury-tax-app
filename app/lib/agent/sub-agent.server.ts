import type { Content, FunctionCall, Part } from "@google/genai";

import { GEMINI_CHAT_MODEL, getGeminiClient } from "./gemini.server";
import { log } from "../log.server";
import "./departments/registry-entrypoint.server";
import { getDepartmentSpec } from "./departments/registry.server";
import type {
  HandlerContext,
  ProposedWrite,
  SubAgentResult,
} from "./departments/department-spec";
import type { DepartmentId } from "./departments";

// V-Sub-1 — Phase Sub-Agents dispatcher. Runs a focused Gemini turn for
// a single department. Loaded only that department's tools — the CEO's
// prompt stays small. Sub-agent is single-shot per delegation: may run
// multiple internal read-tool rounds (max MAX_ROUNDS), but stops as soon
// as it either (a) emits a final text response (completed) or (b) emits
// a write-tool call (proposed for merchant approval).
//
// Why single-shot: multi-turn sub-agents introduce a halt-and-resume
// dance with the merchant approval flow that's complex to get right and
// has no proven need today. The CEO can re-delegate on the next merchant
// turn if continued work is needed.
//
// Why non-streaming: the sub-agent's output is consumed by the CEO, not
// the merchant. SSE plumbing here adds nothing. Use generateContent
// (non-streaming) for simpler control flow + fewer moving parts.

// Per-call hard cap on internal read-tool rounds. If a sub-agent can't
// finish in 4 reads + 1 final response, something's stuck — bail with
// an error.
const MAX_ROUNDS = 4;

// Conservative output cap. Sub-agent responses are short (summary or
// proposed-write rationale) — never a long-form merchant reply.
const MAX_OUTPUT_TOKENS = 1024;

export type RunSubAgentOptions = {
  departmentId: DepartmentId | string; // accepts pilot id "_pilot" too
  task: string;
  context: HandlerContext;
  // Optional: a brief one-paragraph summary of what's happened in the
  // merchant's main conversation, so the sub-agent has context for its
  // task (e.g., merchant said "the cat food I edited yesterday" — the
  // sub-agent needs to know which product).
  conversationContext?: string;
};

export async function runSubAgent(
  opts: RunSubAgentOptions,
): Promise<SubAgentResult> {
  const spec = getDepartmentSpec(opts.departmentId as DepartmentId);
  if (!spec) {
    return {
      kind: "error",
      reason: `Unknown department: ${opts.departmentId}. Available: ${getKnownDepartments().join(", ")}.`,
    };
  }

  // Build the user message: task + optional context.
  const userMessage = opts.conversationContext
    ? `${opts.task}\n\n---\nContext from the merchant's main conversation:\n${opts.conversationContext}`
    : opts.task;

  // History accumulates across internal rounds so each call sees the
  // model's prior tool calls + their results.
  const history: Content[] = [
    { role: "user", parts: [{ text: userMessage }] },
  ];

  let readsExecuted = 0;
  const proposedWrites: ProposedWrite[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let response;
    try {
      const ai = getGeminiClient();
      response = await ai.models.generateContent({
        model: GEMINI_CHAT_MODEL,
        contents: history,
        config: {
          systemInstruction: spec.systemPrompt,
          tools: [{ functionDeclarations: spec.toolDeclarations }],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      });
    } catch (err) {
      log.warn("sub-agent: Gemini call failed", {
        departmentId: spec.id,
        round,
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        kind: "error",
        reason: `Sub-agent LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const candidate = response.candidates?.[0];
    if (!candidate?.content) {
      return {
        kind: "error",
        reason: "Sub-agent produced no candidate content",
      };
    }

    const parts: Part[] = candidate.content.parts ?? [];
    const functionCalls: FunctionCall[] = [];
    const textChunks: string[] = [];

    for (const part of parts) {
      if (part.functionCall) functionCalls.push(part.functionCall);
      if (part.text) textChunks.push(part.text);
    }

    // No tool calls → sub-agent finished. Either it produced a final
    // summary, OR (if proposed writes accumulated in earlier rounds) we
    // return those as the pending actions.
    if (functionCalls.length === 0) {
      const summary = textChunks.join("").trim();

      if (proposedWrites.length > 0) {
        return {
          kind: "proposed_writes",
          writes: proposedWrites,
          rationale: summary || "(no rationale provided)",
        };
      }

      return {
        kind: "completed",
        summary: summary || "(empty response)",
        readsExecuted,
      };
    }

    // Append the model's turn (with its function calls) to history so
    // the next round sees the full conversation.
    history.push({ role: "model", parts });

    // Process each function call. Reads execute inline; writes get
    // collected and break the loop after this round.
    const functionResponseParts: Part[] = [];
    let sawWrite = false;

    for (const call of functionCalls) {
      const toolName = call.name ?? "";
      if (!toolName) {
        functionResponseParts.push({
          functionResponse: {
            name: "unknown",
            response: { error: "tool call had no name" },
          },
        });
        continue;
      }

      // Validate the tool is one this department actually owns. The
      // model SHOULDN'T hallucinate tools (we only gave it our schemas)
      // but defensive check.
      if (!spec.handlers.has(toolName)) {
        functionResponseParts.push({
          functionResponse: {
            name: toolName,
            response: {
              error: `tool '${toolName}' is not part of the ${spec.id} department`,
            },
          },
        });
        continue;
      }

      const isWrite =
        spec.classification.write.has(toolName);
      const isInlineWrite =
        spec.classification.inlineWrite.has(toolName);

      if (isWrite) {
        // Approval-gated write. Collect for return; don't execute.
        proposedWrites.push({
          toolName,
          toolInput: (call.args ?? {}) as Record<string, unknown>,
        });
        // Feed the model a synthetic "queued for merchant approval"
        // result so it can finalize its rationale on the next round
        // (or just stop). Real execution happens after merchant approves
        // in the main conversation.
        functionResponseParts.push({
          functionResponse: {
            name: toolName,
            response: {
              status: "queued_for_merchant_approval",
              message:
                "This write has been queued. The merchant will see an approval card in their main conversation. Stop here and provide a brief rationale.",
            },
          },
        });
        sawWrite = true;
        continue;
      }

      // Read tool (or inline write) — execute via the handler.
      const handler = spec.handlers.get(toolName);
      if (!handler) {
        // Unreachable given the .has() check above, but the type system
        // requires this guard.
        continue;
      }

      let result;
      try {
        result = await handler(call.args ?? {}, opts.context);
      } catch (err) {
        log.warn("sub-agent: handler threw", {
          departmentId: spec.id,
          toolName,
          err: err instanceof Error ? err.message : String(err),
        });
        result = {
          ok: false as const,
          error: `handler threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!isInlineWrite) readsExecuted++;

      functionResponseParts.push({
        functionResponse: {
          name: toolName,
          response: result.ok
            ? { result: result.data }
            : { error: result.error },
        },
      });
    }

    // Push the function-response turn (the "user" role per Gemini's
    // function-calling convention — the API expects function results
    // as user-role messages).
    history.push({ role: "user", parts: functionResponseParts });

    // If we saw any write in this round, the next iteration will let the
    // model produce its final rationale, then we return proposed_writes.
    // If we didn't, the loop continues and the model can call more tools.
    if (sawWrite) {
      // One more round so the model can produce a final rationale text,
      // then we'll exit via the no-function-calls branch above.
      continue;
    }
  }

  // Hit the round cap without finishing.
  log.warn("sub-agent: hit MAX_ROUNDS without producing a final response", {
    departmentId: spec.id,
    rounds: MAX_ROUNDS,
    readsExecuted,
    proposedWritesCount: proposedWrites.length,
  });

  if (proposedWrites.length > 0) {
    return {
      kind: "proposed_writes",
      writes: proposedWrites,
      rationale:
        "(sub-agent hit round limit; queueing the writes it had drafted)",
    };
  }

  return {
    kind: "error",
    reason: `Sub-agent did not finish within ${MAX_ROUNDS} rounds.`,
  };
}

// Pure helper for tests + error messages.
function getKnownDepartments(): string[] {
  // Imported lazily to avoid circular import with registry.
  // The registry is populated by the registry-entrypoint side-effect
  // import at the top of this file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { allDepartmentSpecs } = require("./departments/registry.server") as typeof import("./departments/registry.server");
  return allDepartmentSpecs().map((s) => s.id);
}
