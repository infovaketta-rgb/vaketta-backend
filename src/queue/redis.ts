import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

function createRedis(label: string): Redis {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,           // required by BullMQ
    enableReadyCheck:     false,          // don't block until Redis is ready
    lazyConnect:          false,
    retryStrategy(times) {
      if (times > 20) {
        console.error(`❌ [Redis:${label}] Too many retry attempts — giving up`);
        return null; // stop retrying
      }
      const delay = Math.min(times * 200, 5_000);
      console.warn(`⚠️  [Redis:${label}] Reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
  });

  client.on("connect",   ()    => console.log(`✅ [Redis:${label}] Connected`));
  client.on("ready",     ()    => console.log(`✅ [Redis:${label}] Ready`));
  client.on("error",     (err) => console.error(`❌ [Redis:${label}] Error:`, err.message));
  client.on("close",     ()    => console.warn(`⚠️  [Redis:${label}] Connection closed`));
  client.on("reconnecting", () => console.warn(`⚠️  [Redis:${label}] Reconnecting...`));

  return client;
}

// Singleton used by BullMQ queue and worker
export const redis = createRedis("main");

/** Create an isolated Redis client for pub/sub or other uses. */
export function createRedisClient(label = "client"): Redis {
  return createRedis(label);
}
