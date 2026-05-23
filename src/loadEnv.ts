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

// Render's free tier (and local dev here) has no IPv6 egress. Prefer IPv4 for
// any client that resolves via dns.lookup (e.g. Redis), so it doesn't stall or
// fail (ENETUNREACH) on an AAAA record. NOTE: nodemailer ignores this — it uses
// dns.resolve4/resolve6 directly and is forced to IPv4 in utils/mailer.ts.
// Harmless on hosts where IPv6 works.
dns.setDefaultResultOrder("ipv4first");

const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : ".env.local";

dotenv.config({ path: path.resolve(process.cwd(), envFile) });
