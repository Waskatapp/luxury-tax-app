import { describe, expect, it } from "vitest";

import {
  _testing,
  refundOrder,
} from "../../../app/lib/shopify/orders.server";
import { fakeAdmin } from "../../helpers/fake-admin";

const { REFUND_CREATE_MUTATION } = _testing;

// refundOrder issues UP TO FOUR GraphQL calls in the happy path:
// 1. fetchOrderDetail (currency + amount-cap snapshot + AuditLog state)
// 2. fetchOrderTransactions (find parent SALE/CAPTURE)
// 3. refundCreate mutation (with @idempotent directive)
// 4. fetchOrderDetail (post-refund snapshot)
//
// The defensive gates short-circuit: confirmAmount mismatch fails at
// Zod (no calls); currency mismatch fails after call 1 (no mutation);
// over-refund fails after call 1 (no mutation); no-parent-transaction
// fails after call 2 (no mutation).

function detailNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/Order/1001",
    name: "#1001",
    createdAt: "2026-04-25T10:00:00Z",
    processedAt: "2026-04-25T10:00:00Z",
    cancelledAt: null,
    closedAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    sourceName: "web",
    tags: [],
    note: null,
    updatedAt: "2026-05-04T12:00:00Z",
    customer: {
      id: "gid://shopify/Customer/1",
      displayName: "Cat Lover",
      email: "cat@cats.com",
      phone: null,
    },
    lineItems: { edges: [] },
    subtotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
    totalShippingPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    totalTaxSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    totalPriceSet: { shopMoney: { amount: "29.99", currencyCode: "USD" } },
    totalRefundedSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    shippingAddress: null,
    fulfillments: [],
    refunds: [],
    ...overrides,
  };
}

function detailResponse(overrides?: Partial<Record<string, unknown>>) {
  return { kind: "data" as const, body: { order: detailNode(overrides) } };
}

function transactionsResponse(
  txns: Array<{
    id: string;
    kind: string;
    status: string;
    gateway: string | null;
  }>,
) {
  return {
    kind: "data" as const,
    body: {
      order: {
        id: "gid://shopify/Order/1001",
        transactions: txns.map((t) => ({
          ...t,
          amountSet: { shopMoney: { amount: "29.99", currencyCode: "USD" } },
          parentTransaction: null,
        })),
      },
    },
  };
}

function successfulSaleTxn() {
  return {
    id: "gid://shopify/OrderTransaction/7001",
    kind: "SALE",
    status: "SUCCESS",
    gateway: "shopify_payments",
  };
}

function refundSuccessResponse(amount: string) {
  return {
    kind: "data" as const,
    body: {
      refundCreate: {
        refund: {
          id: "gid://shopify/Refund/9001",
          createdAt: "2026-05-04T12:00:00Z",
          note: null,
          totalRefundedSet: {
            shopMoney: { amount, currencyCode: "USD" },
          },
        },
        userErrors: [],
      },
    },
  };
}

describe("refundOrder — happy paths", () => {
  it("full refund — fetches order + transactions, builds refund, refetches snapshot", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([successfulSaleTxn()]),
      refundSuccessResponse("29.99"),
      detailResponse({
        totalRefundedSet: { shopMoney: { amount: "29.99", currencyCode: "USD" } },
        displayFinancialStatus: "REFUNDED",
      }),
    ]);

    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "29.99",
      confirmAmount: "29.99",
      currencyCode: "USD",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(admin.calls).toHaveLength(4);

    // Mutation input: transactions[].parentId references the SALE id;
    // gateway flows through; kind:REFUND; amount as decimal string.
    const vars = admin.calls[2].variables as {
      input: {
        orderId: string;
        notify: boolean;
        transactions: Array<{
          orderId: string;
          parentId: string;
          gateway: string;
          amount: string;
          kind: string;
        }>;
      };
      idempotencyKey: string;
    };
    expect(vars.input.orderId).toBe("gid://shopify/Order/1001");
    expect(vars.input.notify).toBe(true);
    expect(vars.input.transactions).toEqual([
      {
        orderId: "gid://shopify/Order/1001",
        parentId: "gid://shopify/OrderTransaction/7001",
        gateway: "shopify_payments",
        amount: "29.99",
        kind: "REFUND",
      },
    ]);
  });

  it("partial refund — caller passes a smaller amount, mutation reflects it", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([successfulSaleTxn()]),
      refundSuccessResponse("10.00"),
      detailResponse({
        totalRefundedSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
        displayFinancialStatus: "PARTIALLY_REFUNDED",
      }),
    ]);

    await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "10.00",
      confirmAmount: "10.00",
      currencyCode: "USD",
    });

    const vars = admin.calls[2].variables as {
      input: { transactions: Array<{ amount: string }> };
    };
    expect(vars.input.transactions[0].amount).toBe("10.00");
  });

  it("amount === outstanding-refundable boundary — succeeds at exact match", async () => {
    // totalPrice $29.99, totalRefunded $0 → totalRefundable $29.99.
    // Refunding exactly $29.99 is allowed (equality, not strict-less-than).
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([successfulSaleTxn()]),
      refundSuccessResponse("29.99"),
      detailResponse(),
    ]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "29.99",
      confirmAmount: "29.99",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(true);
  });

  it("notifyCustomer:false flows to refund input as notify:false", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([successfulSaleTxn()]),
      refundSuccessResponse("29.99"),
      detailResponse(),
    ]);
    await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "29.99",
      confirmAmount: "29.99",
      currencyCode: "USD",
      notifyCustomer: false,
    });
    const vars = admin.calls[2].variables as {
      input: { notify: boolean };
    };
    expect(vars.input.notify).toBe(false);
  });

  it("reason — included as `note` on the refund record", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([successfulSaleTxn()]),
      refundSuccessResponse("29.99"),
      detailResponse(),
    ]);
    await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "29.99",
      confirmAmount: "29.99",
      currencyCode: "USD",
      reason: "package lost in shipping",
    });
    const vars = admin.calls[2].variables as {
      input: { note: string };
    };
    expect(vars.input.note).toBe("package lost in shipping");
  });

  it("falls back to first SUCCESS sale/capture, ignoring AUTHORIZATION transactions", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([
        {
          id: "gid://shopify/OrderTransaction/6900",
          kind: "AUTHORIZATION",
          status: "SUCCESS",
          gateway: "shopify_payments",
        },
        successfulSaleTxn(), // the one we want
      ]),
      refundSuccessResponse("29.99"),
      detailResponse(),
    ]);
    await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "29.99",
      confirmAmount: "29.99",
      currencyCode: "USD",
    });
    const vars = admin.calls[2].variables as {
      input: { transactions: Array<{ parentId: string }> };
    };
    expect(vars.input.transactions[0].parentId).toBe(
      "gid://shopify/OrderTransaction/7001",
    );
  });
});

describe("refundOrder — Zod validation (gate 1: confirmAmount + amount shape)", () => {
  it("confirmAmount mismatch off by 1¢ — Zod rejects, no GraphQL calls", async () => {
    const admin = fakeAdmin([]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "29.99",
      confirmAmount: "29.98",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("confirmAmount must equal amount");
    expect(admin.calls).toHaveLength(0);
  });

  it("confirmAmount mismatch off by $1 — Zod rejects", async () => {
    const admin = fakeAdmin([]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "29.99",
      confirmAmount: "30.99",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("confirmAmount = '5' vs amount = '5.00' — accepts (1¢ tolerance compares cents)", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([successfulSaleTxn()]),
      refundSuccessResponse("5.00"),
      detailResponse(),
    ]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "5.00",
      confirmAmount: "5",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects negative amount", async () => {
    const admin = fakeAdmin([]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "-5.00",
      confirmAmount: "-5.00",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects zero amount (refunding nothing makes no sense)", async () => {
    const admin = fakeAdmin([]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "0",
      confirmAmount: "0",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects '0.00' as zero", async () => {
    const admin = fakeAdmin([]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "0.00",
      confirmAmount: "0.00",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects 3+ decimal places (currency precision)", async () => {
    const admin = fakeAdmin([]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "29.999",
      confirmAmount: "29.999",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects scientific notation", async () => {
    const admin = fakeAdmin([]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "1e2",
      confirmAmount: "1e2",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects empty orderId", async () => {
    const admin = fakeAdmin([]);
    const result = await refundOrder(admin, {
      orderId: "",
      amount: "5.00",
      confirmAmount: "5.00",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects currencyCode of wrong length (not 3)", async () => {
    const admin = fakeAdmin([]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "5.00",
      confirmAmount: "5.00",
      currencyCode: "DOLLARS",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });
});

describe("refundOrder — handler gates 2 + 3 (currency + amount-cap)", () => {
  it("currency mismatch — handler refuses after the snapshot fetch, no mutation", async () => {
    const admin = fakeAdmin([
      // Order in USD; refund attempted as EUR.
      detailResponse(),
    ]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "29.99",
      confirmAmount: "29.99",
      currencyCode: "EUR",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("currency mismatch");
    expect(result.error).toContain("USD");
    expect(result.error).toContain("EUR");
    // Only the snapshot fetch happened — no transaction fetch, no mutation.
    expect(admin.calls).toHaveLength(1);
  });

  it("amount > totalRefundable — handler refuses, no mutation", async () => {
    // totalPrice $29.99, totalRefunded $20.00 → totalRefundable $9.99.
    // Refunding $15 should refuse.
    const admin = fakeAdmin([
      detailResponse({
        totalRefundedSet: {
          shopMoney: { amount: "20.00", currencyCode: "USD" },
        },
      }),
    ]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "15.00",
      confirmAmount: "15.00",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("exceeds outstanding-refundable");
    expect(result.error).toContain("9.99");
    expect(admin.calls).toHaveLength(1);
  });

  it("amount === totalRefundable boundary — succeeds (already covered in happy paths) — verify amount > by 1¢ refuses", async () => {
    // totalRefundable computed as $29.99. Refund $30 (1¢ over) should refuse.
    const admin = fakeAdmin([detailResponse()]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "30.00",
      confirmAmount: "30.00",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("exceeds outstanding-refundable");
  });

  it("order not found — fetchOrderDetail error surfaced", async () => {
    const admin = fakeAdmin([{ kind: "data", body: { order: null } }]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/missing",
      amount: "5.00",
      confirmAmount: "5.00",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("order not found");
    expect(admin.calls).toHaveLength(1);
  });
});

describe("refundOrder — gate 4 (parent transaction)", () => {
  it("no successful sale/capture — handler refuses, no mutation", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      // Only an authorization (not yet captured) — can't refund.
      transactionsResponse([
        {
          id: "gid://shopify/OrderTransaction/6900",
          kind: "AUTHORIZATION",
          status: "SUCCESS",
          gateway: "shopify_payments",
        },
      ]),
    ]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "5.00",
      confirmAmount: "5.00",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no successful sale/capture");
    // Only snapshot + transactions fetch happened, no mutation.
    expect(admin.calls).toHaveLength(2);
  });

  it("sale exists but status is FAILURE — handler refuses", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([
        {
          id: "gid://shopify/OrderTransaction/7001",
          kind: "SALE",
          status: "FAILURE",
          gateway: "shopify_payments",
        },
      ]),
    ]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "5.00",
      confirmAmount: "5.00",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no successful sale/capture");
  });

  it("parent transaction has no gateway — handler refuses", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([
        {
          id: "gid://shopify/OrderTransaction/7001",
          kind: "SALE",
          status: "SUCCESS",
          gateway: null,
        },
      ]),
    ]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "5.00",
      confirmAmount: "5.00",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no gateway");
  });
});

describe("refundOrder — @idempotent directive + idempotency key", () => {
  it("mutation query string includes the @idempotent directive", () => {
    // Asserts on the canonical mutation literal exported via _testing.
    // Shopify 2026-04 requires this directive on refundCreate.
    expect(REFUND_CREATE_MUTATION).toContain("@idempotent(key: $idempotencyKey)");
    expect(REFUND_CREATE_MUTATION).toContain("$idempotencyKey: String!");
  });

  it("call passes a UUID-shaped idempotency key in variables", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([successfulSaleTxn()]),
      refundSuccessResponse("5.00"),
      detailResponse(),
    ]);
    await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "5.00",
      confirmAmount: "5.00",
      currencyCode: "USD",
    });
    const vars = admin.calls[2].variables as { idempotencyKey: string };
    // crypto.randomUUID() format: 8-4-4-4-12 hex chars.
    expect(vars.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("two calls produce different idempotency keys (UUID uniqueness)", async () => {
    const adminA = fakeAdmin([
      detailResponse(),
      transactionsResponse([successfulSaleTxn()]),
      refundSuccessResponse("5.00"),
      detailResponse(),
    ]);
    const adminB = fakeAdmin([
      detailResponse(),
      transactionsResponse([successfulSaleTxn()]),
      refundSuccessResponse("5.00"),
      detailResponse(),
    ]);
    await refundOrder(adminA, {
      orderId: "gid://shopify/Order/1001",
      amount: "5.00",
      confirmAmount: "5.00",
      currencyCode: "USD",
    });
    await refundOrder(adminB, {
      orderId: "gid://shopify/Order/1001",
      amount: "5.00",
      confirmAmount: "5.00",
      currencyCode: "USD",
    });
    const keyA = (adminA.calls[2].variables as { idempotencyKey: string })
      .idempotencyKey;
    const keyB = (adminB.calls[2].variables as { idempotencyKey: string })
      .idempotencyKey;
    expect(keyA).not.toBe(keyB);
  });
});

describe("refundOrder — Shopify userErrors", () => {
  it("surfaces refundCreate userErrors verbatim", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([successfulSaleTxn()]),
      {
        kind: "data",
        body: {
          refundCreate: {
            refund: null,
            userErrors: [
              {
                field: ["input", "transactions"],
                message: "Refund amount exceeds available transaction amount",
              },
            ],
          },
        },
      },
    ]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "5.00",
      confirmAmount: "5.00",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Refund amount exceeds");
    // No post-mutation refetch on error.
    expect(admin.calls).toHaveLength(3);
  });

  it("surfaces error if refundCreate returns null refund with no userErrors", async () => {
    const admin = fakeAdmin([
      detailResponse(),
      transactionsResponse([successfulSaleTxn()]),
      {
        kind: "data",
        body: {
          refundCreate: { refund: null, userErrors: [] },
        },
      },
    ]);
    const result = await refundOrder(admin, {
      orderId: "gid://shopify/Order/1001",
      amount: "5.00",
      confirmAmount: "5.00",
      currencyCode: "USD",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("returned no refund");
  });
});
