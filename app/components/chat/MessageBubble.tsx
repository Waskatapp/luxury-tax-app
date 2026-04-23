import { BlockStack, Box, InlineStack, Text } from "@shopify/polaris";
import type { ChatMessage } from "../../hooks/useChat";
import { isApprovalRequiredWrite } from "../../lib/agent/tool-classifier";

type Props = { message: ChatMessage };

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";

  const text = message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Only surface WRITE tool_uses in the bubble — they need approval.
  // READ tool_uses are internal plumbing (Claude asking the server to fetch
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
          <BlockStack gap="150">
            <Text as="span" variant="bodySm" tone="subdued">
              {isUser ? "You" : "Copilot"}
            </Text>
            <Text as="p" variant="bodyMd">
              {text || (message.status === "streaming" ? "…" : " ")}
            </Text>
            {toolUses.length > 0 ? (
              <Text as="p" variant="bodySm" tone="caution">
                Awaiting your approval: {toolUses.map((t) => t.name).join(", ")}
              </Text>
            ) : null}
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
