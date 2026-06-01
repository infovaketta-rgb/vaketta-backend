/**
 * planList.ts
 *
 * Injectable WhatsApp interactive-LIST sender for the advanced_room_allocation
 * node's multi-plan Phase 1. The list message carries the full per-plan
 * breakdown in its body (≤1,024 chars) and the plans as tappable rows in a
 * modal — one message, no carousel, no separate pre-text. Kept OUT of
 * advancedRoomAllocation.ts (which stays import-free / dependency-injected) —
 * this file owns the DB + Meta + socket side effects. Mirrors
 * `trySendOptionsList` in flowRuntime.ts exactly.
 *
 * `buildPlanDescription` / `buildPlanDetailText` are pure + exported for unit
 * testing; importing this module is side-effect-free at load (Prisma client is
 * lazy; the whatsapp service + encryption util only act when called; emit is
 * imported dynamically).
 */

import prisma from "../../db/connect";
import { sendListMessage } from "../../services/whatsapp.send.service";
import { decryptWhatsAppToken } from "../../utils/encryption.utils";
import { MessageChannel, MessageStatus } from "@prisma/client";
import { logger } from "../../utils/logger";
import type { AllocationPlan } from "./advancedRoomAllocation";

const log = logger.child({ service: "plan-list" });

const MAX_BODY = 1_024; // Meta interactive-list body limit

/**
 * List-row description for a plan. Max 60 chars (well within Meta's 72 row-desc
 * limit). Format: "{N} rooms · {type} · {bed info}", e.g.
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
 * Detailed plan-comparison text — the LIST message body. Pure — no side effects,
 * no external imports. All ₹ amounts use the Indian locale.
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

  return `🏨 *Your Room Options*\n\n${blocks.join("\n\n")}\n\n_Tap *View Plans* to choose_ 👇`;
}

/**
 * Send the plan options as a WhatsApp interactive list: the full breakdown in
 * the body, one tappable row per plan (id `plan_N`). Returns true on success
 * (caller returns "ALREADY_SENT"); false on any failure or missing credentials
 * (caller falls back to a text list). Never throws.
 */
export async function trySendPlanList(args: {
  hotelId: string;
  guestId: string;
  plans:   AllocationPlan[];
}): Promise<boolean> {
  const { hotelId, guestId, plans } = args;
  if (plans.length === 0) return false;
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

    let bodyText = buildPlanDetailText(plans);
    if (bodyText.length > MAX_BODY) bodyText = bodyText.slice(0, MAX_BODY - 1) + "…";

    const buttonLabel  = "View Plans";
    const sectionTitle = "Choose a Plan";
    const rows = plans.map((plan, i) => ({
      id:          `plan_${i}`,
      title:       `Plan ${i + 1} — ₹${plan.totalPrice.toLocaleString("en-IN")}`.slice(0, 24),
      description: buildPlanDescription(plan),
    }));

    const wamid = await sendListMessage(guest.phone, phoneNumberId, accessToken, {
      bodyText,
      buttonLabel,
      sections: [{ title: sectionTitle, rows }],
    });

    const saved = await prisma.message.create({
      data: {
        direction:   "OUT",
        fromPhone:   hotel.phone,
        toPhone:     guest.phone,
        body:        JSON.stringify({ bodyText, buttonLabel, rows }),
        messageType: "list",
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
    log.warn({ err, hotelId, guestId }, "plan list send failed — falling back to text list");
    return false;
  }
}
