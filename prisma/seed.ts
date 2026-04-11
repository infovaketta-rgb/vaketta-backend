import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  const phone = "918606113495";

  // 1️⃣ Generate API key
  const apiKey = crypto.randomBytes(32).toString("hex");

  // 2️⃣ Upsert hotel CORRECTLY
  const hotel = await prisma.hotel.upsert({
    where: { phone },
    update: {
      apiKey, // ✅ update existing hotel
    },
    create: {
      name: "Maadathil Cottages & Beach Resort",
      phone,
      apiKey, // ✅ create new hotel
    },
  });

  // 3️⃣ Ensure hotel config exists
  await prisma.hotelConfig.upsert({
    where: { hotelId: hotel.id },
    update: {},
    create: {
      hotelId: hotel.id,
    },
  });

  const menu = await prisma.hotelMenu.upsert({
  where: { hotelId: hotel.id },
  update: {},
  create: {
    hotelId: hotel.id,
    title: "How can we help you?",
    items: {
      create: [
        {
          key: "1",
          label: "Room details",
          replyText: "🏨 Our rooms start from ₹2500/night",
          order: 1,
        },
        {
          key: "2",
          label: "Photos",
          replyText: "📸 https://example.com/gallery",
          order: 2,
        },
        {
          key: "3",
          label: "Location",
          replyText: "📍 https://maps.google.com/?q=hotel",
          order: 3,
        },
        {
          key: "4",
          label: "Talk to staff",
          replyText: "👨‍💼 Staff will assist you shortly",
          order: 4,
        },
      ],
    },
  },
});
  

  console.log("✅ Hotel & config ready:", hotel.id);
  console.log("🔑 HOTEL_API_KEY:", hotel.apiKey);

  // ─── Vaketta platform admin ───────────────────────────────────────────────
  const adminEmail    = process.env.VAKETTA_ADMIN_EMAIL    || "admin@vaketta.com";
  const adminPassword = process.env.VAKETTA_ADMIN_PASSWORD || "changeme123";

  const hashed = await bcrypt.hash(adminPassword, 12);

  await prisma.vakettaAdmin.upsert({
    where:  { email: adminEmail },
    update: {},
    create: { name: "Vaketta Admin", email: adminEmail, password: hashed },
  });

  console.log("🛡️  Vaketta admin ready:", adminEmail);
}

main()
  .catch((e) => {
    console.error("❌ Seeding error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
