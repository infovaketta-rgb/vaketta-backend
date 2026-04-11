/**
 * botEngine.ts
 *
 * Per-hotel, per-guest conversation state machine.
 *
 * All bot logic is built via the visual Flow Builder. This engine only
 * handles routing — it never contains hardcoded conversation steps.
 *
 * States
 * ──────
 * IDLE / AWAITING_SELECTION  — menu shown, waiting for guest to choose
 * FLOW:{flowId}:{nodeId}     — inside a visual flow (delegated to flowRuntime)
 * ENQUIRY_OPEN               — staff-handoff; bot stays silent
 */

import prisma from "../db/connect";
import { buildMenuMessage } from "./buildMenuResponse";
import { getOrCreateSession, updateSession, resetSession, SessionData } from "../services/session.service";
import { executeFlowStep } from "./flowRuntime";
import { getAIReply } from "../services/ai.service";
import { incrementAIUsage } from "../services/usage.service";

// ── Reset trigger keywords ─────────────────────────────────────────────────────

const RESET_KEYWORDS = new Set(["MENU", "0", "HI", "HELLO", "START", "RESTART", "BACK", "HOME"]);

// ── Public entry point ─────────────────────────────────────────────────────────

export async function processMessage(
  hotelId: string,
  guestId: string,
  body: string | null
): Promise<string | null> {
  const input = (body ?? "").trim();
  const upper = input.toUpperCase();

  const session = await getOrCreateSession(guestId, hotelId);
  const data    = session.data as SessionData;

  // Auto-expire idle sessions after 2 hours
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  if (session.updatedAt.getTime() < Date.now() - TWO_HOURS && session.state !== "IDLE") {
    await resetSession(guestId, hotelId);
    session.state = "IDLE";
  }

  // Global reset — works from any state except IDLE/AWAITING_SELECTION
  if (RESET_KEYWORDS.has(upper) && !["IDLE", "AWAITING_SELECTION"].includes(session.state)) {
    await resetSession(guestId, hotelId);
    return showMenu(hotelId, guestId, {}, input);
  }

  // Delegate to flow runtime when inside a visual flow
  if (session.state.startsWith("FLOW:")) {
    return executeFlowStep(hotelId, guestId, session.state, data, input);
  }

  switch (session.state) {
    case "IDLE":
    case "AWAITING_SELECTION":
      return handleSelection(hotelId, guestId, input, session.state === "IDLE", data);

    case "ENQUIRY_OPEN":
      // Staff handles this; bot stays silent
      return null;

    default:
      // Unknown state — reset and show menu
      await resetSession(guestId, hotelId);
      return showMenu(hotelId, guestId, {}, input);
  }
}

// ── Selection handler ──────────────────────────────────────────────────────────

/** If hotel has a menuFlowId, start that flow; otherwise fall back to the
 *  hardcoded buildMenuMessage. This is the single exit point for "show menu". */
async function showMenu(
  hotelId: string,
  guestId: string,
  sessionData: SessionData,
  input: string
): Promise<string | null> {
  const cfg = await prisma.hotelConfig.findUnique({ where: { hotelId } });
  const menuFlowId = (cfg as any)?.menuFlowId as string | null | undefined;

  if (menuFlowId) {
    const flow = await prisma.flowDefinition.findUnique({ where: { id: menuFlowId } });
    const startNode = (flow?.nodes as any[] | undefined)?.find((n: any) => n.type === "start");
    if (flow?.isActive && startNode) {
      const initState = `FLOW:${flow.id}:${startNode.id}`;
      const initData: SessionData = { flow: { flowId: flow.id, flowVars: {} } };
      await updateSession(guestId, hotelId, initState, initData);
      return executeFlowStep(hotelId, guestId, initState, initData, input);
    }
  }

  // Fallback: hardcoded menu builder
  await updateSession(guestId, hotelId, "AWAITING_SELECTION", {});
  return buildMenuMessage(hotelId);
}

async function handleSelection(
  hotelId: string,
  guestId: string,
  input: string,
  isFirstContact = false,
  sessionData: SessionData = {}
): Promise<string | null> {
  const upper = input.toUpperCase();

  const item = await prisma.hotelMenuItem.findFirst({
    where: { key: upper, isActive: true, menu: { hotelId, isActive: true } },
  });

  if (!item) {
    // First contact or reset keyword → show menu (flow-driven or hardcoded)
    if (!input || isFirstContact || RESET_KEYWORDS.has(upper)) {
      return showMenu(hotelId, guestId, sessionData, input);
    }

    // Unknown input — try AI fallback if enabled
    const cfg = await prisma.hotelConfig.findUnique({ where: { hotelId } });
    if ((cfg as any)?.aiEnabled) {
      const aiResult = await getAIReply(hotelId, guestId, input);
      if (aiResult) {
        incrementAIUsage(hotelId).catch(() => {});
        if (aiResult.handoff) {
          await prisma.guest.updateMany({ where: { id: guestId, hotelId }, data: { lastHandledByStaff: true } });
          await updateSession(guestId, hotelId, "ENQUIRY_OPEN", {});
        } else {
          await updateSession(guestId, hotelId, "AWAITING_SELECTION", {});
        }
        return aiResult.text;
      }
    }

    // Fallback — re-show menu with preamble
    const menu = await buildMenuMessage(hotelId);
    if (menu) {
      await updateSession(guestId, hotelId, "AWAITING_SELECTION", {});
      return `Sorry, that option isn't recognised.\n\n${menu}`;
    }
    return showMenu(hotelId, guestId, sessionData, input);
  }

  const type = item.type ?? "INFO";

  // ── ENQUIRY ──
  if (type === "ENQUIRY") {
    await updateSession(guestId, hotelId, "ENQUIRY_OPEN", {});
    const enquiryMsg = item.replyText || "Our team will assist you shortly. Please share your query and we'll respond as soon as possible.";
    return `${enquiryMsg}\n\n_Reply *MENU* at any time to return to the main menu._`;
  }

  // ── BOOKING — must have a flow linked ──
  if (type === "BOOKING") {
    // Prefer the item's own flowId; fall back to hotel-wide bookingFlowId
    let flowId = item.flowId ?? null;
    if (!flowId) {
      const config = await prisma.hotelConfig.findUnique({ where: { hotelId }, select: { bookingFlowId: true } });
      flowId = config?.bookingFlowId ?? null;
    }

    if (flowId) {
      const flow = await prisma.flowDefinition.findUnique({ where: { id: flowId } });
      const startNode = (flow?.nodes as any[] | undefined)?.find((n: any) => n.type === "start");
      if (flow?.isActive && startNode) {
        const initState = `FLOW:${flow.id}:${startNode.id}`;
        const initData: SessionData = { flow: { flowId: flow.id, flowVars: {} } };
        await updateSession(guestId, hotelId, initState, initData);
        return executeFlowStep(hotelId, guestId, initState, initData, input);
      }
    }

    // No flow configured — tell the guest to contact directly
    await resetSession(guestId, hotelId);
    const unavailMsg = item.replyText || "Room booking is currently unavailable online.";
    return `${unavailMsg}\n\nFor assistance please contact us directly.\n_Reply *MENU* to see other options._`;
  }

  // ── FLOW ──
  if (type === "FLOW") {
    if (!item.flowId) {
      await resetSession(guestId, hotelId);
      return showMenu(hotelId, guestId, sessionData, input);
    }
    const flow = await prisma.flowDefinition.findUnique({ where: { id: item.flowId } });
    const startNode = (flow?.nodes as any[] | undefined)?.find((n: any) => n.type === "start");
    if (!flow?.isActive || !startNode) {
      await resetSession(guestId, hotelId);
      return showMenu(hotelId, guestId, sessionData, input);
    }
    const initState = `FLOW:${flow.id}:${startNode.id}`;
    const initData: SessionData = { flow: { flowId: flow.id, flowVars: {} } };
    await updateSession(guestId, hotelId, initState, initData);
    return executeFlowStep(hotelId, guestId, initState, initData, input);
  }

  // ── INFO (default) ──
  await resetSession(guestId, hotelId);
  return (item.replyText || "Thank you! Our team will be in touch if needed.") +
    `\n\n_Reply *MENU* for other options._`;
}
