/**
 * ============================================================
 * LAYER 3: Orchestration-Level Defense
 * ============================================================
 *
 * While Layer 1 protects individual calls and Layer 2 protects
 * the conversation, Layer 3 protects the SYSTEM as a whole.
 *
 * TWO KEY MECHANISMS:
 *
 * 1. CASCADE DETECTION — When failures start cascading
 *    across multiple requests in a short time window, it signals
 *    a systemic issue (not just a transient blip). Layer 3 detects
 *    this pattern and can trigger protective mode.
 *
 *    Normal:    ✅ ✅ ❌ ✅ ✅ ✅ ❌ ✅    ← occasional failures, OK
 *    Cascade:   ✅ ❌ ❌ ❌ ❌ ❌ ❌ ❌    ← rapid consecutive failures!
 *
 * 2. DEADLINE PROPAGATION — Every operation chain gets a deadline.
 *    If the total time for all retries, queuing, and processing
 *    exceeds the deadline, the operation is aborted. This prevents
 *    "zombie requests" that linger in the system long after the
 *    user has given up waiting.
 *
 *    ┌─────────────────── Deadline: 60s ──────────────────┐
 *    │                                                     │
 *    │  Rate Limit  → Retry 1 → Retry 2 → Retry 3         │
 *    │    2s wait      1s fail   2s fail   ← 55s remain    │
 *    │                                                     │
 *    │  If we're past 60s total → ABORT, don't keep trying │
 *    └─────────────────────────────────────────────────────┘
 */

// ─── Configuration ──────────────────────────────────────────────

export interface OrchestrationConfig {
  /** Number of failures within the window to trigger cascade alert */
  cascadeThreshold: number;
  /** Time window (ms) for cascade detection */
  cascadeWindowMs: number;
  /** Default deadline (ms) for entire operation chains */
  defaultDeadlineMs: number;
}

/** Sensible defaults */
export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfig = {
  cascadeThreshold: 3, // 3 failures in the window = cascade
  cascadeWindowMs: 60000, // 60-second sliding window
  defaultDeadlineMs: 60000, // 60-second deadline per operation chain
};

// ─── Deadline Context ───────────────────────────────────────────

/**
 * A deadline context tracks the time boundary for an operation chain.
 *
 * Pass this through your call stack so each layer can check:
 * "Is there still time left, or should I give up?"
 *
 * This prevents wasting resources on requests that have already
 * exceeded the user's patience threshold.
 */
export interface DeadlineContext {
  /** The absolute timestamp when the deadline expires */
  deadline: number;
  /** How many milliseconds remain until the deadline */
  remainingMs: () => number;
  /** Has the deadline already passed? */
  isExpired: () => boolean;
}

/** Status snapshot for monitoring */
export interface OrchestrationStatus {
  cascadeDetected: boolean;
  recentFailures: number;
  cascadeThreshold: number;
  cascadeWindowMs: number;
  totalCascades: number;
}

// ─── Orchestration Guard Implementation ─────────────────────────

export class OrchestrationGuard {
  /** Timestamps of recent failures (sliding window) */
  private failureTimestamps: number[] = [];
  /** Whether a cascade is currently detected */
  private cascadeDetected: boolean = false;
  /** Total number of cascade events detected in this session */
  private totalCascades: number = 0;

  constructor(
    private config: OrchestrationConfig = DEFAULT_ORCHESTRATION_CONFIG
  ) {}

  /**
   * Create a deadline context for an operation chain.
   *
   * The deadline is an absolute timestamp. All layers in the chain
   * can check `isExpired()` to decide whether to continue or abort.
   *
   * @param timeoutMs - Custom timeout, or uses default
   * @returns A DeadlineContext with helper methods
   *
   * @example
   * const deadline = guard.createDeadlineContext(30000);
   * // ... later, in a retry loop:
   * if (deadline.isExpired()) {
   *   throw new Error('Deadline exceeded, aborting');
   * }
   */
  createDeadlineContext(timeoutMs?: number): DeadlineContext {
    const deadline =
      Date.now() + (timeoutMs ?? this.config.defaultDeadlineMs);

    return {
      deadline,
      remainingMs: () => Math.max(0, deadline - Date.now()),
      isExpired: () => Date.now() >= deadline,
    };
  }

  /**
   * Record a failure for cascade detection.
   *
   * Adds the current timestamp to the sliding window and checks
   * if the number of recent failures exceeds the cascade threshold.
   *
   * CASCADE DETECTION ALGORITHM:
   * 1. Add current timestamp to failure list
   * 2. Remove failures older than cascadeWindowMs
   * 3. If count >= threshold → CASCADE DETECTED
   *
   * When a cascade is detected, the system should enter protective
   * mode (e.g., reject new requests, alert operators).
   */
  recordFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);

    // Prune failures outside the sliding window
    this.failureTimestamps = this.failureTimestamps.filter(
      (ts) => now - ts <= this.config.cascadeWindowMs
    );

    // Check if we've crossed the cascade threshold
    if (this.failureTimestamps.length >= this.config.cascadeThreshold) {
      if (!this.cascadeDetected) {
        this.cascadeDetected = true;
        this.totalCascades++;
      }
    } else {
      this.cascadeDetected = false;
    }
  }

  /**
   * Check if the system is currently experiencing a cascade failure.
   *
   * Re-evaluates based on the current sliding window to account
   * for failures that have aged out.
   *
   * @returns true if cascade threshold is exceeded
   */
  isCascading(): boolean {
    const now = Date.now();

    // Prune old failures
    this.failureTimestamps = this.failureTimestamps.filter(
      (ts) => now - ts <= this.config.cascadeWindowMs
    );

    this.cascadeDetected =
      this.failureTimestamps.length >= this.config.cascadeThreshold;
    return this.cascadeDetected;
  }

  /**
   * Reset cascade detection state.
   * Called when the user resets the session.
   */
  reset(): void {
    this.failureTimestamps = [];
    this.cascadeDetected = false;
  }

  /** Get a status snapshot for monitoring/display */
  getStatus(): OrchestrationStatus {
    return {
      cascadeDetected: this.cascadeDetected,
      recentFailures: this.failureTimestamps.length,
      cascadeThreshold: this.config.cascadeThreshold,
      cascadeWindowMs: this.config.cascadeWindowMs,
      totalCascades: this.totalCascades,
    };
  }
}
