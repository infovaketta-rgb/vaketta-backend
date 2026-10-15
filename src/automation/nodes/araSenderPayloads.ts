/**
 * araSenderPayloads.ts — pure payload builders for the ARA senders that live in
 * flowRuntime.ts.
 *
 * WHY THIS FILE EXISTS. `trySendRoomTypeCarousel`, `trySendMixItUpList` and
 * `trySendConfirmButtons` are module-private inside flowRuntime.ts, and their
 * strings sit interleaved with `prisma.roomPhoto.findMany` and `sendOutbound`.
 * They could not be called from a test, so their copy had only source-scan
 * coverage (Stage 1 audit F2) — the registry default was known to exist in the
 * file, but nothing proved it was the string that reached the payload.
 *
 * Moving the PURE part here closes that gap. The side-effect boundary is
 * unchanged: the prisma query, `sendOutbound`, the try/catch and the
 * `return false` contract all stay in flowRuntime.ts. These functions take data
 * and return a payload — no I/O, no logger, no prisma.
 *
 * WHY OUTSIDE ./ara. It needs `OutboundCard` / `OutboundPayload` from
 * services/outbound, which `ara/purity.test.ts` forbids inside `ara/`. Only
 * TYPES are imported, so this module still pulls no runtime dependency beyond
 * `ara/copy` → `interpolate`, and its tests need no mocking whatsoever.
 *
 * `trySendOccupancyNotice` is deliberately absent: it sends `{kind:"text"}` with
 * caller-supplied text and owns no copy of its own, so there is nothing to
 * extract.
 *
 * BYTE-IDENTITY. Every literal, cap and fallback below was moved verbatim from
 * flowRuntime.ts. Two in particular must not be "tidied":
 *   • `inrUnrounded` is flowRuntime's own non-rounding formatter. It is NOT
 *     ara/money.ts, which rounds. A fractional rate renders "₹3,000.5" here and
 *     "₹3,001" on the confirm summary — a known divergence, pinned by goldens.
 *   • `.slice(0, CAROUSEL_DESC_MAX)` stays even though `fillKey` now rejects an
 *     over-long override. It is the legacy backstop for the default path, and
 *     removing it would be a behaviour change.
 */

import {
  DEFAULT_RESOLVED, fillKey,
  type CopyRejection, type ResolvedAraCopy,
} from "./ara/copy";
import type { AllocationRoomInput } from "./ara/types";
import type { OutboundCard, OutboundPayload } from "../../services/outbound/payload";

/** Optional observer for a late copy rejection. Never required. */
export type CopyRejectionSink = (rejection: CopyRejection) => void;

/** Meta's carousel card limit, as applied in flowRuntime today. */
export const CAROUSEL_MAX_CARDS = 10;

/**
 * Carousel card-description cut. Mirrors the `.slice(0, 60)` that has always
 * been applied here. Provenance is UNRESOLVED: `planList.ts:80` calls 60 "well
 * within Meta's 72 row-desc limit", so 60 is a self-imposed margin rather than a
 * documented Meta cap for this surface. Not changed, not relied on as a limit.
 */
export const CAROUSEL_DESC_MAX = 60;

/**
 * flowRuntime's local money format, moved verbatim. Does NOT round — see the
 * file header.
 */
function inrUnrounded(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

// ── Room-type carousel ────────────────────────────────────────────────────────

/**
 * One card per room type, in the order given. The caller filters for
 * availability and runs the photo query, because both must happen before this
 * point: the query needs the eligible ids.
 */
export function buildRoomTypeCards(args: {
  /** Already filtered for `availableCount > 0` by the caller. */
  roomInputs:   AllocationRoomInput[];
  photoByType:  Map<string, string>;
  fallbackImage: string;
  copy?:        ResolvedAraCopy | undefined;
  onReject?:    CopyRejectionSink;
}): OutboundCard[] {
  const { roomInputs, photoByType, fallbackImage } = args;
  const copy = args.copy ?? DEFAULT_RESOLVED;

  return roomInputs.slice(0, CAROUSEL_MAX_CARDS).map((r) => {
    const baseA = r.baseAdults  ?? 2;
    const maxA  = r.maxAdults   ?? baseA;
    const maxC  = r.maxChildren ?? 0;

    const cap = maxC > 0
      ? fillKey(copy, "flowRuntime.cardCapWithChildren", { maxAdults: maxA, maxChildren: maxC }, args.onReject)
      : fillKey(copy, "flowRuntime.cardCapAdultsOnly",   { maxAdults: maxA },                   args.onReject);

    const desc = fillKey(copy, "flowRuntime.cardDescription", {
      cap, price: inrUnrounded(r.basePrice),
    }, args.onReject);

    return {
      imageUrl:    photoByType.get(r.roomTypeId) ?? fallbackImage,
      title:       r.name,
      price:       r.basePrice,
      description: desc.slice(0, CAROUSEL_DESC_MAX),
      // Wire protocol — the plan_selection handler matches this verbatim, so it
      // is NOT in the copy registry and must never become configurable.
      buttonId:    `room_TYPE:${r.roomTypeId}`,
      buttonLabel: fillKey(copy, "flowRuntime.carouselButton", undefined, args.onReject),
    };
  });
}

/** The whole `cards` payload for the room-type carousel. */
export function buildRoomTypeCarouselPayload(args: {
  roomInputs:    AllocationRoomInput[];
  photoByType:   Map<string, string>;
  fallbackImage: string;
  copy?:         ResolvedAraCopy | undefined;
  onReject?:     CopyRejectionSink;
}): Extract<OutboundPayload, { kind: "cards" }> {
  const copy = args.copy ?? DEFAULT_RESOLVED;
  return {
    kind:     "cards",
    bodyText: fillKey(copy, "flowRuntime.carouselBody", undefined, args.onReject),
    cards:    buildRoomTypeCards(args),
  };
}

// ── "Mix it up" list ──────────────────────────────────────────────────────────

/**
 * The single-row choice list offered after the carousel. The row id `MIX_IT_UP`
 * is wire protocol: the webhook collapses `list_reply.id` to a text body the ARA
 * handler matches, so it stays a literal here.
 */
export function buildMixItUpPayload(
  copyArg?: ResolvedAraCopy,
  onReject?: CopyRejectionSink,
): Extract<OutboundPayload, { kind: "choice" }> {
  const copy = copyArg ?? DEFAULT_RESOLVED;
  return {
    kind:        "choice",
    bodyText:    fillKey(copy, "flowRuntime.mixBody", undefined, onReject),
    buttonLabel: fillKey(copy, "flowRuntime.mixButton", undefined, onReject),
    sections: [{
      title: fillKey(copy, "flowRuntime.mixSection", undefined, onReject),
      rows: [{
        id:          "MIX_IT_UP",
        title:       fillKey(copy, "flowRuntime.mixRowTitle", undefined, onReject),
        description: fillKey(copy, "flowRuntime.mixRowDesc", undefined, onReject),
      }],
    }],
  };
}

// ── Confirm / Modify / Cancel buttons ─────────────────────────────────────────

/**
 * The three-button confirm message. `bodyText` is the allocation summary the
 * caller already built, passed through untouched.
 *
 * The three ids are wire protocol — they map to the same actions as the legacy
 * "1"/"2"/"MENU" text replies, so they stay literals. Only the titles are copy.
 */
export function buildConfirmButtonsPayload(
  bodyText: string,
  copyArg?: ResolvedAraCopy,
  onReject?: CopyRejectionSink,
): Extract<OutboundPayload, { kind: "buttons" }> {
  const copy = copyArg ?? DEFAULT_RESOLVED;
  return {
    kind: "buttons",
    bodyText,
    buttons: [
      { id: "CONFIRM_BOOKING", title: fillKey(copy, "confirm.buttonConfirm", undefined, onReject) },
      { id: "MODIFY_BOOKING",  title: fillKey(copy, "confirm.buttonModify",  undefined, onReject) },
      { id: "CANCEL_BOOKING",  title: fillKey(copy, "confirm.buttonCancel",  undefined, onReject) },
    ],
  };
}
