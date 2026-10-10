/**
 * ============================================================
 * RELIABILITY PATTERN: Timeout & Graceful Degradation
 * ============================================================
 *
 * WHY THIS MATTERS:
 * Without timeouts, a slow or hung service can block your application
 * indefinitely. A request to an external API might hang for minutes
 * while your user stares at a spinner. Timeouts enforce a time limit
 * and graceful degradation provides a fallback experience.
 *
 * TWO KEY CONCEPTS:
 *
 * 1. TIMEOUT — Set a time limit on every external call.
 *    "If the API doesn't respond in 30 seconds, give up."
 *    This prevents resource exhaustion (connections, threads, memory).
 *
 * 2. GRACEFUL DEGRADATION — When things fail, fail gracefully.
 *    Instead of crashing with a stack trace, return a friendly
 *    fallback response. The user gets a degraded but usable experience.
 *
 *    ┌───────────────┐     success      ┌──────────────┐
 *    │  API Request  │ ───────────────► │ Full Response │
 *    └───────┬───────┘                  └──────────────┘
 *            │
 *            │ timeout!
 *            ▼
 *    ┌───────────────┐                  ┌──────────────────┐
 *    │ TimeoutError  │ ───────────────► │ Fallback Response │
 *    └───────────────┘    graceful      │ (cached/default)  │
 *                        degradation    └──────────────────┘
 *
 * IMPLEMENTATION:
 * We use Promise.race() to race the operation against a timer.
 * Whichever finishes first wins. If the timer wins → TimeoutError.
 */

// ─── Custom Error ───────────────────────────────────────────────

/**
 * Thrown when an operation exceeds its time limit.
 * Contains the timeout duration for logging/debugging.
 */
export class TimeoutError extends Error {
  constructor(
    message: string,
    public readonly timeoutMs: number
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

// ─── Core Timeout Function ──────────────────────────────────────

/**
 * Executes an operation with a time limit.
 *
 * Uses Promise.race() to race the operation against a timer.
 * If the timer fires first → throws TimeoutError.
 * If the operation completes first → returns the result.
 *
 * @param operation - The async operation to time-bound
 * @param timeoutMs - Maximum time allowed (in milliseconds)
 * @returns The result of the operation
 * @throws TimeoutError if the operation exceeds the time limit
 *
 * @example
 * try {
 *   const response = await executeWithTimeout(
 *     () => fetch('https://api.example.com/data'),
 *     5000 // 5 second timeout
 *   );
 * } catch (error) {
 *   if (error instanceof TimeoutError) {
 *     console.log('API took too long!');
 *   }
 * }
 */
export async function executeWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number = 30000
): Promise<T> {
  // Create a promise that rejects after the timeout
  let timer: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new TimeoutError(
          `Operation timed out after ${timeoutMs}ms`,
          timeoutMs
        )
      );
    }, timeoutMs);
  });

  try {
    // Race the operation against the timeout
    // Whichever finishes first wins
    const result = await Promise.race([operation(), timeoutPromise]);
    return result;
  } finally {
    // IMPORTANT: Always clear the timer to prevent memory leaks
    // and to avoid keeping the Node.js event loop alive
    clearTimeout(timer!);
  }
}

// ─── Graceful Degradation Wrapper ───────────────────────────────

/**
 * Executes an operation with a timeout AND a fallback response.
 *
 * This is the "graceful degradation" pattern:
 * - If the operation succeeds in time → return the real result
 * - If it times out → return a degraded but friendly fallback
 * - If it throws a non-timeout error → re-throw (don't mask real bugs)
 *
 * REAL-WORLD EXAMPLE:
 * Your product page loads reviews from a Reviews API.
 * If the Reviews API is slow, instead of showing a loading spinner
 * forever, show "Reviews are temporarily unavailable" and display
 * the rest of the page normally.
 *
 * @param operation  - The async operation to attempt
 * @param fallback   - The fallback value to return on timeout
 * @param timeoutMs  - Maximum time allowed
 * @returns Either the real result or the fallback
 */
export async function withGracefulDegradation<T>(
  operation: () => Promise<T>,
  fallback: T,
  timeoutMs: number = 30000
): Promise<{ result: T; degraded: boolean }> {
  try {
    const result = await executeWithTimeout(operation, timeoutMs);
    return { result, degraded: false };
  } catch (error) {
    if (error instanceof TimeoutError) {
      // Timeout → return the fallback (degraded experience)
      return { result: fallback, degraded: true };
    }
    // Non-timeout error → don't mask it, let it propagate
    throw error;
  }
}
