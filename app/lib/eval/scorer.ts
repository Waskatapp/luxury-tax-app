// Phase 8 — pure scenario scorer. No DB, no network, no clock.
// Same input → same output. Deterministic by design so a failed
// scenario is always reproducible offline.

import type { EvalExpectation, EvalObservation } from "./types";

export type ScoreResult = {
  passed: boolean;
  failedExpectations: string[];
};

export function scoreScenario(
  expectation: EvalExpectation,
  observation: EvalObservation,
): ScoreResult {
  const failed: string[] = [];

  if (observation.loopError !== null) {
    failed.push(`loop crashed: ${observation.loopError}`);
  }
  if (observation.ranOutOfAdminResponses) {
    failed.push(
      "ran out of canned admin responses — scenario's adminResponses[] is too short",
    );
  }

  if (expectation.mustCallTool && expectation.mustCallTool.length > 0) {
    const used = new Set(observation.toolNamesUsed);
    for (const required of expectation.mustCallTool) {
      if (!used.has(required)) {
        failed.push(
          `expected tool "${required}" to be called; saw [${observation.toolNamesUsed.join(", ") || "none"}]`,
        );
      }
    }
  }

  if (expectation.mustNotCallTool && expectation.mustNotCallTool.length > 0) {
    for (const forbidden of expectation.mustNotCallTool) {
      if (observation.toolNamesUsed.includes(forbidden)) {
        failed.push(
          `expected tool "${forbidden}" to NOT be called, but it was`,
        );
      }
    }
  }

  if (
    expectation.outcomeShouldBe !== undefined &&
    observation.outcome !== expectation.outcomeShouldBe
  ) {
    failed.push(
      `outcome was "${observation.outcome}", expected "${expectation.outcomeShouldBe}"`,
    );
  }

  if (expectation.mustContainText && expectation.mustContainText.length > 0) {
    const haystack = observation.assistantText.toLowerCase();
    for (const needle of expectation.mustContainText) {
      if (!haystack.includes(needle.toLowerCase())) {
        failed.push(
          `assistant text missing required substring "${needle}"`,
        );
      }
    }
  }

  if (
    typeof expectation.confidenceFloor === "number" &&
    expectation.confidenceFloor > 0
  ) {
    const conf = observation.ceoConfidence;
    if (conf === null) {
      failed.push(
        `expected confidence ≥ ${expectation.confidenceFloor.toFixed(2)} but no Confidence tag was emitted`,
      );
    } else if (conf < expectation.confidenceFloor) {
      failed.push(
        `confidence ${conf.toFixed(2)} below floor ${expectation.confidenceFloor.toFixed(2)}`,
      );
    }
  }

  return {
    passed: failed.length === 0,
    failedExpectations: failed,
  };
}
