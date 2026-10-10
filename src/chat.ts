/**
 * ============================================================
 * Chat Application — Terminal-based CLI Interface
 * ============================================================
 *
 * The interactive chat loop that ties everything together.
 * Provides commands to inspect reliability pattern states,
 * view the dead letter queue, and monitor session statistics.
 *
 * COMMANDS:
 *   /status  — View all reliability pattern states
 *   /stats   — View conversation statistics
 *   /dlq     — View dead letter queue
 *   /reset   — Reset conversation and all patterns
 *   /help    — Show command list
 *   /quit    — Exit the application
 */

import * as readline from "readline";
import { ResilientGeminiClient } from "./gemini-client";

// ─── ANSI Color Helpers ─────────────────────────────────────────
// Terminal colors for a premium CLI experience

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

// ─── Chat Application ──────────────────────────────────────────

export class ChatApp {
  private client: ResilientGeminiClient;
  private rl: readline.Interface;

  constructor(apiKey: string) {
    this.client = new ResilientGeminiClient({ apiKey });

    // Subscribe to tool-level events for live pattern activity logging
    this.client.toolLevel.onEvent = (event: string) => {
      console.log(`  ${c.dim}${event}${c.reset}`);
    };

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  /** Start the chat application */
  async start(): Promise<void> {
    this.printBanner();
    this.printHelp();
    console.log();
    this.promptUser();
  }

  // ─── Input Loop ─────────────────────────────────────────────

  /** Prompt the user for input and handle it */
  private promptUser(): void {
    this.rl.question(
      `${c.cyan}${c.bold}You: ${c.reset}`,
      async (input) => {
        const trimmed = input.trim();

        if (!trimmed) {
          this.promptUser();
          return;
        }

        if (trimmed.startsWith("/")) {
          await this.handleCommand(trimmed);
        } else {
          await this.handleMessage(trimmed);
        }

        this.promptUser();
      }
    );
  }

  // ─── Message Handling ───────────────────────────────────────

  /** Send a chat message through all reliability layers */
  private async handleMessage(message: string): Promise<void> {
    console.log(); // Visual spacing
    const startTime = Date.now();

    const response = await this.client.sendMessage(message);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log();
    console.log(`${c.green}${c.bold}Bot:${c.reset} ${response}`);
    console.log(
      `${c.dim}  ⏱  Response time: ${elapsed}s${c.reset}`
    );
    console.log();
  }

  // ─── Command Handling ───────────────────────────────────────

  /** Handle slash commands */
  private async handleCommand(command: string): Promise<void> {
    const cmd = command.toLowerCase().split(" ")[0];

    switch (cmd) {
      case "/status":
        this.printStatus();
        break;
      case "/stats":
        this.printStats();
        break;
      case "/dlq":
        this.printDLQ();
        break;
      case "/reset":
        this.client.resetConversation();
        console.log(
          `\n${c.green}  ✅ Conversation reset. All patterns restored to initial state.${c.reset}\n`
        );
        break;
      case "/help":
        this.printHelp();
        break;
      case "/quit":
      case "/exit":
        console.log(`\n${c.yellow}  👋 Goodbye!${c.reset}\n`);
        this.rl.close();
        process.exit(0);
        break;
      default:
        console.log(
          `\n${c.red}  Unknown command: ${command}${c.reset}`
        );
        console.log(
          `${c.dim}  Type /help for available commands.${c.reset}\n`
        );
    }
  }

  // ─── Display Functions ──────────────────────────────────────

  /** Print the startup banner */
  private printBanner(): void {
    console.log(`
${c.cyan}╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🛡️  ${c.bold}Reliability Patterns CLI Chatbot${c.reset}${c.cyan}                     ║
║   ${c.dim}Powered by Gemini AI with Layered Defenses${c.reset}${c.cyan}               ║
║                                                            ║
║   ${c.dim}Demonstrating: Retry · Circuit Breaker · Bulkhead${c.reset}${c.cyan}        ║
║   ${c.dim}Rate Limiting · Timeout · DLQ · Cascade Detection${c.reset}${c.cyan}        ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝${c.reset}
`);
  }

  /** Print available commands */
  private printHelp(): void {
    console.log(`${c.yellow}  Commands:${c.reset}
    ${c.bold}/status${c.reset}  — View all reliability pattern states
    ${c.bold}/stats${c.reset}   — View conversation statistics
    ${c.bold}/dlq${c.reset}     — View dead letter queue
    ${c.bold}/reset${c.reset}   — Reset conversation & patterns
    ${c.bold}/help${c.reset}    — Show this menu
    ${c.bold}/quit${c.reset}    — Exit
`);
  }

  /** Print the full reliability pattern status dashboard */
  private printStatus(): void {
    const status = this.client.getFullStatus();
    const cb = status.toolLevel.circuitBreaker;
    const bl = status.toolLevel.bulkhead;
    const rl = status.toolLevel.rateLimiter;
    const orch = status.orchestration;
    const dlq = status.dlq;
    const cache = status.cache;

    // Color the circuit breaker state
    const cbColor =
      cb.state === "CLOSED"
        ? c.green
        : cb.state === "OPEN"
          ? c.red
          : c.yellow;

    // Color cascade status
    const cascadeColor = orch.cascadeDetected ? c.red : c.green;
    const cascadeText = orch.cascadeDetected
      ? "CASCADE DETECTED"
      : "Normal";

    console.log(`
${c.cyan}┌────────────────────────── Pattern Status ──────────────────────────┐${c.reset}
│                                                                    │
│  ${c.bold}🔌 Circuit Breaker:${c.reset}  ${cbColor}${cb.state}${c.reset}
│     Failures: ${cb.failureCount}/${cb.failureThreshold} │ Recovery timeout: ${cb.recoveryTimeoutMs / 1000}s
│     Successes: ${cb.successCount} │ Total requests: ${cb.totalRequests}
│                                                                    │
│  ${c.bold}🔄 Retry:${c.reset}  ${c.green}Ready${c.reset}
│     Strategy: ${status.toolLevel.retry.jitterStrategy} jitter │ Max attempts: ${status.toolLevel.retry.maxRetries}
│     Base delay: ${status.toolLevel.retry.baseDelayMs}ms │ Max delay: ${status.toolLevel.retry.maxDelayMs}ms
│                                                                    │
│  ${c.bold}⚡ Rate Limiter:${c.reset}  ${rl.availableTokens}/${rl.maxTokens} tokens available
│     Refill: ${rl.refillRate} token every ${rl.refillIntervalMs / 1000}s │ Waited: ${rl.totalWaited} times
│                                                                    │
│  ${c.bold}🧱 Bulkhead:${c.reset}  ${bl.activeCount}/${bl.maxConcurrent} active │ Queue: ${bl.queueLength}/${bl.maxQueue}
│     Executed: ${bl.totalExecuted} │ Rejected: ${bl.totalRejected}
│                                                                    │
│  ${c.bold}⏱️  Timeout:${c.reset}  ${status.toolLevel.timeoutMs / 1000}s per request
│                                                                    │
│  ${c.bold}📬 Dead Letter Queue:${c.reset}  ${dlq.size} message(s)
│                                                                    │
│  ${c.bold}📦 Cache:${c.reset}  ${cache.size} entries │ ${cache.hits} hits │ TTL: ${cache.ttlMs / 1000}s
│                                                                    │
│  ${c.bold}🔗 Orchestration:${c.reset}  ${cascadeColor}${cascadeText}${c.reset}
│     Recent failures: ${orch.recentFailures}/${orch.cascadeThreshold} (within ${orch.cascadeWindowMs / 1000}s)
│     Total cascades: ${orch.totalCascades}
│                                                                    │
${c.cyan}└────────────────────────────────────────────────────────────────────┘${c.reset}
`);
  }

  /** Print session statistics */
  private printStats(): void {
    const status = this.client.getFullStatus();
    const conv = status.conversation;

    // Calculate token budget usage percentage
    const budgetPct = (
      (conv.totalTokensUsed / conv.tokenBudget) *
      100
    ).toFixed(1);

    console.log(`
${c.cyan}┌────────────────────────── Session Stats ───────────────────────────┐${c.reset}
│                                                                    │
│  ${c.bold}📊 Messages Sent:${c.reset}    ${status.stats.totalMessages}
│  ${c.bold}🔄 Tool Calls:${c.reset}       ${conv.totalToolCalls} total (${conv.toolCallsThisTurn}/${conv.maxToolCallsPerTurn} this turn)
│  ${c.bold}📝 Token Usage:${c.reset}      ~${conv.totalTokensUsed.toLocaleString()} / ${conv.tokenBudget.toLocaleString()} (${budgetPct}%)
│  ${c.bold}📦 Cache Hits:${c.reset}       ${status.stats.cacheHits}
│  ${c.bold}🔍 Dedup Entries:${c.reset}    ${conv.deduplicationEntries}
│                                                                    │
${c.cyan}└────────────────────────────────────────────────────────────────────┘${c.reset}
`);
  }

  /** Print the dead letter queue contents */
  private printDLQ(): void {
    const status = this.client.getFullStatus();
    const dlq = status.dlq;

    if (dlq.size === 0) {
      console.log(
        `\n  ${c.green}📬 Dead Letter Queue is empty — no failed messages!${c.reset}\n`
      );
      return;
    }

    console.log(
      `\n${c.cyan}┌────────────────────────── Dead Letter Queue ───────────────────────┐${c.reset}`
    );
    console.log(`│  ${c.bold}${dlq.size} failed message(s):${c.reset}`);
    console.log(`│`);

    for (const msg of dlq.messages) {
      console.log(
        `│  ${c.yellow}[${msg.id}]${c.reset} ${msg.preview}`
      );
      console.log(
        `│    Error: ${c.red}${msg.error.substring(0, 70)}${c.reset}`
      );
      console.log(
        `│    Retries: ${msg.retryCount} │ Time: ${msg.timestamp}`
      );
      console.log(`│`);
    }

    console.log(
      `${c.cyan}└────────────────────────────────────────────────────────────────────┘${c.reset}\n`
    );
  }
}
