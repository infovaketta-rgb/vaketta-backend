import { Request, Response } from "express";
import { getDashboardData } from "../services/dashboard.service";

type JwtUser = { id: string; role: string; hotelId: string };

export async function getDashboard(req: Request, res: Response) {
  try {
    const user = (req as Request & { user?: JwtUser }).user;
    const hotelId = user?.hotelId;

    if (!hotelId) {
      return res.status(401).json({ error: "Missing hotel context" });
    }

    const data = await getDashboardData(hotelId);
    return res.json(data);
  } catch (err) {
    console.error("❌ Dashboard failed:", err);
    return res.status(500).json({ error: "Failed to load dashboard" });
  }
}
