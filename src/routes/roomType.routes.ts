import { Router } from "express";
import {
  createRoomTypeController,
  getRoomTypesController,
  updateRoomTypeController,
  deleteRoomTypeController,
} from "../controllers/roomType.controller";
import { auth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { UserRole } from "@prisma/client";

const router = Router();

router.get("/", auth, getRoomTypesController);
router.post("/", auth, requireRole(UserRole.ADMIN), createRoomTypeController);
router.put("/:id", auth, requireRole(UserRole.ADMIN), updateRoomTypeController);
router.delete("/:id", auth, requireRole(UserRole.ADMIN), deleteRoomTypeController);

export default router;