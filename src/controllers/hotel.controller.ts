import { Request, Response } from "express";
import { createHotel } from "../services/hotel.service";
import {
  adminLoginService,
  listHotelsService,
  getHotelService,
  updateHotelService,
  deleteHotelService,
  listAdminsService,
  createAdminService,
  deleteAdminService,
  updateAdminSettingsService,
  createHotelUserService,
  updateHotelUserService,
  deleteHotelUserService,
} from "../services/admin.service";
import { blockToken } from "../utils/tokenBlocklist";
import { verifyVakettaToken } from "../utils/vakettaJwt";

const COOKIE_NAME = "vaketta_token";
const isProd = process.env.NODE_ENV === "production";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: isProd,
  // cross-origin in prod (vaketta.com → onrender.com) requires "none" + secure:true
  // "strict" in dev is fine (both localhost)
  sameSite: (isProd ? "none" : "strict") as "none" | "strict",
  maxAge: 8 * 60 * 60 * 1000, // 8 hours — matches JWT expiry
};

// ─── Vaketta Admin Auth ────────────────────────────────────────────────────

export async function adminLogin(req: Request, res: Response) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    const { token, admin } = await adminLoginService(email, password);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ admin }); // token NOT in body — stored in httpOnly cookie
  } catch (e: any) {
    res.status(401).json({ error: e.message });
  }
}

export async function adminLogout(req: Request, res: Response) {
  try {
    const token = (req as any).cookies?.[COOKIE_NAME];
    if (token) {
      const decoded = verifyVakettaToken(token);
      await blockToken(decoded.jti, decoded.exp);
    }
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: isProd ? "none" : "strict", secure: isProd });
    res.json({ success: true });
  } catch {
    res.json({ success: true }); // always succeed — cookie cleared regardless
  }
}

export async function getMeHandler(req: Request, res: Response) {
  // vakettaAdminAuth already decoded the token — just return the admin payload
  res.json({ admin: (req as any).vakettaAdmin });
}

// ─── Hotel CRUD ────────────────────────────────────────────────────────────

export async function createHotelHandler(req: Request, res: Response) {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: "name and phone are required" });
    }
    const hotel = await createHotel(name, phone);
    res.status(201).json(hotel);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}

export async function listHotelsHandler(req: Request, res: Response) {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  ?? 1), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? 20), 10) || 20));
    const search = req.query.search ? String(req.query.search).trim() : undefined;
    const result = await listHotelsService(page, limit, search);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export async function getHotelHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "id required" });
    const hotel = await getHotelService(id);
    res.json(hotel);
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
}

export async function updateHotelHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "id required" });
    const { name, phone } = req.body;
    const hotel = await updateHotelService(id, { name, phone });
    res.json(hotel);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}

export async function deleteHotelHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "id required" });
    await deleteHotelService(id);
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}

// ─── Vaketta Admin User Management ────────────────────────────────────────────

export async function listAdminsHandler(_req: Request, res: Response) {
  try {
    const admins = await listAdminsService();
    res.json(admins);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

export async function createAdminHandler(req: Request, res: Response) {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email and password are required" });
    }
    const admin = await createAdminService(name, email, password, role);
    res.status(201).json(admin);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}

export async function deleteAdminHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "id required" });
    const requesterId = (req as any).vakettaAdmin.id;
    await deleteAdminService(id, requesterId);
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}

export async function updateSettingsHandler(req: Request, res: Response) {
  try {
    const id = (req as any).vakettaAdmin.id;
    const { name, email, currentPassword, newPassword } = req.body;
    const updated = await updateAdminSettingsService(id, { name, email, currentPassword, newPassword });

    if (newPassword) {
      // Password changed — blocklist current token and clear cookie to force re-login
      const token = (req as any).cookies?.[COOKIE_NAME];
      if (token) {
        try {
          const decoded = verifyVakettaToken(token);
          await blockToken(decoded.jti, decoded.exp);
        } catch { /* ignore decode errors */ }
      }
      res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: isProd ? "none" : "strict", secure: isProd });
    }

    res.json({ admin: updated, passwordChanged: !!newPassword });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}

// ─── Hotel User Management ────────────────────────────────────────────────────

export async function createHotelUserHandler(req: Request, res: Response) {
  try {
    const hotelId = req.params.id;
    if (!hotelId) return res.status(400).json({ error: "hotelId required" });
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "name, email, password and role are required" });
    }
    const user = await createHotelUserService(hotelId, { name, email, password, role });
    res.status(201).json(user);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}

export async function updateHotelUserHandler(req: Request, res: Response) {
  try {
    const hotelId = req.params.id;
    const userId = req.params.userId;
    if (!hotelId || !userId) return res.status(400).json({ error: "hotelId and userId required" });
    const { name, email, role, isActive } = req.body;
    const user = await updateHotelUserService(userId, hotelId, { name, email, role, isActive });
    res.json(user);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}

export async function deleteHotelUserHandler(req: Request, res: Response) {
  try {
    const hotelId = req.params.id;
    const userId = req.params.userId;
    if (!hotelId || !userId) return res.status(400).json({ error: "hotelId and userId required" });
    await deleteHotelUserService(userId, hotelId);
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
}
