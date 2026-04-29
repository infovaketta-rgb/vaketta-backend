import { Prisma } from "@prisma/client";

// tx is required — must be called inside a transaction that holds the advisory lock
export async function generateReferenceNumber(
  tx: Prisma.TransactionClient
): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `VKT-${year}-`;
  const last = await tx.booking.findFirst({
    where:   { referenceNumber: { startsWith: prefix } },
    orderBy: { referenceNumber: "desc" },
    select:  { referenceNumber: true },
  });
  const lastSeq = last?.referenceNumber
    ? parseInt(last.referenceNumber.split("-")[2] ?? "0", 10)
    : 0;
  return `${prefix}${String(lastSeq + 1).padStart(5, "0")}`;
}