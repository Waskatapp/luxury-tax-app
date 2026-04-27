import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Autonomous fortnightly tuner. Runs from a GitHub Actions cron with
// DATABASE_URL injected as a secret. Reads the last 14 days of click
// data, applies a small set of conservative rules, edits baseScore
// values in app/lib/agent/suggestions.server.ts, and appends a row to
// docs/suggestion-tuning-log.md.
//
// The workflow then commits + pushes both files (or commits a "no
// changes" log entry if signal was insufficient) — see
// .github/workflows/suggestion-tuning.yml.
//
// Rules (conservative — never tune more than 5 templates per run):
//   - HIGH CTR (>= 20%, impressions >= 20)         → baseScore += 1, cap 6
//   - LOW CTR  (<= 5%, impressions >= 20)          → baseScore -= 1, floor 1
//   - ZERO CTR (= 0%, impressions >= 30)           → baseScore -= 2, floor 1
//
// The script writes the log + edits in-place. It does NOT git-commit;
// the GitHub workflow handles git. Exit code 0 always (a run with no
// changes is success). Exit code non-zero only on hard failure (DB
// unreachable, file not found, parse error in suggestions.server.ts).

const WINDOW_DAYS = 14;
const MAX_CHANGES_PER_RUN = 5;
const HIGH_CTR_THRESHOLD = 0.2;
const LOW_CTR_THRESHOLD = 0.05;
const MIN_IMPRESSIONS_FOR_TUNING = 20;
const MIN_IMPRESSIONS_FOR_ZERO_CTR_DROP = 30;
const MIN_TOTAL_IMPRESSIONS = 50;
const BASESCORE_CAP = 6;
const BASESCORE_FLOOR = 1;

// ESM has no __dirname; resolve it from import.meta.url (the project is
// "type": "module" so tsx loads this script as ESM).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SUGGESTIONS_FILE = path.join(
  REPO_ROOT,
  "app",
  "lib",
  "agent",
  "suggestions.server.ts",
);
const LOG_FILE = path.join(REPO_ROOT, "docs", "suggestion-tuning-log.md");

type TemplateStat = {
  templateId: string;
  impressions: number;
  clicks: number;
  ctr: number; // 0..1
};

type Change = {
  templateId: string;
  oldScore: number;
  newScore: number;
  reason: string;
  impressions: number;
  ctr: number;
};

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let logEntry: string;

  try {
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await prisma.suggestionEvent.findMany({
      where: { createdAt: { gte: since } },
      select: { templateId: true, eventType: true },
    });

    const stats = aggregate(rows);
    const totalImpressions = stats.reduce((acc, s) => acc + s.impressions, 0);
    const totalClicks = stats.reduce((acc, s) => acc + s.clicks, 0);
    const overallCtr =
      totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

    if (totalImpressions < MIN_TOTAL_IMPRESSIONS) {
      logEntry = renderLogEntry({
        totalImpressions,
        totalClicks,
        overallCtr,
        changes: [],
        skipReason: `insufficient data — ${totalImpressions} impressions (need >= ${MIN_TOTAL_IMPRESSIONS})`,
      });
      appendLog(logEntry);
      console.log(
        `[auto-tune] insufficient data: ${totalImpressions} impressions`,
      );
      return;
    }

    const proposed = pickTuningCandidates(stats);
    if (proposed.length === 0) {
      logEntry = renderLogEntry({
        totalImpressions,
        totalClicks,
        overallCtr,
        changes: [],
        skipReason: "no templates met tuning thresholds",
      });
      appendLog(logEntry);
      console.log("[auto-tune] no eligible templates");
      return;
    }

    const source = fs.readFileSync(SUGGESTIONS_FILE, "utf-8");
    const { updatedSource, applied } = applyChanges(source, proposed);

    if (applied.length === 0) {
      logEntry = renderLogEntry({
        totalImpressions,
        totalClicks,
        overallCtr,
        changes: [],
        skipReason:
          "all proposed changes were no-ops (current baseScore already matches target)",
      });
      appendLog(logEntry);
      console.log("[auto-tune] no real changes after dedup");
      return;
    }

    fs.writeFileSync(SUGGESTIONS_FILE, updatedSource, "utf-8");
    logEntry = renderLogEntry({
      totalImpressions,
      totalClicks,
      overallCtr,
      changes: applied,
      skipReason: null,
    });
    appendLog(logEntry);
    console.log(
      `[auto-tune] applied ${applied.length} baseScore changes`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

function aggregate(
  rows: { templateId: string; eventType: string }[],
): TemplateStat[] {
  const byId = new Map<string, { impressions: number; clicks: number }>();
  for (const r of rows) {
    const e = byId.get(r.templateId) ?? { impressions: 0, clicks: 0 };
    if (r.eventType === "impression") e.impressions += 1;
    else if (r.eventType === "click") e.clicks += 1;
    byId.set(r.templateId, e);
  }
  return Array.from(byId.entries()).map(([templateId, e]) => ({
    templateId,
    impressions: e.impressions,
    clicks: e.clicks,
    ctr: e.impressions > 0 ? e.clicks / e.impressions : 0,
  }));
}

type ProposedChange = {
  templateId: string;
  delta: number; // +1 / -1 / -2
  reason: string;
  impressions: number;
  ctr: number;
};

function pickTuningCandidates(stats: TemplateStat[]): ProposedChange[] {
  const proposals: ProposedChange[] = [];

  for (const s of stats) {
    if (s.impressions < MIN_IMPRESSIONS_FOR_TUNING) continue;

    if (s.clicks === 0 && s.impressions >= MIN_IMPRESSIONS_FOR_ZERO_CTR_DROP) {
      proposals.push({
        templateId: s.templateId,
        delta: -2,
        reason: `zero clicks across ${s.impressions} impressions`,
        impressions: s.impressions,
        ctr: 0,
      });
    } else if (s.ctr >= HIGH_CTR_THRESHOLD) {
      proposals.push({
        templateId: s.templateId,
        delta: +1,
        reason: `high CTR ${(s.ctr * 100).toFixed(1)}%`,
        impressions: s.impressions,
        ctr: s.ctr,
      });
    } else if (s.ctr <= LOW_CTR_THRESHOLD && s.clicks > 0) {
      proposals.push({
        templateId: s.templateId,
        delta: -1,
        reason: `low CTR ${(s.ctr * 100).toFixed(1)}%`,
        impressions: s.impressions,
        ctr: s.ctr,
      });
    }
  }

  // Cap to MAX_CHANGES_PER_RUN, prefer those with the most impressions
  // (most statistical confidence).
  proposals.sort((a, b) => b.impressions - a.impressions);
  return proposals.slice(0, MAX_CHANGES_PER_RUN);
}

// Edits the source by finding each Candidate object literal that matches
// templateId, locating its baseScore line, and rewriting the value.
// Skip-no-op: if the current baseScore equals the proposed new score,
// don't edit and don't count it as applied.
function applyChanges(
  source: string,
  proposals: ProposedChange[],
): { updatedSource: string; applied: Change[] } {
  let working = source;
  const applied: Change[] = [];

  for (const p of proposals) {
    const escapedId = p.templateId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match an object whose `id: "<templateId>"` is followed (within this
    // block) by `baseScore: <n>`. Greedy across lines but scoped to the
    // smallest match thanks to non-greedy [\s\S]*?.
    const re = new RegExp(
      `(\\{\\s*[\\s\\S]*?id:\\s*"${escapedId}"[\\s\\S]*?baseScore:\\s*)(\\d+)`,
      "m",
    );
    const m = re.exec(working);
    if (!m) continue;

    const oldScore = Number.parseInt(m[2], 10);
    if (!Number.isFinite(oldScore)) continue;

    const target = clamp(oldScore + p.delta, BASESCORE_FLOOR, BASESCORE_CAP);
    if (target === oldScore) continue;

    working =
      working.slice(0, m.index) +
      m[1] +
      String(target) +
      working.slice(m.index + m[0].length);

    applied.push({
      templateId: p.templateId,
      oldScore,
      newScore: target,
      reason: p.reason,
      impressions: p.impressions,
      ctr: p.ctr,
    });
  }

  return { updatedSource: working, applied };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function renderLogEntry(args: {
  totalImpressions: number;
  totalClicks: number;
  overallCtr: number;
  changes: Change[];
  skipReason: string | null;
}): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`## ${today}`);
  lines.push(`- Window: ${WINDOW_DAYS} days`);
  lines.push(
    `- Total impressions: ${args.totalImpressions}, total clicks: ${args.totalClicks}, overall CTR: ${args.overallCtr.toFixed(2)}%`,
  );
  if (args.skipReason) {
    lines.push(`- Outcome: no changes — ${args.skipReason}`);
  } else {
    lines.push(`- Changes:`);
    for (const c of args.changes) {
      lines.push(
        `  - \`${c.templateId}\`: ${c.oldScore} → ${c.newScore} (${c.impressions} impressions, ${(c.ctr * 100).toFixed(1)}% CTR — ${c.reason})`,
      );
    }
  }
  return lines.join("\n") + "\n\n";
}

function appendLog(entry: string): void {
  const logDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(
      LOG_FILE,
      "# Suggestion Tuning Log\n\nAuto-generated by `scripts/auto-tune-suggestions.ts` via GitHub Actions every 14 days. Edits to `app/lib/agent/suggestions.server.ts` baseScore values are applied automatically when CTR signal is clear.\n\n",
      "utf-8",
    );
  }
  fs.appendFileSync(LOG_FILE, entry, "utf-8");
}

main().catch((err) => {
  console.error("[auto-tune] hard failure:", err);
  process.exit(1);
});
