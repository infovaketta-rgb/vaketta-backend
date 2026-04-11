import { Request,Response } from "express";
import { loginService,createUserService,getUsersService } from "../services/auth.service";
import { UserRole } from "@prisma/client";
import { verifyToken } from "../utils/jwt";
import { blockToken, invalidateUserTokens } from "../utils/tokenBlocklist";
import { comparePassword, hashPassword } from "../utils/hash";
import prisma from "../db/connect";

const CREATABLE_ROLES: UserRole[] = [UserRole.MANAGER, UserRole.STAFF];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email: string) { return EMAIL_RE.test(email); }

export async function login(req:Request,res:Response){
  try{
    const { email,password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const result = await loginService(email,password);
    res.json(result);
  }catch(e:any){
    res.status(401).json({error:e.message});
  }
}

export async function getUsers(req:Request,res:Response){
  try{
    const hotelId = (req as any).user.hotelId;
    const users = await getUsersService(hotelId);
    res.json(users);
  }catch(e:any){
    res.status(500).json({error:e.message});
  }
}

export async function createUser(req:Request,res:Response){
  try{
    const hotelId = (req as any).user.hotelId;
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "name, email, password and role are required" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    if (!CREATABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${CREATABLE_ROLES.join(", ")}` });
    }

    const user = await createUserService({ name, email, password, role, hotelId });
    res.json(user);
  }catch(e:any){
    res.status(400).json({error:e.message});
  }
}

export async function logout(req: Request, res: Response) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (token) {
      const decoded = verifyToken(token);
      await blockToken(decoded.jti, decoded.exp);
    }
    res.json({ message: "Logged out successfully" });
  } catch {
    // Even if token is already invalid, treat as successful logout
    res.json({ message: "Logged out successfully" });
  }
}

export async function changePassword(req: Request, res: Response) {
  try {
    const userId = (req as any).user.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "currentPassword and newPassword are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const valid = await comparePassword(currentPassword, user.password);
    if (!valid) return res.status(400).json({ error: "Current password is incorrect" });

    const hashed = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: userId }, data: { password: hashed } });

    // Revoke all existing tokens for this user across all devices
    await invalidateUserTokens(userId);

    res.json({ message: "Password changed successfully. Please log in again." });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}
