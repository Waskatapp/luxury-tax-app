import { describe, expect, it } from "vitest";

import { deriveHeaderStatus } from "../../../app/components/chat/ApprovalCard";
import type { PendingActionStatus } from "../../../app/hooks/useChat";

function item(status: PendingActionStatus | undefined) {
  return {
    toolCallId: `tc-${Math.random()}`,
    toolName: "update_product_price",
    toolInput: {},
    status,
  };
}

describe("deriveHeaderStatus", () => {
  it("PENDING wins when any item is still pending", () => {
    expect(deriveHeaderStatus([item("EXECUTED"), item("PENDING")])).toBe(
      "PENDING",
    );
  });

  it("undefined item status (no DB sidecar yet) treated as PENDING", () => {
    expect(deriveHeaderStatus([item(undefined), item("EXECUTED")])).toBe(
      "PENDING",
    );
  });

  it("FAILED beats REJECTED beats APPROVED beats EXECUTED", () => {
    expect(deriveHeaderStatus([item("EXECUTED"), item("REJECTED")])).toBe(
      "REJECTED",
    );
    expect(deriveHeaderStatus([item("EXECUTED"), item("FAILED")])).toBe(
      "FAILED",
    );
    expect(deriveHeaderStatus([item("FAILED"), item("REJECTED")])).toBe(
      "FAILED",
    );
    expect(deriveHeaderStatus([item("APPROVED"), item("EXECUTED")])).toBe(
      "APPROVED",
    );
  });

  it("all-EXECUTED batch returns EXECUTED (success header)", () => {
    expect(deriveHeaderStatus([item("EXECUTED"), item("EXECUTED")])).toBe(
      "EXECUTED",
    );
  });

  it("single-item batch defers to that item's status", () => {
    expect(deriveHeaderStatus([item("EXECUTED")])).toBe("EXECUTED");
    expect(deriveHeaderStatus([item("REJECTED")])).toBe("REJECTED");
    expect(deriveHeaderStatus([item(undefined)])).toBe("PENDING");
  });
});
