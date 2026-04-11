import prisma from "../db/connect";
import { comparePassword, hashPassword } from "../utils/hash";
import { signVakettaToken } from "../utils/vakettaJwt";
import { UserRole, VakettaAdminRole } from "@prisma/client";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES: VakettaAdminRole[] = [
  VakettaAdminRole.SUPER_ADMIN,
  VakettaAdminRole.ADMIN,
  VakettaAdminRole.SUPPORT,
];

export async function adminLoginService(email: string, password: string) {
  const admin = await prisma.vakettaAdmin.findUnique({ where: { email } });
  if (!admin) throw new Error("Invalid credentials");

  const valid = await comparePassword(password, admin.password);
  if (!valid) throw new Error("Invalid credentials");

  const token = signVakettaToken({ id: admin.id, email: admin.email, name: admin.name });
  const { password: _pw, ...safeAdmin } = admin;
  return { token, admin: safeAdmin };
}

export async function listHotelsService(page = 1, limit = 20, search?: string) {
  const where = search
    ? { name: { contains: search, mode: "insensitive" as const } }
    : {};
  const skip = (page - 1) * limit;
  const [hotels, total] = await Promise.all([
    prisma.hotel.findMany({
      where,
      include: {
        config: true,
        _count: { select: { users: true, guests: true, bookings: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.hotel.count({ where }),
  ]);
  return { hotels, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getHotelService(id: string) {
  const hotel = await prisma.hotel.findUnique({
    where: { id },
    include: {
      config: true,
      plan: true,
      users: { select: { id: true, name: true, email: true, role: true, isActive: true } },
      roomTypes: true,
      _count: { select: { guests: true, bookings: true, messages: true } },
    },
  });
  if (!hotel) throw new Error("Hotel not found");
  return hotel;
}

export async function updateHotelService(
  id: string,
  data: { name?: string; phone?: string }
) {
  const hotel = await prisma.hotel.findUnique({ where: { id } });
  if (!hotel) throw new Error("Hotel not found");
  return prisma.hotel.update({ where: { id }, data });
}

export async function deleteHotelService(id: string) {
  const hotel = await prisma.hotel.findUnique({ where: { id } });
  if (!hotel) throw new Error("Hotel not found");

  // Manually cascade-delete all related records in FK-safe order.
  // The schema uses default RESTRICT on most Hotel relations, so we must
  // delete children before the parent inside a single transaction.
  await prisma.$transaction(async (tx) => {
    // 1. Conversation sessions (→ Guest, → Hotel)
    await tx.conversationSession.deleteMany({ where: { hotelId: id } });

    // 2. Messages (→ Hotel, → Guest)
    await tx.message.deleteMany({ where: { hotelId: id } });

    // 3. Bookings (→ Hotel, → Guest, → RoomType)
    await tx.booking.deleteMany({ where: { hotelId: id } });

    // 4. Guests (→ Hotel)
    await tx.guest.deleteMany({ where: { hotelId: id } });

    // 5. Room inventory (→ Hotel, → RoomType)
    await tx.roomInventory.deleteMany({ where: { hotelId: id } });

    // 6. Room types — RoomPhoto cascades automatically via schema
    await tx.roomType.deleteMany({ where: { hotelId: id } });

    // 7. Subscriptions (→ Hotel)
    await tx.subscription.deleteMany({ where: { hotelId: id } });

    // 8. Usage records (→ Hotel)
    await tx.usageRecord.deleteMany({ where: { hotelId: id } });

    // 9. Flow definitions (→ Hotel) — sets HotelMenuItem.flowId to null via schema SetNull
    await tx.flowDefinition.deleteMany({ where: { hotelId: id } });

    // 10. WhatsApp menu items then the menu itself
    const menu = await tx.hotelMenu.findUnique({ where: { hotelId: id } });
    if (menu) {
      await tx.hotelMenuItem.deleteMany({ where: { menuId: menu.id } });
      await tx.hotelMenu.delete({ where: { id: menu.id } });
    }

    // 11. Hotel config (→ Hotel)
    await tx.hotelConfig.deleteMany({ where: { hotelId: id } });

    // 12. Staff users (→ Hotel)
    await tx.user.deleteMany({ where: { hotelId: id } });

    // 13. Finally delete the hotel itself
    await tx.hotel.delete({ where: { id } });
  });
}

// ─── Vaketta Admin User Management ───────────────────────────────────────────

export async function listAdminsService() {
  return prisma.vakettaAdmin.findMany({
    select: { id: true, name: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function createAdminService(
  name: string,
  email: string,
  password: string,
  role: VakettaAdminRole = VakettaAdminRole.ADMIN
) {
  if (!EMAIL_RE.test(email)) throw new Error("Invalid email address");
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  if (!VALID_ROLES.includes(role)) throw new Error("Invalid role");
  const existing = await prisma.vakettaAdmin.findUnique({ where: { email } });
  if (existing) throw new Error("Email already in use");
  const hashed = await hashPassword(password);
  return prisma.vakettaAdmin.create({
    data: { name, email, password: hashed, role },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });
}

export async function deleteAdminService(id: string, requesterId: string) {
  if (id === requesterId) throw new Error("Cannot delete your own account");
  const admin = await prisma.vakettaAdmin.findUnique({ where: { id } });
  if (!admin) throw new Error("Admin not found");
  return prisma.vakettaAdmin.delete({ where: { id } });
}

// ─── Hotel User Management (via Vaketta Admin) ───────────────────────────────

export async function createHotelUserService(
  hotelId: string,
  data: { name: string; email: string; password: string; role: UserRole }
) {
  const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
  if (!hotel) throw new Error("Hotel not found");
  if (!EMAIL_RE.test(data.email)) throw new Error("Invalid email address");
  if (data.password.length < 8) throw new Error("Password must be at least 8 characters");
  const conflict = await prisma.user.findUnique({ where: { email: data.email } });
  if (conflict) throw new Error("Email already in use");
  const hashed = await hashPassword(data.password);
  return prisma.user.create({
    data: { name: data.name, email: data.email, password: hashed, role: data.role, hotelId },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
  });
}

export async function updateHotelUserService(
  userId: string,
  hotelId: string,
  data: { name?: string; email?: string; role?: UserRole; isActive?: boolean }
) {
  const user = await prisma.user.findFirst({ where: { id: userId, hotelId } });
  if (!user) throw new Error("User not found");
  if (data.email) {
    if (!EMAIL_RE.test(data.email)) throw new Error("Invalid email address");
    const conflict = await prisma.user.findUnique({ where: { email: data.email } });
    if (conflict && conflict.id !== userId) throw new Error("Email already in use");
  }
  return prisma.user.update({
    where: { id: userId },
    data,
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
  });
}

export async function deleteHotelUserService(userId: string, hotelId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, hotelId } });
  if (!user) throw new Error("User not found");
  return prisma.user.delete({ where: { id: userId } });
}

export async function updateAdminSettingsService(
  id: string,
  data: { name?: string; email?: string; currentPassword?: string; newPassword?: string }
) {
  const admin = await prisma.vakettaAdmin.findUnique({ where: { id } });
  if (!admin) throw new Error("Admin not found");

  const updates: { name?: string; email?: string; password?: string } = {};

  if (data.name?.trim()) updates.name = data.name.trim();

  if (data.email) {
    if (!EMAIL_RE.test(data.email)) throw new Error("Invalid email address");
    const conflict = await prisma.vakettaAdmin.findUnique({ where: { email: data.email } });
    if (conflict && conflict.id !== id) throw new Error("Email already in use");
    updates.email = data.email;
  }

  if (data.newPassword) {
    if (!data.currentPassword) throw new Error("Current password is required");
    if (data.newPassword.length < 8) throw new Error("New password must be at least 8 characters");
    const valid = await comparePassword(data.currentPassword, admin.password);
    if (!valid) throw new Error("Current password is incorrect");
    updates.password = await hashPassword(data.newPassword);
  }

  if (Object.keys(updates).length === 0) throw new Error("Nothing to update");

  return prisma.vakettaAdmin.update({
    where: { id },
    data: updates,
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });
}
