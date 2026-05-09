// Phase 8 — curated scenario barrel. Empty in commit 5; populated in
// commit 3 (deferred — needs the Gemini-mock pattern this phase
// introduces). The harness is fully functional with zero scenarios:
// it runs the routing-analyzer pass and persists an EvalRun row with
// totalScenarios=0.

import type { EvalScenario } from "../types";

export const SCENARIOS: EvalScenario[] = [];
