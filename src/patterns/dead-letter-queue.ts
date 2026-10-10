/**
 * ============================================================
 * RELIABILITY PATTERN: Dead Letter Queue (DLQ)
 * ============================================================
 *
 * WHY THIS MATTERS:
 * When a message/request fails after all retries, you have two options:
 *   1. Discard it silently (bad — data loss, no visibility)
 *   2. Save it to a Dead Letter Queue for inspection and replay (good!)
 *
 * A DLQ captures messages that couldn't be processed, along with
 * the error details, so you can:
 *   - Debug why they failed
 *   - Fix the root cause
 *   - Replay them once the issue is resolved
 *
 * REAL-WORLD ANALOGY:
 * At the post office, if a letter can't be delivered (wrong address,
 * recipient moved, etc.), it goes to the "dead letter office" where
 * postal workers try to figure out where it should go. Your failed
 * messages get the same treatment.
 *
 * ARCHITECTURE:
 *
 *   Request ──► [Retry Layer] ──► Success ──► ✅ Response
 *                    │
 *                    │ all retries failed
 *                    ▼
 *              ┌─────────────┐
 *              │  Dead Letter │
 *              │    Queue     │
 *              │              │
 *              │  [msg1] 💀   │ ← inspect with /dlq
 *              │  [msg2] 💀   │ ← replay when ready
 *              │  [msg3] 💀   │ ← clear when resolved
 *              └─────────────┘
 *
 * IN THIS PROJECT:
 * When a chat message fails (after retries, circuit breaker, etc.),
 * it's saved to the DLQ. The user can inspect failed messages with
 * the /dlq command and understand what went wrong.
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * A single dead letter — a failed message with metadata.
 * Contains everything you need to debug and replay.
 */
export interface DeadLetter {
  /** Unique identifier for this dead letter */
  id: string;
  /** The original message that failed */
  message: string;
  /** The error message from the last failure */
  error: string;
  /** When the failure occurred */
  timestamp: Date;
  /** How many times we've tried to replay this message */
  retryCount: number;
  /** Additional context (e.g., which pattern failed, session info) */
  metadata: Record<string, unknown>;
}

/** Compact status info for display */
export interface DLQStatus {
  size: number;
  messages: Array<{
    id: string;
    preview: string;
    error: string;
    retryCount: number;
    timestamp: string;
  }>;
}

// ─── Dead Letter Queue Implementation ───────────────────────────

export class DeadLetterQueue {
  private queue: DeadLetter[] = [];
  private idCounter: number = 0;

  /**
   * Add a failed message to the dead letter queue.
   *
   * Called when ALL retry attempts have been exhausted and the
   * circuit breaker can't help. The message is preserved for
   * later inspection or replay.
   *
   * @param message  - The original user message that failed
   * @param error    - The error that caused the failure
   * @param metadata - Additional context for debugging
   */
  add(
    message: string,
    error: Error,
    metadata: Record<string, unknown> = {}
  ): void {
    this.queue.push({
      id: `dlq-${++this.idCounter}`,
      message,
      error: error.message,
      timestamp: new Date(),
      retryCount: 0,
      metadata,
    });
  }

  /**
   * Get all dead letters (returns a copy to prevent external mutation).
   */
  getAll(): DeadLetter[] {
    return [...this.queue];
  }

  /**
   * Get a specific dead letter by ID.
   */
  get(id: string): DeadLetter | undefined {
    return this.queue.find((item) => item.id === id);
  }

  /**
   * Replay a dead letter — try processing it again.
   *
   * This is used when the root cause has been fixed (e.g., API is
   * back up, rate limit reset, etc.) and you want to retry the
   * failed message.
   *
   * If replay succeeds → message is removed from the DLQ.
   * If replay fails → message stays with updated error and retry count.
   *
   * @param id      - The dead letter ID to replay
   * @param handler - The function to process the message
   * @returns The result from the handler
   */
  async replay(
    id: string,
    handler: (message: string) => Promise<string>
  ): Promise<string> {
    const item = this.queue.find((i) => i.id === id);
    if (!item) {
      throw new Error(`Dead letter '${id}' not found`);
    }

    item.retryCount++;

    try {
      const result = await handler(item.message);
      // Success! Remove from DLQ — it's been processed
      this.queue = this.queue.filter((i) => i.id !== id);
      return result;
    } catch (error) {
      // Still failing — update the error and keep in DLQ
      item.error =
        error instanceof Error ? error.message : String(error);
      item.timestamp = new Date();
      throw error;
    }
  }

  /**
   * Clear all dead letters.
   * Use after mass-resolving issues or when starting fresh.
   */
  clear(): void {
    this.queue = [];
  }

  /** Get the number of messages in the DLQ */
  get size(): number {
    return this.queue.length;
  }

  /** Get a compact status snapshot for display */
  getStatus(): DLQStatus {
    return {
      size: this.queue.length,
      messages: this.queue.map((item) => ({
        id: item.id,
        preview:
          item.message.substring(0, 50) +
          (item.message.length > 50 ? "..." : ""),
        error: item.error,
        retryCount: item.retryCount,
        timestamp: item.timestamp.toISOString(),
      })),
    };
  }
}
