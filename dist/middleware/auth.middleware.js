"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auth = auth;
const jwt_1 = require("../utils/jwt");
const tokenBlocklist_1 = require("../utils/tokenBlocklist");
async function auth(req, res, next) {
    const header = req.headers.authorization;
    if (!header)
        return res.sendStatus(401);
    const token = header.split(" ")[1];
    if (!token)
        return res.sendStatus(401);
    try {
        const decoded = (0, jwt_1.verifyToken)(token);
        const blocked = await (0, tokenBlocklist_1.isTokenBlocked)(decoded.jti, decoded.id, decoded.iat);
        if (blocked)
            return res.status(401).json({ error: "Token has been revoked" });
        req.user = decoded;
        next();
    }
    catch {
        res.sendStatus(401);
    }
}
//# sourceMappingURL=auth.middleware.js.map