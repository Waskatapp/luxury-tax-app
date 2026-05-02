import { describe, expect, it } from "vitest";

import { createDiscountCode } from "../../../app/lib/shopify/discounts.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function codeSuccessResponse(overrides?: Partial<{
  title: string;
  code: string;
  status: string;
  startsAt: string;
  endsAt: string | null;
  summary: string;
  usageLimit: number | null;
  appliesOncePerCustomer: boolean;
}>) {
  return {
    kind: "data" as const,
    body: {
      discountCodeBasicCreate: {
        codeDiscountNode: {
          id: "gid://shopify/DiscountCodeNode/code-1",
          codeDiscount: {
            title: overrides?.title ?? "SUMMER20",
            status: overrides?.status ?? "ACTIVE",
            startsAt: overrides?.startsAt ?? "2026-06-01T00:00:00Z",
            endsAt: overrides?.endsAt ?? null,
            summary: overrides?.summary ?? "20% off all products",
            usageLimit: overrides?.usageLimit ?? null,
            appliesOncePerCustomer: overrides?.appliesOncePerCustomer ?? false,
            codes: {
              edges: [{ node: { code: overrides?.code ?? "SUMMER20" } }],
            },
          },
        },
        userErrors: [],
      },
    },
  };
}

describe("createDiscountCode — happy paths", () => {
  it("minimal input — defaults title to code; sends correct payload", async () => {
    const admin = fakeAdmin([codeSuccessResponse()]);

    const result = await createDiscountCode(admin, {
      code: "SUMMER20",
      percentOff: 20,
      startsAt: "2026-06-01T00:00:00Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      id: "gid://shopify/DiscountCodeNode/code-1",
      code: "SUMMER20",
      title: "SUMMER20",
      percentOff: 20,
      status: "ACTIVE",
      startsAt: "2026-06-01T00:00:00Z",
      endsAt: null,
      summary: "20% off all products",
      usageLimit: null,
      appliesOncePerCustomer: false,
    });

    // Mapping check — flat input → Shopify nested DiscountCodeBasicInput.
    expect(admin.calls[0].variables).toEqual({
      basicCodeDiscount: {
        title: "SUMMER20",                    // defaulted to code
        code: "SUMMER20",
        startsAt: "2026-06-01T00:00:00Z",
        customerSelection: { all: true },
        customerGets: {
          value: { percentage: 0.2 },         // 20 / 100
          items: { all: true },
        },
      },
    });
  });

  it("uses provided title (not the code) when title is set", async () => {
    const admin = fakeAdmin([
      codeSuccessResponse({ title: "Summer Sale 2026" }),
    ]);

    await createDiscountCode(admin, {
      code: "SUMMER20",
      title: "Summer Sale 2026",
      percentOff: 20,
      startsAt: "2026-06-01T00:00:00Z",
    });

    const vars = admin.calls[0].variables as {
      basicCodeDiscount: { title: string; code: string };
    };
    expect(vars.basicCodeDiscount.title).toBe("Summer Sale 2026");
    expect(vars.basicCodeDiscount.code).toBe("SUMMER20");
  });

  it("includes optional endsAt / usageLimit / appliesOncePerCustomer when set", async () => {
    const admin = fakeAdmin([
      codeSuccessResponse({
        endsAt: "2026-09-01T00:00:00Z",
        usageLimit: 100,
        appliesOncePerCustomer: true,
      }),
    ]);

    const result = await createDiscountCode(admin, {
      code: "FIRST10",
      percentOff: 10,
      startsAt: "2026-06-01T00:00:00Z",
      endsAt: "2026-09-01T00:00:00Z",
      usageLimit: 100,
      appliesOncePerCustomer: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.endsAt).toBe("2026-09-01T00:00:00Z");
    expect(result.data.usageLimit).toBe(100);
    expect(result.data.appliesOncePerCustomer).toBe(true);

    expect(admin.calls[0].variables).toEqual({
      basicCodeDiscount: {
        title: "FIRST10",
        code: "FIRST10",
        startsAt: "2026-06-01T00:00:00Z",
        customerSelection: { all: true },
        customerGets: {
          value: { percentage: 0.1 },
          items: { all: true },
        },
        endsAt: "2026-09-01T00:00:00Z",
        usageLimit: 100,
        appliesOncePerCustomer: true,
      },
    });
  });

  it("omits optional fields when not provided", async () => {
    const admin = fakeAdmin([codeSuccessResponse()]);
    await createDiscountCode(admin, {
      code: "BASIC",
      percentOff: 15,
      startsAt: "2026-06-01T00:00:00Z",
    });

    const vars = admin.calls[0].variables as {
      basicCodeDiscount: Record<string, unknown>;
    };
    expect("endsAt" in vars.basicCodeDiscount).toBe(false);
    expect("usageLimit" in vars.basicCodeDiscount).toBe(false);
    expect("appliesOncePerCustomer" in vars.basicCodeDiscount).toBe(false);
  });

  it("trims whitespace from code (Zod .trim())", async () => {
    const admin = fakeAdmin([codeSuccessResponse({ code: "TRIMME" })]);
    await createDiscountCode(admin, {
      code: "  TRIMME  ",
      percentOff: 25,
      startsAt: "2026-06-01T00:00:00Z",
    });

    const vars = admin.calls[0].variables as {
      basicCodeDiscount: { code: string };
    };
    expect(vars.basicCodeDiscount.code).toBe("TRIMME");
  });

  it("returns the code Shopify echoed back (in case Shopify normalized it)", async () => {
    const admin = fakeAdmin([
      codeSuccessResponse({ code: "summer20" }),     // Shopify lowercased
    ]);
    const result = await createDiscountCode(admin, {
      code: "SUMMER20",
      percentOff: 20,
      startsAt: "2026-06-01T00:00:00Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.code).toBe("summer20");
  });
});

describe("createDiscountCode — Zod rejections", () => {
  it("rejects empty code", async () => {
    const admin = fakeAdmin([]);
    const result = await createDiscountCode(admin, {
      code: "",
      percentOff: 20,
      startsAt: "2026-06-01T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects whitespace-only code (post-trim is empty)", async () => {
    const admin = fakeAdmin([]);
    const result = await createDiscountCode(admin, {
      code: "   ",
      percentOff: 20,
      startsAt: "2026-06-01T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects percentOff > 100", async () => {
    const admin = fakeAdmin([]);
    const result = await createDiscountCode(admin, {
      code: "TOOMUCH",
      percentOff: 150,
      startsAt: "2026-06-01T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects percentOff < 1", async () => {
    const admin = fakeAdmin([]);
    const result = await createDiscountCode(admin, {
      code: "TOOLITTLE",
      percentOff: 0,
      startsAt: "2026-06-01T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects non-integer percentOff", async () => {
    const admin = fakeAdmin([]);
    const result = await createDiscountCode(admin, {
      code: "FLOATY",
      percentOff: 12.5,
      startsAt: "2026-06-01T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects usageLimit < 1", async () => {
    const admin = fakeAdmin([]);
    const result = await createDiscountCode(admin, {
      code: "BAD",
      percentOff: 10,
      startsAt: "2026-06-01T00:00:00Z",
      usageLimit: 0,
    });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });
});

describe("createDiscountCode — error surfacing", () => {
  it("surfaces shopify userErrors", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountCodeBasicCreate: {
            codeDiscountNode: null,
            userErrors: [
              {
                field: ["basicCodeDiscount", "code"],
                message: "Code has already been taken",
                code: "TAKEN",
              },
            ],
          },
        },
      },
    ]);
    const result = await createDiscountCode(admin, {
      code: "DUPLICATE",
      percentOff: 20,
      startsAt: "2026-06-01T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Code has already been taken");
  });

  it("returns error when Shopify returns no codeDiscountNode (defensive)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          discountCodeBasicCreate: {
            codeDiscountNode: null,
            userErrors: [],
          },
        },
      },
    ]);
    const result = await createDiscountCode(admin, {
      code: "GHOST",
      percentOff: 20,
      startsAt: "2026-06-01T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("codeDiscountNode");
  });
});
