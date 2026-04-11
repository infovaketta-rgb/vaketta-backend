// realtime/emit.ts
import { io } from "../server";

export function emitToGuest(
  guestId: string,
  event: string,
  payload: any
) {
  io.to(`guest:${guestId}`).emit(event, payload);
}

export function emitToHotel(
  hotelId: string,
  event: string,
  payload: any
) {
  io.to(`hotel:${hotelId}`).emit(event, payload);
}