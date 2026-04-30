import type { FunctionDeclaration } from "@google/genai";
import { z } from "zod";

import {
  registerDepartment,
} from "../registry.server";
import type {
  DepartmentSpec,
  HandlerContext,
  ToolHandler,
} from "../department-spec";
import type { ToolResult } from "../../executor.server";

// V-Sub-1 — Phase Sub-Agents pilot department. Minimal smoke-test
// surface for the dispatcher infrastructure. NOT a real department.
//
// Removed from the registry in Sub-5 once Insights/Products/Pricing
// have all migrated and the architecture is locked in. Until then,
// the CEO can `delegate_to_department("_pilot", ...)` for end-to-end
// validation that:
//   1. The dispatcher resolves the department via the registry
//   2. The sub-agent's focused Gemini turn loads only this dept's tools
//   3. A read-tool call executes inline via the handler
//   4. The sub-agent returns SubAgentResult.completed
//
// The pilot has ONE read tool (`pilot_echo`) and zero writes. The write
// path is validated for real in Sub-3 (Products migration).
//
// We intentionally do NOT add `_pilot` to the DepartmentId union in
// departments.ts — the type system would treat it as a real department.
// Instead, the pilot uses a runtime cast (the dispatcher accepts any
// DepartmentSpec.id string at runtime even if the static type union is
// narrower). The `_` prefix marks it as internal/test-only.

const PILOT_ECHO_INPUT = z.object({
  message: z.string().min(1).max(200),
});

const pilotEchoDeclaration: FunctionDeclaration = {
  name: "pilot_echo",
  description:
    "Smoke-test tool. Returns the input message unchanged. Used only to validate the sub-agent dispatcher works end-to-end.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Any short string. Will be echoed back.",
      },
    },
    required: ["message"],
  },
};

const pilotEchoHandler: ToolHandler = async (
  input: unknown,
  _ctx: HandlerContext,
): Promise<ToolResult> => {
  const parsed = PILOT_ECHO_INPUT.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `pilot_echo: invalid input — ${parsed.error.message}` };
  }
  return { ok: true, data: { echoed: parsed.data.message } };
};

const PILOT_SPEC: DepartmentSpec = {
  // Cast: "_pilot" isn't in the DepartmentId union (intentional — see
  // module comment). The dispatcher accepts any string at runtime.
  id: "_pilot" as unknown as DepartmentSpec["id"],
  label: "Pilot (smoke test)",
  managerTitle: "Pilot manager",
  description:
    "Internal smoke-test department. Not a real department — used only to validate the sub-agent dispatcher infrastructure. Will be removed before any production tools migrate.",
  systemPrompt: `You are the Pilot manager — an internal test fixture, not a real department.

Your only tool is \`pilot_echo\`. When the CEO delegates a task to you, call \`pilot_echo\` once with a short summary of the task as the message, then respond with a one-line confirmation that the dispatcher worked.

Keep responses short. This is a smoke test.`,
  toolDeclarations: [pilotEchoDeclaration],
  handlers: new Map<string, ToolHandler>([
    ["pilot_echo", pilotEchoHandler],
  ]),
  classification: {
    read: new Set(["pilot_echo"]),
    write: new Set(),
    inlineWrite: new Set(),
  },
};

// Register on module load. The registry entrypoint imports this file,
// which fires this side effect.
registerDepartment(PILOT_SPEC);

// Exported for tests that want to assert the spec shape directly.
export { PILOT_SPEC };
