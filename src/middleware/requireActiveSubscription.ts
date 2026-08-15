import { Request, Response, NextFunction } from "express";

/**
 * Soft-degrade paywall.
 *
 * A lapsed hotel keeps READ access to everything — conversations, bookings,
 * guests, its own billing page — and loses the ability to WRITE. The bot is
 * silenced separately, in the message pipeline.
 *
 * WHY NOT A BLANKET BLOCK: the previous behaviour 402'd every authenticated
 * route from inside `auth`, which meant an expired customer could not open the
 * upgrade screen that the 402 redirected them to, and staff lost access to guest
 * conversations they may be legally required to retain. Blocking writes keeps
 * the commercial pressure (no sends, no bookings, no config changes — the parts
 * that cost us money with Meta) without taking their data hostage.
 *
 * Method-based rather than a route allowlist so a newly added endpoint is
 * governed by default instead of silently escaping the paywall.
 */

/**
 * Never gated, whatever the method — this is how a customer pays us.
 *
 * Two patterns because Express exposes two paths: `req.path` is relative to the
 * router's mount point ("/billing/usage"), while `req.originalUrl` is absolute
 * ("/hotel-settings/billing/usage"). A single start-anchored pattern matches
 * only one of them, and which one depends on where the router happens to be
 * mounted — too fragile for the rule that keeps the upgrade screen reachable.
 */
const ALLOWED_ROUTER_PATH = /^\/billing(\/|$)/;
const ALLOWED_ABSOLUTE_URL = /^\/hotel-settings\/billing(\/|$)/;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireActiveSubscription(req: Request, res: Response, next: NextFunction) {
  // `auth` runs first and always populates this; absent means unauthenticated,
  // which is not this middleware's decision to make.
  const sub = req.subscription;
  if (!sub || !sub.suspended) return next();

  if (READ_METHODS.has(req.method)) return next();

  // Query strings never appear in req.path but do in req.originalUrl.
  const absolute = (req.originalUrl || "").split("?")[0] ?? "";
  if (ALLOWED_ROUTER_PATH.test(req.path || "") || ALLOWED_ABSOLUTE_URL.test(absolute)) {
    return next();
  }

  return res.status(402).json({
    error:
      "Your subscription has expired. You can still view your conversations and bookings, " +
      "but sending messages and making changes is paused until it is renewed.",
    code: "SUBSCRIPTION_EXPIRED",
  });
}
