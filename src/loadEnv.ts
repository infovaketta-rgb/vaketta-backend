/**
 * MUST be the first import in server.ts.
 *
 * In CommonJS (the compiled output), `require()` calls execute in order —
 * NOT hoisted. By importing this module first, dotenv is configured before
 * any other module reads process.env at load time (e.g. redis.ts).
 */
import dotenv from "dotenv";
import path from "path";
import dns from "dns";

// This network has no working IPv6 route (same issue as Prisma DIRECT_URL).
// Node tries IPv6 first by default, so every outbound connection — notably
// SMTP for OTP emails — stalls ~21s before falling back to IPv4. Force IPv4
// first. Harmless on hosts where IPv6 works.
dns.setDefaultResultOrder("ipv4first");

const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : ".env.local";

dotenv.config({ path: path.resolve(process.cwd(), envFile) });
