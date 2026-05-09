import { describe, expect, it } from "vitest";

import { readLocations } from "../../../app/lib/shopify/inventory.server";
import { fakeAdmin } from "../../helpers/fake-admin";

function locationNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gid://shopify/Location/1",
    name: "Vancouver Warehouse",
    isActive: true,
    fulfillsOnlineOrders: true,
    address: { city: "Vancouver", province: "BC", country: "Canada" },
    ...overrides,
  };
}

describe("readLocations", () => {
  it("happy path — returns mapped location summaries", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          locations: {
            edges: [
              { node: locationNode() },
              {
                node: locationNode({
                  id: "gid://shopify/Location/2",
                  name: "Toronto Shop",
                  address: {
                    city: "Toronto",
                    province: "ON",
                    country: "Canada",
                  },
                }),
              },
            ],
          },
        },
      },
    ]);

    const result = await readLocations(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.locations).toHaveLength(2);
    expect(result.data.locations[0]).toEqual({
      locationId: "gid://shopify/Location/1",
      name: "Vancouver Warehouse",
      isActive: true,
      fulfillsOnlineOrders: true,
      city: "Vancouver",
      province: "BC",
      country: "Canada",
    });
    expect(result.data.locations[1].name).toBe("Toronto Shop");
  });

  it("default `first` is 20 when input is empty", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { locations: { edges: [] } } },
    ]);
    await readLocations(admin, {});
    expect(admin.calls[0].variables).toEqual({ first: 20 });
  });

  it("respects custom `first` value within bounds", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { locations: { edges: [] } } },
    ]);
    await readLocations(admin, { first: 5 });
    expect(admin.calls[0].variables).toEqual({ first: 5 });
  });

  it("rejects `first: 0` via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await readLocations(admin, { first: 0 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("rejects `first` above 50 via Zod", async () => {
    const admin = fakeAdmin([]);
    const result = await readLocations(admin, { first: 51 });
    expect(result.ok).toBe(false);
    expect(admin.calls).toHaveLength(0);
  });

  it("handles location with null address fields gracefully", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          locations: {
            edges: [
              {
                node: locationNode({
                  address: { city: null, province: null, country: null },
                }),
              },
            ],
          },
        },
      },
    ]);
    const result = await readLocations(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.locations[0].city).toBeNull();
    expect(result.data.locations[0].province).toBeNull();
    expect(result.data.locations[0].country).toBeNull();
  });

  it("handles fully-missing address (null address object)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          locations: {
            edges: [{ node: locationNode({ address: null }) }],
          },
        },
      },
    ]);
    const result = await readLocations(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.locations[0].city).toBeNull();
  });

  it("returns empty list when shop has no locations", async () => {
    const admin = fakeAdmin([
      { kind: "data", body: { locations: { edges: [] } } },
    ]);
    const result = await readLocations(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.locations).toEqual([]);
  });

  it("surfaces graphql errors verbatim", async () => {
    const admin = fakeAdmin([
      { kind: "errors", errors: [{ message: "ACCESS_DENIED" }] },
    ]);
    const result = await readLocations(admin, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ACCESS_DENIED");
  });

  it("inactive locations are surfaced (not filtered)", async () => {
    const admin = fakeAdmin([
      {
        kind: "data",
        body: {
          locations: {
            edges: [
              { node: locationNode({ isActive: false }) },
              { node: locationNode({ id: "gid://shopify/Location/2" }) },
            ],
          },
        },
      },
    ]);
    const result = await readLocations(admin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.locations).toHaveLength(2);
    expect(result.data.locations[0].isActive).toBe(false);
  });
});
