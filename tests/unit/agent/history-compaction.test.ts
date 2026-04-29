import { describe, expect, it } from "vitest";

import {
  bareToolName,
  collectProposeArtifactIds,
  compactAppliedArtifacts,
  compactOldToolResults,
  type StoredMessage,
} from "../../../app/lib/agent/translate.server";

// V2.5a — old tool_result bodies are summarized before history is replayed
// to Gemini. These tests pin down the cutoff math, the per-tool summary
// shapes, and the defensive fallthroughs.

function userText(text: string): StoredMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): StoredMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolUse(name: string, input: Record<string, unknown>): StoredMessage {
  return {
    role: "assistant",
    content: [
      { type: "tool_use", id: `${name}::id-${Math.random().toString(36).slice(2, 8)}`, name, input },
    ],
  };
}

function userToolResult(toolName: string, content: unknown, opts: { isError?: boolean } = {}): StoredMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: `${toolName}::id-${Math.random().toString(36).slice(2, 8)}`,
        content: typeof content === "string" ? content : JSON.stringify(content),
        is_error: opts.isError,
      },
    ],
  };
}

describe("bareToolName", () => {
  it("extracts the encoded tool name from `<name>::<uuid>` ids", () => {
    expect(bareToolName("read_products::abc-123")).toBe("read_products");
  });

  it("returns null for ids without the `::` separator (legacy)", () => {
    expect(bareToolName("just-a-uuid")).toBeNull();
  });

  it("returns null for empty strings", () => {
    expect(bareToolName("")).toBeNull();
  });
});

describe("compactOldToolResults", () => {
  it("is a no-op when stored.length <= recentWindow", () => {
    const stored = [
      userText("hi"),
      assistantText("hello"),
      userText("show products"),
      assistantToolUse("read_products", { query: "snowboard" }),
      userToolResult("read_products", { products: [{ title: "Snowboard A" }, { title: "Snowboard B" }] }),
      assistantText("here are 2 snowboards"),
    ];
    const out = compactOldToolResults(stored, { recentWindow: 10 });
    expect(out).toEqual(stored);
  });

  it("summarizes read_products tool_results outside the recent window", () => {
    // 3 old messages (will be compacted) + 10 recent messages (verbatim).
    const oldStored: StoredMessage[] = [
      userText("show products"),
      assistantToolUse("read_products", { query: "snowboard" }),
      userToolResult("read_products", {
        products: [
          { title: "Alpine Cruiser", id: "1" },
          { title: "Beach Carver", id: "2" },
          { title: "Mountain Dropper", id: "3" },
          { title: "Powder Floater", id: "4" },
          { title: "Park Smasher", id: "5" },
          { title: "Race Daemon", id: "6" },
        ],
      }),
    ];
    const recentStored: StoredMessage[] = Array.from({ length: 10 }, (_, i) =>
      userText(`recent ${i}`),
    );
    const stored = [...oldStored, ...recentStored];

    const out = compactOldToolResults(stored, { recentWindow: 10 });

    // Old tool_result body should be replaced with the summary.
    const compactedToolResult = out[2].content[0];
    expect(compactedToolResult.type).toBe("tool_result");
    if (compactedToolResult.type === "tool_result") {
      expect(compactedToolResult.content).toContain("read_products");
      expect(compactedToolResult.content).toContain("6 products");
      expect(compactedToolResult.content).toContain("Alpine Cruiser");
      expect(compactedToolResult.content).toContain("+1 more"); // 6 total, 5 shown
      // Original verbose body is gone.
      expect(compactedToolResult.content).not.toContain('"id":"1"');
    }

    // Recent messages pass through unchanged (referential equality).
    for (let i = 0; i < recentStored.length; i++) {
      expect(out[3 + i]).toBe(recentStored[i]);
    }
  });

  it("summarizes read_collections with title list + count", () => {
    const stored: StoredMessage[] = [
      userText("show me collections"),
      assistantToolUse("read_collections", {}),
      userToolResult("read_collections", {
        collections: [
          { title: "New Arrivals" },
          { title: "Sale" },
        ],
      }),
      ...Array.from({ length: 10 }, (_, i) => userText(`pad ${i}`)),
    ];
    const out = compactOldToolResults(stored, { recentWindow: 10 });
    const block = out[2].content[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toContain("read_collections");
      expect(block.content).toContain("2 collection");
      expect(block.content).toContain("New Arrivals, Sale");
    }
  });

  it("summarizes get_analytics with stable fields", () => {
    const stored: StoredMessage[] = [
      userText("revenue?"),
      assistantToolUse("get_analytics", { metric: "revenue", days: 30 }),
      userToolResult("get_analytics", { metric: "revenue", days: 30, amount: 12345.67, currency: "USD" }),
      ...Array.from({ length: 10 }, (_, i) => userText(`pad ${i}`)),
    ];
    const out = compactOldToolResults(stored, { recentWindow: 10 });
    const block = out[2].content[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toContain("get_analytics");
      expect(block.content).toContain("metric=revenue");
      expect(block.content).toContain("days=30");
      expect(block.content).toContain("amount=12345.67");
    }
  });

  it("summarizes read_workflow with the workflow name", () => {
    const stored: StoredMessage[] = [
      userText("show me the price-change SOP"),
      assistantToolUse("read_workflow", { name: "price-change" }),
      userToolResult("read_workflow", { name: "price-change", body: "long markdown body...".repeat(50) }),
      ...Array.from({ length: 10 }, (_, i) => userText(`pad ${i}`)),
    ];
    const out = compactOldToolResults(stored, { recentWindow: 10 });
    const block = out[2].content[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toContain("read_workflow");
      expect(block.content).toContain("price-change");
      expect(block.content).not.toContain("long markdown");
    }
  });

  it("preserves error tool_results verbatim (the CEO needs the error text)", () => {
    const errorBody = JSON.stringify({ error: "shopify userErrors: variant not found" });
    const stored: StoredMessage[] = [
      userText("update price"),
      assistantToolUse("update_product_price", { variantId: "x", newPrice: "1.00" }),
      userToolResult("update_product_price", errorBody, { isError: true }),
      ...Array.from({ length: 10 }, (_, i) => userText(`pad ${i}`)),
    ];
    const out = compactOldToolResults(stored, { recentWindow: 10 });
    const block = out[2].content[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.is_error).toBe(true);
      expect(block.content).toBe(errorBody);
    }
  });

  it("leaves text and tool_use blocks alone", () => {
    const stored: StoredMessage[] = [
      userText("hello"),
      assistantText("hi there, here is a long response that should NOT be compacted"),
      assistantToolUse("read_products", { query: "x" }),
      ...Array.from({ length: 10 }, (_, i) => userText(`pad ${i}`)),
    ];
    const out = compactOldToolResults(stored, { recentWindow: 10 });
    expect(out[1]).toBe(stored[1]); // assistant text untouched
    expect(out[2]).toBe(stored[2]); // tool_use untouched
  });

  it("leaves tool_results verbatim when the tool name can't be resolved (defensive)", () => {
    const stored: StoredMessage[] = [
      userText("foo"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "legacy-id-without-double-colon",
            content: JSON.stringify({ products: [{ title: "A" }] }),
          },
        ],
      },
      ...Array.from({ length: 10 }, (_, i) => userText(`pad ${i}`)),
    ];
    const out = compactOldToolResults(stored, { recentWindow: 10 });
    const block = out[1].content[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toContain("products");
      expect(block.content).toContain("A");
    }
  });

  it("leaves tool_results verbatim for tools without a registered summarizer", () => {
    const stored: StoredMessage[] = [
      userText("save memory"),
      assistantToolUse("update_store_memory", {}),
      userToolResult("update_store_memory", { saved: true }),
      ...Array.from({ length: 10 }, (_, i) => userText(`pad ${i}`)),
    ];
    const out = compactOldToolResults(stored, { recentWindow: 10 });
    const block = out[2].content[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toContain('"saved":true');
    }
  });

  it("leaves tool_results verbatim when the JSON is malformed (defensive)", () => {
    const stored: StoredMessage[] = [
      userText("ok"),
      assistantToolUse("read_products", {}),
      userToolResult("read_products", "not valid json {"),
      ...Array.from({ length: 10 }, (_, i) => userText(`pad ${i}`)),
    ];
    const out = compactOldToolResults(stored, { recentWindow: 10 });
    const block = out[2].content[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toBe("not valid json {");
    }
  });

  it("uses the default recent window of 10 when no opts are passed", () => {
    const stored = Array.from({ length: 11 }, (_, i) =>
      i === 0
        ? userToolResult("read_products", { products: [{ title: "X" }] })
        : userText(`pad ${i}`),
    );
    const out = compactOldToolResults(stored);
    // Index 0 is "old" (10-message window means indices 1..10 are recent)
    const block = out[0].content[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toContain("read_products result, summarized");
    }
  });
});

// V2.5a — applied propose_artifact bodies don't need to live in history
// forever. The canonical content is in the Artifact row + already on
// Shopify; we replace the tool_use input's `content` field with a short
// placeholder for non-DRAFT artifacts.

function assistantProposeArtifact(
  id: string,
  input: Record<string, unknown>,
): StoredMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name: "propose_artifact",
        input,
      },
    ],
  };
}

describe("collectProposeArtifactIds", () => {
  it("returns the ids of every propose_artifact tool_use in stored history", () => {
    const stored: StoredMessage[] = [
      userText("draft a description"),
      assistantProposeArtifact("propose_artifact::a", { content: "<p>A</p>" }),
      userText("now another"),
      assistantProposeArtifact("propose_artifact::b", { content: "<p>B</p>" }),
    ];
    expect(collectProposeArtifactIds(stored)).toEqual([
      "propose_artifact::a",
      "propose_artifact::b",
    ]);
  });

  it("ignores tool_use blocks for other tools", () => {
    const stored: StoredMessage[] = [
      assistantToolUse("read_products", {}),
      assistantProposeArtifact("propose_artifact::a", { content: "<p>A</p>" }),
    ];
    expect(collectProposeArtifactIds(stored)).toEqual(["propose_artifact::a"]);
  });

  it("ignores tool_use blocks in user-role messages (defensive)", () => {
    const stored: StoredMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_use", id: "propose_artifact::x", name: "propose_artifact", input: { content: "x" } },
        ],
      },
    ];
    expect(collectProposeArtifactIds(stored)).toEqual([]);
  });

  it("returns [] for an empty history", () => {
    expect(collectProposeArtifactIds([])).toEqual([]);
  });
});

describe("compactAppliedArtifacts", () => {
  it("replaces content for APPROVED artifacts with the applied placeholder", () => {
    const stored: StoredMessage[] = [
      assistantProposeArtifact("propose_artifact::a", {
        productId: "gid://shopify/Product/1",
        productTitle: "Cat Food",
        content: "<p>Long HTML body</p>",
      }),
    ];
    const out = compactAppliedArtifacts(stored, [
      { toolCallId: "propose_artifact::a", status: "APPROVED" },
    ]);
    const block = out[0].content[0];
    expect(block.type).toBe("tool_use");
    if (block.type === "tool_use") {
      expect(block.input.content).toContain("artifact applied");
      expect(block.input.content).not.toContain("Long HTML body");
      // Other input fields preserved.
      expect(block.input.productTitle).toBe("Cat Food");
    }
  });

  it("uses the discarded placeholder for DISCARDED artifacts", () => {
    const stored: StoredMessage[] = [
      assistantProposeArtifact("propose_artifact::a", { content: "<p>x</p>" }),
    ];
    const out = compactAppliedArtifacts(stored, [
      { toolCallId: "propose_artifact::a", status: "DISCARDED" },
    ]);
    const block = out[0].content[0];
    if (block.type === "tool_use") {
      expect(block.input.content).toContain("artifact discarded");
    }
  });

  it("preserves DRAFT artifacts verbatim (panel may still be open)", () => {
    const stored: StoredMessage[] = [
      assistantProposeArtifact("propose_artifact::a", { content: "<p>still editing</p>" }),
    ];
    const out = compactAppliedArtifacts(stored, [
      { toolCallId: "propose_artifact::a", status: "DRAFT" },
    ]);
    expect(out[0]).toBe(stored[0]); // referential equality — untouched
  });

  it("preserves artifacts with unknown ids verbatim (defensive)", () => {
    const stored: StoredMessage[] = [
      assistantProposeArtifact("propose_artifact::a", { content: "<p>x</p>" }),
    ];
    const out = compactAppliedArtifacts(stored, []);
    expect(out[0]).toBe(stored[0]);
  });

  it("is a no-op when statuses is empty", () => {
    const stored: StoredMessage[] = [
      assistantProposeArtifact("propose_artifact::a", { content: "<p>x</p>" }),
      userText("hi"),
    ];
    const out = compactAppliedArtifacts(stored, []);
    expect(out).toBe(stored);
  });

  it("leaves non-propose_artifact tool_use blocks alone", () => {
    const stored: StoredMessage[] = [
      assistantToolUse("read_products", { query: "x" }),
      assistantProposeArtifact("propose_artifact::a", { content: "<p>x</p>" }),
    ];
    const out = compactAppliedArtifacts(stored, [
      { toolCallId: "propose_artifact::a", status: "APPROVED" },
      // read_products id wouldn't be in the status list anyway, but verify
      // we don't accidentally rewrite based on name match.
      { toolCallId: "read_products::abc", status: "APPROVED" },
    ]);
    expect(out[0]).toBe(stored[0]);
  });

  it("handles REJECTED status the same as APPROVED (applied placeholder)", () => {
    // The artifact lifecycle today is DRAFT → APPROVED | DISCARDED, with
    // REJECTED reserved for a future "reject without discard" UX. We
    // bucket it with applied so the placeholder still hides the body.
    const stored: StoredMessage[] = [
      assistantProposeArtifact("propose_artifact::a", { content: "<p>x</p>" }),
    ];
    const out = compactAppliedArtifacts(stored, [
      { toolCallId: "propose_artifact::a", status: "REJECTED" },
    ]);
    const block = out[0].content[0];
    if (block.type === "tool_use") {
      expect(block.input.content).toContain("artifact applied");
    }
  });
});
