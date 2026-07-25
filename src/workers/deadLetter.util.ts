/**
 * BullMQ fires a worker's "failed" event on EVERY failed attempt, not only the
 * last one — so a job with attempts:3 used to write three DeadLetterEvent rows
 * for a single logical failure. Dead-letter only when no retries remain.
 */
export function isFinalAttempt(
  job?: { attemptsMade: number; opts?: { attempts?: number } } | null | undefined,
): boolean {
  // No job context (rare worker-level failure) — record it rather than lose it.
  if (!job) return true;
  const maxAttempts = job.opts?.attempts ?? 1;
  return job.attemptsMade >= maxAttempts;
}
