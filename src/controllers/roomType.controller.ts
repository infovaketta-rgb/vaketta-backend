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

// ── Occupancy / pricing field validation ─────────────────────────────────────
type OccupancyPricing = {
  baseAdults?:       number;
  baseChildren?:     number;
  extraAdultCharge?: number;
  allowExtraBed?:    boolean;
  extraBedCharge?:   number;
};

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/**
 * Validates + normalizes the six occupancy/pricing fields from a request body.
 * Only keys actually provided are returned, so omitted fields fall back to the
 * service-layer defaults (mirrors how capacity/maxAdults are handled).
 */
function parseOccupancyPricing(
  body: any,
): { values: OccupancyPricing } | { error: string } {
  const values: OccupancyPricing = {};

  // Bounded integer fields: [key, min, max?]
  const intSpecs: Array<[keyof OccupancyPricing, number, number?]> = [
    ["baseAdults", 1],
    ["baseChildren", 0],
  ];
  for (const [key, min, max] of intSpecs) {
    if (isBlank(body[key])) continue;
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
      return {
        error: `${key} must be an integer >= ${min}${max !== undefined ? ` and <= ${max}` : ""}`,
      };
    }
    (values as any)[key] = n;
  }

  // Non-negative float fields
  for (const key of ["extraAdultCharge", "extraBedCharge"] as const) {
    if (isBlank(body[key])) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 0) {
      return { error: `${key} must be a number >= 0` };
    }
    (values as any)[key] = n;
  }

  // Boolean (defaults to false at the service layer when omitted)
  if (!isBlank(body.allowExtraBed)) {
    values.allowExtraBed = body.allowExtraBed === true || body.allowExtraBed === "true";
  }

  return { values };
}



export async function createRoomTypeController(req: Request, res: Response) {
  try {
    const hotelId = (req as any).user?.hotelId; // ✅ fixed
    if (!hotelId) return res.status(401).json({ error: "Unauthorized" });

    const { name, description, basePrice, capacity, maxAdults, maxChildren, totalRooms, carouselButtonLabel } = req.body;

    if (!name || !basePrice) {
      return res.status(400).json({ error: "Name and basePrice are required" });
    }

    // Meta's quick_reply.title is capped at 20 chars; reject longer values up front.
    if (typeof carouselButtonLabel === "string" && carouselButtonLabel.length > 20) {
      return res.status(400).json({ error: "carouselButtonLabel must be 20 characters or fewer" });
    }

    const occ = parseOccupancyPricing(req.body);
    if ("error" in occ) return res.status(400).json({ error: occ.error });

    const roomType = await createRoomType({
      hotelId,
      name,
      basePrice:   Number(basePrice),
      ...(typeof description === "string" ? { description } : {}),
      ...(capacity    ? { capacity:    Number(capacity)    } : {}),
      ...(maxAdults   ? { maxAdults:   Number(maxAdults)   } : {}),
      ...(maxChildren ? { maxChildren: Number(maxChildren) } : {}),
      ...(totalRooms  ? { totalRooms:  Number(totalRooms)  } : {}),
      ...(typeof carouselButtonLabel === "string" ? { carouselButtonLabel: carouselButtonLabel.trim() } : {}),
      ...occ.values,
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
    const { name, description, basePrice, capacity, maxAdults, maxChildren, totalRooms, carouselButtonLabel } = req.body;

    if (!name || !basePrice) {
      return res.status(400).json({ error: "Name and basePrice are required" });
    }

    if (typeof carouselButtonLabel === "string" && carouselButtonLabel.length > 20) {
      return res.status(400).json({ error: "carouselButtonLabel must be 20 characters or fewer" });
    }

    const occ = parseOccupancyPricing(req.body);
    if ("error" in occ) return res.status(400).json({ error: occ.error });

    const roomType = await updateRoomType({
      id,
      hotelId,
      name,
      basePrice:   Number(basePrice),
      ...(typeof description === "string" ? { description } : {}),
      ...(capacity    ? { capacity:    Number(capacity)    } : {}),
      ...(maxAdults   ? { maxAdults:   Number(maxAdults)   } : {}),
      ...(maxChildren ? { maxChildren: Number(maxChildren) } : {}),
      ...(totalRooms  ? { totalRooms:  Number(totalRooms)  } : {}),
      ...(typeof carouselButtonLabel === "string" ? { carouselButtonLabel: carouselButtonLabel.trim() } : {}),
      ...occ.values,
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