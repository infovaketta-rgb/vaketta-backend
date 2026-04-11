"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const roomType_controller_1 = require("../controllers/roomType.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const role_middleware_1 = require("../middleware/role.middleware");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
router.get("/", auth_middleware_1.auth, roomType_controller_1.getRoomTypesController);
router.post("/", auth_middleware_1.auth, (0, role_middleware_1.requireRole)(client_1.UserRole.ADMIN), roomType_controller_1.createRoomTypeController);
router.put("/:id", auth_middleware_1.auth, (0, role_middleware_1.requireRole)(client_1.UserRole.ADMIN), roomType_controller_1.updateRoomTypeController);
router.delete("/:id", auth_middleware_1.auth, (0, role_middleware_1.requireRole)(client_1.UserRole.ADMIN), roomType_controller_1.deleteRoomTypeController);
exports.default = router;
//# sourceMappingURL=roomType.routes.js.map