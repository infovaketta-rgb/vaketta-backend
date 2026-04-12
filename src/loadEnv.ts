/**
 * MUST be the first import in server.ts.
 *
 * In CommonJS (the compiled output), `require()` calls execute in order —
 * NOT hoisted. By importing this module first, dotenv is configured before
 * any other module reads process.env at load time (e.g. redis.ts).
 */
import dotenv from "dotenv";
import path from "path";

const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : ".env.local";

dotenv.config({ path: path.resolve(process.cwd(), envFile) });
