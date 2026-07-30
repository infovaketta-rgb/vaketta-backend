/**
 * metaApi.utils.ts — shared Meta Graph API helpers.
 *
 * Extracted (behaviour-unchanged) from instagram.send.service.ts so other Meta
 * callers (profile enrichment, auth) share one version cache + retry policy.
 *
 * IMPORT RULE: this module must import ONLY prisma and the logger — never
 * instagram.service.ts or anything that transitively pulls
 * message.service → realtime/emit → server.ts (same reason
 * instagram.send.service.ts imports encryption helpers directly from
 * utils/encryption.utils rather than via the re-export).
 */
import prisma from "../db/connect";

const VERSION_TTL_MS = 300_000;
let _cachedVersion: { value: string; expiresAt: number } | null = null;

export async function getMetaVersion(): Promise<string> {
  const now = Date.now();
  if (_cachedVersion && now < _cachedVersion.expiresAt) return _cachedVersion.value;
  try {
    const row = await prisma.platformSettings.findUnique({ where: { id: "global" } }) as
      { metaApiVersion?: string | null } | null;
    const v = row?.metaApiVersion ?? "v25.0";
    _cachedVersion = { value: v, expiresAt: now + VERSION_TTL_MS };
    return v;
  } catch {
    return _cachedVersion?.value ?? "v25.0";
  }
}

export async function withRetry<T>(
 fn:()=>Promise<T>,
 retries=3,
 baseMs=500
):Promise<T>{

 let lastErr;

 for(let i=0;i<=retries;i++){
   try{
     return await fn();
   }catch(err:any){
      lastErr=err;

      const retryable=
       !err.status ||
       err.status===429 ||
       err.status>=500;

      if(!retryable || i===retries){
        throw err;
      }

      const delay=
       baseMs*(2**i)+Math.random()*250;

      await new Promise(
        r=>setTimeout(r,delay)
      );
   }
 }

 throw lastErr;
}
