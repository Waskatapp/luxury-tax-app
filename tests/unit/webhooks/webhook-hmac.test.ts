import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Webhook HMAC verification is enforced by the Shopify SDK's
// authenticate.webhook(request) call. These tests pin the contract that our
// route actions never touch the database when the SDK rejects a request.
// If a future refactor accidentally wraps authenticate.webhook in a try/catch
// that swallows the rejection, these tests fail.

const authenticateMock = vi.hoisted(() => ({
  webhook: vi.fn(),
}));

const dbMock = vi.hoisted(() => ({
  default: {
    session: { deleteMany: vi.fn(), update: vi.fn() },
    store: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: authenticateMock,
}));

vi.mock("../../../app/db.server", () => dbMock);

describe("webhooks.app.uninstalled — HMAC verification", () => {
  beforeEach(() => {
    authenticateMock.webhook.mockReset();
    Object.values(dbMock.default).forEach((model) => {
      if (typeof model === "object") {
        Object.values(model).forEach((fn) => {
          if (typeof fn === "function") (fn as ReturnType<typeof vi.fn>).mockReset();
        });
      }
      if (typeof model === "function") (model as ReturnType<typeof vi.fn>).mockReset();
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("propagates the SDK's 401 Response on tampered HMAC and writes nothing to the DB", async () => {
    const rejection = new Response("Unauthorized", { status: 401 });
    authenticateMock.webhook.mockRejectedValueOnce(rejection);

    const { action } = await import("../../../app/routes/webhooks.app.uninstalled");
    const fakeRequest = new Request("https://example.com/webhooks/app/uninstalled", {
      method: "POST",
      body: "{}",
    });

    await expect(action({ request: fakeRequest } as never)).rejects.toBe(rejection);

    // No DB writes on a rejected webhook.
    expect(dbMock.default.session.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.default.store.findUnique).not.toHaveBeenCalled();
    expect(dbMock.default.$transaction).not.toHaveBeenCalled();
  });

  it("on valid HMAC + existing store, writes uninstalledAt + AuditLog atomically", async () => {
    authenticateMock.webhook.mockResolvedValueOnce({
      shop: "the-new-waskat-dev-store.myshopify.com",
      session: { id: "session-1" },
      topic: "APP_UNINSTALLED",
      payload: {},
    });
    dbMock.default.store.findUnique.mockResolvedValueOnce({
      id: "store-1",
      uninstalledAt: null,
    });

    const { action } = await import("../../../app/routes/webhooks.app.uninstalled");
    const fakeRequest = new Request("https://example.com/webhooks/app/uninstalled", {
      method: "POST",
      body: "{}",
    });

    await action({ request: fakeRequest } as never);

    expect(dbMock.default.session.deleteMany).toHaveBeenCalledWith({
      where: { shop: "the-new-waskat-dev-store.myshopify.com" },
    });
    expect(dbMock.default.$transaction).toHaveBeenCalledTimes(1);
  });
});
