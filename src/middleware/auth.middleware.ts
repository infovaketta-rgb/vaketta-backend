import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";
import { isTokenBlocked } from "../utils/tokenBlocklist";
import prisma from "../db/connect";

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

    // Check user is still active — suspended staff must not use old tokens
    const user = await prisma.user.findUnique({
      where:  { id: decoded.id },
      select: { isActive: true, hotelId: true },
    });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: "Account is inactive" });
    }

    (req as any).user = decoded;
    next();
  } catch {
    res.sendStatus(401);
  }
}
