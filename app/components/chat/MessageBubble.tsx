import { useRef, useState } from "react";
import { BlockStack, Box, Button, InlineStack, Text } from "@shopify/polaris";
import type { ChatMessage, PendingActionStatus } from "../../hooks/useChat";
import type { DepartmentId } from "../../lib/agent/departments";
import { isApprovalRequiredWrite } from "../../lib/agent/tool-classifier";
import type { AnalyticsResult } from "../../lib/shopify/analytics.types";
import { ApprovalCard } from "./ApprovalCard";
import { AnalyticsCard } from "./cards/AnalyticsCard";
import { ClarificationPrompt } from "./ClarificationPrompt";
import { MarkdownContent } from "./MarkdownContent";
import type { PlanStatus, PlanStep } from "./PlanCard";
import { PlanCard, shouldRenderPlanCard } from "./PlanCard";
import { ToolRunningPill } from "./ToolRunningPill";
import { RetryBanner } from "./RetryBanner";

export type PlanSnapshot = {
  id: string;
  summary: string;
  steps: PlanStep[];
  status: PlanStatus;
};

type Props = {
  message: ChatMessage;
  pendingByToolCallId: Record<string, PendingActionStatus>;
  // V2.3 — Plan rows keyed by the propose_plan tool_use's toolCallId.
  // Empty record by default; PlanCard treats missing entries as
  // "just-streamed PENDING" until the next reload populates it.
  planByToolCallId: Record<string, PlanSnapshot>;
  runningTool: string | null;
  runningDepartment: DepartmentId | null;
  // Phase Re Round Re-B — set when the server is in a retry-backoff
  // window for a transient tool failure. Renders a subtle "retrying in
  // Ns…" banner inline with the streaming bubble so the merchant
  // doesn't experience silence during the wait.
  retryPending: { delaySeconds: number; reasonCode: string; toolName: string } | null;
  // V2.3 — passed through to MarkdownContent for citation link
  // resolution (`product:<gid>` schemes need it to build admin URLs).
  shopDomain?: string | null | undefined;
  // V2.2 — true when this message is NOT the latest assistant turn in
  // the conversation (i.e. the merchant has already replied to whatever
  // clarification it contains). The ClarificationPrompt uses this to
  // render in read-only mode for older messages.
  answered: boolean;
  onApprove: (toolCallIds: string[]) => Promise<void> | void;
  onReject: (toolCallIds: string[]) => Promise<void> | void;
  onClarify: (text: string) => Promise<void> | void;
  onApprovePlan: (toolCallId: string) => Promise<void> | void;
  onRejectPlan: (toolCallId: string) => Promise<void> | void;
};

type ToolResultLike = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

// Reads from the rendered DOM via ref when available — gives the merchant
// exactly what they see on screen, with no markdown chars. Falls back on
// the raw source if the ref isn't ready (initial render, etc).
function CopyButton({
  source,
  plainTextRef,
}: {
  source: string;
  plainTextRef?: React.RefObject<HTMLElement | null>;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const fromDom = plainTextRef?.current?.innerText?.trim();
    const text = fromDom && fromDom.length > 0 ? fromDom : source;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — fail silently rather than alarming the merchant.
    }
  }

  // Reads --copy-opacity from the hover/focus wrapper so the button fades
  // in/out without layout shift. `copied` forces it visible briefly so the
  // confirmation text is readable even after the cursor leaves.
  const opacity = copied ? 1 : "var(--copy-opacity, 0)";
  return (
    <div
      style={{
        opacity,
        transition: "opacity 0.15s ease",
      }}
    >
      <Button variant="plain" onClick={handleCopy} accessibilityLabel="Copy message">
        {copied ? "Copied!" : "Copy"}
      </Button>
    </div>
  );
}

function parseAnalytics(block: ToolResultLike): AnalyticsResult | null {
  try {
    const parsed = JSON.parse(block.content);
    if (parsed && typeof parsed === "object" && "metric" in parsed) {
      return parsed as AnalyticsResult;
    }
    return null;
  } catch {
    return null;
  }
}

export function MessageBubble({
  message,
  pendingByToolCallId,
  planByToolCallId,
  runningTool,
  runningDepartment,
  retryPending,
  shopDomain,
  answered,
  onApprove,
  onReject,
  onClarify,
  onApprovePlan,
  onRejectPlan,
}: Props) {
  const isUser = message.role === "user";
  const markdownRef = useRef<HTMLDivElement>(null);

  // Synthetic plumbing rows: all blocks are tool_result. Render any
  // get_analytics results as inline cards; everything else is hidden.
  const allToolResults =
    message.content.length > 0 &&
    message.content.every((b) => b.type === "tool_result");

  if (allToolResults) {
    const analyticsBlocks = message.content
      .filter((b): b is ToolResultLike => b.type === "tool_result")
      .filter((b) => b.tool_use_id.startsWith("get_analytics::"))
      .map((b) => ({ id: b.tool_use_id, data: parseAnalytics(b) }))
      .filter(
        (entry): entry is { id: string; data: AnalyticsResult } =>
          entry.data !== null,
      );

    if (analyticsBlocks.length === 0) return null;

    return (
      <InlineStack align="start" blockAlign="start">
        <div style={{ width: "100%", maxWidth: "100%" }}>
          <BlockStack gap="300">
            {analyticsBlocks.map((entry) => (
              <AnalyticsCard key={entry.id} data={entry.data} />
            ))}
          </BlockStack>
        </div>
      </InlineStack>
    );
  }

  const text = message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Only surface WRITE tool_uses in the bubble — they need approval.
  // READ tool_uses are internal plumbing (the agent asking the server to fetch
  // data); the merchant shouldn't see them at all.
  const allToolUses = message.content.filter(
    (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
      b.type === "tool_use",
  );
  const toolUses = allToolUses.filter((b) => isApprovalRequiredWrite(b.name));
  // V2.2 — `ask_clarifying_question` calls render as inline prompts rather
  // than approval cards. Each prompt has a question + optional list of
  // pre-filled options the merchant can click.
  const clarifications = allToolUses.filter(
    (b) => b.name === "ask_clarifying_question",
  );
  // V2.3 — `propose_plan` calls render as PlanCards above the regular
  // approval flow. Status comes from the planByToolCallId sidecar (or
  // PENDING if missing — that's the just-streamed case before reload).
  const plans = allToolUses.filter((b) => b.name === "propose_plan");

  const showRunningPill =
    !isUser && message.status === "streaming" && runningTool !== null;
  const showRetryBanner =
    !isUser && message.status === "streaming" && retryPending !== null;

  // V3.3 — Hide tool-only assistant turns that have nothing merchant-facing
  // to render. Many turns in the agent loop emit only internal plumbing —
  // a `read_products` lookup, a `propose_artifact` whose canvas already
  // opened in the side panel, a `propose_followup` queued for the offline
  // evaluator. Without text, an approval card, a plan, or a clarification
  // to show, the bubble would render as an empty "Copilot" header card
  // that looks like a broken response. While the turn is still streaming
  // the running pill / "…" indicator covers the gap; once it completes
  // with no renderable body, we skip rendering entirely.
  const hasRenderableContent =
    text.length > 0 ||
    toolUses.length > 0 ||
    plans.length > 0 ||
    clarifications.length > 0 ||
    message.status === "error" ||
    showRunningPill ||
    message.status === "streaming";
  if (!isUser && !hasRenderableContent) {
    return null;
  }

  return (
    <InlineStack align={isUser ? "end" : "start"} blockAlign="start">
      <BubbleWrapper>
        <Box
          padding="300"
          background={isUser ? "bg-surface-secondary" : "bg-surface"}
          borderColor="border"
          borderWidth="025"
          borderRadius="300"
        >
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center" wrap={false}>
              <Text as="span" variant="bodySm" tone="subdued">
                {isUser ? "You" : "Copilot"}
              </Text>
              {text ? (
                <CopyButton
                  source={text}
                  plainTextRef={isUser ? undefined : markdownRef}
                />
              ) : null}
            </InlineStack>
            {text ? (
              isUser ? (
                <Text as="p" variant="bodyMd">
                  {text}
                </Text>
              ) : (
                <MarkdownContent
                  ref={markdownRef}
                  text={text}
                  shopDomain={shopDomain}
                />
              )
            ) : message.status === "streaming" && toolUses.length === 0 && !showRunningPill ? (
              <Text as="p" variant="bodyMd">
                …
              </Text>
            ) : null}
            {showRunningPill ? (
              <ToolRunningPill toolName={runningTool} departmentId={runningDepartment} />
            ) : null}
            {showRetryBanner && retryPending !== null ? (
              <RetryBanner
                delaySeconds={retryPending.delaySeconds}
                reasonCode={retryPending.reasonCode}
              />
            ) : null}
            {toolUses.length > 0 ? (
              // V1.8: ALL approval-required writes from one assistant turn
              // render as a single batched ApprovalCard with one Approve /
              // one Reject button. Single-item turns degrade naturally to
              // the V1.7 single-card UX.
              <ApprovalCard
                items={toolUses.map((tu) => ({
                  toolCallId: tu.id,
                  toolName: tu.name,
                  toolInput: (tu.input ?? {}) as Record<string, unknown>,
                  status: pendingByToolCallId[tu.id],
                }))}
                onApprove={onApprove}
                onReject={onReject}
              />
            ) : null}
            {plans.map((p) => {
              const sidecar = planByToolCallId[p.id];
              // Fall back to the toolInput shape only when sidecar isn't
              // loaded yet AND the toolInput has a valid step count
              // (server-side schema caps at 2–8). When the server rejects
              // a propose_plan call (too many / too few steps, malformed
              // input), no Plan row is created, so the sidecar stays
              // empty — and we should NOT render a phantom card backed
              // by nothing. The CEO's follow-up text already tells the
              // merchant the plan was rejected; rendering a fake
              // approve/reject UI here would contradict that prose.
              const inp = (p.input ?? {}) as {
                summary?: string;
                steps?: unknown;
              };
              const stepsFromInput: PlanStep[] = Array.isArray(inp.steps)
                ? (inp.steps.filter(
                    (s) =>
                      s !== null &&
                      typeof s === "object" &&
                      typeof (s as { description?: unknown }).description ===
                        "string" &&
                      typeof (s as { departmentId?: unknown }).departmentId ===
                        "string",
                  ) as PlanStep[])
                : [];
              if (
                !shouldRenderPlanCard({
                  hasSidecar: Boolean(sidecar),
                  inputStepCount: stepsFromInput.length,
                })
              ) {
                // Plan creation failed server-side — don't render a
                // phantom card. The CEO's next message in the conversation
                // explains what happened.
                return null;
              }

              const summary =
                sidecar?.summary ??
                (typeof inp.summary === "string" ? inp.summary : "");
              const steps = sidecar?.steps ?? stepsFromInput;
              return (
                <PlanCard
                  key={p.id}
                  toolCallId={p.id}
                  summary={summary}
                  steps={steps}
                  status={sidecar?.status}
                  onApprove={onApprovePlan}
                  onReject={onRejectPlan}
                />
              );
            })}
            {clarifications.map((c) => {
              const inp = (c.input ?? {}) as {
                question?: string;
                options?: unknown;
              };
              const opts = Array.isArray(inp.options)
                ? inp.options.filter((o): o is string => typeof o === "string")
                : [];
              return (
                <ClarificationPrompt
                  key={c.id}
                  question={inp.question ?? ""}
                  options={opts}
                  answered={answered}
                  onAnswer={onClarify}
                />
              );
            })}
            {message.status === "error" ? (
              <Text as="p" variant="bodySm" tone="critical">
                Something went wrong with this message.
              </Text>
            ) : null}
          </BlockStack>
        </Box>
      </BubbleWrapper>
    </InlineStack>
  );
}

// Exposes --copy-opacity for hover/focus reveal of the Copy button. Applied
// to both user and assistant bubbles uniformly.
function BubbleWrapper({ children }: { children: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const visible = hovered || focused ? 1 : 0;

  return (
    <div
      style={
        {
          maxWidth: "80%",
          ["--copy-opacity" as string]: String(visible),
        } as React.CSSProperties
      }
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={() => setFocused(false)}
    >
      {children}
    </div>
  );
}
