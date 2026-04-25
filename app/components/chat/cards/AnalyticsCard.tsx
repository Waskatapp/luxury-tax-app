import {
  Badge,
  BlockStack,
  Box,
  Card,
  DataTable,
  InlineStack,
  Text,
} from "@shopify/polaris";

import type {
  AnalyticsInventoryAtRiskResult,
  AnalyticsResult,
  AnalyticsRevenueResult,
  AnalyticsTopProductsResult,
} from "../../../lib/shopify/analytics.types";

type Props = { data: AnalyticsResult };

export function AnalyticsCard({ data }: Props) {
  switch (data.metric) {
    case "top_products":
      return <TopProductsCard data={data} />;
    case "revenue":
      return <RevenueCard data={data} />;
    case "inventory_at_risk":
      return <InventoryAtRiskCard data={data} />;
  }
}

function formatMoney(amount: string, currency: string): string {
  // Polaris DataTable cells are plain strings; we render money inline.
  const n = parseFloat(amount);
  if (Number.isNaN(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function priceRangeLabel(p: AnalyticsTopProductsResult["products"][number]["priceRange"]): string {
  const min = formatMoney(p.min.amount, p.min.currencyCode);
  const max = formatMoney(p.max.amount, p.max.currencyCode);
  return min === max ? min : `${min} – ${max}`;
}

function statusBadgeTone(status: string): "success" | "info" | "attention" {
  if (status === "ACTIVE") return "success";
  if (status === "DRAFT") return "info";
  return "attention";
}

function TopProductsCard({ data }: { data: AnalyticsTopProductsResult }) {
  if (data.products.length === 0) {
    return (
      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Top products
          </Text>
          <Text as="p" tone="subdued">
            No products found.
          </Text>
        </BlockStack>
      </Card>
    );
  }

  const rows = data.products.map((p) => [
    p.title,
    <Badge key={`s-${p.id}`} tone={statusBadgeTone(p.status)}>
      {p.status}
    </Badge>,
    typeof p.totalInventory === "number" ? String(p.totalInventory) : "—",
    priceRangeLabel(p.priceRange),
  ]);

  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h3" variant="headingSm">
            Top products
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {data.note}
          </Text>
        </BlockStack>
        <DataTable
          columnContentTypes={["text", "text", "numeric", "text"]}
          headings={["Product", "Status", "Inventory", "Price"]}
          rows={rows}
        />
      </BlockStack>
    </Card>
  );
}

function RevenueCard({ data }: { data: AnalyticsRevenueResult }) {
  const total = formatMoney(data.totalRevenue, data.currencyCode);
  const aov =
    data.orderCount > 0
      ? formatMoney(
          (parseFloat(data.totalRevenue) / data.orderCount).toFixed(2),
          data.currencyCode,
        )
      : null;

  const startsAtLabel = new Date(data.startsAt).toLocaleDateString();
  const endsAtLabel = new Date(data.endsAt).toLocaleDateString();

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h3" variant="headingSm">
            Revenue (last {data.rangeDays} days)
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {startsAtLabel} → {endsAtLabel}
          </Text>
        </BlockStack>

        <InlineStack gap="600" wrap>
          <Stat label="Total" value={total} />
          <Stat label="Orders" value={String(data.orderCount)} />
          {aov ? <Stat label="Avg order" value={aov} /> : null}
        </InlineStack>

        {data.cappedAtPageLimit ? (
          <Box
            padding="200"
            background="bg-surface-caution"
            borderRadius="200"
          >
            <Text as="p" variant="bodySm">
              ⚠ Order scan capped — figure may be incomplete. Try a shorter
              window for an exact number.
            </Text>
          </Box>
        ) : null}

        <Text as="p" variant="bodySm" tone="subdued">
          {data.note}
        </Text>
      </BlockStack>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="050">
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="headingLg">
        {value}
      </Text>
    </BlockStack>
  );
}

function InventoryAtRiskCard({ data }: { data: AnalyticsInventoryAtRiskResult }) {
  if (data.variants.length === 0) {
    return (
      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Inventory at risk
          </Text>
          <Text as="p" tone="subdued">
            No variants below {data.threshold} units. You're in good shape.
          </Text>
        </BlockStack>
      </Card>
    );
  }

  const rows = data.variants.map((v) => [
    v.productTitle,
    v.variantTitle === "Default Title" ? "—" : v.variantTitle,
    <Badge key={`ps-${v.variantId}`} tone={statusBadgeTone(v.productStatus)}>
      {v.productStatus}
    </Badge>,
    String(v.inventoryQuantity),
  ]);

  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h3" variant="headingSm">
            Inventory at risk
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Variants with fewer than {data.threshold} units in stock, lowest
            first.
          </Text>
        </BlockStack>
        <DataTable
          columnContentTypes={["text", "text", "text", "numeric"]}
          headings={["Product", "Variant", "Status", "Quantity"]}
          rows={rows}
        />
        {data.truncated ? (
          <Text as="p" variant="bodySm" tone="subdued">
            Showing the first results — there may be more variants below this
            threshold. Tighten the threshold to narrow the list.
          </Text>
        ) : null}
      </BlockStack>
    </Card>
  );
}
