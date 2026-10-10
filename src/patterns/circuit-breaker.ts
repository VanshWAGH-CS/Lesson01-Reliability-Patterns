/**
 * ============================================================
 * RELIABILITY PATTERN: Circuit Breaker
 * ============================================================
 *
 * ANALOGY:
 * Just like an electrical circuit breaker in your house trips when
 * there's too much current (preventing a fire), a software circuit
 * breaker trips when there are too many failures (preventing
 * cascade failures across your system).
 *
 * THE THREE STATES:
 *
 *   ┌──────────┐  failures >= threshold   ┌──────────┐
 *   │  CLOSED  │ ────────────────────────► │   OPEN   │
 *   │ (normal) │                           │ (reject) │
 *   └────┬─────┘                           └────┬─────┘
 *        ▲                                      │
 *        │ probe succeeds              timeout expires
 *        │                                      │
 *   ┌────┴───────┐                              ▼
 *   │ HALF-OPEN  │ ◄───────────────────────────-┘
 *   │  (probe)   │
 *   └────────────┘
 *
 * CLOSED:    Normal operation. Requests pass through. Failures are counted.
 *            When failures hit the threshold → switch to OPEN.
 *
 * OPEN:      Too many failures! All requests are REJECTED IMMEDIATELY
 *            without calling the downstream service (fast-fail).
 *            After a recovery timeout → switch to HALF-OPEN.
 *
 * HALF-OPEN: Let ONE probe request through to test if the service recovered.
 *            If probe succeeds → back to CLOSED (healthy again!)
 *            If probe fails   → back to OPEN (still broken)
 *
 * WHY NOT JUST RETRY?
 * If a service is down, retrying hammers it with more requests,
 * making recovery harder. Circuit breaker gives it breathing room
 * by failing fast and checking periodically.
 *
 * KNOWN GOTCHAS:
 * - Granularity Mismatch: Should you have one circuit per service or per endpoint?
 * - Non-deterministic failures: Random errors might trip the circuit unnecessarily
 * - Contextual accumulation: Past failures may not predict future behavior
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * The three states of a circuit breaker.
 * Think of it like a traffic light for your service calls.
 */
export enum CircuitState {
  /** Green light — requests flow normally, failures are counted */
  CLOSED = "CLOSED",
  /** Red light — all requests rejected immediately (fast-fail) */
  OPEN = "OPEN",
  /** Yellow light — allow one probe request to test recovery */
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerConfig {
  /** How many failures before tripping the circuit (CLOSED → OPEN) */
  failureThreshold: number;
  /** How long to wait (ms) before testing recovery (OPEN → HALF_OPEN) */
  recoveryTimeoutMs: number;
  /** How many probe requests to allow in HALF_OPEN state */
  halfOpenMaxAttempts: number;
}

/** Sensible defaults for API protection */
export const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5, // Trip after 5 consecutive failures
  recoveryTimeoutMs: 30000, // Wait 30s before probing
  halfOpenMaxAttempts: 1, // Allow 1 probe request
};

/** Status snapshot for monitoring and display */
export interface CircuitBreakerStatus {
  state: CircuitState;
  failureCount: number;
  failureThreshold: number;
  successCount: number;
  totalRequests: number;
  recoveryTimeoutMs: number;
  lastFailureTime: number;
}

// ─── Custom Error ───────────────────────────────────────────────

/**
 * Thrown when the circuit is OPEN and requests are being rejected.
 * This is a fast-fail — the downstream service is NOT called.
 */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

// ─── Circuit Breaker Implementation ─────────────────────────────

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private halfOpenAttempts: number = 0;
  private successCount: number = 0;
  private totalRequests: number = 0;

  constructor(private config: CircuitBreakerConfig = DEFAULT_CB_CONFIG) {}

  /**
   * Execute an operation through the circuit breaker.
   *
   * - CLOSED:    Execute normally, count failures
   * - OPEN:      Reject immediately (throw CircuitOpenError)
   * - HALF_OPEN: Allow limited probe requests
   *
   * @param operation - The async operation to protect
   * @returns The result of the operation
   * @throws CircuitOpenError if the circuit is OPEN
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // ── Check if we should transition from OPEN → HALF_OPEN ──
    if (this.state === CircuitState.OPEN) {
      const timeSinceFailure = Date.now() - this.lastFailureTime;

      if (timeSinceFailure >= this.config.recoveryTimeoutMs) {
        // Recovery timeout elapsed — let's probe with a test request
        this.state = CircuitState.HALF_OPEN;
        this.halfOpenAttempts = 0;
      } else {
        // Still in cooldown — reject immediately (fast-fail)
        const remainingSeconds = Math.ceil(
          (this.config.recoveryTimeoutMs - timeSinceFailure) / 1000
        );
        throw new CircuitOpenError(
          `Circuit breaker is OPEN. Recovery in ~${remainingSeconds}s`
        );
      }
    }

    // ── In HALF_OPEN: only allow limited probe requests ──
    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
        throw new CircuitOpenError(
          "Circuit breaker is HALF_OPEN — probe limit reached, waiting for result"
        );
      }
      this.halfOpenAttempts++;
    }

    // ── Execute the operation ──
    try {
      this.totalRequests++;
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Called when an operation succeeds.
   * In HALF_OPEN: probe passed → close the circuit (healthy again!)
   * In CLOSED: decrease failure count (sliding recovery)
   */
  private onSuccess(): void {
    this.successCount++;

    if (this.state === CircuitState.HALF_OPEN) {
      // The probe request succeeded! Service has recovered.
      // Transition: HALF_OPEN → CLOSED
      this.state = CircuitState.CLOSED;
      this.failureCount = 0;
    } else {
      // In CLOSED state: decrease failure count on success
      // This creates a "sliding window" effect — intermittent failures
      // don't accumulate indefinitely
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }

  /**
   * Called when an operation fails.
   * In HALF_OPEN: probe failed → reopen the circuit
   * In CLOSED: increment failure count, trip if threshold reached
   */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      // Probe failed — service is still broken
      // Transition: HALF_OPEN → OPEN
      this.state = CircuitState.OPEN;
    } else if (this.failureCount >= this.config.failureThreshold) {
      // Too many failures — trip the circuit!
      // Transition: CLOSED → OPEN
      this.state = CircuitState.OPEN;
    }
  }

  /** Get the current circuit state */
  getState(): CircuitState {
    return this.state;
  }

  /** Get a full status snapshot (for monitoring dashboards / CLI display) */
  getStatus(): CircuitBreakerStatus {
    return {
      state: this.state,
      failureCount: this.failureCount,
      failureThreshold: this.config.failureThreshold,
      successCount: this.successCount,
      totalRequests: this.totalRequests,
      recoveryTimeoutMs: this.config.recoveryTimeoutMs,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /** Manually reset the circuit to CLOSED state */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenAttempts = 0;
  }
}
