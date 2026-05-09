import type { EvalScenario } from "../types";

// Pure acknowledgment ("thanks", "great", etc.) should produce a
// brief text response with zero tool calls. Regression bar: if the
// CEO prompt drifts toward over-helpfulness and starts proactively
// fetching context on every "thanks", this catches it.

export const thanksAcknowledgmentScenario: EvalScenario = {
  id: "thanks-acknowledgment",
  description:
    "Pure acknowledgment should be a short text reply, no tool calls.",
  userMessage: "thanks!",
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
