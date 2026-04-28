import { describe, expect, it } from "vitest";

import {
  filterSlashCommands,
  parseSlashCommand,
  shouldShowPicker,
  SLASH_COMMANDS,
} from "../../../app/lib/agent/slash-commands";

describe("parseSlashCommand", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashCommand("audit")).toBeNull();
    expect(parseSlashCommand("show me my products")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  it("returns null for unknown slash command", () => {
    expect(parseSlashCommand("/banana")).toBeNull();
    expect(parseSlashCommand("/foo bar")).toBeNull();
  });

  it("parses /audit with no args", () => {
    const r = parseSlashCommand("/audit");
    expect(r).not.toBeNull();
    expect(r!.cmd.name).toBe("audit");
    expect(r!.args).toBe("");
    expect(r!.expanded).toContain("Audit my catalog");
    expect(r!.expanded).not.toContain("focus:");
  });

  it("parses /audit with multi-word args", () => {
    const r = parseSlashCommand("/audit pricing and inventory");
    expect(r!.args).toBe("pricing and inventory");
    expect(r!.expanded).toContain("focus: pricing and inventory");
  });

  it("trims trailing whitespace from args", () => {
    const r = parseSlashCommand("/insights last 7 days   ");
    expect(r!.args).toBe("last 7 days");
  });

  it("is case-insensitive on the command name", () => {
    expect(parseSlashCommand("/AUDIT")?.cmd.name).toBe("audit");
    expect(parseSlashCommand("/Insights")?.cmd.name).toBe("insights");
  });

  it("rejects empty args following a hyphenated extension (defensive — no commands today have hyphens but the regex should still match)", () => {
    // Make sure the regex doesn't break on common edge cases.
    expect(parseSlashCommand("/")?.cmd).toBeUndefined();
    expect(parseSlashCommand("/ ")?.cmd).toBeUndefined();
  });

  it("/memory ignores any args (template doesn't use them)", () => {
    const r = parseSlashCommand("/memory whatever");
    expect(r!.cmd.name).toBe("memory");
    expect(r!.expanded).not.toContain("whatever");
  });

  it("each command in SLASH_COMMANDS is parseable", () => {
    for (const cmd of SLASH_COMMANDS) {
      const r = parseSlashCommand(`/${cmd.name}`);
      expect(r).not.toBeNull();
      expect(r!.cmd.name).toBe(cmd.name);
    }
  });
});

describe("filterSlashCommands", () => {
  it("returns the full list for bare '/'", () => {
    expect(filterSlashCommands("/").length).toBe(SLASH_COMMANDS.length);
  });

  it("returns empty for non-slash input", () => {
    expect(filterSlashCommands("audit")).toEqual([]);
    expect(filterSlashCommands("")).toEqual([]);
  });

  it("filters by prefix", () => {
    const r = filterSlashCommands("/a");
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("audit");
  });

  it("filters narrows further as prefix grows", () => {
    expect(filterSlashCommands("/d").map((c) => c.name).sort()).toEqual([
      "diff",
      "discount",
      "draft",
    ]);
    expect(filterSlashCommands("/di").map((c) => c.name).sort()).toEqual([
      "diff",
      "discount",
    ]);
    expect(filterSlashCommands("/dis").map((c) => c.name)).toEqual(["discount"]);
  });

  it("returns empty when no command matches the prefix", () => {
    expect(filterSlashCommands("/zzz")).toEqual([]);
  });
});

describe("shouldShowPicker", () => {
  it.each([
    ["", false],
    ["audit", false],
    ["/", true],
    ["/a", true],
    ["/aud", true],
    ["/audit", true],
    // Once a space appears, the merchant is typing args, not picking
    ["/audit ", false],
    ["/audit pricing", false],
    ["just text", false],
  ])("shouldShowPicker(%j) === %s", (input, expected) => {
    expect(shouldShowPicker(input)).toBe(expected);
  });
});
