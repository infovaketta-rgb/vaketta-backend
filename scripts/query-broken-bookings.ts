import prisma from "../src/db/connect";
async function run() {
  const rows = await prisma.booking.findMany({
    where: { referenceNumber: { in: ["VKT-2026-00015","VKT-2026-00016","VKT-2026-00017","VKT-2026-00018","VKT-2026-00019"] } },
    orderBy: { referenceNumber: "asc" },
  });
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
}
run().catch((e) => { console.error(String(e)); process.exit(1); });
