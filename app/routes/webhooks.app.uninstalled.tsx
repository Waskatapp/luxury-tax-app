import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  const store = await db.store.findUnique({ where: { shopDomain: shop } });
  if (store && !store.uninstalledAt) {
    await db.$transaction([
      db.store.update({
        where: { id: store.id },
        data: { accessToken: "", uninstalledAt: new Date() },
      }),
      db.auditLog.create({
        data: {
          storeId: store.id,
          action: "app_uninstalled",
          before: { hadAccessToken: true },
          after: { uninstalledAt: new Date().toISOString() },
        },
      }),
    ]);
  }

  return new Response();
};
