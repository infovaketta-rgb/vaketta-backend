"use strict";
/**
 * botEngine.ts
 *
 * Per-hotel, per-guest conversation state machine.
 *
 * States
 * ──────
 * IDLE / AWAITING_SELECTION  — menu shown, waiting for guest to choose
 * BOOKING_NAME               — collecting guest full name
 * BOOKING_ROOM               — collecting room type selection
 * BOOKING_CHECKIN            — collecting check-in date
 * BOOKING_CHECKOUT           — collecting check-out date
 * BOOKING_CONFIRM            — showing summary, awaiting YES / NO
 * ENQUIRY_OPEN               — guest opened an enquiry; bot stays silent, staff takes over
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processMessage = processMessage;
const connect_1 = __importDefault(require("../db/connect"));
const buildMenuResponse_1 = require("./buildMenuResponse");
const session_service_1 = require("../services/session.service");
const flowRuntime_1 = require("./flowRuntime");
const availability_service_1 = require("../services/availability.service");
const DIVIDER = "━━━━━━━━━━━━━━━━";
async function loadBotMessages(hotelId) {
    const config = await connect_1.default.hotelConfig.findUnique({ where: { hotelId } });
    if (!config)
        return {};
    return config.botMessages ?? {};
}
function msg(custom, fallback) {
    return custom?.trim() ? custom.trim() : fallback;
}
// ── Date helpers ───────────────────────────────────────────────────────────────
/** Parse DD/MM/YYYY, DD-MM-YYYY, or YYYY-MM-DD. Returns midnight local Date or null. */
function parseDate(input) {
    const t = input.trim();
    // DD/MM/YYYY or DD-MM-YYYY
    const m1 = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m1 && m1[1] && m1[2] && m1[3]) {
        const d = new Date(+m1[3], +m1[2] - 1, +m1[1]);
        if (!isNaN(d.getTime()))
            return d;
    }
    // YYYY-MM-DD
    const m2 = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m2 && m2[1] && m2[2] && m2[3]) {
        const d = new Date(+m2[1], +m2[2] - 1, +m2[3]);
        if (!isNaN(d.getTime()))
            return d;
    }
    return null;
}
function fmtDate(d) {
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}
function toYMD(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function nightsBetween(checkIn, checkOut) {
    return Math.round((checkOut.getTime() - checkIn.getTime()) / 86400000);
}
/** Example date string: tomorrow in DD/MM/YYYY */
function exampleDate(daysFromNow = 1) {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}
// ── Reset trigger keywords ─────────────────────────────────────────────────────
const RESET_KEYWORDS = new Set(["MENU", "0", "HI", "HELLO", "START", "RESTART", "BACK", "HOME"]);
// ── Public entry point ─────────────────────────────────────────────────────────
async function processMessage(hotelId, guestId, body) {
    const input = (body ?? "").trim();
    const upper = input.toUpperCase();
    // Load (or create) session for this guest × hotel pair
    const session = await (0, session_service_1.getOrCreateSession)(guestId, hotelId);
    const data = session.data;
    // Auto-expire idle sessions after 2 hours to avoid ghost state
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    if (session.updatedAt.getTime() < Date.now() - TWO_HOURS && session.state !== "IDLE") {
        await (0, session_service_1.resetSession)(guestId, hotelId);
        session.state = "IDLE";
    }
    // Global reset — works from any state except during selection itself
    if (RESET_KEYWORDS.has(upper) && !["IDLE", "AWAITING_SELECTION"].includes(session.state)) {
        await (0, session_service_1.resetSession)(guestId, hotelId);
        return (0, buildMenuResponse_1.buildMenuMessage)(hotelId);
    }
    // Delegate to flow runtime when inside a visual flow
    if (session.state.startsWith("FLOW:")) {
        return (0, flowRuntime_1.executeFlowStep)(hotelId, guestId, session.state, data, input);
    }
    const botMsgs = await loadBotMessages(hotelId);
    switch (session.state) {
        case "IDLE":
        case "AWAITING_SELECTION":
            return handleSelection(hotelId, guestId, input, botMsgs, session.state === "IDLE");
        case "BOOKING_NAME":
            return handleBookingName(hotelId, guestId, data, input, botMsgs);
        case "BOOKING_ROOM":
            return handleBookingRoom(hotelId, guestId, data, input, botMsgs);
        case "BOOKING_CHECKIN":
            return handleBookingCheckIn(hotelId, guestId, data, input, botMsgs);
        case "BOOKING_CHECKOUT":
            return handleBookingCheckOut(hotelId, guestId, data, input, botMsgs);
        case "BOOKING_CONFIRM":
            return handleBookingConfirm(hotelId, guestId, data, input, botMsgs);
        case "ENQUIRY_OPEN":
            // Staff is expected to respond manually; bot stays silent
            return null;
        default:
            await (0, session_service_1.resetSession)(guestId, hotelId);
            return (0, buildMenuResponse_1.buildMenuMessage)(hotelId) ?? msg(botMsgs.menuFallback, "Reply *MENU* to see our options.");
    }
}
// ── State handlers ─────────────────────────────────────────────────────────────
async function handleSelection(hotelId, guestId, input, botMsgs, isFirstContact = false) {
    const upper = input.toUpperCase();
    const item = await connect_1.default.hotelMenuItem.findFirst({
        where: { key: upper, isActive: true, menu: { hotelId, isActive: true } },
    });
    if (!item) {
        // Unknown input — re-show menu with a polite preamble
        await (0, session_service_1.updateSession)(guestId, hotelId, "AWAITING_SELECTION", {});
        const menu = await (0, buildMenuResponse_1.buildMenuMessage)(hotelId);
        // First contact or reset keywords → show menu cleanly, no error preamble
        if (!input || isFirstContact || RESET_KEYWORDS.has(upper))
            return menu;
        const preamble = "Sorry, that option isn't recognised.\n\n";
        return menu ? preamble + menu : `${preamble}Reply *MENU* to see our options.`;
    }
    const type = item.type ?? "INFO";
    // ── BOOKING intent ──
    if (type === "BOOKING") {
        // Check if hotel has configured a custom booking flow
        const bookingConfig = await connect_1.default.hotelConfig.findUnique({ where: { hotelId } });
        const bookingFlowId = bookingConfig?.bookingFlowId;
        if (bookingFlowId) {
            // Route through the visual flow builder instead of the hardcoded state machine
            const flow = await connect_1.default.flowDefinition.findUnique({ where: { id: bookingFlowId } });
            if (flow?.isActive) {
                const startNode = flow.nodes.find((n) => n.type === "start");
                if (startNode) {
                    const initState = `FLOW:${flow.id}:${startNode.id}`;
                    const initData = { flow: { flowId: flow.id, flowVars: {} } };
                    await (0, session_service_1.updateSession)(guestId, hotelId, initState, initData);
                    return (0, flowRuntime_1.executeFlowStep)(hotelId, guestId, initState, initData, input);
                }
            }
            // Flow not found or inactive — fall through to default booking flow
        }
        const hotel = await connect_1.default.hotel.findUnique({
            where: { id: hotelId },
            include: { config: true, roomTypes: { orderBy: { basePrice: "asc" } } },
        });
        if (!hotel?.config?.bookingEnabled || !hotel.roomTypes.length) {
            const unavailMsg = item.replyText || msg(botMsgs.bookingUnavailable, "Room booking is currently unavailable online.");
            return `${unavailMsg}\n\nFor assistance please contact us directly.\n_Reply *MENU* to see other options._`;
        }
        await (0, session_service_1.updateSession)(guestId, hotelId, "BOOKING_NAME", {});
        if (item.replyText) {
            return `${item.replyText}\n\n_Reply *0* to cancel at any time._`;
        }
        const startMsg = msg(botMsgs.bookingStart, "Let's get you booked in! Please enter your *full name* as it should appear on the reservation.");
        return `📝 *Room Booking*\n\n${startMsg}\n\n_Reply *0* to cancel at any time._`;
    }
    // ── ENQUIRY intent ──
    if (type === "ENQUIRY") {
        await (0, session_service_1.updateSession)(guestId, hotelId, "ENQUIRY_OPEN", {});
        const enquiryMsg = item.replyText || msg(botMsgs.enquiryDefault, "Our team will assist you shortly. Please share your query and we'll respond as soon as possible.");
        return `${enquiryMsg}\n\n_Reply *MENU* at any time to return to the main menu._`;
    }
    // ── FLOW intent ──
    if (type === "FLOW") {
        if (!item.flowId) {
            // Misconfigured — no flow linked; fall back to menu
            await (0, session_service_1.resetSession)(guestId, hotelId);
            return (0, buildMenuResponse_1.buildMenuMessage)(hotelId) ?? msg(botMsgs.menuFallback, "Reply *MENU* to see our options.");
        }
        const flow = await connect_1.default.flowDefinition.findUnique({ where: { id: item.flowId } });
        if (!flow?.isActive) {
            await (0, session_service_1.resetSession)(guestId, hotelId);
            return (0, buildMenuResponse_1.buildMenuMessage)(hotelId) ?? msg(botMsgs.menuFallback, "This service is temporarily unavailable.\n\nReply *MENU* to see other options.");
        }
        const startNode = flow.nodes.find((n) => n.type === "start");
        if (!startNode) {
            await (0, session_service_1.resetSession)(guestId, hotelId);
            return (0, buildMenuResponse_1.buildMenuMessage)(hotelId) ?? msg(botMsgs.menuFallback, "Reply *MENU* to see our options.");
        }
        const initState = `FLOW:${flow.id}:${startNode.id}`;
        const initData = { flow: { flowId: flow.id, flowVars: {} } };
        await (0, session_service_1.updateSession)(guestId, hotelId, initState, initData);
        return (0, flowRuntime_1.executeFlowStep)(hotelId, guestId, initState, initData, input);
    }
    // ── INFO intent (default) ──
    await (0, session_service_1.resetSession)(guestId, hotelId);
    return (item.replyText || "Thank you! Our team will be in touch if needed.") +
        `\n\n_Reply *MENU* for other options._`;
}
// ── Booking flow ───────────────────────────────────────────────────────────────
async function handleBookingName(hotelId, guestId, data, input, botMsgs) {
    if (input.trim().split(/\s+/).length < 2 || input.trim().length < 4) {
        return `Please enter your *full name* (first and last name).`;
    }
    // Fetch room types including capacity and description
    const roomTypes = await connect_1.default.roomType.findMany({
        where: { hotelId },
        orderBy: { basePrice: "asc" },
        select: { id: true, name: true, basePrice: true, description: true, capacity: true },
    });
    if (!roomTypes.length) {
        await (0, session_service_1.resetSession)(guestId, hotelId);
        return msg(botMsgs.bookingNoRooms, `Sorry, we have no rooms available at the moment.\n\nPlease contact us directly for assistance.\n_Reply *MENU* to go back._`);
    }
    const roomList = roomTypes.map((r) => ({
        id: r.id,
        name: r.name,
        basePrice: r.basePrice,
        capacity: r.capacity,
        description: r.description ?? "",
    }));
    await (0, session_service_1.updateSession)(guestId, hotelId, "BOOKING_ROOM", { ...data, bookingGuestName: input.trim(), roomList });
    let text = `Thanks, *${input.trim()}*! 🏨\n\nPlease choose a room type:\n\n${DIVIDER}\n`;
    roomList.forEach((r, i) => {
        text += `*${i + 1}.* ${r.name} — ₹${r.basePrice.toLocaleString("en-IN")}/night\n`;
        const detail = [];
        if (r.capacity != null && r.capacity > 0)
            detail.push(`Fits ${r.capacity} guest${r.capacity > 1 ? "s" : ""}`);
        if (r.description)
            detail.push(r.description.length > 60 ? r.description.slice(0, 57) + "…" : r.description);
        if (detail.length)
            text += `     _${detail.join(" · ")}_\n`;
    });
    text += `${DIVIDER}\n\n` + msg(botMsgs.bookingRoomNote, `Reply with a number (1–${roomList.length}).\n_Reply *0* to cancel._`);
    return text;
}
async function handleBookingRoom(hotelId, guestId, data, input, botMsgs) {
    if (["0", "CANCEL"].includes(input.toUpperCase())) {
        await (0, session_service_1.resetSession)(guestId, hotelId);
        return msg(botMsgs.bookingCancel, "❌ Booking cancelled.\n\n_Reply *MENU* to see our services._");
    }
    const roomList = data.roomList ?? [];
    const num = parseInt(input, 10);
    if (isNaN(num) || num < 1 || num > roomList.length) {
        return `Please reply with a number between *1* and *${roomList.length}*.\n_Reply *0* to cancel._`;
    }
    const chosen = roomList[num - 1];
    await (0, session_service_1.updateSession)(guestId, hotelId, "BOOKING_CHECKIN", {
        ...data,
        bookingRoomTypeId: chosen.id,
        bookingRoomTypeName: chosen.name,
        bookingPricePerNight: chosen.basePrice,
    });
    const checkInText = msg(botMsgs.bookingCheckInText, `Please enter your check-in date:\n\n*DD/MM/YYYY*  _(e.g. ${exampleDate(1)})_\n\n_Reply *0* to cancel._`);
    return `✅ *${chosen.name}* selected!\n\n📅 *Check-in date*\n${checkInText}`;
}
async function handleBookingCheckIn(hotelId, guestId, data, input, botMsgs) {
    if (["0", "CANCEL"].includes(input.toUpperCase())) {
        await (0, session_service_1.resetSession)(guestId, hotelId);
        return msg(botMsgs.bookingCancel, "❌ Booking cancelled.\n\n_Reply *MENU* to see our services._");
    }
    const date = parseDate(input);
    if (!date) {
        return `Please use the format *DD/MM/YYYY*\n_(e.g. ${exampleDate(3)})_`;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (date < today) {
        return `📅 That date has already passed.\n\nPlease enter a *future* check-in date.`;
    }
    await (0, session_service_1.updateSession)(guestId, hotelId, "BOOKING_CHECKOUT", { ...data, bookingCheckIn: toYMD(date) });
    const checkOutText = msg(botMsgs.bookingCheckOutText, `When will you be checking out?\n\n*DD/MM/YYYY*  _(must be after ${fmtDate(date)})_\n\n_Reply *0* to cancel._`);
    return `✅ Check-in: *${fmtDate(date)}*\n\n📅 *Check-out date*\n${checkOutText}`;
}
async function handleBookingCheckOut(hotelId, guestId, data, input, botMsgs) {
    if (["0", "CANCEL"].includes(input.toUpperCase())) {
        await (0, session_service_1.resetSession)(guestId, hotelId);
        return msg(botMsgs.bookingCancel, "❌ Booking cancelled.\n\n_Reply *MENU* to see our services._");
    }
    const date = parseDate(input);
    if (!date) {
        return `Please use the format *DD/MM/YYYY*\n_(e.g. ${exampleDate(4)})_`;
    }
    const checkIn = new Date(data.bookingCheckIn);
    checkIn.setHours(0, 0, 0, 0);
    if (date <= checkIn) {
        return (`Check-out must be *after* your check-in date (*${fmtDate(checkIn)}*).\n\n` +
            `Please enter a later date.`);
    }
    // ── Availability check (when enabled) ───────────────────────────────────────
    const config = await connect_1.default.hotelConfig.findUnique({ where: { hotelId } });
    if (config?.availabilityEnabled && data.bookingRoomTypeId) {
        const { available } = await (0, availability_service_1.checkRoomAvailability)(hotelId, data.bookingRoomTypeId, data.bookingCheckIn, date);
        if (!available) {
            // Reset back to check-in so the guest can try different dates
            const retryData = { ...data };
            delete retryData.bookingCheckIn;
            await (0, session_service_1.updateSession)(guestId, hotelId, "BOOKING_CHECKIN", retryData);
            return (`❌ Sorry, *${data.bookingRoomTypeName ?? "that room"}* is fully booked for those dates.\n\n` +
                `Please enter a different *check-in date*, or reply *0* to cancel.`);
        }
    }
    const nights = nightsBetween(checkIn, date);
    const pricePer = data.bookingPricePerNight ?? 0;
    const total = nights * pricePer;
    await (0, session_service_1.updateSession)(guestId, hotelId, "BOOKING_CONFIRM", { ...data, bookingCheckOut: toYMD(date) });
    const summaryNote = msg(botMsgs.bookingSummaryNote, `_Final amount confirmed at check-in._\n\nReply *YES* to confirm or *NO* to cancel.`);
    return (`📋 *Booking Summary*\n\n` +
        `${DIVIDER}\n` +
        `👤 *Guest:* ${data.bookingGuestName}\n` +
        `🏨 *Room:* ${data.bookingRoomTypeName}\n` +
        `📅 *Check-in:* ${fmtDate(checkIn)}\n` +
        `📅 *Check-out:* ${fmtDate(date)}\n` +
        `🌙 *Duration:* ${nights} night${nights !== 1 ? "s" : ""}\n` +
        `💰 *Estimated Total:* ₹${total.toLocaleString("en-IN")}\n` +
        `${DIVIDER}\n\n` +
        summaryNote);
}
async function handleBookingConfirm(hotelId, guestId, data, input, botMsgs) {
    const upper = input.toUpperCase();
    if (["NO", "N", "CANCEL", "0", "X"].includes(upper)) {
        await (0, session_service_1.resetSession)(guestId, hotelId);
        return msg(botMsgs.bookingCancel, "❌ Booking cancelled.\n\n_Reply *MENU* to see our services._");
    }
    if (!["YES", "Y", "CONFIRM", "OK", "1"].includes(upper)) {
        return `Please reply *YES* to confirm your booking or *NO* to cancel.`;
    }
    try {
        const checkIn = new Date(data.bookingCheckIn);
        const checkOut = new Date(data.bookingCheckOut);
        const nights = nightsBetween(checkIn, checkOut);
        const pricePer = data.bookingPricePerNight ?? 0;
        const total = nights * pricePer;
        const booking = await connect_1.default.booking.create({
            data: {
                hotelId,
                guestId,
                roomTypeId: data.bookingRoomTypeId,
                guestName: data.bookingGuestName,
                checkIn,
                checkOut,
                pricePerNight: pricePer,
                advancePaid: 0,
                totalPrice: total,
                status: "PENDING",
            },
        });
        await (0, session_service_1.resetSession)(guestId, hotelId);
        const ref = booking.id.slice(0, 8).toUpperCase();
        const successBody = msg(botMsgs.bookingSuccess, `Our team will review and confirm your booking shortly. You'll receive a message here once approved.\n\n*What happens next?*\n• We'll confirm availability within a few hours\n• You'll receive confirmation with payment details`);
        return (`✅ *Booking Request Received!*\n\n` +
            `*Reference:* #${ref}\n\n` +
            `${successBody}\n\n` +
            `_Reply *MENU* for other services._`);
    }
    catch (err) {
        console.error("❌ Bot booking creation failed:", err);
        await (0, session_service_1.resetSession)(guestId, hotelId);
        return (`⚠️ We couldn't process your booking right now.\n\n` +
            `Please try again in a few minutes, or contact us directly.\n\n` +
            `_Reply *MENU* to return to the main menu._`);
    }
}
//# sourceMappingURL=botEngine.js.map