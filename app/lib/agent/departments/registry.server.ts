import type { DepartmentId } from "../departments";
import type { DepartmentSpec } from "./department-spec";

// V-Sub-1 — Phase Sub-Agents. Central registry of department modules.
// Each department's index.ts registers its DepartmentSpec here at module
// load time. The sub-agent dispatcher and the post-approval executor
// look up departments via this registry.
//
// Source-of-truth: this registry is the ONLY way to enumerate
// departments at runtime. departments.ts (the legacy flat file with
// DEPARTMENTS array + toolNames[]) is preserved untouched in Sub-1 for
// backward compat with the routing pill UI; it gets retired in Sub-5
// after all tools have been migrated.
//
// Order of registration is irrelevant — the registry is keyed by
// department id (a string enum). At app boot, the registry imports each
// department module which calls registerDepartment() exactly once.

const REGISTRY = new Map<DepartmentId, DepartmentSpec>();

// Register a department. Called from each department's index.ts as a
// side effect of being imported. Idempotent — re-registering with the
// same id REPLACES the prior entry. (Useful for tests; production
// shouldn't hit this path because each department registers once at
// boot via app/lib/agent/departments/registry-entrypoint.server.ts.)
export function registerDepartment(spec: DepartmentSpec): void {
  REGISTRY.set(spec.id, spec);
}

// Look up a single department. Returns null if not registered — callers
// must handle this (the dispatcher returns SubAgentResult { kind:
// "error", reason: "unknown department" }).
export function getDepartmentSpec(id: DepartmentId): DepartmentSpec | null {
  return REGISTRY.get(id) ?? null;
}

// All registered departments. Used by the CEO prompt assembler to list
// available departments + their tools (registry-driven instead of
// reading toolNames[] off departments.ts in Sub-5). Order is insertion
// order, which is the order departments are imported by
// registry-entrypoint.
export function allDepartmentSpecs(): DepartmentSpec[] {
  return Array.from(REGISTRY.values());
}

// Reverse lookup: which department owns this tool? Returns null for
// CEO meta-tools (which don't belong to any department) and for unknown
// tool names. Used by api.tool-approve.tsx to dispatch executeApprovedWrite
// into the correct department's handler in Sub-3+.
export function departmentForTool(toolName: string): DepartmentId | null {
  for (const spec of REGISTRY.values()) {
    if (spec.handlers.has(toolName)) return spec.id;
  }
  return null;
}

// Test seam: clear the registry between tests. NEVER called in production.
// Real production code calls registerDepartment via module side effects
// at boot, then never touches the registry again.
export function __resetRegistryForTest(): void {
  REGISTRY.clear();
}
