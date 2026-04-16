// src/routes/booking.routes.ts
import { Router } from "express";
import { createBooking,getBookings,updateBookingStatus,getBookingSummary,editBooking,getBookingById } from "../controllers/booking.controller";
import { auth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { UserRole } from "@prisma/client";

const router = Router();

router.post("/create", auth,requireRole(UserRole.ADMIN, UserRole.MANAGER), createBooking);
router.get("/", auth, getBookings);
router.get("/summary", auth, getBookingSummary);
router.patch("/:bookingId/status", auth,requireRole(UserRole.ADMIN, UserRole.MANAGER), updateBookingStatus);
router.patch("/:bookingId", auth, requireRole(UserRole.ADMIN, UserRole.MANAGER), editBooking);
router.get("/:bookingId", auth, getBookingById);

export default router;
