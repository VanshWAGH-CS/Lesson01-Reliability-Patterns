/**
 * ============================================================
 * LAYER 2: Conversation-Level Defense
 * ============================================================
 *
 * While Layer 1 (Tool Level) protects individual API calls,
 * Layer 2 protects the CONVERSATION as a whole. It guards against:
 *
 * 1. RUNAWAY TOOL CALLS — An LLM agent might call tools in a loop.
 *    Layer 2 caps the number of tool calls per conversational turn
 *    to prevent infinite loops.
 *
 * 2. TOKEN BUDGET — LLM APIs charge by tokens. Layer 2 tracks
 *    cumulative token usage and stops when the session budget is
 *    exhausted, preventing surprise bills.
 *
 * 3. CALL DEDUPLICATION — If the same message is sent twice within
 *    a short window (e.g., user double-clicked), Layer 2 detects
 *    the duplicate and prevents a wasted API call.
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │              CONVERSATION GUARD                      │
 *   │                                                      │
 *   │  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
 *   │  │ Tool Call Cap │  │ Token Budget │  │  Dedup    │ │
 *   │  │  5 per turn   │  │  100K/session│  │  60s window│ │
 *   │  └──────────────┘  └──────────────┘  └───────────┘ │
 *   │                                                      │
 *   │  message ──► dedup check ──► budget check ──►        │
 *   │                tool call check ──► proceed / reject  │
 *   └─────────────────────────────────────────────────────┘
 */

import { createHash } from "crypto";

// ─── Configuration ──────────────────────────────────────────────

export interface ConversationGuardConfig {
  /** Maximum tool calls allowed per conversational turn */
  maxToolCallsPerTurn: number;
  /** Total token budget for the entire session */
  tokenBudgetPerSession: number;
  /** Enable deduplication of identical messages */
  enableDeduplication: boolean;
  /** Time window (ms) to consider messages as duplicates */
  deduplicationWindowMs: number;
}

/** Sensible defaults for a chatbot session */
export const DEFAULT_CONVERSATION_CONFIG: ConversationGuardConfig = {
  maxToolCallsPerTurn: 5, // Max 5 API calls per user message
  tokenBudgetPerSession: 100000, // ~100K tokens per session
  enableDeduplication: true, // Detect duplicate messages
  deduplicationWindowMs: 60000, // Within 60 seconds
};

/** Status snapshot for monitoring */
export interface ConversationStatus {
  toolCallsThisTurn: number;
  maxToolCallsPerTurn: number;
  totalToolCalls: number;
  totalTokensUsed: number;
  tokenBudget: number;
  deduplicationEntries: number;
}

// ─── Custom Errors ──────────────────────────────────────────────

/** Thrown when max tool calls per turn is exceeded */
export class ToolCallLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCallLimitError";
  }
}

/** Thrown when the session token budget is exhausted */
export class TokenBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenBudgetExceededError";
  }
}

// ─── Conversation Guard Implementation ──────────────────────────

export class ConversationGuard {
  private toolCallsThisTurn: number = 0;
  private totalTokensUsed: number = 0;
  private totalToolCalls: number = 0;
  /** Map of message hash → timestamp for deduplication */
  private recentCalls: Map<string, number> = new Map();

  constructor(
    private config: ConversationGuardConfig = DEFAULT_CONVERSATION_CONFIG
  ) {}

  /**
   * Check and increment the tool call counter for this turn.
   *
   * WHY: LLM agents can enter loops where they call the same tool
   * repeatedly. Capping calls per turn prevents runaway behavior.
   *
   * @throws ToolCallLimitError if the limit is exceeded
   */
  checkToolCallLimit(): void {
    if (this.toolCallsThisTurn >= this.config.maxToolCallsPerTurn) {
      throw new ToolCallLimitError(
        `Max tool calls per turn (${this.config.maxToolCallsPerTurn}) exceeded. ` +
          `Send a new message to reset the counter.`
      );
    }
    this.toolCallsThisTurn++;
    this.totalToolCalls++;
  }

  /**
   * Check if the token budget can accommodate the estimated usage.
   *
   * WHY: Without a budget, a long conversation could use millions
   * of tokens and result in unexpected costs. This is your guardrail.
   *
   * @param estimatedTokens - Estimated tokens for this request + response
   * @throws TokenBudgetExceededError if budget would be exceeded
   */
  checkTokenBudget(estimatedTokens: number): void {
    if (
      this.totalTokensUsed + estimatedTokens >
      this.config.tokenBudgetPerSession
    ) {
      throw new TokenBudgetExceededError(
        `Session token budget (${this.config.tokenBudgetPerSession.toLocaleString()}) would be exceeded. ` +
          `Used: ${this.totalTokensUsed.toLocaleString()}, Requested: ${estimatedTokens.toLocaleString()}. ` +
          `Use /reset to start a new session.`
      );
    }
  }

  /**
   * Track actual token usage after a successful API call.
   *
   * @param tokens - Number of tokens used
   */
  trackTokenUsage(tokens: number): void {
    this.totalTokensUsed += tokens;
  }

  /**
   * Check if a message is a duplicate (sent recently).
   *
   * WHY: Users might double-click send, or a retry might re-send
   * the same message. Deduplication prevents wasted API calls.
   *
   * Implementation: Hash the message and check against a time-windowed map.
   *
   * @param input - The message to check
   * @returns true if this message was sent recently (duplicate)
   */
  isDuplicate(input: string): boolean {
    if (!this.config.enableDeduplication) return false;

    // Hash the message for efficient comparison
    const hash = createHash("md5").update(input).digest("hex");
    const now = Date.now();

    // Clean expired entries (outside the dedup window)
    for (const [key, timestamp] of this.recentCalls) {
      if (now - timestamp > this.config.deduplicationWindowMs) {
        this.recentCalls.delete(key);
      }
    }

    // Check for duplicate
    if (this.recentCalls.has(hash)) {
      return true; // This exact message was sent recently
    }

    // Record this message for future dedup checks
    this.recentCalls.set(hash, now);
    return false;
  }

  /**
   * Reset the per-turn counter.
   * Called at the start of each new user message.
   */
  resetTurn(): void {
    this.toolCallsThisTurn = 0;
  }

  /**
   * Reset the entire session.
   * Called when user explicitly resets the conversation.
   */
  resetSession(): void {
    this.toolCallsThisTurn = 0;
    this.totalTokensUsed = 0;
    this.totalToolCalls = 0;
    this.recentCalls.clear();
  }

  /** Get a status snapshot for monitoring/display */
  getStatus(): ConversationStatus {
    return {
      toolCallsThisTurn: this.toolCallsThisTurn,
      maxToolCallsPerTurn: this.config.maxToolCallsPerTurn,
      totalToolCalls: this.totalToolCalls,
      totalTokensUsed: this.totalTokensUsed,
      tokenBudget: this.config.tokenBudgetPerSession,
      deduplicationEntries: this.recentCalls.size,
    };
  }
}
