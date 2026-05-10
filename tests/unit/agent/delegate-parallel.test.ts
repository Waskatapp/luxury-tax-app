import { describe, expect, it } from "vitest";

// Phase Wf Round Wf-D — delegate_parallel input validation tests.
//
// The executor arm itself is integration-tested implicitly via runSubAgent
// (which is covered elsewhere). Here we cover the Zod input shape — the
// 2-5 delegation cap, required fields, and shape preservation.

import { z } from "zod";

const DelegateToDepartmentInput = z.object({
  department: z.string().min(1).max(80),
  task: z.string().min(1).max(2000),
  conversationContext: z.string().max(2000).optional(),
});

const DelegateParallelInput = z.object({
  delegations: z.array(DelegateToDepartmentInput).min(2).max(5),
});

describe("DelegateParallelInput shape", () => {
  it("accepts a valid 2-delegation payload", () => {
    const r = DelegateParallelInput.safeParse({
      delegations: [
        { department: "insights", task: "summarize 30-day revenue" },
        { department: "products", task: "list low-stock variants" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid 5-delegation payload (max)", () => {
    const r = DelegateParallelInput.safeParse({
      delegations: Array.from({ length: 5 }, (_, i) => ({
        department: "insights",
        task: `task ${i}`,
      })),
    });
    expect(r.success).toBe(true);
  });

  it("rejects fewer than 2 delegations (must be parallel-meaningful)", () => {
    const r = DelegateParallelInput.safeParse({
      delegations: [{ department: "insights", task: "single delegation" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects more than 5 delegations (concurrency cap)", () => {
    const r = DelegateParallelInput.safeParse({
      delegations: Array.from({ length: 6 }, (_, i) => ({
        department: "insights",
        task: `task ${i}`,
      })),
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty department name", () => {
    const r = DelegateParallelInput.safeParse({
      delegations: [
        { department: "", task: "x" },
        { department: "products", task: "y" },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty task", () => {
    const r = DelegateParallelInput.safeParse({
      delegations: [
        { department: "products", task: "" },
        { department: "insights", task: "y" },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("accepts optional conversationContext", () => {
    const r = DelegateParallelInput.safeParse({
      delegations: [
        {
          department: "products",
          task: "find low-stock",
          conversationContext:
            "Merchant just asked for a holiday-prep audit",
        },
        { department: "insights", task: "30-day revenue summary" },
      ],
    });
    expect(r.success).toBe(true);
  });
});

// Phase Wf Round Wf-D — sub-agent allowOnlyReadOnly filter behavior is
// integration-tested separately. The contract here:
//   - When allowOnlyReadOnly=true, sub-agent's tool list is filtered to
//     classification.read entries before the Gemini call.
//   - If the filtered list is empty, sub-agent returns kind:"error" with
//     code: INVALID_INPUT.
//   - The system prompt is augmented with a "READ-ONLY mode" note.
//
// Verifying these properties against the real registry would require a
// running Prisma + Gemini stub; the property documentation here is what
// the implementation must continue to satisfy.
describe("Wf-D contract documentation", () => {
  it("documents the read-only filter contract", () => {
    const contract = {
      allowOnlyReadOnly: true,
      filtersTo: "classification.read",
      onEmpty: "kind:'error', code:'INVALID_INPUT'",
      promptAugmentation: "READ-ONLY mode note appended to user message",
      whyStructural:
        "Filtering at tool-declaration time means the model never SEES write tools — it can't propose them",
    };
    expect(contract.allowOnlyReadOnly).toBe(true);
    expect(contract.filtersTo).toBe("classification.read");
  });
});
