/**
 * modifyLists.test.ts — the four modify-phase senders, at payload level.
 *
 * Closes Stage 1 audit finding F9. `occupancyLabel` has three call sites, but
 * only the `buildManualModeSections` one was reachable from a test; the other
 * two live inside these senders, which call `sendOutbound`. Mocking that one
 * module — exactly as planList.test.ts already does — makes both reachable and
 * lets every outgoing field be asserted without prisma, Redis or a network call.
 *
 * Written in Stage 2C, when modifyLists still held its own literals, to pin the
 * CURRENT strings and prove they equalled the registry defaults. Stage 2E then
 * threaded the registry in — and this file passed UNCHANGED, which is the
 * byte-identity evidence it was written to provide. Keep it that way: the copy
 * plumbing is tested separately in araListCopy.test.ts, so this stays a pure
 * default-output regression net.
 *
 * Also guards against the failure mode the brief names: payload construction
 * must not bypass validation or truncate unexpectedly. Row titles and
 * descriptions ARE sliced here by design (24 / 72); bodyText, buttonLabel and
 * footerText are NOT, because sendListMessage passes those verbatim.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendOutbound = vi.fn();
vi.mock("../../services/outbound/outbound.service", () => ({
  sendOutbound: (...a: unknown[]) => sendOutbound(...a),
}));

import { MessageChannel } from "@prisma/client";
import {
  trySendChangeRoomTypeList, trySendManualModeList,
  trySendMoveToRoomList, trySendRoomMenuList,
} from "./modifyLists";
import { DEFAULT_RESOLVED, fillKey } from "./ara/copy";
import { inr } from "./ara/money";
import type {
  AllocationConfig, AllocationRoom, AllocationRoomInput,
  AraState, RoomConfigResolver,
} from "./ara/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CFG: AllocationConfig = {
  baseAdults: 2, baseChildren: 0, maxAdults: 3, maxChildren: 1,
  extraAdultCharge: 500, allowExtraBed: true, extraBedCharge: 800, childAgeLimit: null,
};
const resolveCfg: RoomConfigResolver = () => CFG;

function room(over: Partial<AllocationRoom> = {}): AllocationRoom {
  return {
    roomTypeId: "rt_a", roomTypeName: "Deluxe",
    adults: 2, children: 1, extraBed: false,
    basePrice: 5000, extraAdultCost: 0, extraBedCost: 0,
    childAgeLimit: null, pricePerNight: 5000, nights: 2, totalPrice: 10000,
    ...over,
  };
}
function roomInput(over: Partial<AllocationRoomInput> = {}): AllocationRoomInput {
  return {
    roomTypeId: "rt_b", name: "Superior", basePrice: 7000,
    maxAdults: 3, maxChildren: 1, availableCount: 4, description: "Sea view",
    ...over,
  };
}
function st(rooms: AllocationRoom[]): AraState {
  return {
    guests: { adults: 2, children: 1 },
    selectedRooms: rooms,
    remainingGuests: { adults: 0, children: 0 },
    phase: "manual",
  };
}
const ctx = { hotelId: "h1", guestId: "g1", channel: MessageChannel.WHATSAPP };

/** The single `choice` payload the sender handed to sendOutbound. */
function sentPayload() {
  expect(sendOutbound).toHaveBeenCalledTimes(1);
  const [context, payload] = sendOutbound.mock.calls[0]!;
  expect(context).toEqual({ hotelId: "h1", guestId: "g1", channel: MessageChannel.WHATSAPP });
  return payload as {
    kind: string; bodyText: string; buttonLabel: string; footerText?: string;
    sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
  };
}

beforeEach(() => {
  sendOutbound.mockReset();
  sendOutbound.mockResolvedValue({ sent: true });
});

// ── trySendRoomMenuList ───────────────────────────────────────────────────────

describe("trySendRoomMenuList", () => {
  it("builds the room-menu choice payload", async () => {
    const ok = await trySendRoomMenuList({
      ...ctx, room: room(), options: ["add_bed", "move_guest", "remove_room"], roomIndex: 0,
    });
    expect(ok).toBe(true);

    const p = sentPayload();
    expect(p.kind).toBe("choice");
    expect(p.bodyText).toBe("*Room 1: Deluxe*\n👥 2 adults, 1 child\n💰 ₹5,000/night\n\nWhat would you like to do?");
    expect(p.buttonLabel).toBe("Options");
    expect(p.footerText).toBe("Type 'Hi' to cancel");
    expect(p.sections.map((s) => s.title)).toEqual(["Modify Room", "Navigation"]);
    expect(p.sections[0]!.rows.map((r) => r.id))
      .toEqual(["MOD_ADD_EXTRA_BED", "MOD_MOVE_GUEST_OUT", "MOD_REMOVE_ROOM"]);
    expect(p.sections[1]!.rows[0]!.id).toBe("MOD_GO_BACK");
  });

  it("the body uses occupancyLabel — F9 call site 1 of 2", async () => {
    // occupancyLabel ALWAYS prints the children clause and NEVER the extra bed,
    // unlike occupancyPhrase on the text path. Previously unreachable.
    await trySendRoomMenuList({
      ...ctx, room: room({ children: 0, extraBed: true }), options: ["remove_bed"], roomIndex: 0,
    });
    expect(sentPayload().bodyText).toContain("👥 2 adults, 0 children\n");
    expect(sentPayload().bodyText).not.toContain("extra bed");
  });

  it("every copy field equals its registry default", async () => {
    await trySendRoomMenuList({ ...ctx, room: room(), options: ["add_bed"], roomIndex: 0 });
    const p = sentPayload();
    expect(p.buttonLabel).toBe(fillKey(DEFAULT_RESOLVED, "lists.buttonOptions"));
    expect(p.footerText).toBe(fillKey(DEFAULT_RESOLVED, "lists.cancelFooter"));
    expect(p.sections[0]!.title).toBe(fillKey(DEFAULT_RESOLVED, "lists.modifyRoomSection"));
    expect(p.sections[1]!.title).toBe(fillKey(DEFAULT_RESOLVED, "lists.navigationSection"));
    expect(p.sections[1]!.rows[0]!.title).toBe(fillKey(DEFAULT_RESOLVED, "lists.goBackRow"));
    expect(p.bodyText).toContain(fillKey(DEFAULT_RESOLVED, "roomMenu.question"));
  });

  it("returns false and sends nothing when the pipeline declines", async () => {
    sendOutbound.mockResolvedValue({ sent: false, reason: "unsupported" });
    expect(await trySendRoomMenuList({ ...ctx, room: room(), options: ["add_bed"], roomIndex: 0 })).toBe(false);
  });

  it("never throws when the pipeline does", async () => {
    sendOutbound.mockRejectedValue(new Error("boom"));
    expect(await trySendRoomMenuList({ ...ctx, room: room(), options: ["add_bed"], roomIndex: 0 })).toBe(false);
  });
});

// ── trySendManualModeList ─────────────────────────────────────────────────────

describe("trySendManualModeList", () => {
  it("builds the manual-mode overview payload", async () => {
    const ok = await trySendManualModeList({ ...ctx, state: st([room()]), addable: [roomInput()] });
    expect(ok).toBe(true);

    const p = sentPayload();
    expect(p.bodyText).toBe("✏️ *Modify your booking*\nRoom 1: Deluxe — 2 adults, 1 child — ₹10,000\n\n*Total: ₹10,000*");
    expect(p.buttonLabel).toBe("Edit Booking");
    expect(p.footerText).toBe("Type 'Hi' to cancel");
    expect(p.sections.map((s) => s.title)).toEqual(["Edit Existing Rooms", "Add a Room", "Confirm"]);
    expect(p.sections[0]!.rows[0]).toEqual({
      id: "EDIT_ROOM_1", title: "Edit Room 1: Deluxe", description: "2 adults, 1 child — ₹10,000",
    });
    expect(p.sections[1]!.rows[0]!.id).toBe("ADD_ROOM_rt_b");
    expect(p.sections[2]!.rows.map((r) => r.id)).toEqual(["MODIFY_DONE", "MODIFY_GO_BACK"]);
  });

  it("the summary uses occupancyLabel — F9 call site 2 of 2", async () => {
    await trySendManualModeList({
      ...ctx, state: st([room({ children: 0, extraBed: true })]), addable: [],
    });
    const p = sentPayload();
    expect(p.bodyText).toContain("Room 1: Deluxe — 2 adults, 0 children — ₹10,000");
    expect(p.bodyText).not.toContain("extra bed");
    // And the text path differs on the same screen — the preserved divergence.
    expect(p.bodyText).not.toContain("*Room 1:");
  });

  it("row title and description equal their registry defaults", async () => {
    await trySendManualModeList({ ...ctx, state: st([room()]), addable: [roomInput()] });
    const p = sentPayload();
    expect(p.sections[0]!.rows[0]!.title).toBe(
      fillKey(DEFAULT_RESOLVED, "lists.editRoomTitle", { roomNumber: 1, roomTypeName: "Deluxe" }),
    );
    expect(p.sections[0]!.rows[0]!.description).toBe(
      fillKey(DEFAULT_RESOLVED, "lists.editRoomDesc", { occupancy: "2 adults, 1 child", total: inr(10000) }),
    );
    expect(p.sections[1]!.rows[0]!.description).toBe(
      fillKey(DEFAULT_RESOLVED, "lists.addRoomDesc", {
        maxAdults: 3, maxChildren: 1, price: inr(7000), available: 4,
      }),
    );
  });

  it("omits a section with no rows", async () => {
    await trySendManualModeList({ ...ctx, state: st([]), addable: [] });
    expect(sentPayload().sections.map((s) => s.title)).toEqual(["Confirm"]);
  });
});

// ── trySendMoveToRoomList ─────────────────────────────────────────────────────

describe("trySendMoveToRoomList", () => {
  it("builds the destination picker and returns the slot mapping", async () => {
    const res = await trySendMoveToRoomList({
      ...ctx,
      state: st([room(), room({ roomTypeName: "Superior" }), room({ roomTypeName: "Basic" })]),
      fromIndex: 0, pending: { adults: 1, children: 1 }, resolveCfg,
    });
    expect(res).toEqual({ sent: true, destIndices: [1, 2] });

    const p = sentPayload();
    expect(p.bodyText).toBe("Move 1 adult, 1 child to which room?");
    expect(p.buttonLabel).toBe("Choose Room");
    expect(p.sections[0]!.title).toBe("Available Rooms");
    expect(p.sections[0]!.rows.map((r) => r.id)).toEqual(["MOVE_TO_ROOM_1", "MOVE_TO_ROOM_2"]);
    expect(p.sections[0]!.rows[0]!.description)
      .toBe("Currently 2 adults, 1 children (max 3 adults, 1 children)");
  });

  it("the row description equals its registry default", async () => {
    await trySendMoveToRoomList({
      ...ctx, state: st([room(), room()]), fromIndex: 0,
      pending: { adults: 1, children: 0 }, resolveCfg,
    });
    expect(sentPayload().sections[0]!.rows[0]!.description).toBe(
      fillKey(DEFAULT_RESOLVED, "lists.moveToRoomDesc", {
        adults: 2, children: 1, maxAdults: 3, maxChildren: 1,
      }),
    );
  });

  it("sends nothing when there is no destination", async () => {
    const res = await trySendMoveToRoomList({
      ...ctx, state: st([room()]), fromIndex: 0, pending: { adults: 1, children: 0 }, resolveCfg,
    });
    expect(res).toEqual({ sent: false, destIndices: [] });
    expect(sendOutbound).not.toHaveBeenCalled();
  });
});

// ── trySendChangeRoomTypeList ─────────────────────────────────────────────────

describe("trySendChangeRoomTypeList", () => {
  it("builds the change-type picker payload", async () => {
    const ok = await trySendChangeRoomTypeList({
      ...ctx, room: room(), roomIndex: 0, candidates: [roomInput()],
    });
    expect(ok).toBe(true);

    const p = sentPayload();
    expect(p.bodyText).toBe("Change Room 1 to which type?");
    expect(p.buttonLabel).toBe("Choose Type");
    expect(p.sections.map((s) => s.title)).toEqual(["Available Room Types", "Navigation"]);
    expect(p.sections[0]!.rows[0]).toEqual({
      id: "CHANGE_TYPE_rt_b", title: "Superior", description: "₹7,000/night · 4 available",
    });
    expect(p.sections[1]!.rows[0]!.id).toBe("CHANGE_TYPE_GO_BACK");
  });

  it("body and row description equal their registry defaults", async () => {
    await trySendChangeRoomTypeList({ ...ctx, room: room(), roomIndex: 0, candidates: [roomInput()] });
    const p = sentPayload();
    expect(p.bodyText).toBe(fillKey(DEFAULT_RESOLVED, "changeType.listBody", { roomNumber: 1 }));
    expect(p.sections[0]!.rows[0]!.description).toBe(
      fillKey(DEFAULT_RESOLVED, "lists.changeTypeDesc", { price: inr(7000), available: 4 }),
    );
  });
});

// ── Truncation: only where it is supposed to happen ──────────────────────────

describe("payload construction truncates rows only, never body/button/footer", () => {
  const LONG = "Presidential Ocean-Facing Suite With Private Terrace And Plunge Pool";

  it("slices row titles to 24 and descriptions to the row cap", async () => {
    await trySendManualModeList({
      ...ctx,
      state: st([room({ roomTypeName: LONG, totalPrice: 1234567 })]),
      addable: [roomInput({ name: LONG, basePrice: 9999999, maxAdults: 9, maxChildren: 9, availableCount: 99 })],
    });
    const p = sentPayload();
    for (const section of p.sections) {
      for (const r of section.rows) {
        expect(r.title.length, r.id).toBeLessThanOrEqual(24);
        if (r.description) expect(r.description.length, r.id).toBeLessThanOrEqual(72); // ROW_DESC_MAX, modifyLists.ts:30
      }
    }
    expect(p.sections[0]!.rows[0]!.title).toBe("Edit Room 1: Presidentia");
  });

  it("leaves bodyText, buttonLabel and footerText un-truncated", async () => {
    // These three reach Meta verbatim (sendListMessage :310, :312, :326), which
    // is exactly why HARD_CAP_KEYS exists — nothing downstream clips them.
    await trySendRoomMenuList({
      ...ctx, room: room({ roomTypeName: LONG }), options: ["add_bed"], roomIndex: 0,
    });
    const p = sentPayload();
    expect(p.bodyText).toContain(LONG);
    expect(p.bodyText.length).toBeGreaterThan(72);
    expect(p.buttonLabel).toBe("Options");
    expect(p.footerText).toBe("Type 'Hi' to cancel");
  });
});

// ── Protocol ids ──────────────────────────────────────────────────────────────

describe("interactive ids in every payload", () => {
  it("are the expected literals across all four senders", async () => {
    const ids: string[] = [];

    await trySendRoomMenuList({ ...ctx, room: room(), options: ["add_bed", "change_type"], roomIndex: 0 });
    ids.push(...sentPayload().sections.flatMap((s) => s.rows.map((r) => r.id)));
    sendOutbound.mockClear();

    await trySendManualModeList({ ...ctx, state: st([room()]), addable: [roomInput()] });
    ids.push(...sentPayload().sections.flatMap((s) => s.rows.map((r) => r.id)));
    sendOutbound.mockClear();

    await trySendMoveToRoomList({
      ...ctx, state: st([room(), room()]), fromIndex: 0,
      pending: { adults: 1, children: 0 }, resolveCfg,
    });
    ids.push(...sentPayload().sections.flatMap((s) => s.rows.map((r) => r.id)));
    sendOutbound.mockClear();

    await trySendChangeRoomTypeList({ ...ctx, room: room(), roomIndex: 0, candidates: [roomInput()] });
    ids.push(...sentPayload().sections.flatMap((s) => s.rows.map((r) => r.id)));

    expect([...new Set(ids)].sort()).toEqual([
      "ADD_ROOM_rt_b",
      "CHANGE_TYPE_GO_BACK",
      "CHANGE_TYPE_rt_b",
      "EDIT_ROOM_1",
      "MODIFY_DONE",
      "MODIFY_GO_BACK",
      "MOD_ADD_EXTRA_BED",
      "MOD_CHANGE_ROOM_TYPE",
      "MOD_GO_BACK",
      "MOVE_GO_BACK",
      "MOVE_TO_ROOM_1",
    ]);
  });
});
