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
