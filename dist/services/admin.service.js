"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminLoginService = adminLoginService;
exports.listHotelsService = listHotelsService;
exports.getHotelService = getHotelService;
exports.updateHotelService = updateHotelService;
exports.deleteHotelService = deleteHotelService;
exports.listAdminsService = listAdminsService;
exports.createAdminService = createAdminService;
exports.deleteAdminService = deleteAdminService;
exports.createHotelUserService = createHotelUserService;
exports.updateHotelUserService = updateHotelUserService;
exports.deleteHotelUserService = deleteHotelUserService;
exports.updateAdminSettingsService = updateAdminSettingsService;
const connect_1 = __importDefault(require("../db/connect"));
const hash_1 = require("../utils/hash");
const vakettaJwt_1 = require("../utils/vakettaJwt");
const client_1 = require("@prisma/client");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = [
    client_1.VakettaAdminRole.SUPER_ADMIN,
    client_1.VakettaAdminRole.ADMIN,
    client_1.VakettaAdminRole.SUPPORT,
];
async function adminLoginService(email, password) {
    const admin = await connect_1.default.vakettaAdmin.findUnique({ where: { email } });
    if (!admin)
        throw new Error("Invalid credentials");
    const valid = await (0, hash_1.comparePassword)(password, admin.password);
    if (!valid)
        throw new Error("Invalid credentials");
    const token = (0, vakettaJwt_1.signVakettaToken)({ id: admin.id, email: admin.email, name: admin.name });
    const { password: _pw, ...safeAdmin } = admin;
    return { token, admin: safeAdmin };
}
async function listHotelsService(page = 1, limit = 20, search) {
    const where = search
        ? { name: { contains: search, mode: "insensitive" } }
        : {};
    const skip = (page - 1) * limit;
    const [hotels, total] = await Promise.all([
        connect_1.default.hotel.findMany({
            where,
            include: {
                config: true,
                _count: { select: { users: true, guests: true, bookings: true } },
            },
            orderBy: { createdAt: "desc" },
            skip,
            take: limit,
        }),
        connect_1.default.hotel.count({ where }),
    ]);
    return { hotels, total, page, limit, pages: Math.ceil(total / limit) };
}
async function getHotelService(id) {
    const hotel = await connect_1.default.hotel.findUnique({
        where: { id },
        include: {
            config: true,
            plan: true,
            users: { select: { id: true, name: true, email: true, role: true, isActive: true } },
            roomTypes: true,
            _count: { select: { guests: true, bookings: true, messages: true } },
        },
    });
    if (!hotel)
        throw new Error("Hotel not found");
    return hotel;
}
async function updateHotelService(id, data) {
    const hotel = await connect_1.default.hotel.findUnique({ where: { id } });
    if (!hotel)
        throw new Error("Hotel not found");
    return connect_1.default.hotel.update({ where: { id }, data });
}
async function deleteHotelService(id) {
    const hotel = await connect_1.default.hotel.findUnique({ where: { id } });
    if (!hotel)
        throw new Error("Hotel not found");
    return connect_1.default.hotel.delete({ where: { id } });
}
// ─── Vaketta Admin User Management ───────────────────────────────────────────
async function listAdminsService() {
    return connect_1.default.vakettaAdmin.findMany({
        select: { id: true, name: true, email: true, role: true, createdAt: true },
        orderBy: { createdAt: "asc" },
    });
}
async function createAdminService(name, email, password, role = client_1.VakettaAdminRole.ADMIN) {
    if (!EMAIL_RE.test(email))
        throw new Error("Invalid email address");
    if (password.length < 8)
        throw new Error("Password must be at least 8 characters");
    if (!VALID_ROLES.includes(role))
        throw new Error("Invalid role");
    const existing = await connect_1.default.vakettaAdmin.findUnique({ where: { email } });
    if (existing)
        throw new Error("Email already in use");
    const hashed = await (0, hash_1.hashPassword)(password);
    return connect_1.default.vakettaAdmin.create({
        data: { name, email, password: hashed, role },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
}
async function deleteAdminService(id, requesterId) {
    if (id === requesterId)
        throw new Error("Cannot delete your own account");
    const admin = await connect_1.default.vakettaAdmin.findUnique({ where: { id } });
    if (!admin)
        throw new Error("Admin not found");
    return connect_1.default.vakettaAdmin.delete({ where: { id } });
}
// ─── Hotel User Management (via Vaketta Admin) ───────────────────────────────
async function createHotelUserService(hotelId, data) {
    const hotel = await connect_1.default.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel)
        throw new Error("Hotel not found");
    if (!EMAIL_RE.test(data.email))
        throw new Error("Invalid email address");
    if (data.password.length < 8)
        throw new Error("Password must be at least 8 characters");
    const conflict = await connect_1.default.user.findUnique({ where: { email: data.email } });
    if (conflict)
        throw new Error("Email already in use");
    const hashed = await (0, hash_1.hashPassword)(data.password);
    return connect_1.default.user.create({
        data: { name: data.name, email: data.email, password: hashed, role: data.role, hotelId },
        select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
    });
}
async function updateHotelUserService(userId, hotelId, data) {
    const user = await connect_1.default.user.findFirst({ where: { id: userId, hotelId } });
    if (!user)
        throw new Error("User not found");
    if (data.email) {
        if (!EMAIL_RE.test(data.email))
            throw new Error("Invalid email address");
        const conflict = await connect_1.default.user.findUnique({ where: { email: data.email } });
        if (conflict && conflict.id !== userId)
            throw new Error("Email already in use");
    }
    return connect_1.default.user.update({
        where: { id: userId },
        data,
        select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
    });
}
async function deleteHotelUserService(userId, hotelId) {
    const user = await connect_1.default.user.findFirst({ where: { id: userId, hotelId } });
    if (!user)
        throw new Error("User not found");
    return connect_1.default.user.delete({ where: { id: userId } });
}
async function updateAdminSettingsService(id, data) {
    const admin = await connect_1.default.vakettaAdmin.findUnique({ where: { id } });
    if (!admin)
        throw new Error("Admin not found");
    const updates = {};
    if (data.name?.trim())
        updates.name = data.name.trim();
    if (data.email) {
        if (!EMAIL_RE.test(data.email))
            throw new Error("Invalid email address");
        const conflict = await connect_1.default.vakettaAdmin.findUnique({ where: { email: data.email } });
        if (conflict && conflict.id !== id)
            throw new Error("Email already in use");
        updates.email = data.email;
    }
    if (data.newPassword) {
        if (!data.currentPassword)
            throw new Error("Current password is required");
        if (data.newPassword.length < 8)
            throw new Error("New password must be at least 8 characters");
        const valid = await (0, hash_1.comparePassword)(data.currentPassword, admin.password);
        if (!valid)
            throw new Error("Current password is incorrect");
        updates.password = await (0, hash_1.hashPassword)(data.newPassword);
    }
    if (Object.keys(updates).length === 0)
        throw new Error("Nothing to update");
    return connect_1.default.vakettaAdmin.update({
        where: { id },
        data: updates,
        select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
}
//# sourceMappingURL=admin.service.js.map