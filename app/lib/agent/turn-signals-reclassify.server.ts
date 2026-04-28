import prisma from "../../db.server";
import { log } from "../log.server";

// V2.2 — Phase 2 of TurnSignal classification: outcomes that depend on
// what happens NEXT can't be decided when the turn closes. They're
// re-classified here.
//
// Two rules:
//
//   1. REPHRASED. If the previous turn was "informational" AND the new
//      user message starts with /^(no|actually|i meant|that's not|wrong)/i,
//      promote the previous turn to "rephrased". The CEO misread the
//      merchant; the merchant is correcting.
//
//   2. ABANDONED. If a turn is older than 24h, has no successor user
//      turn, and is still "informational", promote it to "abandoned".
//      The merchant gave up on whatever the CEO offered.
//
// Both functions are idempotent: re-running on already-classified rows
// is a no-op (the `where` clause filters to `outcome: "informational"`).
//
// Phase 2.6 (Reflection cron) will own the abandoned sweep on a
// schedule. Until then we run BOTH on every new chat turn — cheap
// (one indexed lookup + at most a handful of UPDATEs).

const REPHRASE_PATTERN = /^\s*(no\b|actually\b|i meant\b|that'?s not\b|wrong\b|not what i\b|nope\b)/i;
const REPHRASE_WINDOW_MS = 60_000;
const ABANDON_THRESHOLD_MS = 24 * 60 * 60 * 1_000;

// Called from api.chat.tsx at the start of every new user turn (before any
// Gemini work). The new user message text is what we test against.
export async function reclassifyOnNewTurn(opts: {
  storeId: string;
  conversationId: string;
  newUserText: string;
  now?: Date;
}): Promise<void> {
  const now = opts.now ?? new Date();
  try {
    await Promise.all([
      maybePromoteToRephrased(opts.storeId, opts.conversationId, opts.newUserText, now),
      sweepAbandoned(opts.storeId, now),
    ]);
  } catch (err) {
    // Telemetry must never break chat. Log and move on.
    log.error("reclassifyOnNewTurn failed", { err });
  }
}

async function maybePromoteToRephrased(
  storeId: string,
  conversationId: string,
  newUserText: string,
  now: Date,
): Promise<void> {
  if (!REPHRASE_PATTERN.test(newUserText)) return;

  // The previous assistant turn in THIS conversation, only if still
  // tagged "informational" — already-terminal outcomes don't get demoted.
  const lastInfo = await prisma.turnSignal.findFirst({
    where: { storeId, conversationId, outcome: "informational" },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });
  if (!lastInfo) return;

  const ageMs = now.getTime() - lastInfo.createdAt.getTime();
  if (ageMs > REPHRASE_WINDOW_MS) return;

  // Idempotent: only flip rows still labelled "informational". A racing
  // sweep that already promoted this row to "abandoned" wins — we don't
  // overwrite a more-terminal label.
  await prisma.turnSignal.updateMany({
    where: { id: lastInfo.id, outcome: "informational" },
    data: { outcome: "rephrased" },
  });
}

async function sweepAbandoned(storeId: string, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - ABANDON_THRESHOLD_MS);
  // Anything still "informational" + older than 24h → abandoned. Cheap;
  // the (storeId, createdAt) index covers the predicate. updateMany is
  // idempotent.
  await prisma.turnSignal.updateMany({
    where: {
      storeId,
      outcome: "informational",
      createdAt: { lt: cutoff },
    },
    data: { outcome: "abandoned" },
  });
}

// ---- Pure helpers exported for unit tests ----

// Returns true if the new user text indicates a rephrase. Pure; no DB.
export function isRephraseSignal(newUserText: string): boolean {
  return REPHRASE_PATTERN.test(newUserText);
}

export const _testing = {
  REPHRASE_WINDOW_MS,
  ABANDON_THRESHOLD_MS,
  REPHRASE_PATTERN,
};
