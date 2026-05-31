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
import { sendCarouselMessage, sendTextMessage, type CarouselCard } from "../../services/whatsapp.send.service";
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
 * Detailed plan-comparison text, sent immediately BEFORE the carousel so the
 * guest can read the full per-room breakdown, then tap a card to choose. Pure —
 * no side effects, no external imports. All ₹ amounts use the Indian locale.
 */
export function buildPlanDetailText(plans: AllocationPlan[]): string {
  const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

  const blocks = plans.map((p, i) => {
    const beds = p.rooms.some((r) => r.extraBed) ? "extra beds included" : "no extra beds";
    let block = `*Plan ${i + 1} — ${inr(p.totalPrice)}* _(${p.label})_\n`;
    block += `${p.roomCount} room${p.roomCount === 1 ? "" : "s"} · ${beds}`;
    p.rooms.forEach((r, j) => {
      const occ: string[] = [`${r.adults} adult${r.adults === 1 ? "" : "s"}`];
      if (r.children > 0) occ.push(`${r.children} child${r.children === 1 ? "" : "ren"}`);
      let line = `\n• Room ${j + 1}: ${r.roomTypeName} — ${occ.join(", ")}`;
      if (r.extraBed) line += " + bed";
      block += line;
      block += `\n  ${inr(r.pricePerNight)}/night × ${r.nights} night${r.nights === 1 ? "" : "s"} = ${inr(r.totalPrice)}`;
    });
    return block;
  });

  return `🏨 *Your Room Options*\n\n${blocks.join("\n\n")}\n\n_Swipe the cards below to choose_ 👇`;
}

/**
 * Send the plan options as a WhatsApp carousel (one card per plan), preceded by
 * a detailed text breakdown (sent first; its failure is non-fatal). Returns true
 * on carousel success (caller returns "ALREADY_SENT"); false on any failure or
 * missing credentials (caller falls back to a text list). Never throws.
 *
 * `args.bodyText` is intentionally ignored — the detailed content now lives in
 * the pre-text, so the carousel body is a short tap CTA.
 */
export async function trySendPlanCarousel(args: {
  hotelId:  string;
  guestId:  string;
  plans:    AllocationPlan[];
  bodyText: string;
}): Promise<boolean> {
  const { hotelId, guestId, plans } = args;
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

    // Detailed breakdown FIRST (supplementary — its failure is non-fatal; the
    // carousel is the required action). Sent as a plain text message.
    try {
      const detailText = buildPlanDetailText(plans);
      const textResp = await sendTextMessage({
        toPhone: guest.phone, fromPhone: hotel.phone, hotelId, guestId, text: detailText,
      });
      const textWamid = (textResp as { messages?: { id?: string }[] } | null)?.messages?.[0]?.id ?? null;
      const textMsg = await prisma.message.create({
        data: {
          direction:   "OUT",
          fromPhone:   hotel.phone,
          toPhone:     guest.phone,
          body:        detailText,
          messageType: "text",
          hotelId,
          guestId,
          channel:     MessageChannel.WHATSAPP,
          status:      MessageStatus.SENT,
          wamid:       textWamid,
        },
      });
      const { emitToHotel } = await import("../../realtime/emit");
      emitToHotel(hotelId, "message:new", { message: textMsg });
    } catch (err) {
      log.warn({ err, hotelId, guestId }, "plan detail text send failed — continuing to carousel");
    }

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

    const wamid = await sendCarouselMessage(guest.phone, phoneNumberId, accessToken, "Tap a plan below to select 👇", cards);

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
