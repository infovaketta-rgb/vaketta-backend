import { Request, Response, NextFunction } from "express";
import { UserRole } from "@prisma/client";
export declare function requireRole(...allowedRoles: UserRole[]): (req: Request, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
//# sourceMappingURL=role.middleware.d.ts.map