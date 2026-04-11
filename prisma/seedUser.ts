import prisma from "../src/db/connect";
import { hashPassword } from "../src/utils/hash";
import { UserRole } from "@prisma/client";

async function main() {
  const hotel = await prisma.hotel.findFirst({
    where: { id: "9a36bf46-eb79-43be-84da-0741813fb811" }, // your test hotel name
  });

  if (!hotel) {
    throw new Error("Hotel not found");
  }

  const hashed = await hashPassword("1715273932");

  await prisma.user.create({
    data: {
      name: "Yoosaf",
      email: "maadathil@test.com",
      password: hashed,
      role: UserRole.ADMIN,
      hotelId: hotel.id,
    },
  });

  console.log("✅ User created successfully");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
