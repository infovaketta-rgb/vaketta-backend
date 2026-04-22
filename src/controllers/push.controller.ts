import { Request, Response } from "express";
import prisma from "../db/connect";

export async function getVapidPublicKey(_req: Request, res: Response) {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: "Push not configured" });
  res.json({ key });
}

export async function subscribePush(req: Request, res: Response) {
  const user = (req as any).user as { id: string; hotelId: string };
  const { endpoint, keys } = req.body as {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  const { p256dh, auth } = keys ?? {};

  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: "Invalid subscription object" });
  }

  await prisma.pushSubscription.upsert({
    where:  { endpoint },
    create: { endpoint, p256dh, auth, userId: user.id, hotelId: user.hotelId },
    update: { p256dh, auth, userId: user.id, hotelId: user.hotelId },
  });

  res.status(201).json({ success: true });
}
