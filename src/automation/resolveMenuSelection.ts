import prisma from "../db/connect";

export async function resolveMenuSelection(
  hotelId: string,
  input?: string | null
) {
  if (!input) return null;

  const key = input.trim().toUpperCase();

  const item = await prisma.hotelMenuItem.findFirst({
    where: {
      key,
      isActive: true,
      menu: {
        hotelId,
        isActive: true,
      },
    },
  });

  return item?.replyText ?? null;
}
