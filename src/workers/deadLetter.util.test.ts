/**
 * Regression tests for isFinalAttempt — BullMQ fires "failed" on EVERY attempt,
 * so the instagram worker used to write one DeadLetterEvent per retry (3 rows
 * for one failing event with attempts:3). Dead-letter only on the final attempt.
 */

import { describe, it, expect } from "vitest";
import { isFinalAttempt } from "./deadLetter.util";

describe("isFinalAttempt", () => {
  it("intermediate retries do not dead-letter (attempts 1 and 2 of 3)", () => {
    expect(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } })).toBe(false);
  });

  it("dead-letters only after the FINAL retry has failed (attempt 3 of 3)", () => {
    expect(isFinalAttempt({ attemptsMade: 3, opts: { attempts: 3 } })).toBe(true);
  });

  it("single-attempt jobs (no retry config) dead-letter on their only failure", () => {
    expect(isFinalAttempt({ attemptsMade: 1, opts: {} })).toBe(true);
    expect(isFinalAttempt({ attemptsMade: 1 })).toBe(true);
  });

  it("missing job context is recorded rather than lost", () => {
    expect(isFinalAttempt(undefined)).toBe(true);
    expect(isFinalAttempt(null)).toBe(true);
  });
});
