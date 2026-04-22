import { Request, Response } from "express";
import { getDashboardData } from "../services/dashboard.service";
import { redis } from "../queue/redis";
import { logger } from "../utils/logger";

const log = logger.child({ service: "dashboard" });
const CACHE_TTL = 300; // 5 minutes

type JwtUser = { id: string; role: string; hotelId: string };

export async function getDashboard(req: Request, res: Response) {
  try {
    const user = (req as Request & { user?: JwtUser }).user;
    const hotelId = user?.hotelId;

    if (!hotelId) {
      return res.status(401).json({ error: "Missing hotel context" });
    }

    const cacheKey = `dashboard:${hotelId}`;

    // Try cache first
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    } catch (cacheErr) {
      log.warn({ cacheErr, hotelId }, "Redis cache read failed — falling back to live query");
    }

    const data = await getDashboardData(hotelId);

    // Populate cache (fire-and-forget — never block response)
    redis.setex(cacheKey, CACHE_TTL, JSON.stringify(data)).catch((err) =>
      log.warn({ err, hotelId }, "Redis cache write failed")
    );

    return res.json(data);
  } catch (err) {
    log.error({ err }, "Dashboard failed");
    return res.status(500).json({ error: "Failed to load dashboard" });
  }
}
