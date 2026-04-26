import { Box, InlineStack, Spinner, Text } from "@shopify/polaris";

const LABELS: Record<string, string> = {
  read_products: "Looking up your products…",
  read_collections: "Loading your collections…",
  get_analytics: "Crunching the numbers…",
  update_store_memory: "Saving to memory…",
};

export function ToolRunningPill({ toolName }: { toolName: string }) {
  const label = LABELS[toolName] ?? "Working on it…";
  return (
    <Box padding="150" background="bg-surface-secondary" borderRadius="200">
      <InlineStack gap="200" blockAlign="center">
        <Spinner size="small" accessibilityLabel="Loading" />
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
      </InlineStack>
    </Box>
  );
}
