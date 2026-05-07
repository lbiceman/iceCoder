# iceCoder

**A complete, production-grade memory system for AI coding agents** — with a full coding assistant built around it.

**English** | [中文](./README.zh-CN.md)

Most AI coding assistants forget everything when the session ends. iceCoder doesn't. It ships with a 15-module LLM-driven memory system that automatically extracts, recalls, consolidates, and secures knowledge across sessions — zero external databases, pure file-based persistence.

> **Why this matters:** Aider has no persistent memory. Cline relies on community-built "Memory Bank" hacks. Even Claude Code's memory system (per the 2025 source leak) uses a simpler architecture. iceCoder's memory system is the most complete open-source implementation available.

---

## What the Memory System Does

```
Session 1: "I prefer Vitest over Jest"
  → Auto-extracted to memory file with confidence score
  → Secret-scanned before writing to disk

Session 2: "Write tests for this module"
  → LLM semantic recall finds the Vitest preference
  → Relevance gate: passes ✓
  → Tests generated with Vitest, not Jest
  → 💾 Passive confirmation: "Recalled: vitest preference"

Session 3: "Help me deploy to production"
  → LLM recall returns Vitest memory
  → Relevance gate: Layer 1 keyword mismatch → Layer 2 LLM rescue → filtered out
  → No irrelevant Vitest memory injected

Background: autoDream consolidation merges duplicates,
  prunes stale memories, detects user habit patterns
```

---

## Full Memory Architecture

```
User input
  → Async prefetch (fire-and-forget)
  → Harness loop
      ├─ onLoopStart: load memory context
      ├─ injectMemoryContext: recall → rerank → relevance gate → CoN+JSON injection
      ├─ LLM + tool execution (loop)
      └─ onLoopEnd: background extraction + session notes + autoDream
  → Response + passive confirmation notices
```

### Memory Lifecycle

```
Write path:
  Conversation → Signal word detection → LLM extraction → Dedup check → Secret scan → Write file
                                                              ↓
                                                      Contradiction detection → Notify user

Read path:
  User message → Keyword extraction → LLM/keyword recall → Rerank → Relevance gate → Inject context
                                                              ↓
                                                      Layer 1: keyword overlap (zero cost)
                                                      Layer 2: LLM rescue (auto-triggered)

Consolidation path:
  Session accumulation → autoDream trigger → Orient → Gather → Consolidate → Prune
                                                          ↓
                                                  Merge duplicates / Resolve contradictions / Promote user preferences
```

---

## 15 Modules, Full Lifecycle

| Module | What it does |
|--------|-------------|
| **memory-recall** | LLM semantic recall + TF-IDF weighted keyword fallback, two-level recall (coarse → LLM rerank), fact-level ranking, negation expansion, time-range weighting, entity matching, **relevance gate** (two-layer filtering with auto LLM rescue) |
| **memory-llm-extractor** | Auto-extraction via signal words + 30 content-pattern regexes + turn throttling, mutex with agent writes, secret scanning, contradiction detection |
| **memory-dream** | autoDream consolidation: merge/prune/dedup/expire, ConsolidationLock with PID + deadlock detection + rollback, user candidate promotion |
| **memory-age** | Three-tier decay (fresh/stale/expired), high-confidence memories decay 2x slower |
| **session-memory** | 10-section session notes, validated before write, injected after context compaction |
| **memory-concurrency** | `sequential()` wrapper + inProgress mutex + trailing run pattern |
| **memory-secret-scanner** | 25 high-confidence rules (from gitleaks), auto-redact before disk write |
| **memory-security** | Path validation against 7 attack vectors (null byte, traversal, URL encoding, Unicode NFKC, symlink, absolute path, backslash) |
| **memory-telemetry** | JSONL logging + EventEmitter for recall/extraction/dream metrics |
| **memory-remote-config** | Runtime parameter tuning via hot-reloaded config file (5-min cache) |
| **multi-level-memory** | Three-tier loading (project/user/directory), user-type memories shared across projects |
| **harness-memory** | Integration layer: passive confirmation, preference regex, topic-shift detection, agent write mutex, relevance gate integration |
| **json-parser** | 4-layer LLM JSON parsing fallback (direct → markdown block → regex extract → fix common errors) |
| **memory-config** | Centralized defaults for all memory subsystems |
| **async-prefetch** | Fire-and-forget memory prefetching with cache |

---

## Key Design Decisions

### Relevance Gate

**Problem:** Recalled memories may be irrelevant to the current conversation (e.g., Vitest test config injected when solving a deployment issue), confusing the agent.

**Solution:** Two-layer filtering with auto rescue.

```
Recalled memories
  → Layer 1: Keyword overlap check (zero cost)
      ├─ Pass rate ≥ 50% → return passed
      └─ Pass rate < 50% → trigger Layer 2
  → Layer 2: LLM rescue (auto-triggered)
      └─ Recover relevant memories from filtered batch
```

**Configuration (`data/memory/memory-config.json`):**
```json
{
  "relevanceGate": {
    "enabled": true,
    "contextWindow": 3,
    "minKeywordOverlap": 1,
    "rescueThreshold": 0.5
  }
}
```

### LLM Recall + Keyword Bigram Fallback

When the LLM is available, it selects relevant memories from a manifest. When it's not (rate limit, timeout), the system falls back to two-stage keyword matching with Chinese bigram tokenization (zero-dependency, no dictionary needed).

**Two-level recall flow:**
1. Coarse recall: 6x candidates
2. LLM rerank: select top-K from candidates
3. Relevance gate: filter out irrelevant memories

**TF-IDF weighting (v5):** Rare tokens get higher weight, description/filename tokens weighted ×2.

### Topic-Shift Re-Recall

Jaccard coefficient < 0.2 between consecutive user messages triggers fresh memory recall. Pure local computation, zero LLM cost.

### Secret Scanning Before Write

25 regex rules derived from gitleaks catch API keys, tokens, and private keys before they're persisted. Rule source code splits and concatenates key prefixes to avoid triggering scanners on the source itself.

### Agent Write Mutex

If the main agent writes to memory files directly (via write_file tool), background extraction skips that conversation turn. `hasMemoryWritesSince` scans assistant tool_use messages to detect this.

### Passive Confirmation

After extraction, the next response includes "💾 Remembered: ..." so users know what was stored. Builds trust without interrupting flow.

### autoDream Consolidation

Four-phase process (Orient → Gather → Consolidate → Prune) that merges duplicates, resolves contradictions, detects user habit patterns, and promotes confirmed user preferences from project-level to user-level storage. Protected by file lock with PID write + deadlock detection + failure rollback.

### Contradiction Detection

LLM marks `contradicts` field during extraction. New memories don't directly overwrite old ones — contradictions are recorded and users are notified for confirmation.

### Session Memory

Independent of persistent memory, a session-level notebook system with 10 fixed sections that maintains continuity across context compactions.

**Trigger conditions:**
- Token growth exceeds threshold (default 5000)
- Tool call count exceeds threshold (default 3)
- Or: previous assistant turn had no tool calls (natural conversation breakpoint)

---

## vs. Claude Code Memory (per 2025 source leak)

| Capability | iceCoder | Claude Code |
|-----------|:--------:|:-----------:|
| LLM semantic recall | ✅ | ✅ |
| LLM auto-extraction | ✅ | ✅ |
| autoDream consolidation | ✅ | ✅ |
| Fallback when LLM unavailable | ✅ TF-IDF + bigram | ❌ |
| Memory decay + confidence | ✅ three-tier | ❌ |
| Topic-shift re-recall | ✅ Jaccard local | ❌ |
| Relevance gate | ✅ two-layer + auto rescue | ❌ |
| Fact-level ranking | ✅ | ❌ |
| Negation expansion | ✅ | ❌ |
| Time-range weighting | ✅ | ❌ |
| Content preview fallback | ✅ 300 chars | ❌ |
| Telemetry | ✅ real JSONL | ⚠️ stub |
| Runtime config | ✅ file hot-reload | ⚠️ GrowthBook |
| Secret scanning | ✅ 25 rules | ✅ |

> This table compares memory subsystem design only. Claude Code has native prompt caching, 200k context, multi-agent parallelism, and Anthropic's infrastructure — a different league as a complete product.

---

## Beyond Memory: Full Coding Assistant

iceCoder is also a complete AI coding assistant with CLI, Web, and mobile interfaces.

### Capabilities

- **32+ built-in tools** — file ops, search, Git, shell, document parsing (PPTX/XMind/XLSX/HTML), web search
- **MCP protocol** — dynamically connect external tool servers
- **6-agent pipeline** — requirements → design → task split → coding → testing → verification
- **Harness loop engine** — custom state machine (not LangChain), with max-output-tokens recovery, `<status>` tag continuation, exponential backoff retry, tool result budget trimming, stream/non-stream auto-fallback, **consecutive failure circuit breaker**
- **Context compaction** — auto-trim + LLM summarization for long conversations
- **Mobile** — scan QR code to connect phone as remote controller
- **LLM adapter** — unified interface for OpenAI + Anthropic SDKs, hot-switchable

### Circuit Breaker

Automatically stops when consecutive tool failures reach threshold, preventing infinite loops.

**Config:** `maxConsecutiveFailures` (default 3)

**Behavior:** Any failure in a batch → counter increments → all succeed → counter resets → threshold reached → auto-stop with user prompt

---

## Quick Start

```bash
npm install
# Edit data/config.json — add at least one OpenAI-compatible API key
npm run iceCoder          # Start all (CLI + Web + Tunnel)
```

### Commands

```bash
npm run iceCoder              # CLI + Web + Tunnel
npm run iceCoder:cli          # CLI only
npm run iceCoder:web          # Web only
npm run iceCoder:run -- "fix the build errors"   # One-shot task
npm run iceCoder:tools        # List tools
npm run iceCoder:mcp          # List MCP servers
npm run iceCoder:config       # Show config
npm run dev                   # Vite dev server
npm run build && npm start    # Production build
```

### Global Install

```bash
npm run build && npm link
iceCoder start [--port 8080]
iceCoder cli / web
iceCoder run "fix build errors" [--max-rounds 50] [--json]
iceCoder tools / mcp / config / help
```

### Built-in Commands (`~` prefix)

| Command | Description |
|---------|-------------|
| `~clear` | Clear conversation history |
| `~open` | File manager (Web) |
| `~scan` | QR code for mobile connection |
| `~telemetry` | Memory telemetry report |
| `~export` | Export memory files |
| `~memory` | View/manage/delete memories |
| `~tools` | List tools (terminal) |
| `~quit` | Exit (terminal) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `ICE_CONFIG_PATH` | `data/config.json` | LLM + MCP config |
| `ICE_SYSTEM_PROMPT_PATH` | `data/system-prompt.md` | System prompt |
| `ICE_SESSIONS_DIR` | `data/sessions` | Session storage |
| `ICE_MEMORY_DIR` | `data/memory-files` | File memory |
| `ICE_OUTPUT_DIR` | `output` | Pipeline output |

### Dynamic Config (`data/memory/memory-config.json`)

```json
{
  "extraction": {
    "minTurns": 3,
    "minTokens": 5000,
    "toolCallInterval": 3,
    "turnThrottle": 1
  },
  "dream": {
    "minHours": 6,
    "minSessions": 3,
    "enabled": true
  },
  "recall": {
    "maxResults": 15
  },
  "relevanceGate": {
    "enabled": true,
    "contextWindow": 3,
    "minKeywordOverlap": 1,
    "rescueThreshold": 0.5
  },
  "sessionMemory": {
    "enabled": true,
    "minTokensToInit": 10000,
    "minTokensBetweenUpdate": 5000,
    "toolCallsBetweenUpdates": 3
  }
}
```

Config hot-reloads with 5-minute cache refresh, no restart needed.

---

## Architecture

```
Clients (PC/Mobile WebSocket + SSE + CLI)
  → Express + WebSocket Server
    → Harness loop engine (chat) / Orchestrator (6-stage pipeline)
      → Tool system (32+ built-in + MCP) + LLM adapter + Memory system
```

### Design Decisions

| Aspect | Choice |
|--------|--------|
| Loop engine | Custom Harness state machine, not LangChain — full control over tool execution flow |
| Tool system | Central registry + Zod validation + unified executor + streaming parallel execution |
| LLM adapter | Unified interface (OpenAI + Anthropic SDK), hot-switchable providers |
| Memory persistence | Zero external DB, pure files + LLM semantic recall |
| Frontend | Zero-framework vanilla HTML/CSS/JS |
| MCP | stdio protocol, dynamic load/unload |

---

## Project Structure

```
src/
├── index.ts          # Entry point
├── cli/              # CLI commands
├── core/             # Orchestrator + agent base class + pipeline state
├── agents/           # 6 specialized agents
├── harness/          # Conversation loop engine
├── tools/            # Tool registry + 32 built-in tools
├── mcp/              # MCP client
├── llm/              # LLM adapter layer
├── memory/           # Memory system (15 modules)
├── parser/           # Document parsing
├── web/              # Express + WebSocket + SSE
├── public/           # Frontend
└── data/             # Runtime data
```

---

## Memory System File Map

```
src/memory/file-memory/
├── index.ts                  # Unified exports
├── types.ts                  # Type definitions
├── file-memory-manager.ts    # FileMemoryManager main class
├── memory-recall.ts          # Recall engine (LLM + keyword + relevance gate)
├── memory-llm-extractor.ts   # LLM auto-extraction
├── memory-dream.ts           # autoDream consolidation
├── memory-scanner.ts         # File scanning + frontmatter parsing
├── memory-scanner-cache.ts   # Scanner cache
├── memory-fact-index.ts      # Fact-level index
├── memory-prompt.ts          # Memory system prompts
├── session-memory.ts         # Session memory (10-section notes)
├── multi-level-memory.ts     # Three-tier loading
├── memory-config.ts          # Centralized defaults
├── memory-remote-config.ts   # Remote dynamic config
├── memory-eviction.ts        # LRU eviction
├── memory-age.ts             # Decay + freshness
├── memory-security.ts        # Path security
├── memory-secret-scanner.ts  # Secret scanning
├── memory-concurrency.ts     # Concurrency control
├── memory-telemetry.ts       # Telemetry logging
├── memory-tokenizer.ts       # Chinese/English tokenization
├── memory-parser.ts          # Markdown parsing
├── json-parser.ts            # LLM JSON parsing fallback
└── async-prefetch.ts         # Async prefetch

src/harness/
├── harness.ts                # Harness loop engine
├── harness-memory.ts         # Memory integration layer
├── loop-controller.ts        # Loop control + circuit breaker
└── types.ts                  # Type definitions
```

---

## Known Limitations

- 200-file hard cap + full scan per recall (no vector search)
- LLM recall costs ~256 output tokens per invocation
- No backup/restore, no encrypted storage
- Dream consolidation reads only first 50 files (2000 chars each)
- `harness-memory.ts` integration layer is overloaded (~450 lines, too many responsibilities)
- Memory modules are flat in one directory (not organized into recall/, extraction/, dream/, security/ subdirectories)

## Tech Stack

Node.js ≥ 18 · TypeScript · Express · WebSocket + SSE · OpenAI SDK + Anthropic SDK · jszip + xml2js + cheerio + officeparser · MCP 2024-11-05 · Vanilla HTML/CSS/JS

## License

ISC
