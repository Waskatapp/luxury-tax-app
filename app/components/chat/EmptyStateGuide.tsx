import { BlockStack, Button, InlineStack, Text } from "@shopify/polaris";

// Empty-state welcome screen. 3-4 contextual prompts picked by
// app/lib/agent/suggestions.server.ts based on store signals + heuristic
// scoring + Gemini Flash-Lite curation. Replaces the prior 9-prompt /
// 4-category static layout that was identical for every merchant.
//
// The button label is what Flash-Lite may have rewritten in the merchant's
// brand voice; the prompt that gets sent on click is the stable text from
// the candidate pool. templateId is logged to SuggestionEvent for telemetry.

export type Suggestion = {
  templateId: string;
  label: string;
  prompt: string;
};

export function EmptyStateGuide({
  suggestions,
  onSelect,
  onRefresh,
  disabled,
  refreshing,
}: {
  suggestions: Suggestion[];
  onSelect: (suggestion: Suggestion, slotPosition: number) => void;
  onRefresh: () => void;
  disabled: boolean;
  refreshing: boolean;
}) {
  const visible = suggestions.length > 0 ? suggestions : FALLBACK;

  return (
    <BlockStack gap="400">
      <BlockStack gap="100">
        <Text as="h2" variant="headingMd">
          Welcome to your Copilot
        </Text>
        <Text as="p" tone="subdued">
          Type plain-English requests. Every store-modifying action shows an
          approval card before anything happens.
        </Text>
      </BlockStack>

      <InlineStack align="space-between" blockAlign="center">
        <Text as="h3" variant="headingSm" tone="subdued">
          Suggested for you
        </Text>
        <Button
          variant="plain"
          onClick={onRefresh}
          disabled={disabled || refreshing}
          loading={refreshing}
          accessibilityLabel="Refresh suggestions"
        >
          ↻ Refresh
        </Button>
      </InlineStack>

      <BlockStack gap="200">
        {visible.map((s, idx) => (
          <Button
            key={s.templateId}
            size="large"
            textAlign="start"
            disabled={disabled}
            onClick={() => onSelect(s, idx)}
            fullWidth
          >
            {s.label}
          </Button>
        ))}
      </BlockStack>

      <Text as="p" variant="bodySm" tone="subdued">
        Tip: tell the Copilot things to remember — "always keep responses
        short", "our brand voice is warm and cheeky" — and it'll apply
        them across every conversation. Manage these at the Memory tab.
      </Text>
    </BlockStack>
  );
}

// Last-resort fallback: shown only if `suggestions` is empty (signal
// gathering failed AND the orchestrator's onboarding fallback didn't reach
// the loader). Synthetic templateIds prefixed `fallback_*` so we can tell
// them apart in telemetry.
const FALLBACK: Suggestion[] = [
  {
    templateId: "fallback_show_products",
    label: "Show me my products",
    prompt: "Show me my products.",
  },
  {
    templateId: "fallback_revenue",
    label: "How's revenue this week?",
    prompt: "How is revenue this week compared to last week?",
  },
  {
    templateId: "fallback_low_stock",
    label: "What's running low on stock?",
    prompt: "What's running low on stock?",
  },
];
