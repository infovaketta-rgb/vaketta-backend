/**
 * Block a specific token (e.g. on logout).
 * TTL = remaining seconds until the token naturally expires.
 */
export declare function blockToken(jti: string, exp: number): Promise<void>;
/**
 * Invalidate ALL tokens for a user (e.g. on password change).
 * Stores the current unix timestamp; any token issued before this is rejected.
 * TTL = max token lifetime so the key auto-cleans once all old tokens would have expired.
 */
export declare function invalidateUserTokens(userId: string): Promise<void>;
/**
 * Returns true if the token should be rejected.
 * Checks both the individual JTI blocklist and the user-level invalidation timestamp.
 */
export declare function isTokenBlocked(jti: string, userId: string, iat: number): Promise<boolean>;
//# sourceMappingURL=tokenBlocklist.d.ts.map