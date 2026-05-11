// Phase Ab Round Ab-E — pure helpers for the abandonment lifecycle UI.
//
// Lives outside the route layer so the helpers can be unit-tested without
// pulling in the @shopify/shopify-app-react-router chain (which needs env
// vars to load). The routes import these helpers and provide their own
// Polaris rendering on top.

// Stable: file-finding.server.ts always writes `workflow_proposal:<id>` as
// the SystemHealthFinding.component for VERIFIED_FIXED + GIVING_UP transitions.
export const ABANDONMENT_COMPONENT_PREFIX = "workflow_proposal:";

// Subset of WorkflowProposal fields the lifecycle UI needs. Matches the
// shape the loader serializes — same one ProposalRowView consumes.
export type ProposalRowLike = {
  id: string;
  name: string;
  status: string;
  fingerprint: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  shippedAt: string | null;
  baselineClusterSize: number | null;
  verifiedAt: string | null;
  verificationAttempts: number;
  currentClusterSize: number | null;
};

// Pure shape-extractor for the abandonment-finding evidence JSON.
// Returns null when the row isn't an abandonment finding; returns a
// normalized object otherwise. Distinguishes `null` (explicit) from
// `undefined` (field absent) for baselineClusterSize so callers can show
// "no baseline" vs hiding the row entirely.
export function parseAbandonmentEvidence(row: {
  component: string;
  scanName: string;
  evidence: Record<string, unknown>;
}): {
  proposalId: string;
  proposalName: string;
  fingerprint: string;
  fingerprintShort: string | null;
  baselineClusterSize: number | null | undefined;
  currentClusterSize: number | null;
  reductionPct: number | null;
  verificationAttempts: number | null;
  verifiedAt: string | null;
  kind: "verified" | "giving_up" | "other";
} | null {
  if (!row.component.startsWith(ABANDONMENT_COMPONENT_PREFIX)) return null;
  const proposalId = row.component.slice(ABANDONMENT_COMPONENT_PREFIX.length);
  const ev = row.evidence ?? {};
  const fingerprint = typeof ev.fingerprint === "string" ? ev.fingerprint : "";
  const baselineRaw = ev.baselineClusterSize;
  const baseline =
    typeof baselineRaw === "number"
      ? baselineRaw
      : baselineRaw === null
        ? null
        : undefined;
  const kind: "verified" | "giving_up" | "other" =
    row.scanName === "abandonmentVerifiedFixScan"
      ? "verified"
      : row.scanName === "abandonmentGivingUpScan"
        ? "giving_up"
        : "other";
  return {
    proposalId,
    proposalName:
      typeof ev.proposalName === "string" ? ev.proposalName : "(unnamed)",
    fingerprint,
    fingerprintShort: fingerprint ? fingerprint.slice(0, 8) : null,
    baselineClusterSize: baseline,
    currentClusterSize:
      typeof ev.currentClusterSize === "number" ? ev.currentClusterSize : null,
    reductionPct:
      typeof ev.reductionPct === "number" ? ev.reductionPct : null,
    verificationAttempts:
      typeof ev.verificationAttempts === "number"
        ? ev.verificationAttempts
        : null,
    verifiedAt: typeof ev.verifiedAt === "string" ? ev.verifiedAt : null,
    kind,
  };
}

// Pure verification math, lifted from the workflow-proposals route so
// buildTimelineEvents below can re-use it from outside the route layer.
// Returns null when the math isn't applicable (PENDING / REJECTED /
// baseline ≤ 0). Returns a human-readable string otherwise.
export function verificationSummary(p: ProposalRowLike): string | null {
  if (p.baselineClusterSize === null) {
    if (
      p.status === "FIX_SHIPPED" ||
      p.status === "VERIFIED_FIXED" ||
      p.status === "FIX_DIDNT_HELP" ||
      p.status === "FIX_DIDNT_HELP_GIVING_UP"
    ) {
      return "no baseline captured at ship time";
    }
    return null;
  }
  const current = p.currentClusterSize ?? 0;
  const baseline = p.baselineClusterSize;
  if (baseline <= 0) return null;
  const pct = Math.round((1 - current / baseline) * 100);
  return `${baseline} → ${current} (${pct >= 0 ? `${pct}% reduction` : `${-pct}% increase`})`;
}

export type TimelineEvent = {
  when: string; // ISO
  what: string;
  tone?: "subdued" | "success" | "caution" | "critical";
};

// Compact closed-loop timeline: proposed → reviewed → shipped → verified
// (or didn't help / locked). Re-authored siblings (proposals sharing
// fingerprint) get appended so the operator sees the full chain on a
// FIX_DIDNT_HELP or FIX_DIDNT_HELP_GIVING_UP proposal without bouncing
// screens. Pure — caller pre-computes siblings from the loader.
export function buildTimelineEvents(
  proposal: ProposalRowLike,
  siblings: ProposalRowLike[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const fpShort = proposal.fingerprint
    ? `${proposal.fingerprint.slice(0, 8)}…`
    : "(no fingerprint)";

  events.push({
    when: proposal.createdAt,
    what: `Proposed by Wf-E from cluster \`${fpShort}\``,
    tone: "subdued",
  });

  if (proposal.reviewedAt) {
    const verb = proposal.status === "REJECTED" ? "Rejected" : "Reviewed";
    events.push({
      when: proposal.reviewedAt,
      what:
        proposal.status === "REJECTED"
          ? `${verb}: fingerprint blocked${proposal.reviewedBy ? ` by ${proposal.reviewedBy}` : ""}`
          : `${verb}: approved${proposal.reviewedBy ? ` by ${proposal.reviewedBy}` : ""}`,
      tone: proposal.status === "REJECTED" ? "critical" : "subdued",
    });
  }

  if (proposal.shippedAt) {
    events.push({
      when: proposal.shippedAt,
      what: `Shipped — baseline ${proposal.baselineClusterSize ?? "(none captured)"} turns`,
      tone: "subdued",
    });
  }

  if (proposal.verifiedAt) {
    if (proposal.status === "VERIFIED_FIXED") {
      const summary = verificationSummary(proposal);
      events.push({
        when: proposal.verifiedAt,
        what: `Verified — ${summary ?? "≥50% reduction"}`,
        tone: "success",
      });
    } else if (proposal.status === "FIX_DIDNT_HELP") {
      events.push({
        when: proposal.verifiedAt,
        what: `Didn't help — attempt ${proposal.verificationAttempts}/3, re-author scheduled`,
        tone: "caution",
      });
    } else if (proposal.status === "FIX_DIDNT_HELP_GIVING_UP") {
      events.push({
        when: proposal.verifiedAt,
        what: `Locked — gave up after ${proposal.verificationAttempts} failed attempt${
          proposal.verificationAttempts === 1 ? "" : "s"
        }`,
        tone: "critical",
      });
    }
  }

  // Append sibling outcomes (re-authored proposals sharing fingerprint).
  // Sorted chronologically so the chain reads in order.
  const sortedSiblings = [...siblings].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  for (const s of sortedSiblings) {
    let label: string;
    let tone: TimelineEvent["tone"] = "subdued";
    if (s.status === "VERIFIED_FIXED") {
      label = `Sibling proposal \`${s.name}\` — verified working`;
      tone = "success";
    } else if (s.status === "FIX_DIDNT_HELP_GIVING_UP") {
      label = `Sibling proposal \`${s.name}\` — locked (gave up)`;
      tone = "critical";
    } else if (s.status === "FIX_DIDNT_HELP") {
      label = `Sibling proposal \`${s.name}\` — didn't help (attempt ${s.verificationAttempts}/3)`;
      tone = "caution";
    } else if (s.status === "FIX_SHIPPED") {
      label = `Sibling proposal \`${s.name}\` — shipped, awaiting verification`;
    } else if (s.status === "PENDING") {
      label = `Sibling proposal \`${s.name}\` — pending review`;
    } else if (s.status === "REJECTED") {
      label = `Sibling proposal \`${s.name}\` — rejected`;
      tone = "critical";
    } else {
      label = `Sibling proposal \`${s.name}\` (${s.status})`;
    }
    events.push({ when: s.createdAt, what: label, tone });
  }

  // Final pass: chronological order.
  events.sort((a, b) => a.when.localeCompare(b.when));
  return events;
}
