import { Router } from "express";
import { login, logout, createUser, getUsers, updateUser, changePassword, forgotPassword, resetPassword } from "../controllers/auth.controller";
import { auth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { UserRole } from "@prisma/client";

const router = Router();

router.post("/login", login);
router.post("/logout", auth, logout);
router.post("/change-password", auth, changePassword);

// Public — password reset via emailed OTP (rate-limited in app.ts)
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

router.get("/users", auth, requireRole(UserRole.ADMIN), getUsers);
router.post("/create-user", auth, requireRole(UserRole.ADMIN), createUser);
router.patch("/users/:id", auth, requireRole(UserRole.ADMIN), updateUser);

export default router;
