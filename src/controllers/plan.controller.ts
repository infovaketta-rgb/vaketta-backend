/**
 * plan.controller.ts
 *
 * WHAT CHANGED: every handler here presence-checked at best and then blindly
 * `Number()`-ed its inputs. `priceMonthly: "abc"` became NaN, reached Prisma,
 * threw, and surfaced as a **500 with the raw Prisma message**. Negative prices
 * and negative limits passed straight through — and a negative
 * `conversationLimit` made `usage >= -5` permanently true, silencing the
 * hotel's bot forever. `updatePlanHandler` had no validation at all and passed
 * `isActive` through unsanitised, so the string "false" disabled nothing.
 *
 * Now: parsed through billing/validate.ts (400 on bad input), errors go through
 * `serverError` so Prisma internals never reach a client, and `country` — which
 * the admin UI has always sent and rendered — is finally persisted.
 */
import { Request, Response } from "express";
import { createPlan, getPlans, getPlanById, updatePlan } from "../services/plan.service";
import { assignPlanToHotel, startTrial, cancelSubscription, extendSubscription } from "../services/billing.service";
import { recordBillingEvent } from "../services/audit.service";
import { serverError } from "../utils/serverError";
import {
  collect,
  parseBasisPoints,
  parseBoolean,
  parseCountry,
  parseCurrency,
  parseIntInRange,
  parseLimit,
  parseMinorAmount,
  parseNonEmptyString,
} from "../billing/validate";

const adminId = (req: Request): string | null => (req as any).vakettaAdmin?.id ?? null;

// GET /admin/plans
export async function listPlans(req: Request, res: Response) {
  try {
    const plans = await getPlans({ includeInactive: true }); // admin sees inactive too
    res.json(plans);
  } catch (err) {
    return serverError(res, err, "Failed to fetch plans");
  }
}

// POST /admin/plans
export async function createPlanHandler(req: Request, res: Response) {
  const b = req.body ?? {};

  const parsed = collect({
    name: parseNonEmptyString(b.name, "name", 80),
    currency: parseCurrency(b.currency ?? "USD"),
    country: parseCountry(b.country ?? "ALL"),
    priceMonthly: parseMinorAmount(b.priceMonthly, "priceMonthly"),
    conversationLimit: parseLimit(b.conversationLimit, "conversationLimit"),
    aiReplyLimit: parseLimit(b.aiReplyLimit, "aiReplyLimit"),
    extraConversationCharge: parseMinorAmount(b.extraConversationCharge ?? 0, "extraConversationCharge"),
    extraAiReplyCharge: parseMinorAmount(b.extraAiReplyCharge ?? 0, "extraAiReplyCharge"),
    // Defaults to 0 so an existing caller that never sends it creates an
    // untaxed plan — identical behaviour to before the column existed.
    taxRate: parseBasisPoints(b.taxRate ?? 0, "taxRate"),
  });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  let taxLabel: string | undefined;
  if (b.taxLabel != null) {
    const label = parseNonEmptyString(b.taxLabel, "taxLabel", 40);
    if (!label.ok) return res.status(400).json({ error: label.error });
    taxLabel = label.value;
  }

  try {
    const plan = await createPlan({ ...parsed.value, ...(taxLabel !== undefined ? { taxLabel } : {}) });
    await recordBillingEvent("plan.created", {
      actorId: adminId(req),
      data: { planId: plan.id, name: plan.name, price: plan.priceMonthly, currency: plan.currency },
    });
    res.status(201).json(plan);
  } catch (err) {
    return serverError(res, err, "Failed to create plan");
  }
}

// PATCH /admin/plans/:id
export async function updatePlanHandler(req: Request, res: Response) {
  const id = req.params["id"]!;
  const b = req.body ?? {};
  const data: Record<string, unknown> = {};

  // Each field is optional, but any field that IS present must be valid —
  // partial updates were previously unvalidated entirely.
  const fields = [
    ["name", () => parseNonEmptyString(b.name, "name", 80)],
    ["currency", () => parseCurrency(b.currency)],
    ["country", () => parseCountry(b.country)],
    ["priceMonthly", () => parseMinorAmount(b.priceMonthly, "priceMonthly")],
    ["conversationLimit", () => parseLimit(b.conversationLimit, "conversationLimit")],
    ["aiReplyLimit", () => parseLimit(b.aiReplyLimit, "aiReplyLimit")],
    ["extraConversationCharge", () => parseMinorAmount(b.extraConversationCharge, "extraConversationCharge")],
    ["extraAiReplyCharge", () => parseMinorAmount(b.extraAiReplyCharge, "extraAiReplyCharge")],
    ["taxRate", () => parseBasisPoints(b.taxRate, "taxRate")],
    ["taxLabel", () => parseNonEmptyString(b.taxLabel, "taxLabel", 40)],
    ["isActive", () => parseBoolean(b.isActive, "isActive")],
  ] as const;

  for (const [key, parse] of fields) {
    if (b[key] === undefined) continue;
    const parsed = parse();
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    data[key] = parsed.value;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No valid fields to update." });
  }

  try {
    const before = await getPlanById(id);
    if (!before) return res.status(404).json({ error: "Plan not found" });

    const plan = await updatePlan(id, data);

    await recordBillingEvent("plan.updated", {
      actorId: adminId(req),
      data: {
        planId: id,
        changes: data as Record<string, string | number | boolean>,
        // Price edits are the highest-blast-radius change here: they alter what
        // every future period costs for every hotel on the plan.
        ...(data.priceMonthly !== undefined ? { previousPrice: before.priceMonthly } : {}),
      },
    });

    res.json(plan);
  } catch (err) {
    return serverError(res, err, "Failed to update plan");
  }
}

// PATCH /admin/hotels/:id/plan — assign plan to hotel
export async function assignPlanHandler(req: Request, res: Response) {
  const hotelId = req.params["id"]!;
  const { planId, startAt } = req.body ?? {};
  if (!planId || typeof planId !== "string") {
    return res.status(400).json({ error: "planId required" });
  }
  if (startAt !== undefined && startAt !== "now" && startAt !== "trial_end") {
    return res.status(400).json({ error: 'startAt must be "now" or "trial_end".' });
  }

  try {
    const plan = await getPlanById(planId);
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    // Retired plans should not be assignable — this was never checked.
    if (!plan.isActive) return res.status(400).json({ error: "Cannot assign an inactive plan." });

    // Omitting `startAt` defers to the trial boundary when the hotel is on a
    // trial — never silently shortening a trial the customer was promised.
    const sub = await assignPlanToHotel(hotelId, planId, {
      actorId: adminId(req),
      ...(startAt ? { startAt } : {}),
    });
    res.json(sub);
  } catch (err) {
    // The service throws this for a hotel that doesn't exist; a 404 is the
    // honest answer rather than the 500 a raw Prisma error produced.
    if (err instanceof Error && err.message === "Hotel not found") {
      return res.status(404).json({ error: "Hotel not found" });
    }
    if (err instanceof Error && err.message === "Hotel is not on a trial") {
      return res.status(400).json({ error: "Hotel is not on a trial, so the plan cannot start at trial end." });
    }
    return serverError(res, err, "Failed to assign plan");
  }
}

// POST /admin/hotels/:id/trial — start a free trial
export async function startTrialHandler(req: Request, res: Response) {
  const hotelId = req.params["id"]!;
  const b = req.body ?? {};

  const overrides: { durationDays?: number; conversationLimit?: number; aiReplyLimit?: number } = {};

  if (b.days != null) {
    const parsed = parseIntInRange(b.days, "days", 1, 365);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    overrides.durationDays = parsed.value;
  }
  // Previously unclamped: a negative limit here silenced the hotel's bot
  // permanently, because `usage >= -5` is always true.
  if (b.conversationLimit != null) {
    const parsed = parseLimit(b.conversationLimit, "conversationLimit");
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    overrides.conversationLimit = parsed.value;
  }
  if (b.aiReplyLimit != null) {
    const parsed = parseLimit(b.aiReplyLimit, "aiReplyLimit");
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    overrides.aiReplyLimit = parsed.value;
  }

  try {
    const result = await startTrial(hotelId, overrides);
    await recordBillingEvent("trial.started", { hotelId, actorId: adminId(req), data: { ...overrides } });
    res.json(result);
  } catch (err) {
    return serverError(res, err, "Failed to start trial");
  }
}

// POST /admin/hotels/:id/cancel — cancel a subscription
export async function cancelSubscriptionHandler(req: Request, res: Response) {
  const hotelId = req.params["id"]!;
  const immediate = req.body?.immediate === true;

  try {
    const sub = await cancelSubscription(hotelId, immediate, adminId(req));
    res.json(sub);
  } catch (err) {
    if (err instanceof Error && err.message === "Hotel has no active subscription") {
      return res.status(404).json({ error: err.message });
    }
    return serverError(res, err, "Failed to cancel subscription");
  }
}

// POST /admin/hotels/:id/extend — push the current period end out
export async function extendSubscriptionHandler(req: Request, res: Response) {
  const hotelId = req.params["id"]!;
  const parsed = parseIntInRange(req.body?.days, "days", 1, 365);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const sub = await extendSubscription(hotelId, parsed.value, adminId(req));
    res.json(sub);
  } catch (err) {
    if (err instanceof Error && err.message === "Hotel has no active subscription") {
      return res.status(404).json({ error: err.message });
    }
    return serverError(res, err, "Failed to extend subscription");
  }
}
