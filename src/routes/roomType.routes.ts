import { Router } from "express";
import {
  createRoomTypeController,
  getRoomTypesController,
  updateRoomTypeController,
  deleteRoomTypeController,
  getRoomTypeByIdController,
  uploadRoomPhotoController,
  deleteRoomPhotoController,
  setMainPhotoController,
  reorderRoomPhotosController,
  uploadMiddleware,
} from "../controllers/roomType.controller";
import { auth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { UserRole } from "@prisma/client";

const router = Router();

router.get("/",                                    auth, getRoomTypesController);
router.post("/",                                   auth, requireRole(UserRole.ADMIN), createRoomTypeController);
router.get("/:id",                                 auth, getRoomTypeByIdController);
router.put("/:id",                                 auth, requireRole(UserRole.ADMIN), updateRoomTypeController);
router.delete("/:id",                              auth, requireRole(UserRole.ADMIN), deleteRoomTypeController);
router.post("/:id/photos",                         auth, requireRole(UserRole.ADMIN), uploadMiddleware, uploadRoomPhotoController);
router.delete("/:id/photos/:photoId",              auth, requireRole(UserRole.ADMIN), deleteRoomPhotoController);
router.patch("/:id/photos/:photoId/main",          auth, requireRole(UserRole.ADMIN), setMainPhotoController);
router.patch("/:id/photos/reorder",                auth, requireRole(UserRole.ADMIN), reorderRoomPhotosController);

export default router;