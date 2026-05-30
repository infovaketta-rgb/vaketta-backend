/**
 * planCarousel.ts
 *
 * Injectable WhatsApp-carousel sender for the advanced_room_allocation node's
 * multi-plan Phase 1. Kept OUT of advancedRoomAllocation.ts (which stays
 * import-free / dependency-injected) — this file owns the DB + Meta + socket
 * side effects. Mirrors `trySendRoomCarousel` in flowRuntime.ts exactly.
 *
 * `buildPlanDescription` is pure + exported for unit testing; importing this
 * module is side-effect-free at load (Prisma client is lazy; whatsapp service
 * and encryption util only act when called; emit is imported dynamically).
 */

import prisma from "../../db/connect";
import { sendCarouselMessage, type CarouselCard } from "../../services/whatsapp.send.service";
import { decryptWhatsAppToken } from "../../utils/encryption.utils";
import { MessageChannel, MessageStatus } from "@prisma/client";
import { logger } from "../../utils/logger";
import type { AllocationPlan } from "./advancedRoomAllocation";

const log = logger.child({ service: "plan-carousel" });

// Generic placeholder served when a room type has no photos (matches flowRuntime).
const CAROUSEL_FALLBACK_IMAGE = "https://placehold.co/600x400/png?text=Room";

/**
 * Carousel card description for a plan. Max 60 chars (Meta limit).
 * Format: "{N} rooms · {type} · {bed info}", e.g.
 *   "3 rooms · Deluxe · No extra beds"
 *   "2 rooms · Deluxe · Extra beds incl."
 *   "2 rooms · Deluxe mix · Extra beds incl."  (mixed types)
 * The type name is truncated if the whole line would exceed 60 chars.
 */
export function buildPlanDescription(plan: AllocationPlan): string {
  const primary  = plan.rooms.find((r) => r.roomTypeId === plan.primaryRoomTypeId) ?? plan.rooms[0];
  const allSame  = plan.rooms.length > 0 && plan.rooms.every((r) => r.roomTypeId === plan.primaryRoomTypeId);
  let   typeName = primary?.roomTypeName ?? "Room";
  if (!allSame) typeName = `${typeName} mix`;

  const beds      = plan.extraBedCount > 0 ? "Extra beds incl." : "No extra beds";
  const roomsPart = `${plan.roomCount} room${plan.roomCount === 1 ? "" : "s"}`;
  const build = (t: string) => `${roomsPart} · ${t} · ${beds}`;

  let desc = build(typeName);
  if (desc.length > 60) {
    const overflow = desc.length - 60;
    typeName = typeName.slice(0, Math.max(1, typeName.length - overflow - 1)) + "…";
    desc = build(typeName);
    if (desc.length > 60) desc = desc.slice(0, 60);
  }
  return desc;
}

/**
 * Send the plan options as a WhatsApp carousel (one card per plan).
 * Returns true on success (caller returns "ALREADY_SENT"); false on any failure
 * or missing credentials (caller falls back to a text list). Never throws.
 */
export async function trySendPlanCarousel(args: {
  hotelId:  string;
  guestId:  string;
  plans:    AllocationPlan[];
  bodyText: string;
}): Promise<boolean> {
  const { hotelId, guestId, plans, bodyText } = args;
  if (plans.length < 2) return false;                          // Meta requires ≥2 cards
  if (process.env["MOCK_WHATSAPP_SEND"] === "true") return false;

  try {
    const [hotel, guest] = await Promise.all([
      prisma.hotel.findUnique({ where: { id: hotelId }, include: { config: true } }),
      prisma.guest.findUnique({ where: { id: guestId } }),
    ]);
    if (!hotel || !guest) return false;

    const cfg = hotel.config;
    const phoneNumberId = cfg?.metaPhoneNumberId ?? "";
    const encryptedTok  = cfg?.metaAccessTokenEncrypted ?? "";
    if (!phoneNumberId || !encryptedTok) return false;
    const accessToken = decryptWhatsAppToken(encryptedTok);

    // Lead photo per plan's primary room type (isMain first, then lowest order).
    const typeIds = [...new Set(plans.map((p) => p.primaryRoomTypeId).filter(Boolean))];
    const photos = await prisma.roomPhoto.findMany({
      where:   { roomTypeId: { in: typeIds } },
      orderBy: [{ isMain: "desc" }, { order: "asc" }],
      select:  { roomTypeId: true, url: true },
    });
    const photoByType = new Map<string, string>();
    for (const p of photos) {
      if (!photoByType.has(p.roomTypeId)) photoByType.set(p.roomTypeId, p.url);
    }

    const cards: CarouselCard[] = plans.map((plan, i) => ({
      imageUrl:    photoByType.get(plan.primaryRoomTypeId) ?? CAROUSEL_FALLBACK_IMAGE,
      title:       `Plan ${i + 1} — ₹${plan.totalPrice.toLocaleString("en-IN")}`,
      price:       plan.totalPrice,
      description: buildPlanDescription(plan),
      buttonId:    `plan_${i}`,
      buttonLabel: `Choose Plan ${i + 1}`,
    }));

    const wamid = await sendCarouselMessage(guest.phone, phoneNumberId, accessToken, bodyText, cards);

    const saved = await prisma.message.create({
      data: {
        direction:   "OUT",
        fromPhone:   hotel.phone,
        toPhone:     guest.phone,
        body:        JSON.stringify({ cards }),
        messageType: "carousel",
        hotelId,
        guestId,
        channel:     MessageChannel.WHATSAPP,
        status:      MessageStatus.SENT,
        wamid,
      },
    });

    const { emitToHotel } = await import("../../realtime/emit");
    emitToHotel(hotelId, "message:new", { message: saved });

    return true;
  } catch (err) {
    log.warn({ err, hotelId, guestId }, "plan carousel send failed — falling back to text list");
    return false;
  }
}
