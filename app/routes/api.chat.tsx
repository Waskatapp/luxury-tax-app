import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import prisma from "../db.server";
import { requireStoreAccess } from "../lib/auth.server";
import { sanitizeUserInput } from "../lib/security/sanitize.server";

// POST /api/chat — stubbed streaming endpoint (Phase 3).
// Real Claude streaming lands in Phase 4; this emits fixed text_delta frames
// so we can prove the SSE pipeline end-to-end.
const BodySchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1).max(4000),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { store } = await requireStoreAccess(request);

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid body", { status: 400 });
  const { conversationId, text } = parsed.data;

  // Tenant scope (CLAUDE.md rule #2).
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, storeId: store.id },
    select: { id: true, title: true },
  });
  if (!conversation) return new Response("Not found", { status: 404 });

  const sanitized = sanitizeUserInput(text);

  // Persist user message + stub assistant message in the exact ContentBlock[]
  // shape (CLAUDE.md rule #3) so Phase 4 needs no data migration.
  const userContent = [{ type: "text" as const, text: sanitized }];
  const assistantText =
    "This is a stubbed Copilot reply. Phase 4 will stream real Claude output here.";
  const assistantContent = [{ type: "text" as const, text: assistantText }];

  await prisma.$transaction([
    prisma.message.create({
      data: { conversationId, role: "user", content: userContent },
    }),
    prisma.message.create({
      data: { conversationId, role: "assistant", content: assistantContent },
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: {
        title: conversation.title ?? sanitized.slice(0, 60),
        updatedAt: new Date(),
      },
    }),
  ]);

  // Stream the assistant text word-by-word so the UI sees a real streaming effect.
  const words = assistantText.split(/(\s+)/).filter((w) => w.length > 0);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      for (const word of words) {
        emit("text_delta", { delta: word });
        await new Promise((r) => setTimeout(r, 60));
      }
      emit("done", {});
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable Railway/Nginx edge buffering for SSE (CLAUDE.md risk #5).
      "X-Accel-Buffering": "no",
    },
  });
};
