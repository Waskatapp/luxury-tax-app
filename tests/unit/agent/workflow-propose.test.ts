import { describe, expect, it } from "vitest";

import {
  buildProposalPrompt,
  parseProposalDraft,
  MAX_PROPOSALS_PER_STORE_PER_RUN,
  PROPOSAL_DEDUPE_WINDOW_MS,
} from "../../../app/lib/agent/workflows/propose.server";

// Phase Wf Round Wf-E — pure-function tests for the Skill Creator's
// prompt builder + LLM-output parser. The DB-touching pieces
// (shouldSkipFingerprint, persistProposal, runWorkflowProposalPass) are
// integration-tested implicitly through the cron run — here we cover the
// shape contracts so a malformed LLM output never makes it into the
// WorkflowProposal table.

describe("buildProposalPrompt", () => {
  it("includes cluster size + sample turns", () => {
    const prompt = buildProposalPrompt({
      cluster: {
        id: "c1",
        storeId: "s1",
        size: 7,
        sampleTurnIds: ["t1", "t2"],
        commonTools: ["update_product_status"],
        commonRouterReason: "missing-product-context",
        dominantOutcome: "abandoned",
        fingerprint: "fp1",
      },
      sampleTurns: [
        {
          userMessage: "archive these 15 products",
          assistantSummary: "I'll need IDs",
          outcome: "abandoned",
        },
      ],
    });
    expect(prompt).toContain("size: 7");
    expect(prompt).toContain("update_product_status");
    expect(prompt).toContain("missing-product-context");
    expect(prompt).toContain("archive these 15 products");
  });

  it("caps sample turns at 5 in the prompt", () => {
    const sampleTurns = Array.from({ length: 10 }, (_, i) => ({
      userMessage: `msg-${i}`,
      assistantSummary: `resp-${i}`,
      outcome: "abandoned",
    }));
    const prompt = buildProposalPrompt({
      cluster: {
        id: "c1",
        storeId: "s1",
        size: 10,
        sampleTurnIds: [],
        commonTools: [],
        commonRouterReason: null,
        dominantOutcome: "abandoned",
        fingerprint: "fp1",
      },
      sampleTurns,
    });
    expect(prompt).toContain("msg-0");
    expect(prompt).toContain("msg-4");
    // 5+ should not be in the prompt (capped).
    expect(prompt).not.toContain("msg-5");
  });

  it("instructs the model to output ONLY a JSON object", () => {
    const prompt = buildProposalPrompt({
      cluster: {
        id: "c1",
        storeId: "s1",
        size: 5,
        sampleTurnIds: [],
        commonTools: [],
        commonRouterReason: null,
        dominantOutcome: "abandoned",
        fingerprint: "fp1",
      },
      sampleTurns: [],
    });
    expect(prompt).toContain("Output ONLY a JSON object");
    expect(prompt).toContain("kebab-case");
    expect(prompt).toContain("triggers");
  });
});

describe("parseProposalDraft — happy paths", () => {
  it("parses a well-formed JSON proposal", () => {
    const raw = JSON.stringify({
      name: "handle-stale-bulk-archive",
      summary: "When bulk-archiving by ID, partition stale IDs first via Re-D",
      triggers: ["bulk archive", "archive products"],
      body: "# Workflow: Stale ID handling\n\nTool: `bulk_update_status`\n\n## When this runs\n\nBulk archive operations.\n\n## Anti-patterns\n\n| Don't | Do instead |\n|---|---|\n| Silently skip missing | Surface count |\n",
    });
    const draft = parseProposalDraft(raw);
    expect(draft).not.toBeNull();
    expect(draft?.name).toBe("handle-stale-bulk-archive");
    expect(draft?.triggers).toEqual(["bulk archive", "archive products"]);
  });

  it("strips ```json wrapping if the model adds it despite instructions", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        name: "test-workflow",
        summary: "A test workflow for the parser",
        triggers: ["foo", "bar"],
        body: "# Workflow: Test\n\nTool: `test_tool`\n\n## When this runs\n\nFor testing the parser. Long enough body to pass minimum size checks for the parser to accept this.\n",
      }) +
      "\n```";
    const draft = parseProposalDraft(raw);
    expect(draft).not.toBeNull();
    expect(draft?.name).toBe("test-workflow");
  });

  it("dedupes + lowercases triggers + caps at 5", () => {
    const raw = JSON.stringify({
      name: "test-wf",
      summary: "Tests trigger normalization",
      triggers: ["FOO", "foo", "Bar", "baz", "qux", "quux", "extra"],
      body: "# Workflow: Test\n\nTool: `test_tool`\n\n## When this runs\n\nLong enough body to pass minimum size checks for the parser to accept this draft as valid input.\n",
    });
    const draft = parseProposalDraft(raw);
    expect(draft).not.toBeNull();
    expect(draft?.triggers).toEqual(["foo", "bar", "baz", "qux", "quux"]);
    expect(draft?.triggers).toHaveLength(5);
  });
});

describe("parseProposalDraft — fail-soft on bad shapes", () => {
  it("returns null on invalid JSON", () => {
    expect(parseProposalDraft("not json at all")).toBeNull();
  });

  it("returns null on missing fields", () => {
    expect(parseProposalDraft(JSON.stringify({ name: "test" }))).toBeNull();
  });

  it("returns null on bad name (uppercase / special chars)", () => {
    const raw = JSON.stringify({
      name: "Bad_Name!",
      summary: "Has bad name",
      triggers: ["foo", "bar"],
      body: "# Workflow: Test\n\nTool: `test_tool`\n\n## When this runs\n\nLong enough body to pass minimum size checks for the parser.\n",
    });
    expect(parseProposalDraft(raw)).toBeNull();
  });

  it("returns null on body too short", () => {
    const raw = JSON.stringify({
      name: "test-wf",
      summary: "Short body",
      triggers: ["foo", "bar"],
      body: "# Tiny\n",
    });
    expect(parseProposalDraft(raw)).toBeNull();
  });

  it("returns null on body too long (DoS guard)", () => {
    const raw = JSON.stringify({
      name: "test-wf",
      summary: "Huge body",
      triggers: ["foo", "bar"],
      body: "x".repeat(20_000),
    });
    expect(parseProposalDraft(raw)).toBeNull();
  });

  it("returns null when triggers < 2 (must be matchable)", () => {
    const raw = JSON.stringify({
      name: "test-wf",
      summary: "Single trigger",
      triggers: ["onlyone"],
      body: "# Workflow: Test\n\nTool: `test_tool`\n\n## When this runs\n\nLong enough body to pass minimum size checks for the parser.\n",
    });
    expect(parseProposalDraft(raw)).toBeNull();
  });

  it("returns null on empty summary", () => {
    const raw = JSON.stringify({
      name: "test-wf",
      summary: "",
      triggers: ["foo", "bar"],
      body: "# Workflow: Test\n\nTool: `test_tool`\n\n## When this runs\n\nLong enough body to pass minimum size checks for the parser.\n",
    });
    expect(parseProposalDraft(raw)).toBeNull();
  });
});

describe("Wf-E constants", () => {
  it("exposes a hard-coded cost cap (no env var)", () => {
    expect(MAX_PROPOSALS_PER_STORE_PER_RUN).toBe(5);
  });

  it("dedupe window is 7 days", () => {
    expect(PROPOSAL_DEDUPE_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
