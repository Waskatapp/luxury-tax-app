// Phase Mn Round Mn-1 — `brief` field on tool calls.
//
// The CEO's department managers (sub-agents) propose write tool calls; on
// approval, those land as PendingAction rows. Without a "why," the AuditLog
// shows WHAT changed but never WHY. This module injects an optional
// `brief` parameter into every write tool's FunctionDeclaration centrally,
// so individual department modules don't each duplicate the field.
//
// The injection is purely additive — `brief` is optional, not in `required`.
// Zod schemas in the underlying handlers `.strip()` unknown keys by default,
// so the handler never sees `brief`. Extraction happens at the agent-loop
// boundary (PendingAction.create) where we hoist `brief` into its own DB
// column.

import type { FunctionDeclaration } from "@google/genai";

export const BRIEF_MAX_LEN = 200;

const BRIEF_PROPERTY = {
  type: "string",
  description:
    "One short sentence explaining WHY this action is being taken (≤200 chars). Flows into the audit log so operators can read your reasoning, not just the action. Examples: \"Merchant requested weekend sale price drop\", \"Cleaning up demo snowboard products before US launch\", \"Bundle discount aligns with Q2 promo plan\". Skip for trivial / merchant-obvious actions.",
} as const;

// Inject `brief` into the parametersJsonSchema.properties of each declaration
// whose name is in `writeToolNames`. Returns a new array; inputs are not
// mutated.
export function injectBriefIntoWriteDeclarations(
  declarations: FunctionDeclaration[],
  writeToolNames: Set<string>,
): FunctionDeclaration[] {
  return declarations.map((d) => {
    if (!d.name || !writeToolNames.has(d.name)) return d;
    const params = d.parametersJsonSchema as
      | {
          type?: string;
          properties?: Record<string, unknown>;
          required?: string[];
        }
      | undefined;
    if (!params || params.type !== "object") return d;
    if (params.properties && "brief" in params.properties) return d; // already present
    return {
      ...d,
      parametersJsonSchema: {
        ...params,
        properties: {
          ...(params.properties ?? {}),
          brief: BRIEF_PROPERTY,
        },
      },
    };
  });
}

// Pull `brief` from a tool_use input, returning the trimmed string or null.
// Caller is responsible for stripping `brief` from the input before passing
// to validation/handlers — see `stripBrief()`.
export function extractBrief(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = (input as Record<string, unknown>).brief;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, BRIEF_MAX_LEN);
}

// Return a shallow copy of `input` with the `brief` key removed. Safe to
// pass to Zod schemas + handlers downstream.
export function stripBrief(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const obj = input as Record<string, unknown>;
  if (!("brief" in obj)) return obj;
  const { brief: _brief, ...rest } = obj;
  return rest;
}
