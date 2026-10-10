/**
 * ============================================================
 * Resilient Gemini Client
 * ============================================================
 *
 * This is where everything comes together. The ResilientGeminiClient
 * wraps the Google Gemini API with ALL four layers of defense:
 *
 *   Layer 1: Tool Level      → Rate limit, timeout, retry, circuit breaker, bulkhead
 *   Layer 2: Conversation    → Max calls/turn, token budget, deduplication
 *   Layer 3: Orchestration   → Cascade detection, deadline propagation
 *   Layer 4: Caching         → Response cache as fault tolerance
 *
 * Plus a Dead Letter Queue to capture messages that fail permanently.
 *
 * FLOW:
 *
 *   User Message
 *     │
 *     ▼
 *   [Layer 2] Conversation checks (dedup, budget, call limit)
 *     │
 *     ▼
 *   [Layer 3] Orchestration checks (cascade, deadline)
 *     │
 *     ▼
 *   [Layer 4] Cache check → hit? → return cached response
 *     │ miss
 *     ▼
 *   [Layer 1] Tool-level defense (bulkhead → rate limit → circuit breaker → retry → timeout)
 *     │
 *     ▼
 *   Gemini API call
 *     │
 *     ├─ success → cache response → return
 *     └─ failure → DLQ → try cache fallback → graceful error
 */

import { GoogleGenerativeAI, ChatSession, GenerativeModel } from "@google/generative-ai";
import { ToolLevelDefense } from "./layers/tool-level";
import { ConversationGuard } from "./layers/conversation-level";
import { OrchestrationGuard } from "./layers/orchestration-level";
import { DeadLetterQueue } from "./patterns/dead-letter-queue";

// ─── Configuration ──────────────────────────────────────────────

export interface GeminiClientConfig {
  /** Your Gemini API key */
  apiKey: string;
  /** Model name (default: gemini-3.8-flash — free tier) */
  model?: string;
  /** How long cached responses stay valid (ms) */
  cacheTTLMs?: number;
}

// ─── Cache Entry ────────────────────────────────────────────────

interface CacheEntry {
  response: string;
  timestamp: number;
}

// ─── Resilient Gemini Client ────────────────────────────────────

export class ResilientGeminiClient {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;
  private chat: ChatSession | null = null;

  // ── Reliability Layers (public for status display) ──
  public readonly toolLevel: ToolLevelDefense;
  public readonly conversationGuard: ConversationGuard;
  public readonly orchestrationGuard: OrchestrationGuard;
  public readonly dlq: DeadLetterQueue;

  // ── Layer 4: Response Cache (fault tolerance) ──
  private responseCache: Map<string, CacheEntry> = new Map();
  private cacheTTLMs: number;

  // ── Statistics ──
  private totalMessages: number = 0;
  private cacheHits: number = 0;

  constructor(config: GeminiClientConfig) {
    // Initialize Gemini AI
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.model = this.genAI.getGenerativeModel({
      model: config.model ?? "gemini-3.8-flash",
    });
    this.cacheTTLMs = config.cacheTTLMs ?? 300000; // 5 min default

    // ── Initialize All Reliability Layers ──

    // Layer 1: Tool-level defense with tuned configs
    this.toolLevel = new ToolLevelDefense({
      retry: {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        jitterStrategy: "decorrelated",
      },
      circuitBreaker: {
        failureThreshold: 5,
        recoveryTimeoutMs: 30000,
        halfOpenMaxAttempts: 1,
      },
      bulkhead: {
        maxConcurrent: 3,
        maxQueue: 10,
        queueTimeoutMs: 5000,
      },
      timeoutMs: 30000,
      rateLimiter: {
        maxTokens: 10,
        refillRate: 1,
        refillIntervalMs: 6000, // ~10 requests per minute
      },
    });

    // Layer 2: Conversation-level guard
    this.conversationGuard = new ConversationGuard({
      maxToolCallsPerTurn: 5,
      tokenBudgetPerSession: 100000,
      enableDeduplication: true,
      deduplicationWindowMs: 60000,
    });

    // Layer 3: Orchestration-level guard
    this.orchestrationGuard = new OrchestrationGuard({
      cascadeThreshold: 3,
      cascadeWindowMs: 60000,
      defaultDeadlineMs: 60000,
    });

    // Dead Letter Queue for permanently failed messages
    this.dlq = new DeadLetterQueue();
  }

  /**
   * Send a message through all reliability layers.
   *
   * This is the main entry point. It passes through:
   * Layer 2 → Layer 3 → Layer 4 (cache) → Layer 1 → Gemini API
   *
   * On failure: DLQ capture → cache fallback → graceful error
   *
   * @param message - The user's chat message
   * @returns The bot's response (or a graceful error message)
   */
  async sendMessage(message: string): Promise<string> {
    // ── LAYER 2: Conversation-Level Checks ──

    // Reset the per-turn counter for a fresh turn
    this.conversationGuard.resetTurn();

    // Check for duplicate messages (prevents double-click sends)
    if (this.conversationGuard.isDuplicate(message)) {
      return "⚠️ Duplicate message detected within the last 60s. Please rephrase or wait a moment.";
    }

    // Check tool call limit for this turn
    this.conversationGuard.checkToolCallLimit();

    // Estimate token usage (rough: ~4 chars per token + response buffer)
    const estimatedTokens = Math.ceil(message.length / 4) + 500;
    this.conversationGuard.checkTokenBudget(estimatedTokens);

    // ── LAYER 3: Orchestration-Level Checks ──

    // Check for cascade failures — if the system is melting down, protect it
    if (this.orchestrationGuard.isCascading()) {
      return (
        "⚠️ Cascade failure detected — the system is in protective mode.\n" +
        "Multiple rapid failures suggest a systemic issue. Please wait a moment and try again."
      );
    }

    // Create a deadline for the entire operation chain
    const deadline = this.orchestrationGuard.createDeadlineContext();

    // ── LAYER 4: Cache Check (Fault Tolerance) ──

    const cached = this.getCachedResponse(message);
    if (cached) {
      this.cacheHits++;
      return `📦 [Cached Response]\n${cached}`;
    }

    // ── LAYER 1: Tool-Level Defense → Gemini API Call ──

    try {
      this.totalMessages++;

      const response = await this.toolLevel.execute(async () => {
        // Check deadline before making the API call
        if (deadline.isExpired()) {
          throw new Error("Operation deadline (60s) exceeded — aborting");
        }

        // Initialize or reuse the chat session
        if (!this.chat) {
          this.chat = this.model.startChat({ history: [] });
        }

        // Make the actual Gemini API call
        const result = await this.chat.sendMessage(message);
        return result.response.text();
      });

      // ── Success Path ──

      // Cache the response for fault tolerance (Layer 4)
      this.cacheResponse(message, response);

      // Track token usage in the conversation budget
      this.conversationGuard.trackTokenUsage(estimatedTokens);

      return response;
    } catch (error) {
      // ── Failure Path ──

      const err = error instanceof Error ? error : new Error(String(error));

      // Record the failure for cascade detection (Layer 3)
      this.orchestrationGuard.recordFailure();

      // Save to Dead Letter Queue for later inspection
      this.dlq.add(message, err, {
        totalMessages: this.totalMessages,
        timestamp: new Date().toISOString(),
      });

      // Try to serve a cached response as fallback (graceful degradation)
      const fallbackCache = this.getCachedResponse(message);
      if (fallbackCache) {
        return `⚠️ [Error — showing cached response]\n${fallbackCache}`;
      }

      // Last resort: friendly error message
      return (
        `⚠️ Unable to get a response: ${err.message}\n` +
        `The message has been saved to the Dead Letter Queue. Use /dlq to inspect.`
      );
    }
  }

  // ─── Cache Helpers (Layer 4) ──────────────────────────────────

  /**
   * Check the cache for a stored response.
   * Returns undefined if not found or expired.
   */
  private getCachedResponse(message: string): string | undefined {
    const entry = this.responseCache.get(message);
    if (entry && Date.now() - entry.timestamp < this.cacheTTLMs) {
      return entry.response;
    }
    // Clean up expired entry
    if (entry) {
      this.responseCache.delete(message);
    }
    return undefined;
  }

  /** Store a response in the cache */
  private cacheResponse(message: string, response: string): void {
    this.responseCache.set(message, {
      response,
      timestamp: Date.now(),
    });
  }

  // ─── Session Management ───────────────────────────────────────

  /** Reset the entire conversation and all pattern states */
  resetConversation(): void {
    this.chat = null;
    this.conversationGuard.resetSession();
    this.orchestrationGuard.reset();
    this.responseCache.clear();
    this.totalMessages = 0;
    this.cacheHits = 0;
  }

  // ─── Status for CLI Display ───────────────────────────────────

  /** Get a comprehensive status snapshot of all layers */
  getFullStatus() {
    return {
      toolLevel: this.toolLevel.getStatus(),
      conversation: this.conversationGuard.getStatus(),
      orchestration: this.orchestrationGuard.getStatus(),
      dlq: this.dlq.getStatus(),
      cache: {
        size: this.responseCache.size,
        hits: this.cacheHits,
        ttlMs: this.cacheTTLMs,
      },
      stats: {
        totalMessages: this.totalMessages,
        cacheHits: this.cacheHits,
      },
    };
  }
}
