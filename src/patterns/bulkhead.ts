/**
 * ============================================================
 * RELIABILITY PATTERN: Bulkhead (Resource Isolation)
 * ============================================================
 *
 * ANALOGY:
 * In a ship, bulkheads are watertight walls between compartments.
 * If one compartment floods, the bulkhead prevents water from
 * spreading to the rest of the ship — the ship stays afloat.
 *
 * In software, a bulkhead limits the number of concurrent calls
 * to a resource. If one service gets overwhelmed, it can't consume
 * ALL available threads/connections — other services stay healthy.
 *
 * HOW IT WORKS:
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │                  BULKHEAD                        │
 *   │                                                  │
 *   │  Active Slots: [■] [■] [□]    ← max 3 concurrent│
 *   │                                                  │
 *   │  Queue:        [▪] [▪] [▪] [▪] ← overflow queue │
 *   │                                                  │
 *   │  New request → slot available? → execute         │
 *   │              → no slot?        → queue (or reject)│
 *   └──────────────────────────────────────────────────┘
 *
 * REAL-WORLD EXAMPLE:
 * Your app calls 3 external APIs. Without bulkhead, a slow API
 * could consume all 100 of your thread pool threads, leaving
 * none for the other 2 healthy APIs. With bulkhead, each API
 * gets at most 33 threads — the slow one can't starve the others.
 *
 * IMPLEMENTATION:
 * We use a semaphore pattern — a counter that limits concurrency.
 * When max concurrent slots are full, new requests queue up
 * (with a timeout to prevent indefinite waiting).
 */

// ─── Configuration ──────────────────────────────────────────────

export interface BulkheadConfig {
  /** Maximum number of operations that can run simultaneously */
  maxConcurrent: number;
  /** Maximum number of operations waiting in the queue */
  maxQueue: number;
  /** How long a queued operation will wait before being rejected (ms) */
  queueTimeoutMs: number;
}

/** Sensible defaults for a CLI chatbot (low concurrency) */
export const DEFAULT_BULKHEAD_CONFIG: BulkheadConfig = {
  maxConcurrent: 3, // At most 3 API calls running at once
  maxQueue: 10, // Up to 10 waiting in line
  queueTimeoutMs: 5000, // Give up after 5s in queue
};

/** Status snapshot for monitoring */
export interface BulkheadStatus {
  activeCount: number;
  maxConcurrent: number;
  queueLength: number;
  maxQueue: number;
  totalExecuted: number;
  totalRejected: number;
}

// ─── Custom Error ───────────────────────────────────────────────

/**
 * Thrown when the bulkhead is full (all slots occupied AND queue is full).
 * This is a backpressure signal — the system is overloaded.
 */
export class BulkheadFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkheadFullError";
  }
}

// ─── Queue Entry Type ───────────────────────────────────────────

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Bulkhead Implementation ────────────────────────────────────

export class Bulkhead {
  private activeCount: number = 0;
  private queue: QueueEntry[] = [];
  private totalExecuted: number = 0;
  private totalRejected: number = 0;

  constructor(private config: BulkheadConfig = DEFAULT_BULKHEAD_CONFIG) {}

  /**
   * Execute an operation through the bulkhead.
   *
   * Flow:
   * 1. If a slot is available → execute immediately
   * 2. If no slot but queue has room → wait in queue (with timeout)
   * 3. If no slot AND queue is full → reject immediately (BulkheadFullError)
   *
   * @param operation - The async operation to execute
   * @returns The result of the operation
   * @throws BulkheadFullError if all slots and queue are full
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // Try to acquire a slot
    await this.acquire();

    try {
      this.totalExecuted++;
      // Execute the operation in the acquired slot
      return await operation();
    } finally {
      // ALWAYS release the slot, even if the operation throws
      this.release();
    }
  }

  /**
   * Acquire a slot in the bulkhead.
   *
   * This is essentially a semaphore: if a slot is free, take it immediately.
   * If not, queue up and wait (or reject if the queue is also full).
   */
  private acquire(): Promise<void> {
    // Fast path: slot available → take it immediately
    if (this.activeCount < this.config.maxConcurrent) {
      this.activeCount++;
      return Promise.resolve();
    }

    // No slots available — can we queue?
    if (this.queue.length >= this.config.maxQueue) {
      // Queue is also full → reject (backpressure)
      this.totalRejected++;
      return Promise.reject(
        new BulkheadFullError(
          `Bulkhead full: ${this.activeCount}/${this.config.maxConcurrent} active, ` +
            `${this.queue.length}/${this.config.maxQueue} queued`
        )
      );
    }

    // Queue up and wait for a slot to open
    return new Promise<void>((resolve, reject) => {
      // Set a timeout — don't wait forever in the queue
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((entry) => entry.timer === timer);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          this.totalRejected++;
          reject(
            new BulkheadFullError(
              `Queue wait timeout exceeded (${this.config.queueTimeoutMs}ms)`
            )
          );
        }
      }, this.config.queueTimeoutMs);

      this.queue.push({
        resolve: () => {
          clearTimeout(timer);
          this.activeCount++;
          resolve();
        },
        reject,
        timer,
      });
    });
  }

  /**
   * Release a slot back to the bulkhead.
   * If anyone is waiting in the queue, let them in.
   */
  private release(): void {
    this.activeCount--;

    // If someone is waiting in the queue, give them the slot
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.resolve();
    }
  }

  /** Get a status snapshot for monitoring/display */
  getStatus(): BulkheadStatus {
    return {
      activeCount: this.activeCount,
      maxConcurrent: this.config.maxConcurrent,
      queueLength: this.queue.length,
      maxQueue: this.config.maxQueue,
      totalExecuted: this.totalExecuted,
      totalRejected: this.totalRejected,
    };
  }
}
