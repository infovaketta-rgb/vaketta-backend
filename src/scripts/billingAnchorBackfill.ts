/**
 * billingAnchorBackfill.ts — settle existing hotels onto the anchored model.
 *
 *   npx tsx src/scripts/billingAnchorBackfill.ts            # report only (default)
 *   npx tsx src/scripts/billingAnchorBackfill.ts --apply    # write
 *
 * Step 2 of the four-step rollout:
 *   1. migration 20260815130000_..._expand   (additive; before the deploy)
 *   2. THIS SCRIPT
 *   3. deploy the new code
 *   4. migration 20260815140000_..._drop_legacy_usage_month_unique (after)
 *
 * Safe to run while the OLD code is still serving: it only writes columns that
 * old code does not read.
 *
 * WHY THIS IS A SCRIPT AND NOT SQL
 * --------------------------------
 * Both backfills are timezone-dependent, and the timezone is a row in
 * PlatformSettings. Doing this in SQL would mean re-implementing
 * `zonedMidnightUTC`/`anchorDayOf` in Postgres and hoping the two agree; a
 * one-day disagreement here moves a customer's renewal date or strands their
 * usage counter. This calls the exact functions the runtime calls.
 *
 * WHAT IT DOES — and, more importantly, what it refuses to do
 * ----------------------------------------------------------
 * 1. `Subscription.billingAnchorDay` ← the day-of-month of the period's END.
 *
 *    NOT the signup date, and NOT `startDate`. The anchor is the day the NEXT
 *    period begins, which is the schedule the customer is already on:
 *      - a renewed calendar-aligned hotel ends on the 1st → anchor 1 → its
 *        periods stay 1st-to-1st, i.e. NOTHING changes for it;
 *      - a hotel still inside the old model's partial first period (assigned
 *        e.g. 15 Aug, period truncated at 1 Sep) also ends on the 1st → anchor
 *        1 → its next period is 1 Sep → 1 Oct, exactly as today.
 *    Deriving from the signup day instead would move renewal dates for live
 *    customers, which is precisely what this migration must not do.
 *
 * 2. `UsageRecord.periodStart/periodEnd` for the row a hotel is CURRENTLY
 *    metering into ← that subscription's stored period boundaries.
 *
 *    This is the part that prevents a free allowance or a double charge. The
 *    SQL migration gave every row a calendar-month boundary; if the hotel's
 *    live period does not start exactly at a UTC month boundary, the runtime
 *    would look up a bucket that does not exist, find zero usage, and hand out
 *    a fresh allowance mid-period. Pointing the in-flight row at the exact
 *    period the runtime will ask for keeps the counter continuous.
 *
 * 3. Nothing else. Periods are NOT recomputed, `startDate`/`endDate` are NOT
 *    touched, historical usage rows keep their counts and their month labels,
 *    and no invoice is read or written. Anchors take effect at each hotel's
 *    next natural renewal.
 *
 * Idempotent: only fills `billingAnchorDay` where it is NULL, and only corrects
 * a usage row whose boundaries do not already match. Safe to re-run.
 */
import prisma from "../db/connect";
import { SubscriptionStatus } from "@prisma/client";
import { anchorDayOf } from "../billing/period";
import { getBillingConfig, LIVE_STATUSES } from "../services/billing.service";

type Args = { apply: boolean; hotelId?: string };

function parseArgs(argv: string[]): Args {
  const hotelIdx = argv.indexOf("--hotel");
  const hotelId = hotelIdx >= 0 ? argv[hotelIdx + 1] : undefined;
  return { apply: argv.includes("--apply"), ...(hotelId ? { hotelId } : {}) };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "—");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { timezone } = await getBillingConfig();

  console.log(`\nBilling anchor backfill — ${args.apply ? "APPLY" : "REPORT ONLY"}`);
  console.log(`Billing timezone: ${timezone}\n`);

  // ── 1. Subscription anchors ────────────────────────────────────────────────

  const needAnchor = await prisma.subscription.findMany({
    where: {
      billingAnchorDay: null,
      status: { in: LIVE_STATUSES },
      ...(args.hotelId ? { hotelId: args.hotelId } : {}),
    },
    select: { id: true, hotelId: true, status: true, startDate: true, endDate: true },
  });

  console.log(`Subscriptions missing an anchor: ${needAnchor.length}`);

  let anchorsWritten = 0;
  for (const sub of needAnchor) {
    // endDate is the boundary the next period starts on — see the header.
    const anchorDay = anchorDayOf(sub.endDate ?? sub.startDate, timezone);
    console.log(
      `  ${sub.hotelId}  ${sub.status.padEnd(9)}  ${iso(sub.startDate)} → ${iso(sub.endDate)}  ⇒ anchor ${anchorDay}`,
    );

    if (args.apply) {
      await prisma.subscription.update({ where: { id: sub.id }, data: { billingAnchorDay: anchorDay } });
      anchorsWritten++;
    }
  }

  // ── 2. In-flight usage buckets ─────────────────────────────────────────────

  const live = await prisma.subscription.findMany({
    where: {
      status: { in: LIVE_STATUSES },
      endDate: { not: null },
      ...(args.hotelId ? { hotelId: args.hotelId } : {}),
    },
    select: { hotelId: true, startDate: true, endDate: true },
  });

  console.log(`\nHotels with a live period: ${live.length}`);

  let bucketsRepointed = 0;
  let bucketsAlreadyCorrect = 0;
  let noBucketYet = 0;

  for (const sub of live) {
    // The row the runtime WOULD have been writing into before this migration:
    // the one overlapping the live period. Matched by overlap rather than by
    // month string so a period spanning two calendar months is still found.
    const candidates = await prisma.usageRecord.findMany({
      where: {
        hotelId: sub.hotelId,
        periodStart: { lt: sub.endDate! },
        periodEnd: { gt: sub.startDate },
      },
      orderBy: { periodStart: "desc" },
    });

    const current = candidates[0];
    if (!current) {
      noBucketYet++;
      continue;
    }

    if (
      current.periodStart?.getTime() === sub.startDate.getTime() &&
      current.periodEnd?.getTime() === sub.endDate!.getTime()
    ) {
      bucketsAlreadyCorrect++;
      continue;
    }

    // Another row already occupies the target key — re-pointing would violate
    // the unique index. Leave both alone and report: a human should look.
    const clash = await prisma.usageRecord.findFirst({
      where: { hotelId: sub.hotelId, periodStart: sub.startDate, NOT: { id: current.id } },
      select: { id: true },
    });
    if (clash) {
      console.log(`  ⚠ ${sub.hotelId}  bucket ${current.id} would collide with ${clash.id} — SKIPPED`);
      continue;
    }

    console.log(
      `  ${sub.hotelId}  usage ${current.month} (${current.conversationsUsed} conv / ${current.aiRepliesUsed} ai)  ` +
        `${iso(current.periodStart)} ⇒ ${iso(sub.startDate)}`,
    );

    if (args.apply) {
      await prisma.usageRecord.update({
        where: { id: current.id },
        // Counts are NOT touched — only the bucket's boundaries.
        data: { periodStart: sub.startDate, periodEnd: sub.endDate! },
      });
      bucketsRepointed++;
    }
  }

  // ── 3. Anything the SQL migration could not key ────────────────────────────

  const orphaned = await prisma.usageRecord.count({ where: { periodStart: null } });

  console.log("\n─────────────────────────────────────────────");
  console.log(`Anchors to write:        ${needAnchor.length}${args.apply ? ` (written: ${anchorsWritten})` : ""}`);
  console.log(`Usage buckets to repoint: ${live.length - bucketsAlreadyCorrect - noBucketYet}${args.apply ? ` (written: ${bucketsRepointed})` : ""}`);
  console.log(`  already correct:        ${bucketsAlreadyCorrect}`);
  console.log(`  no usage yet:           ${noBucketYet}`);
  console.log(`Usage rows still unkeyed: ${orphaned}${orphaned ? "  ← malformed `month`, exempt from the unique index" : ""}`);

  if (!args.apply) {
    console.log("\nReport only. Re-run with --apply to write.\n");
  } else {
    console.log("\nDone.\n");
  }

  // Sanity: the invariant the whole migration rests on.
  const trialing = await prisma.subscription.count({
    where: { status: SubscriptionStatus.TRIALING, scheduledPlanId: { not: null } },
  });
  if (trialing) console.log(`(${trialing} trial(s) already have a scheduled plan.)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
