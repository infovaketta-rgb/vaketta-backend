"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireRole = requireRole;
function requireRole(...allowedRoles) {
    return (req, res, next) => {
        const user = req.user;
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
//# sourceMappingURL=role.middleware.js.map