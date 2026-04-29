import { Server, Socket } from "socket.io";
import prisma from "./db/connect";
import { logger } from "./utils/logger";

const log = logger.child({ service: "socket" });

const isProd = process.env.NODE_ENV === "production";

type AuthedSocket = Socket & {
  data: {
    hotel: {
      id: string;
      name: string;
    };
  };
};

export function initSocket(server: any) {
  const io = new Server(server, {
    cors: {
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        const allowed = (process.env.FRONTEND_ORIGIN || "https://www.vaketta.com")
          .split(",")
          .map((o) => o.trim());
        const isNgrok = !isProd && origin.includes("ngrok");
        if (allowed.includes(origin) || isNgrok) callback(null, true);
        else callback(new Error(`Socket origin ${origin} not allowed`));
      },
      credentials: true,
    },
  });

  // 🔐 AUTH MIDDLEWARE
  io.use(async (socket: AuthedSocket, next: (err?: Error) => void) => {
    try {
      const apiKey = socket.handshake.auth?.apiKey;

      if (!apiKey) {
        return next(new Error("API key required"));
      }

      const hotel = await prisma.hotel.findUnique({
        where: { apiKey },
        select: { id: true, name: true },
      });

      if (!hotel) {
        return next(new Error("Invalid API key"));
      }

      // attach hotel to socket
      socket.data.hotel = hotel;

      // 🔒 hotel-specific room
      socket.join(`hotel:${hotel.id}`);

      next();
    } catch (err) {
      next(new Error("Socket auth failed"));
    }
  });

  io.on("connection", (socket: AuthedSocket) => {
    log.info({ hotelName: socket.data.hotel.name }, "hotel socket connected");
  });

  return io;
}
