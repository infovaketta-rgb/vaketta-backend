import prisma from "../db/connect";

export function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ── Increment ──────────────────────────────────────────────────────────────────

export async function incrementConversationUsage(hotelId: string): Promise<void> {
  const month = currentMonth();
  await prisma.usageRecord.upsert({
    where:  { hotelId_month: { hotelId, month } },
    update: { conversationsUsed: { increment: 1 } },
    create: { hotelId, month, conversationsUsed: 1, aiRepliesUsed: 0 },
  });
}

export async function incrementAIUsage(hotelId: string): Promise<void> {
  const month = currentMonth();
  await prisma.usageRecord.upsert({
    where:  { hotelId_month: { hotelId, month } },
    update: { aiRepliesUsed: { increment: 1 } },
    create: { hotelId, month, conversationsUsed: 0, aiRepliesUsed: 1 },
  });
}

// ── Read ───────────────────────────────────────────────────────────────────────

export async function getCurrentUsage(hotelId: string) {
  const month = currentMonth();
  return (
    (await prisma.usageRecord.findUnique({
      where: { hotelId_month: { hotelId, month } },
    })) ?? { hotelId, month, conversationsUsed: 0, aiRepliesUsed: 0 }
  );
}

export async function getUsageHistory(hotelId: string, months = 6) {
  const records = await prisma.usageRecord.findMany({
    where:   { hotelId },
    orderBy: { month: "desc" },
    take:    months,
  });
  return records.reverse(); // oldest → newest for charts
}

// ── Admin aggregates ───────────────────────────────────────────────────────────

export async function getPlatformUsageThisMonth() {
  const month = currentMonth();
  const agg = await prisma.usageRecord.aggregate({
    where: { month },
    _sum:  { conversationsUsed: true, aiRepliesUsed: true },
  });
  return {
    conversations: agg._sum.conversationsUsed ?? 0,
    aiReplies:     agg._sum.aiRepliesUsed     ?? 0,
  };
}

export async function getPlatformUsageHistory(months = 6) {
  // Collect last N distinct months across all hotels
  const records = await prisma.usageRecord.groupBy({
    by:      ["month"],
    _sum:    { conversationsUsed: true, aiRepliesUsed: true },
    orderBy: { month: "asc" },
    take:    months * 10, // over-fetch; will slice after
  });

  // Get the last `months` unique months
  const unique = [...new Map(records.map((r) => [r.month, r])).values()];
  return unique.slice(-months).map((r) => ({
    month:         r.month,
    conversations: r._sum.conversationsUsed ?? 0,
    aiReplies:     r._sum.aiRepliesUsed     ?? 0,
  }));
}
