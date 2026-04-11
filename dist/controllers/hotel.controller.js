"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminLogin = adminLogin;
exports.adminLogout = adminLogout;
exports.getMeHandler = getMeHandler;
exports.createHotelHandler = createHotelHandler;
exports.listHotelsHandler = listHotelsHandler;
exports.getHotelHandler = getHotelHandler;
exports.updateHotelHandler = updateHotelHandler;
exports.deleteHotelHandler = deleteHotelHandler;
exports.listAdminsHandler = listAdminsHandler;
exports.createAdminHandler = createAdminHandler;
exports.deleteAdminHandler = deleteAdminHandler;
exports.updateSettingsHandler = updateSettingsHandler;
exports.createHotelUserHandler = createHotelUserHandler;
exports.updateHotelUserHandler = updateHotelUserHandler;
exports.deleteHotelUserHandler = deleteHotelUserHandler;
const hotel_service_1 = require("../services/hotel.service");
const admin_service_1 = require("../services/admin.service");
const tokenBlocklist_1 = require("../utils/tokenBlocklist");
const vakettaJwt_1 = require("../utils/vakettaJwt");
const COOKIE_NAME = "vaketta_token";
const COOKIE_OPTS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000, // 8 hours — matches JWT expiry
};
// ─── Vaketta Admin Auth ────────────────────────────────────────────────────
async function adminLogin(req, res) {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: "email and password are required" });
        }
        const { token, admin } = await (0, admin_service_1.adminLoginService)(email, password);
        res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
        res.json({ admin }); // token NOT in body — stored in httpOnly cookie
    }
    catch (e) {
        res.status(401).json({ error: e.message });
    }
}
async function adminLogout(req, res) {
    try {
        const token = req.cookies?.[COOKIE_NAME];
        if (token) {
            const decoded = (0, vakettaJwt_1.verifyVakettaToken)(token);
            await (0, tokenBlocklist_1.blockToken)(decoded.jti, decoded.exp);
        }
        res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production" });
        res.json({ success: true });
    }
    catch {
        res.json({ success: true }); // always succeed — cookie cleared regardless
    }
}
async function getMeHandler(req, res) {
    // vakettaAdminAuth already decoded the token — just return the admin payload
    res.json({ admin: req.vakettaAdmin });
}
// ─── Hotel CRUD ────────────────────────────────────────────────────────────
async function createHotelHandler(req, res) {
    try {
        const { name, phone } = req.body;
        if (!name || !phone) {
            return res.status(400).json({ error: "name and phone are required" });
        }
        const hotel = await (0, hotel_service_1.createHotel)(name, phone);
        res.status(201).json(hotel);
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
}
async function listHotelsHandler(req, res) {
    try {
        const page = Math.max(1, parseInt(String(req.query.page ?? 1), 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? 20), 10) || 20));
        const search = req.query.search ? String(req.query.search).trim() : undefined;
        const result = await (0, admin_service_1.listHotelsService)(page, limit, search);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
}
async function getHotelHandler(req, res) {
    try {
        const { id } = req.params;
        if (!id)
            return res.status(400).json({ error: "id required" });
        const hotel = await (0, admin_service_1.getHotelService)(id);
        res.json(hotel);
    }
    catch (e) {
        res.status(404).json({ error: e.message });
    }
}
async function updateHotelHandler(req, res) {
    try {
        const { id } = req.params;
        if (!id)
            return res.status(400).json({ error: "id required" });
        const { name, phone } = req.body;
        const hotel = await (0, admin_service_1.updateHotelService)(id, { name, phone });
        res.json(hotel);
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
}
async function deleteHotelHandler(req, res) {
    try {
        const { id } = req.params;
        if (!id)
            return res.status(400).json({ error: "id required" });
        await (0, admin_service_1.deleteHotelService)(id);
        res.json({ success: true });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
}
// ─── Vaketta Admin User Management ────────────────────────────────────────────
async function listAdminsHandler(_req, res) {
    try {
        const admins = await (0, admin_service_1.listAdminsService)();
        res.json(admins);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
}
async function createAdminHandler(req, res) {
    try {
        const { name, email, password, role } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ error: "name, email and password are required" });
        }
        const admin = await (0, admin_service_1.createAdminService)(name, email, password, role);
        res.status(201).json(admin);
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
}
async function deleteAdminHandler(req, res) {
    try {
        const { id } = req.params;
        if (!id)
            return res.status(400).json({ error: "id required" });
        const requesterId = req.vakettaAdmin.id;
        await (0, admin_service_1.deleteAdminService)(id, requesterId);
        res.json({ success: true });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
}
async function updateSettingsHandler(req, res) {
    try {
        const id = req.vakettaAdmin.id;
        const { name, email, currentPassword, newPassword } = req.body;
        const updated = await (0, admin_service_1.updateAdminSettingsService)(id, { name, email, currentPassword, newPassword });
        if (newPassword) {
            // Password changed — blocklist current token and clear cookie to force re-login
            const token = req.cookies?.[COOKIE_NAME];
            if (token) {
                try {
                    const decoded = (0, vakettaJwt_1.verifyVakettaToken)(token);
                    await (0, tokenBlocklist_1.blockToken)(decoded.jti, decoded.exp);
                }
                catch { /* ignore decode errors */ }
            }
            res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production" });
        }
        res.json({ admin: updated, passwordChanged: !!newPassword });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
}
// ─── Hotel User Management ────────────────────────────────────────────────────
async function createHotelUserHandler(req, res) {
    try {
        const hotelId = req.params.id;
        if (!hotelId)
            return res.status(400).json({ error: "hotelId required" });
        const { name, email, password, role } = req.body;
        if (!name || !email || !password || !role) {
            return res.status(400).json({ error: "name, email, password and role are required" });
        }
        const user = await (0, admin_service_1.createHotelUserService)(hotelId, { name, email, password, role });
        res.status(201).json(user);
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
}
async function updateHotelUserHandler(req, res) {
    try {
        const hotelId = req.params.id;
        const userId = req.params.userId;
        if (!hotelId || !userId)
            return res.status(400).json({ error: "hotelId and userId required" });
        const { name, email, role, isActive } = req.body;
        const user = await (0, admin_service_1.updateHotelUserService)(userId, hotelId, { name, email, role, isActive });
        res.json(user);
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
}
async function deleteHotelUserHandler(req, res) {
    try {
        const hotelId = req.params.id;
        const userId = req.params.userId;
        if (!hotelId || !userId)
            return res.status(400).json({ error: "hotelId and userId required" });
        await (0, admin_service_1.deleteHotelUserService)(userId, hotelId);
        res.json({ success: true });
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
}
//# sourceMappingURL=hotel.controller.js.map