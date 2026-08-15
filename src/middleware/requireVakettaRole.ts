import { Request, Response, NextFunction } from "express";
import { VakettaAdminRole } from "@prisma/client";
import prisma from "../db/connect";
import { logger } from "../utils/logger";

const log = logger.child({ service: "adminRole" });

/**
 * Role gate for Vaketta platform admins.
 *
 * WHY THIS EXISTS: `VakettaAdminRole` has SUPER_ADMIN | ADMIN | SUPPORT, but
 * every admin route was protected by `vakettaAdminAuth` alone, which never looks
 * at the role. A SUPPORT admin could create plans, rewrite prices, grant free
 * trials, and edit platform settings.
 *
 * The role is read from the DATABASE, not the JWT. The admin token
 * (`signVakettaToken`) carries only id/email/name and lives for 8 hours, so a
 * token-based check would (a) reject every already-issued token on deploy and
 * (b) keep honouring a revoked role until the token expired. One indexed
 * primary-key lookup on a rare, money-touching route is the right trade.
 *
 * Mount AFTER `vakettaAdminAuth`, which populates `req.vakettaAdmin`.
 */
export function requireVakettaRole(...allowed: VakettaAdminRole[]) {
  return async function roleGate(req: Request, res: Response, next: NextFunction) {
    const admin = (req as any).vakettaAdmin as { id?: string } | undefined;

    // No admin on the request means the auth middleware did not run — treat as
    // unauthenticated rather than quietly allowing through.
    if (!admin?.id) return res.status(401).json({ error: "Unauthorized" });

    try {
      const row = await prisma.vakettaAdmin.findUnique({
        where: { id: admin.id },
        select: { role: true },
      });

      // Token valid but the account is gone — the token outlived the admin.
      if (!row) return res.status(401).json({ error: "Unauthorized" });

      if (!allowed.includes(row.role)) {
        return res.status(403).json({ error: "You do not have permission to perform this action." });
      }

      (req as any).vakettaAdmin.role = row.role;
      return next();
    } catch (err) {
      // Fail CLOSED: an unverifiable role must not authorise a price change.
      log.error({ err, adminId: admin.id }, "admin role lookup failed — denying");
      return res.status(503).json({ error: "Unable to verify permissions. Please try again." });
    }
  };
}

/** Billing writes: plans, pricing, plan assignment, trials, payments. */
export const requireBillingAdmin = requireVakettaRole(
  VakettaAdminRole.SUPER_ADMIN,
  VakettaAdminRole.ADMIN,
);

/** Platform-wide configuration that affects every tenant. */
export const requireSuperAdmin = requireVakettaRole(VakettaAdminRole.SUPER_ADMIN);
