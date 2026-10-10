/**
 * ============================================================
 * RELIABILITY PATTERN: Retry with Exponential Backoff & Jitter
 * ============================================================
 *
 * WHY THIS MATTERS:
 * Transient failures are temporary — network blips, 429 rate limits,
 * 503 server overloads. Simply retrying after a smart delay often works.
 *
 * But naive retries cause the "Thundering Herd" problem:
 * If 1000 clients all fail at the same time and retry at exactly
 * 1s, 2s, 4s... they create synchronized spikes that make things worse.
 *
 * THE SOLUTION — Three key ingredients:
 *
 * 1. EXPONENTIAL BACKOFF — Wait longer between each retry.
 *    Attempt 1: wait ~1s → Attempt 2: wait ~2s → Attempt 3: wait ~4s
 *    This gives the server breathing room to recover.
 *
 * 2. JITTER — Add randomness to spread out retries.
 *    Instead of all clients retrying at exactly 2s, they retry
 *    at random times between 0-2s, preventing synchronized spikes.
 *
 * 3. MAX RETRIES — Don't retry forever.
 *    Cap attempts to avoid wasting resources on permanent failures.
 *
 * ERROR CLASSIFICATION — Not all errors deserve a retry!
 *   ✅ 429 (Rate Limited), 5xx (Server Error), 529 (Overloaded) → RETRY
 *   ❌ 400 (Bad Request), 401 (Unauthorized), 413 (Too Large) → DON'T RETRY
 */

// ─── Configuration ──────────────────────────────────────────────

export interface RetryConfig {
  /** Maximum number of retry attempts before giving up */
  maxRetries: number;
  /** Initial delay in ms before the first retry (doubles each attempt) */
  baseDelayMs: number;
  /** Maximum delay cap in ms — prevents absurdly long waits */
  maxDelayMs: number;
  /**
   * Jitter strategy to prevent thundering herd:
   * - 'full':         delay = random(0, exponentialDelay)
   * - 'equal':        delay = exponentialDelay/2 + random(0, exponentialDelay/2)
   * - 'decorrelated': delay = random(baseDelay, previousDelay * 3)  ← AWS recommended
   */
  jitterStrategy: "full" | "equal" | "decorrelated";
}

/** Default retry configuration — sensible defaults for most API calls */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterStrategy: "decorrelated",
};

/** Metadata about a retry attempt — useful for logging and monitoring */
export interface RetryAttemptInfo {
  attempt: number;
  delayMs: number;
  error: Error;
}

// ─── Error Classification ───────────────────────────────────────

/**
 * Determines if an error is worth retrying.
 *
 * REAL-WORLD RULE OF THUMB:
 * - Server errors (5xx) → Usually transient → retry
 * - Rate limits  (429)  → Definitely transient → retry with backoff
 * - Client errors (4xx) → Your fault → fix the code, don't retry
 *
 * @param error - The error to classify
 * @returns true if the error is transient and worth retrying
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // These status codes indicate transient server-side issues — RETRY
  const retryablePatterns = [
    "429", // Too Many Requests — rate limited
    "500", // Internal Server Error
    "502", // Bad Gateway
    "503", // Service Unavailable
    "529", // Site Overloaded
    "econnreset", // Connection reset by peer
    "etimedout", // Connection timed out
    "enotfound", // DNS failure (might be transient)
    "socket hang up", // Connection dropped mid-request
    "network", // Generic network error
    "timeout", // Operation timed out
    "fetch failed", // Fetch API failure
  ];

  // These are permanent errors — retrying won't help — FIX REQUIRED
  const nonRetryablePatterns = [
    "400", // Bad Request — malformed input
    "401", // Unauthorized — invalid API key
    "403", // Forbidden — insufficient permissions
    "404", // Not Found — wrong endpoint
    "413", // Payload Too Large — reduce input size
  ];

  // Check non-retryable first (they're more specific)
  if (nonRetryablePatterns.some((pattern) => message.includes(pattern))) {
    return false;
  }

  return retryablePatterns.some((pattern) => message.includes(pattern));
}

// ─── Delay Calculation with Jitter ──────────────────────────────

/**
 * Calculates the delay before the next retry attempt.
 *
 * EXPONENTIAL BACKOFF formula:
 *   baseDelay × 2^attempt = 1s, 2s, 4s, 8s, 16s...
 *
 * Raw exponential backoff has a flaw: if 100 clients all start at the
 * same time, they ALL retry at 1s, 2s, 4s... (Thundering Herd!)
 *
 * JITTER STRATEGIES solve this by adding randomness:
 *
 * ┌─────────────────┬──────────────────────────────────────────────┐
 * │ Full Jitter     │ random(0, base × 2^attempt)                 │
 * │                 │ Most spread out, but may retry very quickly  │
 * ├─────────────────┼──────────────────────────────────────────────┤
 * │ Equal Jitter    │ base×2^attempt/2 + random(0, base×2^attempt/2) │
 * │                 │ Guaranteed minimum wait + randomness         │
 * ├─────────────────┼──────────────────────────────────────────────┤
 * │ Decorrelated    │ random(base, previousDelay × 3)             │
 * │ (Recommended)   │ Best for preventing correlated retry storms  │
 * └─────────────────┴──────────────────────────────────────────────┘
 */
function calculateDelay(
  attempt: number,
  config: RetryConfig,
  previousDelay?: number
): number {
  // Base exponential delay: 1000 × 2^0 = 1s, 1000 × 2^1 = 2s, 1000 × 2^2 = 4s...
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);
  let delay: number;

  switch (config.jitterStrategy) {
    case "full":
      // Full jitter: completely random between 0 and the exponential ceiling
      // Pros: maximum spread  |  Cons: sometimes retries very fast
      delay = Math.random() * exponentialDelay;
      break;

    case "equal":
      // Equal jitter: half deterministic + half random
      // Guarantees at least half the exponential wait
      const half = exponentialDelay / 2;
      delay = half + Math.random() * half;
      break;

    case "decorrelated":
      // Decorrelated jitter: based on PREVIOUS delay, not attempt number
      // Each retry's delay is independent of other clients' delays
      // This is the AWS-recommended strategy for preventing correlated spikes
      const prev = previousDelay ?? config.baseDelayMs;
      delay =
        Math.random() * (prev * 3 - config.baseDelayMs) + config.baseDelayMs;
      break;
  }

  // Cap the delay to prevent waiting hours on high attempt counts
  return Math.min(delay, config.maxDelayMs);
}

// ─── Main Retry Executor ────────────────────────────────────────

/**
 * Executes an async operation with automatic retry on transient failures.
 *
 * This is the main function you'd use in production:
 * - Automatically retries on transient failures (429, 5xx, network errors)
 * - Uses exponential backoff with jitter to prevent thundering herd
 * - Classifies errors to avoid wasting retries on permanent failures
 * - Calls onRetry callback for logging/monitoring
 *
 * @param operation - The async operation to execute
 * @param config    - Retry configuration (delays, max retries, jitter strategy)
 * @param onRetry   - Optional callback fired before each retry (for logging)
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted
 *
 * @example
 * const result = await executeWithRetry(
 *   () => callGeminiAPI(prompt),
 *   { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, jitterStrategy: 'decorrelated' },
 *   (info) => console.log(`Retry ${info.attempt}/${3}, waiting ${info.delayMs}ms`)
 * );
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (info: RetryAttemptInfo) => void
): Promise<T> {
  let lastError: Error;
  let previousDelay: number | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      // Try the operation — if it succeeds, we're done!
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // If this was our last attempt, stop trying
      if (attempt === config.maxRetries) {
        break;
      }

      // Don't waste retries on permanent errors (400, 401, 413, etc.)
      if (!isRetryableError(lastError)) {
        throw lastError;
      }

      // Calculate how long to wait, using jitter to prevent thundering herd
      const delayMs = calculateDelay(attempt, config, previousDelay);
      previousDelay = delayMs;

      // Notify the caller about the retry (useful for logging/UI)
      if (onRetry) {
        onRetry({ attempt: attempt + 1, delayMs, error: lastError });
      }

      // Wait before the next attempt
      await sleep(delayMs);
    }
  }

  // All retries exhausted — throw the last error
  throw lastError!;
}

// ─── Utility ────────────────────────────────────────────────────

/** Simple promise-based sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
