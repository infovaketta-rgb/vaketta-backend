import prisma from "../db/connect";

export async function createPlan(data: {
  name: string;
  currency: string;
  priceMonthly: number;
  conversationLimit: number;
  aiReplyLimit: number;
  extraConversationCharge?: number;
  extraAiReplyCharge?: number;
}) {
  return prisma.plan.create({ data });
}

export async function getPlans(includeInactive = false) {
  return prisma.plan.findMany({
    where: includeInactive ? {} : { isActive: true },
    include: { _count: { select: { hotels: true } } },
    orderBy: { priceMonthly: "asc" },
  });
}

export async function getPlanById(id: string) {
  return prisma.plan.findUnique({ where: { id } });
}

export async function updatePlan(
  id: string,
  data: {
    name?: string;
    currency?: string;
    priceMonthly?: number;
    conversationLimit?: number;
    aiReplyLimit?: number;
    extraConversationCharge?: number;
    extraAiReplyCharge?: number;
    isActive?: boolean;
  }
) {
  return prisma.plan.update({ where: { id }, data });
}
