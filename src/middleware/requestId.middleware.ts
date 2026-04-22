import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  (req as any).requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}
