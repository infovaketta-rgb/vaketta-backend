/**
 * billingBackfillReport.ts — the "free forever" audit.
 *
 *   npx tsx src/scripts/billingBackfillReport.ts            # report only
 *   npx tsx src/scripts/billingBackfillReport.ts --apply    # start trials
 *   npx tsx src/scripts/billingBackfillReport.ts --apply --days 14 --hotel <id>
 *
 * WHY THIS IS A SCRIPT AND NOT A MIGRATION
 * ----------------------------------------
 * Before the auto-trial fix, `createHotel` never started a trial. Every hotel
 * created through the admin panel therefore had `subscriptionStatus` at its
 * schema default, `billingEndDate` NULL, and NO subscription row — which meant
 * the expiry cron never matched it (NULL fails `< now`), the paywall never
 * fired, and the quota check found no subscription and returned "unlimited".
 * Those hotels have been receiving free, uncapped service, possibly for months.
 *
 * Dating them from inside a migration would suspend live, in-use customers with
 * no warning the moment the grace window elapsed. That is a commercial decision,
 * not something a schema change gets to make — so this reports first and only
 * acts under `--apply`.
 */
import prisma from "../db/connect";
import { SubscriptionStatus } from "@prisma/client";
import { startTrial } from "../services/billing.service";
import { monthKey } from "../billing/period";
import { getBillingConfig } from "../services/billing.service";

type Args = { apply: boolean; days?: number; hotelId?: string };

function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  const daysIdx = argv.indexOf("--days");
  const hotelIdx = argv.indexOf("--hotel");
  const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : undefined;
  const hotelId = hotelIdx >= 0 ? argv[hotelIdx + 1] : undefined;
  return {
    apply,
    ...(Number.isFinite(days) && days! > 0 ? { days: Math.round(days!) } : {}),
    ...(hotelId ? { hotelId } : {}),
  };
}

function fmtMoney(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { timezone } = await getBillingConfig();
  const month = monthKey(new Date(), timezone);

  // The signature of the bug: no end date AND no live subscription.
  const candidates = await prisma.hotel.findMany({
    where: {
      ...(args.hotelId ? { id: args.hotelId } : {}),
      billingEndDate: null,
      subscriptionStatus: { in: [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE] },
    },
    select: {
      id: true,
      name: true,
      phone: true,
      createdAt: true,
      subscriptionStatus: true,
      planId: true,
      _count: { select: { guests: true, bookings: true, messages: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const withoutSubscription: typeof candidates = [];
  for (const hotel of candidates) {
    const live = await prisma.subscription.findFirst({
      where: {
        hotelId: hotel.id,
        status: { in: [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
      },
      select: { id: true },
    });
    if (!live) withoutSubscription.push(hotel);
  }

  console.log("\n=== Free-forever hotels (no billingEndDate, no live subscription) ===\n");

  if (withoutSubscription.length === 0) {
    console.log("None. Every hotel has a dated entitlement.\n");
    return;
  }

  const usage = await prisma.usageRecord.findMany({
    where: { hotelId: { in: withoutSubscription.map((h) => h.id) }, month },
  });
  const usageMap = Object.fromEntries(usage.map((u) => [u.hotelId, u]));

  const plans = await prisma.plan.findMany({ where: { isActive: true }, orderBy: { priceMonthly: "asc" } });
  const cheapest = plans[0];

  let unbilledEstimate = 0;

  for (const h of withoutSubscription) {
    const u = usageMap[h.id] ?? { conversationsUsed: 0, aiRepliesUsed: 0 };
    const ageDays = Math.floor((Date.now() - h.createdAt.getTime()) / 86_400_000);
    const months = Math.max(1, Math.round(ageDays / 30));
    if (cheapest) unbilledEstimate += cheapest.priceMonthly * months;

    console.log(
      [
        `  ${h.name}`,
        `    id=${h.id}  phone=${h.phone}`,
        `    status=${h.subscriptionStatus}  age=${ageDays}d (~${months} mo)  plan=${h.planId ?? "none"}`,
        `    lifetime: ${h._count.messages} messages, ${h._count.guests} guests, ${h._count.bookings} bookings`,
        `    this month: ${u.conversationsUsed} conversations, ${u.aiRepliesUsed} AI replies`,
      ].join("\n"),
    );
  }

  console.log(`\n  ${withoutSubscription.length} hotel(s) receiving unlimited free service.`);
  if (cheapest) {
    console.log(
      `  Rough unbilled value at the cheapest active plan (${cheapest.name}): ` +
        `${fmtMoney(unbilledEstimate, cheapest.currency)}`,
    );
  }

  if (!args.apply) {
    console.log(
      "\n  Report only — nothing changed.\n" +
        "  Review this list with whoever owns these accounts BEFORE dating them:\n" +
        "  starting a trial gives each hotel a real expiry, after which its bot stops\n" +
        "  replying to guests.\n\n" +
        "  To act:  npx tsx src/scripts/billingBackfillReport.ts --apply [--days N] [--hotel <id>]\n",
    );
    return;
  }

  console.log(`\n  --apply given: starting a ${args.days ?? "default-length"} trial for each hotel above.\n`);

  let ok = 0;
  let failed = 0;

  for (const h of withoutSubscription) {
    try {
      const result = await startTrial(h.id, args.days ? { durationDays: args.days } : undefined);
      console.log(`  ✓ ${h.name} — trial ends ${result.billingEndDate.toISOString().slice(0, 10)}`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${h.name} (${h.id}):`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  console.log(`\n  Done. ${ok} started, ${failed} failed.\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // Redis keeps the process alive (billing.service holds a connection).
    process.exit(process.exitCode ?? 0);
  });
