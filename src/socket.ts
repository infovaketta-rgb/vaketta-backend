import { Server, Socket } from "socket.io";
import prisma from "./db/connect";
import { logger } from "./utils/logger";
import { verifySocketToken } from "./utils/vakettaJwt";

const log = logger.child({ service: "socket" });

const isProd = process.env.NODE_ENV === "production";

type AuthedSocket = Socket & {
  data: {
    hotel?: { id: string; name: string };
    admin?: { id: string; email: string; name: string };
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
      const apiKey       = socket.handshake.auth?.apiKey as string | undefined;
      const adminToken   = socket.handshake.auth?.adminToken as string | undefined;

      // ── Hotel staff auth (API key) ──────────────────────────────────────────
      if (apiKey) {
        const hotel = await prisma.hotel.findUnique({
          where: { apiKey },
          select: { id: true, name: true },
        });
        if (!hotel) return next(new Error("Invalid API key"));
        socket.data.hotel = hotel;
        socket.join(`hotel:${hotel.id}`);
        return next();
      }

      // ── Vaketta admin auth (short-lived socket token from /admin/socket-token)
      if (adminToken) {
        const decoded = verifySocketToken(adminToken);
        socket.data.admin = { id: decoded.id, email: decoded.email, name: decoded.name };
        socket.join("admin:global");
        return next();
      }

      return next(new Error("Authentication required"));
    } catch (err) {
      next(new Error("Socket auth failed"));
    }
  });

  io.on("connection", (socket: AuthedSocket) => {
    if (socket.data.hotel) {
      log.info({ hotelName: socket.data.hotel.name }, "hotel socket connected");
    } else if (socket.data.admin) {
      log.info({ adminEmail: socket.data.admin.email }, "admin socket connected");
    }
  });

  return io;
}
