import type { EvalScenario } from "../types";

// Vague intent should trigger ask_clarifying_question, not a guess.
// Regression bar: a quarter of the 222-turn corpus ended in
// "clarified" or "abandoned" — many of those are turns where the
// CEO either guessed wrong or dove into the wrong tool. This
// scenario pins down the right behavior on the most ambiguous
// possible input: "make my store better."

export const ambiguousNeedsClarificationScenario: EvalScenario = {
  id: "ambiguous-needs-clarification",
  description:
    "Highly ambiguous merchant request should produce ask_clarifying_question, not a tool guess.",
  userMessage: "make my store better",
  adminResponses: [],
  expectations: {
    mustCallTool: ["ask_clarifying_question"],
    mustNotCallTool: [
      "delegate_to_department",
      "propose_plan",
      "update_product_price",
    ],
    outcomeShouldBe: "clarified",
  },
};
