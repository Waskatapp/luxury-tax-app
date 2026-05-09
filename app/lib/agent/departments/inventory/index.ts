import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type { DepartmentSpec, ToolHandler } from "../department-spec";

import {
  adjustInventoryQuantityHandler,
  readInventoryLevelsHandler,
  readLocationsHandler,
  setInventoryQuantityHandler,
  setInventoryTrackingHandler,
  transferInventoryHandler,
} from "./handlers";
import { loadRaw } from "../../load-raw.server";
const INVENTORY_PROMPT = loadRaw(import.meta.url, "./prompt.md");

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

// ----------------------------------------------------------------------------
// V-Inv-B — Quantity mutations. Three writes, three risk profiles:
//   - adjust (relative delta)   — MEDIUM-risk; reversible by opposite-sign adjust
//   - set    (absolute)         — HIGH-risk;   destructive; requires referenceDocumentUri
//   - transfer (paired delta)   — MEDIUM-risk; atomic single-call between two locations
// ----------------------------------------------------------------------------

const adjustInventoryQuantityDeclaration: FunctionDeclaration = {
  name: "adjust_inventory_quantity",
  description:
    "Adjust the available quantity of an inventory item at a specific location by a relative DELTA. **REQUIRES HUMAN APPROVAL.** Use for 'received 10 more Cat Food at Vancouver' (+10) / 'wrote off 3 damaged units' (-3) / 'correction: was off by 2'.\n\nThe merchant must provide the `inventoryItemId` (from `read_inventory_levels`), `locationId` (from `read_locations`), and `delta` (signed integer; non-zero). Pass `reason` as one of Shopify's documented values — don't invent freeform reasons (Shopify will reject them server-side).\n\nSurfaces the post-adjustment per-location snapshot in the result so the merchant sees the new available count immediately.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      inventoryItemId: {
        type: "string",
        description:
          "InventoryItem GID. Get from read_inventory_levels — every variant in that result includes its inventoryItemId.",
      },
      locationId: {
        type: "string",
        description:
          "Location GID. Get from read_locations — match by location name to the merchant's words ('the warehouse' → Vancouver Warehouse, etc.).",
      },
      delta: {
        type: "integer",
        description:
          "Signed integer, non-zero. Positive = receiving stock (+10); negative = removing stock (-3). Zero is rejected (no-op writes pollute the audit trail).",
      },
      reason: {
        type: "string",
        enum: [
          "correction",
          "cycle_count_available",
          "damaged",
          "received",
          "movement_created",
          "movement_updated",
          "movement_received",
          "movement_canceled",
          "other",
        ],
        description:
          "Why the adjustment happened. `correction` (default) for fix-it-up edits; `received` for inbound shipments; `damaged` for write-offs; `cycle_count_available` for inventory audits where a delta is the right shape (use set_inventory_quantity if the merchant counted to an absolute number); `movement_*` for stock-movement events; `other` as catch-all.",
      },
      referenceDocumentUri: {
        type: "string",
        description:
          "Optional audit document — e.g., shipment number, internal cycle-count ticket id, signed PDF URL. Up to 255 chars.",
      },
    },
    required: ["inventoryItemId", "locationId", "delta"],
  },
};

const setInventoryQuantityDeclaration: FunctionDeclaration = {
  name: "set_inventory_quantity",
  description:
    "Set the available quantity of an inventory item at a specific location to an ABSOLUTE value. **REQUIRES HUMAN APPROVAL.** Use ONLY when the merchant explicitly says 'set to X' / 'I just counted, we have exactly Y' / 'cycle count says Z'. Higher risk than `adjust_inventory_quantity` — destructive: any concurrent in-flight orders or stock movements between the merchant's count and our mutation are overwritten.\n\n**Required: `referenceDocumentUri`** — a non-empty audit identifier (cycle-count number, PDF URL, internal ticket id). Shopify's API requires it on this mutation; we Zod-enforce it pre-mutation so the merchant gets a clean error. Don't fabricate a placeholder — ask the merchant if they don't supply one, or use `adjust_inventory_quantity` instead.\n\nIf the merchant said 'add 10' or 'subtract 3', use `adjust_inventory_quantity` (relative delta) — set is only for cycle counts and absolute corrections.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      inventoryItemId: {
        type: "string",
        description: "InventoryItem GID. Get from read_inventory_levels.",
      },
      locationId: {
        type: "string",
        description: "Location GID. Get from read_locations.",
      },
      quantity: {
        type: "integer",
        minimum: 0,
        description:
          "The new ABSOLUTE available quantity. Non-negative integer. Use 0 to mark the item out of stock at this location.",
      },
      reason: {
        type: "string",
        enum: ["correction", "cycle_count_available", "received", "other"],
        description:
          "Why the absolute set is being applied. `cycle_count_available` is the most common (the merchant just counted). `correction` for known-bad-data fixes. `received` for inbound where the merchant confirms the arrival count. `other` as catch-all.",
      },
      referenceDocumentUri: {
        type: "string",
        description:
          "REQUIRED non-empty audit identifier. Up to 255 chars. Examples: 'cycle-count-2026-05-09', 'https://merchant-files.example.com/receipt-1234.pdf', 'internal-ticket-987'. The merchant should supply something traceable — if they don't, ask before proposing the write.",
      },
    },
    required: [
      "inventoryItemId",
      "locationId",
      "quantity",
      "reason",
      "referenceDocumentUri",
    ],
  },
};

const transferInventoryDeclaration: FunctionDeclaration = {
  name: "transfer_inventory",
  description:
    "Transfer available stock of one inventory item from one location to another. **REQUIRES HUMAN APPROVAL.** Atomic single-call: under the hood it's ONE Shopify mutation with two paired deltas (-quantity at `from`, +quantity at `to`). Partial transfers are impossible — the whole transfer happens or nothing happens.\n\nDefensive pre-flight: the handler verifies the `from` location actually has at least `quantity` available BEFORE issuing the mutation. Refuses with a clear local error if the transfer would drive the source negative — friendlier than letting Shopify return a generic error.\n\n**Use when the merchant explicitly says 'move X from Y to Z' / 'transfer Y units to Z' / 'shift inventory from one location to another'.** For receiving / writing off / counting, use `adjust_inventory_quantity` or `set_inventory_quantity` instead.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      inventoryItemId: {
        type: "string",
        description: "InventoryItem GID. Get from read_inventory_levels.",
      },
      fromLocationId: {
        type: "string",
        description:
          "Source location GID. Stock will be DECREMENTED here. Get from read_locations.",
      },
      toLocationId: {
        type: "string",
        description:
          "Destination location GID. Stock will be INCREMENTED here. Must differ from fromLocationId — Zod refine rejects equal values.",
      },
      quantity: {
        type: "integer",
        minimum: 1,
        description:
          "Positive integer. The number of units to move from `from` to `to`. Pre-flight check refuses if from.available < quantity.",
      },
      reason: {
        type: "string",
        enum: ["movement_created", "movement_updated", "other"],
        description:
          "Reason for the movement. `movement_created` (default) is correct for most transfers. Use `movement_updated` if you're correcting a previously-recorded transfer; `other` as catch-all.",
      },
      referenceDocumentUri: {
        type: "string",
        description:
          "Optional audit document — internal transfer ticket id, signed PDF URL, etc. Up to 255 chars.",
      },
    },
    required: ["inventoryItemId", "fromLocationId", "toLocationId", "quantity"],
  },
};

const INVENTORY_SPEC: DepartmentSpec = {
  id: "inventory",
  label: "Inventory",
  managerTitle: "Inventory manager",
  description:
    "Owns multi-location stock state — listing fulfillment locations, " +
    "reading per-variant stock across locations (with sku / barcode / " +
    "tracked flag / inventoryItemId), toggling whether Shopify tracks " +
    "inventory for a given item, and mutating quantities: adjust " +
    "(relative delta), set (absolute, audit-grade with referenceDocumentUri), " +
    "and transfer (paired delta between two locations, atomic single-call).",
  systemPrompt: INVENTORY_PROMPT,
  toolDeclarations: [
    readLocationsDeclaration,
    readInventoryLevelsDeclaration,
    setInventoryTrackingDeclaration,
    adjustInventoryQuantityDeclaration,
    setInventoryQuantityDeclaration,
    transferInventoryDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["read_locations", readLocationsHandler],
    ["read_inventory_levels", readInventoryLevelsHandler],
    ["set_inventory_tracking", setInventoryTrackingHandler],
    ["adjust_inventory_quantity", adjustInventoryQuantityHandler],
    ["set_inventory_quantity", setInventoryQuantityHandler],
    ["transfer_inventory", transferInventoryHandler],
  ]),
  classification: {
    read: new Set(["read_locations", "read_inventory_levels"]),
    write: new Set([
      "set_inventory_tracking",
      "adjust_inventory_quantity",
      "set_inventory_quantity",
      "transfer_inventory",
    ]),
    inlineWrite: new Set(),
  },
};

registerDepartment(INVENTORY_SPEC);

export { INVENTORY_SPEC };
