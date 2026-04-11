import { Request, Response, NextFunction } from "express";
import { verifyVakettaToken } from "../utils/vakettaJwt";
import { isTokenBlocked } from "../utils/tokenBlocklist";

const COOKIE_NAME = "vaketta_token";

/**
 * Vaketta platform-level admin auth.
 * Reads JWT from httpOnly cookie first, falls back to Authorization header.
 * Verifies type: "vaketta_admin" — hotel staff tokens are rejected.
 */
export async function vakettaAdminAuth(req: Request, res: Response, next: NextFunction) {
  const token = (req as any).cookies?.[COOKIE_NAME]
    ?? req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded = verifyVakettaToken(token); // throws if not type: "vaketta_admin"

    const blocked = await isTokenBlocked(decoded.jti, decoded.id, decoded.iat);
    if (blocked) return res.status(401).json({ error: "Token has been revoked" });

    (req as any).vakettaAdmin = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}
