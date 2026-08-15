import prisma from "../db/connect";

export type PlanInput = {
  name: string;
  currency: string;
  /** "ALL" or ISO 3166-1 alpha-2. */
  country: string;
  priceMonthly: number;
  conversationLimit: number;
  aiReplyLimit: number;
  extraConversationCharge?: number;
  extraAiReplyCharge?: number;
};

export async function createPlan(data: PlanInput) {
  return prisma.plan.create({ data });
}

export type PlanQuery = {
  includeInactive?: boolean;
  /**
   * Restrict to plans a hotel in this country can buy: its own country plus
   * global ("ALL") plans. The admin Plans UI has always presented country
   * targeting as the point of the field, but the column did not exist and the
   * controller dropped it, so every plan was silently global.
   */
  country?: string | null;
};

export async function getPlans(query: PlanQuery = {}) {
  const { includeInactive = false, country } = query;

  return prisma.plan.findMany({
    where: {
      ...(includeInactive ? {} : { isActive: true }),
      ...(country ? { country: { in: ["ALL", country.toUpperCase()] } } : {}),
    },
    include: { _count: { select: { hotels: true } } },
    orderBy: [{ country: "asc" }, { priceMonthly: "asc" }],
  });
}

export async function getPlanById(id: string) {
  return prisma.plan.findUnique({ where: { id } });
}

export async function updatePlan(id: string, data: Partial<PlanInput> & { isActive?: boolean }) {
  return prisma.plan.update({ where: { id }, data });
}
