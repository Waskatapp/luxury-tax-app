import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetRegistryForTest,
  allDepartmentSpecs,
  departmentForTool,
  getDepartmentSpec,
  registerDepartment,
} from "../../../app/lib/agent/departments/registry.server";
import {
  makeFakeDepartmentSpec,
} from "../../../app/lib/agent/departments/department-spec";
import type {
  DepartmentSpec,
  ToolHandler,
} from "../../../app/lib/agent/departments/department-spec";

beforeEach(() => {
  __resetRegistryForTest();
});

const fakeHandler: ToolHandler = async () => ({ ok: true, data: null });

describe("registerDepartment + getDepartmentSpec", () => {
  it("registers a department and looks it up by id", () => {
    const spec = makeFakeDepartmentSpec({ id: "products" });
    registerDepartment(spec);
    expect(getDepartmentSpec("products")).toBe(spec);
  });

  it("returns null for an unregistered id (caller must handle)", () => {
    expect(getDepartmentSpec("insights")).toBeNull();
  });

  it("registering with the same id REPLACES the prior spec (idempotent)", () => {
    const a = makeFakeDepartmentSpec({ id: "products", label: "First" });
    const b = makeFakeDepartmentSpec({ id: "products", label: "Second" });
    registerDepartment(a);
    registerDepartment(b);
    expect(getDepartmentSpec("products")?.label).toBe("Second");
  });
});

describe("allDepartmentSpecs", () => {
  it("returns empty when no departments registered", () => {
    expect(allDepartmentSpecs()).toEqual([]);
  });

  it("returns specs in insertion order", () => {
    const a = makeFakeDepartmentSpec({ id: "products" });
    const b = makeFakeDepartmentSpec({ id: "insights" });
    const c = makeFakeDepartmentSpec({ id: "pricing-promotions" });
    registerDepartment(a);
    registerDepartment(b);
    registerDepartment(c);
    expect(allDepartmentSpecs().map((s) => s.id)).toEqual([
      "products",
      "insights",
      "pricing-promotions",
    ]);
  });
});

describe("departmentForTool", () => {
  function specWithTools(
    id: DepartmentSpec["id"],
    toolNames: string[],
  ): DepartmentSpec {
    const handlers = new Map<string, ToolHandler>();
    for (const name of toolNames) handlers.set(name, fakeHandler);
    return makeFakeDepartmentSpec({ id, handlers });
  }

  it("finds the owning department for a registered tool", () => {
    registerDepartment(specWithTools("products", ["read_products"]));
    registerDepartment(specWithTools("insights", ["get_analytics"]));
    expect(departmentForTool("read_products")).toBe("products");
    expect(departmentForTool("get_analytics")).toBe("insights");
  });

  it("returns null for unknown tools (CEO meta-tools, typos, etc.)", () => {
    registerDepartment(specWithTools("products", ["read_products"]));
    expect(departmentForTool("propose_plan")).toBeNull();
    expect(departmentForTool("nonexistent_tool")).toBeNull();
  });
});

describe("makeFakeDepartmentSpec defaults", () => {
  it("produces a spec with empty handlers/declarations and empty classification sets", () => {
    const spec = makeFakeDepartmentSpec({ id: "insights" });
    expect(spec.handlers.size).toBe(0);
    expect(spec.toolDeclarations).toEqual([]);
    expect(spec.classification.read.size).toBe(0);
    expect(spec.classification.write.size).toBe(0);
    expect(spec.classification.inlineWrite.size).toBe(0);
  });

  it("allows overriding any field including label and prompt", () => {
    const spec = makeFakeDepartmentSpec({
      id: "products",
      label: "Custom Products",
      systemPrompt: "Custom prompt body.",
    });
    expect(spec.label).toBe("Custom Products");
    expect(spec.systemPrompt).toBe("Custom prompt body.");
  });
});
