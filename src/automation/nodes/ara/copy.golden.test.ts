/**
 * ara/copy.golden.test.ts — the lockfile for guest-facing output.
 *
 * WHY THIS EXISTS. The 197 tests in advancedRoomAllocation.test.ts assert copy
 * almost entirely with `toContain` fragments, and for interactive list rows they
 * assert only `description.length <= 72` and never the text. So today that suite
 * stays green if you change whitespace, the divider, line order, a footer, a
 * trailing note, or ANY list-row description. This file closes that hole by
 * pinning whole strings.
 *
 * HOW TO READ A FAILURE HERE. A diff in this file is a change to what a guest
 * receives. That is sometimes correct — but it is never incidental, so never
 * run `vitest -u` to make it go away without reading the diff. The snapshots are
 * inline precisely so the strings show up in review.
 *
 * WHAT IS DELIBERATELY PINNED AS "WRONG". Two known inconsistencies are frozen
 * here so that fixing them later is a visible, reviewed diff rather than an
 * invisible side effect:
 *   1. Five different occupancy renderings (see the matrix below).
 *   2. Two different money formatters — planList does NOT round, everything
 *      else does, so one booking can show ₹1,234.5 and ₹1,235 on two screens.
 * Do not "tidy" either while this file is the only thing describing them.
 *
 * Fixtures are frozen constants: no Date.now, no randomness, no I/O.
 */

import { describe, expect, it } from "vitest";

import { copyDefault } from "./copy";

import {
  buildManualRoomList, buildRoomDescriptionsMessage, capHint, confirmPromptFooter,
  occupancyPhrase, renderAllocationSummary, renderChangeTypeSelect, renderManualMode,
  renderMoveFromCount, renderMoveToRoom, renderPlanTextFallback, renderRoomMenu,
  roomMenuOptions,
} from "./render";
import { ageConfirmFooter, buildOccupancyNotice, formatAges, renderAgeConfirmation } from "./ages";
import { applyAddExtraBed, applyChangeRoomType, applyMoveGuest } from "./appliers";
import {
  buildChangeTypeSections, buildManualModeSections, buildMoveToRoomSections,
  buildRoomMenuSections,
} from "../modifyLists";
import { buildPlanDescription, buildPlanDetailText, chunkPlanDetailText } from "../planList";
import type {
  AllocationConfig, AllocationPlan, AllocationRoom, AllocationRoomInput,
  AraState, RoomConfigResolver,
} from "./types";

// ── Frozen fixtures ───────────────────────────────────────────────────────────

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
    maxAdults: 3, maxChildren: 1, availableCount: 4, description: "Sea view suite",
    ...over,
  };
}
function st(rooms: AllocationRoom[], over: Partial<AraState> = {}): AraState {
  return {
    guests: { adults: 2, children: 1 },
    selectedRooms: rooms,
    remainingGuests: { adults: 0, children: 0 },
    phase: "manual",
    ...over,
  };
}
function plan(over: Partial<AllocationPlan> = {}): AllocationPlan {
  return {
    label: "Best Value 💰", rooms: [room()], totalPrice: 10000, nights: 2,
    roomCount: 1, extraBedCount: 0, primaryRoomTypeId: "rt_a", planTag: "value",
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// THE OCCUPANCY DIVERGENCE — FIVE RENDERINGS, PRESERVED ON PURPOSE
// ══════════════════════════════════════════════════════════════════════════════
//
// The node describes "who is in this room" in five different ways. They agree
// only when children >= 1 AND there is no extra bed. Two independent splits:
//
//   • children === 0 — occupancyPhrase OMITS the clause; everything else prints
//     "0 children".
//   • extraBed      — occupancyPhrase APPENDS ", extra bed"; nothing else
//     mentions it at all.
//
// The guest-visible consequence is that the SAME screen reads differently
// depending on whether the interactive list sent or fell back to text:
//
//   manual mode, list  → "2 adults, 0 children — ₹10,000"
//   manual mode, text  → "Room 1: Deluxe — 2 adults — ₹10,000"
//
// Unifying them would change output on whichever path loses, so Stage 1 does
// NOT unify them. This grid is the evidence any later change has to confront.
// Rows 1-2 isolate the zero-children split, rows 5-6 the extra-bed split, and
// rows 3-4 are where the five agree and must keep agreeing.

describe("occupancy divergence — DO NOT UNIFY", () => {
  const GRID: Array<{ label: string; r: AllocationRoom }> = [
    { label: "1a 0c no bed", r: room({ adults: 1, children: 0, extraBed: false }) },
    { label: "2a 0c no bed", r: room({ adults: 2, children: 0, extraBed: false }) },
    { label: "2a 1c no bed", r: room({ adults: 2, children: 1, extraBed: false }) },
    { label: "2a 2c no bed", r: room({ adults: 2, children: 2, extraBed: false }) },
    { label: "3a 1c BED",    r: room({ adults: 3, children: 1, extraBed: true  }) },
    { label: "1a 1c BED",    r: room({ adults: 1, children: 1, extraBed: true  }) },
  ];

  // #1 — occupancyPhrase (ara/render.ts). Omits zero children, names the bed.
  it("renderer 1: occupancyPhrase", () => {
    expect(GRID.map((g) => `${g.label} → ${occupancyPhrase(g.r)}`)).toEqual([
      "1a 0c no bed → 1 adult",
      "2a 0c no bed → 2 adults",
      "2a 1c no bed → 2 adults, 1 child",
      "2a 2c no bed → 2 adults, 2 children",
      "3a 1c BED → 3 adults, 1 child, extra bed",
      "1a 1c BED → 1 adult, 1 child, extra bed",
    ]);
  });

  // #2 — occupancyLabel (modifyLists.ts, module-private). Reached through the
  // manual-mode edit-row description, which is where a guest actually sees it.
  it("renderer 2: occupancyLabel, via the manual-mode edit row", () => {
    const descs = GRID.map((g) => {
      const sections = buildManualModeSections(st([g.r]), []);
      return `${g.label} → ${sections[0]!.rows[0]!.description}`;
    });
    expect(descs).toEqual([
      "1a 0c no bed → 1 adult, 0 children — ₹10,000",
      "2a 0c no bed → 2 adults, 0 children — ₹10,000",
      "2a 1c no bed → 2 adults, 1 child — ₹10,000",
      "2a 2c no bed → 2 adults, 2 children — ₹10,000",
      "3a 1c BED → 3 adults, 1 child — ₹10,000",
      "1a 1c BED → 1 adult, 1 child — ₹10,000",
    ]);
  });

  // #3 — the inline phrase in renderMoveFromCount. Matches #2, not #1.
  it("renderer 3: renderMoveFromCount's inline '(currently …)'", () => {
    const lines = GRID.map((g) => {
      const current = renderMoveFromCount(g.r, 0).split("\n")[1]!;
      return `${g.label} → ${current}`;
    });
    expect(lines).toEqual([
      "1a 0c no bed → (currently 1 adult, 0 children)",
      "2a 0c no bed → (currently 2 adults, 0 children)",
      "2a 1c no bed → (currently 2 adults, 1 child)",
      "2a 2c no bed → (currently 2 adults, 2 children)",
      "3a 1c BED → (currently 3 adults, 1 child)",
      "1a 1c BED → (currently 1 adult, 1 child)",
    ]);
  });

  // #4 — renderMoveToRoom's destination row. Pluralises NOTHING: always
  // "adults" and always "child", so "1 adults" and "2 child" both occur.
  it("renderer 4: renderMoveToRoom's destination row never pluralises", () => {
    const rows = GRID.map((g) => {
      const text = renderMoveToRoom(st([room(), g.r]), { adults: 1, children: 0 }, 0, resolveCfg);
      return `${g.label} → ${text.split("\n")[2]!}`;
    });
    expect(rows).toEqual([
      "1a 0c no bed → *1.* Deluxe — currently 1 adults, 0 child (max 3 adults, 1 child)",
      "2a 0c no bed → *1.* Deluxe — currently 2 adults, 0 child (max 3 adults, 1 child)",
      "2a 1c no bed → *1.* Deluxe — currently 2 adults, 1 child (max 3 adults, 1 child)",
      "2a 2c no bed → *1.* Deluxe — currently 2 adults, 2 child (max 3 adults, 1 child)",
      "3a 1c BED → *1.* Deluxe — currently 3 adults, 1 child (max 3 adults, 1 child)",
      "1a 1c BED → *1.* Deluxe — currently 1 adults, 1 child (max 3 adults, 1 child)",
    ]);
  });

  // #5 — buildMoveToRoomSections' row description. Always "adults"/"children"
  // AND a capital "Currently", so it disagrees with #4 on the same screen.
  it("renderer 5: buildMoveToRoomSections' row description", () => {
    const descs = GRID.map((g) => {
      const { sections } = buildMoveToRoomSections(
        st([room(), g.r]), 0, { adults: 1, children: 0 }, resolveCfg,
      );
      return `${g.label} → ${sections[0]!.rows[0]!.description}`;
    });
    expect(descs).toEqual([
      "1a 0c no bed → Currently 1 adults, 0 children (max 3 adults, 1 children)",
      "2a 0c no bed → Currently 2 adults, 0 children (max 3 adults, 1 children)",
      "2a 1c no bed → Currently 2 adults, 1 children (max 3 adults, 1 children)",
      "2a 2c no bed → Currently 2 adults, 2 children (max 3 adults, 1 children)",
      "3a 1c BED → Currently 3 adults, 1 children (max 3 adults, 1 children)",
      "1a 1c BED → Currently 1 adults, 1 children (max 3 adults, 1 children)",
    ]);
  });

  it("the text and list paths of the SAME screen disagree today", () => {
    // This is the summary of the whole problem, in one assertion.
    const r = room({ adults: 2, children: 0, extraBed: false });
    const listRow = buildManualModeSections(st([r]), [])[0]!.rows[0]!.description;
    const textRow = renderManualMode(st([r]), []).split("\n")[2]!;

    expect(listRow).toBe("2 adults, 0 children — ₹10,000");
    expect(textRow).toBe("*Room 1: Deluxe* — 2 adults — ₹10,000");
    expect(listRow).not.toContain("extra bed");
  });

  it("occupancyLabel's extra ', 0 children' shifts where a long name truncates", () => {
    // The row description is capped at 72. occupancyLabel spends ~12 characters
    // on a clause occupancyPhrase omits, so unifying them would move the cut
    // point — a silent change to what the guest can read.
    const long = room({
      roomTypeName: "Presidential Ocean-Facing Suite With Private Terrace",
      adults: 2, children: 0, totalPrice: 123456,
    });
    const desc = buildManualModeSections(st([long]), [])[0]!.rows[0]!.description!;
    expect(desc).toBe("2 adults, 0 children — ₹1,23,456");
    expect(desc.length).toBeLessThanOrEqual(72);

    const title = buildManualModeSections(st([long]), [])[0]!.rows[0]!.title;
    expect(title).toBe("Edit Room 1: Presidentia");
    expect(title.length).toBeLessThanOrEqual(24);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// THE MONEY DIVERGENCE — TWO FORMATTERS, PRESERVED ON PURPOSE
// ══════════════════════════════════════════════════════════════════════════════

describe("money divergence — DO NOT UNIFY", () => {
  // RoomType.extraAdultCharge / extraBedCharge are Prisma Float?, so fractional
  // totals are reachable in production, not hypothetical.
  const fractional = room({ pricePerNight: 5000.25, totalPrice: 10000.5 });

  it("the summary ROUNDS", () => {
    const text = renderAllocationSummary([fractional], {});
    expect(text).toContain("₹5,000/night");
    expect(text).toContain("*Total: ₹10,001*");
    expect(text).not.toContain("10,000.5");
  });

  it("the plan detail body does NOT round", () => {
    const text = buildPlanDetailText([plan({ rooms: [fractional], totalPrice: 10000.5 })]);
    expect(text).toContain("₹10,000.5");
    expect(text).toContain("₹5,000.25/night");
  });

  it("so one booking shows two different totals on two screens", () => {
    const summary = renderAllocationSummary([fractional], {});
    const detail  = buildPlanDetailText([plan({ rooms: [fractional], totalPrice: 10000.5 })]);
    expect(summary).toContain("₹10,001");
    expect(detail).toContain("₹10,000.5");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GOLDENS — whole output of every pure builder
// ══════════════════════════════════════════════════════════════════════════════

describe("goldens — allocation summary", () => {
  it("plain, single room", () => {
    expect(renderAllocationSummary([room()], {})).toMatchInlineSnapshot(`
      "🛏 *Suggested Allocation*
      ━━━━━━━━━━━━━━━━
      *Room 1: Deluxe*
      👥 2 adults, 1 child
      💰 ₹5,000/night × 2 nights = *₹10,000*
      ━━━━━━━━━━━━━━━━
      *Total: ₹10,000*"
    `);
  });

  it("with the extra-adult and extra-bed breakdown lines", () => {
    expect(renderAllocationSummary(
      [room({ adults: 3, extraBed: true, extraAdultCost: 500, extraBedCost: 800, pricePerNight: 6300, totalPrice: 12600 })],
      {},
    )).toMatchInlineSnapshot(`
      "🛏 *Suggested Allocation*
      ━━━━━━━━━━━━━━━━
      *Room 1: Deluxe*
      👥 3 adults, 1 child
      🛏 Extra bed included
      💰 ₹5,000 base + ₹500 extra adult + ₹800 extra bed
         = ₹6,300/night × 2 nights = *₹12,600*
      ━━━━━━━━━━━━━━━━
      *Total: ₹12,600*"
    `);
  });

  it("with children's ages shown, and the age-limit note", () => {
    expect(renderAllocationSummary(
      [room({ children: 2, childAgeLimit: 12 })],
      { childrenAges: [6, 9] },
    )).toMatchInlineSnapshot(`
      "🛏 *Suggested Allocation*
      ━━━━━━━━━━━━━━━━
      *Room 1: Deluxe*
      👥 2 adults, children aged 6 & 9
      💰 ₹5,000/night × 2 nights = *₹10,000*
      ━━━━━━━━━━━━━━━━
      *Total: ₹10,000*
      _Note: Children above 12 years are charged as adults._"
    `);
  });

  it("with a trailing footer, multi-room", () => {
    expect(renderAllocationSummary(
      [room(), room({ roomTypeName: "Superior", children: 0 })],
      { trailing: confirmPromptFooter() },
    )).toMatchInlineSnapshot(`
      "🛏 *Suggested Allocation*
      ━━━━━━━━━━━━━━━━
      *Room 1: Deluxe*
      👥 2 adults, 1 child
      💰 ₹5,000/night × 2 nights = *₹10,000*
      *Room 2: Superior*
      👥 2 adults
      💰 ₹5,000/night × 2 nights = *₹10,000*
      ━━━━━━━━━━━━━━━━
      *Total: ₹20,000*

      Reply *1* to Confirm
      Reply *2* to Modify manually
      Reply *MENU* to cancel"
    `);
  });
});

describe("goldens — ages", () => {
  it("renderAgeConfirmation, one child", () => {
    expect(renderAgeConfirmation([6])).toMatchInlineSnapshot(`"Just to confirm — your child is aged *6*."`);
  });
  it("renderAgeConfirmation, three children", () => {
    expect(renderAgeConfirmation([4, 7, 12])).toMatchInlineSnapshot(`"Just to confirm — your 3 children are aged *4, 7 & 12*."`);
  });
  it("ageConfirmFooter", () => {
    expect(ageConfirmFooter()).toMatchInlineSnapshot(`
      "Reply *1* if that's right
      Reply *2* to correct the ages
      Reply *MENU* to cancel"
    `);
  });
  it("formatAges across lengths", () => {
    expect([formatAges([]), formatAges([6]), formatAges([6, 9]), formatAges([4, 7, 12])])
      .toMatchInlineSnapshot(`
        [
          "",
          "6",
          "6 & 9",
          "4, 7 & 12",
        ]
      `);
  });
  it("buildOccupancyNotice, one promoted", () => {
    expect(buildOccupancyNotice(3, 1, 1, 12)).toMatchInlineSnapshot(`
      "*Occupancy Summary* 👥

      Adults: *3*   Children: *1*

      _One of your children is above 12 years and will be counted as an adult per hotel policy._"
    `);
  });
  it("buildOccupancyNotice, several promoted", () => {
    expect(buildOccupancyNotice(4, 0, 2, 8)).toMatchInlineSnapshot(`
      "*Occupancy Summary* 👥

      Adults: *4*   Children: *0*

      _2 of your children are above 8 years and will be counted as adults per hotel policy._"
    `);
  });
});

describe("goldens — manual mode and the room menu", () => {
  it("confirmPromptFooter", () => {
    expect(confirmPromptFooter()).toMatchInlineSnapshot(`
      "Reply *1* to Confirm
      Reply *2* to Modify manually
      Reply *MENU* to cancel"
    `);
  });
  it("renderManualMode with an addable room", () => {
    expect(renderManualMode(st([room()]), [roomInput()])).toMatchInlineSnapshot(`
      "✏️ *Modify your booking*
      ━━━━━━━━━━━━━━━━
      *Room 1: Deluxe* — 2 adults, 1 child — ₹10,000
      ━━━━━━━━━━━━━━━━
      *Total: ₹10,000*

      Reply *1–1* to edit a room.

      ➕ *Add a room:*
      *2.* Superior _(fits 3 adults, 1 child)_ _(4 avail)_ — ₹7,000/night

      Reply *DONE* to confirm · *MENU* to cancel"
    `);
  });
  it("renderManualMode with nothing addable", () => {
    expect(renderManualMode(st([room(), room()]), [])).toMatchInlineSnapshot(`
      "✏️ *Modify your booking*
      ━━━━━━━━━━━━━━━━
      *Room 1: Deluxe* — 2 adults, 1 child — ₹10,000
      *Room 2: Deluxe* — 2 adults, 1 child — ₹10,000
      ━━━━━━━━━━━━━━━━
      *Total: ₹20,000*

      Reply *1–2* to edit a room.

      Reply *DONE* to confirm · *MENU* to cancel"
    `);
  });
  it("buildManualRoomList", () => {
    expect(buildManualRoomList([roomInput(), roomInput({ name: "Basic", basePrice: 3000, maxChildren: 0 })], { adults: 2, children: 1 }))
      .toMatchInlineSnapshot(`
        "Pick a room to add to your booking. *2 adults, 1 child* still need a room.

        ━━━━━━━━━━━━━━━━
        *1.* Superior _(fits 3 adults, 1 child)_ _(4 avail)_ — ₹7,000/night
        *2.* Basic _(fits 3 adults)_ _(4 avail)_ — ₹3,000/night
        ━━━━━━━━━━━━━━━━

        Reply *1–2* to add a room.
        Reply *DONE* when finished.
        Reply *MENU* to cancel."
      `);
  });
  it("buildManualRoomList with no children remaining", () => {
    expect(buildManualRoomList([roomInput()], { adults: 1, children: 0 })).toMatchInlineSnapshot(`
      "Pick a room to add to your booking. *1 adult* still need a room.

      ━━━━━━━━━━━━━━━━
      *1.* Superior _(fits 3 adults, 1 child)_ _(4 avail)_ — ₹7,000/night
      ━━━━━━━━━━━━━━━━

      Reply *1–1* to add a room.
      Reply *DONE* when finished.
      Reply *MENU* to cancel."
    `);
  });
  it("renderRoomMenu, every action offered", () => {
    const r = room({ extraBed: false });
    expect(renderRoomMenu(r, roomMenuOptions(r, CFG), 0)).toMatchInlineSnapshot(`
      "*Room 1: Deluxe*
      👥 2 adults, 1 child
      💰 ₹5,000/night

      What would you like to do?
      ━━━━━━━━━━━━━━━━
      *1.* Add extra bed
      *2.* Move a guest out
      *3.* Change room type
      *4.* Remove this room
      ━━━━━━━━━━━━━━━━
      Reply *0* to go back · *MENU* to cancel"
    `);
  });
  it("renderRoomMenu with a bed already in place", () => {
    const r = room({ extraBed: true });
    expect(renderRoomMenu(r, roomMenuOptions(r, CFG), 1)).toMatchInlineSnapshot(`
      "*Room 2: Deluxe*
      👥 2 adults, 1 child, extra bed
      💰 ₹5,000/night

      What would you like to do?
      ━━━━━━━━━━━━━━━━
      *1.* Remove extra bed
      *2.* Move a guest out
      *3.* Change room type
      *4.* Remove this room
      ━━━━━━━━━━━━━━━━
      Reply *0* to go back · *MENU* to cancel"
    `);
  });
  it("capHint variants", () => {
    expect([
      capHint({ maxAdults: 3, maxChildren: 1 }),
      capHint({ maxAdults: 3, maxChildren: 0 }),
      capHint({ maxAdults: null, maxChildren: null }),
    ]).toMatchInlineSnapshot(`
      [
        " _(fits 3 adults, 1 child)_",
        " _(fits 3 adults)_",
        "",
      ]
    `);
  });
});

describe("goldens — move and change-type", () => {
  it("renderMoveFromCount", () => {
    expect(renderMoveFromCount(room({ adults: 2, children: 1 }), 0)).toMatchInlineSnapshot(`
      "Moving guests out of *Room 1: Deluxe*
      (currently 2 adults, 1 child)

      How many adults and children to move?
      Format: *adults children*  e.g. *1 0* for 1 adult, 0 children.
      Reply *0* to go back · *MENU* to cancel."
    `);
  });
  it("renderMoveToRoom", () => {
    expect(renderMoveToRoom(
      st([room(), room({ roomTypeName: "Superior" }), room({ roomTypeName: "Basic" })]),
      { adults: 1, children: 1 }, 0, resolveCfg,
    )).toMatchInlineSnapshot(`
      "Move 1 adult, 1 child to which room?
      ━━━━━━━━━━━━━━━━
      *1.* Superior — currently 2 adults, 1 child (max 3 adults, 1 child)
      *2.* Basic — currently 2 adults, 1 child (max 3 adults, 1 child)
      ━━━━━━━━━━━━━━━━
      Reply *0* to go back · *MENU* to cancel."
    `);
  });
  it("renderChangeTypeSelect", () => {
    expect(renderChangeTypeSelect(room(), [roomInput(), roomInput({ name: "Basic", basePrice: 3000 })], 0))
      .toMatchInlineSnapshot(`
        "Change *Room 1: Deluxe* (currently 2 adults, 1 child) to which type?
        ━━━━━━━━━━━━━━━━
        *1.* Superior _(fits 3 adults, 1 child)_ _(4 avail)_ — ₹7,000/night
        *2.* Basic _(fits 3 adults, 1 child)_ _(4 avail)_ — ₹3,000/night
        ━━━━━━━━━━━━━━━━
        Reply *0* to go back · *MENU* to cancel."
      `);
  });
});

describe("goldens — plans", () => {
  it("renderPlanTextFallback, two plans", () => {
    expect(renderPlanTextFallback([
      plan(),
      plan({ label: "Best Experience 🌟", extraBedCount: 1, roomCount: 2, totalPrice: 21000, rooms: [room(), room({ roomTypeName: "Superior", extraBed: true })] }),
    ])).toMatchInlineSnapshot(`
      "🏨 *Choose your room plan:*
      ━━━━━━━━━━━━━━━━
      *1. Best Value 💰 — ₹10,000*
         1 room · Deluxe · No extra beds
         Room 1: Deluxe — 2 adults, 1 child
      *2. Best Experience 🌟 — ₹21,000*
         2 rooms · Deluxe · Extra beds incl.
         Room 1: Deluxe — 2 adults, 1 child
         Room 2: Superior — 2 adults, 1 child, extra bed
      ━━━━━━━━━━━━━━━━
      Reply *1–2* to choose · *MENU* to cancel"
    `);
  });
  it("buildPlanDescription", () => {
    expect([
      buildPlanDescription(plan()),
      buildPlanDescription(plan({ extraBedCount: 2, roomCount: 3 })),
      buildPlanDescription(plan({ rooms: [room(), room({ roomTypeId: "rt_z", roomTypeName: "Superior" })], roomCount: 2 })),
    ]).toMatchInlineSnapshot(`
      [
        "1 room · Deluxe · No extra beds",
        "3 rooms · Deluxe · Extra beds incl.",
        "2 rooms · Deluxe mix · No extra beds",
      ]
    `);
  });
  it("buildPlanDescription truncates a very long type name to 60", () => {
    const desc = buildPlanDescription(plan({
      rooms: [room({ roomTypeName: "Presidential Ocean-Facing Suite With Private Terrace" })],
    }));
    expect(desc).toMatchInlineSnapshot(`"1 room · Presidential Ocean-Facing Suite Wi… · No extra beds"`);
    expect(desc.length).toBeLessThanOrEqual(60);
  });
  it("buildPlanDetailText", () => {
    expect(buildPlanDetailText([plan({ rooms: [room({ extraBed: true })], extraBedCount: 1 })]))
      .toMatchInlineSnapshot(`
        "🏨 *Your Room Options*

        *Plan 1 — ₹10,000* _(Best Value 💰)_
        1 room · extra beds included
        • Room 1: Deluxe — 2 adults, 1 child + bed
          ₹5,000/night × 2 nights = ₹10,000

        _Tap *View Plans* to choose_ 👇"
      `);
  });
  it("chunkPlanDetailText keeps one plan in one chunk", () => {
    const chunks = chunkPlanDetailText([plan()]);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toMatchInlineSnapshot(`
      "🏨 *Your Room Options*

      *Plan 1 — ₹10,000* _(Best Value 💰)_
      1 room · no extra beds
      • Room 1: Deluxe — 2 adults, 1 child
        ₹5,000/night × 2 nights = ₹10,000

      _Tap *View Plans* to choose_ 👇"
    `);
  });
});

describe("goldens — room descriptions", () => {
  it("with and without a description", () => {
    expect(buildRoomDescriptionsMessage([
      roomInput(),
      roomInput({ name: "Basic", basePrice: 3000, description: null }),
      roomInput({ name: "Hidden", availableCount: 0 }),
    ])).toMatchInlineSnapshot(`
      "🏨 *Our Room Types*

      *Superior* — ₹7,000/night
      _Sea view suite_

      *Basic* — ₹3,000/night

      _Tap the options below to choose your preferred room type_ 👇"
    `);
  });
  it("returns null when nothing is available", () => {
    expect(buildRoomDescriptionsMessage([roomInput({ availableCount: 0 })])).toBeNull();
  });
});

describe("goldens — interactive list sections", () => {
  it("buildRoomMenuSections", () => {
    expect(buildRoomMenuSections(room(), ["add_bed", "move_guest", "change_type", "remove_room"]))
      .toMatchInlineSnapshot(`
        [
          {
            "rows": [
              {
                "id": "MOD_ADD_EXTRA_BED",
                "title": "Add extra bed",
              },
              {
                "id": "MOD_MOVE_GUEST_OUT",
                "title": "Move a guest out",
              },
              {
                "id": "MOD_CHANGE_ROOM_TYPE",
                "title": "Change room type",
              },
              {
                "id": "MOD_REMOVE_ROOM",
                "title": "Remove this room",
              },
            ],
            "title": "Modify Room",
          },
          {
            "rows": [
              {
                "id": "MOD_GO_BACK",
                "title": "↩️ Go back",
              },
            ],
            "title": "Navigation",
          },
        ]
      `);
  });
  it("buildManualModeSections", () => {
    expect(buildManualModeSections(st([room()]), [roomInput()])).toMatchInlineSnapshot(`
      [
        {
          "rows": [
            {
              "description": "2 adults, 1 child — ₹10,000",
              "id": "EDIT_ROOM_1",
              "title": "Edit Room 1: Deluxe",
            },
          ],
          "title": "Edit Existing Rooms",
        },
        {
          "rows": [
            {
              "description": "Fits 3 adults, 1 children · ₹7,000/night · 4 avail",
              "id": "ADD_ROOM_rt_b",
              "title": "Superior",
            },
          ],
          "title": "Add a Room",
        },
        {
          "rows": [
            {
              "id": "MODIFY_DONE",
              "title": "✅ Confirm booking",
            },
            {
              "id": "MODIFY_GO_BACK",
              "title": "↩️ Go back",
            },
          ],
          "title": "Confirm",
        },
      ]
    `);
  });
  it("buildChangeTypeSections", () => {
    expect(buildChangeTypeSections([roomInput()])).toMatchInlineSnapshot(`
      [
        {
          "rows": [
            {
              "description": "₹7,000/night · 4 available",
              "id": "CHANGE_TYPE_rt_b",
              "title": "Superior",
            },
          ],
          "title": "Available Room Types",
        },
        {
          "rows": [
            {
              "id": "CHANGE_TYPE_GO_BACK",
              "title": "↩️ Go back",
            },
          ],
          "title": "Navigation",
        },
      ]
    `);
  });
  it("buildMoveToRoomSections", () => {
    expect(buildMoveToRoomSections(st([room(), room({ roomTypeName: "Superior" })]), 0, { adults: 1, children: 0 }, resolveCfg))
      .toMatchInlineSnapshot(`
        {
          "destIndices": [
            1,
          ],
          "sections": [
            {
              "rows": [
                {
                  "description": "Currently 2 adults, 1 children (max 3 adults, 1 children)",
                  "id": "MOVE_TO_ROOM_1",
                  "title": "Superior",
                },
              ],
              "title": "Available Rooms",
            },
            {
              "rows": [
                {
                  "id": "MOVE_GO_BACK",
                  "title": "↩️ Go back",
                },
              ],
              "title": "Navigation",
            },
          ],
        }
      `);
  });
});

describe("goldens — applier rejection reasons", () => {
  it("every rejection string", () => {
    const reason = (r: { ok: boolean } & Record<string, unknown>) =>
      r.ok ? "<applied>" : String(r["reason"]);

    expect([
      reason(applyAddExtraBed([room()], 0, () => ({ ...CFG, allowExtraBed: false }))),
      reason(applyMoveGuest([room(), room()], 0, 1, 0, 0, resolveCfg)),
      reason(applyMoveGuest([room({ adults: 1, children: 0 }), room()], 0, 1, 2, 0, resolveCfg)),
      reason(applyMoveGuest([room({ adults: 3 }), room({ adults: 3 })], 0, 1, 1, 0, resolveCfg)),
      reason(applyMoveGuest([room({ children: 2 }), room({ children: 1 })], 0, 1, 0, 2, resolveCfg)),
      reason(applyChangeRoomType([room()], 0, roomInput({ availableCount: 0 }), resolveCfg)),
      reason(applyChangeRoomType([room({ adults: 3 })], 0, roomInput(), () => ({ ...CFG, maxAdults: 2 }))),
      reason(applyChangeRoomType([room({ children: 2 })], 0, roomInput(), () => ({ ...CFG, maxChildren: 1 }))),
    ]).toMatchInlineSnapshot(`
      [
        "Deluxe rooms don't support an extra bed.",
        "Nothing to move.",
        "Room 1 only has 1 adult and 0 children.",
        "Deluxe rooms hold at most 3 adults.",
        "Deluxe rooms hold at most 1 child.",
        "Sorry, no Superior rooms are available for those dates.",
        "Superior rooms hold at most 2 adults.",
        "Superior rooms hold at most 1 child.",
      ]
    `);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CAROUSEL CARD COPY (audit F2) — composed, because it cannot be called
// ══════════════════════════════════════════════════════════════════════════════
//
// These three keys mirror literals inside flowRuntime's module-private
// trySendRoomTypeCarousel, where they sit between a prisma query and a
// sendOutbound call. They cannot be invoked from a test, so the registry
// composition is pinned here and the literals are matched against the source in
// copy.test.ts. Note the price uses flowRuntime's NON-rounding formatter.

describe("goldens — room-type carousel card", () => {
  it("capacity line, both arms", () => {
    expect([
      copyDefault("flowRuntime.cardCapWithChildren", { maxAdults: 3, maxChildren: 1 }),
      copyDefault("flowRuntime.cardCapAdultsOnly", { maxAdults: 3 }),
      copyDefault("flowRuntime.cardCapAdultsOnly", { maxAdults: 1 }),
    ]).toMatchInlineSnapshot(`
      [
        "Up to 3 adults, 1 children",
        "Up to 3 adults",
        "Up to 1 adults",
      ]
    `);
  });

  it("full card description, both arms", () => {
    const price = (n: number) => `₹${n.toLocaleString("en-IN")}`;
    expect([
      copyDefault("flowRuntime.cardDescription", {
        cap: copyDefault("flowRuntime.cardCapWithChildren", { maxAdults: 3, maxChildren: 1 }),
        price: price(7000),
      }),
      copyDefault("flowRuntime.cardDescription", {
        cap: copyDefault("flowRuntime.cardCapAdultsOnly", { maxAdults: 2 }),
        price: price(3000),
      }),
      // Non-rounding formatter: a fractional rate keeps its decimals here,
      // where the confirm summary would round. Pinned deliberately.
      copyDefault("flowRuntime.cardDescription", {
        cap: copyDefault("flowRuntime.cardCapAdultsOnly", { maxAdults: 2 }),
        price: price(3000.5),
      }),
    ]).toMatchInlineSnapshot(`
      [
        "Up to 3 adults, 1 children · ₹7,000/night",
        "Up to 2 adults · ₹3,000/night",
        "Up to 2 adults · ₹3,000.5/night",
      ]
    `);
  });

  it("stays inside the 60-char cut even at absurd capacity and rate", () => {
    const worst = copyDefault("flowRuntime.cardDescription", {
      cap: copyDefault("flowRuntime.cardCapWithChildren", { maxAdults: 99, maxChildren: 99 }),
      price: "₹99,99,99,999",
    });
    expect(worst).toMatchInlineSnapshot(`"Up to 99 adults, 99 children · ₹99,99,99,999/night"`);
    // The .slice(0, 60) in flowRuntime is therefore unreachable defensive code.
    expect(worst.length).toBeLessThanOrEqual(60);
  });
});
