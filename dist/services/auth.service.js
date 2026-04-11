"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginService = loginService;
exports.getUsersService = getUsersService;
exports.createUserService = createUserService;
const connect_1 = __importDefault(require("../db/connect"));
const hash_1 = require("../utils/hash");
const jwt_1 = require("../utils/jwt");
async function loginService(email, password) {
    const user = await connect_1.default.user.findUnique({
        where: { email },
        include: { hotel: true }
    });
    if (!user)
        throw new Error("Invalid credentials");
    if (!user.isActive)
        throw new Error("Account is disabled. Contact your administrator.");
    const valid = await (0, hash_1.comparePassword)(password, user.password);
    if (!valid)
        throw new Error("Invalid credentials");
    const token = (0, jwt_1.signToken)({
        id: user.id,
        role: user.role,
        hotelId: user.hotelId
    });
    const { password: _pw, ...safeUser } = user;
    return { token, user: safeUser };
}
async function getUsersService(hotelId) {
    return connect_1.default.user.findMany({
        where: { hotelId },
        select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
        orderBy: { createdAt: "asc" },
    });
}
async function createUserService(data) {
    const hashed = await (0, hash_1.hashPassword)(data.password);
    const existing = await connect_1.default.user.findUnique({
        where: { email: data.email }
    });
    if (existing)
        throw new Error("Email already exists");
    return connect_1.default.user.create({
        data: { ...data, password: hashed },
        select: { id: true, name: true, email: true, role: true, hotelId: true, createdAt: true },
    });
}
//# sourceMappingURL=auth.service.js.map