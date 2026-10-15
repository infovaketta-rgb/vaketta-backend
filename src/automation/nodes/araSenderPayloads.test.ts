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

import {
  CAROUSEL_DESC_MAX, CAROUSEL_MAX_CARDS,
  buildConfirmButtonsPayload, buildMixItUpPayload,
  buildRoomTypeCards, buildRoomTypeCarouselPayload,
} from "./araSenderPayloads";
import {
  DEFAULT_RESOLVED, fillKey, resolveAraCopy,
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
