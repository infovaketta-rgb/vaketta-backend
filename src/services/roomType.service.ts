import prisma from "../db/connect";

export async function createRoomType({
  hotelId,
  name,
  basePrice,
  capacity,
  maxAdults,
  maxChildren,
  totalRooms,
}: {
  hotelId:     string;
  name:        string;
  basePrice:   number;
  capacity?:   number;
  maxAdults?:  number;
  maxChildren?: number;
  totalRooms?: number;
}) {
  return prisma.roomType.create({
    data: {
      hotelId,
      name,
      basePrice,
      capacity:    capacity    ?? null,
      maxAdults:   maxAdults   ?? null,
      maxChildren: maxChildren ?? null,
      totalRooms:  totalRooms  ?? 1,
    },
  });
}

export async function getRoomTypes(hotelId: string) {
  return prisma.roomType.findMany({
    where: { hotelId },
    orderBy: { createdAt: "asc" },
  });
}

export async function updateRoomType({
  id,
  hotelId,
  name,
  basePrice,
  capacity,
  maxAdults,
  maxChildren,
  totalRooms,
}: {
  id:           string;
  hotelId:      string;
  name?:        string;
  basePrice:    number;
  capacity?:    number;
  maxAdults?:   number;
  maxChildren?: number;
  totalRooms?:  number;
}) {
  return prisma.roomType.update({
    where: { id, hotelId },
    data: {
      name:        name ?? "",
      basePrice,
      capacity:    capacity    ?? null,
      maxAdults:   maxAdults   ?? null,
      maxChildren: maxChildren ?? null,
      ...(totalRooms !== undefined && { totalRooms }),
    },
  });
}

export async function deleteRoomType({
  id,
  hotelId,
}: {
  id:      string;
  hotelId: string;
}) {
  return prisma.roomType.delete({
    where: { id, hotelId },
  });
}
