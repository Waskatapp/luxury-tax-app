import { BlockStack, Box, Button, InlineStack, Text } from "@shopify/polaris";

// First-time empty state — shows a brief welcome + categorized example
// prompts the merchant can click to start. Replaces the prior single-row
// SEEDED_PROMPTS list. Each prompt is a real working sentence so a click
// fires a useful first message; placeholder-style suggestions (like
// "<product>") are intentionally avoided.

type Category = {
  heading: string;
  blurb: string;
  prompts: string[];
};

const CATEGORIES: Category[] = [
  {
    heading: "Explore your store",
    blurb: "Read products, collections, and inventory.",
    prompts: [
      "Show me my products",
      "List my collections",
      "What's running low on stock?",
    ],
  },
  {
    heading: "Understand your sales",
    blurb: "Revenue, top sellers, recent orders.",
    prompts: [
      "How is revenue the last 30 days?",
      "Show me my top 5 products",
    ],
  },
  {
    heading: "Update products",
    blurb:
      "Change prices, descriptions, or status — every change asks for approval first.",
    prompts: [
      "Help me update a product's price",
      "Rewrite a product description for me",
      "Help me publish a draft product",
    ],
  },
  {
    heading: "Run a promotion",
    blurb: "Create automatic discounts.",
    prompts: ["Create a 15% off discount"],
  },
];

export function EmptyStateGuide({
  onSelect,
  disabled,
}: {
  onSelect: (prompt: string) => void;
  disabled: boolean;
}) {
  return (
    <BlockStack gap="400">
      <BlockStack gap="100">
        <Text as="h2" variant="headingMd">
          Welcome to your Copilot
        </Text>
        <Text as="p" tone="subdued">
          Type plain-English requests. The Copilot reads and changes your
          store with your approval — every store-modifying action shows an
          approval card before anything happens.
        </Text>
      </BlockStack>

      <BlockStack gap="300">
        {CATEGORIES.map((cat) => (
          <Box
            key={cat.heading}
            padding="300"
            background="bg-surface-secondary"
            borderRadius="200"
            borderColor="border"
            borderWidth="025"
          >
            <BlockStack gap="200">
              <BlockStack gap="050">
                <Text as="h3" variant="headingSm">
                  {cat.heading}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {cat.blurb}
                </Text>
              </BlockStack>
              <InlineStack gap="200" wrap>
                {cat.prompts.map((prompt) => (
                  <Button
                    key={prompt}
                    onClick={() => onSelect(prompt)}
                    disabled={disabled}
                  >
                    {prompt}
                  </Button>
                ))}
              </InlineStack>
            </BlockStack>
          </Box>
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
