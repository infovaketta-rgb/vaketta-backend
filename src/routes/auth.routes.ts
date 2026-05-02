import { Router } from "express";
import { login, logout, createUser, getUsers, updateUser, changePassword } from "../controllers/auth.controller";
import { auth } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { UserRole } from "@prisma/client";

const router = Router();

router.post("/login", login);
router.post("/logout", auth, logout);
router.post("/change-password", auth, changePassword);

router.get("/users", auth, requireRole(UserRole.ADMIN), getUsers);
router.post("/create-user", auth, requireRole(UserRole.ADMIN), createUser);
router.patch("/users/:id", auth, requireRole(UserRole.ADMIN), updateUser);

export default router;
