import { Response } from "express";

const isProd = process.env.NODE_ENV === "production";

/**
 * Send a 500 response without leaking Prisma / internal error details in production.
 */
export function serverError(res: Response, err: unknown, fallback = "Internal server error"): void {
  const msg = isProd ? fallback : ((err as any)?.message ?? fallback);
  res.status(500).json({ error: msg });
}
