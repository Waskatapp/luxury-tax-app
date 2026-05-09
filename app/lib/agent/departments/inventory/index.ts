import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type { DepartmentSpec, ToolHandler } from "../department-spec";

import {
  readInventoryLevelsHandler,
  readLocationsHandler,
  setInventoryTrackingHandler,
} from "./handlers";
import INVENTORY_PROMPT from "./prompt.md?raw";

// V-Inv-A — Phase Inventory & Operations Round A. Seventh domain
// department after Orders (shipped 2026-05-04). Round A is reads + a
// single low-risk write (set_inventory_tracking — a flag toggle that
// affects no quantities). Round B adds the three quantity-mutating
// writes (adjust / set / transfer) — those land with their own
// dedicated risk patterns.
//
// Round A ships ZERO scope friction: read_inventory + write_inventory
// are already in shopify.app.toml from Insights Phase 3.

const readLocationsDeclaration: FunctionDeclaration = {
  name: "read_locations",
  description:
    "List the store's fulfillment locations. Returns one row per location with id, name, isActive, fulfillsOnlineOrders, and city/province/country.\n\n**Essential first step before any quantity-mutating inventory write.** Every Inventory write tool requires a `locationId`, which the merchant doesn't have memorized. Call this once at the start of an inventory workflow to discover the locations; the agent picks the right one based on the merchant's words ('the warehouse', 'Vancouver', 'main shop').\n\nMost stores have 1-5 locations. Use `first: 50` only if the merchant explicitly mentions a multi-warehouse setup.\n\nUse this for 'show me my locations' / 'where do I ship from?' / as a prerequisite for any inventory adjustment. Read-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      first: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description:
          "Max locations to return. Defaults to 20. Most stores have <5; bump only for known multi-warehouse merchants.",
      },
    },
  },
};

const readInventoryLevelsDeclaration: FunctionDeclaration = {
  name: "read_inventory_levels",
  description:
    "Per-location stock for one or more variants. Returns per-variant: variantId, productTitle, variantTitle, sku, barcode, tracked flag, inventoryItemId, AND a perLocation list (locationId, locationName, available quantity).\n\n**Requires variantIds** (`gid://shopify/ProductVariant/...`). Get those from `read_products` via the Products department. Don't fabricate variant IDs.\n\nUse for 'how much stock do I have on Cat Food?' / 'where's my Cat Food inventory?' / 'is the Snowboard in stock at Toronto?'. Batched — pass up to 20 variantIds in one call. Returns the inventoryItemId per variant — the agent uses that for any subsequent quantity write.\n\nRead-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      variantIds: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 20,
        description:
          "Variant GIDs to look up. Get these from a read_products call first if you don't already have them. 1-20 in one call.",
      },
    },
    required: ["variantIds"],
  },
};

const setInventoryTrackingDeclaration: FunctionDeclaration = {
  name: "set_inventory_tracking",
  description:
    "Enable or disable Shopify inventory tracking for an inventory item. **REQUIRES HUMAN APPROVAL.** Low-risk: this only flips a boolean — no quantities change. Genuine gap that update_variant in the Products dept does NOT cover, so it lives here.\n\nUse for 'enable tracking on the new Snowboard variant' / 'stop tracking inventory on this digital download' / 'turn on stock tracking for my SKUs'. The merchant must provide the inventoryItemId — get it from a `read_inventory_levels` call first.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      inventoryItemId: {
        type: "string",
        description:
          "InventoryItem GID, e.g. gid://shopify/InventoryItem/12345. Get this from read_inventory_levels — every variant in that result includes its inventoryItemId.",
      },
      tracked: {
        type: "boolean",
        description:
          "true to enable inventory tracking; false to disable. The merchant should explicitly say 'enable' or 'disable' / 'turn on' or 'turn off' — don't infer from soft phrasing.",
      },
    },
    required: ["inventoryItemId", "tracked"],
  },
};

const INVENTORY_SPEC: DepartmentSpec = {
  id: "inventory",
  label: "Inventory",
  managerTitle: "Inventory manager",
  description:
    "Owns multi-location stock state — listing fulfillment locations, " +
    "reading per-variant stock across locations (with sku / barcode / " +
    "tracked flag / inventoryItemId), and toggling whether Shopify " +
    "tracks inventory for a given item. Round B adds quantity " +
    "mutations: adjust (relative delta), set (absolute, audit-grade " +
    "with referenceDocumentUri), and transfer (paired delta between " +
    "two locations, atomic single-call).",
  systemPrompt: INVENTORY_PROMPT,
  toolDeclarations: [
    readLocationsDeclaration,
    readInventoryLevelsDeclaration,
    setInventoryTrackingDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["read_locations", readLocationsHandler],
    ["read_inventory_levels", readInventoryLevelsHandler],
    ["set_inventory_tracking", setInventoryTrackingHandler],
  ]),
  classification: {
    read: new Set(["read_locations", "read_inventory_levels"]),
    write: new Set(["set_inventory_tracking"]),
    inlineWrite: new Set(),
  },
};

registerDepartment(INVENTORY_SPEC);

export { INVENTORY_SPEC };
