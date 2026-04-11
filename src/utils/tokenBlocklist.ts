import { redis } from "../queue/redis";

const JTI_PREFIX  = "bl:jti:";   // bl:jti:<jti>       → blocked single token
const USER_PREFIX = "bl:user:";  // bl:user:<userId>   → timestamp; tokens issued before this are invalid

const MAX_TOKEN_TTL_SEC = 7 * 24 * 60 * 60; // 7 days — max possible token lifetime

/**
 * Block a specific token (e.g. on logout).
 * TTL = remaining seconds until the token naturally expires.
 */
export async function blockToken(jti: string, exp: number): Promise<void> {
  const ttl = exp - Math.floor(Date.now() / 1000);
  if (ttl > 0) {
    await redis.setex(`${JTI_PREFIX}${jti}`, ttl, "1");
  }
}

/**
 * Invalidate ALL tokens for a user (e.g. on password change).
 * Stores the current unix timestamp; any token issued before this is rejected.
 * TTL = max token lifetime so the key auto-cleans once all old tokens would have expired.
 */
export async function invalidateUserTokens(userId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await redis.setex(`${USER_PREFIX}${userId}`, MAX_TOKEN_TTL_SEC, String(now));
}

/**
 * Returns true if the token should be rejected.
 * Checks both the individual JTI blocklist and the user-level invalidation timestamp.
 */
export async function isTokenBlocked(
  jti: string,
  userId: string,
  iat: number
): Promise<boolean> {
  const [jtiBlocked, userInvalidatedAt] = await redis.mget(
    `${JTI_PREFIX}${jti}`,
    `${USER_PREFIX}${userId}`
  );

  if (jtiBlocked) return true;
  if (userInvalidatedAt && iat < Number(userInvalidatedAt)) return true;

  return false;
}
