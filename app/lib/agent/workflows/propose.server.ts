// Phase Wf Round Wf-E — Skill Creator. The nightly Abandonment Brain
// pass calls this for each large abandonment cluster (size >= 5,
// dominantOutcome IN ('abandoned','errored_unrecovered')) to author a
// new workflow SOP that would have prevented the failure pattern.
// Operator reviews via /app/settings/workflow-proposals.
//
// Constitutional shape:
// - Cost-bounded: 5 LLM calls per store per nightly run (constant below)
// - Spam guard: skip if a non-rejected proposal exists for the same
//   cluster fingerprint within 7 days
// - Fail-soft: try/catch per cluster; null returns logged + skipped
// - Per-store scoping: every query filters by storeId
// - Operator-only: PROPOSED workflows are NEVER injected into the CEO
//   prompt before status flips to ACCEPTED

import { GoogleGenAI } from "@google/genai";

import prisma from "../../../db.server";
import { GEMINI_MEMORY_MODEL, getGeminiClient } from "../gemini.server";
import { log } from "../../log.server";

// Cost cap per store per nightly run. Hardcoded here per the constitution
// (rule 5 of Phase Wf): "cost cap enforced as a code constant, not env var".
export const MAX_PROPOSALS_PER_STORE_PER_RUN = 5;

// Spam-guard window. Skip a fingerprint if a non-rejected proposal
// exists within this window. REJECTED fingerprints are permanently
// blocked (independent check).
export const PROPOSAL_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// LLM output cap. Keeps the prompt + response cheap; matches the
// _FORMAT.md cap of 250 lines per workflow body.
const MAX_OUTPUT_TOKENS = 1500;

// Cluster shape this helper consumes. Mirrors the Prisma row but kept
// as a pure type so tests can construct fixtures without touching the DB.
export type ProposalSeedCluster = {
  id: string;
  storeId: string;
  size: number;
  sampleTurnIds: string[];
  commonTools: string[];
  commonRouterReason: string | null;
  dominantOutcome: string;
  fingerprint: string;
};

export type ProposalSampleTurn = {
  userMessage: string;
  assistantSummary: string;
  outcome: string;
};

// What the LLM returns. Validated post-parse — bad shapes fail soft.
type RawLlmProposal = {
  name?: unknown;
  summary?: unknown;
  triggers?: unknown;
  body?: unknown;
};

export type ProposalDraft = {
  name: string;
  summary: string;
  triggers: string[];
  body: string;
};

// Phase Ab Round Ab-C-prime — statuses that permanently block re-proposal
// for a fingerprint. REJECTED = operator said no; FIX_DIDNT_HELP_GIVING_UP
// = 3 attempts failed verification; FIX_SHIPPED + VERIFIED_FIXED = the
// fix is working or awaiting verification, don't pile on duplicates.
const FINGERPRINT_PERMANENT_BLOCK_STATUSES = [
  "REJECTED",
  "FIX_SHIPPED",
  "VERIFIED_FIXED",
  "FIX_DIDNT_HELP_GIVING_UP",
] as const;

// Decide whether to skip a cluster on spam-guard / fingerprint-block grounds.
// Pure-ish (single DB query); separated for unit-testable boundaries.
//
// Ab-C-prime — extended block matrix:
//   REJECTED                        → permanent block (operator rejected)
//   FIX_SHIPPED                     → permanent block (waiting on verify)
//   VERIFIED_FIXED                  → permanent block (workflow is working)
//   FIX_DIDNT_HELP_GIVING_UP        → permanent block (3 attempts failed)
//   FIX_DIDNT_HELP (any age)        → NOT a block (re-author is the point)
//   PENDING / ACCEPTED / REVISED within 7d → block (don't pile on)
//   PENDING / ACCEPTED / REVISED older than 7d → not blocked
export async function shouldSkipFingerprint(opts: {
  storeId: string;
  fingerprint: string;
  now: Date;
}): Promise<{ skip: true; reason: string } | { skip: false }> {
  // Permanently-blocked statuses (operator decision OR exhausted retries).
  const permanent = await prisma.workflowProposal.findFirst({
    where: {
      storeId: opts.storeId,
      fingerprint: opts.fingerprint,
      status: { in: [...FINGERPRINT_PERMANENT_BLOCK_STATUSES] },
    },
    select: { id: true, status: true },
  });
  if (permanent) {
    return {
      skip: true,
      reason: `fingerprint permanently blocked (status=${permanent.status})`,
    };
  }
  // FIX_DIDNT_HELP at any age → eligible for re-author; don't block here.
  // PENDING / ACCEPTED / REVISED within 7d → block.
  const cutoff = new Date(opts.now.getTime() - PROPOSAL_DEDUPE_WINDOW_MS);
  const recent = await prisma.workflowProposal.findFirst({
    where: {
      storeId: opts.storeId,
      fingerprint: opts.fingerprint,
      createdAt: { gt: cutoff },
      status: { in: ["PENDING", "ACCEPTED", "REVISED"] },
    },
    select: { id: true },
  });
  if (recent) {
    return { skip: true, reason: "non-rejected proposal exists in last 7d" };
  }
  return { skip: false };
}

// Phase Ab Round Ab-C-prime — prior attempts that didn't verify.
// runWorkflowProposalPass loads these for a fingerprint that has a
// FIX_DIDNT_HELP row and threads them into buildProposalPrompt so the
// model authors a DIFFERENT shape, not the same one again.
export type PriorFailedAttempt = {
  name: string;
  summary: string;
  body: string;
  verificationAttempt: number; // 1, 2, ...
};

// Load prior FIX_DIDNT_HELP proposals for a fingerprint so the next
// re-author run sees them. Ordered by verificationAttempts ascending so
// the prompt shows attempt #1, #2, ... in chronological order. Returns
// [] when there are no prior failed attempts (the common case — most
// proposals never enter the re-author loop).
export async function loadPriorFailedAttempts(opts: {
  storeId: string;
  fingerprint: string;
}): Promise<PriorFailedAttempt[]> {
  const rows = await prisma.workflowProposal.findMany({
    where: {
      storeId: opts.storeId,
      fingerprint: opts.fingerprint,
      status: "FIX_DIDNT_HELP",
    },
    orderBy: { verificationAttempts: "asc" },
    select: {
      name: true,
      summary: true,
      body: true,
      verificationAttempts: true,
    },
  });
  return rows.map((r) => ({
    name: r.name,
    summary: r.summary,
    body: r.body,
    verificationAttempt: r.verificationAttempts,
  }));
}

// Build the prompt for one cluster. Pure — testable without LLM.
// Phase Ab Round Ab-C-prime — when priorFailedAttempts is non-empty,
// inject a section instructing the model to differ from those approaches.
// This is the ADAPT signal: the prior workflow shipped, didn't move the
// cluster size enough in 7 days; the next attempt has to try something
// substantively different.
export function buildProposalPrompt(opts: {
  cluster: ProposalSeedCluster;
  sampleTurns: ProposalSampleTurn[];
  priorFailedAttempts?: PriorFailedAttempt[];
}): string {
  const samples = opts.sampleTurns
    .slice(0, 5)
    .map(
      (t, i) =>
        `Sample ${i + 1}:\n  Merchant: ${t.userMessage}\n  Assistant: ${t.assistantSummary}\n  Outcome: ${t.outcome}`,
    )
    .join("\n\n");
  const tools = opts.cluster.commonTools.length
    ? opts.cluster.commonTools.join(", ")
    : "(none)";
  const routerReason = opts.cluster.commonRouterReason ?? "(unknown)";

  const priorAttempts = opts.priorFailedAttempts ?? [];
  const priorSection = priorAttempts.length > 0
    ? [
        "",
        "PRIOR FAILED ATTEMPTS for THIS exact failure pattern (same fingerprint).",
        `${priorAttempts.length} previous workflow(s) shipped for this cluster but did NOT reduce its size by ≥50% over 7 days of post-ship traffic. Don't repeat their approach — try a substantively different angle (a different decision tree, a different tool order, a different clarifying question, or a different anti-pattern focus). Use the prior bodies to see what's been tried; pick a different lever.`,
        "",
        ...priorAttempts.map(
          (a) =>
            `--- Prior attempt #${a.verificationAttempt} (name: ${a.name}) ---\nSummary: ${a.summary}\nBody:\n${a.body}\n--- end attempt #${a.verificationAttempt} ---`,
        ),
        "",
      ].join("\n")
    : "";

  return [
    "You are a workflow author for a Shopify Merchant Copilot. Your job is to look at a cluster of merchant chat turns where the agent failed (the merchant abandoned, or the agent errored unrecoverably) and write a NEW workflow SOP that would have PREVENTED or SHORT-CIRCUITED the failure.",
    "",
    "Cluster context:",
    `- size: ${opts.cluster.size} similar abandoned/errored turns`,
    `- common tools fired: ${tools}`,
    `- common router reason: ${routerReason}`,
    `- dominant outcome: ${opts.cluster.dominantOutcome}`,
    "",
    "Sample turns from the cluster:",
    "",
    samples,
    priorSection,
    "Author a workflow following these constraints:",
    "- Output ONLY a JSON object. No markdown wrapping, no prose. The shape:",
    `  { "name": "kebab-case-workflow-name", "summary": "One-line description ≤ 140 chars", "triggers": ["keyword", "multi word phrase"], "body": "Markdown body following the workflow format spec" }`,
    "- name: kebab-case, ≤ 40 chars, descriptive of the situation",
    "- triggers: 2-5 entries, lowercase, whole-word matchable. NO stop words like 'do' or 'all'.",
    "- body: Markdown with these sections (in order):",
    "  # Workflow: <Title>",
    "  Tool: `<primary_tool>`",
    "  ## When this runs (2-4 bullets)",
    "  ## Decision tree (numbered branching steps with concrete actions)",
    "  ## Anti-patterns (Don't / Do instead table — 4-6 rows)",
    "  ## Examples (1-3 concrete merchant phrasings + the action shape)",
    "- ≤ 250 lines body. Be concise.",
    "- Anti-patterns rows MUST be sourced from the failure pattern in the samples above.",
    "",
    "Return only the JSON object.",
  ].join("\n");
}

// Phase Mn Round Mn-1 — content-safety scan. Wf-E persists proposals
// from an autonomous LLM pass; the body becomes part of the next CEO's
// system prompt once an operator approves. A body containing
// `[SYSTEM]` sentinels, prompt-injection role markers, or raw HTML
// like `<script>` could poison the prompt or render unsafely in the
// operator UI. Reject at parse-time so unsafe bodies never persist.
//
// Scan looks for:
//   - HTML tags that execute or embed: <script>, <iframe>, <style>,
//     <object>, <embed>, <svg> (case-insensitive, opening-tag only)
//   - Prompt-injection sentinels: [SYSTEM] / [ASSISTANT] / [USER] in
//     square brackets, Gemini-style <|im_start|>, <|im_end|>,
//     <|endoftext|>
//   - Role-marker lines (start-of-line, lowercase): "system:" /
//     "assistant:" / "user:" — common LLM-prompt-format injection
//
// Markdown code fences and prose containing "system" as a word stay
// safe — we match anchored patterns, not substrings.
const UNSAFE_HTML_TAG_RE =
  /<\s*(?:script|iframe|style|object|embed|svg)\b/i;
const PROMPT_INJECTION_SENTINEL_RE =
  /\[(?:SYSTEM|ASSISTANT|USER)\]|<\|(?:im_start|im_end|endoftext)\|>/i;
const ROLE_MARKER_LINE_RE = /^\s*(?:system|assistant|user)\s*:/im;

export function containsUnsafeContent(body: string): boolean {
  return (
    UNSAFE_HTML_TAG_RE.test(body) ||
    PROMPT_INJECTION_SENTINEL_RE.test(body) ||
    ROLE_MARKER_LINE_RE.test(body)
  );
}

// Parse + validate the LLM's JSON output. Returns null on any malformed
// shape — caller logs and skips. Strips wrapping ```json blocks if the
// model added them despite instructions.
export function parseProposalDraft(raw: string): ProposalDraft | null {
  // Strip ```json … ``` if the model wrapped despite instructions.
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let parsed: RawLlmProposal;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  const rawTriggers = Array.isArray(parsed.triggers) ? parsed.triggers : [];

  // Shape validation.
  if (!/^[a-z][a-z0-9-]{2,39}$/.test(name)) return null;
  if (summary.length === 0 || summary.length > 200) return null;
  if (body.length < 100 || body.length > 12_000) return null;
  // Mn-1 content safety scan — reject bodies carrying prompt-injection
  // patterns or unsafe HTML before persistence.
  if (containsUnsafeContent(body)) return null;

  const triggers: string[] = [];
  for (const t of rawTriggers) {
    if (typeof t !== "string") continue;
    const norm = t.trim().toLowerCase();
    if (norm.length === 0 || norm.length > 80) continue;
    if (!triggers.includes(norm)) triggers.push(norm);
    if (triggers.length >= 5) break;
  }
  if (triggers.length < 2) return null;

  return { name, summary, body, triggers };
}

// Run one cluster through the LLM. Returns the parsed draft or null
// (failure soft, logged). Uses Flash-Lite per the cost cap rationale.
// Ab-C-prime — priorFailedAttempts threads through to the prompt so
// re-author calls see what's been tried before.
export async function generateProposalDraft(opts: {
  cluster: ProposalSeedCluster;
  sampleTurns: ProposalSampleTurn[];
  priorFailedAttempts?: PriorFailedAttempt[];
}): Promise<ProposalDraft | null> {
  let ai: GoogleGenAI;
  try {
    ai = getGeminiClient();
  } catch (err) {
    log.warn("workflow-propose: getGeminiClient failed (no API key?)", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const prompt = buildProposalPrompt(opts);
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MEMORY_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });
    const text =
      response.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .filter((t) => t.length > 0)
        .join("") ?? "";
    if (!text) {
      log.warn("workflow-propose: empty LLM response", {
        clusterId: opts.cluster.id,
      });
      return null;
    }
    const draft = parseProposalDraft(text);
    if (!draft) {
      log.warn("workflow-propose: parse failed", {
        clusterId: opts.cluster.id,
        rawPreview: text.slice(0, 200),
      });
      return null;
    }
    return draft;
  } catch (err) {
    log.warn("workflow-propose: LLM call failed", {
      clusterId: opts.cluster.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Persist the draft as a PENDING proposal. Returns the row id, or null
// on collision / DB error. Naming-collision check happens at the
// @@unique([storeId, name]) constraint level — caught + logged.
export async function persistProposal(opts: {
  storeId: string;
  fingerprint: string;
  draft: ProposalDraft;
  evidence: {
    clusterIds: string[];
    sampleTurnIds: string[];
    commonTools: string[];
    commonRouterReason: string | null;
  };
}): Promise<string | null> {
  try {
    const row = await prisma.workflowProposal.create({
      data: {
        storeId: opts.storeId,
        name: opts.draft.name,
        summary: opts.draft.summary,
        body: opts.draft.body,
        triggers: opts.draft.triggers,
        evidence: opts.evidence as unknown as object,
        fingerprint: opts.fingerprint,
        status: "PENDING",
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    log.warn("workflow-propose: persist failed (probably name collision)", {
      storeId: opts.storeId,
      name: opts.draft.name,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Cron-pass orchestrator. Reads top abandonment clusters for a store,
// applies dedupe + cost cap, calls generateProposalDraft per cluster,
// persists drafts. Returns counters for the cron's summary log.
//
// Structurally identical to Phase Ab Round Ab-A's per-store loop —
// fail-soft per cluster, never blocks the cron, never throws upward.
export async function runWorkflowProposalPass(opts: {
  storeId: string;
  now: Date;
}): Promise<{ scanned: number; skipped: number; proposed: number; errored: number }> {
  const counters = { scanned: 0, skipped: 0, proposed: 0, errored: 0 };
  let proposedThisRun = 0;
  try {
    // Top candidate clusters: size >= 5, abandonment-shaped outcome,
    // ordered by size desc. Limit gives us breathing room around dedupe.
    const clusters = await prisma.abandonmentCluster.findMany({
      where: {
        storeId: opts.storeId,
        size: { gte: 5 },
        dominantOutcome: { in: ["abandoned", "errored_unrecovered"] },
      },
      orderBy: { size: "desc" },
      take: MAX_PROPOSALS_PER_STORE_PER_RUN * 3,
    });
    for (const c of clusters) {
      counters.scanned += 1;
      if (proposedThisRun >= MAX_PROPOSALS_PER_STORE_PER_RUN) {
        counters.skipped += 1;
        continue;
      }
      const skipDecision = await shouldSkipFingerprint({
        storeId: opts.storeId,
        fingerprint: c.fingerprint,
        now: opts.now,
      });
      if (skipDecision.skip) {
        counters.skipped += 1;
        continue;
      }
      // Pull a few sample turns for the LLM. Each turn's user message +
      // a short assistant trace is enough to characterize the failure
      // pattern; we cap at 5 to keep the prompt cheap.
      const sampleTurns = await fetchSampleTurns(c.sampleTurnIds.slice(0, 5));
      if (sampleTurns.length === 0) {
        counters.skipped += 1;
        continue;
      }
      // Phase Ab Round Ab-C-prime — if this fingerprint has prior
      // FIX_DIDNT_HELP attempts, load them so the model authors a
      // different shape instead of repeating the failed pattern.
      const priorFailedAttempts = await loadPriorFailedAttempts({
        storeId: opts.storeId,
        fingerprint: c.fingerprint,
      });
      const draft = await generateProposalDraft({
        cluster: {
          id: c.id,
          storeId: c.storeId,
          size: c.size,
          sampleTurnIds: c.sampleTurnIds,
          commonTools: c.commonTools,
          commonRouterReason: c.commonRouterReason,
          dominantOutcome: c.dominantOutcome,
          fingerprint: c.fingerprint,
        },
        sampleTurns,
        priorFailedAttempts,
      });
      if (!draft) {
        counters.errored += 1;
        continue;
      }
      const id = await persistProposal({
        storeId: opts.storeId,
        fingerprint: c.fingerprint,
        draft,
        evidence: {
          clusterIds: [c.id],
          sampleTurnIds: c.sampleTurnIds,
          commonTools: c.commonTools,
          commonRouterReason: c.commonRouterReason,
        },
      });
      if (id) {
        counters.proposed += 1;
        proposedThisRun += 1;
      } else {
        counters.errored += 1;
      }
    }
  } catch (err) {
    log.error("workflow-propose: pass failed (bailing for this store)", {
      storeId: opts.storeId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return counters;
}

// Pull a small evidence batch — user message text + a short assistant
// summary — for the LLM. Best-effort; turn IDs that don't resolve are
// skipped silently.
async function fetchSampleTurns(
  turnSignalIds: string[],
): Promise<ProposalSampleTurn[]> {
  if (turnSignalIds.length === 0) return [];
  try {
    const signals = await prisma.turnSignal.findMany({
      where: { id: { in: turnSignalIds } },
      select: {
        outcome: true,
        conversationId: true,
        message: { select: { createdAt: true } },
      },
    });
    if (signals.length === 0) return [];
    const conversationIds = Array.from(
      new Set(signals.map((s) => s.conversationId)),
    );
    const messages = await prisma.message.findMany({
      where: { conversationId: { in: conversationIds } },
      select: {
        conversationId: true,
        role: true,
        content: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const out: ProposalSampleTurn[] = [];
    for (const sig of signals) {
      const conv = messages.filter((m) => m.conversationId === sig.conversationId);
      // Find the user text that prompted this turn (most recent user
      // message before the assistant message in the signal).
      const sigCreatedAt = sig.message?.createdAt ?? new Date(0);
      let userText = "";
      let assistantText = "";
      for (const m of conv) {
        if (m.createdAt >= sigCreatedAt) break;
        const text = extractFirstText(m.content);
        if (m.role === "user" && text) userText = text;
        if ((m.role === "assistant" || m.role === "model") && text)
          assistantText = text;
      }
      if (!userText) continue;
      out.push({
        userMessage: userText.slice(0, 300),
        assistantSummary: assistantText.slice(0, 300),
        outcome: sig.outcome,
      });
    }
    return out;
  } catch (err) {
    log.warn("workflow-propose: fetchSampleTurns failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function extractFirstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === "text" && typeof block.text === "string") {
      return block.text.trim();
    }
  }
  return "";
}
