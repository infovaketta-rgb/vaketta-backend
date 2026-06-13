// src/routes/booking.routes.ts
import { Router } from "express";
import { createBooking,getBookings,updateBookingStatus,getBookingSummary,editBooking,getBookingById,exportBookingsCsv,bulkUpdateBookingStatus,confirmBookingOptions,confirmBookingPreview,confirmBooking } from "../controllers/booking.controller";
import { auth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { UserRole } from "@prisma/client";

const router = Router();

router.post("/create",      auth, requireRole(UserRole.ADMIN, UserRole.MANAGER), createBooking);
router.post("/bulk-status", auth, requireRole(UserRole.ADMIN, UserRole.MANAGER), bulkUpdateBookingStatus);
router.get("/export",       auth, requireRole(UserRole.ADMIN, UserRole.MANAGER), exportBookingsCsv);
router.get("/", auth, getBookings);
router.get("/summary", auth, getBookingSummary);
router.get("/:bookingId/confirm-options",  auth, requireRole(UserRole.ADMIN, UserRole.MANAGER), confirmBookingOptions);
router.get("/:bookingId/confirm-preview", auth, requireRole(UserRole.ADMIN, UserRole.MANAGER), confirmBookingPreview);
router.post("/:bookingId/confirm",         auth, requireRole(UserRole.ADMIN, UserRole.MANAGER), confirmBooking);
router.patch("/:bookingId/status", auth,requireRole(UserRole.ADMIN, UserRole.MANAGER), updateBookingStatus);
router.patch("/:bookingId", auth, requireRole(UserRole.ADMIN, UserRole.MANAGER), editBooking);
router.get("/:bookingId", auth, getBookingById);

export default router;
