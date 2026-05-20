import jwt from "jsonwebtoken";
import crypto from "crypto";

export type VakettaAdminPayload = {
  jti: string;
  id: string;
  email: string;
  name: string;
  type: "vaketta_admin"; // discriminator — never accepted on hotel routes
  iat: number;
  exp: number;
};

export function signVakettaToken(payload: { id: string; email: string; name: string }): string {
  return jwt.sign(
    { ...payload, type: "vaketta_admin", jti: crypto.randomUUID() },
    process.env.JWT_SECRET!,
    { expiresIn: "8h" }
  );
}

export function verifyVakettaToken(token: string): VakettaAdminPayload {
  const decoded = jwt.verify(token, process.env.JWT_SECRET!) as VakettaAdminPayload;
  if (decoded.type !== "vaketta_admin") {
    throw new Error("Invalid token type");
  }
  return decoded;
}

// ── Short-lived socket tokens (used only during WebSocket handshake) ──────────

export type AdminSocketTokenPayload = {
  id: string;
  email: string;
  name: string;
  type: "vaketta_admin_socket";
};

export function issueSocketToken(admin: { id: string; email: string; name: string }): string {
  return jwt.sign(
    { ...admin, type: "vaketta_admin_socket" },
    process.env.JWT_SECRET!,
    { expiresIn: "120s" }
  );
}

export function verifySocketToken(token: string): AdminSocketTokenPayload {
  const decoded = jwt.verify(token, process.env.JWT_SECRET!) as AdminSocketTokenPayload;
  if (decoded.type !== "vaketta_admin_socket") throw new Error("Invalid socket token type");
  return decoded;
}
