"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSocket = initSocket;
const socket_io_1 = require("socket.io");
const connect_1 = __importDefault(require("./db/connect"));
function initSocket(server) {
    const io = new socket_io_1.Server(server, {
        cors: {
            origin: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
            credentials: true,
        },
    });
    // 🔐 AUTH MIDDLEWARE
    io.use(async (socket, next) => {
        try {
            const apiKey = socket.handshake.auth?.apiKey;
            if (!apiKey) {
                return next(new Error("API key required"));
            }
            const hotel = await connect_1.default.hotel.findUnique({
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
        }
        catch (err) {
            next(new Error("Socket auth failed"));
        }
    });
    io.on("connection", (socket) => {
        console.log("🔌 Hotel connected:", socket.data.hotel.name);
    });
    return io;
}
//# sourceMappingURL=socket.js.map