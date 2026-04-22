import { Redis } from "ioredis";
import { logger } from "../utils/logger";

function createRedis(label: string): Redis {
  // Read at call time (not module load time) so dotenv has already run.
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL environment variable is not set");

  const client = new Redis(url, {
    maxRetriesPerRequest: null,           // required by BullMQ
    enableReadyCheck:     false,          // don't block until Redis is ready
    lazyConnect:          false,
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
