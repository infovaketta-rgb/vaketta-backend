"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signVakettaToken = signVakettaToken;
exports.verifyVakettaToken = verifyVakettaToken;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
function signVakettaToken(payload) {
    return jsonwebtoken_1.default.sign({ ...payload, type: "vaketta_admin", jti: crypto_1.default.randomUUID() }, process.env.JWT_SECRET, { expiresIn: "8h" });
}
function verifyVakettaToken(token) {
    const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== "vaketta_admin") {
        throw new Error("Invalid token type");
    }
    return decoded;
}
//# sourceMappingURL=vakettaJwt.js.map