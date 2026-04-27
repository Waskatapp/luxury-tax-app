import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Deterministic audit report for the autonomous suggestion tuner.
// Read-only: parses docs/suggestion-tuning-log.md, app/lib/agent/
// suggestions.server.ts, and git log. Emits markdown to stdout (default)
// or JSON anomaly summary (--json).
//
// Run via .github/workflows/suggestion-tuning-report.yml on the 1st of
// each month, or locally via `npm run audit:tuning`.
//
// No DB access, no LLM calls. The whole point is to catch the autonomous
// tuner drifting; another non-deterministic layer would defeat the purpose.

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const LOG_FILE = path.join(REPO_ROOT, "docs", "suggestion-tuning-log.md");
const SUGGESTIONS_FILE = path.join(
  REPO_ROOT,
  "app",
  "lib",
  "agent",
  "suggestions.server.ts",
);

const RECENT_RUNS_IN_REPORT = 4;
const BOT_SILENT_DAYS_THRESHOLD = 35;
const BASESCORE_FLOOR = 1;
const BASESCORE_CAP = 6;
const VOLATILE_WINDOW = 4;
const VOLATILE_MIN_CHANGES = 3;
const DROUGHT_RUN_COUNT = 3;
const CATASTROPHIC_DROP_THRESHOLD = -3;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type LogChange = {
  templateId: string;
  oldScore: number;
  newScore: number;
  reason: string;
};

export type LogRun = {
  date: string; // YYYY-MM-DD
  windowDays: number | null;
  impressions: number;
  clicks: number;
  ctr: number; // 0..1
  outcome: "changed" | "no_changes" | "insufficient_data" | "aborted";
  outcomeNote: string | null;
  changes: LogChange[];
};

export type CurrentTemplate = {
  templateId: string;
  category: string;
  baseScore: number;
};

export type Anomaly = {
  rule:
    | "stuck_at_floor"
    | "stuck_at_cap"
    | "volatile"
    | "data_drought"
    | "bot_silent"
    | "catastrophic_drop";
  templateId: string | null;
  detail: string;
};

export type AuditSummary = {
  generatedAt: string;
  totalRuns: number;
  lastBotCommitDate: string | null;
  templatesAtFloor: number;
  templatesAtCap: number;
  cumulativeImpressions: number;
  cumulativeClicks: number;
  overallCtr: number; // 0..1
};

// ---------------------------------------------------------------------------
// Log parser — simple, line-based. Each run is a `## YYYY-MM-DD` section.
// ---------------------------------------------------------------------------

export function parseLog(markdown: string): LogRun[] {
  const lines = markdown.split(/\r?\n/);
  const runs: LogRun[] = [];
  let i = 0;

  while (i < lines.length) {
    const headerMatch = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(lines[i]);
    if (!headerMatch) {
      i += 1;
      continue;
    }
    const date = headerMatch[1];
    i += 1;

    let windowDays: number | null = null;
    let impressions = 0;
    let clicks = 0;
    let ctr = 0;
    let outcome: LogRun["outcome"] = "no_changes";
    let outcomeNote: string | null = null;
    const changes: LogChange[] = [];

    // Read until the next `## ` header or end of file.
    while (i < lines.length && !/^##\s+/.test(lines[i])) {
      const line = lines[i];

      const wm = /^- Window:\s*(\d+)\s*days?/.exec(line);
      if (wm) windowDays = Number.parseInt(wm[1], 10);

      const tm = /Total impressions:\s*(\d+),\s*total clicks:\s*(\d+),\s*overall CTR:\s*([\d.]+)%/.exec(
        line,
      );
      if (tm) {
        impressions = Number.parseInt(tm[1], 10);
        clicks = Number.parseInt(tm[2], 10);
        ctr = Number.parseFloat(tm[3]) / 100;
      }

      const om = /^- Outcome:\s*(.+)$/.exec(line);
      if (om) {
        const txt = om[1].trim();
        outcomeNote = txt;
        if (/insufficient data/i.test(txt)) outcome = "insufficient_data";
        else if (/no changes/i.test(txt)) outcome = "no_changes";
        else if (/abort/i.test(txt)) outcome = "aborted";
      }

      const cm = /^- Changes:\s*$/.exec(line);
      if (cm) outcome = "changed";

      // Bullet form: `  - templateId: 4 → 5 (...)`. Be lenient about indent.
      const chm =
        /^\s+-\s+`?([a-z0-9_]+)`?\s*:\s*(\d+)\s*(?:→|->|->)\s*(\d+)\s*(?:\(([^)]*)\))?/.exec(
          line,
        );
      if (chm) {
        changes.push({
          templateId: chm[1],
          oldScore: Number.parseInt(chm[2], 10),
          newScore: Number.parseInt(chm[3], 10),
          reason: (chm[4] ?? "").trim(),
        });
      }

      i += 1;
    }

    runs.push({
      date,
      windowDays,
      impressions,
      clicks,
      ctr,
      outcome,
      outcomeNote,
      changes,
    });
  }

  // Newest first.
  runs.sort((a, b) => (a.date < b.date ? 1 : -1));
  return runs;
}

// ---------------------------------------------------------------------------
// CANDIDATE_POOL parser — regex-based. Same shape as the tuner uses.
// ---------------------------------------------------------------------------

export function parsePool(source: string): CurrentTemplate[] {
  const out: CurrentTemplate[] = [];
  // Match each `{ id: "X", ... category: "Y", ... baseScore: N }` block.
  // The non-greedy [\s\S]*? scopes to the smallest match per pool entry.
  const re = /id:\s*"([a-z0-9_]+)"[\s\S]*?category:\s*"([a-z0-9_]+)"[\s\S]*?baseScore:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({
      templateId: m[1],
      category: m[2],
      baseScore: Number.parseInt(m[3], 10),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

export function computeAnomalies(
  runs: LogRun[], // newest first
  current: CurrentTemplate[],
  lastBotCommitDate: string | null,
  today: Date = new Date(),
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // Build per-template change history in chronological order (oldest first
  // for "last N changes"-style rules).
  const chronological = [...runs].reverse();
  const historyByTemplate = new Map<string, LogChange[]>();
  for (const run of chronological) {
    for (const ch of run.changes) {
      const arr = historyByTemplate.get(ch.templateId) ?? [];
      arr.push(ch);
      historyByTemplate.set(ch.templateId, arr);
    }
  }

  for (const t of current) {
    const history = historyByTemplate.get(t.templateId) ?? [];
    const last2 = history.slice(-2);

    if (
      t.baseScore === BASESCORE_FLOOR &&
      last2.length >= 2 &&
      last2.every((c) => c.newScore === BASESCORE_FLOOR)
    ) {
      anomalies.push({
        rule: "stuck_at_floor",
        templateId: t.templateId,
        detail: `${t.templateId} has been at baseScore=${BASESCORE_FLOOR} in the last ${last2.length} runs that touched it`,
      });
    }

    if (
      t.baseScore === BASESCORE_CAP &&
      last2.length >= 2 &&
      last2.every((c) => c.newScore === BASESCORE_CAP)
    ) {
      anomalies.push({
        rule: "stuck_at_cap",
        templateId: t.templateId,
        detail: `${t.templateId} has been at baseScore=${BASESCORE_CAP} in the last ${last2.length} runs that touched it`,
      });
    }

    // Volatile: this template changed in 3 of the last 4 runs (in the
    // overall log). We check the 4 most recent runs in `runs` (newest first)
    // and count how many had a change for this template.
    const recentRuns = runs.slice(0, VOLATILE_WINDOW);
    const changedCount = recentRuns.filter((r) =>
      r.changes.some((c) => c.templateId === t.templateId),
    ).length;
    if (changedCount >= VOLATILE_MIN_CHANGES) {
      anomalies.push({
        rule: "volatile",
        templateId: t.templateId,
        detail: `${t.templateId} baseScore changed in ${changedCount} of the last ${recentRuns.length} runs`,
      });
    }

    // Catastrophic drop: cumulative drop of 3+ points relative to first
    // observed `oldScore` for this template across all logged runs. If the
    // template never appears in the log we have no baseline → skip.
    if (history.length > 0) {
      const initial = history[0].oldScore;
      const delta = t.baseScore - initial;
      if (delta <= CATASTROPHIC_DROP_THRESHOLD) {
        anomalies.push({
          rule: "catastrophic_drop",
          templateId: t.templateId,
          detail: `${t.templateId} dropped ${delta} cumulatively (from ${initial} to ${t.baseScore})`,
        });
      }
    }
  }

  // Data drought: most recent N runs ALL had outcome == "insufficient_data".
  if (runs.length >= DROUGHT_RUN_COUNT) {
    const recent = runs.slice(0, DROUGHT_RUN_COUNT);
    if (recent.every((r) => r.outcome === "insufficient_data")) {
      anomalies.push({
        rule: "data_drought",
        templateId: null,
        detail: `Last ${DROUGHT_RUN_COUNT} runs all reported insufficient data — traffic may be too low or impression tracking may be broken`,
      });
    }
  }

  // Bot silent: no bot commit in the last N days. If we have no bot commit
  // record at all, that's a separate sub-condition (treat as silent).
  if (lastBotCommitDate === null) {
    anomalies.push({
      rule: "bot_silent",
      templateId: null,
      detail: `No github-actions[bot] commit found on main`,
    });
  } else {
    const last = new Date(lastBotCommitDate);
    if (!Number.isNaN(last.getTime())) {
      const daysSince = (today.getTime() - last.getTime()) / (24 * 60 * 60 * 1000);
      if (daysSince > BOT_SILENT_DAYS_THRESHOLD) {
        anomalies.push({
          rule: "bot_silent",
          templateId: null,
          detail: `Last bot commit was ${Math.floor(daysSince)} days ago (${lastBotCommitDate}) — workflow may be failing`,
        });
      }
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export function renderMarkdown(
  runs: LogRun[],
  current: CurrentTemplate[],
  initialPool: Map<string, number>,
  anomalies: Anomaly[],
  summary: AuditSummary,
): string {
  const lines: string[] = [];
  lines.push("# Suggestion Tuning Audit Report");
  lines.push("");
  lines.push(
    `_Auto-generated by \`.github/workflows/suggestion-tuning-report.yml\` on ${summary.generatedAt}._`,
  );
  lines.push("");

  lines.push("## Summary");
  lines.push(`- Tuner runs logged: ${summary.totalRuns}`);
  lines.push(
    `- Last bot commit on main: ${summary.lastBotCommitDate ?? "(none yet)"}`,
  );
  lines.push(`- Templates at floor (${BASESCORE_FLOOR}): ${summary.templatesAtFloor}`);
  lines.push(`- Templates at cap (${BASESCORE_CAP}): ${summary.templatesAtCap}`);
  lines.push(`- Cumulative impressions across logged runs: ${summary.cumulativeImpressions}`);
  lines.push(`- Cumulative clicks: ${summary.cumulativeClicks}`);
  lines.push(`- Overall CTR: ${(summary.overallCtr * 100).toFixed(2)}%`);
  lines.push("");

  lines.push(`## Anomalies (${anomalies.length} detected)`);
  if (anomalies.length === 0) {
    lines.push("- ✅ no anomalies");
  } else {
    for (const a of anomalies) {
      lines.push(`- ⚠️ \`${a.rule}\`: ${a.detail}`);
    }
  }
  lines.push("");

  lines.push(`## Recent runs (last ${RECENT_RUNS_IN_REPORT})`);
  lines.push("| Date | Window | Impressions | Clicks | CTR | Outcome |");
  lines.push("|---|---|---|---|---|---|");
  const recent = runs.slice(0, RECENT_RUNS_IN_REPORT);
  if (recent.length === 0) {
    lines.push("| _(no runs yet)_ | | | | | |");
  } else {
    for (const r of recent) {
      const outcomeText =
        r.outcome === "changed"
          ? `${r.changes.length} changes`
          : r.outcomeNote ?? r.outcome;
      lines.push(
        `| ${r.date} | ${r.windowDays ?? "?"}d | ${r.impressions} | ${r.clicks} | ${(r.ctr * 100).toFixed(2)}% | ${outcomeText} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Current baseScore snapshot");
  lines.push("| Template | Category | baseScore | Δ from initial |");
  lines.push("|---|---|---|---|");
  const sorted = [...current].sort((a, b) =>
    a.templateId < b.templateId ? -1 : 1,
  );
  for (const t of sorted) {
    const initial = initialPool.get(t.templateId);
    const delta =
      typeof initial === "number" ? t.baseScore - initial : null;
    const deltaText =
      delta === null
        ? "(no record)"
        : delta > 0
          ? `+${delta}`
          : String(delta);
    lines.push(
      `| \`${t.templateId}\` | ${t.category} | ${t.baseScore} | ${deltaText} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Initial pool reconstruction
// ---------------------------------------------------------------------------

// To compute "Δ from initial", we need each template's pool value as it
// was BEFORE any tuning happened. We derive this by walking the log
// chronologically: a template's "initial" is the `oldScore` of its first
// recorded change. If a template has never been touched, its current
// baseScore IS its initial (delta 0).
export function reconstructInitialPool(
  runs: LogRun[],
  current: CurrentTemplate[],
): Map<string, number> {
  const initial = new Map<string, number>();
  const chronological = [...runs].reverse();
  for (const r of chronological) {
    for (const ch of r.changes) {
      if (!initial.has(ch.templateId)) {
        initial.set(ch.templateId, ch.oldScore);
      }
    }
  }
  for (const t of current) {
    if (!initial.has(t.templateId)) {
      initial.set(t.templateId, t.baseScore);
    }
  }
  return initial;
}

// ---------------------------------------------------------------------------
// Bot commit lookup
// ---------------------------------------------------------------------------

function getLastBotCommitDate(): string | null {
  try {
    const out = execSync(
      `git log --author="github-actions\\[bot\\]" -n 1 --format=%cs origin/main`,
      { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!out) return null;
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function buildSummary(
  runs: LogRun[],
  current: CurrentTemplate[],
  lastBotCommitDate: string | null,
  generatedAt: string,
): AuditSummary {
  const cumulativeImpressions = runs.reduce((acc, r) => acc + r.impressions, 0);
  const cumulativeClicks = runs.reduce((acc, r) => acc + r.clicks, 0);
  return {
    generatedAt,
    totalRuns: runs.length,
    lastBotCommitDate,
    templatesAtFloor: current.filter((t) => t.baseScore === BASESCORE_FLOOR).length,
    templatesAtCap: current.filter((t) => t.baseScore === BASESCORE_CAP).length,
    cumulativeImpressions,
    cumulativeClicks,
    overallCtr:
      cumulativeImpressions > 0 ? cumulativeClicks / cumulativeImpressions : 0,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const wantJson = process.argv.includes("--json");

  const logSrc = fs.existsSync(LOG_FILE)
    ? fs.readFileSync(LOG_FILE, "utf-8")
    : "";
  const poolSrc = fs.readFileSync(SUGGESTIONS_FILE, "utf-8");

  const runs = parseLog(logSrc);
  const current = parsePool(poolSrc);
  const lastBot = getLastBotCommitDate();
  const today = new Date();
  const generatedAt = today.toISOString().slice(0, 10);

  const anomalies = computeAnomalies(runs, current, lastBot, today);
  const summary = buildSummary(runs, current, lastBot, generatedAt);

  if (wantJson) {
    process.stdout.write(
      JSON.stringify({ anomalies, summary }, null, 2) + "\n",
    );
    return;
  }

  const initial = reconstructInitialPool(runs, current);
  const md = renderMarkdown(runs, current, initial, anomalies, summary);
  process.stdout.write(md);
}

// Only run when invoked directly. The test file imports the helpers and
// must NOT trigger main()'s side effects (file reads + git exec).
const invokedDirectly =
  import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("tuning-audit-report.ts");
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error("[audit] hard failure:", err);
    process.exit(1);
  }
}
