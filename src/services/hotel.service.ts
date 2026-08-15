import prisma from "../db/connect";
import crypto from "crypto";
import { SubscriptionStatus } from "@prisma/client";
import { logger } from "../utils/logger";
import { startTrial, invalidateSubscriptionStatusCache } from "./billing.service";

const log = logger.child({ service: "hotel" });

/**
 * Create a hotel and, unless the platform says otherwise, put it on a trial.
 *
 * THE FREE-FOREVER BUG THIS FIXES
 * -------------------------------
 * `createHotel` used to create the Hotel and its config and nothing else. That
 * left every new tenant in a state where:
 *   - `subscriptionStatus` was the schema default (TRIALING / then "trial"),
 *   - `billingEndDate` was NULL,
 *   - and NO Subscription row existed.
 *
 * Each of those independently disabled a control:
 *   - the expiry cron filters `billingEndDate < now`, and NULL never matches,
 *     so the hotel could never expire;
 *   - the auth middleware saw a non-expired status, so no paywall;
 *   - the quota check found no subscription and returned "not over quota",
 *     so conversations AND AI replies were unlimited.
 *
 * Net effect: every hotel created through `POST /admin/hotels` received
 * unlimited, never-expiring free service unless an admin remembered to click
 * "Start Trial" by hand. Meanwhile `TrialConfig.autoStartOnCreate` — the toggle
 * built precisely to control this — was written by the admin UI and read by
 * nothing.
 *
 * The trial is started in the SAME transaction as the hotel, so a crash between
 * the two can't recreate the un-dated state.
 */
export async function createHotel(name: string, phone: string) {
  const apiKey = crypto.randomBytes(32).toString("hex"); // unique per hotel, per call

  const hotel = await prisma.$transaction(async (tx) => {
    const created = await tx.hotel.create({
      data: {
        name,
        phone,
        apiKey,
        config: {
          create: {
            autoReplyEnabled: true,
            bookingEnabled: true,
          },
        },
      },
      include: { config: true },
    });

    const trialConfig = await tx.trialConfig.upsert({
      where: { id: "global" },
      update: {},
      create: { id: "global" },
    });

    if (trialConfig.autoStartOnCreate) {
      await startTrial(created.id, undefined, tx);
    } else {
      // Auto-trial is off, so the hotel starts with no entitlement rather than
      // an open-ended one. An admin assigns a plan or starts a trial explicitly.
      await tx.hotel.update({
        where: { id: created.id },
        data: { subscriptionStatus: SubscriptionStatus.EXPIRED },
      });
    }

    return created;
  });

  invalidateSubscriptionStatusCache(hotel.id);

  // Emitted after commit — announcing a subscription that could still roll back
  // would leave the admin panel showing a hotel that does not exist.
  try {
    const { emitToAdmin } = await import("../realtime/emit");
    const fresh = await prisma.hotel.findUnique({
      where: { id: hotel.id },
      select: { subscriptionStatus: true, billingEndDate: true },
    });
    emitToAdmin("admin:subscription_changed", {
      hotelId: hotel.id,
      planId: null,
      status: fresh?.subscriptionStatus ?? SubscriptionStatus.TRIALING,
      billingEndDate: fresh?.billingEndDate ?? null,
    });
  } catch (err) {
    log.warn({ err, hotelId: hotel.id }, "failed to emit subscription event for new hotel");
  }

  return hotel;
}
