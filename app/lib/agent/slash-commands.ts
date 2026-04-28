// V2.4 — keyboard-driven shortcuts for power users. Pure parser + the
// command list. Lives without `.server` so the ChatInput popover can
// import it for the picker UI.
//
// Behavior: when the merchant types `/<name> [args]`, the client expands
// the entire input into a fully-formed prompt before submitting. Server
// receives only the expanded text — no special-casing needed in
// api.chat.tsx beyond reading `text` as usual. The merchant's bubble
// shows the expanded version (clearer than `/audit` two days later when
// they re-read the conversation).

export type ModelTierHint = "flash" | "flash-lite";

export type SlashCommand = {
  name: string;
  // One-line label rendered in the picker. Stays short so 6+ commands
  // fit in the popover without scrolling.
  description: string;
  // Hint surfaced under the description in the picker.
  argHint: string;
  // Pure expansion. `args` is whatever followed `/<name> ` after the
  // first space, trimmed. Empty string means no args were given.
  promptTemplate: (args: string) => string;
  // Hint to model-router.ts for tier selection. We hard-code per command
  // because we know the shape of the workload — `/insights` is always a
  // read-only summary, `/audit` always plans. The router still has the
  // last word; this is just the floor.
  tier: ModelTierHint;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "audit",
    description: "Audit catalog for issues",
    argHint: "Optional: focus area (e.g. 'pricing', 'inventory', 'descriptions')",
    promptTemplate: (a) =>
      `Audit my catalog${a ? ` (focus: ${a})` : ""} for missing descriptions, broken status, low stock, and pricing anomalies. Propose a fix plan.`,
    tier: "flash",
  },
  {
    name: "draft",
    description: "Draft a product description",
    argHint: "Required: product name (e.g. 'cat food bag')",
    promptTemplate: (a) =>
      `Draft a product description for ${a || "the product I'm about to specify"}.`,
    tier: "flash",
  },
  {
    name: "diff",
    description: "Show recent changes",
    argHint: "Optional: timeframe (e.g. '7 days', '24 hours')",
    promptTemplate: (a) =>
      `Show me what's changed in the last ${a || "7 days"} from the audit log.`,
    tier: "flash-lite",
  },
  {
    name: "discount",
    description: "Plan a discount",
    argHint: "Optional: target (e.g. 'hoodies', '10% off snowboards')",
    promptTemplate: (a) =>
      `Plan a discount${a ? ` for ${a}` : ""} — propose percent, target products, and dates.`,
    tier: "flash",
  },
  {
    name: "insights",
    description: "Snapshot of store performance",
    argHint: "Optional: timeframe (e.g. '7 days', '90 days'); default 30",
    promptTemplate: (a) =>
      `Snapshot of revenue, top products, and inventory at risk for the last ${a || "30 days"}.`,
    tier: "flash-lite",
  },
  {
    name: "memory",
    description: "What you remember",
    argHint: "No args needed",
    promptTemplate: () =>
      `Summarize what you remember about my store, brand, and preferences.`,
    tier: "flash-lite",
  },
];

const COMMAND_BY_NAME = new Map(SLASH_COMMANDS.map((c) => [c.name, c]));

export type ParsedSlashCommand = {
  cmd: SlashCommand;
  args: string;
  expanded: string;
};

// Pure parser. Returns null if the text doesn't start with `/<known>`.
// Trailing whitespace in args is stripped; preserved internal whitespace
// for multi-word args ("cat food bag" → "cat food bag").
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  // First token after `/`. Stop at whitespace or end.
  const match = trimmed.slice(1).match(/^([a-z][a-z0-9-]*)(\s+(.*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const cmd = COMMAND_BY_NAME.get(name);
  if (!cmd) return null;
  const args = (match[3] ?? "").trim();
  return {
    cmd,
    args,
    expanded: cmd.promptTemplate(args),
  };
}

// Pre-filtered command list for the picker. Filters by name prefix on
// what the merchant has typed after `/`. Returns the full list when
// the input is just "/".
export function filterSlashCommands(input: string): SlashCommand[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return [];
  const prefix = trimmed.slice(1).split(/\s/)[0].toLowerCase();
  if (prefix.length === 0) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

// True when the popover should be open (input starts with `/` and
// nothing else has happened to make it not a command). Used by the UI
// to decide picker visibility — we don't show the picker once the
// merchant has typed something past the command name + a space (they
// know what command they're invoking).
export function shouldShowPicker(input: string): boolean {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return false;
  // Hide once they've typed a space — at that point they're typing args,
  // not picking a command.
  return !/\s/.test(trimmed.slice(1));
}
