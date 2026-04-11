import jwt from "jsonwebtoken";
import crypto from "crypto";

export type JwtPayload = {
  jti: string;   // unique token ID — used for blocklist
  id: string;    // user ID
  role: string;
  hotelId: string;
  iat: number;   // issued at (unix seconds, set by jsonwebtoken)
  exp: number;   // expires at (unix seconds, set by jsonwebtoken)
};

export function signToken(payload: { id: string; role: string; hotelId: string }): string {
  return jwt.sign(
    { ...payload, jti: crypto.randomUUID() },
    process.env.JWT_SECRET!,
    { expiresIn: "7d" }
  );
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
}
