// Tiny structured logger. Emits one JSON object per line to stdout/stderr —
// Railway captures both. Intentionally not pino: no dep, no stream wiring,
// fits in this file. If we ever need redaction, child loggers, or
// transports, swap to pino in a focused PR.
//
// Rule: never log secrets. The `ctx` object is shallow-stringified; pass
// only structured metadata (storeId, conversationId, toolName, durationMs).
// Don't pass session.accessToken, encrypted blobs, or full message text.

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      // Errors don't JSON.stringify usefully; flatten name+message+stack.
      if (v instanceof Error) {
        line[k] = { name: v.name, message: v.message, stack: v.stack };
      } else {
        line[k] = v;
      }
    }
  }
  // Look up `console[level]` lazily so test spies on console.warn etc. work.
  const fn = console[level] as (...args: unknown[]) => void;
  fn(JSON.stringify(line));
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit("error", msg, ctx),
};
