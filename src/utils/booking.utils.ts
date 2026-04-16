import prisma from "../db/connect";

export async function generateReferenceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `VKT-${year}-`;
  const last = await prisma.booking.findFirst({
    where:   { referenceNumber: { startsWith: prefix } },
    orderBy: { referenceNumber: "desc" },
    select:  { referenceNumber: true },
  });
  const lastSeq = last?.referenceNumber
    ? parseInt(last.referenceNumber.split("-")[2] ?? "0", 10)
    : 0;
  return `${prefix}${String(lastSeq + 1).padStart(5, "0")}`;
}