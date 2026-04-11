"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = login;
exports.getUsers = getUsers;
exports.createUser = createUser;
exports.logout = logout;
exports.changePassword = changePassword;
const auth_service_1 = require("../services/auth.service");
const client_1 = require("@prisma/client");
const jwt_1 = require("../utils/jwt");
const tokenBlocklist_1 = require("../utils/tokenBlocklist");
const hash_1 = require("../utils/hash");
const connect_1 = __importDefault(require("../db/connect"));
const CREATABLE_ROLES = [client_1.UserRole.MANAGER, client_1.UserRole.STAFF];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) { return EMAIL_RE.test(email); }
async function login(req, res) {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: "email and password are required" });
        }
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: "Invalid email format" });
        }
        const result = await (0, auth_service_1.loginService)(email, password);
        res.json(result);
    }
    catch (e) {
        res.status(401).json({ error: e.message });
    }
}
async function getUsers(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const users = await (0, auth_service_1.getUsersService)(hotelId);
        res.json(users);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
}
async function createUser(req, res) {
    try {
        const hotelId = req.user.hotelId;
        const { name, email, password, role } = req.body;
        if (!name || !email || !password || !role) {
            return res.status(400).json({ error: "name, email, password and role are required" });
        }
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: "Invalid email format" });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: "Password must be at least 8 characters" });
        }
        if (!CREATABLE_ROLES.includes(role)) {
            return res.status(400).json({ error: `Role must be one of: ${CREATABLE_ROLES.join(", ")}` });
        }
        const user = await (0, auth_service_1.createUserService)({ name, email, password, role, hotelId });
        res.json(user);
    }
    catch (e) {
        res.status(400).json({ error: e.message });
    }
}
async function logout(req, res) {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        if (token) {
            const decoded = (0, jwt_1.verifyToken)(token);
            await (0, tokenBlocklist_1.blockToken)(decoded.jti, decoded.exp);
        }
        res.json({ message: "Logged out successfully" });
    }
    catch {
        // Even if token is already invalid, treat as successful logout
        res.json({ message: "Logged out successfully" });
    }
}
async function changePassword(req, res) {
    try {
        const userId = req.user.id;
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: "currentPassword and newPassword are required" });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: "New password must be at least 8 characters" });
        }
        const user = await connect_1.default.user.findUnique({ where: { id: userId } });
        if (!user)
            return res.status(404).json({ error: "User not found" });
        const valid = await (0, hash_1.comparePassword)(currentPassword, user.password);
        if (!valid)
            return res.status(400).json({ error: "Current password is incorrect" });
        const hashed = await (0, hash_1.hashPassword)(newPassword);
        await connect_1.default.user.update({ where: { id: userId }, data: { password: hashed } });
        // Revoke all existing tokens for this user across all devices
        await (0, tokenBlocklist_1.invalidateUserTokens)(userId);
        res.json({ message: "Password changed successfully. Please log in again." });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
}
//# sourceMappingURL=auth.controller.js.map