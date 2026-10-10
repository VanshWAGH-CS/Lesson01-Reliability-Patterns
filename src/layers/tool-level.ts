/**
 * ============================================================
 * LAYER 1: Tool-Level Defense
 * ============================================================
 *
 * This is the innermost defense layer — it wraps every individual
 * API call (tool invocation) with multiple reliability patterns
 * composed in the correct order.
 *
 * COMPOSITION ORDER (outermost → innermost):
 *
 *   Bulkhead          ← Limits concurrent API calls
 *     → Rate Limiter  ← Throttles request rate
 *       → Circuit Breaker  ← Fails fast if service is down
 *         → Retry           ← Retries transient failures
 *           → Timeout       ← Time-bounds each attempt
 *             → API Call    ← The actual Gemini API request
 *
 * WHY THIS ORDER?
 *
 * 1. BULKHEAD first: Prevents too many concurrent requests from
 *    consuming all resources. Even if everything else fails,
 *    the bulkhead ensures resource isolation.
 *
 * 2. RATE LIMITER second: Within the bulkhead slot, throttle the
 *    request rate to stay within API limits (Gemini free: 15 RPM).
 *
 * 3. CIRCUIT BREAKER third: Before attempting retries, check if the
 *    service is known to be down. If circuit is OPEN → fail fast
 *    without wasting time on retries.
 *
 * 4. RETRY fourth: If the circuit is closed, retry transient failures
 *    with exponential backoff and jitter.
 *
 * 5. TIMEOUT innermost: Each individual retry attempt has its own
 *    timeout. This prevents a single hung request from consuming
 *    the entire retry budget.
 */

import {
  executeWithRetry,
  RetryConfig,
  DEFAULT_RETRY_CONFIG,
  RetryAttemptInfo,
} from "../patterns/retry";
import {
  CircuitBreaker,
  CircuitBreakerConfig,
  DEFAULT_CB_CONFIG,
} from "../patterns/circuit-breaker";
import {
  Bulkhead,
  BulkheadConfig,
  DEFAULT_BULKHEAD_CONFIG,
} from "../patterns/bulkhead";
import { executeWithTimeout } from "../patterns/timeout";
import {
  RateLimiter,
  RateLimiterConfig,
  DEFAULT_RL_CONFIG,
} from "../patterns/rate-limiter";

// ─── Configuration ──────────────────────────────────────────────

export interface ToolLevelConfig {
  retry: RetryConfig;
  circuitBreaker: CircuitBreakerConfig;
  bulkhead: BulkheadConfig;
  timeoutMs: number;
  rateLimiter: RateLimiterConfig;
}

// ─── Tool-Level Defense ─────────────────────────────────────────

export class ToolLevelDefense {
  private circuitBreaker: CircuitBreaker;
  private bulkhead: Bulkhead;
  private rateLimiter: RateLimiter;
  private retryConfig: RetryConfig;
  private timeoutMs: number;

  /** Event callback — set this to receive live pattern activity logs */
  public onEvent?: (event: string) => void;

  constructor(config?: Partial<ToolLevelConfig>) {
    this.circuitBreaker = new CircuitBreaker(config?.circuitBreaker ?? DEFAULT_CB_CONFIG);
    this.bulkhead = new Bulkhead(config?.bulkhead ?? DEFAULT_BULKHEAD_CONFIG);
    this.rateLimiter = new RateLimiter(config?.rateLimiter ?? DEFAULT_RL_CONFIG);
    this.retryConfig = config?.retry ?? DEFAULT_RETRY_CONFIG;
    this.timeoutMs = config?.timeoutMs ?? 30000;
  }

  /**
   * Execute an operation through ALL tool-level defenses.
   *
   * The operation passes through 5 layers:
   * Bulkhead → Rate Limiter → Circuit Breaker → Retry → Timeout → Operation
   *
   * @param operation - The async operation to protect
   * @returns The result of the operation
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // ── Layer 1.1: BULKHEAD — limit concurrent operations ──
    this.emit("🧱 [Bulkhead] Acquiring execution slot...");

    return this.bulkhead.execute(async () => {
      const blStatus = this.bulkhead.getStatus();
      this.emit(
        `🧱 [Bulkhead] Slot acquired (${blStatus.activeCount}/${blStatus.maxConcurrent} active)`
      );

      // ── Layer 1.2: RATE LIMITER — throttle request rate ──
      this.emit("⚡ [Rate Limiter] Acquiring token...");
      await this.rateLimiter.acquire();
      const rlStatus = this.rateLimiter.getStatus();
      this.emit(
        `⚡ [Rate Limiter] Token acquired (${rlStatus.availableTokens}/${rlStatus.maxTokens} remaining)`
      );

      // ── Layer 1.3: CIRCUIT BREAKER — fail fast if service is down ──
      const cbState = this.circuitBreaker.getState();
      this.emit(`🔌 [Circuit Breaker] State: ${cbState}`);

      return this.circuitBreaker.execute(async () => {
        // ── Layer 1.4: RETRY — handle transient failures ──
        return executeWithRetry(
          async () => {
            // ── Layer 1.5: TIMEOUT — bound each individual attempt ──
            this.emit(`⏱️  [Timeout] ${this.timeoutMs / 1000}s deadline set`);

            return executeWithTimeout(operation, this.timeoutMs);
          },
          this.retryConfig,
          (info: RetryAttemptInfo) => {
            this.emit(
              `🔄 [Retry] Attempt ${info.attempt}/${this.retryConfig.maxRetries} ` +
                `after ${Math.round(info.delayMs)}ms delay — ${info.error.message.substring(0, 80)}`
            );
          }
        );
      });
    });
  }

  /** Emit a pattern activity event (for live CLI logging) */
  private emit(message: string): void {
    if (this.onEvent) {
      this.onEvent(message);
    }
  }

  /** Get a status snapshot of all tool-level patterns */
  getStatus() {
    return {
      circuitBreaker: this.circuitBreaker.getStatus(),
      bulkhead: this.bulkhead.getStatus(),
      rateLimiter: this.rateLimiter.getStatus(),
      retry: this.retryConfig,
      timeoutMs: this.timeoutMs,
    };
  }

  /** Reset the circuit breaker to CLOSED state */
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }
}
