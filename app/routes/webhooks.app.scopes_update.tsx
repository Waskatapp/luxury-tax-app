import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const current = payload.current as string[];
  const scopesString = current.join(",");

  if (session) {
    await db.session.update({
      where: { id: session.id },
      data: { scope: scopesString },
    });
  }

  const store = await db.store.findUnique({ where: { shopDomain: shop } });
  if (store) {
    await db.$transaction([
      db.store.update({
        where: { id: store.id },
        data: { scopes: scopesString },
      }),
      db.auditLog.create({
        data: {
          storeId: store.id,
          action: "scopes_updated",
          before: { scopes: store.scopes },
          after: { scopes: scopesString },
        },
      }),
    ]);
  }

  return new Response();
};
