# 🛡️ Reliability Patterns CLI Chatbot

A **terminal-based CLI chatbot** built with TypeScript and the free Gemini API, demonstrating real-world **reliability patterns** used in production systems.

Each pattern is implemented in its own file with detailed comments explaining _what_ it does and _why_ it matters.

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Add your free Gemini API key to .env
#    Get one at: https://aistudio.google.com/apikey
echo "GEMINI_API_KEY=your_key_here" > .env

# 3. Start the chatbot
npm start
```

---

## 🏗️ Project Structure

```
src/
├── patterns/                        # Individual reliability patterns
│   ├── retry.ts                     # Exponential backoff + jitter
│   ├── circuit-breaker.ts           # CLOSED → OPEN → HALF_OPEN
│   ├── bulkhead.ts                  # Semaphore-based concurrency limiting
│   ├── timeout.ts                   # Time-bounded operations + fallbacks
│   ├── rate-limiter.ts              # Token bucket algorithm
│   └── dead-letter-queue.ts         # Capture & replay failed messages
│
├── layers/                          # Layered defense composition
│   ├── tool-level.ts                # Layer 1: Per-call defenses
│   ├── conversation-level.ts        # Layer 2: Session-wide guards
│   └── orchestration-level.ts       # Layer 3: System-wide protection
│
├── gemini-client.ts                 # Gemini API + all layers composed
├── chat.ts                          # Interactive CLI interface
└── index.ts                         # Entry point
```

---

## 🔧 Reliability Patterns Explained

### 1. 🔄 Retry with Exponential Backoff & Jitter
**File:** [`src/patterns/retry.ts`](src/patterns/retry.ts)

**Problem:** Transient failures (network blips, 429 rate limits, 503 overloads) are temporary. But naive retries cause the **"Thundering Herd"** — thousands of clients retrying at the exact same intervals create synchronized load spikes.

**Solution:**
- **Exponential Backoff:** Wait longer between each retry (1s → 2s → 4s → 8s)
- **Jitter:** Add randomness to spread retries out (prevents thundering herd)
- **Max Retries:** Cap attempts to avoid infinite loops
- **Error Classification:** Only retry transient errors (429/5xx), not permanent ones (400/401/413)

```
Attempt 1: wait ~1.2s  (base × random)
Attempt 2: wait ~3.7s  (longer, with jitter)
Attempt 3: wait ~6.1s  (even longer, still random)
→ Give up after max retries
```

**Jitter Strategies:**
| Strategy | Formula | Best For |
|---|---|---|
| Full | `random(0, delay)` | Maximum spread |
| Equal | `delay/2 + random(0, delay/2)` | Guaranteed minimum wait |
| Decorrelated | `random(base, prevDelay × 3)` | Preventing correlated storms (AWS recommended) |

---

### 2. 🔌 Circuit Breaker
**File:** [`src/patterns/circuit-breaker.ts`](src/patterns/circuit-breaker.ts)

**Problem:** If a downstream service is down, retrying hammers it with more load, making recovery harder. Your system wastes resources waiting for responses that will never come.

**Solution:** Like an electrical circuit breaker, trip the circuit when too many failures occur:

```
  CLOSED (normal)  ──failures──►  OPEN (reject all)
       ▲                              │
       │ probe succeeds          timeout expires
       │                              │
  HALF-OPEN (test one request) ◄──────┘
```

- **CLOSED:** Normal operation, failures are counted
- **OPEN:** All requests rejected immediately (fast-fail, no wasted time)
- **HALF-OPEN:** Allow one probe request to test if the service recovered

**Real-world:** Netflix's Hystrix, Resilience4j, and Polly all implement this pattern.

---

### 3. 🧱 Bulkhead (Resource Isolation)
**File:** [`src/patterns/bulkhead.ts`](src/patterns/bulkhead.ts)

**Problem:** Without isolation, a slow service can consume ALL your threads/connections, starving other healthy services.

**Solution:** Named after watertight compartments in a ship — if one compartment floods, the others stay dry:
- Limit concurrent calls to each resource using a **semaphore**
- Excess requests queue up (with a timeout)
- If the queue is full, reject immediately (**backpressure**)

```
Active Slots: [■] [■] [□]     ← max 3 concurrent
Queue:        [▪] [▪] [▪]     ← overflow queue
New request → slot free? → execute : queue (or reject)
```

---

### 4. ⏱️ Timeout & Graceful Degradation
**File:** [`src/patterns/timeout.ts`](src/patterns/timeout.ts)

**Problem:** A hung API call can block your app indefinitely. Users stare at spinners. Resources are consumed with no result.

**Solution:**
- **Timeout:** Set a time limit on every external call using `Promise.race()`
- **Graceful Degradation:** When timeout hits, return a degraded but usable response instead of crashing

```
API Call ──success──► Full Response ✅
    │
    │ timeout!
    ▼
Fallback ──────────► "Service temporarily unavailable" ⚠️
```

---

### 5. ⚡ Rate Limiter (Token Bucket)
**File:** [`src/patterns/rate-limiter.ts`](src/patterns/rate-limiter.ts)

**Problem:** APIs have rate limits (Gemini free tier: ~15 RPM). Exceeding them causes 429 errors and potential bans.

**Solution:** Token Bucket algorithm — imagine a bucket of tokens:
- Each request costs one token
- Tokens refill at a steady rate
- If empty, wait for refill (instead of getting 429'd)
- Allows short **bursts** while enforcing a long-term average rate

```
Bucket: [🪙🪙🪙🪙🪙]  ← 5 tokens available
Request → take token → ✅ proceed
Request → take token → ✅ proceed  
Request → bucket empty → ⏳ wait for refill
```

---

### 6. 📬 Dead Letter Queue (DLQ)
**File:** [`src/patterns/dead-letter-queue.ts`](src/patterns/dead-letter-queue.ts)

**Problem:** When a message fails after all retries, you can either discard it (data loss!) or save it for later.

**Solution:** Save permanently-failed messages to a Dead Letter Queue:
- **Inspect:** See what failed and why (`/dlq` command)
- **Debug:** Error details and metadata help identify root causes
- **Replay:** Once the issue is fixed, replay failed messages

```
Request → Retry → Retry → Retry → All failed!
                                      │
                                      ▼
                              Dead Letter Queue
                              [msg1 💀] [msg2 💀]
                                      │
                              Fix the issue, then replay ✅
```

---

## 🏛️ Layered Defense Architecture

Patterns don't work in isolation — they're composed in **layers**:

### Layer 1: Tool Level (`src/layers/tool-level.ts`)
Wraps each individual API call:
```
Bulkhead → Rate Limiter → Circuit Breaker → Retry → Timeout → API Call
```

### Layer 2: Conversation Level (`src/layers/conversation-level.ts`)
Guards the session:
- **Max tool calls per turn** — prevents runaway agent loops
- **Token budget per session** — prevents surprise API bills
- **Call deduplication** — prevents double-sends

### Layer 3: Orchestration Level (`src/layers/orchestration-level.ts`)
Protects the system:
- **Cascade detection** — detects rapid failure cascades via sliding window
- **Deadline propagation** — aborts stale operation chains

### Layer 4: Caching as Fault Tolerance (built into `gemini-client.ts`)
- Successful responses are cached
- On failure, cached responses serve as fallbacks
- The system degrades gracefully instead of failing hard

```
User Message
    │
    ▼
[Layer 2] Conversation checks ── dedup? budget? call limit?
    │
    ▼
[Layer 3] Orchestration checks ── cascading? deadline?
    │
    ▼
[Layer 4] Cache check ── cache hit? → return cached
    │ cache miss
    ▼
[Layer 1] Tool-level defense ── bulkhead → rate limit → circuit breaker → retry → timeout
    │
    ▼
Gemini API → success? cache + return : DLQ + fallback
```

---

## 🎮 CLI Commands

| Command | Description |
|---------|-------------|
| `/status` | View all reliability pattern states (circuit breaker, rate limiter, etc.) |
| `/stats` | View session statistics (messages, tokens, cache hits) |
| `/dlq` | View the dead letter queue (failed messages) |
| `/reset` | Reset conversation and all pattern states |
| `/help` | Show available commands |
| `/quit` | Exit the application |

---

## 📋 Error Classification

Not all errors deserve a retry:

| Status Code | Action | Reason |
|-------------|--------|--------|
| `429` | ✅ Retry with backoff | Rate limited — temporary |
| `500` | ✅ Retry with backoff | Server error — likely transient |
| `502` | ✅ Retry with backoff | Bad gateway — temporary |
| `503` | ✅ Retry with backoff | Service unavailable — temporary |
| `529` | ✅ Retry with backoff | Site overloaded — temporary |
| `400` | ❌ No retry | Bad request — fix your input |
| `401` | ❌ No retry | Unauthorized — fix your API key |
| `403` | ❌ No retry | Forbidden — fix permissions |
| `413` | ❌ No retry | Payload too large — reduce input |

---

## 🤔 Circuit Breaker Gotchas

The circuit breaker isn't perfect. Be aware of:

1. **Granularity Mismatch** — One circuit for the entire service vs. per-endpoint? Per-endpoint is more precise but more complex to manage.

2. **Non-deterministic Failures** — Random failures (e.g., 1 in 100 requests fail) might trip the circuit unnecessarily. Consider using a failure _rate_ threshold instead of a failure _count_.

3. **Contextual Accumulation** — Past failures may not predict future failures. A service that failed at 2 AM due to a deployment might be fine at 3 AM.

---

## 📚 Further Reading

- [AWS Architecture Blog: Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Martin Fowler: Circuit Breaker](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Microsoft: Bulkhead Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead)
- [Google Cloud: API Design - Retry](https://cloud.google.com/apis/design/errors#retrying_errors)

---

## 📄 License

MIT — Use freely, share widely! 🚀
