// Phase 8 — eval harness public types. Pure module — no DB, no SDK.
//
// A scenario describes a merchant turn we want the agent to handle a
// specific way. A scorer compares the agent's actual behavior against
// the scenario's expectations and emits a pass/fail with diagnostics.
// A run aggregates many scenario results into one nightly summary.

import type { TurnOutcome } from "../agent/turn-signals.server";
import type { FakeAdminResponse } from "../../../tests/helpers/fake-admin";

// What the agent SHOULD do for this scenario. All fields optional — a
// scenario sets only the constraints it actually wants to assert.
export type EvalExpectation = {
  // Tools that MUST appear in the assistant's tool_use blocks (any
  // order, any count ≥ 1). Names match what the agent emits — e.g.
  // "delegate_to_department" or a concrete tool like "bulk_update_titles"
  // (when the sub-agent surfaces it via synthetic tool_use).
  mustCallTool?: string[];
  // Tools that MUST NOT appear. Useful for "agent shouldn't propose a
  // write here" assertions on read-only intents.
  mustNotCallTool?: string[];
  // The classified outcome at SSE done. Sub-Pending writes classify
  // as "informational" until tool-approve runs (which doesn't happen
  // in the harness), so write-proposing scenarios expect
  // "informational" not "approved".
  outcomeShouldBe?: TurnOutcome;
  // Substrings (case-insensitive) that must appear in the accumulated
  // assistant text. The matcher is forgiving — it lowercases both
  // sides and uses includes(), so "low stock" matches "Low Stock"
  // and "running low on stock" matches "running LOW on Stock".
  mustContainText?: string[];
  // Lower bound on the highest `Confidence: 0.X` tag the agent
  // emits this turn. Null means no constraint. 0.0 also means no
  // constraint (any confidence passes including null).
  confidenceFloor?: number;
};

// Inputs needed to run one scenario through the agent stack.
export type EvalScenario = {
  // Stable identifier — also the file basename. Used as the row key
  // in EvalRun.summary so we can diff runs over time.
  id: string;
  // Human-readable label rendered in the operator UI.
  description: string;
  // What the merchant typed in. The harness uses this verbatim — no
  // sanitization or translation.
  userMessage: string;
  // Canned Shopify GraphQL responses, in the order the agent will
  // call them. The harness wraps these in fakeAdmin and substitutes
  // the real admin client. If the agent makes more calls than there
  // are responses, fakeAdmin throws (which we catch and surface as
  // an "unexpected admin call" failure).
  adminResponses: FakeAdminResponse[];
  // What the agent should do. Empty object means "no constraints" —
  // the scenario passes as long as the loop runs to done() without
  // crashing. That's a useful smoke-only fixture for new tools.
  expectations: EvalExpectation;
};

// What the harness observes about one scenario's run. Carries the
// FULL agent output so a failure surfaces a debug trail, not a
// yes/no boolean.
export type EvalObservation = {
  // The accumulated assistant text across the loop's iterations.
  assistantText: string;
  // Every tool name the agent called this turn (including synthetic
  // tool_use blocks lifted from sub-agent results).
  toolNamesUsed: string[];
  // The outcome the harness's classifier produced. Same code path as
  // production via classifyTurnOutcome — so passing scenarios are
  // grounded in the same notion of "outcome" as the 75% abandonment
  // metric the eval harness is meant to debug.
  outcome: TurnOutcome;
  // Highest Confidence: 0.X tag in the assistant text, or null when
  // the turn didn't warrant one.
  ceoConfidence: number | null;
  // True when fakeAdmin ran out of canned responses mid-run — the
  // scenario's adminResponses array was too short for what the
  // agent actually did.
  ranOutOfAdminResponses: boolean;
  // Truthy when the loop threw before reaching done.
  loopError: string | null;
};

export type EvalScenarioResult = {
  scenarioId: string;
  description: string;
  passed: boolean;
  // One human-readable string per failed expectation. Empty when
  // passed === true. Surfaced verbatim in the operator UI.
  failedExpectations: string[];
  observation: EvalObservation;
  durationMs: number;
};

// One nightly run summary. Persisted as one EvalRun row.
export type EvalRunSummary = {
  runAt: Date;
  totalScenarios: number;
  passed: number;
  failed: number;
  durationMs: number;
  results: EvalScenarioResult[];
};
