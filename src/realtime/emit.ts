// realtime/emit.ts
import { io } from "../server";

export function emitToGuest(guestId: string, event: string, payload: any) {
  io.to(`guest:${guestId}`).emit(event, payload);
}

export function emitToHotel(hotelId: string, event: string, payload: any) {
  io.to(`hotel:${hotelId}`).emit(event, payload);
}

/** Broadcast to all connected Vaketta admin clients. */
export function emitToAdmin(event: string, payload: any) {
  io.to("admin:global").emit(event, payload);
}