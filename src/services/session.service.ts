import prisma from "../db/connect";

export type SessionData = {
  bookingGuestName?:    string;
  bookingRoomTypeId?:   string;
  bookingRoomTypeName?: string;
  bookingPricePerNight?: number;
  bookingCheckIn?:      string; // YYYY-MM-DD
  bookingCheckOut?:     string; // YYYY-MM-DD
  roomList?: Array<{ id: string; name: string; basePrice: number; capacity: number | null; description: string }>;
  // Flow runner state (present when session.state starts with "FLOW:")
  flow?: {
    flowId:      string;
    flowVars:    Record<string, string>; // variableName → collected answer
    waitingFor?: "answer";
    lastInput?:  string;
  };
};

export async function getOrCreateSession(guestId: string, hotelId: string) {
  return prisma.conversationSession.upsert({
    where: { guestId_hotelId: { guestId, hotelId } },
    update: {},
    create: { guestId, hotelId, state: "IDLE", data: {} },
  });
}

export async function updateSession(
  guestId: string,
  hotelId: string,
  state: string,
  data: SessionData = {}
) {
  return prisma.conversationSession.upsert({
    where: { guestId_hotelId: { guestId, hotelId } },
    update:  { state, data: data as object },
    create:  { guestId, hotelId, state, data: data as object },
  });
}

export async function resetSession(guestId: string, hotelId: string) {
  return updateSession(guestId, hotelId, "IDLE", {});
}
