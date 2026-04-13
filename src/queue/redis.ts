import { Redis } from "ioredis";

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
