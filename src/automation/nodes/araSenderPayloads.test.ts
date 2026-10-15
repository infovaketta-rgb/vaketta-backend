/**
 * araSenderPayloads.test.ts — proves resolved copy reaches the OUTGOING payload.
 *
 * Stage 1 verified these three senders' strings by source scan only: the literal
 * was known to exist in flowRuntime.ts, but nothing proved it was the string
 * that ended up in the payload (audit F2). Now that the pure construction is
 * extracted, every copy-bearing field is asserted against the registry, and the
 * override paths are exercised end-to-end at payload level.
 *
 * No mocking at all: the builders import only types from services/outbound, so
 * there is no prisma, no Redis and no network to stub.
 *
 * BYTE-IDENTITY is the point of the first describe block. The literals asserted
 * there are copied from flowRuntime.ts as it stood BEFORE the extraction, so a
 * drift in either the registry or the builders fails here.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CAROUSEL_DESC_MAX, CAROUSEL_MAX_CARDS,
  buildConfirmButtonsPayload, buildMixItUpPayload,
  buildRoomTypeCards, buildRoomTypeCarouselPayload,
} from "./araSenderPayloads";
import {
  DEFAULT_RESOLVED, araOverridesFromBotMessages, fillKey, resolveAraCopy,
  type CopyRejection,
} from "./ara/copy";
import type { AllocationRoomInput } from "./ara/types";

const FALLBACK = "https://placehold.co/600x400/png?text=Room";

function roomInput(over: Partial<AllocationRoomInput> = {}): AllocationRoomInput {
  return {
    roomTypeId: "rt_a", name: "Deluxe", basePrice: 7000,
    maxAdults: 3, maxChildren: 1, availableCount: 4, description: "Sea view",
    ...over,
  };
}
const noPhotos = new Map<string, string>();

// ── Byte-identity with the pre-extraction literals ───────────────────────────

describe("default payloads are byte-identical to the pre-extraction senders", () => {
  it("room-type carousel", () => {
    const payload = buildRoomTypeCarouselPayload({
      roomInputs: [roomInput()], photoByType: noPhotos, fallbackImage: FALLBACK,
    });
    expect(payload).toEqual({
      kind:     "cards",
      bodyText: "🏨 *Choose a room type:*",
      cards: [{
        imageUrl:    FALLBACK,
        title:       "Deluxe",
        price:       7000,
        description: "Up to 3 adults, 1 children · ₹7,000/night",
        buttonId:    "room_TYPE:rt_a",
        buttonLabel: "Choose",
      }],
    });
  });

  it("mix-it-up list", () => {
    expect(buildMixItUpPayload()).toEqual({
      kind:        "choice",
      bodyText:    "_Not sure? Let us pick the best combination for you_ 👇",
      buttonLabel: "Options",
      sections: [{
        title: "Let us choose",
        rows: [{
          id:          "MIX_IT_UP",
          title:       "Mix it up 🎲",
          description: "We'll pick the best room combination",
        }],
      }],
    });
  });

  it("confirm buttons", () => {
    expect(buildConfirmButtonsPayload("THE SUMMARY")).toEqual({
      kind:     "buttons",
      bodyText: "THE SUMMARY",
      buttons: [
        { id: "CONFIRM_BOOKING", title: "✅ Confirm" },
        { id: "MODIFY_BOOKING",  title: "✏️ Modify" },
        { id: "CANCEL_BOOKING",  title: "✖️ Cancel" },
      ],
    });
  });

  it("the adults-only capacity arm", () => {
    const [card] = buildRoomTypeCards({
      roomInputs: [roomInput({ maxChildren: 0 })], photoByType: noPhotos, fallbackImage: FALLBACK,
    });
    expect(card!.description).toBe("Up to 3 adults · ₹7,000/night");
  });

  it("keeps the NON-rounding money format — not ara/money's rounding one", () => {
    // A fractional rate renders with decimals here and rounded on the confirm
    // summary. A known divergence, preserved deliberately.
    const [card] = buildRoomTypeCards({
      roomInputs: [roomInput({ basePrice: 3000.5, maxChildren: 0 })],
      photoByType: noPhotos, fallbackImage: FALLBACK,
    });
    expect(card!.description).toBe("Up to 3 adults · ₹3,000.5/night");
  });

  it("falls back through baseAdults when maxAdults is null", () => {
    // maxA = maxAdults ?? (baseAdults ?? 2) — the chain, moved verbatim.
    const cards = buildRoomTypeCards({
      roomInputs: [
        roomInput({ roomTypeId: "a", maxAdults: null, baseAdults: 4, maxChildren: 0 }),
        roomInput({ roomTypeId: "b", maxAdults: null, maxChildren: 0 }),
      ],
      photoByType: noPhotos, fallbackImage: FALLBACK,
    });
    expect(cards[0]!.description).toContain("Up to 4 adults");
    expect(cards[1]!.description).toContain("Up to 2 adults");
  });

  it("uses the lead photo when one exists, the fallback otherwise", () => {
    const cards = buildRoomTypeCards({
      roomInputs: [roomInput({ roomTypeId: "has" }), roomInput({ roomTypeId: "none" })],
      photoByType: new Map([["has", "https://cdn/x.jpg"]]),
      fallbackImage: FALLBACK,
    });
    expect(cards[0]!.imageUrl).toBe("https://cdn/x.jpg");
    expect(cards[1]!.imageUrl).toBe(FALLBACK);
  });

  it("caps the carousel at ten cards", () => {
    const many = Array.from({ length: 14 }, (_, i) => roomInput({ roomTypeId: `rt_${i}` }));
    expect(buildRoomTypeCards({ roomInputs: many, photoByType: noPhotos, fallbackImage: FALLBACK }))
      .toHaveLength(CAROUSEL_MAX_CARDS);
    expect(CAROUSEL_MAX_CARDS).toBe(10);
  });
});

// ── Every copy-bearing field traces to the registry ──────────────────────────

describe("payload fields equal their registry keys", () => {
  it("carousel body, card button and card description", () => {
    const payload = buildRoomTypeCarouselPayload({
      roomInputs: [roomInput()], photoByType: noPhotos, fallbackImage: FALLBACK,
    });
    expect(payload.bodyText).toBe(fillKey(DEFAULT_RESOLVED, "flowRuntime.carouselBody"));
    expect(payload.cards[0]!.buttonLabel).toBe(fillKey(DEFAULT_RESOLVED, "flowRuntime.carouselButton"));

    const cap = fillKey(DEFAULT_RESOLVED, "flowRuntime.cardCapWithChildren", { maxAdults: 3, maxChildren: 1 });
    expect(payload.cards[0]!.description).toBe(
      fillKey(DEFAULT_RESOLVED, "flowRuntime.cardDescription", { cap, price: "₹7,000" }),
    );
  });

  it("mix-it-up body, button, section and row", () => {
    const p = buildMixItUpPayload();
    expect(p.bodyText).toBe(fillKey(DEFAULT_RESOLVED, "flowRuntime.mixBody"));
    expect(p.buttonLabel).toBe(fillKey(DEFAULT_RESOLVED, "flowRuntime.mixButton"));
    expect(p.sections[0]!.title).toBe(fillKey(DEFAULT_RESOLVED, "flowRuntime.mixSection"));
    expect(p.sections[0]!.rows[0]!.title).toBe(fillKey(DEFAULT_RESOLVED, "flowRuntime.mixRowTitle"));
    expect(p.sections[0]!.rows[0]!.description).toBe(fillKey(DEFAULT_RESOLVED, "flowRuntime.mixRowDesc"));
  });

  it("the three confirm button titles", () => {
    const p = buildConfirmButtonsPayload("x");
    expect(p.buttons.map((b) => b.title)).toEqual([
      fillKey(DEFAULT_RESOLVED, "confirm.buttonConfirm"),
      fillKey(DEFAULT_RESOLVED, "confirm.buttonModify"),
      fillKey(DEFAULT_RESOLVED, "confirm.buttonCancel"),
    ]);
  });
});

// ── Valid overrides reach the payload ────────────────────────────────────────

describe("valid overrides reach the payload", () => {
  it("carousel body and card button", () => {
    const copy = resolveAraCopy({
      "flowRuntime.carouselBody":   "🏨 *Pick a room:*",
      "flowRuntime.carouselButton": "Select",
    });
    expect(copy.rejected).toEqual([]);
    const p = buildRoomTypeCarouselPayload({
      roomInputs: [roomInput()], photoByType: noPhotos, fallbackImage: FALLBACK, copy,
    });
    expect(p.bodyText).toBe("🏨 *Pick a room:*");
    expect(p.cards[0]!.buttonLabel).toBe("Select");
  });

  it("an interpolated capacity arm", () => {
    const copy = resolveAraCopy({
      "flowRuntime.cardCapWithChildren": "Sleeps {{maxAdults}}+{{maxChildren}}",
    });
    expect(copy.rejected).toEqual([]);
    const [card] = buildRoomTypeCards({
      roomInputs: [roomInput()], photoByType: noPhotos, fallbackImage: FALLBACK, copy,
    });
    expect(card!.description).toBe("Sleeps 3+1 · ₹7,000/night");
  });

  it("mix-it-up labels and the confirm titles", () => {
    const copy = resolveAraCopy({
      "flowRuntime.mixButton":    "Choose",
      "flowRuntime.mixSection":   "Or let us pick",
      "flowRuntime.mixRowTitle":  "Surprise me 🎲",
      "confirm.buttonConfirm":    "✅ Yes",
    });
    expect(copy.rejected).toEqual([]);
    const mix = buildMixItUpPayload(copy);
    expect(mix.buttonLabel).toBe("Choose");
    expect(mix.sections[0]!.title).toBe("Or let us pick");
    expect(mix.sections[0]!.rows[0]!.title).toBe("Surprise me 🎲");
    expect(buildConfirmButtonsPayload("x", copy).buttons[0]!.title).toBe("✅ Yes");
  });
});

// ── Invalid overrides never reach the payload ────────────────────────────────

describe("invalid overrides fall back to the default in the payload", () => {
  it("a too-long list CTA label is refused at resolve time", () => {
    // flowRuntime.mixButton is hard-capped at 20 — sendListMessage passes
    // action.button verbatim, so an overflow would be a Meta 400.
    const copy = resolveAraCopy({ "flowRuntime.mixButton": "A label far beyond twenty characters" });
    expect(copy.rejected.map((r) => r.reason)).toEqual(["too-long"]);
    expect(buildMixItUpPayload(copy).buttonLabel).toBe("Options");
  });

  it("a protocol-like override cannot enter a payload", () => {
    const copy = resolveAraCopy({ "flowRuntime.mixRowTitle": "MIX_IT_UP" });
    expect(copy.rejected.map((r) => r.reason)).toEqual(["protocol-like"]);
    expect(buildMixItUpPayload(copy).sections[0]!.rows[0]!.title).toBe("Mix it up 🎲");
  });

  it("an undeclared token is refused, so no raw {{token}} ships", () => {
    const copy = resolveAraCopy({ "flowRuntime.cardCapAdultsOnly": "Up to {{guestName}}" });
    expect(copy.rejected.map((r) => r.reason)).toEqual(["undeclared-token"]);
    const [card] = buildRoomTypeCards({
      roomInputs: [roomInput({ maxChildren: 0 })], photoByType: noPhotos, fallbackImage: FALLBACK, copy,
    });
    expect(card!.description).toBe("Up to 3 adults · ₹7,000/night");
    expect(card!.description).not.toContain("{{");
  });

  it("blank, non-string and unknown keys all leave the payload at defaults", () => {
    const copy = resolveAraCopy({
      "flowRuntime.mixBody":   "   ",
      "flowRuntime.mixButton": 42,
      "flowRuntime.notAKey":   "x",
    });
    expect(copy.rejected.map((r) => r.reason).sort()).toEqual(["blank", "not-a-string", "unknown-key"]);
    const p = buildMixItUpPayload(copy);
    expect(p.bodyText).toBe("_Not sure? Let us pick the best combination for you_ 👇");
    expect(p.buttonLabel).toBe("Options");
  });
});

// ── Length boundaries at the payload surface ─────────────────────────────────

describe("card-description length boundary", () => {
  // Skeleton fits the 60 cap, so resolveAraCopy accepts it; only the rendered
  // text overflows. This is the case a template-level check cannot catch.
  const OVERFLOWING = "Sleeps {{cap}} at just {{price}} per night, breakfast included";
  const wide = roomInput({ maxAdults: 99, maxChildren: 99, basePrice: 999999999 });

  it("accepts the override at resolve time", () => {
    const copy = resolveAraCopy({ "flowRuntime.cardDescription": OVERFLOWING });
    expect(copy.rejected).toEqual([]);
    expect(copy.overridden).toEqual(["flowRuntime.cardDescription"]);
  });

  it("falls back to the DEFAULT rendering once the final text overflows", () => {
    const copy = resolveAraCopy({ "flowRuntime.cardDescription": OVERFLOWING });
    const seen: CopyRejection[] = [];
    const [card] = buildRoomTypeCards({
      roomInputs: [wide], photoByType: noPhotos, fallbackImage: FALLBACK,
      copy, onReject: (r) => seen.push(r),
    });

    expect(card!.description).toBe("Up to 99 adults, 99 children · ₹99,99,99,999/night");
    expect(card!.description).not.toContain("Sleeps");
    expect(seen.map((r) => r.reason)).toEqual(["too-long"]);
  });

  it("never ships a clipped version of the hotel's own text", () => {
    const copy = resolveAraCopy({ "flowRuntime.cardDescription": OVERFLOWING });
    const [card] = buildRoomTypeCards({
      roomInputs: [wide], photoByType: noPhotos, fallbackImage: FALLBACK, copy,
    });
    expect(card!.description.startsWith("Sleeps")).toBe(false);
    expect(card!.description.endsWith("…")).toBe(false);
  });

  it("an override that fits is used verbatim", () => {
    const copy = resolveAraCopy({ "flowRuntime.cardDescription": "{{cap}} from {{price}}" });
    const [card] = buildRoomTypeCards({
      roomInputs: [roomInput({ maxChildren: 0 })], photoByType: noPhotos, fallbackImage: FALLBACK, copy,
    });
    expect(card!.description).toBe("Up to 3 adults from ₹7,000");
  });

  it("the legacy .slice backstop is still applied and still a no-op by default", () => {
    // Kept because removing it would be a behaviour change; with real data the
    // default composition tops out around 50 characters.
    const [card] = buildRoomTypeCards({
      roomInputs: [wide], photoByType: noPhotos, fallbackImage: FALLBACK,
    });
    expect(card!.description).toHaveLength(50);
    expect(card!.description.length).toBeLessThanOrEqual(CAROUSEL_DESC_MAX);
    expect(CAROUSEL_DESC_MAX).toBe(60);
  });
});

// ── Protocol ids survive every override attempt ──────────────────────────────

describe("interactive ids are never affected by copy", () => {
  it("carousel button id, mix row id and the three confirm ids stay literal", () => {
    const copy = resolveAraCopy({
      "flowRuntime.carouselButton": "Select",
      "flowRuntime.mixRowTitle":    "Surprise me",
      "confirm.buttonConfirm":      "✅ Yes",
      "confirm.buttonModify":       "✏️ Change",
      "confirm.buttonCancel":       "✖️ Stop",
    });
    expect(copy.rejected).toEqual([]);

    expect(buildRoomTypeCards({
      roomInputs: [roomInput({ roomTypeId: "rt_x" })], photoByType: noPhotos,
      fallbackImage: FALLBACK, copy,
    })[0]!.buttonId).toBe("room_TYPE:rt_x");

    expect(buildMixItUpPayload(copy).sections[0]!.rows[0]!.id).toBe("MIX_IT_UP");

    expect(buildConfirmButtonsPayload("x", copy).buttons.map((b) => b.id))
      .toEqual(["CONFIRM_BOOKING", "MODIFY_BOOKING", "CANCEL_BOOKING"]);
  });

  it("the confirm body is passed through untouched", () => {
    // It is the caller's allocation summary, not a registry key.
    const summary = "🛏 *Suggested Allocation*\n━━━\n*Total: ₹10,000*";
    expect(buildConfirmButtonsPayload(summary).bodyText).toBe(summary);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// STAGE 2D — botMessages all the way to the outgoing payload
// ══════════════════════════════════════════════════════════════════════════════
//
// The chain flowRuntime runs once per ARA turn:
//   hotelCfg.botMessages → araOverridesFromBotMessages → resolveAraCopy → builder
//
// Everything here is pure, so the chain is exercised directly. The single line
// of flowRuntime wiring is verified by source scan at the end of this file —
// importing flowRuntime would drag in prisma, Redis and ai.service.

/** What flowRuntime does, for one hotel's config row. */
const copyFor = (botMessages: unknown) =>
  resolveAraCopy(araOverridesFromBotMessages(botMessages));

describe("2D: botMessages → payload", () => {
  const carousel = (botMessages: unknown) => buildRoomTypeCarouselPayload({
    roomInputs: [roomInput()], photoByType: noPhotos, fallbackImage: FALLBACK,
    copy: copyFor(botMessages),
  });

  it("no overrides → byte-identical default payloads", () => {
    for (const botMessages of [undefined, null, {}, { menuGreeting: "Hi there" }, "garbage", []]) {
      expect(carousel(botMessages), JSON.stringify(botMessages) ?? typeof botMessages).toEqual({
        kind:     "cards",
        bodyText: "🏨 *Choose a room type:*",
        cards: [{
          imageUrl:    FALLBACK,
          title:       "Deluxe",
          price:       7000,
          description: "Up to 3 adults, 1 children · ₹7,000/night",
          buttonId:    "room_TYPE:rt_a",
          buttonLabel: "Choose",
        }],
      });
      expect(buildMixItUpPayload(copyFor(botMessages))).toEqual(buildMixItUpPayload());
      expect(buildConfirmButtonsPayload("S", copyFor(botMessages)))
        .toEqual(buildConfirmButtonsPayload("S"));
    }
  });

  it("a valid override changes exactly the intended field", () => {
    const p = carousel({ "ara.flowRuntime.carouselBody": "🏨 *Pick your room:*" });
    expect(p.bodyText).toBe("🏨 *Pick your room:*");
    // Nothing else moved.
    expect(p.cards[0]!.buttonLabel).toBe("Choose");
    expect(p.cards[0]!.description).toBe("Up to 3 adults, 1 children · ₹7,000/night");
    expect(p.cards[0]!.buttonId).toBe("room_TYPE:rt_a");
  });

  it("overrides reach all three senders", () => {
    const botMessages = {
      "ara.flowRuntime.carouselButton": "Select",
      "ara.flowRuntime.mixButton":      "Choose",
      "ara.confirm.buttonConfirm":      "✅ Yes",
    };
    const copy = copyFor(botMessages);
    expect(copy.rejected).toEqual([]);
    expect(carousel(botMessages).cards[0]!.buttonLabel).toBe("Select");
    expect(buildMixItUpPayload(copy).buttonLabel).toBe("Choose");
    expect(buildConfirmButtonsPayload("S", copy).buttons[0]!.title).toBe("✅ Yes");
  });

  it("an invalid override falls back to the default in the payload", () => {
    // Over the 20-char cap on a key sendListMessage passes verbatim.
    const copy = copyFor({ "ara.flowRuntime.mixButton": "A label far beyond twenty characters" });
    expect(copy.rejected.map((r) => r.reason)).toEqual(["too-long"]);
    expect(buildMixItUpPayload(copy).buttonLabel).toBe("Options");
  });

  it("an unsupported key is ignored and reported", () => {
    const copy = copyFor({ "ara.flowRuntime.notAThing": "x", "menuFooter": "y" });
    expect(copy.rejected).toEqual([{ key: "flowRuntime.notAThing", reason: "unknown-key" }]);
    expect(buildMixItUpPayload(copy)).toEqual(buildMixItUpPayload());
  });

  it("a protocol-like override can never enter a payload", () => {
    const copy = copyFor({ "ara.flowRuntime.mixRowTitle": "MIX_IT_UP" });
    expect(copy.rejected.map((r) => r.reason)).toEqual(["protocol-like"]);
    const p = buildMixItUpPayload(copy);
    expect(p.sections[0]!.rows[0]!.title).toBe("Mix it up 🎲");
    expect(p.sections[0]!.rows[0]!.id).toBe("MIX_IT_UP");
  });

  it("malformed botMessages never throws and yields defaults", () => {
    const hostile: unknown[] = [
      Object.create(null), new Map(), new Date(), 0, NaN, "",
      { "ara.flowRuntime.mixBody": { nested: true } },
      { "ara.flowRuntime.mixBody": null },
      { "ara.flowRuntime.mixBody": ["a"] },
    ];
    hostile.forEach((h, i) => {
      expect(() => copyFor(h), `case ${i}`).not.toThrow();
      expect(buildMixItUpPayload(copyFor(h)), `case ${i}`).toEqual(buildMixItUpPayload());
    });
  });

  it("interactive ids survive every override attempt", () => {
    const copy = copyFor({
      "ara.flowRuntime.carouselButton": "Select",
      "ara.confirm.buttonConfirm":      "✅ Yes",
      "ara.confirm.buttonModify":       "✏️ Change",
      "ara.confirm.buttonCancel":       "✖️ Stop",
    });
    expect(carousel({ "ara.flowRuntime.carouselButton": "Select" }).cards[0]!.buttonId)
      .toBe("room_TYPE:rt_a");
    expect(buildConfirmButtonsPayload("S", copy).buttons.map((b) => b.id))
      .toEqual(["CONFIRM_BOOKING", "MODIFY_BOOKING", "CANCEL_BOOKING"]);
  });
});

describe("2D: multi-tenant payload isolation", () => {
  it("two hotels in sequence get their own payloads", () => {
    const a = copyFor({ "ara.flowRuntime.mixButton": "A-label" });
    const b = copyFor({});
    const c = copyFor({ "ara.flowRuntime.mixButton": "C-label" });

    expect(buildMixItUpPayload(a).buttonLabel).toBe("A-label");
    expect(buildMixItUpPayload(b).buttonLabel).toBe("Options");
    expect(buildMixItUpPayload(c).buttonLabel).toBe("C-label");
    // A's bundle is untouched by the later resolves.
    expect(buildMixItUpPayload(a).buttonLabel).toBe("A-label");
  });

  it("an un-customised hotel is unaffected by a customised one", () => {
    const customised = copyFor({ "ara.flowRuntime.carouselBody": "CHANGED" });
    expect(buildRoomTypeCarouselPayload({
      roomInputs: [roomInput()], photoByType: noPhotos, fallbackImage: FALLBACK, copy: customised,
    }).bodyText).toBe("CHANGED");

    const plain = copyFor(undefined);
    expect(plain.copy).toBe(DEFAULT_RESOLVED.copy);
    expect(buildRoomTypeCarouselPayload({
      roomInputs: [roomInput()], photoByType: noPhotos, fallbackImage: FALLBACK, copy: plain,
    }).bodyText).toBe("🏨 *Choose a room type:*");
  });
});

describe("2D: the flowRuntime wiring (tenant overrides deferred to 2G)", () => {
  // flowRuntime imports prisma, queue/redis (which constructs a client at
  // import) and ai.service, so it is read as TEXT — the technique already used
  // by ara/purity.test.ts and ara/copy.test.ts.
  const src = readFileSync(join(__dirname, "..", "flowRuntime.ts"), "utf8");

  // The absence assertions below must be about CODE, not prose: the deferral is
  // documented at the call site in a comment that necessarily names the symbols
  // 2G will introduce. Conservative line-based strip — whole-line comments
  // only, which is exactly where that documentation lives, and a trailing
  // comment on a code line still leaves its code behind.
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("does NOT read HotelConfig.botMessages yet", () => {
    // Stage 2G owns activation. Until then the runtime resolves to the
    // built-in bundle, so guest output is byte-identical for every hotel and
    // an `ara.*` key written directly to botMessages has no effect.
    expect(code).not.toContain("araOverridesFromBotMessages");
    expect(code.match(/resolveAraCopy\(/g) ?? []).toEqual([]);
    expect(code).toContain("const araCopy = DEFAULT_RESOLVED;");
    // And no config fetch was added in anticipation of 2G.
    expect(code.match(/getHotelConfigCached\(/g) ?? []).toHaveLength(2); // pre-existing: :227 and :562
  });

  it("binds the default bundle into every copy-bearing sender", () => {
    // The threading itself is 2C/2D/2E work and stays — only the SOURCE of the
    // bundle is deferred, so 2G is a one-line change at a single call site.
    // Three extracted payload builders (2C/2D) + planList and the four
    // modifyLists senders (2E) = eight.
    expect(src.match(/copy: araCopy/g) ?? []).toHaveLength(8);
    for (const sender of [
      "trySendRoomTypeCarousel", "trySendMixItUpList", "trySendConfirmButtons",
      "trySendPlanList", "trySendRoomMenuList", "trySendMoveToRoomList",
      "trySendManualModeList", "trySendChangeRoomTypeList",
    ]) {
      const line = src.split("\n").find((l) => l.includes(`${sender}({ ...a,`));
      expect(line, `${sender} is not bound with copy`).toContain("copy: araCopy");
    }
  });

  it("carries no rejection-logging path, because nothing can be refused", () => {
    // A default is never rejected (the grandfathering rule), so a warn here
    // would be unreachable code. It lands with the 2G read.
    expect(code).not.toContain("ARA copy: ignoring invalid botMessages override(s)");
    expect(code).not.toContain("araCopy.rejected");
  });

  it("does not thread copy into the Stage 2F modules", () => {
    // Scope guard, moved forward by 2E: planList and modifyLists are now
    // threaded, but the pure ARA core is not. These senders take the channel
    // only, so this stage cannot have silently become 2F.
    for (const sender of ["trySendOccupancyNotice"]) {
      const line = src.split("\n").find((l) => l.includes(`${sender}({ ...a,`));
      expect(line, `${sender} binding`).toBeDefined();
      expect(line, `${sender} should not take copy yet`).not.toContain("copy:");
    }

    // render.ts / ages.ts / appliers.ts / plans.ts / phases/* / handler.ts own
    // 79 of the 134 keys and still use their own literals — the registry scan
    // in ara/copy.test.ts is what proves that, and it would fail here if one
    // of them were silently converted.
    const araSrc = ["render", "ages", "appliers", "plans", "handler", "dates", "constants"]
      .map((m) => readFileSync(join(__dirname, "ara", `${m}.ts`), "utf8"))
      .join("\n");
    expect(araSrc).not.toContain("fillKey(");
  });
});
