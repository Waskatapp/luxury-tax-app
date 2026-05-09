// V-Inv-A — Inventory & Operations department core. Reads + low-risk
// tracking-flag write in Round A; quantity mutations (adjust / set /
// transfer) added in Round B.
//
// Single canonical snapshot: fetchInventoryLevels(admin, inventoryItemId)
// is the shape returned by snapshotBefore() for every inventory write
// tool — same pattern as Orders' fetchOrderDetail and Customers'
// fetchCustomerDetail. One query, one shape, no per-tool drift.
//
// readInventoryLevels takes variantIds (merchant convenience — the
// merchant has variants, not inventoryItems) and resolves each via the
// productVariant(id:) → inventoryItem path. The snapshot helper for
// write tools takes inventoryItemId directly because every Round B
// inventory mutation receives inventoryItemId in scope.
//
// Scopes: read_inventory + write_inventory (already in shopify.app.toml
// from Insights Phase 3). Round Inv-A ships with ZERO scope friction.

import { z } from "zod";

import { graphqlRequest, type ShopifyAdmin } from "./graphql-client.server";

export type ToolModuleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ----------------------------------------------------------------------------
// Snapshot shapes
// ----------------------------------------------------------------------------

export type LocationSummary = {
  locationId: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  city: string | null;
  province: string | null;
  country: string | null;
};

export type ReadLocationsResult = {
  locations: LocationSummary[];
};

export type InventoryLevelAtLocation = {
  locationId: string;
  locationName: string;
  available: number;
};

// One canonical shape for "what's the state of this variant's inventory."
// Returned by both readInventoryLevels (per-variant entries) and
// fetchInventoryLevels (single-snapshot for write tools).
export type VariantInventoryLevels = {
  variantId: string | null; // null when fetched via inventoryItem and the variant pointer is missing
  productId: string | null;
  productTitle: string;
  variantTitle: string | null;
  inventoryItemId: string | null;
  sku: string | null;
  barcode: string | null;
  tracked: boolean;
  perLocation: InventoryLevelAtLocation[];
};

export type ReadInventoryLevelsResult = {
  variants: VariantInventoryLevels[];
};

export type SetInventoryTrackingResult = {
  inventoryItemId: string;
  tracked: boolean;
  sku: string | null;
};

// ----------------------------------------------------------------------------
// Input schemas
// ----------------------------------------------------------------------------

export const ReadLocationsInput = z.object({
  first: z.number().int().min(1).max(50).default(20),
});

export const ReadInventoryLevelsInput = z.object({
  variantIds: z.array(z.string().min(1)).min(1).max(20),
});

export const SetInventoryTrackingInput = z.object({
  inventoryItemId: z.string().min(1),
  tracked: z.boolean(),
});

// V-Inv-B — Quantity mutations. Three writes covering the three real
// merchant intents:
//   - adjust_inventory_quantity: relative delta (+10 / -3) — most common
//   - set_inventory_quantity: absolute set (cycle count) — audit-grade,
//     requires referenceDocumentUri (Zod-required, non-empty)
//   - transfer_inventory: paired delta between two locations — atomic
//     single-call (one inventoryAdjustQuantities call with two change
//     entries); pre-flight from-quantity check in the handler before
//     the mutation fires
//
// Reason enums: each tool has its own subset of Shopify's documented
// values. adjust accepts the broadest set (correction / cycle count /
// damaged / received / movement-* / other); set is narrower (correction /
// cycle count / received / other — set is more deliberate); transfer is
// narrowest (movement_* / other — semantically a movement).

const ADJUST_REASONS = [
  "correction",
  "cycle_count_available",
  "damaged",
  "received",
  "movement_created",
  "movement_updated",
  "movement_received",
  "movement_canceled",
  "other",
] as const;

const SET_REASONS = [
  "correction",
  "cycle_count_available",
  "received",
  "other",
] as const;

const TRANSFER_REASONS = [
  "movement_created",
  "movement_updated",
  "other",
] as const;

const REFERENCE_DOC_MAX = 255;

export const AdjustInventoryQuantityInput = z.object({
  inventoryItemId: z.string().min(1),
  locationId: z.string().min(1),
  // Integer delta. Reject 0 (no-op writes pollute the audit trail).
  // Negative is allowed (writing off damaged stock, etc.).
  delta: z
    .number()
    .int()
    .refine((n) => n !== 0, { message: "delta must be non-zero" }),
  reason: z.enum(ADJUST_REASONS).default("correction"),
  referenceDocumentUri: z.string().min(1).max(REFERENCE_DOC_MAX).optional(),
});

export const SetInventoryQuantityInput = z.object({
  inventoryItemId: z.string().min(1),
  locationId: z.string().min(1),
  quantity: z.number().int().min(0),
  reason: z.enum(SET_REASONS),
  // REQUIRED on set (audit trail non-negotiable; Shopify's API also
  // requires it on inventorySetQuantities). The merchant must provide
  // a meaningful identifier — internal cycle-count number, signed PDF
  // URL, etc.
  referenceDocumentUri: z.string().min(1).max(REFERENCE_DOC_MAX),
});

export const TransferInventoryInput = z
  .object({
    inventoryItemId: z.string().min(1),
    fromLocationId: z.string().min(1),
    toLocationId: z.string().min(1),
    quantity: z.number().int().positive(),
    reason: z.enum(TRANSFER_REASONS).default("movement_created"),
    referenceDocumentUri: z.string().min(1).max(REFERENCE_DOC_MAX).optional(),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, {
    message:
      "fromLocationId and toLocationId must differ — to transfer in place is a no-op",
    path: ["toLocationId"],
  });

// ----------------------------------------------------------------------------
// GraphQL
// ----------------------------------------------------------------------------

const READ_LOCATIONS_QUERY = `#graphql
  query ReadLocations($first: Int!) {
    locations(first: $first) {
      edges {
        node {
          id
          name
          isActive
          fulfillsOnlineOrders
          address { city province country }
        }
      }
    }
  }
`;

// Variant-rooted query: used by readInventoryLevels. The merchant has
// variantIds (from read_products); we resolve each to its inventoryItem
// + per-location levels in a single query per variant.
const FETCH_VARIANT_INVENTORY_QUERY = `#graphql
  query FetchVariantInventory($id: ID!) {
    productVariant(id: $id) {
      id
      title
      barcode
      product { id title }
      inventoryItem {
        id
        sku
        tracked
        inventoryLevels(first: 50) {
          edges {
            node {
              location { id name }
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

// InventoryItem-rooted query: used by fetchInventoryLevels (the snapshot
// helper for write tools). Every Round B inventory mutation operates on
// inventoryItemId, so the canonical snapshot starts there. The variant
// pointer is included so the AuditLog before-state has merchant-readable
// product context.
const FETCH_INVENTORY_BY_ITEM_QUERY = `#graphql
  query FetchInventoryByItem($id: ID!) {
    inventoryItem(id: $id) {
      id
      sku
      tracked
      variant {
        id
        title
        barcode
        product { id title }
      }
      inventoryLevels(first: 50) {
        edges {
          node {
            location { id name }
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
        }
      }
    }
  }
`;

const INVENTORY_ITEM_UPDATE_MUTATION = `#graphql
  mutation InventoryItemUpdate($id: ID!, $input: InventoryItemUpdateInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem {
        id
        tracked
        sku
      }
      userErrors { field message }
    }
  }
`;

// V-Inv-B — inventoryAdjustQuantities. Used by BOTH adjustInventoryQuantity
// (one change entry) AND transferInventory (two change entries — one
// negative delta on fromLocation, one positive delta on toLocation).
// Atomic by design: Shopify processes the entire `changes` array as a
// single transaction. Partial application is impossible.
const INVENTORY_ADJUST_QUANTITIES_MUTATION = `#graphql
  mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }
`;

// V-Inv-B — inventorySetQuantities. Used by setInventoryQuantity for
// absolute (cycle-count-style) writes. Shopify REQUIRES referenceDocumentUri
// on this mutation; we Zod-require it on the input too.
//
// ignoreCompareQuantity: true skips Shopify's optional CAS check (which
// would require us to pass compareQuantity = the prior value). v1 doesn't
// do CAS — the snapshotBefore + ApprovalCard pattern already shows the
// merchant the current state before approval, which is the human-in-the-
// loop equivalent.
const INVENTORY_SET_QUANTITIES_MUTATION = `#graphql
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }
`;

// ----------------------------------------------------------------------------
// GraphQL response types
// ----------------------------------------------------------------------------

type LocationNode = {
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  address: {
    city: string | null;
    province: string | null;
    country: string | null;
  } | null;
};

type ReadLocationsResponse = {
  locations: { edges: Array<{ node: LocationNode }> };
};

type InventoryLevelEdge = {
  node: {
    location: { id: string; name: string };
    quantities: Array<{ name: string; quantity: number }>;
  };
};

type VariantInventoryNode = {
  id: string;
  title: string | null;
  barcode: string | null;
  product: { id: string; title: string } | null;
  inventoryItem: {
    id: string;
    sku: string | null;
    tracked: boolean;
    inventoryLevels: { edges: InventoryLevelEdge[] };
  } | null;
};

type FetchVariantInventoryResponse = {
  productVariant: VariantInventoryNode | null;
};

type InventoryItemNode = {
  id: string;
  sku: string | null;
  tracked: boolean;
  variant: {
    id: string;
    title: string | null;
    barcode: string | null;
    product: { id: string; title: string } | null;
  } | null;
  inventoryLevels: { edges: InventoryLevelEdge[] };
};

type FetchInventoryByItemResponse = {
  inventoryItem: InventoryItemNode | null;
};

type InventoryItemUpdateResponse = {
  inventoryItemUpdate: {
    inventoryItem: { id: string; tracked: boolean; sku: string | null } | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
};

type InventoryAdjustQuantitiesResponse = {
  inventoryAdjustQuantities: {
    inventoryAdjustmentGroup: { id: string } | null;
    userErrors: Array<{ field?: string[]; message: string; code?: string }>;
  };
};

type InventorySetQuantitiesResponse = {
  inventorySetQuantities: {
    inventoryAdjustmentGroup: { id: string } | null;
    userErrors: Array<{ field?: string[]; message: string; code?: string }>;
  };
};

// ----------------------------------------------------------------------------
// Mappers
// ----------------------------------------------------------------------------

function locationNodeToSummary(node: LocationNode): LocationSummary {
  return {
    locationId: node.id,
    name: node.name,
    isActive: node.isActive,
    fulfillsOnlineOrders: node.fulfillsOnlineOrders,
    city: node.address?.city ?? null,
    province: node.address?.province ?? null,
    country: node.address?.country ?? null,
  };
}

function levelEdgesToPerLocation(
  edges: InventoryLevelEdge[],
): InventoryLevelAtLocation[] {
  return edges.map((e) => ({
    locationId: e.node.location.id,
    locationName: e.node.location.name,
    available:
      e.node.quantities.find((q) => q.name === "available")?.quantity ?? 0,
  }));
}

// Variant-rooted → canonical snapshot. Used by readInventoryLevels.
// If the variant has no inventoryItem (rare — usually means an
// out-of-band data setup issue), surface a slim "untracked" shape so
// the merchant sees the variant exists but has no stock signal.
function variantNodeToInventoryLevels(
  node: VariantInventoryNode,
): VariantInventoryLevels {
  if (!node.inventoryItem) {
    return {
      variantId: node.id,
      productId: node.product?.id ?? null,
      productTitle: node.product?.title ?? "",
      variantTitle: node.title,
      inventoryItemId: null,
      sku: null,
      barcode: node.barcode,
      tracked: false,
      perLocation: [],
    };
  }
  return {
    variantId: node.id,
    productId: node.product?.id ?? null,
    productTitle: node.product?.title ?? "",
    variantTitle: node.title,
    inventoryItemId: node.inventoryItem.id,
    sku: node.inventoryItem.sku,
    barcode: node.barcode,
    tracked: node.inventoryItem.tracked,
    perLocation: levelEdgesToPerLocation(node.inventoryItem.inventoryLevels.edges),
  };
}

// InventoryItem-rooted → canonical snapshot. Used by fetchInventoryLevels.
function itemNodeToInventoryLevels(
  node: InventoryItemNode,
): VariantInventoryLevels {
  return {
    variantId: node.variant?.id ?? null,
    productId: node.variant?.product?.id ?? null,
    productTitle: node.variant?.product?.title ?? "",
    variantTitle: node.variant?.title ?? null,
    inventoryItemId: node.id,
    sku: node.sku,
    barcode: node.variant?.barcode ?? null,
    tracked: node.tracked,
    perLocation: levelEdgesToPerLocation(node.inventoryLevels.edges),
  };
}

// ----------------------------------------------------------------------------
// fetchInventoryLevels — canonical snapshot helper for write tools.
// Used by snapshotBefore() in executor.server.ts for every inventory
// write. Single source of truth for "what's the inventory state of this
// item right now."
// ----------------------------------------------------------------------------

export async function fetchInventoryLevels(
  admin: ShopifyAdmin,
  inventoryItemId: string,
): Promise<ToolModuleResult<VariantInventoryLevels>> {
  const result = await graphqlRequest<FetchInventoryByItemResponse>(
    admin,
    FETCH_INVENTORY_BY_ITEM_QUERY,
    { id: inventoryItemId },
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!result.data.inventoryItem) {
    return {
      ok: false,
      error: `inventory item not found: ${inventoryItemId}`,
    };
  }
  return { ok: true, data: itemNodeToInventoryLevels(result.data.inventoryItem) };
}

// ----------------------------------------------------------------------------
// readLocations — list shop fulfillment locations. Essential for the
// agent: every quantity-mutating write in Round B requires a locationId,
// and rule 24 forbids asking the merchant for IDs they don't have.
// ----------------------------------------------------------------------------

export async function readLocations(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadLocationsResult>> {
  const parsed = ReadLocationsInput.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<ReadLocationsResponse>(
    admin,
    READ_LOCATIONS_QUERY,
    { first: parsed.data.first },
  );
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    data: {
      locations: result.data.locations.edges.map((e) =>
        locationNodeToSummary(e.node),
      ),
    },
  };
}

// ----------------------------------------------------------------------------
// readInventoryLevels — multi-variant batched read. Takes variantIds
// (merchant-friendly: they have those from read_products) and runs
// per-variant productVariant(id:) queries in parallel. Each query
// returns the variant + its inventoryItem + per-location levels in one
// roundtrip. Surfaces the FIRST error and returns it (rule 4: never
// throw, always return a result).
// ----------------------------------------------------------------------------

export async function readInventoryLevels(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<ReadInventoryLevelsResult>> {
  const parsed = ReadInventoryLevelsInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const results = await Promise.all(
    parsed.data.variantIds.map((id) =>
      graphqlRequest<FetchVariantInventoryResponse>(
        admin,
        FETCH_VARIANT_INVENTORY_QUERY,
        { id },
      ),
    ),
  );

  const variants: VariantInventoryLevels[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.data.productVariant) {
      return {
        ok: false,
        error: `variant not found: ${parsed.data.variantIds[i]}`,
      };
    }
    variants.push(variantNodeToInventoryLevels(r.data.productVariant));
  }

  return { ok: true, data: { variants } };
}

// ----------------------------------------------------------------------------
// setInventoryTracking — toggle whether Shopify tracks inventory for
// this item. Genuine gap: Products' update_variant doesn't expose
// inventoryItem.tracked. Low-risk: flips a boolean; no quantities
// change.
// ----------------------------------------------------------------------------

export async function setInventoryTracking(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<SetInventoryTrackingResult>> {
  const parsed = SetInventoryTrackingInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<InventoryItemUpdateResponse>(
    admin,
    INVENTORY_ITEM_UPDATE_MUTATION,
    {
      id: parsed.data.inventoryItemId,
      input: { tracked: parsed.data.tracked },
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.inventoryItemUpdate.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  if (!result.data.inventoryItemUpdate.inventoryItem) {
    return {
      ok: false,
      error: "inventoryItemUpdate returned no inventoryItem",
    };
  }

  const item = result.data.inventoryItemUpdate.inventoryItem;
  return {
    ok: true,
    data: {
      inventoryItemId: item.id,
      tracked: item.tracked,
      sku: item.sku,
    },
  };
}

// ----------------------------------------------------------------------------
// V-Inv-B — adjustInventoryQuantity. Relative delta. The most-used
// quantity write — "received 10 more" / "wrote off 3 damaged units" /
// "correction: was off by 2." Returns the post-mutation snapshot via
// fetchInventoryLevels so the result + AuditLog after-state share the
// canonical VariantInventoryLevels shape.
// ----------------------------------------------------------------------------

export async function adjustInventoryQuantity(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<VariantInventoryLevels>> {
  const parsed = AdjustInventoryQuantityInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const input: Record<string, unknown> = {
    name: "available",
    reason: parsed.data.reason,
    changes: [
      {
        inventoryItemId: parsed.data.inventoryItemId,
        locationId: parsed.data.locationId,
        delta: parsed.data.delta,
      },
    ],
  };
  if (parsed.data.referenceDocumentUri !== undefined) {
    input.referenceDocumentUri = parsed.data.referenceDocumentUri;
  }

  const result = await graphqlRequest<InventoryAdjustQuantitiesResponse>(
    admin,
    INVENTORY_ADJUST_QUANTITIES_MUTATION,
    { input },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.inventoryAdjustQuantities.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  if (!result.data.inventoryAdjustQuantities.inventoryAdjustmentGroup) {
    return {
      ok: false,
      error: "inventoryAdjustQuantities returned no adjustmentGroup",
    };
  }

  return fetchInventoryLevels(admin, parsed.data.inventoryItemId);
}

// ----------------------------------------------------------------------------
// V-Inv-B — setInventoryQuantity. Absolute (cycle-count) write. The
// merchant just counted the shelf and wants the system to match. Higher
// risk than adjust — destructive: any concurrent in-flight orders / stock
// movements between the merchant's count and our mutation would be lost.
//
// Defensive design:
//   - Zod requires non-empty referenceDocumentUri (audit trail). Shopify's
//     API also requires it on inventorySetQuantities, but we enforce it
//     pre-mutation so the merchant gets a clear error rather than a
//     server-side rejection.
//   - The CEO orchestrator pattern (snapshotBefore captures pre-state in
//     AuditLog before approval) means the merchant sees current → new in
//     the ApprovalCard before approving — they can reject if reality
//     drifted from their mental model.
//   - ignoreCompareQuantity: true skips CAS — we trust the merchant's
//     human-in-the-loop confirmation as the equivalent gate.
// ----------------------------------------------------------------------------

export async function setInventoryQuantity(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<VariantInventoryLevels>> {
  const parsed = SetInventoryQuantityInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  const result = await graphqlRequest<InventorySetQuantitiesResponse>(
    admin,
    INVENTORY_SET_QUANTITIES_MUTATION,
    {
      input: {
        name: "available",
        reason: parsed.data.reason,
        ignoreCompareQuantity: true,
        quantities: [
          {
            inventoryItemId: parsed.data.inventoryItemId,
            locationId: parsed.data.locationId,
            quantity: parsed.data.quantity,
          },
        ],
        referenceDocumentUri: parsed.data.referenceDocumentUri,
      },
    },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.inventorySetQuantities.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  if (!result.data.inventorySetQuantities.inventoryAdjustmentGroup) {
    return {
      ok: false,
      error: "inventorySetQuantities returned no adjustmentGroup",
    };
  }

  return fetchInventoryLevels(admin, parsed.data.inventoryItemId);
}

// ----------------------------------------------------------------------------
// V-Inv-B — transferInventory. Move stock between two locations. Atomic
// single-call: ONE inventoryAdjustQuantities call with TWO change entries
// (one negative delta on `from`, one positive delta on `to`). Shopify
// processes the changes array as a single transaction — partial transfer
// is impossible by construction.
//
// Defensive pre-flight: handler fetches current state via
// fetchInventoryLevels FIRST, verifies the `from` location has at least
// `quantity` available, AND verifies the location actually exists for
// this inventory item. Surfaces a clean local error before the mutation
// fires — friendlier than letting Shopify return a generic "negative
// quantity" error after the fact.
// ----------------------------------------------------------------------------

export async function transferInventory(
  admin: ShopifyAdmin,
  rawInput: unknown,
): Promise<ToolModuleResult<VariantInventoryLevels>> {
  const parsed = TransferInventoryInput.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `invalid input: ${parsed.error.message}` };
  }

  // Pre-flight gate — fetch current state, verify from-location validity
  // + sufficient available quantity.
  const snap = await fetchInventoryLevels(admin, parsed.data.inventoryItemId);
  if (!snap.ok) return snap;

  const fromLevel = snap.data.perLocation.find(
    (l) => l.locationId === parsed.data.fromLocationId,
  );
  if (!fromLevel) {
    return {
      ok: false,
      error: `from location ${parsed.data.fromLocationId} has no inventory level for this item — call read_inventory_levels first to confirm the location is valid`,
    };
  }
  if (fromLevel.available < parsed.data.quantity) {
    return {
      ok: false,
      error: `transfer would drive ${fromLevel.locationName} negative — current available: ${fromLevel.available}, requested transfer: ${parsed.data.quantity}`,
    };
  }

  // Atomic single-call paired delta.
  const input: Record<string, unknown> = {
    name: "available",
    reason: parsed.data.reason,
    changes: [
      {
        inventoryItemId: parsed.data.inventoryItemId,
        locationId: parsed.data.fromLocationId,
        delta: -parsed.data.quantity,
      },
      {
        inventoryItemId: parsed.data.inventoryItemId,
        locationId: parsed.data.toLocationId,
        delta: parsed.data.quantity,
      },
    ],
  };
  if (parsed.data.referenceDocumentUri !== undefined) {
    input.referenceDocumentUri = parsed.data.referenceDocumentUri;
  }

  const result = await graphqlRequest<InventoryAdjustQuantitiesResponse>(
    admin,
    INVENTORY_ADJUST_QUANTITIES_MUTATION,
    { input },
  );
  if (!result.ok) return { ok: false, error: result.error };

  const errors = result.data.inventoryAdjustQuantities.userErrors;
  if (errors.length > 0) {
    return {
      ok: false,
      error: `shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  if (!result.data.inventoryAdjustQuantities.inventoryAdjustmentGroup) {
    return {
      ok: false,
      error: "inventoryAdjustQuantities returned no adjustmentGroup",
    };
  }

  return fetchInventoryLevels(admin, parsed.data.inventoryItemId);
}

// ----------------------------------------------------------------------------
// Test seam — exported only for unit tests.
// ----------------------------------------------------------------------------

export const _testing = {
  READ_LOCATIONS_QUERY,
  FETCH_VARIANT_INVENTORY_QUERY,
  FETCH_INVENTORY_BY_ITEM_QUERY,
  INVENTORY_ITEM_UPDATE_MUTATION,
  INVENTORY_ADJUST_QUANTITIES_MUTATION,
  INVENTORY_SET_QUANTITIES_MUTATION,
  ADJUST_REASONS,
  SET_REASONS,
  TRANSFER_REASONS,
};
