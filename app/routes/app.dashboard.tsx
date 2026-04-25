import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Banner,
  BlockStack,
  Layout,
  Page,
} from "@shopify/polaris";

import { requireStoreAccess } from "../lib/auth.server";
import { getAnalytics } from "../lib/shopify/analytics.server";
import type { AnalyticsResult } from "../lib/shopify/analytics.types";
import { AnalyticsCard } from "../components/chat/cards/AnalyticsCard";

type DashboardTile =
  | { ok: true; data: AnalyticsResult }
  | { ok: false; error: string };

// Calls getAnalytics() directly — no Gemini, no tokens, no approval flow.
// All three queries fire in parallel.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await requireStoreAccess(request);

  const [topProducts, revenue, inventoryAtRisk] = await Promise.all([
    getAnalytics(admin, { metric: "top_products" }),
    getAnalytics(admin, { metric: "revenue", days: 30 }),
    getAnalytics(admin, { metric: "inventory_at_risk", threshold: 5 }),
  ]);

  return {
    topProducts: tileFromResult(topProducts),
    revenue: tileFromResult(revenue),
    inventoryAtRisk: tileFromResult(inventoryAtRisk),
  };
};

function tileFromResult(
  r: { ok: true; data: AnalyticsResult } | { ok: false; error: string },
): DashboardTile {
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
}

export default function DashboardPage() {
  const { topProducts, revenue, inventoryAtRisk } = useLoaderData<typeof loader>();

  return (
    <Page
      title="Dashboard"
      subtitle="A snapshot of your store. For deeper questions, ask the Copilot."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Tile tile={revenue} label="Revenue" />
            <Tile tile={topProducts} label="Top products" />
            <Tile tile={inventoryAtRisk} label="Inventory at risk" />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function Tile({ tile, label }: { tile: DashboardTile; label: string }) {
  if (!tile.ok) {
    return (
      <Banner tone="warning" title={`${label} unavailable`}>
        <p>{tile.error}</p>
      </Banner>
    );
  }
  return <AnalyticsCard data={tile.data} />;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
