import { PrismaClient } from "@prisma/client";

// Prints CTR aggregates over the last N days as JSON to stdout. Used by:
//   1) the autonomous fortnightly tuning loop (parses stdout, edits
//      baseScore values in app/lib/agent/suggestions.server.ts)
//   2) ad-hoc human inspection (`npm run stats:suggestions -- 30`)
//
// Requires DATABASE_URL in the environment. Run via `railway run` to load
// the production env, or set DATABASE_URL locally for dev.
//
// Usage: npx tsx scripts/suggestion-stats.ts [days=14]

const days = Number.parseInt(process.argv[2] ?? "14", 10);
if (!Number.isFinite(days) || days < 1 || days > 365) {
  console.error("days must be 1..365");
  process.exit(2);
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await prisma.suggestionEvent.findMany({
      where: { createdAt: { gte: since } },
      select: { templateId: true, eventType: true, slotPosition: true },
    });

    type Stat = {
      templateId: string;
      impressions: number;
      clicks: number;
      avgClickSlot: number | null; // weighted-mean position when clicked
    };
    const byId = new Map<string, Stat & { _slotSum: number }>();
    for (const r of rows) {
      const s =
        byId.get(r.templateId) ??
        ({
          templateId: r.templateId,
          impressions: 0,
          clicks: 0,
          avgClickSlot: null,
          _slotSum: 0,
        } satisfies Stat & { _slotSum: number });
      if (r.eventType === "impression") s.impressions += 1;
      else if (r.eventType === "click") {
        s.clicks += 1;
        s._slotSum += r.slotPosition;
      }
      byId.set(r.templateId, s);
    }

    const stats = Array.from(byId.values()).map((s) => ({
      templateId: s.templateId,
      impressions: s.impressions,
      clicks: s.clicks,
      ctr: s.impressions > 0 ? s.clicks / s.impressions : null,
      avgClickSlot: s.clicks > 0 ? s._slotSum / s.clicks : null,
    }));

    // Sort: highest CTR first (with at least 5 impressions to be meaningful);
    // zero-impression rows last. Tiebreak by total clicks.
    stats.sort((a, b) => {
      const aReady = (a.impressions ?? 0) >= 5;
      const bReady = (b.impressions ?? 0) >= 5;
      if (aReady !== bReady) return aReady ? -1 : 1;
      const ac = a.ctr ?? -1;
      const bc = b.ctr ?? -1;
      if (ac !== bc) return bc - ac;
      return (b.clicks ?? 0) - (a.clicks ?? 0);
    });

    const summary = {
      windowDays: days,
      generatedAt: new Date().toISOString(),
      totalImpressions: stats.reduce((acc, s) => acc + s.impressions, 0),
      totalClicks: stats.reduce((acc, s) => acc + s.clicks, 0),
      uniqueTemplatesShown: stats.filter((s) => s.impressions > 0).length,
      perTemplate: stats,
    };

    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
