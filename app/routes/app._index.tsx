import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { requireStoreAccess } from "../lib/auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { store, userRole } = await requireStoreAccess(request);
  return {
    shopDomain: store.shopDomain,
    userRole,
  };
};

export default function Index() {
  const { shopDomain, userRole } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Merchant Copilot">
      <s-section heading="Welcome">
        <s-paragraph>
          Your AI copilot for {shopDomain}. Signed in as{" "}
          {userRole.replace("_", " ").toLowerCase()}.
        </s-paragraph>
        <s-paragraph>
          Tell the copilot what you want to change in plain English — pricing, product
          descriptions, discounts, analytics — and approve each action before it goes
          live on your store.
        </s-paragraph>
        <s-paragraph>
          <s-link href="/app/copilot">Open Copilot →</s-link>
        </s-paragraph>
      </s-section>

      <s-section heading="Coming soon">
        <s-unordered-list>
          <s-list-item>Price changes with approval cards (Phase 5)</s-list-item>
          <s-list-item>Product descriptions &amp; discount creation (Phase 6)</s-list-item>
          <s-list-item>Brand voice memory across sessions (Phase 8)</s-list-item>
          <s-list-item>Sales analytics inline in chat (Phase 9)</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Status">
        <s-paragraph>
          <s-text>Framework: </s-text>
          <s-link href="https://reactrouter.com/" target="_blank">
            React Router 7
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>Database: </s-text>
          <s-link href="https://www.prisma.io/" target="_blank">
            Prisma + PostgreSQL
          </s-link>
        </s-paragraph>
        <s-paragraph>
          <s-text>AI: </s-text>
          <s-link href="https://www.anthropic.com/" target="_blank">
            Claude (Sonnet 4.6)
          </s-link>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
