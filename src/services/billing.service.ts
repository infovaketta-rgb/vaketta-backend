import prisma from "../db/connect";

// ── Date helpers (no external deps) ──────────────────────────────────────────

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfNextMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

// ── Plan assignment (creates subscription snapshot) ────────────────────────────

export async function assignPlanToHotel(hotelId: string, planId: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });

  const now       = new Date();
  const startDate = startOfMonth(now);
  const endDate   = startOfNextMonth(now);

  // Snapshot subscription — preserves terms even if plan is later edited
  const subscription = await prisma.subscription.create({
    data: {
      hotelId,
      planId,
      planName:               plan.name,
      currency:               plan.currency,
      price:                  plan.priceMonthly,
      conversationLimit:      plan.conversationLimit,
      aiReplyLimit:           plan.aiReplyLimit,
      extraConversationCharge: plan.extraConversationCharge,
      extraAiReplyCharge:     plan.extraAiReplyCharge,
      startDate,
      endDate,
    },
  });

  await prisma.hotel.update({
    where: { id: hotelId },
    data: {
      planId,
      subscriptionStatus: "active",
      billingStartDate:   startDate,
      billingEndDate:     endDate,
    },
  });

  return subscription;
}

// ── Trial assignment ──────────────────────────────────────────────────────────

export async function startTrial(
  hotelId: string,
  overrides?: {
    durationDays?:      number;
    conversationLimit?: number;
    aiReplyLimit?:      number;
  }
) {
  // Load global defaults, then apply per-call overrides
  const config = await prisma.trialConfig.upsert({
    where:  { id: "global" },
    update: {},
    create: { id: "global" },
  });

  const days    = overrides?.durationDays      ?? config.durationDays;
  const convLim = overrides?.conversationLimit ?? config.conversationLimit;
  const aiLim   = overrides?.aiReplyLimit      ?? config.aiReplyLimit;

  const now     = new Date();
  const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  // Create a snapshot-style subscription so trial limits are visible in the billing controller
  await prisma.subscription.create({
    data: {
      hotelId,
      planId:               null,
      planName:             "Trial",
      currency:             "USD",
      price:                0,
      conversationLimit:    convLim,
      aiReplyLimit:         aiLim,
      extraConversationCharge: 0,
      extraAiReplyCharge:   0,
      startDate:            now,
      endDate,
    },
  });

  await prisma.hotel.update({
    where: { id: hotelId },
    data: {
      planId:             null,
      subscriptionStatus: "trial",
      billingStartDate:   now,
      billingEndDate:     endDate,
    },
  });

  return {
    subscriptionStatus: "trial",
    billingStartDate:   now,
    billingEndDate:     endDate,
    conversationLimit:  convLim,
    aiReplyLimit:       aiLim,
    durationDays:       days,
  };
}

// ── Read hotel billing state ───────────────────────────────────────────────────

export async function getHotelBilling(hotelId: string) {
  const hotel = await prisma.hotel.findUnique({
    where:   { id: hotelId },
    include: { plan: true },
  });
  if (!hotel) throw new Error("Hotel not found");

  // Latest subscription snapshot
  const subscription = await prisma.subscription.findFirst({
    where:   { hotelId },
    orderBy: { createdAt: "desc" },
  });

  return { hotel, subscription };
}

// ── Admin analytics ────────────────────────────────────────────────────────────

export async function getAdminBillingAnalytics() {
  // MRR = sum of plan prices for active-subscription hotels
  const activeHotels = await prisma.hotel.findMany({
    where:   { subscriptionStatus: "active" },
    include: { plan: true },
  });

  const mrr = activeHotels.reduce(
    (sum, h) => sum + (h.plan?.priceMonthly ?? 0),
    0
  );

  // MRR trend: use subscriptions grouped by month (start of billing period)
  // Gives a picture of when hotels were activated
  const subHistory = await prisma.subscription.findMany({
    orderBy: { startDate: "asc" },
    select:  { price: true, startDate: true },
  });

  // Build monthly MRR from subscription activations (cumulative running total)
  const monthMap = new Map<string, number>();
  for (const sub of subHistory) {
    const m = `${sub.startDate.getFullYear()}-${String(sub.startDate.getMonth() + 1).padStart(2, "0")}`;
    monthMap.set(m, (monthMap.get(m) ?? 0) + sub.price);
  }

  const mrrHistory = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([month, total]) => ({ month, mrr: total }));

  return {
    mrr,
    activeHotelsCount: activeHotels.length,
    mrrHistory,
  };
}

// ── Check and expire subscriptions ────────────────────────────────────────────
// Call this from a scheduled job

export async function expireOverdueSubscriptions() {
  const now = new Date();
  // Both "active" paid plans and "trial" periods must be expired when billingEndDate passes
  const result = await prisma.hotel.updateMany({
    where: {
      subscriptionStatus: { in: ["active", "trial"] },
      billingEndDate:     { lt: now },
    },
    data: { subscriptionStatus: "expired" },
  });
  return result.count;
}
