import prisma from "../src/db/connect";

async function run() {
  // Check keeper exists with correct total and 5 child rows
  const kept = await prisma.booking.findUnique({
    where:   { referenceNumber: "VKT-2026-00015" },
    include: { rooms: true },
  });
  console.log("Keeper booking:");
  console.log("  id:          ", kept?.id);
  console.log("  reference:   ", kept?.referenceNumber);
  console.log("  guestName:   ", kept?.guestName);
  console.log("  totalPrice:  ", kept?.totalPrice);
  console.log("  BookingRoom rows:", kept?.rooms.length);
  kept?.rooms.forEach((r, i) =>
    console.log(`    room ${i+1}: pricePerNight=${r.pricePerNight} totalPrice=${r.totalPrice}`)
  );

  // Confirm duplicates are gone
  const leftovers = await prisma.booking.findMany({
    where: { referenceNumber: { in: ["VKT-2026-00016","VKT-2026-00017","VKT-2026-00018","VKT-2026-00019"] } },
  });
  console.log("\nDuplicate rows remaining:", leftovers.length, "(should be 0)");

  await prisma.$disconnect();
}

run().catch((e) => { console.error(String(e)); process.exit(1); });
