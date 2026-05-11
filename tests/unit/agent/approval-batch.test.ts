import { describe, expect, it, vi } from "vitest";

import {
  buildApproveToolResults,
  buildRejectToolResults,
  processApproveBatch,
  processRejectBatch,
  summarizeBatchOutcome,
  validateBatch,
  type PendingRow,
} from "../../../app/lib/agent/approval-batch";

function row(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    id: "p1",
    toolCallId: "update_product_price::abc",
    conversationId: "conv1",
    toolName: "update_product_price",
    toolInput: { variantId: "gid://shopify/ProductVariant/1", newPrice: "50.00" },
    status: "PENDING",
    ...overrides,
  };
}

describe("validateBatch", () => {
  it("rejects empty batch", () => {
    expect(validateBatch([])).toEqual({ ok: false, reason: "no rows" });
  });

  it("rejects batch spanning two conversations", () => {
    const r = validateBatch([
      row({ toolCallId: "a", conversationId: "c1" }),
      row({ toolCallId: "b", conversationId: "c2" }),
    ]);
    expect(r.ok).toBe(false);
  });

  it("returns the conversationId on a single-conversation batch", () => {
    const r = validateBatch([
      row({ toolCallId: "a", conversationId: "c9" }),
      row({ toolCallId: "b", conversationId: "c9" }),
    ]);
    expect(r).toEqual({ ok: true, conversationId: "c9" });
  });
});

describe("processApproveBatch", () => {
  it("single row, succeeds", async () => {
    const r = row();
    const flip = vi.fn().mockResolvedValue({ count: 1 });
    const snapshot = vi.fn().mockResolvedValue({ price: "20.00" });
    const execute = vi.fn().mockResolvedValue({ ok: true, data: { price: "50.00" } });

    const { processed, responseResults } = await processApproveBatch({
      toolCallIds: [r.toolCallId],
      rowByCallId: new Map([[r.toolCallId, r]]),
      flipPending: flip,
      snapshot,
      execute,
    });

    expect(flip).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(processed).toHaveLength(1);
    expect(processed[0].finalStatus).toBe("EXECUTED");
    expect(processed[0].before).toEqual({ price: "20.00" });
    expect(processed[0].after).toEqual({ price: "50.00" });
    expect(responseResults).toEqual([
      { toolCallId: r.toolCallId, status: "EXECUTED" },
    ]);
  });

  it("two rows, both succeed", async () => {
    const a = row({ toolCallId: "a", id: "ra" });
    const b = row({ toolCallId: "b", id: "rb" });
    const flip = vi.fn().mockResolvedValue({ count: 1 });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { price: "50.00" } })
      .mockResolvedValueOnce({ ok: true, data: { price: "50.00" } });

    const { processed, responseResults } = await processApproveBatch({
      toolCallIds: ["a", "b"],
      rowByCallId: new Map([
        ["a", a],
        ["b", b],
      ]),
      flipPending: flip,
      snapshot: async () => null,
      execute,
    });

    expect(processed.map((p) => p.finalStatus)).toEqual(["EXECUTED", "EXECUTED"]);
    expect(processed.every((p) => !p.skip)).toBe(true);
    expect(responseResults).toEqual([
      { toolCallId: "a", status: "EXECUTED" },
      { toolCallId: "b", status: "EXECUTED" },
    ]);
  });

  it("first succeeds, second fails — produces mixed processed list", async () => {
    const a = row({ toolCallId: "a", id: "ra" });
    const b = row({ toolCallId: "b", id: "rb" });
    const flip = vi.fn().mockResolvedValue({ count: 1 });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { price: "50.00" } })
      .mockResolvedValueOnce({ ok: false, error: "Price must be > 0" });

    const { processed, responseResults } = await processApproveBatch({
      toolCallIds: ["a", "b"],
      rowByCallId: new Map([
        ["a", a],
        ["b", b],
      ]),
      flipPending: flip,
      snapshot: async () => null,
      execute,
    });

    expect(processed[0]).toMatchObject({ finalStatus: "EXECUTED", error: null, skip: false });
    expect(processed[1]).toMatchObject({
      finalStatus: "FAILED",
      error: "Price must be > 0",
      skip: false,
    });
    expect(responseResults).toEqual([
      { toolCallId: "a", status: "EXECUTED" },
      { toolCallId: "b", status: "FAILED", error: "Price must be > 0" },
    ]);
  });

  it("already-EXECUTED row is skipped (idempotent retry)", async () => {
    const r = row({ status: "EXECUTED" });
    // updateMany with status:PENDING returns count=0 since it's already EXECUTED.
    const flip = vi.fn().mockResolvedValue({ count: 0 });
    const execute = vi.fn().mockResolvedValue({ ok: true, data: {} });

    const { processed, responseResults } = await processApproveBatch({
      toolCallIds: [r.toolCallId],
      rowByCallId: new Map([[r.toolCallId, r]]),
      flipPending: flip,
      snapshot: async () => null,
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(processed[0].skip).toBe(true);
    expect(processed[0].finalStatus).toBe("EXECUTED");
    expect(responseResults[0]).toEqual({
      toolCallId: r.toolCallId,
      status: "EXECUTED",
      error: "already executed",
    });
  });

  it("missing toolCallId returns 'not found' result without crashing the batch", async () => {
    const a = row({ toolCallId: "a", id: "ra" });
    const flip = vi.fn().mockResolvedValue({ count: 1 });
    const execute = vi.fn().mockResolvedValue({ ok: true, data: {} });

    const { processed, responseResults } = await processApproveBatch({
      toolCallIds: ["a", "ghost"],
      rowByCallId: new Map([["a", a]]),
      flipPending: flip,
      snapshot: async () => null,
      execute,
    });

    // Ghost has no row — counted as a not-found result; processed has only "a".
    expect(processed).toHaveLength(1);
    expect(processed[0].toolCallId).toBe("a");
    expect(responseResults).toEqual([
      { toolCallId: "a", status: "EXECUTED" },
      { toolCallId: "ghost", status: "FAILED", error: "not found" },
    ]);
  });

  it("processes rows sequentially in input order, never in parallel", async () => {
    // Track ordering by recording call timestamps from the execute mock.
    const order: string[] = [];
    const a = row({ toolCallId: "a", id: "ra" });
    const b = row({ toolCallId: "b", id: "rb" });
    const c = row({ toolCallId: "c", id: "rc" });
    const flip = vi.fn().mockResolvedValue({ count: 1 });
    const execute = vi.fn().mockImplementation(async (_name, input) => {
      order.push(String(input.variantId ?? "?"));
      // Yield the loop so any parallel invocation would interleave.
      await new Promise((r) => setTimeout(r, 0));
      return { ok: true, data: {} };
    });

    await processApproveBatch({
      toolCallIds: ["a", "b", "c"],
      rowByCallId: new Map([
        ["a", { ...a, toolInput: { variantId: "A", newPrice: "1" } }],
        ["b", { ...b, toolInput: { variantId: "B", newPrice: "1" } }],
        ["c", { ...c, toolInput: { variantId: "C", newPrice: "1" } }],
      ]),
      flipPending: flip,
      snapshot: async () => null,
      execute,
    });

    expect(order).toEqual(["A", "B", "C"]);
  });
});

describe("processRejectBatch", () => {
  it("flips two PENDING rows to REJECTED", async () => {
    const a = row({ toolCallId: "a", id: "ra" });
    const b = row({ toolCallId: "b", id: "rb" });
    const flip = vi.fn().mockResolvedValue({ count: 1 });

    const { processed, responseResults } = await processRejectBatch({
      toolCallIds: ["a", "b"],
      rowByCallId: new Map([
        ["a", a],
        ["b", b],
      ]),
      flipPending: flip,
    });

    expect(processed.map((p) => p.finalStatus)).toEqual(["REJECTED", "REJECTED"]);
    expect(processed.every((p) => !p.skip)).toBe(true);
    expect(responseResults).toEqual([
      { toolCallId: "a", status: "REJECTED" },
      { toolCallId: "b", status: "REJECTED" },
    ]);
  });

  it("already-EXECUTED row cannot be un-executed via reject (skipped)", async () => {
    const r = row({ status: "EXECUTED" });
    const flip = vi.fn().mockResolvedValue({ count: 0 });

    const { processed, responseResults } = await processRejectBatch({
      toolCallIds: [r.toolCallId],
      rowByCallId: new Map([[r.toolCallId, r]]),
      flipPending: flip,
    });

    expect(processed[0].skip).toBe(true);
    expect(processed[0].finalStatus).toBe("EXECUTED");
    expect(responseResults[0]).toEqual({
      toolCallId: r.toolCallId,
      status: "EXECUTED",
      error: "already executed",
    });
  });
});

describe("buildApproveToolResults", () => {
  it("succeeded row: content is JSON of `after`, is_error false", () => {
    const blocks = buildApproveToolResults([
      {
        pendingId: "p1",
        toolCallId: "tc-1",
        toolName: "update_product_price",
        finalStatus: "EXECUTED",
        before: { price: "20" },
        after: { price: "50" },
        error: null,
        skip: false,
        brief: null,
      },
    ]);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.tool_use_id).toBe("tc-1");
      // V3.3 — outcome-bearing successful writes get an `applied: true`
      // flag + `_note` to nudge propose_followup. The original `after`
      // payload is preserved verbatim alongside.
      const parsed = JSON.parse(block.content);
      expect(parsed.price).toBe("50");
      expect(parsed.applied).toBe(true);
      expect(typeof parsed._note).toBe("string");
      expect(parsed._note).toMatch(/propose_followup/);
      expect(block.is_error).toBe(false);
    }
  });

  it("non-outcome-bearing successful write: no applied flag, no follow-up nudge", () => {
    // Sentinel: only the 4 explicitly-listed outcome-bearing writes get
    // the applied/_note treatment. Everything else passes through
    // verbatim. update_store_memory is the canonical "write that has no
    // measurable outcome" — adding a follow-up here would be noise.
    const [block] = buildApproveToolResults([
      {
        pendingId: "p1",
        toolCallId: "tc-1",
        toolName: "update_store_memory",
        finalStatus: "EXECUTED",
        before: null,
        after: { key: "brand_voice", value: "casual" },
        error: null,
        skip: false,
        brief: null,
      },
    ]);
    if (block.type === "tool_result") {
      const parsed = JSON.parse(block.content);
      expect(parsed).toEqual({ key: "brand_voice", value: "casual" });
      expect(parsed.applied).toBeUndefined();
      expect(parsed._note).toBeUndefined();
    }
  });

  it("failed row: content is JSON of error, is_error true", () => {
    const [block] = buildApproveToolResults([
      {
        pendingId: "p1",
        toolCallId: "tc-1",
        toolName: "update_product_price",
        finalStatus: "FAILED",
        before: null,
        after: null,
        error: "Price must be > 0",
        skip: false,
        brief: null,
      },
    ]);
    if (block.type === "tool_result") {
      expect(JSON.parse(block.content)).toEqual({ error: "Price must be > 0" });
      expect(block.is_error).toBe(true);
    }
  });

  it("skipped (already-terminal) row: content notes existing status, is_error false", () => {
    const [block] = buildApproveToolResults([
      {
        pendingId: "p1",
        toolCallId: "tc-1",
        toolName: "update_product_price",
        finalStatus: "EXECUTED",
        before: null,
        after: null,
        error: null,
        skip: true,
        brief: null,
      },
    ]);
    if (block.type === "tool_result") {
      expect(JSON.parse(block.content)).toEqual({ status: "executed" });
      expect(block.is_error).toBe(false);
    }
  });
});

describe("buildRejectToolResults", () => {
  it("rejected row content is { rejected: true, reason }", () => {
    const [block] = buildRejectToolResults([
      {
        pendingId: "p1",
        toolCallId: "tc-1",
        toolName: "update_product_price",
        finalStatus: "REJECTED",
        skip: false,
      },
    ]);
    if (block.type === "tool_result") {
      expect(JSON.parse(block.content)).toMatchObject({ rejected: true });
      expect(block.is_error).toBe(false);
    }
  });
});

describe("summarizeBatchOutcome", () => {
  it("ok=true when every row EXECUTED", () => {
    expect(
      summarizeBatchOutcome([
        { toolCallId: "a", status: "EXECUTED" },
        { toolCallId: "b", status: "EXECUTED" },
      ]),
    ).toEqual({ ok: true, firstError: null });
  });

  it("ok=false when any row failed; surfaces first error", () => {
    expect(
      summarizeBatchOutcome([
        { toolCallId: "a", status: "EXECUTED" },
        { toolCallId: "b", status: "FAILED", error: "oops" },
        { toolCallId: "c", status: "FAILED", error: "second oops" },
      ]),
    ).toEqual({ ok: false, firstError: "oops" });
  });

  it("ok=false when any row was a skip (rejected/already-executed counts as not-fully-OK)", () => {
    expect(
      summarizeBatchOutcome([
        { toolCallId: "a", status: "EXECUTED" },
        { toolCallId: "b", status: "REJECTED", error: "already rejected" },
      ]),
    ).toEqual({ ok: false, firstError: "already rejected" });
  });
});
