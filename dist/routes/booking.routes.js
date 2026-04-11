"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/booking.routes.ts
const express_1 = require("express");
const booking_controller_1 = require("../controllers/booking.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const role_middleware_1 = require("../middleware/role.middleware");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
router.post("/create", auth_middleware_1.auth, (0, role_middleware_1.requireRole)(client_1.UserRole.ADMIN, client_1.UserRole.MANAGER), booking_controller_1.createBooking);
router.get("/", auth_middleware_1.auth, booking_controller_1.getBookings);
router.get("/summary", auth_middleware_1.auth, booking_controller_1.getBookingSummary);
router.patch("/:bookingId/status", auth_middleware_1.auth, (0, role_middleware_1.requireRole)(client_1.UserRole.ADMIN, client_1.UserRole.MANAGER), booking_controller_1.updateBookingStatus);
router.patch("/:bookingId", auth_middleware_1.auth, (0, role_middleware_1.requireRole)(client_1.UserRole.ADMIN, client_1.UserRole.MANAGER), booking_controller_1.editBooking);
exports.default = router;
//# sourceMappingURL=booking.routes.js.map