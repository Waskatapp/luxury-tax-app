import { describe, expect, it } from "vitest";

import {
  buildSummary,
  computeAnomalies,
  parseLog,
  parsePool,
  reconstructInitialPool,
  renderMarkdown,
  type CurrentTemplate,
  type LogRun,
} from "../../../scripts/tuning-audit-report";

// Pure-function tests for the audit. No filesystem, no git, no Prisma.

const TODAY = new Date("2026-06-01T09:13:00Z");

describe("parseLog", () => {
  it("parses an empty log to an empty array", () => {
    expect(parseLog("")).toEqual([]);
    expect(parseLog("# Suggestion Tuning Log\n\nintro paragraph\n\n")).toEqual(
      [],
    );
  });

  it("parses a single insufficient-data run", () => {
    const md = `# Suggestion Tuning Log

## 2026-04-27
- Window: 14 days
- Total impressions: 0, total clicks: 0, overall CTR: 0.00%
- Outcome: no changes — insufficient data — 0 impressions (need >= 50)

`;
    const runs = parseLog(md);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      date: "2026-04-27",
      windowDays: 14,
      impressions: 0,
      clicks: 0,
      ctr: 0,
      outcome: "insufficient_data",
    });
    expect(runs[0].changes).toEqual([]);
  });

  it("parses a run with concrete baseScore changes", () => {
    const md = `## 2026-05-25
- Window: 14 days
- Total impressions: 87, total clicks: 14, overall CTR: 16.09%
- Changes:
  - \`whats_low_on_stock\`: 4 → 5 (87 impressions, 24.1% CTR — high CTR 24.1%)
  - \`set_brand_voice\`: 2 → 1 (45 impressions, 2.2% CTR — low CTR 2.2%)
`;
    const runs = parseLog(md);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("changed");
    expect(runs[0].impressions).toBe(87);
    expect(runs[0].clicks).toBe(14);
    expect(runs[0].ctr).toBeCloseTo(0.1609, 4);
    expect(runs[0].changes).toHaveLength(2);
    expect(runs[0].changes[0]).toMatchObject({
      templateId: "whats_low_on_stock",
      oldScore: 4,
      newScore: 5,
    });
    expect(runs[0].changes[1]).toMatchObject({
      templateId: "set_brand_voice",
      oldScore: 2,
      newScore: 1,
    });
  });

  it("returns runs newest-first regardless of file order", () => {
    const md = `## 2026-04-27
- Window: 14 days
- Total impressions: 0, total clicks: 0, overall CTR: 0.00%
- Outcome: no changes — insufficient data

## 2026-05-11
- Window: 14 days
- Total impressions: 30, total clicks: 2, overall CTR: 6.67%
- Outcome: no changes — insufficient data

## 2026-05-25
- Window: 14 days
- Total impressions: 60, total clicks: 5, overall CTR: 8.33%
- Outcome: no changes — no templates met tuning thresholds
`;
    const runs = parseLog(md);
    expect(runs.map((r) => r.date)).toEqual([
      "2026-05-25",
      "2026-05-11",
      "2026-04-27",
    ]);
  });
});

describe("parsePool", () => {
  it("extracts templateId, category, and baseScore from each entry", () => {
    const src = `
export const CANDIDATE_POOL = [
  {
    id: "whats_low_on_stock",
    label: "Stock?",
    prompt: "...",
    category: "analytics",
    baseScore: 4,
    boostWhen: ["low_stock"],
  },
  {
    id: "set_brand_voice",
    label: "Voice",
    prompt: "...",
    category: "memory",
    baseScore: 2,
  },
];
`;
    const pool = parsePool(src);
    expect(pool).toEqual([
      { templateId: "whats_low_on_stock", category: "analytics", baseScore: 4 },
      { templateId: "set_brand_voice", category: "memory", baseScore: 2 },
    ]);
  });
});

describe("computeAnomalies", () => {
  function run(
    date: string,
    overrides: Partial<LogRun> = {},
  ): LogRun {
    return {
      date,
      windowDays: 14,
      impressions: 100,
      clicks: 10,
      ctr: 0.1,
      outcome: "no_changes",
      outcomeNote: null,
      changes: [],
      ...overrides,
    };
  }

  function template(
    templateId: string,
    baseScore: number,
    category = "analytics",
  ): CurrentTemplate {
    return { templateId, category, baseScore };
  }

  const recentBot = "2026-05-30"; // 2 days before TODAY=2026-06-01

  it("returns no anomalies for a clean state", () => {
    const runs = [run("2026-05-25", { outcome: "no_changes" })];
    const current = [template("a", 4)];
    const out = computeAnomalies(runs, current, recentBot, TODAY);
    expect(out).toEqual([]);
  });

  it("flags stuck_at_floor when current=1 and last 2 changes ended at 1", () => {
    const runs = [
      run("2026-05-25", {
        outcome: "changed",
        changes: [
          { templateId: "a", oldScore: 2, newScore: 1, reason: "low CTR" },
        ],
      }),
      run("2026-05-11", {
        outcome: "changed",
        changes: [
          { templateId: "a", oldScore: 3, newScore: 1, reason: "zero CTR" },
        ],
      }),
    ];
    const current = [template("a", 1)];
    const out = computeAnomalies(runs, current, recentBot, TODAY);
    expect(out.find((x) => x.rule === "stuck_at_floor")).toMatchObject({
      templateId: "a",
    });
  });

  it("does NOT flag stuck_at_floor when current=1 but only one historical change", () => {
    const runs = [
      run("2026-05-25", {
        outcome: "changed",
        changes: [{ templateId: "a", oldScore: 2, newScore: 1, reason: "" }],
      }),
    ];
    const current = [template("a", 1)];
    const out = computeAnomalies(runs, current, recentBot, TODAY);
    expect(out.find((x) => x.rule === "stuck_at_floor")).toBeUndefined();
  });

  it("flags stuck_at_cap symmetric to stuck_at_floor", () => {
    const runs = [
      run("2026-05-25", {
        outcome: "changed",
        changes: [{ templateId: "b", oldScore: 5, newScore: 6, reason: "" }],
      }),
      run("2026-05-11", {
        outcome: "changed",
        changes: [{ templateId: "b", oldScore: 4, newScore: 6, reason: "" }],
      }),
    ];
    const current = [template("b", 6)];
    const out = computeAnomalies(runs, current, recentBot, TODAY);
    expect(out.find((x) => x.rule === "stuck_at_cap")).toMatchObject({
      templateId: "b",
    });
  });

  it("flags volatile when a template changed in 3 of the last 4 runs", () => {
    const runs = [
      run("2026-05-25", {
        outcome: "changed",
        changes: [{ templateId: "c", oldScore: 4, newScore: 5, reason: "" }],
      }),
      run("2026-05-11", {
        outcome: "changed",
        changes: [{ templateId: "c", oldScore: 3, newScore: 4, reason: "" }],
      }),
      run("2026-04-27", { outcome: "no_changes" }),
      run("2026-04-13", {
        outcome: "changed",
        changes: [{ templateId: "c", oldScore: 4, newScore: 3, reason: "" }],
      }),
    ];
    const current = [template("c", 5)];
    const out = computeAnomalies(runs, current, recentBot, TODAY);
    expect(out.find((x) => x.rule === "volatile")).toMatchObject({
      templateId: "c",
    });
  });

  it("flags data_drought when last 3 runs are insufficient_data", () => {
    const runs = [
      run("2026-05-25", { outcome: "insufficient_data" }),
      run("2026-05-11", { outcome: "insufficient_data" }),
      run("2026-04-27", { outcome: "insufficient_data" }),
    ];
    const current = [template("a", 4)];
    const out = computeAnomalies(runs, current, recentBot, TODAY);
    expect(out.find((x) => x.rule === "data_drought")).toMatchObject({
      templateId: null,
    });
  });

  it("does NOT flag data_drought when 1 of last 3 runs had data", () => {
    const runs = [
      run("2026-05-25", { outcome: "insufficient_data" }),
      run("2026-05-11", { outcome: "no_changes" }),
      run("2026-04-27", { outcome: "insufficient_data" }),
    ];
    const current = [template("a", 4)];
    const out = computeAnomalies(runs, current, recentBot, TODAY);
    expect(out.find((x) => x.rule === "data_drought")).toBeUndefined();
  });

  it("flags bot_silent when no bot commit recorded", () => {
    const out = computeAnomalies([], [template("a", 4)], null, TODAY);
    expect(out.find((x) => x.rule === "bot_silent")).toBeDefined();
  });

  it("flags bot_silent when last commit > 35 days old", () => {
    const stale = "2026-04-01"; // ~61 days before TODAY
    const out = computeAnomalies([], [template("a", 4)], stale, TODAY);
    expect(out.find((x) => x.rule === "bot_silent")).toBeDefined();
  });

  it("does NOT flag bot_silent when commit is recent", () => {
    const out = computeAnomalies([], [template("a", 4)], recentBot, TODAY);
    expect(out.find((x) => x.rule === "bot_silent")).toBeUndefined();
  });

  it("flags catastrophic_drop when cumulative delta is -3 or worse", () => {
    const runs = [
      run("2026-05-25", {
        outcome: "changed",
        changes: [{ templateId: "d", oldScore: 3, newScore: 1, reason: "" }],
      }),
      run("2026-05-11", {
        outcome: "changed",
        changes: [{ templateId: "d", oldScore: 4, newScore: 3, reason: "" }],
      }),
    ];
    // initial recorded = 4 (oldScore of FIRST chronological change), current = 1, delta = -3
    const current = [template("d", 1)];
    const out = computeAnomalies(runs, current, recentBot, TODAY);
    expect(out.find((x) => x.rule === "catastrophic_drop")).toMatchObject({
      templateId: "d",
    });
  });
});

describe("reconstructInitialPool", () => {
  it("uses oldScore of first chronological change for tuned templates", () => {
    const runs: LogRun[] = [
      {
        date: "2026-05-25",
        windowDays: 14,
        impressions: 100,
        clicks: 10,
        ctr: 0.1,
        outcome: "changed",
        outcomeNote: null,
        changes: [{ templateId: "a", oldScore: 3, newScore: 2, reason: "" }],
      },
      {
        date: "2026-05-11",
        windowDays: 14,
        impressions: 100,
        clicks: 10,
        ctr: 0.1,
        outcome: "changed",
        outcomeNote: null,
        changes: [{ templateId: "a", oldScore: 4, newScore: 3, reason: "" }],
      },
    ];
    const current: CurrentTemplate[] = [
      { templateId: "a", category: "x", baseScore: 2 },
      { templateId: "b", category: "x", baseScore: 5 },
    ];
    const initial = reconstructInitialPool(runs, current);
    expect(initial.get("a")).toBe(4); // older run's oldScore
    expect(initial.get("b")).toBe(5); // never tuned → current is initial
  });
});

describe("renderMarkdown", () => {
  it("includes summary, anomalies, recent runs, and snapshot sections", () => {
    const runs: LogRun[] = [
      {
        date: "2026-04-27",
        windowDays: 14,
        impressions: 0,
        clicks: 0,
        ctr: 0,
        outcome: "insufficient_data",
        outcomeNote: "no changes — insufficient data",
        changes: [],
      },
    ];
    const current: CurrentTemplate[] = [
      { templateId: "a", category: "analytics", baseScore: 4 },
      { templateId: "b", category: "memory", baseScore: 2 },
    ];
    const initial = reconstructInitialPool(runs, current);
    const summary = buildSummary(runs, current, "2026-04-27", "2026-05-01");
    const md = renderMarkdown(runs, current, initial, [], summary);

    expect(md).toContain("# Suggestion Tuning Audit Report");
    expect(md).toContain("Tuner runs logged: 1");
    expect(md).toContain("Last bot commit on main: 2026-04-27");
    expect(md).toContain("✅ no anomalies");
    expect(md).toContain("| 2026-04-27 | 14d | 0 | 0 | 0.00% |");
    expect(md).toContain("| `a` | analytics | 4 | 0 |");
    expect(md).toContain("| `b` | memory | 2 | 0 |");
  });

  it("renders anomaly bullets when present", () => {
    const summary = buildSummary([], [], null, "2026-05-01");
    const md = renderMarkdown(
      [],
      [],
      new Map(),
      [
        {
          rule: "bot_silent",
          templateId: null,
          detail: "No github-actions[bot] commit found on main",
        },
      ],
      summary,
    );
    expect(md).toContain("## Anomalies (1 detected)");
    expect(md).toContain("⚠️ `bot_silent`");
    expect(md).not.toContain("✅ no anomalies");
  });
});
