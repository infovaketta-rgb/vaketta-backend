import webpush from "web-push";
import prisma from "../db/connect";
import { logger } from "../utils/logger";

const log = logger.child({ service: "push" });

let vapidInitialised = false;

function initVapid() {
  if (vapidInitialised) return;
  const pub   = process.env.VAPID_PUBLIC_KEY;
  const priv  = process.env.VAPID_PRIVATE_KEY;
  const email = process.env.VAPID_EMAIL;
  if (!pub || !priv || !email) {
    log.warn("VAPID keys not configured — web push disabled");
    return;
  }
  webpush.setVapidDetails(`mailto:${email}`, pub, priv);
  vapidInitialised = true;
}

export interface PushPayload {
  title: string;
  body:  string;
  icon?: string;
  url?:  string;
}

export async function sendPushToHotelStaff(hotelId: string, payload: PushPayload): Promise<void> {
  initVapid();
  if (!vapidInitialised) return;

  const subs = await prisma.pushSubscription.findMany({ where: { hotelId } });
  if (subs.length === 0) return;

  const data = JSON.stringify(payload);

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          data,
        );
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Subscription expired — clean it up
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          log.info({ subId: sub.id }, "removed expired push subscription");
        } else {
          log.warn({ err: err.message, subId: sub.id }, "push send failed");
        }
      }
    }),
  );
}
