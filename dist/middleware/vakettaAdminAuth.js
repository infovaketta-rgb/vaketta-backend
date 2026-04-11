"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.vakettaAdminAuth = vakettaAdminAuth;
const vakettaJwt_1 = require("../utils/vakettaJwt");
const tokenBlocklist_1 = require("../utils/tokenBlocklist");
const COOKIE_NAME = "vaketta_token";
/**
 * Vaketta platform-level admin auth.
 * Reads JWT from httpOnly cookie first, falls back to Authorization header.
 * Verifies type: "vaketta_admin" — hotel staff tokens are rejected.
 */
async function vakettaAdminAuth(req, res, next) {
    const token = req.cookies?.[COOKIE_NAME]
        ?? req.headers.authorization?.split(" ")[1];
    if (!token)
        return res.status(401).json({ error: "Unauthorized" });
    try {
        const decoded = (0, vakettaJwt_1.verifyVakettaToken)(token); // throws if not type: "vaketta_admin"
        const blocked = await (0, tokenBlocklist_1.isTokenBlocked)(decoded.jti, decoded.id, decoded.iat);
        if (blocked)
            return res.status(401).json({ error: "Token has been revoked" });
        req.vakettaAdmin = decoded;
        next();
    }
    catch {
        res.status(401).json({ error: "Unauthorized" });
    }
}
//# sourceMappingURL=vakettaAdminAuth.js.map