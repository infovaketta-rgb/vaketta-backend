import { Request, Response, NextFunction } from "express";
import { SubscriptionStatus } from "@prisma/client";
import { verifyToken } from "../utils/jwt";
import { isTokenBlocked } from "../utils/tokenBlocklist";
import { getSubscriptionStatus } from "../services/billing.service";
import prisma from "../db/connect";

/**
 * Hotel staff auth.
 *
 * WHAT CHANGED: this used to return **402 for every authenticated route** when a
 * hotel's subscription had lapsed — including `/hotel-settings/billing/*`. The
 * paywall locked customers out of the paywall screen: an expired hotel could not
 * view its plan, its usage, or the plans available to upgrade to, and the
 * dashboard fell back to a static "email support" page. It also contradicted the
 * product's own Help copy, which promises staff keep read access.
 *
 * Now `auth` only authenticates. It records the subscription status on the
 * request and lets `requireActiveSubscription` (mounted on mutating routes only)
 * make the entitlement decision. See requireActiveSubscription.ts.
 *
 * Also: the subscription status now comes from a Redis read-through cache rather
 * than a Postgres join **on every single authenticated request**.
 */

export type RequestSubscription = {
  status: SubscriptionStatus;
  /** Lapsed — writes are blocked and the bot is off. */
  suspended: boolean;
  /** In the dunning grace window; still fully served. */
  pastDue: boolean;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      subscription?: RequestSubscription;
    }
  }
}

export async function auth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header) return res.sendStatus(401);

  const token = header.split(" ")[1];
  if (!token) return res.sendStatus(401);

  try {
    const decoded = verifyToken(token);

    // Check token blocklist (logout / password change)
    const blocked = await isTokenBlocked(decoded.jti, decoded.id, decoded.iat);
    if (blocked) return res.status(401).json({ error: "Token has been revoked" });

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      // `role` is selected here — from the DATABASE, not the token — so
      // `requireHotelRole` gates on the CURRENT role. Hotel JWTs live 24 h, so a
      // token-derived role would keep honouring a demotion for up to a day.
      // This row was already being loaded to check `isActive`, so the extra
      // column is free.
      select: { isActive: true, hotelId: true, role: true },
    });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: "Account is inactive" });
    }

    const status = (await getSubscriptionStatus(user.hotelId)) ?? SubscriptionStatus.EXPIRED;

    // Spread order matters: the DB role overrides whatever the token carried.
    // Every existing reader of `req.user` (hotelId, id, jti…) is untouched.
    (req as any).user = { ...decoded, role: user.role };
    req.subscription = {
      status,
      suspended: status === SubscriptionStatus.EXPIRED || status === SubscriptionStatus.CANCELED,
      pastDue: status === SubscriptionStatus.PAST_DUE,
    };

    next();
  } catch {
    res.sendStatus(401);
  }
}
