import { BlockStack, Box, InlineStack, Text } from "@shopify/polaris";
import type { ChatMessage, PendingActionStatus } from "../../hooks/useChat";
import { isApprovalRequiredWrite } from "../../lib/agent/tool-classifier";
import type { AnalyticsResult } from "../../lib/shopify/analytics.types";
import { ApprovalCard } from "./ApprovalCard";
import { AnalyticsCard } from "./cards/AnalyticsCard";

type Props = {
  message: ChatMessage;
  pendingByToolCallId: Record<string, PendingActionStatus>;
  onApprove: (toolCallId: string) => Promise<void> | void;
  onReject: (toolCallId: string) => Promise<void> | void;
};

type ToolResultLike = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

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
  onApprove,
  onReject,
}: Props) {
  const isUser = message.role === "user";

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
  const toolUses = message.content
    .filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
        b.type === "tool_use",
    )
    .filter((b) => isApprovalRequiredWrite(b.name));

  return (
    <InlineStack align={isUser ? "end" : "start"} blockAlign="start">
      <div style={{ maxWidth: "80%" }}>
        <Box
          padding="300"
          background={isUser ? "bg-surface-secondary" : "bg-surface"}
          borderColor="border"
          borderWidth="025"
          borderRadius="300"
        >
          <BlockStack gap="200">
            <Text as="span" variant="bodySm" tone="subdued">
              {isUser ? "You" : "Copilot"}
            </Text>
            {text || (message.status === "streaming" && toolUses.length === 0) ? (
              <Text as="p" variant="bodyMd">
                {text || "…"}
              </Text>
            ) : null}
            {toolUses.map((tu) => (
              <ApprovalCard
                key={tu.id}
                toolCallId={tu.id}
                toolName={tu.name}
                toolInput={(tu.input ?? {}) as Record<string, unknown>}
                status={pendingByToolCallId[tu.id]}
                onApprove={onApprove}
                onReject={onReject}
              />
            ))}
            {message.status === "error" ? (
              <Text as="p" variant="bodySm" tone="critical">
                Something went wrong with this message.
              </Text>
            ) : null}
          </BlockStack>
        </Box>
      </div>
    </InlineStack>
  );
}
