/**
 * interpolate.ts
 *
 * Pure flowVar placeholder substitution, kept dependency-free so it can be unit
 * tested without pulling flowRuntime's heavy module-load chain (Redis at import,
 * Prisma, queues, AI). Same isolation principle as bookingAllocation.ts.
 */

/**
 * Replace {{varName}} / {{obj.field}} placeholders in `text` with values from
 * `flowVars`. Unknown keys are left as the literal token (so authors can see
 * which variable failed to resolve rather than getting a blank).
 */
export function interpolate(text: string, flowVars: Record<string, string>): string {
  return text.replace(/\{\{([\w.]+)\}\}/g, (_, key) => flowVars[key] ?? `{{${key}}}`);
}
