/**
 * araListCopy.test.ts — Stage 2E: the copy registry threaded into planList.ts
 * and modifyLists.ts.
 *
 * The 27 keys those two files own (7 + 20) are now DE-DUPLICATED: the literal
 * is gone from both modules and `fillKey(copy, "<key>")` is the only source.
 * That makes the registry scan in ara/copy.test.ts inapplicable to them (there
 * is nothing left to scan for), so this file supplies CALL equivalence instead
 * — the same trade Stage 2C made for the thirteen sender keys.
 *
 * Deliberately NOT a second copy of planList.test.ts (10) / modifyLists.test.ts
 * (17). Those two pin the full default payloads and are untouched by this
 * stage, which is the byte-identity evidence; this file proves the PLUMBING:
 * that an absent bundle, the default bundle and an empty override all render
 * identically, that a valid override reaches exactly one field, that an invalid
 * one falls back, and that protocol ids and the truncation boundaries are
 * unaffected either way.
 *
 * Tenant overrides are still OFF in the runtime (flowRuntime binds
 * DEFAULT_RESOLVED — Stage 2G owns activation), so every override here is
 * constructed directly through resolveAraCopy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendOutbound = vi.fn();
vi.mock("../../services/outbound/outbound.service", () => ({
  sendOutbound: (...a: unknown[]) => sendOutbound(...a),
}));

import { MessageChannel } from "@prisma/client";
import { buildPlanDetailText, chunkPlanDetailText, trySendPlanList } from "./planList";
import {
  buildChangeTypeSections, buildManualModeSections, buildMoveToRoomSections,
  buildRoomMenuSections, trySendChangeRoomTypeList, trySendManualModeList,
  trySendMoveToRoomList, trySendRoomMenuList,
} from "./modifyLists";
import {
  DEFAULT_COPY, DEFAULT_RESOLVED, fillKey, resolveAraCopy,
  type AraCopyKey, type ResolvedAraCopy,
} from "./ara/copy";
import type {
  AllocationConfig, AllocationPlan, AllocationRoom, AllocationRoomInput,
  AraState, RoomConfigResolver,
} from "./ara/types";

// ── Fixtures (same shapes as planList.test.ts / modifyLists.test.ts) ──────────

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
function plan(over: Partial<AllocationPlan> = {}): AllocationPlan {
  const rooms = over.rooms ?? [room({ children: 0 })];
  return {
    label: "Most Comfortable", planTag: "comfort", rooms,
    totalPrice: rooms.reduce((s, r) => s + r.totalPrice, 0),
    nights: rooms[0]?.nights ?? 2,
    roomCount: rooms.length,
    extraBedCount: rooms.filter((r) => r.extraBed).length,
    primaryRoomTypeId: rooms[0]?.roomTypeId ?? "rt_a",
    ...over,
  };
}

const ctx = { hotelId: "h1", guestId: "g1", channel: MessageChannel.WHATSAPP };

type ChoicePayload = {
  kind: string; bodyText: string; buttonLabel: string; footerText?: string;
  sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
};

/** The last `choice` payload handed to sendOutbound. */
function lastChoice(): ChoicePayload {
  const calls = sendOutbound.mock.calls.filter((c) => (c[1] as ChoicePayload).kind === "choice");
  expect(calls.length, "no choice payload was sent").toBeGreaterThan(0);
  return calls[calls.length - 1]![1] as ChoicePayload;
}

/** An override bundle, built the way Stage 2G will build it. */
function withCopy(overrides: Partial<Record<AraCopyKey, string>>): ResolvedAraCopy {
  const r = resolveAraCopy(overrides);
  expect(r.rejected, `unexpected refusals: ${JSON.stringify(r.rejected)}`).toEqual([]);
  return r;
}

beforeEach(() => {
  sendOutbound.mockReset();
  sendOutbound.mockResolvedValue({ sent: true });
});

// ── The three equivalent ways to say "no customisation" ───────────────────────

describe("2E: an absent bundle, the default bundle and {} are identical", () => {
  // The back-compat lever for the whole stage. Existing callers and the 27 tests
  // in planList.test.ts / modifyLists.test.ts pass no bundle at all; flowRuntime
  // passes DEFAULT_RESOLVED; Stage 2G will pass resolveAraCopy({}) for a hotel
  // with no ara.* entries. All three must render the same bytes.
  const empty = resolveAraCopy({});

  it("resolveAraCopy({}) returns the shared default bundle by identity", () => {
    expect(empty.copy).toBe(DEFAULT_COPY);
    expect(empty.copy).toBe(DEFAULT_RESOLVED.copy);
    expect(empty.overridden).toEqual([]);
  });

  it("every pure builder in both modules agrees across all three", () => {
    const state = st([room(), room({ roomTypeName: "Suite", adults: 1, children: 0 })]);
    const plans = [plan(), plan({ label: "Best Value 💰", rooms: [room({ extraBed: true })] })];

    const cases: Array<[string, (c?: ResolvedAraCopy) => unknown]> = [
      ["buildPlanDetailText",     (c) => (c ? buildPlanDetailText(plans, c) : buildPlanDetailText(plans))],
      ["chunkPlanDetailText",     (c) => (c ? chunkPlanDetailText(plans, c) : chunkPlanDetailText(plans))],
      ["buildRoomMenuSections",   (c) => (c ? buildRoomMenuSections(room(), ["add_bed", "move_guest"], c)
                                            : buildRoomMenuSections(room(), ["add_bed", "move_guest"]))],
      ["buildMoveToRoomSections", (c) => (c ? buildMoveToRoomSections(state, 0, { adults: 1, children: 0 }, resolveCfg, c)
                                            : buildMoveToRoomSections(state, 0, { adults: 1, children: 0 }, resolveCfg))],
      ["buildManualModeSections", (c) => (c ? buildManualModeSections(state, [roomInput()], c)
                                            : buildManualModeSections(state, [roomInput()]))],
      ["buildChangeTypeSections", (c) => (c ? buildChangeTypeSections([roomInput()], c)
                                            : buildChangeTypeSections([roomInput()]))],
    ];

    for (const [name, build] of cases) {
      const bare = build(undefined);
      expect(build(DEFAULT_RESOLVED), `${name}: DEFAULT_RESOLVED differs from no bundle`).toEqual(bare);
      expect(build(empty), `${name}: resolveAraCopy({}) differs from no bundle`).toEqual(bare);
    }
  });

  it("every sender in both modules agrees across all three", async () => {
    const state = st([room(), room({ roomTypeName: "Suite" })]);
    const senders: Array<[string, (c: ResolvedAraCopy | undefined) => Promise<unknown>]> = [
      ["trySendPlanList", (copy) => trySendPlanList({ ...ctx, plans: [plan()], copy })],
      ["trySendRoomMenuList", (copy) =>
        trySendRoomMenuList({ ...ctx, room: room(), options: ["add_bed"], roomIndex: 0, copy })],
      ["trySendMoveToRoomList", (copy) =>
        trySendMoveToRoomList({ ...ctx, state, fromIndex: 0, pending: { adults: 1, children: 0 }, resolveCfg, copy })],
      ["trySendManualModeList", (copy) =>
        trySendManualModeList({ ...ctx, state, addable: [roomInput()], copy })],
      ["trySendChangeRoomTypeList", (copy) =>
        trySendChangeRoomTypeList({ ...ctx, room: room(), roomIndex: 0, candidates: [roomInput()], copy })],
    ];

    for (const [name, send] of senders) {
      const shots: ChoicePayload[] = [];
      for (const copy of [undefined, DEFAULT_RESOLVED, empty]) {
        sendOutbound.mockReset();
        sendOutbound.mockResolvedValue({ sent: true });
        await send(copy);
        shots.push(lastChoice());
      }
      expect(shots[1], `${name}: DEFAULT_RESOLVED differs from no bundle`).toEqual(shots[0]);
      expect(shots[2], `${name}: resolveAraCopy({}) differs from no bundle`).toEqual(shots[0]);
    }
  });
});

// ── planList ─────────────────────────────────────────────────────────────────

describe("2E: planList reads its seven keys from the registry", () => {
  it("the default body is composed from the registry, not literals", () => {
    const text = buildPlanDetailText([plan()]);
    expect(text.startsWith(fillKey(DEFAULT_RESOLVED, "plans.detailHeader"))).toBe(true);
    expect(text.endsWith(fillKey(DEFAULT_RESOLVED, "plans.detailFooter"))).toBe(true);
    expect(text).toContain(fillKey(DEFAULT_RESOLVED, "plans.detailBedsNone"));
  });

  it("the beds fragment switches arms on extraBed", () => {
    const withBed = buildPlanDetailText([plan({ rooms: [room({ extraBed: true })] })]);
    expect(withBed).toContain(fillKey(DEFAULT_RESOLVED, "plans.detailBedsIncluded"));
    expect(withBed).not.toContain(fillKey(DEFAULT_RESOLVED, "plans.detailBedsNone"));
  });

  it("an override reaches the header, footer and both beds arms", () => {
    const copy = withCopy({
      "plans.detailHeader":       "🛏 *Pick a package*",
      "plans.detailFooter":       "_Tap below_ 👇",
      "plans.detailBedsNone":     "standard beds",
      "plans.detailBedsIncluded": "with roll-aways",
    });
    const text = buildPlanDetailText([plan()], copy);
    expect(text.startsWith("🛏 *Pick a package*")).toBe(true);
    expect(text.endsWith("_Tap below_ 👇")).toBe(true);
    expect(text).toContain("standard beds");

    const bed = buildPlanDetailText([plan({ rooms: [room({ extraBed: true })] })], copy);
    expect(bed).toContain("with roll-aways");
  });

  it("chunkPlanDetailText threads the same bundle", () => {
    const copy = withCopy({ "plans.detailHeader": "HEADER", "plans.detailFooter": "FOOTER" });
    const chunks = chunkPlanDetailText([plan()], copy);
    expect(chunks[0]!.startsWith("HEADER")).toBe(true);
    expect(chunks[chunks.length - 1]!.endsWith("FOOTER")).toBe(true);
  });

  it("the section title and list button come from the registry", async () => {
    await trySendPlanList({ ...ctx, plans: [plan()] });
    expect(lastChoice().sections[0]!.title).toBe(fillKey(DEFAULT_RESOLVED, "plans.sectionTitle"));
    expect(lastChoice().buttonLabel).toBe(fillKey(DEFAULT_RESOLVED, "plans.buttonLabel"));

    sendOutbound.mockReset();
    sendOutbound.mockResolvedValue({ sent: true });
    await trySendPlanList({
      ...ctx, plans: [plan()],
      copy: withCopy({ "plans.sectionTitle": "Our packages", "plans.buttonLabel": "See options" }),
    });
    expect(lastChoice().sections[0]!.title).toBe("Our packages");
    expect(lastChoice().buttonLabel).toBe("See options");
  });

  it("plans.rowTitleLegacy is used ONLY for a plan with no label", async () => {
    // The labelled arm composes the plan's own label (from ara/plans.ts) and is
    // deliberately not registry copy, so an override must not touch it.
    //
    // `AllocationPlan.label` is typed REQUIRED (ara/types.ts:90) while the call
    // site guards on it being falsy — legacy generatePlans output simply had no
    // such field. An empty string is the type-valid way to take that branch.
    const copy = withCopy({ "plans.rowTitleLegacy": "Option {{number}}: {{total}}" });
    await trySendPlanList({
      ...ctx,
      plans: [plan({ label: "" }), plan({ label: "Best Value 💰" })],
      copy,
    });
    const rows = lastChoice().sections[0]!.rows;
    expect(rows[0]!.title).toBe("Option 1: ₹10,000");
    expect(rows[1]!.title).toBe("Best Value 💰 — ₹10,000");
  });

  it("plan_N ids are untouched by any override", async () => {
    await trySendPlanList({
      ...ctx,
      plans: [plan({ label: "" }), plan({ label: "" })],
      copy: withCopy({ "plans.rowTitleLegacy": "X {{number}} {{total}}", "plans.sectionTitle": "Y" }),
    });
    expect(lastChoice().sections[0]!.rows.map((r) => r.id)).toEqual(["plan_0", "plan_1"]);
  });
});

// ── modifyLists ──────────────────────────────────────────────────────────────

describe("2E: modifyLists reads its twenty keys from the registry", () => {
  it("room-menu sections, button and footer come from the registry", async () => {
    await trySendRoomMenuList({ ...ctx, room: room(), options: ["add_bed", "move_guest"], roomIndex: 0 });
    const p = lastChoice();
    expect(p.sections[0]!.title).toBe(fillKey(DEFAULT_RESOLVED, "lists.modifyRoomSection"));
    expect(p.sections[1]!.title).toBe(fillKey(DEFAULT_RESOLVED, "lists.navigationSection"));
    expect(p.sections[1]!.rows[0]!.title).toBe(fillKey(DEFAULT_RESOLVED, "lists.goBackRow"));
    expect(p.buttonLabel).toBe(fillKey(DEFAULT_RESOLVED, "lists.buttonOptions"));
    expect(p.footerText).toBe(fillKey(DEFAULT_RESOLVED, "lists.cancelFooter"));
  });

  it("the change-type body interpolates the room number", async () => {
    await trySendChangeRoomTypeList({ ...ctx, room: room(), roomIndex: 2, candidates: [roomInput()] });
    expect(lastChoice().bodyText)
      .toBe(fillKey(DEFAULT_RESOLVED, "changeType.listBody", { roomNumber: 3 }));

    sendOutbound.mockReset();
    sendOutbound.mockResolvedValue({ sent: true });
    await trySendChangeRoomTypeList({
      ...ctx, room: room(), roomIndex: 2, candidates: [roomInput()],
      copy: withCopy({ "changeType.listBody": "Swap room {{roomNumber}}?" }),
    });
    expect(lastChoice().bodyText).toBe("Swap room 3?");
  });

  it("the row-description templates interpolate their declared locals", () => {
    const state = st([room(), room({ roomTypeName: "Suite", adults: 1, children: 0 })]);

    // moveToRoomDesc — adults/children/maxAdults/maxChildren
    const move = buildMoveToRoomSections(state, 0, { adults: 1, children: 0 }, resolveCfg);
    expect(move.sections[0]!.rows[0]!.description).toBe(
      fillKey(DEFAULT_RESOLVED, "lists.moveToRoomDesc",
        { adults: 1, children: 0, maxAdults: 3, maxChildren: 1 }),
    );

    // addRoomDesc — maxAdults/maxChildren/price/available
    const manual = buildManualModeSections(state, [roomInput()]);
    const addRow = manual.find((s) => s.title === fillKey(DEFAULT_RESOLVED, "lists.addRoomSection"))!.rows[0]!;
    expect(addRow.description).toBe(
      fillKey(DEFAULT_RESOLVED, "lists.addRoomDesc",
        { maxAdults: 3, maxChildren: 1, price: "₹7,000", available: 4 }),
    );

    // changeTypeDesc — price/available
    expect(buildChangeTypeSections([roomInput()])[0]!.rows[0]!.description).toBe(
      fillKey(DEFAULT_RESOLVED, "lists.changeTypeDesc", { price: "₹7,000", available: 4 }),
    );
  });

  it("the ?? \"?\" placeholder still fires for a type with no caps", () => {
    // The one branch Stage 1.1 recorded as uncovered: null caps render "?".
    const desc = buildManualModeSections(
      st([]), [roomInput({ maxAdults: null, maxChildren: null })],
    )[0]!.rows[0]!.description;
    expect(desc).toBe(
      fillKey(DEFAULT_RESOLVED, "lists.addRoomDesc",
        { maxAdults: "?", maxChildren: "?", price: "₹7,000", available: 4 }),
    );
    expect(desc).toContain("Fits ? adults, ? children");
  });

  it("one cancelFooter override reaches all four senders", async () => {
    const copy = withCopy({ "lists.cancelFooter": "Say *stop* to cancel" });
    const state = st([room(), room({ roomTypeName: "Suite" })]);

    const sends: Array<() => Promise<unknown>> = [
      () => trySendRoomMenuList({ ...ctx, room: room(), options: ["add_bed"], roomIndex: 0, copy }),
      () => trySendMoveToRoomList({ ...ctx, state, fromIndex: 0, pending: { adults: 1, children: 0 }, resolveCfg, copy }),
      () => trySendManualModeList({ ...ctx, state, addable: [roomInput()], copy }),
      () => trySendChangeRoomTypeList({ ...ctx, room: room(), roomIndex: 0, candidates: [roomInput()], copy }),
    ];
    for (const send of sends) {
      sendOutbound.mockReset();
      sendOutbound.mockResolvedValue({ sent: true });
      await send();
      expect(lastChoice().footerText).toBe("Say *stop* to cancel");
    }
  });

  it("one goBackRow override reaches every navigation row", () => {
    const copy = withCopy({ "lists.goBackRow": "<< Back" });
    const state = st([room(), room({ roomTypeName: "Suite" })]);

    expect(buildRoomMenuSections(room(), ["add_bed"], copy)[1]!.rows[0]!.title).toBe("<< Back");
    expect(buildMoveToRoomSections(state, 0, { adults: 1, children: 0 }, resolveCfg, copy)
      .sections[1]!.rows[0]!.title).toBe("<< Back");
    expect(buildChangeTypeSections([roomInput()], copy)[1]!.rows[0]!.title).toBe("<< Back");

    const confirmSection = buildManualModeSections(state, [], copy)
      .find((s) => s.title === fillKey(copy, "lists.confirmSection"))!;
    expect(confirmSection.rows[1]!.title).toBe("<< Back");
  });

  it("every row and section id is unaffected by overrides", () => {
    const copy = withCopy({
      "lists.goBackRow":          "<< Back",
      "lists.confirmBookingRow":  "Book it",
      "lists.editRoomTitle":      "R{{roomNumber}} {{roomTypeName}}",
      "lists.modifyRoomSection":  "Options",
      "lists.availableTypesSection": "Types",
    });
    const state = st([room(), room({ roomTypeName: "Suite" })]);

    expect(buildRoomMenuSections(room(), ["add_bed", "move_guest"], copy)
      .flatMap((s) => s.rows.map((r) => r.id)))
      .toEqual(["MOD_ADD_EXTRA_BED", "MOD_MOVE_GUEST_OUT", "MOD_GO_BACK"]);

    expect(buildMoveToRoomSections(state, 0, { adults: 1, children: 0 }, resolveCfg, copy)
      .sections.flatMap((s) => s.rows.map((r) => r.id)))
      .toEqual(["MOVE_TO_ROOM_1", "MOVE_GO_BACK"]);

    expect(buildManualModeSections(state, [roomInput()], copy)
      .flatMap((s) => s.rows.map((r) => r.id)))
      .toEqual(["EDIT_ROOM_1", "EDIT_ROOM_2", "ADD_ROOM_rt_b", "MODIFY_DONE", "MODIFY_GO_BACK"]);

    expect(buildChangeTypeSections([roomInput()], copy)
      .flatMap((s) => s.rows.map((r) => r.id)))
      .toEqual(["CHANGE_TYPE_rt_b", "CHANGE_TYPE_GO_BACK"]);
  });
});

// ── Refusals and the truncation contract ─────────────────────────────────────

describe("2E: an invalid override cannot reach a list payload", () => {
  it("over-length, blank, unknown and protocol-like overrides all fall back", () => {
    const r = resolveAraCopy({
      "lists.modifyRoomSection": "A section heading well past twenty-four",  // maxLen 24
      "lists.buttonOptions":     "",                                        // blank
      "lists.goBackRow":         "MOD_GO_BACK",                             // protocol-like
      "lists.notAKey":           "x",                                       // unknown
    });
    expect(r.rejected.map((x) => x.reason).sort())
      .toEqual(["blank", "protocol-like", "too-long", "unknown-key"]);

    const sections = buildRoomMenuSections(room(), ["add_bed"], r);
    expect(sections[0]!.title).toBe(fillKey(DEFAULT_RESOLVED, "lists.modifyRoomSection"));
    expect(sections[1]!.rows[0]!.title).toBe(fillKey(DEFAULT_RESOLVED, "lists.goBackRow"));
  });

  it("an undeclared token is refused, so no raw {{token}} ships", () => {
    const r = resolveAraCopy({ "lists.changeTypeDesc": "{{price}} for {{guestName}}" });
    expect(r.rejected).toEqual([
      { key: "lists.changeTypeDesc", reason: "undeclared-token", detail: "guestName" },
    ]);
    const desc = buildChangeTypeSections([roomInput()], r)[0]!.rows[0]!.description!;
    expect(desc).not.toContain("{{");
  });

  it("row titles and descriptions are still sliced at 24 / 72", () => {
    // The caps the call sites own. An override that fits the registry check can
    // still overflow once a long room name is interpolated — the slice is what
    // keeps Meta from rejecting the message, and it must survive 2E.
    const long = buildManualModeSections(
      st([room({ roomTypeName: "Presidential Garden View Suite With Terrace" })]),
      [roomInput({ name: "A".repeat(40) })],
    );
    const editRow = long[0]!.rows[0]!;
    expect(editRow.title).toHaveLength(24);
    expect(editRow.title).toBe("Edit Room 1: Presidentia");

    const moveDesc = buildMoveToRoomSections(
      st([room(), room({ roomTypeName: "Suite" })]), 0, { adults: 1, children: 0 },
      () => ({ ...CFG, maxAdults: 999999, maxChildren: 999999 }),
    ).sections[0]!.rows[0]!.description!;
    expect(moveDesc.length).toBeLessThanOrEqual(72);
  });

  it("bodyText, buttonLabel and footerText are NOT sliced — hence HARD_CAP_KEYS", async () => {
    // sendListMessage passes these three verbatim (:310, :312, :326), so the
    // registry cap is the only guard. A refused override therefore has to fall
    // back rather than clip: buttonLabel carries maxLen 20 and does exactly
    // that, which this asserts from the payload side.
    const r = resolveAraCopy({ "lists.buttonChooseType": "A button label beyond twenty" });
    expect(r.rejected.map((x) => x.reason)).toEqual(["too-long"]);

    await trySendChangeRoomTypeList({
      ...ctx, room: room(), roomIndex: 0, candidates: [roomInput()], copy: r,
    });
    const p = lastChoice();
    expect(p.buttonLabel).toBe(fillKey(DEFAULT_RESOLVED, "lists.buttonChooseType"));
    expect(p.buttonLabel).not.toBe("A button label beyo");   // never clipped
  });

  it("KNOWN GAP: lists.cancelFooter has no maxLen, so a long override ships", async () => {
    // Pinned, not fixed — the 2E analogue of flowRuntime.carouselBody/mixBody.
    // sendListMessage passes footer.text verbatim and the registry declares no
    // cap for it, because the list footer limit is still unverified against
    // Meta's docs (Stage 2F). Until that lands, a hotel could overflow it.
    const footer = "F".repeat(400);
    const r = resolveAraCopy({ "lists.cancelFooter": footer });
    expect(r.rejected).toEqual([]);
    expect(r.overridden).toEqual(["lists.cancelFooter"]);

    await trySendRoomMenuList({ ...ctx, room: room(), options: ["add_bed"], roomIndex: 0, copy: r });
    expect(lastChoice().footerText).toBe(footer);
    expect(lastChoice().footerText).toHaveLength(400);
  });
});

// ── Isolation ────────────────────────────────────────────────────────────────

describe("2E: list copy is per-resolve, never shared", () => {
  it("two hotels' bundles do not leak into one another", () => {
    const a = withCopy({ "lists.buttonOptions": "A-opts" });
    const b = resolveAraCopy({});
    const c = withCopy({ "lists.buttonOptions": "C-opts" });

    expect(fillKey(a, "lists.buttonOptions")).toBe("A-opts");
    expect(fillKey(b, "lists.buttonOptions")).toBe(fillKey(DEFAULT_RESOLVED, "lists.buttonOptions"));
    expect(fillKey(c, "lists.buttonOptions")).toBe("C-opts");
    expect(fillKey(a, "lists.buttonOptions")).toBe("A-opts");
  });

  it("resolving a list override never mutates DEFAULT_COPY", () => {
    const before = DEFAULT_COPY["lists.cancelFooter"];
    withCopy({ "lists.cancelFooter": "mutating?" });
    expect(DEFAULT_COPY["lists.cancelFooter"]).toBe(before);
    expect(Object.isFrozen(DEFAULT_COPY)).toBe(true);
  });
});
