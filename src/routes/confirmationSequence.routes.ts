import { Router } from "express";
import { requireRole } from "../middleware/role.middleware";
import { UserRole } from "@prisma/client";
import {
  listConfirmationSequences,
  createConfirmationSequence,
  updateConfirmationSequence,
  deleteConfirmationSequence,
} from "../controllers/confirmationSequence.controller";

// `auth` is applied at mount time in app.ts. hotelId is always taken from the JWT
// inside each handler — never from the request body — so a hotel can only ever
// read/modify its own sequences.
const router = Router();

router.get("/",     requireRole(UserRole.ADMIN, UserRole.MANAGER), listConfirmationSequences);
router.post("/",    requireRole(UserRole.ADMIN, UserRole.MANAGER), createConfirmationSequence);
router.put("/:id",  requireRole(UserRole.ADMIN, UserRole.MANAGER), updateConfirmationSequence);
router.delete("/:id", requireRole(UserRole.ADMIN, UserRole.MANAGER), deleteConfirmationSequence);

export default router;
