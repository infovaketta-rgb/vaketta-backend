import { Request, Response } from "express";
import {
  createRoomType,
  getRoomTypes,
  updateRoomType,
  deleteRoomType,
} from "../services/roomType.service";
import { invalidatePromptCache } from "../services/ai.service";
import { logger } from "../utils/logger";
import multer from "multer";

const log = logger.child({ service: "room-type" });
import { uploadRoomPhoto, deleteRoomPhoto, setMainPhoto, reorderRoomPhotos, getRoomTypeById } from "../services/roomType.service";



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

    invalidatePromptCache(hotelId);
    res.json(roomType);
  } catch (err) {
    log.error({ err });
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
    log.error({ err });
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

    invalidatePromptCache(hotelId);
    res.json(roomType);
  } catch (err) {
    log.error({ err });
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
    invalidatePromptCache(hotelId);
    res.json({ success: true });
  } catch (err) {
    log.error({ err });
    res.status(500).json({ error: "Delete room type failed" });
  }
}


const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
export const uploadMiddleware = upload.single("photo");

export async function getRoomTypeByIdController(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user?.hotelId;
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Room type ID is required" });
    const roomType = await getRoomTypeById(id, hotelId);
    if (!roomType) return res.status(404).json({ error: "Room type not found" });
    res.json(roomType);
  } catch (err) {
    res.status(500).json({ error: "Failed to get room type" });
  }
}

export async function uploadRoomPhotoController(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user?.hotelId;
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Room type ID is required" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const photo = await uploadRoomPhoto(
      id, hotelId,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );
    res.json(photo);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Upload failed" });
  }
}

export async function deleteRoomPhotoController(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user?.hotelId;
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });
    const { photoId } = req.params;
    if (!photoId) return res.status(400).json({ error: "Photo ID is required" });
    await deleteRoomPhoto(photoId, hotelId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Delete failed" });
  }
}

export async function setMainPhotoController(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user?.hotelId;
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });
    const { id, photoId } = req.params;
    if (!id || !photoId) return res.status(400).json({ error: "IDs required" });
    const photo = await setMainPhoto(photoId, id, hotelId);
    res.json(photo);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to set main photo" });
  }
}

export async function reorderRoomPhotosController(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user?.hotelId;
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Room type ID is required" });
    const { photoIds } = req.body;
    if (!Array.isArray(photoIds)) return res.status(400).json({ error: "photoIds must be an array" });
    await reorderRoomPhotos(id, hotelId, photoIds);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Reorder failed" });
  }
}