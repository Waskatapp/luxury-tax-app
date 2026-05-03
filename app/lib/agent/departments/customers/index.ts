import type { FunctionDeclaration } from "@google/genai";

import { registerDepartment } from "../registry.server";
import type { DepartmentSpec, ToolHandler } from "../department-spec";

import {
  readCustomerDetailHandler,
  readCustomersHandler,
  readSegmentMembersHandler,
  readSegmentsHandler,
  updateCustomerHandler,
  updateCustomerTagsHandler,
  updateEmailMarketingConsentHandler,
  updateSmsMarketingConsentHandler,
} from "./handlers";
import CUSTOMERS_PROMPT from "./prompt.md?raw";

// V-Cu-A — Phase Customers Round A. Fifth domain department after
// Marketing (shipped 2026-05-02). Owns 6 tools today: read list +
// read detail + identity edit + tag edit + email + SMS marketing
// consent. Round B (deferred until merchant verifies Cu-A) adds
// segments read-only.

const readCustomersDeclaration: FunctionDeclaration = {
  name: "read_customers",
  description:
    "List customers with optional Shopify search syntax. Returns summary fields per customer (id, name, email, phone, account state, lifetime stats, tags, createdAt) — no order history, no consent state (those come from `read_customer_detail`).\n\nSearch syntax examples:\n- `tag:vip` — customers tagged \"vip\"\n- `email:*@cats.com` — customers from a domain\n- `orders_count:>5` — repeat customers\n- `total_spent:>500` — high-value customers\n- bare keywords match name + email\n\nUse this when the merchant asks 'who are my biggest spenders?' / 'list customers tagged X' / 'show me recent signups'. Read-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max customers to return. Defaults to 20.",
      },
      query: {
        type: "string",
        description:
          "Optional Shopify customer search syntax. Bare keywords match name + email; `tag:`, `email:`, `orders_count:`, `total_spent:` for precision.",
      },
    },
  },
};

const readCustomerDetailDeclaration: FunctionDeclaration = {
  name: "read_customer_detail",
  description:
    "Single customer, full picture. Returns identity (firstName/lastName/email/phone/state) + email & SMS marketing consent state + lifetime stats (numberOfOrders, amountSpent) + recent 10 orders + default address + tags + note. **Requires the customerId** (`gid://shopify/Customer/...`).\n\nUse this when the merchant asks 'tell me about X' / 'what does X buy' / 'is X subscribed to email?'. If the task only has a customer NAME or email, call `read_customers` FIRST to get the GID — never fabricate. Read-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      customerId: {
        type: "string",
        description:
          "Customer GID, e.g. gid://shopify/Customer/12345. Get this from a read_customers call first if you only have the name/email.",
      },
    },
    required: ["customerId"],
  },
};

const updateCustomerDeclaration: FunctionDeclaration = {
  name: "update_customer",
  description:
    "Partial identity edit on a single customer. **REQUIRES HUMAN APPROVAL.**\n\nOptional fields: firstName, lastName, email, phone, note. At least ONE field beyond `customerId` must be provided. Tags are NOT updated by this tool — use `update_customer_tags` for tag changes (different semantics: tags is a replacement set, not delta).\n\nUse this for 'fix Cat Lover's email typo' / 'update phone' / 'add a note about wholesale arrangement' type asks.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      customerId: {
        type: "string",
        description:
          "Customer GID. Get this from read_customers if you only have the name.",
      },
      firstName: { type: "string", description: "New first name. Up to 255 chars." },
      lastName: { type: "string", description: "New last name. Up to 255 chars." },
      email: { type: "string", description: "New email address. Validated as a proper email." },
      phone: { type: "string", description: "New phone number. Up to 50 chars; format flexible (E.164 preferred)." },
      note: {
        type: "string",
        description:
          "Admin-only note (visible to the merchant in Shopify admin, not to the customer). Up to 5000 chars.",
      },
    },
    required: ["customerId"],
  },
};

const updateCustomerTagsDeclaration: FunctionDeclaration = {
  name: "update_customer_tags",
  description:
    "Replace the customer's FULL tag list. **REQUIRES HUMAN APPROVAL.** **NOT a delta — REPLACEMENT semantics.**\n\nWorkflow: call `read_customer_detail` first to get the existing tags, append/remove the changes, then propose this tool with the merged final list. Don't propose tag changes without first reading current state — silently dropping the merchant's existing tags is the worst-case outcome.\n\nUse this for 'add the wholesale tag to Cat Lover' / 'tag Cat Lover as VIP' / 'remove the at-risk tag from Cat Lover'.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "Customer GID." },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "FULL replacement tag list. Pass [] to clear all tags (rare — usually you want to merge with existing tags).",
      },
    },
    required: ["customerId", "tags"],
  },
};

const updateEmailMarketingConsentDeclaration: FunctionDeclaration = {
  name: "update_email_marketing_consent",
  description:
    "Set the customer's email-marketing subscription state. **REQUIRES HUMAN APPROVAL.** Recording an email-marketing consent change is a LEGAL COMMITMENT (CAN-SPAM, GDPR, CASL depending on customer jurisdiction).\n\n`subscribed: true` records the customer as SUBSCRIBED to email marketing; `false` records UNSUBSCRIBED. Always send `consentUpdatedAt: now` so audit trails are accurate.\n\n**Only call this when the merchant explicitly asks to subscribe/unsubscribe a SPECIFIC customer.** Never propose bulk consent changes from inferred intent — push back and ask the merchant to confirm one customer at a time.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "Customer GID." },
      subscribed: {
        type: "boolean",
        description:
          "true → SUBSCRIBED, false → UNSUBSCRIBED. Records the consent change with consentUpdatedAt = now.",
      },
    },
    required: ["customerId", "subscribed"],
  },
};

const updateSmsMarketingConsentDeclaration: FunctionDeclaration = {
  name: "update_sms_marketing_consent",
  description:
    "Set the customer's SMS-marketing subscription state. **REQUIRES HUMAN APPROVAL.** SMS marketing is governed by TCPA in the US (and other regimes elsewhere) — separate audit trail from email.\n\nSame `subscribed: bool` shape as `update_email_marketing_consent`. **DO NOT batch with email** — if the merchant says 'unsubscribe Cat Lover from everything,' propose TWO separate writes (one email, one SMS), each with its own ApprovalCard.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "Customer GID." },
      subscribed: {
        type: "boolean",
        description:
          "true → SUBSCRIBED, false → UNSUBSCRIBED. Records the consent change with consentUpdatedAt = now.",
      },
    },
    required: ["customerId", "subscribed"],
  },
};

// ----------------------------------------------------------------------------
// V-Cu-B — Customer segments (read-only). Segment WRITES are deferred —
// Shopify's visual segment editor handles the DSL query authoring much
// better than chat. We ship reads so the CEO can leverage existing
// segments for "show me my VIPs" type questions.
// ----------------------------------------------------------------------------

const readSegmentsDeclaration: FunctionDeclaration = {
  name: "read_segments",
  description:
    "List the merchant's customer segments. Each segment is a saved query (defined in Shopify admin's segment editor) that selects a subset of customers — e.g. \"VIP Customers\", \"Repeat Buyers\", \"At-Risk\". Returns id, name, the segment's DSL query string, and creation/edit timestamps.\n\nUse this when the merchant asks 'what segments do I have?' / 'list my customer segments' / when you need a segmentId to drill into a specific segment's members. Read-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max segments to return. Defaults to 20.",
      },
      query: {
        type: "string",
        description:
          "Optional Shopify segment search syntax. Bare keywords match segment names.",
      },
    },
  },
};

const readSegmentMembersDeclaration: FunctionDeclaration = {
  name: "read_segment_members",
  description:
    "List the customers who currently match a segment's query. **Requires the segmentId** — call `read_segments` FIRST to find the right segment if you only have its name.\n\nReturns customer summaries (id, displayName, email, lifetime stats). Use this for 'show me the customers in my VIP segment' / 'how many people are in my Repeat Buyers segment?' Read-only — no approval card.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      segmentId: {
        type: "string",
        description:
          "Segment GID, e.g. gid://shopify/Segment/12345. Get from a read_segments call first.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max members to return. Defaults to 20.",
      },
    },
    required: ["segmentId"],
  },
};

const CUSTOMERS_SPEC: DepartmentSpec = {
  id: "customers",
  label: "Customers",
  managerTitle: "Customers manager",
  description:
    "Owns the customer list: read summaries + drill-in details, edit identity (name / email / phone / note), manage tags (replacement set), update email + SMS marketing consent state (separate per-channel audit trails), and read customer segments + their members (read-only). All writes go through human approval.",
  systemPrompt: CUSTOMERS_PROMPT,
  toolDeclarations: [
    readCustomersDeclaration,
    readCustomerDetailDeclaration,
    updateCustomerDeclaration,
    updateCustomerTagsDeclaration,
    updateEmailMarketingConsentDeclaration,
    updateSmsMarketingConsentDeclaration,
    readSegmentsDeclaration,
    readSegmentMembersDeclaration,
  ],
  handlers: new Map<string, ToolHandler>([
    ["read_customers", readCustomersHandler],
    ["read_customer_detail", readCustomerDetailHandler],
    ["update_customer", updateCustomerHandler],
    ["update_customer_tags", updateCustomerTagsHandler],
    ["update_email_marketing_consent", updateEmailMarketingConsentHandler],
    ["update_sms_marketing_consent", updateSmsMarketingConsentHandler],
    ["read_segments", readSegmentsHandler],
    ["read_segment_members", readSegmentMembersHandler],
  ]),
  classification: {
    read: new Set([
      "read_customers",
      "read_customer_detail",
      "read_segments",
      "read_segment_members",
    ]),
    write: new Set([
      "update_customer",
      "update_customer_tags",
      "update_email_marketing_consent",
      "update_sms_marketing_consent",
    ]),
    inlineWrite: new Set(),
  },
};

registerDepartment(CUSTOMERS_SPEC);

export { CUSTOMERS_SPEC };
