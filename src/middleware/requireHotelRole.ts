import { Request, Response, NextFunction } from "express";
import { UserRole } from "@prisma/client";

/**
 * Role gate for HOTEL STAFF routes — the tenant-side counterpart to
 * `requireVakettaRole`.
 *
 * WHY THIS EXISTS: hotel routes were protected by `auth` (authentication) and
 * `requireActiveSubscription` (entitlement) and nothing else. No hotel route
 * checked `UserRole` at all, so a STAFF account could read the hotel's invoices,
 * its plan price, and its full payment history from
 * `/hotel-settings/billing/*` — commercial information the sidebar itself
 * scopes to the Account section but the API left wide open.
 *
 * TENANT ISOLATION IS UNAFFECTED and unchanged: `hotelId` still comes from the
 * verified JWT in every handler, so this narrows access WITHIN a hotel and can
 * never widen it across hotels.
 *
 * The role is read from `req.user.role`, which `auth` now populates from the
 * DATABASE rather than from the token — see auth.middleware.ts. That matters
 * here: hotel JWTs live for 24 hours, so a token-derived role would keep
 * honouring a demotion for up to a day. `auth` already loads the User row to
 * check `isActive`, so adding `role` to that existing `select` costs nothing.
 *
 * Fails CLOSED — an absent or unrecognised role is denied, not defaulted.
 */
export function requireHotelRole(...allowed: UserRole[]) {
  return function hotelRoleGate(req: Request, res: Response, next: NextFunction) {
    const user = (req as any).user as { role?: unknown } | undefined;

    // No user means `auth` did not run — unauthenticated, not merely unauthorised.
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const role = typeof user.role === "string" ? (user.role as UserRole) : null;
    if (!role || !allowed.includes(role)) {
      return res.status(403).json({ error: "You do not have permission to view billing information." });
    }

    return next();
  };
}

/**
 * Who may see what the hotel pays, owes, and has been invoiced.
 *
 * OWNER and ADMIN only. MANAGER runs the property day to day (bookings, guests)
 * and STAFF answers guest messages; neither needs the commercial relationship
 * with Vaketta, and `Sidebar.tsx` already treats Administration as ADMIN-only.
 */
export const requireBillingViewer = requireHotelRole(UserRole.OWNER, UserRole.ADMIN);
