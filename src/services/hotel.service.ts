import prisma from "../db/connect";
import crypto from "crypto";

export async function createHotel(name: string, phone: string) {
  const apiKey = crypto.randomBytes(32).toString("hex"); // unique per hotel, per call

  const hotel = await prisma.hotel.create({
    data: {
      name,
      phone,
      apiKey,
      config: {
        create: {
          autoReplyEnabled: true,
          bookingEnabled: true,
        },
      },
    },
    include: {
      config: true,
    },
  });

  return hotel;
}
