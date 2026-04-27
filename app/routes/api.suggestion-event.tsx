import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import { log } from "../lib/log.server";

// POST /api/suggestion-event
//
// Welcome-screen telemetry. The client batches an "impression" POST when
// the welcome screen renders (one row per visible suggestion, same createdAt)
// and a separate "click" POST when the merchant clicks a suggestion. Fire-
// and-forget on the client (sendBeacon for impressions, keepalive fetch for
// clicks) — never blocks the chat.
//
// Used today only for short-term session de-dupe via the recent-clicks query
// in pickSuggestions. Future phase computes CTR per templateId for ranking.

const EventItem = z.object({
  templateId: z.string().min(1).max(80),
  slotPosition: z.number().int().min(0).max(10),
  eventType: z.enum(["impression", "click"]),
  conversationId: z.string().min(1).max(40).optional(),
});

const RequestBody = z.object({
  events: z.array(EventItem).min(1).max(20),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { store, session } = await requireStoreAccess(request);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const parsed = RequestBody.safeParse(raw);
  if (!parsed.success) {
    return new Response(`Invalid payload: ${parsed.error.message}`, {
      status: 400,
    });
  }

  const userId =
    session.onlineAccessInfo?.associated_user?.id?.toString() ?? "owner";

  try {
    await prisma.suggestionEvent.createMany({
      data: parsed.data.events.map((e) => ({
        storeId: store.id,
        userId,
        templateId: e.templateId,
        slotPosition: e.slotPosition,
        eventType: e.eventType,
        conversationId: e.conversationId ?? null,
      })),
    });
  } catch (err) {
    // Telemetry must never surface user-facing errors. Log + swallow.
    log.warn("suggestion-event: insert failed (non-fatal)", {
      storeId: store.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return Response.json({ ok: true });
};
