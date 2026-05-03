// V-Cu-A — Customers department handlers. Reads thread the per-
// conversation cache (5-min TTL); writes pass through to
// app/lib/shopify/customers.server.ts. Approval-flow plumbing
// (PendingAction → ApprovalCard → executor) lives upstream and runs
// identically to every other department's writes.

import {
  readCustomerDetail,
  readCustomers,
  updateCustomer,
  updateCustomerTags,
  updateEmailMarketingConsent,
  updateSmsMarketingConsent,
} from "../../../shopify/customers.server";
import {
  readSegmentMembers,
  readSegments,
} from "../../../shopify/segments.server";
import { readCacheGet, readCacheSet } from "../../read-cache.server";
import type { HandlerContext, ToolHandler } from "../department-spec";

export const readCustomersHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(ctx.conversationId, "read_customers", input);
    if (cached !== undefined) return { ok: true, data: cached };
  }
  const result = await readCustomers(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(ctx.conversationId, "read_customers", input, result.data);
  }
  return result;
};

export const readCustomerDetailHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(
      ctx.conversationId,
      "read_customer_detail",
      input,
    );
    if (cached !== undefined) return { ok: true, data: cached };
  }
  const result = await readCustomerDetail(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(
      ctx.conversationId,
      "read_customer_detail",
      input,
      result.data,
    );
  }
  return result;
};

export const updateCustomerHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateCustomer(ctx.admin, input);
};

export const updateCustomerTagsHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateCustomerTags(ctx.admin, input);
};

export const updateEmailMarketingConsentHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateEmailMarketingConsent(ctx.admin, input);
};

export const updateSmsMarketingConsentHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  return updateSmsMarketingConsent(ctx.admin, input);
};

// V-Cu-B — Segment read handlers. Cached per-conversation; busted by
// any customer write (since segment composition can shift on tag edits
// — the executor's readCacheInvalidate handles that).
export const readSegmentsHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(ctx.conversationId, "read_segments", input);
    if (cached !== undefined) return { ok: true, data: cached };
  }
  const result = await readSegments(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(ctx.conversationId, "read_segments", input, result.data);
  }
  return result;
};

export const readSegmentMembersHandler: ToolHandler = async (
  input: unknown,
  ctx: HandlerContext,
) => {
  if (ctx.conversationId) {
    const cached = readCacheGet(
      ctx.conversationId,
      "read_segment_members",
      input,
    );
    if (cached !== undefined) return { ok: true, data: cached };
  }
  const result = await readSegmentMembers(ctx.admin, input);
  if (result.ok && ctx.conversationId) {
    readCacheSet(
      ctx.conversationId,
      "read_segment_members",
      input,
      result.data,
    );
  }
  return result;
};
