import { Request, Response } from "express";
import {
  getCalendarData,
  upsertInventoryCell,
  bulkUpsertInventory,
  getAvailabilityEnabled,
  setAvailabilityEnabled,
} from "../services/availability.service";

function hotelId(req: Request): string {
  return (req as any).user?.hotelId as string;
}

// GET /hotel-settings/availability/calendar?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
export async function getCalendarHandler(req: Request, res: Response) {
  try {
    const { startDate, endDate } = req.query as Record<string, string>;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ error: "Dates must be YYYY-MM-DD" });
    }
    const diffDays = (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000;
    if (diffDays < 1 || diffDays > 90) {
      return res.status(400).json({ error: "Date range must be 1–90 days" });
    }
    const data = await getCalendarData(hotelId(req), startDate, endDate);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// PATCH /hotel-settings/availability/cell
export async function patchCellHandler(req: Request, res: Response) {
  try {
    const { roomTypeId, date, availableRooms, price } = req.body;
    if (!roomTypeId || !date || availableRooms === undefined) {
      return res.status(400).json({ error: "roomTypeId, date and availableRooms are required" });
    }
    const row = await upsertInventoryCell(
      hotelId(req),
      roomTypeId,
      date,
      Number(availableRooms),
      price !== undefined && price !== "" ? Number(price) : null
    );
    res.json(row);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}

// PATCH /hotel-settings/availability/bulk
export async function bulkPatchHandler(req: Request, res: Response) {
  try {
    const { roomTypeId, startDate, endDate, availableRooms, price } = req.body;
    if (!roomTypeId || !startDate || !endDate || availableRooms === undefined) {
      return res.status(400).json({ error: "roomTypeId, startDate, endDate and availableRooms are required" });
    }
    const result = await bulkUpsertInventory(
      hotelId(req),
      roomTypeId,
      startDate,
      endDate,
      Number(availableRooms),
      price !== undefined && price !== "" ? Number(price) : null
    );
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}

// GET /hotel-settings/availability/toggle
export async function getToggleHandler(req: Request, res: Response) {
  try {
    const enabled = await getAvailabilityEnabled(hotelId(req));
    res.json({ availabilityEnabled: enabled });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// PATCH /hotel-settings/availability/toggle
export async function patchToggleHandler(req: Request, res: Response) {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled (boolean) is required" });
    }
    await setAvailabilityEnabled(hotelId(req), enabled);
    res.json({ availabilityEnabled: enabled });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
