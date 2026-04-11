"use strict";
/**
 * flowRuntime.ts
 *
 * Executes one step of a visual flow for a given guest session.
 * Called when session.state starts with "FLOW:{flowId}:{nodeId}".
 *
 * Node types handled:
 *   start, message, question, branch, action, end,
 *   check_availability, show_rooms
 *
 * Question types:
 *   text, room_selection (legacy), date, number, yes_no, rating
 *
 * Action types:
 *   create_booking, update_booking_status, start_booking_flow (legacy),
 *   handoff_to_staff, notify_staff, reset_to_menu, set_variable, send_review_request
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeFlowStep = executeFlowStep;
const connect_1 = __importDefault(require("../db/connect"));
const session_service_1 = require("../services/session.service");
const buildMenuResponse_1 = require("./buildMenuResponse");
const availability_service_1 = require("../services/availability.service");
const MAX_HOPS = 30;
const DIVIDER = "━━━━━━━━━━━━━━━━";
const MENU_FALLBACK = "Reply *MENU* to see our options.";
// ── Helpers ────────────────────────────────────────────────────────────────────
function buildMaps(nodes, edges) {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const adjacency = new Map();
    for (const e of edges) {
        const list = adjacency.get(e.source) ?? [];
        list.push({ targetId: e.target, sourceHandle: e.sourceHandle });
        adjacency.set(e.source, list);
    }
    return { nodeMap, adjacency };
}
function nextNodeId(nodeId, adjacency, handle) {
    const edges = adjacency.get(nodeId) ?? [];
    if (!handle)
        return edges[0]?.targetId ?? null;
    return edges.find((e) => e.sourceHandle === handle)?.targetId ?? null;
}
function evaluateCondition(cond, flowVars) {
    const actual = (flowVars[cond.variable] ?? "").toLowerCase().trim();
    // Support {{varName}} interpolation in compareValue so admins can compare two variables
    const compare = interpolate(cond.compareValue, flowVars).toLowerCase().trim();
    switch (cond.operator) {
        case "equals": return actual === compare;
        case "not_equals": return actual !== compare;
        case "contains": return actual.includes(compare);
        case "starts_with": return actual.startsWith(compare);
        case "gt": return parseFloat(actual) > parseFloat(compare);
        case "lt": return parseFloat(actual) < parseFloat(compare);
        default: return false;
    }
}
/** Parse DD/MM/YYYY or YYYY-MM-DD into a Date (midnight UTC). Returns null on failure. */
function parseFlexDate(raw) {
    const m1 = raw.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m1) {
        const d = new Date(`${m1[3]}-${m1[2].padStart(2, "0")}-${m1[1].padStart(2, "0")}T00:00:00Z`);
        return isNaN(d.getTime()) ? null : d;
    }
    const m2 = raw.trim().match(/^\d{4}-\d{2}-\d{2}$/);
    if (m2) {
        const d = new Date(`${raw.trim()}T00:00:00Z`);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
}
/** Normalise date to YYYY-MM-DD string */
function toDateStr(d) {
    return d.toISOString().slice(0, 10);
}
/** Midnight UTC today */
function todayUTC() {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
/** Replace {{varName}} placeholders in text with values from flowVars. */
function interpolate(text, flowVars) {
    return text.replace(/\{\{(\w+)\}\}/g, (_, key) => flowVars[key] ?? `{{${key}}}`);
}
async function safeMenu(hotelId) {
    return (await (0, buildMenuResponse_1.buildMenuMessage)(hotelId)) ?? MENU_FALLBACK;
}
// ── Room type fetcher ──────────────────────────────────────────────────────────
async function fetchRoomTypes(hotelId, filters) {
    return connect_1.default.roomType.findMany({
        where: {
            hotelId,
            ...(filters?.minCapacity ? { capacity: { gte: filters.minCapacity } } : {}),
            ...(filters?.minAdults ? { maxAdults: { gte: filters.minAdults } } : {}),
            ...(filters?.minChildren ? { maxChildren: { gte: filters.minChildren } } : {}),
        },
        orderBy: { basePrice: "asc" },
        select: {
            id: true, name: true, basePrice: true,
            capacity: true, maxAdults: true, maxChildren: true,
            description: true,
        },
    });
}
function buildRoomListText(promptText, rooms) {
    if (!rooms.length) {
        return `${promptText}\n\n_No rooms are currently available for those dates. Please try different dates or contact us directly._`;
    }
    let text = `${promptText}\n\n${DIVIDER}\n`;
    rooms.forEach((r, i) => {
        const avail = r.availableCount !== undefined ? ` _(${r.availableCount} avail)_` : "";
        text += `*${i + 1}.* ${r.name}${avail} — ₹${r.basePrice.toLocaleString("en-IN")}/night\n`;
        const parts = [];
        // Show adults + children if set, otherwise fall back to total capacity
        if (r.maxAdults != null && r.maxAdults > 0) {
            const childPart = r.maxChildren != null && r.maxChildren > 0
                ? ` + ${r.maxChildren} child${r.maxChildren > 1 ? "ren" : ""}`
                : "";
            parts.push(`${r.maxAdults} adult${r.maxAdults > 1 ? "s" : ""}${childPart}`);
        }
        else if (r.capacity != null && r.capacity > 0) {
            parts.push(`Fits ${r.capacity} guest${r.capacity > 1 ? "s" : ""}`);
        }
        if (r.description)
            parts.push(r.description.length > 60 ? r.description.slice(0, 57) + "…" : r.description);
        if (parts.length)
            text += `     _${parts.join(" · ")}_\n`;
    });
    text += `${DIVIDER}\n\n_Reply with a number (1–${rooms.length}).  Type *MENU* to cancel._`;
    return text;
}
// ── Main entry point ───────────────────────────────────────────────────────────
async function executeFlowStep(hotelId, guestId, state, // "FLOW:{flowId}:{nodeId}"
sessionData, input) {
    const parts = state.split(":");
    const flowId = parts[1];
    const nodeId = parts[2];
    const flow = await connect_1.default.flowDefinition.findUnique({ where: { id: flowId } });
    if (!flow || !flow.isActive) {
        await (0, session_service_1.resetSession)(guestId, hotelId);
        return safeMenu(hotelId);
    }
    const nodes = flow.nodes;
    const edges = flow.edges;
    const { nodeMap, adjacency } = buildMaps(nodes, edges);
    const flowData = { ...(sessionData.flow ?? { flowId, flowVars: {} }) };
    let hops = 0;
    return advance(nodeId);
    async function advance(currentNodeId) {
        var _a, _b, _c, _d, _e;
        if (++hops > MAX_HOPS) {
            await (0, session_service_1.resetSession)(guestId, hotelId);
            return safeMenu(hotelId);
        }
        const node = nodeMap.get(currentNodeId);
        if (!node) {
            await (0, session_service_1.resetSession)(guestId, hotelId);
            return safeMenu(hotelId);
        }
        switch (node.type) {
            // ── start ───────────────────────────────────────────────────────────────
            case "start": {
                const next = nextNodeId(currentNodeId, adjacency);
                if (!next) {
                    await (0, session_service_1.resetSession)(guestId, hotelId);
                    return safeMenu(hotelId);
                }
                return advance(next);
            }
            // ── message ─────────────────────────────────────────────────────────────
            case "message": {
                const d = node.data;
                const text = interpolate(d.text || "", flowData.flowVars);
                const next = nextNodeId(currentNodeId, adjacency);
                if (!next) {
                    await (0, session_service_1.resetSession)(guestId, hotelId);
                    return text || safeMenu(hotelId);
                }
                await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                const rest = await advance(next);
                if (!text)
                    return rest;
                if (!rest)
                    return text;
                return `${text}\n\n${rest}`;
            }
            // ── question ────────────────────────────────────────────────────────────
            case "question": {
                const d = node.data;
                const qt = d.questionType ?? "text";
                // ── room_selection (legacy) ────────────────────────────────────────────
                if (qt === "room_selection") {
                    if (!flowData.waitingFor) {
                        const rooms = await fetchRoomTypes(hotelId);
                        const prompt = interpolate(d.text || "Please choose a room type:", flowData.flowVars);
                        const listText = buildRoomListText(prompt, rooms);
                        const updatedVars = {
                            ...flowData.flowVars,
                            __roomList__: JSON.stringify(rooms.map(r => ({ id: r.id, name: r.name, price: r.basePrice }))),
                        };
                        flowData.waitingFor = "answer";
                        flowData.flowVars = updatedVars;
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        return listText;
                    }
                    const rawList = JSON.parse(flowData.flowVars["__roomList__"] ?? "[]");
                    if (!rawList.length) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        return safeMenu(hotelId);
                    }
                    const num = parseInt(input, 10);
                    if (isNaN(num) || num < 1 || num > rawList.length) {
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        return d.validationError || `Please reply with a number between *1* and *${rawList.length}*.`;
                    }
                    const chosen = rawList[num - 1];
                    const prefix = d.variableName || "room";
                    flowData.flowVars = {
                        ...flowData.flowVars,
                        [`${prefix}TypeId`]: chosen.id,
                        [`${prefix}TypeName`]: chosen.name,
                        [`${prefix}Price`]: String(chosen.price),
                        bookingRoomTypeId: chosen.id,
                        bookingRoomTypeName: chosen.name,
                        bookingPricePerNight: String(chosen.price),
                    };
                    delete flowData.waitingFor;
                    const next = nextNodeId(currentNodeId, adjacency);
                    if (!next) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        return safeMenu(hotelId);
                    }
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                    return advance(next);
                }
                // ── date ───────────────────────────────────────────────────────────────
                if (qt === "date") {
                    if (!flowData.waitingFor) {
                        flowData.waitingFor = "answer";
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        const hint = " _(DD/MM/YYYY)_";
                        return interpolate(d.text || "Please enter a date:", flowData.flowVars) + hint;
                    }
                    const parsed = parseFlexDate(input);
                    if (!parsed) {
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        return d.validationError || "Please enter a valid date in *DD/MM/YYYY* format.";
                    }
                    if (d.dateMin === "today" && parsed < todayUTC()) {
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        return d.validationError || "Please enter a *future* date.";
                    }
                    if (d.dateMaxDays) {
                        const maxDate = new Date(todayUTC().getTime() + d.dateMaxDays * 86400000);
                        if (parsed > maxDate) {
                            await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                            return d.validationError || `Please enter a date within the next *${d.dateMaxDays} days*.`;
                        }
                    }
                    const dateStr = toDateStr(parsed);
                    flowData.flowVars = { ...flowData.flowVars, [d.variableName]: dateStr };
                    // Set canonical booking aliases if var name suggests check-in / check-out
                    const vl = d.variableName.toLowerCase();
                    if (vl.includes("checkin") || vl.includes("check_in") || vl === "checkin")
                        (_a = flowData.flowVars)["bookingCheckIn"] ?? (_a["bookingCheckIn"] = dateStr);
                    if (vl.includes("checkout") || vl.includes("check_out") || vl === "checkout")
                        (_b = flowData.flowVars)["bookingCheckOut"] ?? (_b["bookingCheckOut"] = dateStr);
                    delete flowData.waitingFor;
                    const next = nextNodeId(currentNodeId, adjacency);
                    if (!next) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        return safeMenu(hotelId);
                    }
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                    return advance(next);
                }
                // ── number ─────────────────────────────────────────────────────────────
                if (qt === "number") {
                    if (!flowData.waitingFor) {
                        flowData.waitingFor = "answer";
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        return interpolate(d.text || "Please enter a number:", flowData.flowVars);
                    }
                    const num = parseFloat(input.trim().replace(/,/g, ""));
                    if (isNaN(num)) {
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        return d.validationError || "Please enter a valid *number*.";
                    }
                    if (d.numberMin !== undefined && num < d.numberMin) {
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        return d.validationError || `The minimum value is *${d.numberMin}*.`;
                    }
                    if (d.numberMax !== undefined && num > d.numberMax) {
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        return d.validationError || `The maximum value is *${d.numberMax}*.`;
                    }
                    flowData.flowVars = { ...flowData.flowVars, [d.variableName]: String(num) };
                    delete flowData.waitingFor;
                    const next = nextNodeId(currentNodeId, adjacency);
                    if (!next) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        return safeMenu(hotelId);
                    }
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                    return advance(next);
                }
                // ── yes_no ─────────────────────────────────────────────────────────────
                if (qt === "yes_no") {
                    const yesLabel = d.yesLabel || "Yes";
                    const noLabel = d.noLabel || "No";
                    if (!flowData.waitingFor) {
                        flowData.waitingFor = "answer";
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        return `${interpolate(d.text || "Please choose:", flowData.flowVars)}\n\nReply *1* for *${yesLabel}* or *2* for *${noLabel}*.`;
                    }
                    const clean = input.toLowerCase().trim();
                    const isYes = clean === "1" || clean === "yes" || clean === "y";
                    const isNo = clean === "2" || clean === "no" || clean === "n";
                    if (!isYes && !isNo) {
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        return d.validationError || `Please reply *1* for *${yesLabel}* or *2* for *${noLabel}*.`;
                    }
                    flowData.flowVars = { ...flowData.flowVars, [d.variableName]: isYes ? "yes" : "no" };
                    delete flowData.waitingFor;
                    const next = nextNodeId(currentNodeId, adjacency);
                    if (!next) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        return safeMenu(hotelId);
                    }
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                    return advance(next);
                }
                // ── rating ─────────────────────────────────────────────────────────────
                if (qt === "rating") {
                    const maxStars = d.ratingMax ?? 5;
                    if (!flowData.waitingFor) {
                        flowData.waitingFor = "answer";
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        const stars = Array.from({ length: maxStars }, (_, i) => `*${i + 1}*`).join(" / ");
                        return `${interpolate(d.text || "How would you rate your experience?", flowData.flowVars)}\n\nReply with a number: ${stars} ⭐`;
                    }
                    const score = parseInt(input.trim());
                    if (isNaN(score) || score < 1 || score > maxStars) {
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                        return d.validationError || `Please reply with a number from *1* to *${maxStars}*.`;
                    }
                    const isPositive = d.ratingPositiveThreshold !== undefined && score >= d.ratingPositiveThreshold;
                    flowData.flowVars = {
                        ...flowData.flowVars,
                        [d.variableName]: String(score),
                        [`${d.variableName}_isPositive`]: isPositive ? "yes" : "no",
                    };
                    delete flowData.waitingFor;
                    const next = nextNodeId(currentNodeId, adjacency);
                    if (!next) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        let reply = `Thank you for your *${score}★* rating! 🌟`;
                        if (isPositive && d.reviewUrl)
                            reply += `\n\nWe'd love your review: ${d.reviewUrl}`;
                        return reply;
                    }
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                    const rest = await advance(next);
                    // Prepend the review link if positive rating
                    if (isPositive && d.reviewUrl) {
                        const reviewMsg = `Thank you for your *${score}★* rating! 🌟\n\nWe'd love your review: ${d.reviewUrl}`;
                        return rest ? `${reviewMsg}\n\n${rest}` : reviewMsg;
                    }
                    return rest;
                }
                // ── text (default) ─────────────────────────────────────────────────────
                if (!flowData.waitingFor) {
                    flowData.waitingFor = "answer";
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                    return interpolate(d.text || "Please reply.", flowData.flowVars);
                }
                // Validate text input
                const rule = d.validation ?? "none";
                if (rule === "number" && (isNaN(parseFloat(input)) || input.trim() === "")) {
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                    return d.validationError || "Please provide a valid number.";
                }
                if (rule === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim())) {
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                    return d.validationError || "Please provide a valid email address.";
                }
                if (rule === "date" && !parseFlexDate(input)) {
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                    return d.validationError || "Please provide a valid date.";
                }
                flowData.flowVars = { ...flowData.flowVars, [d.variableName]: input };
                // Canonical aliases
                if (d.variableName) {
                    const key = d.variableName.toLowerCase();
                    if (key.includes("name"))
                        (_c = flowData.flowVars)["bookingGuestName"] ?? (_c["bookingGuestName"] = input);
                    if (key.includes("checkin"))
                        (_d = flowData.flowVars)["bookingCheckIn"] ?? (_d["bookingCheckIn"] = input);
                    if (key.includes("checkout"))
                        (_e = flowData.flowVars)["bookingCheckOut"] ?? (_e["bookingCheckOut"] = input);
                }
                delete flowData.waitingFor;
                const next = nextNodeId(currentNodeId, adjacency);
                if (!next) {
                    await (0, session_service_1.resetSession)(guestId, hotelId);
                    return safeMenu(hotelId);
                }
                await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                return advance(next);
            }
            // ── check_availability ───────────────────────────────────────────────────
            case "check_availability": {
                const d = node.data;
                const vars = flowData.flowVars;
                const roomTypeId = vars[d.roomTypeIdVar] ?? null;
                const checkIn = vars[d.checkInVar] ?? null;
                const checkOut = vars[d.checkOutVar] ?? null;
                let available = false;
                let availableCount = 0;
                if (roomTypeId && checkIn && checkOut) {
                    const result = await (0, availability_service_1.checkRoomAvailability)(hotelId, roomTypeId, checkIn, checkOut);
                    available = result.available;
                    availableCount = result.availableCount;
                }
                // Store result for use in downstream nodes
                flowData.flowVars = {
                    ...flowData.flowVars,
                    availabilityResult: available ? "available" : "unavailable",
                    availabilityCount: String(availableCount),
                };
                const handle = available ? "available" : "unavailable";
                const fallback = nextNodeId(currentNodeId, adjacency);
                const next = nextNodeId(currentNodeId, adjacency, handle) ?? fallback;
                if (!next) {
                    await (0, session_service_1.resetSession)(guestId, hotelId);
                    return available ? null : (d.unavailableMessage || "Sorry, that room is not available for those dates. Please try different dates or contact us.");
                }
                if (!available && d.unavailableMessage) {
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                    const rest = await advance(next);
                    return rest ? `${d.unavailableMessage}\n\n${rest}` : d.unavailableMessage;
                }
                await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                return advance(next);
            }
            // ── show_rooms ───────────────────────────────────────────────────────────
            case "show_rooms": {
                const d = node.data;
                const vars = flowData.flowVars;
                if (!flowData.waitingFor) {
                    // Phase 1: fetch rooms and show list
                    let allRooms = await fetchRoomTypes(hotelId, {
                        ...(d.minCapacity ? { minCapacity: d.minCapacity } : {}),
                        ...(d.minAdults ? { minAdults: d.minAdults } : {}),
                        ...(d.minChildren ? { minChildren: d.minChildren } : {}),
                    });
                    let displayRooms = allRooms;
                    if (d.filter === "available_only") {
                        const checkIn = d.checkInVar ? vars[d.checkInVar] : null;
                        const checkOut = d.checkOutVar ? vars[d.checkOutVar] : null;
                        if (checkIn && checkOut) {
                            const results = await Promise.all(allRooms.map(async (r) => {
                                const res = await (0, availability_service_1.checkRoomAvailability)(hotelId, r.id, checkIn, checkOut);
                                return { ...r, availableCount: res.availableCount, available: res.available };
                            }));
                            displayRooms = results.filter((r) => r.available);
                        }
                    }
                    if (!displayRooms.length) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        return d.validationError
                            || "Sorry, there are no rooms available for those dates. Please try different dates or contact us directly.";
                    }
                    const prompt = interpolate(d.text || "Please choose a room type:", vars);
                    const listText = buildRoomListText(prompt, displayRooms);
                    flowData.waitingFor = "answer";
                    flowData.flowVars = {
                        ...vars,
                        __roomList__: JSON.stringify(displayRooms.map((r) => ({
                            id: r.id,
                            name: r.name,
                            price: r.basePrice,
                            maxAdults: r.maxAdults ?? null,
                            maxChildren: r.maxChildren ?? null,
                        }))),
                    };
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                    return listText;
                }
                // Phase 2: validate selection
                const rawList = JSON.parse(flowData.flowVars["__roomList__"] ?? "[]");
                if (!rawList.length) {
                    await (0, session_service_1.resetSession)(guestId, hotelId);
                    return safeMenu(hotelId);
                }
                const num = parseInt(input, 10);
                if (isNaN(num) || num < 1 || num > rawList.length) {
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${currentNodeId}`, { ...sessionData, flow: { ...flowData } });
                    return d.validationError || `Please reply with a number between *1* and *${rawList.length}*.`;
                }
                const chosen = rawList[num - 1];
                const prefix = d.variableName || "room";
                flowData.flowVars = {
                    ...flowData.flowVars,
                    [`${prefix}TypeId`]: chosen.id,
                    [`${prefix}TypeName`]: chosen.name,
                    [`${prefix}Price`]: String(chosen.price),
                    ...(chosen.maxAdults != null ? { [`${prefix}MaxAdults`]: String(chosen.maxAdults) } : {}),
                    ...(chosen.maxChildren != null ? { [`${prefix}MaxChildren`]: String(chosen.maxChildren) } : {}),
                    // canonical booking aliases
                    bookingRoomTypeId: chosen.id,
                    bookingRoomTypeName: chosen.name,
                    bookingPricePerNight: String(chosen.price),
                };
                delete flowData.waitingFor;
                const next = nextNodeId(currentNodeId, adjacency);
                if (!next) {
                    await (0, session_service_1.resetSession)(guestId, hotelId);
                    return safeMenu(hotelId);
                }
                await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                return advance(next);
            }
            // ── branch ───────────────────────────────────────────────────────────────
            case "branch": {
                const d = node.data;
                let handle = d.defaultHandleId;
                for (const cond of d.conditions) {
                    if (evaluateCondition(cond, flowData.flowVars)) {
                        handle = cond.id;
                        break;
                    }
                }
                const next = nextNodeId(currentNodeId, adjacency, handle) ??
                    nextNodeId(currentNodeId, adjacency, d.defaultHandleId) ??
                    nextNodeId(currentNodeId, adjacency);
                if (!next) {
                    await (0, session_service_1.resetSession)(guestId, hotelId);
                    return null;
                }
                return advance(next);
            }
            // ── action ───────────────────────────────────────────────────────────────
            case "action": {
                const d = node.data;
                // ── create_booking ─────────────────────────────────────────────────────
                if (d.actionType === "create_booking") {
                    const vars = flowData.flowVars;
                    const guestName = (d.guestNameVar && vars[d.guestNameVar]) || vars["bookingGuestName"] || null;
                    const roomTypeId = (d.roomTypeIdVar && vars[d.roomTypeIdVar]) || vars["bookingRoomTypeId"] || null;
                    const checkIn = (d.checkInVar && vars[d.checkInVar]) || vars["bookingCheckIn"] || null;
                    const checkOut = (d.checkOutVar && vars[d.checkOutVar]) || vars["bookingCheckOut"] || null;
                    const advancePaidRaw = d.advancePaidVar ? vars[d.advancePaidVar] : null;
                    if (!guestName || !roomTypeId || !checkIn || !checkOut) {
                        const next = nextNodeId(currentNodeId, adjacency);
                        const errMsg = "⚠️ Could not create booking — missing required details. Please contact us directly.";
                        if (!next) {
                            await (0, session_service_1.resetSession)(guestId, hotelId);
                            return errMsg;
                        }
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                        return advance(next);
                    }
                    const checkInDate = parseFlexDate(checkIn);
                    const checkOutDate = parseFlexDate(checkOut);
                    if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) {
                        const next = nextNodeId(currentNodeId, adjacency);
                        const errMsg = "⚠️ Booking failed — invalid or reversed dates. Please contact us directly.";
                        if (!next) {
                            await (0, session_service_1.resetSession)(guestId, hotelId);
                            return errMsg;
                        }
                        await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                        return advance(next);
                    }
                    const config = await connect_1.default.hotelConfig.findUnique({ where: { hotelId } });
                    if (config?.availabilityEnabled) {
                        const { available } = await (0, availability_service_1.checkRoomAvailability)(hotelId, roomTypeId, checkIn, checkOut);
                        if (!available) {
                            await (0, session_service_1.resetSession)(guestId, hotelId);
                            return "❌ Sorry, that room type is fully booked for the selected dates. Please contact us to check alternatives.";
                        }
                    }
                    const roomType = await connect_1.default.roomType.findFirst({ where: { id: roomTypeId, hotelId } });
                    const pricePerNight = roomType ? roomType.basePrice : 0;
                    const nights = Math.max(1, Math.ceil((checkOutDate.getTime() - checkInDate.getTime()) / 86400000));
                    const totalPrice = pricePerNight * nights;
                    const advancePaid = advancePaidRaw ? Math.round(parseFloat(advancePaidRaw)) : 0;
                    const booking = await connect_1.default.booking.create({
                        data: {
                            hotelId, guestId, roomTypeId, guestName,
                            checkIn: checkInDate, checkOut: checkOutDate,
                            status: "PENDING", pricePerNight, totalPrice, advancePaid,
                        },
                    });
                    flowData.flowVars = {
                        ...flowData.flowVars,
                        bookingRef: booking.id.slice(0, 8).toUpperCase(),
                        bookingStatus: "PENDING",
                        bookingId: booking.id,
                    };
                    const next = nextNodeId(currentNodeId, adjacency);
                    if (!next) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        return d.message
                            ? interpolate(d.message, flowData.flowVars)
                            : `✅ Booking confirmed! Your reference: *${flowData.flowVars["bookingRef"]}*`;
                    }
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                    return advance(next);
                }
                // ── update_booking_status ──────────────────────────────────────────────
                if (d.actionType === "update_booking_status") {
                    if (d.newStatus) {
                        const ref = d.bookingRefVar
                            ? flowData.flowVars[d.bookingRefVar]
                            : flowData.flowVars["bookingRef"];
                        if (ref) {
                            const booking = await connect_1.default.booking.findFirst({
                                where: { hotelId, id: { startsWith: ref.toLowerCase() } },
                            });
                            if (booking) {
                                await connect_1.default.booking.update({ where: { id: booking.id }, data: { status: d.newStatus } });
                                flowData.flowVars = { ...flowData.flowVars, bookingStatus: d.newStatus };
                            }
                        }
                    }
                    const next = nextNodeId(currentNodeId, adjacency);
                    if (!next) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        return d.message ? interpolate(d.message, flowData.flowVars) : null;
                    }
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                    return advance(next);
                }
                // ── set_variable ───────────────────────────────────────────────────────
                if (d.actionType === "set_variable") {
                    if (d.variableToSet && d.valueToSet !== undefined) {
                        flowData.flowVars = {
                            ...flowData.flowVars,
                            [d.variableToSet]: interpolate(d.valueToSet, flowData.flowVars),
                        };
                    }
                    const next = nextNodeId(currentNodeId, adjacency);
                    if (!next) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        return null;
                    }
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                    return advance(next);
                }
                // ── send_review_request ────────────────────────────────────────────────
                if (d.actionType === "send_review_request") {
                    let reviewUrl = d.reviewUrl?.trim() || null;
                    if (!reviewUrl) {
                        const cfg = await connect_1.default.hotelConfig.findUnique({ where: { hotelId } });
                        reviewUrl = cfg?.reviewUrl ?? null;
                    }
                    const bodyText = d.reviewMessage
                        ? interpolate(d.reviewMessage, flowData.flowVars)
                        : "We'd love to hear about your experience! Please take a moment to leave us a review.";
                    const fullMsg = reviewUrl ? `${bodyText}\n\n${reviewUrl}` : bodyText;
                    const next = nextNodeId(currentNodeId, adjacency);
                    if (!next) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        return fullMsg;
                    }
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                    const rest = await advance(next);
                    return rest ? `${fullMsg}\n\n${rest}` : fullMsg;
                }
                // ── notify_staff ───────────────────────────────────────────────────────
                if (d.actionType === "notify_staff") {
                    await connect_1.default.guest.update({ where: { id: guestId }, data: { lastHandledByStaff: true } }).catch(() => { });
                    flowData.flowVars = { ...flowData.flowVars, staffNotified: "yes" };
                    const next = nextNodeId(currentNodeId, adjacency);
                    if (!next) {
                        await (0, session_service_1.resetSession)(guestId, hotelId);
                        return d.message
                            ? interpolate(d.message, flowData.flowVars)
                            : "Our team has been notified and will be in touch shortly.";
                    }
                    await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                    const rest = await advance(next);
                    if (d.message) {
                        const note = interpolate(d.message, flowData.flowVars);
                        return rest ? `${note}\n\n${rest}` : note;
                    }
                    return rest;
                }
                // ── start_booking_flow (legacy) ────────────────────────────────────────
                if (d.actionType === "start_booking_flow") {
                    if (d.prefillFromVars) {
                        const vars = flowData.flowVars;
                        const guestName = (d.guestNameVar && vars[d.guestNameVar]) || vars["bookingGuestName"] || null;
                        const roomTypeId = (d.roomTypeIdVar && vars[d.roomTypeIdVar]) || vars["bookingRoomTypeId"] || null;
                        const roomTypeName = vars["bookingRoomTypeName"] || null;
                        const pricePerNight = vars["bookingPricePerNight"] ? Number(vars["bookingPricePerNight"]) : undefined;
                        const checkIn = (d.checkInVar && vars[d.checkInVar]) || vars["bookingCheckIn"] || null;
                        const checkOut = (d.checkOutVar && vars[d.checkOutVar]) || vars["bookingCheckOut"] || null;
                        const bookingData = {};
                        if (guestName)
                            bookingData["bookingGuestName"] = guestName;
                        if (roomTypeId)
                            bookingData["bookingRoomTypeId"] = roomTypeId;
                        if (roomTypeName)
                            bookingData["bookingRoomTypeName"] = roomTypeName;
                        if (pricePerNight)
                            bookingData["bookingPricePerNight"] = pricePerNight;
                        if (guestName && roomTypeId && checkIn && checkOut) {
                            bookingData["bookingCheckIn"] = checkIn;
                            bookingData["bookingCheckOut"] = checkOut;
                            await (0, session_service_1.updateSession)(guestId, hotelId, "BOOKING_CONFIRM", bookingData);
                            const reply = d.message ? `${d.message}\n\n` : "";
                            return `${reply}Please confirm your booking:\n\nGuest: *${guestName}*\nRoom: *${roomTypeName || roomTypeId}*\nCheck-in: *${checkIn}*\nCheck-out: *${checkOut}*\n\nReply *YES* to confirm or *NO* to cancel.`;
                        }
                        else if (guestName && roomTypeId) {
                            await (0, session_service_1.updateSession)(guestId, hotelId, "BOOKING_CHECKIN", bookingData);
                            const reply = d.message ? `${d.message}\n\n` : "";
                            return `${reply}📅 *Check-in date*\n\nPlease enter your check-in date:\n*DD/MM/YYYY*\n\n_Reply *0* to cancel._`;
                        }
                    }
                    await (0, session_service_1.updateSession)(guestId, hotelId, "BOOKING_NAME", {});
                    const prefix = d.message ? `${d.message}\n\n` : "";
                    return `${prefix}Let's get you booked in! Please enter your *full name* as it should appear on the reservation.\n\n_Reply *0* to cancel at any time._`;
                }
                // ── handoff_to_staff ───────────────────────────────────────────────────
                if (d.actionType === "handoff_to_staff") {
                    await (0, session_service_1.updateSession)(guestId, hotelId, "ENQUIRY_OPEN", {});
                    return ((d.message || "Our team will assist you shortly. Please share your query and we'll respond as soon as possible.") +
                        "\n\n_Reply *MENU* at any time to return to the main menu._");
                }
                // ── reset_to_menu ──────────────────────────────────────────────────────
                if (d.actionType === "reset_to_menu") {
                    await (0, session_service_1.resetSession)(guestId, hotelId);
                    const menu = await safeMenu(hotelId);
                    return d.message ? `${d.message}\n\n${menu ?? ""}`.trim() : menu;
                }
                // Unknown action — advance silently
                const next = nextNodeId(currentNodeId, adjacency);
                if (!next) {
                    await (0, session_service_1.resetSession)(guestId, hotelId);
                    return null;
                }
                await (0, session_service_1.updateSession)(guestId, hotelId, `FLOW:${flowId}:${next}`, { ...sessionData, flow: { ...flowData } });
                return advance(next);
            }
            // ── end ──────────────────────────────────────────────────────────────────
            case "end": {
                const d = node.data;
                await (0, session_service_1.resetSession)(guestId, hotelId);
                const text = d.farewellText?.trim();
                return text ? interpolate(text, flowData.flowVars) : null;
            }
            default: {
                await (0, session_service_1.resetSession)(guestId, hotelId);
                return safeMenu(hotelId);
            }
        }
    }
}
//# sourceMappingURL=flowRuntime.js.map