import { Box, InlineStack, Spinner, Text } from "@shopify/polaris";

// Phase Re Round Re-B — subtle "retrying in Ns…" banner. Renders inline
// in the streaming assistant bubble while the server is in a backoff
// window for a transient tool failure (RATE_LIMITED_BURST, NETWORK).
//
// Why we surface this: silence during a 30-60s backoff feels broken.
// The merchant types a question, sees the agent start, then nothing for
// a minute — they reach for the back button or the refresh. A tiny
// "retrying in 30s…" banner tells them the system is doing the right
// thing and they can wait. No interaction, no decisions — just signal.

type Props = {
  delaySeconds: number;
  reasonCode: string;
};

const REASON_LABEL: Record<string, string> = {
  RATE_LIMITED_BURST: "Hit a rate limit",
  RATE_LIMITED_DAILY: "Daily quota reached",
  NETWORK: "Network blip",
  UPSTREAM_ERROR: "Upstream issue",
  ID_NOT_FOUND: "Resource went missing",
  PERMISSION_DENIED: "Permission issue",
  INVALID_INPUT: "Bad input",
  UNKNOWN: "Hit a snag",
};

export function RetryBanner({ delaySeconds, reasonCode }: Props) {
  const label = REASON_LABEL[reasonCode] ?? "Hit a snag";
  return (
    <Box padding="150" background="bg-surface-secondary" borderRadius="200">
      <InlineStack gap="200" blockAlign="center">
        <Spinner size="small" accessibilityLabel="Retrying" />
        <Text as="span" variant="bodySm" tone="subdued">
          {label} — retrying in {delaySeconds}s…
        </Text>
      </InlineStack>
    </Box>
  );
}
