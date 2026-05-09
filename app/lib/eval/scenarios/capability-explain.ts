import type { EvalScenario } from "../types";

// "What can you do?" should produce a text-only response describing
// capabilities. NO tool calls — this is the agent introducing
// itself, not actually doing work.
//
// Regression bar: the agent should mention concrete domains
// (products, prices, customers, orders, inventory, marketing,
// insights) so the merchant knows what to ask for. If the prompt
// drifts and the agent gives a generic "I'm here to help" without
// listing capabilities, this fails.

export const capabilityExplainScenario: EvalScenario = {
  id: "capability-explain",
  description:
    "Capability question should produce a text-only response naming the agent's domains.",
  userMessage: "what can you help me with?",
  adminResponses: [],
  expectations: {
    mustNotCallTool: [
      "read_products",
      "read_collections",
      "delegate_to_department",
      "propose_plan",
    ],
    outcomeShouldBe: "informational",
    // Loose substring match — at least one of these domain words
    // should appear in the answer. Case-insensitive matcher.
    mustContainText: ["product"],
  },
};
