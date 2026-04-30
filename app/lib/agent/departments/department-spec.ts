import type { FunctionDeclaration } from "@google/genai";

import type { ShopifyAdmin } from "../../shopify/graphql-client.server";
import type { ToolResult } from "../executor.server";
import type { DepartmentId } from "../departments";

// V-Sub-1 — Phase Sub-Agents. Shared types for the department-scoped
// MCP-shaped architecture. Each department lives at app/lib/agent/
// departments/<id>/ as a self-contained module exporting a
// DepartmentSpec; the registry enumerates them; the sub-agent dispatcher
// (sub-agent.server.ts) loads one department's tools per delegated turn.
//
// Posture: in-process, NOT literal MCP. The shape mirrors MCP (tool
// definition + handler pair, exposed via a registry) so a future move to
// real MCP servers is mechanical, but everything runs inside one Node
// process today. See plan: phase-sub-agents.

// ----- Tool handlers -----

// Identical contract to executor.server.ts → executeTool's per-tool
// switch arms. Same input/output types so existing handlers can be
// lifted into department modules with no signature change.
export type ToolHandler = (
  input: unknown,
  ctx: HandlerContext,
) => Promise<ToolResult>;

// Subset of executor.server.ts's ToolContext — everything a domain
// handler needs. Note: conversationId/toolCallId optional because some
// callers (snapshotBefore, post-approval execution) don't have them in
// scope. Same convention as the existing ToolContext.
export type HandlerContext = {
  storeId: string;
  admin: ShopifyAdmin;
  conversationId?: string;
  toolCallId?: string;
};

// ----- Tool classification (per-department) -----

// Each department self-classifies its tools so the dispatcher knows
// whether a tool call is an inline read (execute now), an approval-gated
// write (halt sub-agent and propose to merchant), or an inline write
// (memory-only mutations that don't need approval — extremely rare in
// domain departments, but the slot exists for symmetry with the central
// classifier today).
export type DepartmentClassification = {
  read: Set<string>;
  write: Set<string>; // approval-gated; goes through PendingAction
  inlineWrite: Set<string>; // inline; no approval (memory-only writes)
};

// ----- Department spec (the unit of registration) -----

export type DepartmentSpec = {
  // Identity — must match a DepartmentId in departments.ts
  id: DepartmentId;
  label: string;
  managerTitle: string;
  description: string;

  // System prompt for the sub-agent's focused Gemini turn. Loaded from
  // prompt.md via Vite's `?raw` import. Keep it tight — sub-agent
  // prompts only need the manager's role + their tool philosophy, NOT
  // the full CEO prompt. The dispatcher prepends/appends shared context
  // (today's date, merchant identity, the task) at runtime.
  systemPrompt: string;

  // Gemini-shaped tool declarations for THIS department only. Loaded
  // into the sub-agent's `generateContentStream` call so the model only
  // sees this department's tools.
  toolDeclarations: FunctionDeclaration[];

  // tool name → handler. Map (not record) for fast .has() / .get().
  // Handlers MUST validate input (Zod) and return ToolResult — never
  // throw out into the dispatcher.
  handlers: Map<string, ToolHandler>;

  classification: DepartmentClassification;
};

// ----- Sub-agent results -----

// What the sub-agent produces after a single delegated turn. Discriminated
// union so the CEO orchestration layer can branch cleanly:
//   - completed: sub-agent finished its work using only reads + reasoning,
//     summary string is the human-readable result the CEO weaves into its
//     reply.
//   - proposed_writes: sub-agent wants to mutate state. Each ProposedWrite
//     becomes a PendingAction in the merchant's main conversation,
//     rendered as a normal ApprovalCard. The merchant approves/rejects
//     in their main UI; on approval, executeApprovedWrite dispatches into
//     the owning department's handler.
//   - needs_clarification: sub-agent couldn't proceed without merchant
//     input. CEO surfaces the question to the merchant in plain text.
//   - error: dispatcher or sub-agent itself failed. CEO falls back to
//     direct reasoning (rule 17 out-of-catalog mode) and surfaces the
//     limitation honestly.
export type SubAgentResult =
  | {
      kind: "completed";
      summary: string;
      readsExecuted: number; // telemetry only — count of read tool calls
    }
  | {
      kind: "proposed_writes";
      writes: ProposedWrite[];
      rationale: string; // sub-agent's explanation, surfaced with the approval card
    }
  | {
      kind: "needs_clarification";
      question: string;
    }
  | {
      kind: "error";
      reason: string;
    };

// A write the sub-agent wants the merchant to approve. The toolName must
// belong to the same department that produced this — the dispatcher
// validates and the executor enforces (via department-registry.lookup).
export type ProposedWrite = {
  toolName: string;
  toolInput: Record<string, unknown>;
  // Optional: a one-liner the sub-agent wants the merchant to see ABOVE
  // the standard ApprovalCard diff ("rewrote in cheekier voice — see
  // diff below"). The CEO can ignore this if the rationale already covers
  // the ground.
  preview?: string;
};

// ----- Test seam -----

// Exported only for tests: lets a unit test build a fake DepartmentSpec
// without importing all the real modules. Real production code should
// always import a real spec from app/lib/agent/departments/<id>/.
export function makeFakeDepartmentSpec(
  override: Partial<DepartmentSpec> & Pick<DepartmentSpec, "id">,
): DepartmentSpec {
  return {
    label: override.label ?? "Fake",
    managerTitle: override.managerTitle ?? "Fake manager",
    description: override.description ?? "Test fixture department.",
    systemPrompt: override.systemPrompt ?? "You are a test department manager.",
    toolDeclarations: override.toolDeclarations ?? [],
    handlers: override.handlers ?? new Map(),
    classification:
      override.classification ?? {
        read: new Set(),
        write: new Set(),
        inlineWrite: new Set(),
      },
    ...override,
  };
}
