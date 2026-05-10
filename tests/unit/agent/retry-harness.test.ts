import { describe, expect, it, vi } from "vitest";

import { withRetry } from "../../../app/lib/agent/executor.server";

// Phase Re Round Re-B — auto-retry harness tests. Use fake sleepFn so
// tests don't actually wait 30 seconds. Each test verifies a specific
// branch of the retry decision tree:
//   - retryable + idempotent → retries once
//   - !retryable → no retry
//   - !idempotent → no retry (even if retryable)
//   - first attempt OK → no retry
//   - retry-then-fails → returns final failure
//   - notify callback fires before sleep
//   - wallclock budget protects against retries that won't fit

const RETRYABLE_BURST_FAIL = {
  ok: false as const,
  error: "HTTP 429",
  code: "RATE_LIMITED_BURST" as const,
  retryable: true,
};

const NON_RETRYABLE_FAIL = {
  ok: false as const,
  error: "product not found",
  code: "ID_NOT_FOUND" as const,
  retryable: false,
};

const SUCCESS = { ok: true as const, data: { archived: 1 } };

const noSleep = (_ms: number) => Promise.resolve();

describe("withRetry — retryable + idempotent path", () => {
  it("retries once on RATE_LIMITED_BURST when tool is idempotent and retry succeeds", async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls++;
      return calls === 1 ? RETRYABLE_BURST_FAIL : SUCCESS;
    });
    const result = await withRetry("update_product_status", attempt, {
      sleepFn: noSleep,
    });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it("returns the second-attempt failure when retry also fails", async () => {
    const attempt = vi.fn(async () => RETRYABLE_BURST_FAIL);
    const result = await withRetry("update_product_status", attempt, {
      sleepFn: noSleep,
    });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RATE_LIMITED_BURST");
  });

  it("fires notify callback BEFORE sleep with delay info", async () => {
    const sleepCalls: number[] = [];
    const notifyCalls: Array<{
      toolName: string;
      delaySeconds: number;
      reasonCode: string;
    }> = [];

    let attemptCount = 0;
    const attempt = async () => {
      attemptCount++;
      // Verify notify already fired before this second attempt runs
      if (attemptCount === 2) {
        expect(notifyCalls).toHaveLength(1);
        expect(sleepCalls).toHaveLength(1);
      }
      return attemptCount === 1 ? RETRYABLE_BURST_FAIL : SUCCESS;
    };

    await withRetry("bulk_update_status", attempt, {
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
      notify: (info) => {
        notifyCalls.push({
          toolName: info.toolName,
          delaySeconds: info.delaySeconds,
          reasonCode: info.reasonCode,
        });
      },
    });

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].toolName).toBe("bulk_update_status");
    expect(notifyCalls[0].reasonCode).toBe("RATE_LIMITED_BURST");
    // Default backoff for RATE_LIMITED_BURST is 30s ±20% jitter.
    expect(notifyCalls[0].delaySeconds).toBeGreaterThanOrEqual(24);
    expect(notifyCalls[0].delaySeconds).toBeLessThanOrEqual(36);
  });
});

describe("withRetry — no-retry paths", () => {
  it("does NOT retry when first attempt succeeds", async () => {
    const attempt = vi.fn(async () => SUCCESS);
    const result = await withRetry("update_product_status", attempt, {
      sleepFn: noSleep,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("does NOT retry when error is not retryable (ID_NOT_FOUND)", async () => {
    const attempt = vi.fn(async () => NON_RETRYABLE_FAIL);
    const result = await withRetry("update_product_status", attempt, {
      sleepFn: noSleep,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it("does NOT retry when tool is NOT in IDEMPOTENT_TOOLS", async () => {
    // create_discount is non-idempotent: each call creates a new discount
    // record. Auto-retry could create a duplicate.
    const attempt = vi.fn(async () => RETRYABLE_BURST_FAIL);
    const result = await withRetry("create_discount", attempt, {
      sleepFn: noSleep,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it("does NOT retry when wallclock budget is too tight", async () => {
    const attempt = vi.fn(async () => RETRYABLE_BURST_FAIL);
    // Budget of 1s — 30s backoff doesn't fit, so no retry.
    const result = await withRetry("update_product_status", attempt, {
      sleepFn: noSleep,
      maxWallclockMs: 1000,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });
});

describe("withRetry — fail-soft", () => {
  it("wraps thrown exceptions on first attempt as classified failure (no retry — thunks shouldn't throw)", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("HTTP 429 throttled");
    });
    const result = await withRetry("update_product_status", attempt, {
      sleepFn: noSleep,
    });
    // The thunk's contract is to return ToolResult on both success and
    // failure paths. An exception means the thunk itself broke — the
    // retry harness wraps it via fail() and returns. No retry: a thunk
    // that throws is a bug, and re-running it would just throw again.
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RATE_LIMITED_BURST");
  });

  it("survives a notifier that throws", async () => {
    let calls = 0;
    const attempt = async () => {
      calls++;
      return calls === 1 ? RETRYABLE_BURST_FAIL : SUCCESS;
    };
    const result = await withRetry("update_product_status", attempt, {
      sleepFn: noSleep,
      notify: () => {
        throw new Error("listener went boom");
      },
    });
    // Notifier blow-up should NOT prevent the retry; result is success.
    expect(result.ok).toBe(true);
  });
});

describe("withRetry — backoff selection by code", () => {
  it("uses 30s base backoff for RATE_LIMITED_BURST", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const attempt = async () => {
      calls++;
      return calls === 1 ? RETRYABLE_BURST_FAIL : SUCCESS;
    };
    await withRetry("read_products", attempt, {
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toHaveLength(1);
    // 30s ±20% jitter = [24s, 36s]
    expect(sleeps[0]).toBeGreaterThanOrEqual(24_000);
    expect(sleeps[0]).toBeLessThanOrEqual(36_000);
  });

  it("uses 5s base backoff for NETWORK", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const attempt = async () => {
      calls++;
      return calls === 1
        ? {
            ok: false as const,
            error: "ECONNRESET",
            code: "NETWORK" as const,
            retryable: true,
          }
        : SUCCESS;
    };
    await withRetry("read_products", attempt, {
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toHaveLength(1);
    // 5s ±20% = [4s, 6s]
    expect(sleeps[0]).toBeGreaterThanOrEqual(4_000);
    expect(sleeps[0]).toBeLessThanOrEqual(6_000);
  });
});
