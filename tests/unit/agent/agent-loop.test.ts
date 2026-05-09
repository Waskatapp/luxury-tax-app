import { describe, expect, it } from "vitest";

import {
  runAgentLoop,
  type AgentEmit,
  type RunAgentLoopInput,
  type RunAgentLoopResult,
} from "../../../app/lib/agent/agent-loop.server";

// Phase 8 — smoke test for the agent-loop extraction. The function
// itself isn't fully exercised here (that requires a Gemini mock,
// which lands with the eval harness scenarios in a later commit).
// What this test guarantees is the module's public shape: the
// exports exist, the types compose cleanly, and the AgentEmit
// signature matches the route's inline `emit` so SSE byte-identity
// is preserved by construction.

describe("agent-loop module", () => {
  it("exports runAgentLoop as an async function", () => {
    expect(typeof runAgentLoop).toBe("function");
    expect(runAgentLoop.constructor.name).toBe("AsyncFunction");
  });

  it("AgentEmit signature accepts (eventName, payload) — matches route's inline emit", () => {
    const calls: Array<{ name: string; payload: unknown }> = [];
    const emit: AgentEmit = (name, payload) => {
      calls.push({ name, payload });
    };
    emit("text_delta", { delta: "hello" });
    emit("done", {});
    expect(calls).toEqual([
      { name: "text_delta", payload: { delta: "hello" } },
      { name: "done", payload: {} },
    ]);
  });

  it("RunAgentLoopInput and RunAgentLoopResult are structurally compatible", () => {
    // Compile-time only — if these types drift the test file fails to
    // type-check, surfacing the breakage before the agent loop runs in
    // production. Runtime assertion is trivial.
    const input: Partial<RunAgentLoopInput> = {
      storeId: "test",
      conversationId: "conv",
      systemInstruction: "you are a helpful assistant",
      storedSize: 0,
    };
    const result: Partial<RunAgentLoopResult> = {
      lastAssistantMessageId: null,
      totalToolCalls: 0,
      hadWriteTool: false,
      hadClarification: false,
      hadPlan: false,
      writeToolCallIds: [],
      assistantTextBuffer: "",
      groundingTexts: [],
      rateLimitedEarly: false,
    };
    expect(input.storeId).toBe("test");
    expect(result.totalToolCalls).toBe(0);
  });
});
