/**
 * ara/handler.ts — the node's single runtime entry point.
 *
 * Dispatch only: reads the phase out of session state and delegates. Two
 * idempotency rules are enforced here — a global MENU cancel that works in any
 * sub-phase, and a confirm arriving after state was already cleaned up (a
 * duplicate webhook) which must never re-write the output contract.
 */

import { computeRoomPricing, resolveRoomConfig } from "./allocator";
import {
  applyAddExtraBed,
  applyChangeRoomType,
  applyMoveGuest,
  applyRemoveExtraBed,
  applyRemoveRoom,
  inRange,
} from "./appliers";
import { resolveConfig } from "./config";
import { countNights } from "./dates";
import { buildInventoryRooms } from "./inventory";
import {
  isConfirmInput,
  isDoneInput,
  isGoBackInput,
  isMenuInput,
  isModifyInput,
  parseManualListReply,
  parseMoveToRoomSlot,
  roomMenuListReplyToIdx,
} from "./keywords";
import {
  addableRooms,
  buildManualRoomList,
  changeTypeCandidates,
  renderAllocationSummary,
  renderChangeTypeSelect,
  renderManualMode,
  renderMoveFromCount,
  renderMoveToRoom,
  renderPlanTextFallback,
  renderRoomMenu,
  roomMenuOptions,
} from "./render";
import { clearState, persist, readState, writeState } from "./state";
import {
  handleAgeCollection,
  handleAgeConfirmation,
} from "./phases/ages.phase";
import {
  confirmReply,
  finalizeAndAdvance,
  tryModify,
} from "./phases/confirm.phase";
import { generateAndSendPlans, phase1 } from "./phases/phase1";
import type {
  AdvancedRoomAllocationDeps,
  AdvancedRoomAllocationNodeData,
  AllocationRoom,
  AllocationRoomInput,
  ApplyResult,
  AraState,
  RoomAction,
  RoomConfigResolver,
} from "./types";

// ── Public entry point ────────────────────────────────────────────────────────

export async function handleAdvancedRoomAllocation(deps: AdvancedRoomAllocationDeps): Promise<string | null> {
  const { input, flowData, hotelId, guestId, resetSession, safeMenu, currentNodeId, adjacency, nextNodeId, advance } = deps;
  const vars = flowData.flowVars;

  // ── Phase 1 ─────────────────────────────────────────────────────────────────
  if (!flowData.waitingFor) {
    return phase1(deps);
  }

  // ── Phase 2 ─────────────────────────────────────────────────────────────────
  // Global cancel — works in any sub-phase.
  if (isMenuInput(input)) {
    clearState(vars);
    await resetSession(guestId, hotelId);
    return safeMenu(hotelId, guestId);
  }

  const state = readState(vars);

  // ── Idempotency rule 2: confirm arrives after state already cleaned up ─────
  // (e.g. a duplicate webhook after the first confirm already advanced past us)
  if (!state) {
    if (isConfirmInput(input)) {
      // Already confirmed and cleaned up. If output keys exist, this is a true
      // duplicate — silently no-op. If not, do a safe silent advance without
      // re-writing any keys.
      if (vars["bookingRooms"]) return null;
      delete flowData.waitingFor;
      const next = nextNodeId(currentNodeId, adjacency);
      if (!next) {
        await resetSession(guestId, hotelId);
        return safeMenu(hotelId, guestId);
      }
      return advance(next);
    }
    // No state and not a confirm-like input → reset gracefully.
    await resetSession(guestId, hotelId);
    return safeMenu(hotelId, guestId);
  }

  // ── Children-age collection sub-phase (Task 1) ─────────────────────────────
  // (MENU is already handled globally above.)
  if (state.phase === "collecting_ages") {
    return handleAgeCollection(deps, state);
  }

  // ── Age read-back sub-phase ────────────────────────────────────────────────
  // Only reached when the collected ages were uncertain (AI-parsed or sliced).
  // An older serialised state can never carry this phase, so nothing in flight
  // changes behaviour. (MENU handled globally above.)
  if (state.phase === "confirming_ages") {
    return handleAgeConfirmation(deps, state);
  }

  // ── Room-preference collection sub-phase (Piece 2A) ────────────────────────
  // Guest taps a carousel card (room_TYPE:{id}) → that's the preferred type;
  // taps/types "Mix it up" (MIX_IT_UP / "mix") → no preference. Then we generate
  // preference-aware plans and send the plan list. (MENU handled globally above.)
  if (state.phase === "collecting_room_preference") {
    const pref = state.prefCollection;
    if (!pref) {                         // corrupt state → reset gracefully
      clearState(vars);
      await resetSession(guestId, hotelId);
      return safeMenu(hotelId, guestId);
    }
    const t = input.trim();

    // "Mix it up" — list reply id MIX_IT_UP, or a typed "mix" fallback.
    if (/^MIX_IT_UP$/i.test(t) || /^mix$/i.test(t)) {
      return generateAndSendPlans(deps, { guestsField: state.guests, preferredRoomTypeId: null, pref });
    }

    // Carousel card tap — "room_TYPE:{id}" (or "ROOM_TYPE:{id}" text fallback).
    const tappedId = t.match(/^room_TYPE:(.+)$/i)?.[1] ?? t.match(/^ROOM_TYPE:(.+)$/i)?.[1];
    if (tappedId) {
      const known = pref.rooms.some((r) => r.roomTypeId === tappedId && r.availableCount > 0);
      const preferredRoomTypeId = known ? tappedId : null; // unknown id → treat as no preference
      return generateAndSendPlans(deps, { guestsField: state.guests, preferredRoomTypeId, pref });
    }

    // Unrecognised reply → re-prompt (stay in the phase, no mutation).
    return "Please tap a room type from the cards above, or *Mix it up 🎲* to let us choose. Reply *MENU* to cancel.";
  }

  // ── Plan selection sub-phase ───────────────────────────────────────────────
  // (MENU is already handled globally above.) Carousel taps are handled in the
  // preference phase now; here we only accept a plan choice.
  if (state.phase === "plan_selection") {
    const plans = state.plans ?? [];
    if (plans.length === 0) {            // corrupt state → reset gracefully
      clearState(vars);
      await resetSession(guestId, hotelId);
      return safeMenu(hotelId, guestId);
    }

    const t = input.trim();

    // ── Plan selection: "plan_N" (0-based) or text "1".."N" ──
    let idx = -1;
    const m = t.match(/^plan_(\d+)$/i);
    if (m) {
      idx = parseInt(m[1]!, 10);
    } else {
      const num = parseInt(t, 10);
      if (Number.isFinite(num)) idx = num - 1;
    }

    if (idx < 0 || idx >= plans.length) {
      // Invalid / unknown → re-show the TEXT list (never re-send the carousel). No mutation.
      return renderPlanTextFallback(plans);
    }

    const chosen = plans[idx]!;
    const confirmState: AraState = {
      guests:              state.guests,
      selectedRooms:       chosen.rooms,
      remainingGuests:     { adults: 0, children: 0 },
      phase:               "confirm",
      selectedPlanIndex:   idx,
      ...(state.preferredRoomTypeId !== undefined ? { preferredRoomTypeId: state.preferredRoomTypeId } : {}),
      ...(chosen.planType ? { selectedPlanType: chosen.planType } : {}),
    };
    writeState(vars, confirmState);
    await persist(deps);
    return confirmReply(deps, chosen.rooms, state.guests.childrenAges);
  }

  // ── Confirm sub-phase ──────────────────────────────────────────────────────
  if (state.phase === "confirm") {
    if (isConfirmInput(input)) {
      return finalizeAndAdvance(deps, state.selectedRooms);
    }
    if (isModifyInput(input)) {
      // Switch to manual mode but KEEP the suggested rooms as the starting point
      // (all guests already placed). The guest can add/remove rooms, move guests,
      // or DONE to confirm as-is — no rebuild from zero.
      const next: AraState = {
        guests:          state.guests,
        selectedRooms:   state.selectedRooms,
        remainingGuests: { adults: 0, children: 0 },
        phase:           "manual",
      };
      writeState(vars, next);
      await persist(deps);

      // Re-fetch room inputs so the add-room prompt has live availability info.
      const checkIn  = vars["bookingCheckIn"]!;
      const checkOut = vars["bookingCheckOut"]!;
      const confirmRooms  = await buildInventoryRooms(hotelId, checkIn, checkOut, deps.fetchRoomTypes, deps.getCalendarData);
      const confirmAddable = addableRooms(confirmRooms, next.selectedRooms);
      if (deps.sendManualModeList) {
        const sent = await deps.sendManualModeList({ hotelId, guestId, state: next, addable: confirmAddable });
        if (sent) return "ALREADY_SENT";
      }
      return renderManualMode(next, confirmAddable);
    }
    // Free text at the confirm step → AI modification, staying in confirm phase
    // (Fix B). No interpreter dep → unchanged behaviour (no AI call, no fetch).
    if (deps.interpretModification) {
      const ci = vars["bookingCheckIn"];
      const co = vars["bookingCheckOut"];
      const roomInputs = ci && co
        ? await buildInventoryRooms(hotelId, ci, co, deps.fetchRoomTypes, deps.getCalendarData)
        : [];
      const aiReply = await tryModify(deps, state, roomInputs, input, "confirm");
      if (aiReply !== null) return aiReply;
    }
    return `Please reply *1* to confirm, *2* to modify, or *MENU* to cancel.\n\n${renderAllocationSummary(state.selectedRooms, { childrenAges: state.guests.childrenAges })}`;
  }

  // ── Manual sub-phase ───────────────────────────────────────────────────────
  // Re-fetch rooms each turn — availability may have shifted; do not cache.
  const checkIn  = vars["bookingCheckIn"];
  const checkOut = vars["bookingCheckOut"];
  if (!checkIn || !checkOut) {
    clearState(vars);
    await resetSession(guestId, hotelId);
    return safeMenu(hotelId, guestId);
  }
  const rooms = await buildInventoryRooms(hotelId, checkIn, checkOut, deps.fetchRoomTypes, deps.getCalendarData);
  const data   = (deps.node.data ?? {}) as AdvancedRoomAllocationNodeData;
  const config = resolveConfig(data);
  const nights = countNights(checkIn, checkOut);

  // Per-room config resolver from live inventory (DB overrides → node config) —
  // used by the appliers and the destination caps shown in move_to_room.
  const inputById = new Map(rooms.map((ri) => [ri.roomTypeId, ri]));
  const resolveCfg: RoomConfigResolver = (ar) => {
    const ri = inputById.get(ar.roomTypeId);
    return ri ? resolveRoomConfig(ri, config) : config;
  };

  // Return to manual mode showing the modify menu. (remainingGuests is preserved
  // from `state`; the structured-modify phases only run when all guests are placed.)
  const toManual = async (selectedRooms: AllocationRoom[]): Promise<string> => {
    const m: AraState = {
      guests:          state.guests,
      selectedRooms,
      remainingGuests: state.remainingGuests,
      phase:           "manual",
    };
    writeState(vars, m);
    await persist(deps);
    const addable = addableRooms(rooms, selectedRooms);
    if (deps.sendManualModeList) {
      const sent = await deps.sendManualModeList({ hotelId, guestId, state: m, addable });
      if (sent) return "ALREADY_SENT";
    }
    return renderManualMode(m, addable);
  };

  // Helper to show / re-show the room-menu: optionally via interactive list.
  const showRoomMenu = async (targetRoom: AllocationRoom, roomOpts: RoomAction[], roomIdx: number): Promise<string> => {
    if (deps.sendRoomMenuList) {
      const sent = await deps.sendRoomMenuList({ hotelId, guestId, room: targetRoom, options: roomOpts, roomIndex: roomIdx });
      if (sent) return "ALREADY_SENT";
    }
    return renderRoomMenu(targetRoom, roomOpts, roomIdx);
  };

  // ── room_menu — per-room action picker (deterministic, no AI) ──────────────
  if (state.phase === "room_menu") {
    const idx = state.selectedRoomIndex ?? -1;
    if (!inRange(state.selectedRooms, idx)) return toManual(state.selectedRooms);
    const targetRoom = state.selectedRooms[idx]!;
    const options    = roomMenuOptions(targetRoom, resolveCfg(targetRoom));
    const t = input.trim();
    // "0" typed or MOD_GO_BACK list reply → go back to manual overview.
    if (isGoBackInput(t)) return toManual(state.selectedRooms);
    // Map list-reply ids to 1-based option indices; fall through to numeric parse.
    const listSel = roomMenuListReplyToIdx(t, options);
    const sel = listSel ?? parseInt(t, 10);
    if (!Number.isFinite(sel) || sel < 1 || sel > options.length) {
      return showRoomMenu(targetRoom, options, idx);
    }
    const action = options[sel - 1]!;
    if (action === "move_guest") {
      const mv: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "move_from_count", selectedRoomIndex: idx,
      };
      writeState(vars, mv);
      await persist(deps);
      return renderMoveFromCount(targetRoom, idx);
    }
    if (action === "change_type") {
      const candidates = changeTypeCandidates(rooms, targetRoom);
      if (candidates.length === 0) {
        // No other types available — explain and re-show the menu (not an error).
        const menuText = renderRoomMenu(targetRoom, options, idx);
        return `Sorry, there are no other room types to switch to.\n\n${menuText}`;
      }
      const ct: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "change_type_select", selectedRoomIndex: idx,
      };
      writeState(vars, ct);
      await persist(deps);
      if (deps.sendChangeRoomTypeList) {
        const sent = await deps.sendChangeRoomTypeList({ hotelId, guestId, room: targetRoom, roomIndex: idx, candidates });
        if (sent) return "ALREADY_SENT";
      }
      return renderChangeTypeSelect(targetRoom, candidates, idx);
    }
    const res: ApplyResult =
      action === "add_bed"    ? applyAddExtraBed(state.selectedRooms, idx, resolveCfg)
      : action === "remove_bed" ? applyRemoveExtraBed(state.selectedRooms, idx)
      : /* remove_room */         applyRemoveRoom(state.selectedRooms, idx);
    if (res.ok) return toManual(res.rooms);
    const reason = res.reason || "Sorry, that didn't work. Please choose another option.";
    return `${reason}\n\n${renderRoomMenu(targetRoom, options, idx)}`;
  }

  // ── move_from_count — how many adults/children to move out ─────────────────
  if (state.phase === "move_from_count") {
    const idx = state.selectedRoomIndex ?? -1;
    if (!inRange(state.selectedRooms, idx)) return toManual(state.selectedRooms);
    const targetRoom = state.selectedRooms[idx]!;
    const t = input.trim();
    if (isGoBackInput(t)) {
      const rm: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "room_menu", selectedRoomIndex: idx,
      };
      writeState(vars, rm);
      await persist(deps);
      return showRoomMenu(targetRoom, roomMenuOptions(targetRoom, resolveCfg(targetRoom)), idx);
    }
    const nums = t.split(/\s+/).map((s) => parseInt(s, 10));
    const mvA = Number.isFinite(nums[0]) ? nums[0]! : NaN;
    const mvC = nums.length >= 2 && Number.isFinite(nums[1]) ? nums[1]! : 0;
    if (!Number.isFinite(mvA) || mvA < 0 || mvC < 0 || (mvA === 0 && mvC === 0) ||
        mvA > targetRoom.adults || mvC > targetRoom.children) {
      return `Please reply like *1 0* (adults children) — at least one above 0, and no more than the room has.\n\n${renderMoveFromCount(targetRoom, idx)}`;
    }
    const mv: AraState = {
      guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
      phase: "move_to_room", selectedRoomIndex: idx, pendingMove: { fromRoomIndex: idx, adults: mvA, children: mvC },
    };
    writeState(vars, mv);
    await persist(deps);
    if (deps.sendMoveToRoomList) {
      const r = await deps.sendMoveToRoomList({ hotelId, guestId, state: mv, fromIndex: idx, pending: mv.pendingMove!, resolveCfg });
      if (r.sent) return "ALREADY_SENT";
    }
    return renderMoveToRoom(mv, mv.pendingMove!, idx, resolveCfg);
  }

  // ── move_to_room — pick the destination room ───────────────────────────────
  if (state.phase === "move_to_room") {
    const pm = state.pendingMove;
    if (!pm || !inRange(state.selectedRooms, pm.fromRoomIndex)) return toManual(state.selectedRooms);
    const fromIdx = pm.fromRoomIndex;
    const t = input.trim();
    if (isGoBackInput(t)) {
      const back: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "move_from_count", selectedRoomIndex: fromIdx, pendingMove: pm, // preserve pendingMove
      };
      writeState(vars, back);
      await persist(deps);
      return renderMoveFromCount(state.selectedRooms[fromIdx]!, fromIdx);
    }
    const destIndices = state.selectedRooms.map((_, i) => i).filter((i) => i !== fromIdx);
    // Accept MOVE_TO_ROOM_{n} list-reply OR typed slot number.
    const listSlot = parseMoveToRoomSlot(t);
    const sel = listSlot ?? parseInt(t, 10);
    if (!Number.isFinite(sel) || sel < 1 || sel > destIndices.length) {
      // Re-show — list senders are fire-and-forget here (re-render only).
      return renderMoveToRoom(state, pm, fromIdx, resolveCfg);
    }
    const toIdx = destIndices[sel - 1]!;
    const res = applyMoveGuest(state.selectedRooms, fromIdx, toIdx, pm.adults, pm.children, resolveCfg);
    if (res.ok) return toManual(res.rooms);
    if (res.outOfRange) return renderMoveToRoom(state, pm, fromIdx, resolveCfg);
    return `${res.reason}\n\n${renderMoveToRoom(state, pm, fromIdx, resolveCfg)}`;
  }

  // ── change_type_select — pick the new room type ────────────────────────────
  if (state.phase === "change_type_select") {
    const idx = state.selectedRoomIndex ?? -1;
    if (!inRange(state.selectedRooms, idx)) return toManual(state.selectedRooms);
    const targetRoom = state.selectedRooms[idx]!;
    const candidates = changeTypeCandidates(rooms, targetRoom);
    const t = input.trim();
    if (isGoBackInput(t) || t.toUpperCase() === "CHANGE_TYPE_GO_BACK") {
      const rm: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "room_menu", selectedRoomIndex: idx,
      };
      writeState(vars, rm);
      await persist(deps);
      return showRoomMenu(targetRoom, roomMenuOptions(targetRoom, resolveCfg(targetRoom)), idx);
    }

    // Accept CHANGE_TYPE_{roomTypeId} list-reply or typed slot number.
    const typeId = t.match(/^CHANGE_TYPE_(.+)$/i)?.[1] ?? null;
    let target: AllocationRoomInput | undefined;
    if (typeId) {
      target = candidates.find((c) => c.roomTypeId === typeId);
    } else {
      const sel = parseInt(t, 10);
      if (Number.isFinite(sel) && sel >= 1 && sel <= candidates.length) {
        target = candidates[sel - 1];
      }
    }

    // Helper to re-show the picker (optionally as list).
    const showChangeTypePicker = async (): Promise<string> => {
      if (deps.sendChangeRoomTypeList) {
        const sent = await deps.sendChangeRoomTypeList({ hotelId, guestId, room: targetRoom, roomIndex: idx, candidates });
        if (sent) return "ALREADY_SENT";
      }
      return renderChangeTypeSelect(targetRoom, candidates, idx);
    };

    if (!target) return showChangeTypePicker();
    const res = applyChangeRoomType(state.selectedRooms, idx, target, resolveCfg);
    if (res.ok) return toManual(res.rooms);
    if (res.outOfRange) return showChangeTypePicker();
    return `${res.reason}\n\n${renderChangeTypeSelect(targetRoom, candidates, idx)}`;
  }

  // ── phase "manual" ─────────────────────────────────────────────────────────
  const allPlaced = state.remainingGuests.adults + state.remainingGuests.children === 0;

  if (isDoneInput(input)) {
    if (state.selectedRooms.length === 0) {
      return `You haven't picked any rooms yet. ${buildManualRoomList(rooms, state.remainingGuests)}`;
    }
    return finalizeAndAdvance(deps, state.selectedRooms);
  }

  const rawInput = input.trim();
  const pick = parseInt(rawInput, 10);

  // All guests placed → numbered menu: 1..N edit an existing room (room_menu),
  // N+1..N+M add a room type (offset). Also accepts list-reply ids (EDIT_ROOM_*,
  // ADD_ROOM_*, MODIFY_GO_BACK). Anything else → AI free text, else re-render.
  if (allPlaced) {
    const addable = addableRooms(rooms, state.selectedRooms);
    const n = state.selectedRooms.length;

    // MODIFY_GO_BACK list reply → same as "0" (back to confirm, no-op here since
    // the manual phase has no "back" — just re-show the overview).
    if (isGoBackInput(rawInput)) {
      return toManual(state.selectedRooms);
    }

    // Resolve list-reply to a slot number or room-type id.
    const listReply = parseManualListReply(rawInput);

    // Determine effective edit slot: list reply EDIT_ROOM_{n} or typed number.
    const editSlot = listReply?.kind === "edit" ? listReply.slot :
      (Number.isFinite(pick) && pick >= 1 && pick <= n ? pick : null);

    if (editSlot !== null) {
      const targetRoom = state.selectedRooms[editSlot - 1]!;
      const menu: AraState = {
        guests: state.guests, selectedRooms: state.selectedRooms, remainingGuests: state.remainingGuests,
        phase: "room_menu", selectedRoomIndex: editSlot - 1,
      };
      writeState(vars, menu);
      await persist(deps);
      return showRoomMenu(targetRoom, roomMenuOptions(targetRoom, resolveCfg(targetRoom)), editSlot - 1);
    }

    // Add-room via list reply ADD_ROOM_{roomTypeId}: find in addable by roomTypeId.
    if (listReply?.kind === "add") {
      const roomToAdd = addable.find((r) => r.roomTypeId === listReply.roomTypeId);
      if (roomToAdd) {
        const rc   = resolveRoomConfig(roomToAdd, config);
        const effMaxAdults   = Math.min(config.maxAdults + (config.allowExtraBed ? 1 : 0), roomToAdd.maxAdults ?? Infinity);
        const effMaxChildren = Math.min(config.maxChildren, roomToAdd.maxChildren ?? Infinity);
        const addAdults   = Math.min(rc.baseAdults,   effMaxAdults);
        const addChildren = Math.min(rc.baseChildren, effMaxChildren);
        const p = computeRoomPricing(roomToAdd.basePrice, addAdults, false, nights, rc);
        const extraRoom: AllocationRoom = {
          roomTypeId:    roomToAdd.roomTypeId,
          roomTypeName:  roomToAdd.name,
          adults:        addAdults,
          children:      addChildren,
          extraBed:      false,
          basePrice:     roomToAdd.basePrice,
          extraAdultCost: p.extraAdultCost,
          extraBedCost:   p.extraBedCost,
          childAgeLimit: rc.childAgeLimit,
          pricePerNight:  p.pricePerNight,
          nights,
          totalPrice:     p.totalPrice,
        };
        return toManual([...state.selectedRooms, extraRoom]);
      }
    }

    // Add-room via typed offset number N+1..N+M.
    if (Number.isFinite(pick) && pick >= n + 1 && pick <= n + addable.length) {
      const roomToAdd = addable[pick - n - 1]!;
      const rc   = resolveRoomConfig(roomToAdd, config);
      const effMaxAdults   = Math.min(config.maxAdults + (config.allowExtraBed ? 1 : 0), roomToAdd.maxAdults ?? Infinity);
      const effMaxChildren = Math.min(config.maxChildren, roomToAdd.maxChildren ?? Infinity);
      // Extra room by choice → base occupancy, no extra bed (base never exceeds base).
      const addAdults   = Math.min(rc.baseAdults,   effMaxAdults);
      const addChildren = Math.min(rc.baseChildren, effMaxChildren);
      const p = computeRoomPricing(roomToAdd.basePrice, addAdults, false, nights, rc);
      const extraRoom: AllocationRoom = {
        roomTypeId:    roomToAdd.roomTypeId,
        roomTypeName:  roomToAdd.name,
        adults:        addAdults,
        children:      addChildren,
        extraBed:      false,
        basePrice:     roomToAdd.basePrice,
        extraAdultCost: p.extraAdultCost,
        extraBedCost:   p.extraBedCost,
        childAgeLimit: rc.childAgeLimit,
        pricePerNight:  p.pricePerNight,
        nights,
        totalPrice:     p.totalPrice,
      };
      return toManual([...state.selectedRooms, extraRoom]);
    }

    // Not a valid menu number or list reply → AI free-text convenience, else re-show.
    const aiReply = await tryModify(deps, state, rooms, input, "manual");
    return aiReply ?? renderManualMode(state, addable);
  }

  // ── Guests still need rooms → fill-by-number flow (legacy / rebuild path) ──
  if (!Number.isFinite(pick) || pick < 1 || pick > rooms.length) {
    const aiReply = await tryModify(deps, state, rooms, input, "manual");
    return aiReply ?? `Please reply with a room number (1–${rooms.length}), *DONE* to finish, or *MENU* to cancel.`;
  }
  const room = rooms[pick - 1]!;

  const alreadyPickedOfType = state.selectedRooms.filter((r) => r.roomTypeId === room.roomTypeId).length;
  if (room.availableCount - alreadyPickedOfType <= 0) {
    return `Sorry, no more *${room.name}* rooms available for those dates. Please pick another.`;
  }

  const effMaxAdults   = Math.min(config.maxAdults + (config.allowExtraBed ? 1 : 0), room.maxAdults ?? Infinity);
  const effMaxChildren = Math.min(config.maxChildren, room.maxChildren ?? Infinity);
  const takeAdults     = Math.min(state.remainingGuests.adults,   effMaxAdults);
  const takeChildren   = Math.min(state.remainingGuests.children, effMaxChildren);

  if (takeAdults + takeChildren === 0) {
    return `Sorry, *${room.name}* can't take your remaining guests. Please pick another.\n\n${buildManualRoomList(rooms, state.remainingGuests)}`;
  }

  const rc       = resolveRoomConfig(room, config);
  const extraBed = takeAdults > rc.baseAdults;
  const p        = computeRoomPricing(room.basePrice, takeAdults, extraBed, nights, rc);

  const newRoom: AllocationRoom = {
    roomTypeId:    room.roomTypeId,
    roomTypeName:  room.name,
    adults:        takeAdults,
    children:      takeChildren,
    extraBed,
    basePrice:     room.basePrice,
    extraAdultCost: p.extraAdultCost,
    extraBedCost:   p.extraBedCost,
    childAgeLimit: rc.childAgeLimit,
    pricePerNight:  p.pricePerNight,
    nights,
    totalPrice:     p.totalPrice,
  };

  const updated: AraState = {
    guests:        state.guests,
    selectedRooms: [...state.selectedRooms, newRoom],
    remainingGuests: {
      adults:   state.remainingGuests.adults   - takeAdults,
      children: state.remainingGuests.children - takeChildren,
    },
    phase: "manual",
  };
  writeState(vars, updated);
  await persist(deps);

  if (updated.remainingGuests.adults + updated.remainingGuests.children === 0) {
    return renderManualMode(updated, addableRooms(rooms, updated.selectedRooms));
  }
  const summary = renderAllocationSummary(updated.selectedRooms, { childrenAges: updated.guests.childrenAges });
  return `${summary}\n\n${buildManualRoomList(rooms, updated.remainingGuests)}`;
}
