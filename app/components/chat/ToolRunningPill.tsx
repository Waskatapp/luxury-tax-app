import { Box, InlineStack, Spinner, Text } from "@shopify/polaris";

import {
  managerTitleForDepartment,
  type DepartmentId,
} from "../../lib/agent/departments";

// Per-tool fallback labels for cross-cutting / unknown tools where we don't
// have a department-managed pill (e.g. update_store_memory). The reactive
// pill prefers the department manager title when one is available.
const FALLBACK_LABELS: Record<string, string> = {
  read_products: "Looking up your products…",
  read_collections: "Loading your collections…",
  get_analytics: "Crunching the numbers…",
  update_store_memory: "Saving to memory…",
};

type Props = {
  toolName: string | null;
  departmentId?: DepartmentId | null;
};

// V2.0 — when the tool belongs to a department, render the manager-flavored
// pill ("Asking the Pricing & Promotions manager…") to reinforce the
// company metaphor. Otherwise fall back to the per-tool label, then a
// generic "Working on it…" if the tool isn't recognized.
export function ToolRunningPill({ toolName, departmentId }: Props) {
  const label = pickLabel(toolName, departmentId ?? null);
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

function pickLabel(
  toolName: string | null,
  departmentId: DepartmentId | null,
): string {
  const managerTitle = managerTitleForDepartment(departmentId);
  if (managerTitle) {
    return `Asking the ${managerTitle}…`;
  }
  if (toolName && FALLBACK_LABELS[toolName]) {
    return FALLBACK_LABELS[toolName];
  }
  return "Working on it…";
}
