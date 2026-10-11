/**
 * ara/copy.test.ts — proves the registry mirrors reality, and stays clean.
 *
 * Stage 1 leaves the call sites holding their own literals, so for now every
 * string exists TWICE: once in ./copy and once where it is emitted. This suite
 * is what makes that safe. It asserts the two copies agree, so editing either
 * one alone fails here rather than silently shipping a reworded bot.
 *
 * TWO VERIFICATION TECHNIQUES, chosen per key by its `origin`:
 *
 *   CALL equivalence — the string comes out of a pure exported builder, so the
 *     builder is invoked and the result compared. The strong form; it covers
 *     render/ages/appliers/constants/plans/modifyLists/planList.
 *
 *   SOURCE scan — the string is an inline literal inside a phase handler, the
 *     dispatcher, or one of flowRuntime's four module-private ARA senders. Those
 *     cannot be called: `trySendRoomTypeCarousel`, `trySendOccupancyNotice`,
 *     `trySendMixItUpList` and `trySendConfirmButtons` are not exported, their
 *     literals sit interleaved with `prisma.roomPhoto.findMany` and
 *     `sendOutbound`, and importing flowRuntime.ts would drag in prisma, Redis
 *     (queue/redis.ts constructs a client at import) and ai.service — the exact
 *     chain ara/purity.test.ts exists to keep out. So the module is read as TEXT
 *     and the default's literal segments are matched against it.
 *
 *     Source scan is weaker: it proves the literal exists in that file, not that
 *     it is the one emitted on that path. It is strong enough for the failure
 *     mode that matters here — a registry default drifting from the source — and
 *     it needs no import and no change to the file. Same technique, same
 *     directory, as purity.test.ts.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ARA_COPY, DEFAULT_COPY, copyDefault, fill,
  HARD_CAP_KINDS, staticKeys, validateResolvedCopy,
  type AraCopyKey, type AraCopyOrigin, type AraCopySpec,
} from "./copy";
import { inr } from "./money";
import { generateSmartPlans, planTypeName } from "./plans";
import { DIVIDER, MODIFY_FAILED, MODIFY_PROMPT, ROOM_ACTION_LABELS } from "./constants";
import { ageConfirmFooter, buildOccupancyNotice, formatAges, renderAgeConfirmation } from "./ages";
import { applyAddExtraBed, applyChangeRoomType, applyMoveGuest } from "./appliers";
import {
  buildManualRoomList, buildRoomDescriptionsMessage, confirmPromptFooter,
  occupancyPhrase, renderAllocationSummary, renderChangeTypeSelect, renderManualMode,
  renderMoveFromCount, renderMoveToRoom, renderPlanTextFallback, renderRoomMenu,
} from "./render";
import {
  buildChangeTypeSections, buildManualModeSections, buildMoveToRoomSections,
  buildRoomMenuSections,
} from "../modifyLists";
import { buildPlanDetailText } from "../planList";
import type {
  AllocationConfig, AllocationPlan, AllocationRoom, AllocationRoomInput,
  AraState, RoomConfigResolver,
} from "./types";

const KEYS = Object.keys(ARA_COPY) as AraCopyKey[];

/** Widens the per-key literal type to the declared interface, so optional
 *  members are readable on every key. */
const specOf = (k: AraCopyKey): AraCopySpec => ARA_COPY[k];

// ── Fixtures ──────────────────────────────────────────────────────────────────

const cfg: AllocationConfig = {
  baseAdults: 2, baseChildren: 0, maxAdults: 3, maxChildren: 1,
  extraAdultCharge: 500, allowExtraBed: true, extraBedCharge: 800, childAgeLimit: null,
};
const resolveCfg: RoomConfigResolver = () => cfg;

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
function state(rooms: AllocationRoom[]): AraState {
  return {
    guests: { adults: 2, children: 1 },
    selectedRooms: rooms,
    remainingGuests: { adults: 0, children: 0 },
    phase: "manual",
  };
}
function plan(over: Partial<AllocationPlan> = {}): AllocationPlan {
  return {
    label: "Best Value 💰", rooms: [room()], totalPrice: 10000, nights: 2,
    roomCount: 1, extraBedCount: 0, primaryRoomTypeId: "rt_a", planTag: "value",
    ...over,
  };
}

// ── Registry integrity ────────────────────────────────────────────────────────

describe("ARA copy registry — integrity", () => {
  it("is non-trivially populated", () => {
    expect(KEYS.length).toBeGreaterThan(80);
  });

  it("declares every {{var}} it uses, and uses every var it declares", () => {
    const problems: string[] = [];
    for (const key of KEYS) {
      const s = specOf(key);
      const used = new Set([...s.default.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]!));
      const declared = new Set<string>(s.vars ?? []);
      for (const u of used) if (!declared.has(u)) problems.push(`${key}: uses {{${u}}} but does not declare it`);
      for (const d of declared) if (!used.has(d)) problems.push(`${key}: declares "${d}" but never uses it`);
    }
    expect(problems).toEqual([]);
  });

  it("no default can overflow its own declared maxLen", () => {
    // The cap applies to the string the guest receives, not to the template, so
    // a templated key is measured by its SKELETON — the literal text with every
    // token removed. A skeleton that already overflows would be truncated even
    // with empty values. Validation of the FULLY INTERPOLATED string is a
    // separate concern, handled by validateResolvedCopy below.
    const problems: string[] = [];
    for (const k of KEYS) {
      const { default: value, maxLen, vars } = specOf(k);
      if (maxLen === undefined) continue;
      const measured = vars?.length ? value.replace(/\{\{[\w.]+\}\}/g, "") : value;
      if (measured.length > maxLen) problems.push(`${k}: skeleton ${measured.length} > ${maxLen}`);
    }
    expect(problems).toEqual([]);
  });

  it("keys sharing a default all explain why via note", () => {
    const byDefault = new Map<string, AraCopyKey[]>();
    for (const k of KEYS) {
      const list = byDefault.get(specOf(k).default) ?? [];
      list.push(k);
      byDefault.set(specOf(k).default, list);
    }
    const unexplained: string[] = [];
    for (const [value, keys] of byDefault) {
      if (keys.length < 2) continue;
      for (const k of keys) {
        if (!specOf(k).note) unexplained.push(`${k} shares "${value}" with ${keys.filter((o) => o !== k).join(", ")} but has no note`);
      }
    }
    expect(unexplained).toEqual([]);
  });

  it("contains no protocol identifier", () => {
    // Button/row ids are a machine contract with the webhook. If one ever landed
    // in this registry a hotel could edit it and break every tap.
    const PROTOCOL = /\b(MOD_[A-Z_]+|MOVE_TO_ROOM_|MOVE_GO_BACK|MODIFY_DONE|MODIFY_GO_BACK|MODIFY_BOOKING|CONFIRM_BOOKING|CANCEL_BOOKING|CHANGE_TYPE_|EDIT_ROOM_|ADD_ROOM_|MIX_IT_UP|room_TYPE|plan_\d)\b/;
    expect(KEYS.filter((k) => PROTOCOL.test(specOf(k).default))).toEqual([]);
  });

  it("contains no operational safety constant or allocation rule", () => {
    // MAX_ROOMS (50), MAX_BODY (1024), the Meta caps and the loop guards must
    // stay unreachable from the registry — and copy.ts must not even import the
    // modules that hold them.
    const src = readFileSync(join(__dirname, "copy.ts"), "utf8");
    expect(src).not.toContain('from "./constants"');
    expect(src).not.toContain('from "./allocator"');
    const NUMERIC = /\b(50|1024|3650|86400000)\b/;
    expect(KEYS.filter((k) => NUMERIC.test(specOf(k).default))).toEqual([]);
  });

  it("DEFAULT_COPY is total over the registry and frozen", () => {
    expect(Object.keys(DEFAULT_COPY).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) expect(DEFAULT_COPY[k]).toBe(specOf(k).default);
    expect(Object.isFrozen(DEFAULT_COPY)).toBe(true);
  });

  it("branch-arm keys carry a note naming the condition", () => {
    const arms = KEYS.filter((k) => /(One|Many|Fallback)$/.test(k));
    expect(arms.length).toBeGreaterThan(8);
    expect(arms.filter((k) => !specOf(k).note)).toEqual([]);
  });
});

// ── fill() ────────────────────────────────────────────────────────────────────

describe("fill", () => {
  it("substitutes declared tokens and coerces numbers", () => {
    expect(fill("a {{x}} b {{y}}", { x: "1", y: 2 })).toBe("a 1 b 2");
  });

  it("leaves an unknown token verbatim rather than blanking it", () => {
    // Inherited from interpolate() on purpose: a visible {{typo}} beats a gap.
    expect(fill("hi {{nope}}", {})).toBe("hi {{nope}}");
  });

  it("is a no-op on a default with no tokens", () => {
    expect(copyDefault("rejections.nothingToMove")).toBe("Nothing to move.");
  });
});

// ── Resolved-length validation (audit F5) ────────────────────────────────────

describe("validateResolvedCopy — caps on the FINAL string", () => {
  it("every STATIC default satisfies every cap it declares", () => {
    // Only static keys: DEFAULT_COPY holds TEMPLATES, and a template is longer
    // than what it renders ("Plan {{number}} — {{total}}" is 27 characters but
    // renders to about 16). Measuring a template against a cap is precisely the
    // mistake the skeleton check above exists to avoid.
    const staticDefaults = Object.fromEntries(
      staticKeys().map((k) => [k, DEFAULT_COPY[k]]),
    ) as Partial<Record<AraCopyKey, string>>;
    expect(validateResolvedCopy(staticDefaults)).toEqual([]);
  });

  it("a templated default is NOT validatable from the registry alone", () => {
    // Documents the boundary rather than hiding it: these four templates exceed
    // their cap as raw text and only fit once interpolated, so the wiring stage
    // must call validateResolvedCopy AFTER fill(), never on the template.
    const templatedOverflow = validateResolvedCopy(DEFAULT_COPY).map((v) => v.key).sort();
    expect(templatedOverflow).toEqual([
      "lists.addRoomDesc",
      "lists.editRoomTitle",
      "lists.moveToRoomDesc",
      "plans.rowTitleLegacy",
    ]);
    for (const k of templatedOverflow) expect(specOf(k).vars?.length).toBeGreaterThan(0);
  });

  it("every hard-capped key is STATIC, so the default check is complete", () => {
    // This is the property that makes a resolved-length check meaningful without
    // per-key locals: buttons and section titles interpolate nothing, so their
    // resolved text IS their default. Adding a templated button would fail here
    // rather than quietly creating a cap nobody can validate.
    const statics = new Set(staticKeys());
    expect(KEYS.filter((k) => HARD_CAP_KINDS.includes(specOf(k).kind) && !statics.has(k))).toEqual([]);
  });

  it("covers every button and section title", () => {
    const hard = KEYS.filter((k) => HARD_CAP_KINDS.includes(specOf(k).kind));
    expect(hard.length).toBeGreaterThanOrEqual(19);
    for (const k of hard) expect(specOf(k).maxLen, `${k} has no maxLen`).toBeDefined();
    expect(validateResolvedCopy(DEFAULT_COPY, { onlyKinds: HARD_CAP_KINDS })).toEqual([]);
  });

  it("reports an over-long override instead of truncating it", () => {
    // Deliberately NOT silently shortened: a clipped button reading
    // "Confirm boo" is worse than a rejected override.
    const bad = validateResolvedCopy({ "lists.buttonOptions": "A button label far beyond twenty characters" });
    expect(bad).toHaveLength(1);
    expect(bad[0]!.key).toBe("lists.buttonOptions");
    expect(bad[0]!.kind).toBe("button");
    expect(bad[0]!.maxLen).toBe(20);
    expect(bad[0]!.length).toBeGreaterThan(20);
    expect(bad[0]!.value).toContain("far beyond");
  });

  it("honours onlyKinds and skips absent or uncapped keys", () => {
    const over = {
      "lists.buttonOptions": "x".repeat(40),
      "rejections.nothingToMove": "y".repeat(400),
    };
    expect(validateResolvedCopy(over).map((v) => v.key)).toEqual(["lists.buttonOptions"]);
    expect(validateResolvedCopy(over, { onlyKinds: ["section.title"] })).toEqual([]);
    expect(validateResolvedCopy({})).toEqual([]);
  });

  it("excludes row kinds, which the call sites already slice", () => {
    // Row titles/descriptions are truncated by `.slice()` in modifyLists and
    // planList, so overflow there is clipping, not a Meta 400. Buttons and
    // section titles are sliced NOWHERE today, which is why only they are hard.
    expect([...HARD_CAP_KINDS]).toEqual(["button", "section.title"]);
  });
});

// ── Equivalence: constants ────────────────────────────────────────────────────

describe("source equivalence — constants", () => {
  it("summary.divider is DIVIDER", () => {
    expect(specOf("summary.divider").default).toBe(DIVIDER);
  });
  it("manual.prompt is MODIFY_PROMPT", () => {
    expect(specOf("manual.prompt").default).toBe(MODIFY_PROMPT);
  });
  it("manual.failed is MODIFY_FAILED", () => {
    expect(specOf("manual.failed").default).toBe(MODIFY_FAILED);
  });
  it("roomMenu.action* are ROOM_ACTION_LABELS", () => {
    expect(specOf("roomMenu.actionAddBed").default).toBe(ROOM_ACTION_LABELS.add_bed);
    expect(specOf("roomMenu.actionRemoveBed").default).toBe(ROOM_ACTION_LABELS.remove_bed);
    expect(specOf("roomMenu.actionMoveGuest").default).toBe(ROOM_ACTION_LABELS.move_guest);
    expect(specOf("roomMenu.actionChangeType").default).toBe(ROOM_ACTION_LABELS.change_type);
    expect(specOf("roomMenu.actionRemoveRoom").default).toBe(ROOM_ACTION_LABELS.remove_room);
  });
});

// ── Equivalence: whole-output exact matches ───────────────────────────────────

describe("source equivalence — exact, whole function output", () => {
  it("confirm.footer is confirmPromptFooter()", () => {
    expect(specOf("confirm.footer").default).toBe(confirmPromptFooter());
  });

  it("ages.confirmFooter is ageConfirmFooter()", () => {
    expect(specOf("ages.confirmFooter").default).toBe(ageConfirmFooter());
  });

  it("ages.confirmPrompt + subject arms rebuild renderAgeConfirmation, both arms", () => {
    const many = fill(specOf("ages.confirmPrompt").default, {
      subject: fill(specOf("ages.confirmSubjectMany").default, { count: 2 }),
      ages: formatAges([6, 9]),
    });
    expect(many).toBe(renderAgeConfirmation([6, 9]));

    const one = fill(specOf("ages.confirmPrompt").default, {
      subject: specOf("ages.confirmSubjectOne").default,
      ages: formatAges([6]),
    });
    expect(one).toBe(renderAgeConfirmation([6]));
  });

  it("occupancy.notice* rebuild buildOccupancyNotice, both arms", () => {
    const compose = (who: string, counted: string, a: number, c: number, limit: number) =>
      [
        specOf("occupancy.noticeHeader").default,
        fill(specOf("occupancy.noticeCounts").default, { adults: a, children: c }),
        fill(specOf("occupancy.noticeBody").default, { who, ageLimit: limit, counted }),
      ].join("\n\n");

    expect(compose(specOf("occupancy.noticeWhoOne").default, specOf("occupancy.noticeCountedOne").default, 3, 1, 12))
      .toBe(buildOccupancyNotice(3, 1, 1, 12));

    expect(compose(
      fill(specOf("occupancy.noticeWhoMany").default, { promoted: 2 }),
      specOf("occupancy.noticeCountedMany").default, 4, 0, 8,
    )).toBe(buildOccupancyNotice(4, 0, 2, 8));
  });

  it("rejections.* are exactly what the appliers return", () => {
    const noBed = applyAddExtraBed([room()], 0, () => ({ ...cfg, allowExtraBed: false }));
    expect(noBed.ok).toBe(false);
    if (!noBed.ok) expect(noBed.reason).toBe(copyDefault("rejections.noExtraBed", { roomTypeName: "Deluxe" }));

    const nothing = applyMoveGuest([room(), room()], 0, 1, 0, 0, resolveCfg);
    expect(nothing.ok).toBe(false);
    if (!nothing.ok) expect(nothing.reason).toBe(copyDefault("rejections.nothingToMove"));

    const lacks = applyMoveGuest([room({ adults: 1, children: 0 }), room()], 0, 1, 2, 0, resolveCfg);
    expect(lacks.ok).toBe(false);
    if (!lacks.ok) {
      expect(lacks.reason).toBe(copyDefault("rejections.sourceLacksGuests", {
        roomNumber: 1, adultsPhrase: "1 adult", childrenPhrase: "0 children",
      }));
    }

    const tooManyAdults = applyMoveGuest([room({ adults: 3 }), room({ adults: 3 })], 0, 1, 1, 0, resolveCfg);
    expect(tooManyAdults.ok).toBe(false);
    if (!tooManyAdults.ok) {
      expect(tooManyAdults.reason).toBe(copyDefault("rejections.maxAdults", {
        roomTypeName: "Deluxe", adultsPhrase: "3 adults",
      }));
    }

    const tooManyChildren = applyMoveGuest([room({ children: 2 }), room({ children: 1 })], 0, 1, 0, 2, resolveCfg);
    expect(tooManyChildren.ok).toBe(false);
    if (!tooManyChildren.ok) {
      expect(tooManyChildren.reason).toBe(copyDefault("rejections.maxChildren", {
        roomTypeName: "Deluxe", childrenPhrase: "1 child",
      }));
    }

    const soldOutType = applyChangeRoomType([room()], 0, roomInput({ availableCount: 0 }), resolveCfg);
    expect(soldOutType.ok).toBe(false);
    if (!soldOutType.ok) {
      expect(soldOutType.reason).toBe(copyDefault("rejections.typeUnavailable", { roomTypeName: "Superior" }));
    }
  });

  it("lists.* are exactly the titles and descriptions the builders emit", () => {
    const menu = buildRoomMenuSections(room(), ["add_bed", "remove_room"]);
    expect(menu[0]!.title).toBe(specOf("lists.modifyRoomSection").default);
    expect(menu[1]!.title).toBe(specOf("lists.navigationSection").default);
    expect(menu[1]!.rows[0]!.title).toBe(specOf("lists.goBackRow").default);
    expect(menu[0]!.rows[0]!.title).toBe(specOf("roomMenu.actionAddBed").default);

    // F1 — move-to-room row description (occupancy renderer #5).
    const { sections: moveSections } = buildMoveToRoomSections(
      state([room(), room({ adults: 2, children: 1 })]), 0, { adults: 1, children: 0 }, resolveCfg,
    );
    expect(moveSections[0]!.title).toBe(specOf("lists.availableRoomsSection").default);
    expect(moveSections[0]!.rows[0]!.description).toBe(copyDefault("lists.moveToRoomDesc", {
      adults: 2, children: 1, maxAdults: 3, maxChildren: 1,
    }));

    // F1 — manual-mode edit row title + description, and the add row description.
    const manual = buildManualModeSections(state([room()]), [roomInput()]);
    expect(manual.map((s) => s.title)).toEqual([
      specOf("lists.editExistingSection").default,
      specOf("lists.addRoomSection").default,
      specOf("lists.confirmSection").default,
    ]);
    expect(manual[0]!.rows[0]!.title).toBe(copyDefault("lists.editRoomTitle", {
      roomNumber: 1, roomTypeName: "Deluxe",
    }));
    expect(manual[0]!.rows[0]!.description).toBe(copyDefault("lists.editRoomDesc", {
      occupancy: "2 adults, 1 child", total: inr(10000),
    }));
    expect(manual[1]!.rows[0]!.description).toBe(copyDefault("lists.addRoomDesc", {
      maxAdults: 3, maxChildren: 1, price: inr(7000), available: 4,
    }));
    expect(manual[2]!.rows[0]!.title).toBe(specOf("lists.confirmBookingRow").default);
    expect(manual[2]!.rows[1]!.title).toBe(specOf("lists.goBackRow").default);

    // F1 — change-type row description.
    const change = buildChangeTypeSections([roomInput()]);
    expect(change[0]!.title).toBe(specOf("lists.availableTypesSection").default);
    expect(change[1]!.title).toBe(specOf("lists.navigationSection").default);
    expect(change[0]!.rows[0]!.description).toBe(copyDefault("lists.changeTypeDesc", {
      price: inr(7000), available: 4,
    }));
  });

  it("move.toRoomRow is exactly the destination row renderMoveToRoom emits (F1)", () => {
    const text = renderMoveToRoom(
      state([room(), room({ roomTypeName: "Superior", adults: 2, children: 1 })]),
      { adults: 1, children: 0 }, 0, resolveCfg,
    );
    expect(text.split("\n")[2]).toBe(copyDefault("move.toRoomRow", {
      number: 1, roomTypeName: "Superior", adults: 2, children: 1, maxAdults: 3, maxChildren: 1,
    }));
  });

  it("flowRuntime.cardDescription composes from its two capacity arms (F2)", () => {
    // flowRuntime's carousel builder is module-private and interleaved with
    // prisma + sendOutbound, so this verifies the COMPOSITION here and the
    // literals by source scan below.
    const withKids = copyDefault("flowRuntime.cardCapWithChildren", { maxAdults: 3, maxChildren: 2 });
    expect(withKids).toBe("Up to 3 adults, 2 children");

    const adultsOnly = copyDefault("flowRuntime.cardCapAdultsOnly", { maxAdults: 3 });
    expect(adultsOnly).toBe("Up to 3 adults");

    // The price fragment uses flowRuntime's NON-rounding formatter, so the
    // composition is asserted with a plain locale string, not ara/money's inr.
    expect(copyDefault("flowRuntime.cardDescription", {
      cap: withKids, price: `₹${(7000).toLocaleString("en-IN")}`,
    })).toBe("Up to 3 adults, 2 children · ₹7,000/night");

    expect(copyDefault("flowRuntime.cardDescription", {
      cap: adultsOnly, price: `₹${(3000).toLocaleString("en-IN")}`,
    })).toBe("Up to 3 adults · ₹3,000/night");
  });
});

// ── Equivalence: fragments inside a composed render ──────────────────────────

describe("source equivalence — fragments present in real output", () => {
  const summary = renderAllocationSummary(
    [room({ extraBed: true, extraBedCost: 800, extraAdultCost: 500, childAgeLimit: 12 })], {},
  );

  it("summary.* appear in renderAllocationSummary", () => {
    expect(summary).toContain(specOf("summary.header").default);
    expect(summary).toContain(specOf("summary.extraBedLine").default);
    expect(summary).toContain(specOf("summary.divider").default);
    expect(summary).toContain(copyDefault("summary.ageLimitNote", { ageLimit: 12 }));
    // F3 — the COMPLETE registry value, trailing asterisk included, rather than
    // a hand-written "*Total: " prefix. The fixture's single room totals 10000.
    expect(summary).toContain(copyDefault("summary.total", { total: inr(10000) }));
    expect(copyDefault("summary.total", { total: inr(10000) })).toBe("*Total: ₹10,000*");
  });

  it("manual.* appear in renderManualMode", () => {
    const text = renderManualMode(state([room()]), [roomInput()]);
    expect(text).toContain(specOf("manual.header").default);
    expect(text).toContain(copyDefault("manual.editHint", { count: 1 }));
    expect(text).toContain(specOf("manual.addHeader").default);
    expect(text).toContain(specOf("manual.footer").default);
    // summary.total is shared verbatim with the summary — assert it here too.
    expect(text).toContain(copyDefault("summary.total", { total: inr(10000) }));
  });

  it("manual.pick* appear in buildManualRoomList", () => {
    const text = buildManualRoomList([roomInput()], { adults: 2, children: 1 });
    expect(text).toContain(copyDefault("manual.pickHeader", { occupancy: "2 adults, 1 child" }));
    expect(text).toContain(copyDefault("manual.pickFooter", { count: 1 }));
  });

  it("roomMenu.* appear in renderRoomMenu", () => {
    const text = renderRoomMenu(room(), ["add_bed", "remove_room"], 0);
    expect(text).toContain(specOf("roomMenu.question").default);
    expect(text).toContain(specOf("roomMenu.footer").default);
  });

  it("move.* appear in renderMoveFromCount and renderMoveToRoom", () => {
    const from = renderMoveFromCount(room({ adults: 2, children: 0 }), 0);
    expect(from).toContain(copyDefault("move.fromCountHeader", { roomNumber: 1, roomTypeName: "Deluxe" }));
    expect(from).toContain(copyDefault("move.fromCountCurrent", { occupancy: "2 adults, 0 children" }));
    expect(from).toContain(specOf("move.fromCountQuestion").default);
    expect(from).toContain(specOf("move.fromCountFormat").default);
    expect(from).toContain(specOf("move.goBackFooter").default);

    const to = renderMoveToRoom(state([room(), room()]), { adults: 1, children: 0 }, 0, resolveCfg);
    expect(to).toContain(copyDefault("move.toRoomHeader", { moving: "1 adult" }));
  });

  it("changeType.header rebuilds the first line of renderChangeTypeSelect", () => {
    const r = room({ adults: 2, children: 1, extraBed: true });
    const text = renderChangeTypeSelect(r, [roomInput()], 0);
    expect(text).toContain(copyDefault("changeType.header", {
      roomNumber: 1, roomTypeName: "Deluxe", occupancy: occupancyPhrase(r),
    }));
  });

  it("plans.* appear in renderPlanTextFallback", () => {
    const withBeds = renderPlanTextFallback([plan({ extraBedCount: 1 })]);
    expect(withBeds).toContain(specOf("plans.textFallbackHeader").default);
    expect(withBeds).toContain(specOf("plans.bedsIncluded").default);
    expect(withBeds).toContain(copyDefault("plans.textFallbackFooter", { count: 1 }));
    expect(renderPlanTextFallback([plan()])).toContain(specOf("plans.bedsNone").default);
  });

  it("plans.detail* appear in buildPlanDetailText", () => {
    const text = buildPlanDetailText([plan()]);
    expect(text).toContain(specOf("plans.detailHeader").default);
    expect(text).toContain(specOf("plans.detailFooter").default);
    expect(text).toContain(specOf("plans.detailBedsNone").default);
    expect(buildPlanDetailText([plan({ rooms: [room({ extraBed: true })] })]))
      .toContain(specOf("plans.detailBedsIncluded").default);
  });

  it("rooms.desc* appear in buildRoomDescriptionsMessage", () => {
    const text = buildRoomDescriptionsMessage([roomInput()])!;
    expect(text).toContain(specOf("rooms.descHeader").default);
    expect(text).toContain(specOf("rooms.descFooter").default);
  });
});

// ── Equivalence: source scan for literals that cannot be called ──────────────

const SRC = join(__dirname, "..");

/** Modules a key's `origin` maps to. `phases` spans all three phase files. */
const ORIGIN_FILES: Record<AraCopyOrigin, string[]> = {
  render: ["ara/render.ts"],
  ages: ["ara/ages.ts"],
  appliers: ["ara/appliers.ts"],
  constants: ["ara/constants.ts"],
  plans: ["ara/plans.ts"],
  dates: ["ara/dates.ts"],
  phases: ["ara/phases/phase1.ts", "ara/phases/ages.phase.ts", "ara/phases/confirm.phase.ts"],
  handler: ["ara/handler.ts"],
  planList: ["planList.ts"],
  modifyLists: ["modifyLists.ts"],
  flowRuntime: ["../flowRuntime.ts"],
};

const sourceCache = new Map<string, string>();
function sourceOf(origin: AraCopyOrigin): string {
  if (!sourceCache.has(origin)) {
    sourceCache.set(origin, ORIGIN_FILES[origin].map((f) => readFileSync(join(SRC, f), "utf8")).join("\n"));
  }
  return sourceCache.get(origin)!;
}

/**
 * Source splits one logical message across adjacent string literals joined by
 * `+`, so those joins are closed up before matching — otherwise a message the
 * code emits in two pieces looks absent from its own file.
 */
function normaliseSource(source: string): string {
  return source
    .replace(/`\s*\+\s*\n?\s*`/g, "")
    .replace(/"\s*\+\s*\n?\s*"/g, "");
}

/**
 * Keys whose emitted string is interrupted MID-LITERAL by an inline
 * pluralisation ternary — `room${n === 1 ? "" : "s"} as requested` never
 * contains the run "room as requested" in source, though that is exactly what
 * the guest receives — or that have no literal run long enough to match at all.
 *
 * Every key here is verified instead by CALL equivalence or by a complete-tail
 * source assertion below, so an exemption is never a hole (audit F4).
 */
const SCAN_EXEMPT: Partial<Record<AraCopyKey, string>> = {
  "ages.gotPartialOne": "trailing 'child?' sits past a ternary",
  "ages.gotPartialMany": "trailing 'children?' sits past a ternary",
  "plans.rationaleYourChoiceOne": "'room as requested' spans a ternary",
  "plans.rationaleYourChoiceMany": "'rooms as requested' spans a ternary",
  "plans.rationaleComfortPickOne": "'room, base occupancy' spans a ternary",
  "plans.rationaleComfortPickMany": "'rooms, base occupancy' spans a ternary",
  "plans.rationalePremiumValue": "only an em dash between two tokens",
  "lists.editRoomDesc": "only an em dash between two tokens",
};

/** The literal runs of a default, i.e. what survives between `{{tokens}}`. */
function literalSegments(value: string): string[] {
  return value.split(/\{\{[\w.]+\}\}/).map((s) => s.trim()).filter((s) => s.length >= 3);
}

function appearsInSource(segment: string, source: string): boolean {
  const normalised = normaliseSource(source);
  const escaped = segment.split("\n").join(String.fromCharCode(92) + "n");
  return normalised.includes(segment) || normalised.includes(escaped);
}

describe("source equivalence — scan (literals that cannot be invoked)", () => {
  it("every default's literal segments appear in its origin module", () => {
    const problems: string[] = [];
    for (const key of KEYS) {
      if (SCAN_EXEMPT[key]) continue;
      const s = specOf(key);
      const src = sourceOf(s.origin);
      const segments = literalSegments(s.default);
      if (segments.length === 0) {
        problems.push(`${key}: no segment long enough to verify — needs a call-equivalence case instead`);
        continue;
      }
      for (const seg of segments) {
        if (!appearsInSource(seg, src)) {
          problems.push(`${key}: "${seg}" not found in ${ORIGIN_FILES[s.origin].join(", ")}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("the flowRuntime senders' strings are all still there", () => {
    const src = sourceOf("flowRuntime");
    for (const key of KEYS.filter((k) => specOf(k).origin === "flowRuntime")) {
      for (const seg of literalSegments(specOf(key).default)) {
        expect(src, `${key} segment "${seg}" missing from flowRuntime.ts`).toContain(seg);
      }
    }
    // 3 confirm buttons + 7 mix/carousel + 3 card-description keys (F2).
    expect(KEYS.filter((k) => specOf(k).origin === "flowRuntime").length).toBe(13);
  });

  it("the carousel card description is still truncated to 60 (F2)", () => {
    // The slice lives in flowRuntime's private builder, which this patch must
    // not modify, so its presence is asserted rather than exercised.
    const src = sourceOf("flowRuntime");
    expect(src).toContain("description: desc.slice(0, 60)");
    expect(specOf("flowRuntime.cardDescription").maxLen).toBe(60);

    // The slice is DEFENSIVE, not load-bearing: both capacity arms are bounded
    // by two-digit occupancy numbers, so even an absurd rate composes to ~50
    // characters and the 60-char cut is unreachable with real data. Asserted so
    // that a future reword which DOES overflow shows up as a failure here.
    const widest = copyDefault("flowRuntime.cardCapWithChildren", { maxAdults: 99, maxChildren: 99 });
    const worst = copyDefault("flowRuntime.cardDescription", { cap: widest, price: "₹99,99,99,999" });
    expect(worst).toBe("Up to 99 adults, 99 children · ₹99,99,99,999/night");
    expect(worst.length).toBe(50);
    expect(worst.length).toBeLessThanOrEqual(60);
  });

  it("every scan-exempt key is verified to its COMPLETE emitted text (F4)", () => {
    // F4: the first pass checked only a leading fragment, so a reworded tail
    // would have passed. The two age arms cannot be called without a deps
    // harness, so the concatenation-normalised source is matched against the
    // WHOLE expression — both ternary arms and the trailing "?" included.
    const phases = normaliseSource(sourceOf("phases"));
    expect(phases).toContain(
      "what's the age of your other ${remaining} " +
      '${remaining === 1 ? "child" : "children"}?',
    );

    // lists.editRoomDesc has no scannable run, so it is verified against the
    // real builder output (also asserted exactly in the lists.* case above).
    expect(buildManualModeSections(state([room()]), [])[0]!.rows[0]!.description)
      .toBe(copyDefault("lists.editRoomDesc", { occupancy: "2 adults, 1 child", total: inr(10000) }));

    // The exemption list is exactly the one the scan honours — no silent growth.
    expect(Object.keys(SCAN_EXEMPT).sort()).toEqual([
      "ages.gotPartialMany",
      "ages.gotPartialOne",
      "lists.editRoomDesc",
      "plans.rationaleComfortPickMany",
      "plans.rationaleComfortPickOne",
      "plans.rationalePremiumValue",
      "plans.rationaleYourChoiceMany",
      "plans.rationaleYourChoiceOne",
    ]);
  });

  it("every plan rationale equals its registry rendering, in full (F4)", () => {
    // Exact equality, reconstructed from the plan object — so a reworded TAIL
    // fails, which a leading-fragment check could not catch.
    const cfgPlans: AllocationConfig = {
      baseAdults: 2, baseChildren: 0, maxAdults: 3, maxChildren: 1,
      extraAdultCharge: 500, allowExtraBed: true, extraBedCharge: 800, childAgeLimit: null,
    };
    const eco = roomInput({ roomTypeId: "rt_eco", name: "Economy", basePrice: 3000, availableCount: 9 });
    const dlx = roomInput({ roomTypeId: "rt_dlx", name: "Deluxe", basePrice: 6000, availableCount: 9 });
    const ste = roomInput({ roomTypeId: "rt_ste", name: "Suite", basePrice: 10000, availableCount: 9 });
    const scr = roomInput({ roomTypeId: "rt_scr", name: "Scarce", basePrice: 7000, availableCount: 1 });

    // Dedup suppresses plans that collapse to the same composition, so no single
    // call yields the whole family.
    const runs = [
      { adults: 5, rooms: [eco, dlx, ste], preferredRoomTypeId: "rt_dlx", cheapest: "Economy", preferred: "Deluxe" },
      { adults: 5, rooms: [eco, dlx, ste], preferredRoomTypeId: null, cheapest: "Economy", preferred: "" },
      { adults: 2, rooms: [eco, dlx, ste], preferredRoomTypeId: "rt_ste", cheapest: "Economy", preferred: "Suite" },
      { adults: 7, rooms: [scr, eco, dlx], preferredRoomTypeId: "rt_scr", cheapest: "Economy", preferred: "Scarce" },
      { adults: 9, rooms: [scr, eco, dlx], preferredRoomTypeId: "rt_scr", cheapest: "Economy", preferred: "Scarce" },
      { adults: 8, rooms: [eco, dlx], preferredRoomTypeId: null, cheapest: "Economy", preferred: "" },
      { adults: 1, rooms: [eco, dlx], preferredRoomTypeId: "rt_dlx", cheapest: "Economy", preferred: "Deluxe" },
    ];

    const seenKeys = new Set<AraCopyKey>();
    let checked = 0;

    for (const run of runs) {
      for (const pl of generateSmartPlans({
        adults: run.adults, children: 0, rooms: run.rooms,
        config: cfgPlans, nights: 2,
        preferredRoomTypeId: run.preferredRoomTypeId, maxPlans: 8,
      })) {
        if (!pl.rationale) continue;
        checked++;
        const total = inr(pl.totalPrice);
        const typeName = planTypeName(pl);
        let allowed: Array<[AraCopyKey, string]>;

        switch (pl.label) {
          case "Your Choice ⭐":
            allowed = [
              ["plans.rationaleYourChoiceOne", copyDefault("plans.rationaleYourChoiceOne", { count: pl.roomCount, roomTypeName: run.preferred })],
              ["plans.rationaleYourChoiceMany", copyDefault("plans.rationaleYourChoiceMany", { count: pl.roomCount, roomTypeName: run.preferred })],
              ["plans.rationaleYourChoiceFallback", copyDefault("plans.rationaleYourChoiceFallback", { roomTypeName: run.preferred })],
            ];
            break;
          case "Best Value 💰":
            allowed = [["plans.rationaleBestValue", copyDefault("plans.rationaleBestValue", { total })]];
            break;
          case "Best Experience 🌟":
            allowed = [["plans.rationaleBestExperience", copyDefault("plans.rationaleBestExperience", { typeName })]];
            break;
          case "Budget Friendly 🤝":
            allowed = [["plans.rationaleBudgetFriendly", copyDefault("plans.rationaleBudgetFriendly", { roomTypeName: run.cheapest })]];
            break;
          case "Comfort Pick ✨":
            allowed = [
              ["plans.rationaleComfortPickOne", copyDefault("plans.rationaleComfortPickOne", { count: pl.roomCount })],
              ["plans.rationaleComfortPickMany", copyDefault("plans.rationaleComfortPickMany", { count: pl.roomCount })],
            ];
            break;
          case "Premium Value ✨":
            allowed = [["plans.rationalePremiumValue", copyDefault("plans.rationalePremiumValue", { typeName, total })]];
            break;
          default:
            throw new Error(`unrecognised plan label: ${pl.label}`);
        }

        const hit = allowed.find(([, v]) => v === pl.rationale);
        expect(hit, `${pl.label}: rationale ${JSON.stringify(pl.rationale)} matched none of ${JSON.stringify(allowed.map(([, v]) => v))}`).toBeTruthy();
        seenKeys.add(hit![0]);
      }
    }

    // Non-vacuous, and PRECISE about what the allocator can actually reach.
    // plans.rationaleBudgetFriendly and plans.rationaleComfortPickOne are
    // absent on purpose: BUDGET_FRIENDLY allocates [cheapest] with max-fill,
    // which is byte-identical to BEST_VALUE whenever the cheapest type can
    // house the party and returns null when it cannot — so isDistinctPlan
    // always drops it. ComfortPickOne needs a surviving single-room base-first
    // plan, and at one room base-first and max-fill agree, so it dedups too.
    // If a future allocator change makes either reachable, this assertion fails
    // and the key gains real coverage — which is the point.
    expect(checked).toBeGreaterThanOrEqual(12);
    expect([...seenKeys].sort()).toEqual([
      "plans.rationaleBestExperience",
      "plans.rationaleBestValue",
      "plans.rationaleComfortPickMany",
      "plans.rationalePremiumValue",
      "plans.rationaleYourChoiceFallback",
      "plans.rationaleYourChoiceMany",
      "plans.rationaleYourChoiceOne",
    ]);
  });

  it("the scan can actually fail", () => {
    // Guards against a vacuous pass from a broken reader or matcher.
    expect(appearsInSource("a string that is definitely not in the source", sourceOf("render"))).toBe(false);
    expect(sourceOf("render").length).toBeGreaterThan(1000);
  });
});
