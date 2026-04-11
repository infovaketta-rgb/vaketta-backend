import { Request, Response, NextFunction } from "express";
/**
 * Vaketta platform-level admin auth.
 * Reads JWT from httpOnly cookie first, falls back to Authorization header.
 * Verifies type: "vaketta_admin" — hotel staff tokens are rejected.
 */
export declare function vakettaAdminAuth(req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=vakettaAdminAuth.d.ts.map