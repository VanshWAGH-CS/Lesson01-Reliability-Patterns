/**
 * ============================================================
 * RELIABILITY PATTERN: Rate Limiter (Token Bucket Algorithm)
 * ============================================================
 *
 * WHY THIS MATTERS:
 * APIs have rate limits. Gemini's free tier allows ~15 requests/minute.
 * If your app exceeds this, you get 429 (Too Many Requests) errors.
 * A rate limiter controls your request rate BEFORE hitting the API,
 * preventing wasted requests and 429 errors proactively.
 *
 * TOKEN BUCKET ALGORITHM:
 * Imagine a bucket that holds tokens. Each request costs one token.
 * Tokens refill at a steady rate. If the bucket is empty, wait.
 *
 *   ┌──────────────────────────────────────────┐
 *   │              TOKEN BUCKET                 │
 *   │                                           │
 *   │  Capacity: 10 tokens                      │
 *   │  Refill:   1 token every 6 seconds        │
 *   │                                           │
 *   │  ┌────┐                                   │
 *   │  │ 🪙 │ ← tokens refill over time         │
 *   │  │ 🪙 │                                   │
 *   │  │ 🪙 │   request arrives                 │
 *   │  │ 🪙 │ ──────────────────►  token? ──► ✅│
 *   │  │ 🪙 │                      empty? ──► ⏳│
 *   │  └────┘                                   │
 *   └──────────────────────────────────────────┘
 *
 * WHY TOKEN BUCKET (vs. other algorithms)?
 * - Allows short bursts (up to maxTokens at once) while enforcing
 *   a long-term average rate
 * - Simple to implement and reason about
 * - Used by AWS, Stripe, Google APIs, and most cloud providers
 *
 * ALTERNATIVES:
 * - Fixed Window:      Simple but has burst-at-boundary issues
 * - Sliding Window:    More precise but more complex
 * - Leaky Bucket:      Strict constant rate, no bursts allowed
 */

// ─── Configuration ──────────────────────────────────────────────

export interface RateLimiterConfig {
  /** Maximum number of tokens in the bucket (burst capacity) */
  maxTokens: number;
  /** Number of tokens added per refill interval */
  refillRate: number;
  /** Time between refills in milliseconds */
  refillIntervalMs: number;
}

/**
 * Default config: 10 requests/minute with burst capacity of 10.
 * This is conservative enough for Gemini's free tier (15 RPM).
 */
export const DEFAULT_RL_CONFIG: RateLimiterConfig = {
  maxTokens: 10, // Can burst up to 10 requests
  refillRate: 1, // Add 1 token per interval
  refillIntervalMs: 6000, // Every 6 seconds (= 10 per minute)
};

/** Status snapshot for monitoring */
export interface RateLimiterStatus {
  availableTokens: number;
  maxTokens: number;
  refillRate: number;
  refillIntervalMs: number;
  totalAcquired: number;
  totalWaited: number;
}

// ─── Custom Error ───────────────────────────────────────────────

/** Thrown when tryAcquire() fails (non-blocking mode) */
export class RateLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitExceededError";
  }
}

// ─── Rate Limiter Implementation ────────────────────────────────

export class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private totalAcquired: number = 0;
  private totalWaited: number = 0;

  constructor(private config: RateLimiterConfig = DEFAULT_RL_CONFIG) {
    // Start with a full bucket
    this.tokens = config.maxTokens;
    this.lastRefillTime = Date.now();
  }

  /**
   * Refill tokens based on elapsed time.
   *
   * This is called lazily (on each acquire attempt) rather than
   * on a timer — more efficient and avoids timer management.
   *
   * Formula: tokensToAdd = floor(elapsed / refillInterval) × refillRate
   * Then cap at maxTokens to prevent overflow.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    const tokensToAdd =
      Math.floor(elapsed / this.config.refillIntervalMs) *
      this.config.refillRate;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.config.maxTokens, this.tokens + tokensToAdd);
      // Only advance lastRefillTime by the intervals we consumed
      // This prevents "losing" partial intervals
      this.lastRefillTime +=
        Math.floor(elapsed / this.config.refillIntervalMs) *
        this.config.refillIntervalMs;
    }
  }

  /**
   * Try to acquire a token without waiting (non-blocking).
   *
   * @returns true if a token was acquired, false if bucket is empty
   */
  tryAcquire(): boolean {
    this.refill();

    if (this.tokens > 0) {
      this.tokens--;
      this.totalAcquired++;
      return true;
    }

    return false;
  }

  /**
   * Acquire a token, waiting if necessary (blocking).
   *
   * If the bucket is empty, this method will wait until a token
   * becomes available (i.e., until the next refill).
   *
   * This is what you'd typically use in production — it automatically
   * throttles your request rate to stay within limits.
   *
   * @returns A promise that resolves when a token is acquired
   */
  async acquire(): Promise<void> {
    if (this.tryAcquire()) {
      return; // Got a token immediately!
    }

    // Bucket is empty — wait for next refill
    this.totalWaited++;

    while (!this.tryAcquire()) {
      // Calculate how long until the next token arrives
      const now = Date.now();
      const elapsed = now - this.lastRefillTime;
      const waitTime = this.config.refillIntervalMs - elapsed;

      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, waitTime))
      );
    }
  }

  /** Get a status snapshot for monitoring/display */
  getStatus(): RateLimiterStatus {
    this.refill(); // Ensure we have the latest count
    return {
      availableTokens: this.tokens,
      maxTokens: this.config.maxTokens,
      refillRate: this.config.refillRate,
      refillIntervalMs: this.config.refillIntervalMs,
      totalAcquired: this.totalAcquired,
      totalWaited: this.totalWaited,
    };
  }
}
