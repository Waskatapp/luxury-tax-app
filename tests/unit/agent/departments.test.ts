import { describe, expect, it } from "vitest";

import {
  DEPARTMENTS,
  departmentForTool,
  getDepartment,
  managerTitleForDepartment,
} from "../../../app/lib/agent/departments";

describe("departmentForTool", () => {
  it("maps every V1 read tool to the expected department", () => {
    expect(departmentForTool("read_products")).toBe("products");
    expect(departmentForTool("read_collections")).toBe("products");
    expect(departmentForTool("get_analytics")).toBe("insights");
  });

  it("maps every V1 approval-required write tool to the expected department", () => {
    expect(departmentForTool("update_product_description")).toBe("products");
    expect(departmentForTool("update_product_status")).toBe("products");
    expect(departmentForTool("create_product_draft")).toBe("products");
    expect(departmentForTool("update_product_price")).toBe("pricing-promotions");
    expect(departmentForTool("create_discount")).toBe("pricing-promotions");
  });

  it("returns null for cross-cutting CEO-level tools", () => {
    // update_store_memory is the V1 cross-cutting tool. Future phases will
    // add ask_clarifying_question + propose_plan; both expected to remain
    // department-less.
    expect(departmentForTool("update_store_memory")).toBeNull();
    expect(departmentForTool("ask_clarifying_question")).toBeNull();
    expect(departmentForTool("propose_plan")).toBeNull();
  });

  it("returns null for unknown / typo'd tool names", () => {
    expect(departmentForTool("read_proudcts")).toBeNull();
    expect(departmentForTool("")).toBeNull();
    expect(departmentForTool("totally_made_up")).toBeNull();
  });

  it("every tool listed in DEPARTMENTS round-trips through departmentForTool", () => {
    // Sanity check: the table and the lookup function agree.
    for (const dept of DEPARTMENTS) {
      for (const toolName of dept.toolNames) {
        expect(departmentForTool(toolName)).toBe(dept.id);
      }
    }
  });
});

describe("getDepartment", () => {
  it("returns the department record by id", () => {
    expect(getDepartment("products").label).toBe("Products");
    expect(getDepartment("pricing-promotions").label).toBe(
      "Pricing & Promotions",
    );
    expect(getDepartment("insights").label).toBe("Insights");
  });

  it("manager titles end with ' manager' for the routing pill", () => {
    for (const dept of DEPARTMENTS) {
      expect(dept.managerTitle).toMatch(/ manager$/);
    }
  });
});

describe("managerTitleForDepartment", () => {
  it("returns the manager title for a known id", () => {
    expect(managerTitleForDepartment("products")).toBe("Products manager");
    expect(managerTitleForDepartment("pricing-promotions")).toBe(
      "Pricing & Promotions manager",
    );
    expect(managerTitleForDepartment("insights")).toBe("Insights manager");
  });

  it("returns null for null input (cross-cutting tool case)", () => {
    expect(managerTitleForDepartment(null)).toBeNull();
  });
});

describe("DEPARTMENTS sanity", () => {
  it("no tool appears in two departments", () => {
    const seen = new Set<string>();
    for (const dept of DEPARTMENTS) {
      for (const toolName of dept.toolNames) {
        expect(seen.has(toolName)).toBe(false);
        seen.add(toolName);
      }
    }
  });

  it("every department has at least one tool", () => {
    for (const dept of DEPARTMENTS) {
      expect(dept.toolNames.length).toBeGreaterThan(0);
    }
  });

  it("every department has a non-empty description, label, and managerTitle", () => {
    for (const dept of DEPARTMENTS) {
      expect(dept.label.length).toBeGreaterThan(0);
      expect(dept.managerTitle.length).toBeGreaterThan(0);
      expect(dept.description.length).toBeGreaterThan(0);
    }
  });
});
