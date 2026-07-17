import { Redis } from "ioredis";
import { logger } from "../utils/logger";

function createRedis(label: string): Redis {
  // Read at call time (not module load time) so dotenv has already run.
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL environment variable is not set");

  // NOTE ON TUNING (Upstash → self-hosted):
  //   Several settings here and in the workers (drainDelay / stalledInterval /
  //   keepAlive) were tuned to minimise command count against Upstash's free tier
  //   (500k commands/day). On a self-hosted Redis on the same VPS these limits do
  //   not apply. Safe self-hosted defaults, if you want snappier behaviour:
  //     • keepAlive: default (0) or 10_000 — LAN latency is negligible
  //     • worker drainDelay: 5_000  (faster pickup when a queue is idle)
  //     • worker stalledInterval: 30_000 (crashed jobs recover in ~30s, not 10min)
  //   maxRetriesPerRequest:null and enableReadyCheck:false are BullMQ REQUIREMENTS
  //   — do not change those regardless of Redis host.
  const client = new Redis(url, {
    maxRetriesPerRequest: null,           // required by BullMQ — keep
    enableReadyCheck:     false,          // required by BullMQ — keep
    lazyConnect:          false,
    keepAlive:            30_000,         // Upstash: fewer PINGs. Self-hosted: can lower/remove.
    retryStrategy(times) {
      const delay = times > 20
        ? 30_000  // after 20 fast attempts, keep retrying every 30s indefinitely
        : Math.min(times * 200, 5_000);
      logger.warn({ label, attempt: times, delayMs: delay }, "Redis reconnecting");
      return delay;
    },
  });

  client.on("connect",      ()    => logger.info({ label }, "Redis connected"));
  client.on("ready",        ()    => logger.info({ label }, "Redis ready"));
  client.on("error",        (err) => logger.error({ label, err: err.message }, "Redis error"));
  client.on("close",        ()    => logger.warn({ label }, "Redis connection closed"));
  client.on("reconnecting", ()    => logger.warn({ label }, "Redis reconnecting"));

  return client;
}

// Singleton used by BullMQ queue and worker
export const redis = createRedis("main");

/** Create an isolated Redis client for pub/sub or other uses. */
export function createRedisClient(label = "client"): Redis {
  return createRedis(label);
}
