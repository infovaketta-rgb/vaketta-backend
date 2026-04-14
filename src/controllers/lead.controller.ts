import { Request, Response } from "express";
import prisma from "../db/connect";

// ── Public: POST /public/leads ────────────────────────────────────────────────
export async function submitLead(req: Request, res: Response) {
  try {
    const { name, email, phone, hotelName, country, planId, message } = req.body;

    if (!name?.trim() || !email?.trim() || !phone?.trim() || !hotelName?.trim()) {
      return res.status(400).json({ error: "name, email, phone and hotelName are required" });
    }

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email.trim())) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const lead = await prisma.lead.create({
      data: {
        name:      name.trim(),
        email:     email.trim().toLowerCase(),
        phone:     phone.trim(),
        hotelName: hotelName.trim(),
        country:   country?.trim() ?? "",
        planId:    planId ?? null,
        message:   message?.trim() ?? null,
      },
    });

    return res.status(201).json({ success: true, id: lead.id });
  } catch (err: any) {
    console.error("❌ submitLead:", err);
    return res.status(500).json({ error: "Failed to submit lead" });
  }
}

// ── Admin: GET /admin/leads ───────────────────────────────────────────────────
export async function listLeads(req: Request, res: Response) {
  try {
    const page   = Math.max(1, parseInt(req.query["page"]  as string) || 1);
    const limit  = Math.min(50, parseInt(req.query["limit"] as string) || 20);
    const status = req.query["status"] as string | undefined;
    const search = (req.query["search"] as string | undefined)?.trim();

    const where: any = {};
    if (status && status !== "all") where.status = status;
    if (search) {
      where.OR = [
        { name:      { contains: search, mode: "insensitive" } },
        { email:     { contains: search, mode: "insensitive" } },
        { hotelName: { contains: search, mode: "insensitive" } },
        { phone:     { contains: search } },
      ];
    }

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.lead.count({ where }),
    ]);

    return res.json({ data: leads, total, page, pages: Math.ceil(total / limit), limit });
  } catch (err: any) {
    console.error("❌ listLeads:", err);
    return res.status(500).json({ error: "Failed to fetch leads" });
  }
}

// ── Admin: PATCH /admin/leads/:id ─────────────────────────────────────────────
export async function updateLead(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const valid = ["new", "contacted", "converted", "rejected"];
    if (status && !valid.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${valid.join(", ")}` });
    }

    const lead = await prisma.lead.update({
      where: { id: id as string },
      data: {
        ...(status !== undefined ? { status } : {}),
        ...(notes  !== undefined ? { notes  } : {}),
      },
    });

    return res.json(lead);
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Lead not found" });
    console.error("❌ updateLead:", err);
    return res.status(500).json({ error: "Failed to update lead" });
  }
}

// ── Public: GET /public/plans ─────────────────────────────────────────────────
export async function listPublicPlans(_req: Request, res: Response) {
  try {
    const plans = await prisma.plan.findMany({
      where:   { isActive: true },
      orderBy: { priceMonthly: "asc" },
      select: {
        id:                      true,
        name:                    true,
        currency:                true,
        priceMonthly:            true,
        conversationLimit:       true,
        aiReplyLimit:            true,
        extraConversationCharge: true,
        extraAiReplyCharge:      true,
      },
    });
    return res.json(plans);
  } catch (err: any) {
    console.error("❌ listPublicPlans:", err);
    return res.status(500).json({ error: "Failed to fetch plans" });
  }
}
