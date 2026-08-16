/**
 * audit.service.ts
 *
 * Server-side audit trail for money-touching and administrative actions.
 *
 * WHY THIS EXISTS
 * ---------------
 * The frontend had `lib/adminAudit.ts` — a `console.info("[VAKETTA_AUDIT]", …)`
 * stub whose own comment said "extend to POST /admin/audit-log when backend is
 * ready". It was called for renaming a hotel and editing locale, and NOT called
 * for assigning a plan or starting a trial. So the only actions that moved money
 * were the ones with no trail, and what trail existed was written by the client
 * — which is not evidence.
 *
 * Writes here are **best-effort and never throw**: an audit failure must not
 * roll back a plan assignment or abort the billing cron. Pass a transaction
 * client when the log genuinely belongs to the same atomic unit as the write.
 *
 * Also serves as the dunning idempotency store — `hasEvent()` is what stops a
 * container restart re-sending an expiry email. See `sendBillingNotices`.
 */
import { Prisma } from "@prisma/client";
import prisma from "../db/connect";
import { logger } from "../utils/logger";

const log = logger.child({ service: "audit" });

export type AuditCategory = "billing" | "hotel" | "admin";
export type AuditActorType = "ADMIN" | "SYSTEM";

/** Billing event types. Kept as a union so typos surface at compile time. */
export type BillingEventType =
  | "plan.assigned"
  /** A paid plan queued to begin at a trial's exclusive end. */
  | "plan.scheduled"
  | "plan.created"
  | "plan.updated"
  | "trial.started"
  /** A scheduled plan materialised into a live paid subscription. */
  | "trial.converted"
  | "subscription.renewed"
  | "subscription.canceled"
  | "subscription.past_due"
  | "subscription.expired"
  | "invoice.issued"
  | "invoice.paid"
  | "payment.recorded"
  | "notice.renewal_upcoming"
  | "notice.past_due"
  | "notice.expired";

export type AuditInput = {
  category: AuditCategory;
  type: BillingEventType | string;
  actorType?: AuditActorType;
  /** VakettaAdmin.id for an admin action; omit for SYSTEM. */
  actorId?: string | null;
  hotelId?: string | null;
  data?: Prisma.InputJsonValue;
};

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Record an audit event. Never throws — a failure to log is logged, not raised.
 */
export async function recordAudit(input: AuditInput, tx?: Prisma.TransactionClient): Promise<void> {
  const db: Db = tx ?? prisma;
  try {
    await db.auditLog.create({
      data: {
        category: input.category,
        type: input.type,
        actorType: input.actorType ?? (input.actorId ? "ADMIN" : "SYSTEM"),
        actorId: input.actorId ?? null,
        hotelId: input.hotelId ?? null,
        ...(input.data !== undefined ? { data: input.data } : {}),
      },
    });
  } catch (err) {
    log.error({ err, type: input.type, hotelId: input.hotelId }, "failed to record audit event");
  }
}

/** Convenience wrapper for `category: "billing"`. */
export async function recordBillingEvent(
  type: BillingEventType,
  args: Omit<AuditInput, "category" | "type">,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  return recordAudit({ category: "billing", type, ...args }, tx);
}

/**
 * Has this exact event already been recorded for this hotel?
 *
 * The dunning guard. `since` scopes the lookup to the current billing period so
 * "renewal upcoming" can fire once per period rather than once ever.
 * **Fails closed** (returns `true`) on a DB error: if we cannot prove a notice
 * was not already sent, we do not send it. Spamming a paying customer's inbox is
 * worse than missing one reminder.
 */
export async function hasEvent(
  type: BillingEventType | string,
  hotelId: string,
  since: Date,
): Promise<boolean> {
  try {
    const existing = await prisma.auditLog.findFirst({
      where: { type, hotelId, createdAt: { gte: since } },
      select: { id: true },
    });
    return existing !== null;
  } catch (err) {
    log.error({ err, type, hotelId }, "audit hasEvent lookup failed — suppressing notice");
    return true;
  }
}

export type AuditQuery = {
  category?: string | undefined;
  type?: string | undefined;
  hotelId?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
};

/** Paginated audit feed for the admin panel. Newest first. */
export async function listAuditLog(query: AuditQuery = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));

  const where: Prisma.AuditLogWhereInput = {
    ...(query.category ? { category: query.category } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.hotelId ? { hotelId: query.hotelId } : {}),
  };

  const [data, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { data, total, page, pages: Math.ceil(total / limit), limit };
}
