import prisma from "../db/connect";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";


export async function createRoomType({
  hotelId,
  name,
  basePrice,
  capacity,
  maxAdults,
  maxChildren,
  totalRooms,
  carouselButtonLabel,
}: {
  hotelId:              string;
  name:                 string;
  basePrice:            number;
  capacity?:            number;
  maxAdults?:           number;
  maxChildren?:         number;
  totalRooms?:          number;
  carouselButtonLabel?: string;
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
      ...(carouselButtonLabel !== undefined && { carouselButtonLabel }),
    },
  });
}

export async function getRoomTypes(hotelId: string) {
  return prisma.roomType.findMany({
    where: { hotelId },
    orderBy: { createdAt: "asc" },
    include: { photos: { orderBy: { order: "asc" } } },
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
  carouselButtonLabel,
}: {
  id:                   string;
  hotelId:              string;
  name?:                string;
  basePrice:            number;
  capacity?:            number;
  maxAdults?:           number;
  maxChildren?:         number;
  totalRooms?:          number;
  carouselButtonLabel?: string;
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
      ...(carouselButtonLabel !== undefined && { carouselButtonLabel }),
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



const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export async function getRoomTypeById(id: string, hotelId: string) {
  return prisma.roomType.findFirst({
    where: { id, hotelId },
    include: { photos: { orderBy: { order: "asc" } } },
  });
}

export async function uploadRoomPhoto(
  roomTypeId: string,
  hotelId:    string,
  buffer:     Buffer,
  mimeType:   string,
  fileName:   string
) {
  const roomType = await prisma.roomType.findFirst({ where: { id: roomTypeId, hotelId } });
  if (!roomType) throw new Error("Room type not found");

  const key = `hotels/${hotelId}/rooms/${roomTypeId}/${Date.now()}-${fileName}`;
  await new Upload({
    client: s3,
    params: {
      Bucket:      process.env.R2_BUCKET_NAME!,
      Key:         key,
      Body:        buffer,
      ContentType: mimeType,
    },
  }).done();

  const url = `${process.env.R2_PUBLIC_URL}/${key}`;
  const photoCount = await prisma.roomPhoto.count({ where: { roomTypeId } });

  return prisma.roomPhoto.create({
    data: {
      roomTypeId,
      url,
      order:  photoCount,
      isMain: photoCount === 0, // first photo is main by default
    },
  });
}

export async function deleteRoomPhoto(photoId: string, hotelId: string) {
  const photo = await prisma.roomPhoto.findFirst({
    where: { id: photoId, roomType: { hotelId } },
  });
  if (!photo) throw new Error("Photo not found");

  // Delete from R2
  const key = photo.url.replace(`${process.env.R2_PUBLIC_URL}/`, "");
  await s3.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key:    key,
  }));

  await prisma.roomPhoto.delete({ where: { id: photoId } });

  // If deleted photo was main, set first remaining photo as main
  if (photo.isMain) {
    const first = await prisma.roomPhoto.findFirst({
      where:   { roomTypeId: photo.roomTypeId },
      orderBy: { order: "asc" },
    });
    if (first) {
      await prisma.roomPhoto.update({ where: { id: first.id }, data: { isMain: true } });
    }
  }
}

export async function setMainPhoto(photoId: string, roomTypeId: string, hotelId: string) {
  const roomType = await prisma.roomType.findFirst({ where: { id: roomTypeId, hotelId } });
  if (!roomType) throw new Error("Room type not found");

  await prisma.roomPhoto.updateMany({ where: { roomTypeId }, data: { isMain: false } });
  return prisma.roomPhoto.update({ where: { id: photoId }, data: { isMain: true } });
}

export async function reorderRoomPhotos(
  roomTypeId: string,
  hotelId:    string,
  photoIds:   string[]  // ordered array of photo IDs
) {
  const roomType = await prisma.roomType.findFirst({ where: { id: roomTypeId, hotelId } });
  if (!roomType) throw new Error("Room type not found");

  await Promise.all(
    photoIds.map((id, index) =>
      prisma.roomPhoto.update({ where: { id }, data: { order: index } })
    )
  );
}