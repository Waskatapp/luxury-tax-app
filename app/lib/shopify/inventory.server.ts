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
// Test seam — exported only for unit tests.
// ----------------------------------------------------------------------------

export const _testing = {
  READ_LOCATIONS_QUERY,
  FETCH_VARIANT_INVENTORY_QUERY,
  FETCH_INVENTORY_BY_ITEM_QUERY,
  INVENTORY_ITEM_UPDATE_MUTATION,
};
