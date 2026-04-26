import { useState } from "react";
import { BlockStack, Box, Button, InlineStack, Text } from "@shopify/polaris";
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older browsers / non-secure contexts.
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
      <UserBubbleWrapper isUser={isUser}>
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
              {isUser && text ? <CopyButton text={text} /> : null}
            </InlineStack>
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
      </UserBubbleWrapper>
    </InlineStack>
  );
}

// Wraps the bubble. For user bubbles, exposes a `--copy-opacity` CSS var via
// hover/focus state so the Copy button is visible only when the merchant is
// pointing at the message (or has tab-focused it). Assistant bubbles render
// the same shell with no hover behavior.
function UserBubbleWrapper({
  isUser,
  children,
}: {
  isUser: boolean;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  if (!isUser) {
    return <div style={{ maxWidth: "80%" }}>{children}</div>;
  }

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
