// Phase 8b — curated scenario barrel. First batch focuses on
// CEO prompt-level behavior (zero admin calls). Future commits add
// scenarios that exercise tool flows + sub-agent delegation, which
// require canned Shopify responses in adminResponses.
//
// These are NOT vitest tests — they're data fixtures consumed by
// the cron-driven runner (scripts/run-eval-harness.ts → runEvalScenario).
// Each runs against the real Gemini API; expect ~5-15s per scenario.

import type { EvalScenario } from "../types";

import { ambiguousNeedsClarificationScenario } from "./ambiguous-needs-clarification";
import { capabilityExplainScenario } from "./capability-explain";
import { greetingNoToolsScenario } from "./greeting-no-tools";
import { thanksAcknowledgmentScenario } from "./thanks-acknowledgment";

export const SCENARIOS: EvalScenario[] = [
  greetingNoToolsScenario,
  thanksAcknowledgmentScenario,
  capabilityExplainScenario,
  ambiguousNeedsClarificationScenario,
];
