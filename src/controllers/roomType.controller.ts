import { Request, Response } from "express";
import {
  createRoomType,
  getRoomTypes,
  updateRoomType,
  deleteRoomType,
} from "../services/roomType.service";

export async function createRoomTypeController(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user?.hotelId; // ✅ fixed
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });

    const { name, basePrice, capacity, maxAdults, maxChildren, totalRooms } = req.body;

    if (!name || !basePrice) {
      return res.status(400).json({ error: "Name and basePrice are required" });
    }

    const roomType = await createRoomType({
      hotelId,
      name,
      basePrice:   Number(basePrice),
      ...(capacity    ? { capacity:    Number(capacity)    } : {}),
      ...(maxAdults   ? { maxAdults:   Number(maxAdults)   } : {}),
      ...(maxChildren ? { maxChildren: Number(maxChildren) } : {}),
      ...(totalRooms  ? { totalRooms:  Number(totalRooms)  } : {}),
    });

    res.json(roomType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Create room type failed" });
  }
}

export async function getRoomTypesController(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user?.hotelId; // ✅ fixed
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });

    const roomTypes = await getRoomTypes(hotelId);
    res.json(roomTypes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Get room types failed" });
  }
}

export async function updateRoomTypeController(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user?.hotelId; // ✅ fixed
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
if (!id) return res.status(400).json({ error: "Room type ID is required" });
    const { name, basePrice, capacity, maxAdults, maxChildren, totalRooms } = req.body;

    if (!name || !basePrice) {
      return res.status(400).json({ error: "Name and basePrice are required" });
    }

    const roomType = await updateRoomType({
      id,
      hotelId,
      name,
      basePrice:   Number(basePrice),
      ...(capacity    ? { capacity:    Number(capacity)    } : {}),
      ...(maxAdults   ? { maxAdults:   Number(maxAdults)   } : {}),
      ...(maxChildren ? { maxChildren: Number(maxChildren) } : {}),
      ...(totalRooms  ? { totalRooms:  Number(totalRooms)  } : {}),
    });

    res.json(roomType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Update room type failed" });
  }
}

export async function deleteRoomTypeController(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user?.hotelId; // ✅ fixed
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Room type ID is required" });
    await deleteRoomType({ id, hotelId });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Delete room type failed" });
  }
}