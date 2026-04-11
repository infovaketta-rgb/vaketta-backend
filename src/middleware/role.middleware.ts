
import { Request, Response, NextFunction } from "express";
import { UserRole } from "@prisma/client";

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    next();
  };
}

/*export function allowRoles(...roles:string[]){
  return (req:any,res:any,next:any)=>{
    if(!roles.includes(req.user.role))
      return res.sendStatus(403);

    next();
  };
}*/
