"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("../controllers/auth.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const role_middleware_1 = require("../middleware/role.middleware");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
router.post("/login", auth_controller_1.login);
router.post("/logout", auth_middleware_1.auth, auth_controller_1.logout);
router.post("/change-password", auth_middleware_1.auth, auth_controller_1.changePassword);
router.get("/users", auth_middleware_1.auth, (0, role_middleware_1.requireRole)(client_1.UserRole.ADMIN), auth_controller_1.getUsers);
router.post("/create-user", auth_middleware_1.auth, (0, role_middleware_1.requireRole)(client_1.UserRole.ADMIN), auth_controller_1.createUser);
exports.default = router;
//# sourceMappingURL=auth.routes.js.map