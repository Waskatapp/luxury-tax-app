import type { EvalScenario } from "../types";

// Smoke test: a bare greeting should NOT trigger any tool calls.
// Regression bar: if the CEO prompt drifts toward "always fetch
// store context first" and starts firing read_products on "hi",
// this scenario fails.

export const greetingNoToolsScenario: EvalScenario = {
  id: "greeting-no-tools",
  description:
    "Bare greeting from merchant should produce a text-only response with zero tool calls.",
  userMessage: "hi",
  adminResponses: [],
  expectations: {
    mustNotCallTool: [
      "read_products",
      "read_collections",
      "delegate_to_department",
      "ask_clarifying_question",
      "propose_plan",
    ],
    outcomeShouldBe: "informational",
  },
};
