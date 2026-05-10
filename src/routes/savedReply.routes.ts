import { Router, Request, Response } from "express";
import prisma from "../db/connect";

const router = Router();

// ── Helper: extract {{variable_name}} placeholders from body ─────────────────
function extractVariables(body: string): string[] {
  const matches = body.match(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(2, -2)))];
}

// GET /saved-replies — list all for this hotel
router.get("/", async (req: Request, res: Response) => {
  const hotelId = (req as any).user.hotelId as string;
  const { category } = req.query;

  const where: any = { hotelId };
  if (category && typeof category === "string") where.category = category;

  const replies = await prisma.savedReply.findMany({
    where,
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  return res.json(
    replies.map((r) => ({ ...r, variables: extractVariables(r.body) }))
  );
});

// GET /saved-replies/categories — distinct category list for this hotel
router.get("/categories", async (req: Request, res: Response) => {
  const hotelId = (req as any).user.hotelId as string;

  const rows = await prisma.savedReply.findMany({
    where:   { hotelId, category: { not: null } },
    select:  { category: true },
    distinct: ["category"],
    orderBy: { category: "asc" },
  });

  return res.json(rows.map((r) => r.category).filter(Boolean));
});

// POST /saved-replies — create
router.post("/", async (req: Request, res: Response) => {
  const hotelId = (req as any).user.hotelId as string;
  const { name, category, body } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  if (!body?.trim()) return res.status(400).json({ error: "body is required" });

  try {
    const reply = await prisma.savedReply.create({
      data: { hotelId, name: name.trim(), category: category?.trim() || null, body: body.trim() },
    });
    return res.status(201).json({ ...reply, variables: extractVariables(reply.body) });
  } catch (err: any) {
    if (err.code === "P2002") return res.status(409).json({ error: "A saved reply with this name already exists" });
    throw err;
  }
});

// PUT /saved-replies/:id — update
router.put("/:id", async (req: Request, res: Response) => {
  const hotelId = (req as any).user.hotelId as string;
  const { id } = req.params;
  const { name, category, body } = req.body;

  const existing = await prisma.savedReply.findFirst({ where: { id, hotelId } });
  if (!existing) return res.status(404).json({ error: "Saved reply not found" });

  if (name !== undefined && !name?.trim()) return res.status(400).json({ error: "name cannot be empty" });
  if (body !== undefined && !body?.trim()) return res.status(400).json({ error: "body cannot be empty" });

  const reply = await prisma.savedReply.update({
    where: { id },
    data: {
      ...(name  !== undefined ? { name:     name.trim()            } : {}),
      ...(body  !== undefined ? { body:     body.trim()            } : {}),
      ...(category !== undefined ? { category: category?.trim() || null } : {}),
    },
  });
  return res.json({ ...reply, variables: extractVariables(reply.body) });
});

// DELETE /saved-replies/:id
router.delete("/:id", async (req: Request, res: Response) => {
  const hotelId = (req as any).user.hotelId as string;
  const { id } = req.params;

  const existing = await prisma.savedReply.findFirst({ where: { id, hotelId } });
  if (!existing) return res.status(404).json({ error: "Saved reply not found" });

  await prisma.savedReply.delete({ where: { id } });
  return res.status(204).send();
});

export default router;
