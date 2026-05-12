# iceCoder

iceCoder is a **tool-using LLM runtime** for local repositories: a Harness loop with tools, file-based long-term memory, session memory for compaction recovery, prompt assembly, and **CLI / Web / WebSocket** entrypoints (plus optional MCP tools).

**Stack:** Node.js 18+, TypeScript, Express (API + static SPA in production), Vite (dev UI on a separate port), WebSocket chat, Vitest.

The goal is not only to chat with a model, but to run a **software-engineering assistant** that can understand a task, inspect a repository, edit files, run verification, recover from failures, preserve useful memory, and continue long sessions without losing state.

**Removed (no longer in tree):** the legacy **multi-stage pipeline** and per-stage **Agent** classes (`BaseAgent`, `executePipeline`, stage reports, etc.). The `Orchestrator` is now a thin holder for `FileParser` + `LLMAdapter` shared by the WebSocket chat path.

[中文文档](./README.zh-CN.md) | [Next Work](./nextWork.md)

---

## Current Status

The core Runtime P0/P1 work has been implemented:

- Tool calls execute when `toolCalls` is present, regardless of provider `finishReason` quirks.
- Executable tasks that receive a text-only response get a no-tool recovery prompt.
- `permissions` supports `allow / confirm / deny`, including wildcard patterns such as `read_*`.
- `confirm` without a configured confirmation handler is denied by default.
- Task State v1 tracks task intent, phase, files read/changed, commands, and verification state.
- Verification Gate v1 prevents editable tasks from claiming completion before verification when verification tools are available.
- RepoContext v1 tracks files read, files changed, commands, test commands, and recent diagnostics.
- Runtime State and Repo Context are injected before each LLM call once they contain useful state.
- Repeated failed tool calls are detected and the model is instructed to change strategy.
- Session memory supports forced update before compaction.
- Memory prompts have been tightened to prefer precise, evidence-backed long-term memories.
- A minimal `npm run eval:agent` skeleton defines future **runtime** metrics (naming is historical).

Verification:

```bash
npx tsc --noEmit
npm test
npm run eval:agent
```

Treat **`npm test`** as the source of truth for counts and pass/fail. The suite is organized under `test/**/*.test.ts` (on the order of **three dozen** files and **550+** examples—numbers drift as tests are added).

---

## Runtime Architecture

```text
User / CLI / Web / Remote
  -> loadAssembledChatPrompt()
  -> HarnessConfig
      -> ContextAssembler
      -> LLMAdapter
      -> ToolExecutor
      -> HarnessMemoryIntegration
      -> ContextCompactor
  -> Harness.run()
```

### Harness Loop

The Harness is the runtime state machine around the LLM:

```text
initialize messages
initialize TaskState
initialize RepoContext
while running:
  maybe compact context
  inject runtime state and repo context
  normalize messages
  call LLM with tools
  if toolCalls:
    apply permissions
    execute tools
    update TaskState / RepoContext
    inject relevant memories
    continue
  else:
    recover no-tool executable tasks
    enforce verification gate
    run stop hooks
    finalize
```

### Sub-Agent Runner

`src/harness/sub-agent-runner.ts` provides an **isolated read-only agent** for codebase exploration. When the main model calls `delegate_to_subagent`, a private message loop starts with a whitelisted tool set (`read_file`, `search_codebase`, `fs_operation list` only). The sub-agent runs independently (60s timeout, max 10 rounds), reads files, searches code, and returns a **concise structured summary** instead of dumping raw file contents into the main context.

This solves the "context pollution" problem: previously, each exploration task dumped large search results and file contents directly into the session, accelerating compaction and wasting tokens. With the sub-agent, the main context receives only a short summary (~hundreds of tokens), cutting exploration-induced context bloat by an estimated 60-80%.

The sub-agent also has a **process-level LRU cache** (default 100 entries, keyed by task + filesRead + mtimes) to skip re-execution of identical queries when files haven't changed on disk.

Key components:
- `SubAgentRunner` — isolated message loop with timeout and round limits
- `delegate_to_subagent` — the tool exposed to the model for delegation
- `formatSubAgentResult()` — formats the structured result for the main session

Key runtime protections:

- No-tool recovery for executable tasks
- Verification gate after file-changing tools
- Permission rules before tool execution
- Confirmation-required tools are denied if no confirmation callback exists
- Repeated failed tool signature detection
- Consecutive failure circuit breaker
- Context compaction and post-compaction Runtime Recovery Context

### Tool planner

On the first user turn of an executable engineering task, the Harness may inject a **tool planner** hint: a short list of **2–3 suggested tool names** derived from `taskState.intent` (see `src/harness/tool-plan-intent-map.ts` and `src/harness/tool-planner.ts`). This reduces hesitant openings where the model chats instead of acting.

---

## Prompt System

Prompt assembly is split into stable and dynamic layers.

### Stable System Prompt

Defined by `src/prompts/sections.ts` and assembled by `PromptAssembler`:

- identity
- work style
- execution rules
- modification rules
- tool usage policy
- shell rules
- context-management reminders

### Dynamic Context

Injected by `ContextAssembler`:

- environment
- current date
- language override if explicitly configured
- persistent memory instructions
- project instructions
- runtime state
- repo context
- memory context

This separation keeps the stable prompt cache-friendly while allowing changing runtime state to flow into the model.

### Tool Disable Semantics

`ICE_EVAL_MODE=1` or `ICE_DISABLE_TOOLS=1` disables runtime tools and removes tool-oriented prompt sections. This avoids the earlier split where some entrypoints removed tool instructions but still passed tools to the model.

---

## Tool Runtime

Tools are registered in `src/tools/` and exposed to the model through tool schemas.

Important components:

- `ToolRegistry`: stores available tools and definitions
- `ToolExecutor`: validates and executes tool calls with retry/timeout
- `StreamingToolExecutor`: batches and streams tool execution output
- `tool-metadata`: read-only, destructive, concurrency, and result-size metadata
- Harness permissions: runtime policy for allow/confirm/deny

Current tool categories:

- file read/write/edit/patch
- shell commands
- git
- code search
- document parsing
- web search/fetch
- environment and diff helpers

---

## Memory System

iceCoder uses file-based persistent memory. It does not require an external database.

### Memory Types

| Type | Purpose |
|---|---|
| `user` | durable user profile, role, goals, explicit preferences |
| `feedback` | corrections and behavior feedback |
| `project` | project facts not derivable from code or git |
| `reference` | links or references to external systems |

### Memory Lifecycle

```text
conversation
  -> extraction trigger
  -> LLM extraction
  -> secret scan
  -> dedup / contradiction check
  -> write memory files
  -> recall on future tasks
  -> relevance gate
  -> CoN + JSON injection
  -> dream consolidation
  -> decay / eviction
```

### Recall Flow

```text
query
  -> scan memory files
  -> confidence filter
  -> FactIndex build/cache
  -> LLM recall if candidate count is high enough
  -> keyword fallback otherwise
  -> related memory expansion
  -> relevance gate
  -> execution-intent filter
  -> budget filter
  -> JSON memory prompt injection
```

Recent changes tightened memory behavior:

- Recall prompt now uses strict relevance rather than broad inclusion.
- Coding/debugging tasks prefer project facts and technical constraints.
- Personal preferences are injected only when strongly relevant.
- Extraction prompt now prefers fewer high-confidence memories over noisy long-term memory.
- Weak one-off signals should remain session state, not persistent memory.

### Dream Consolidation & Eviction

`src/memory/file-memory/memory-dream.ts` runs a periodic "dream" process (analogous to human sleep consolidation) that reviews, deduplicates, and prunes memories. Triggers:

- Session threshold (every 5 sessions)
- File count threshold (default 30 files)
- New files since last dream (≥10)
- Expired memories detected (≥3)
- Dead links in MEMORY.md index
- Memory count exceeds post-dream cap

Dream phases: **Orient** → **Gather** → **Consolidate** → **Prune**. After consolidation, the system runs a cap-enforcing eviction pass on both project-level and user-level memory directories when configured (`enforceMemoryCapAfterDream` / `enforceUserMemoryCapAfterDream`).

`src/memory/file-memory/memory-eviction.ts` implements a **weighted scoring eviction** (not pure LRU). Scores combine:

| Factor | Range | Effect |
|---|---|---|
| Freshness penalty | 0-100 | Longer inactive = higher score (more likely evicted) |
| Confidence protection | 0-30 | High confidence memories are protected |
| Recall protection | 0-20 | Frequently recalled memories are protected |
| Type protection | 0 or 15 | `user` type is protected |
| Level protection | -18 to 35 | `hard_rule` > `preference` > `project_fact` > `observation` > `session_state` |
| Evidence protection | -16 to 28 | `explicit` > `repeated` > `inferred` > `weak` |
| Source protection | 0-30 | `user_explicit` > `manual` > `dream` > `llm_extract` |
| Type evict bias | configurable | `feedback` / `reference` types biased toward eviction |

Safety protections:
- Memories with `confidence >= 1.0` are never evicted (user explicit declarations)
- Recently active memories (within `protectionDays`) are never evicted
- The `MEMORY.md` index file itself is never evicted
- Evicted files go to `evicted/` subdirectory (recoverable via `restoreEvicted()`)
- Eviction log is written to `evicted/eviction-log.jsonl`
- Old evicted archives are automatically pruned

---

## Session Memory and Compaction

Long sessions use session memory and context compaction to avoid losing current task state.

### Session Memory

`session-memory.ts` maintains a structured Markdown session note with sections such as:

- Session Title
- Current State
- Task Specification
- Files and Functions
- Workflow
- Errors & Corrections
- Worklog

Recent changes:

- forced session memory update is supported before compaction
- session memory update prompt now asks the LLM to return Markdown directly
- code validates returned notes before writing

### Context Compaction

`ContextCompactor` uses layered compression:

1. snip duplicate reminders/summaries
2. microcompact old low-value history
3. trim long tool results
4. extract structural summary
5. optionally refine summary with LLM
6. re-inject recent file content and recovery prompt

The context window is selected by priority:

```text
ICE_CONTEXT_WINDOW
  -> default provider maxContextTokens
  -> largest configured provider maxContextTokens
  -> 128k default
```

### Runtime snapshot in session notes

Structured **`TaskState`** and **`RepoContext`** can be persisted into `data/sessions/session-notes.md` inside a fenced block with language tag **`icecoder-runtime`** (JSON payload). Schema types live in **`src/types/runtime-snapshot.ts`** (`PersistedRuntimeV1`, etc.) so session-memory does not depend on harness implementation classes.

When a chat session **resumes with existing message history**, the Harness can **`applySnapshot`** from that block so process restarts or UI reloads still restore goal, phase, files touched, and verification status—not only narrative session notes.

---

## Task State and Repo Context

Task State v1 and RepoContext v1 are the current bridge toward a stronger **tool-using** runtime with clearer state and verification.

Task State tracks:

- goal
- intent
- phase
- files read
- files changed
- commands run
- whether verification is required
- verification status

RepoContext tracks:

- files read
- files changed
- commands run
- test commands
- recent diagnostics

Once useful state exists, Harness injects it as runtime context before LLM calls.

This gives the model a stable view of what has happened even if conversation history grows or is compacted.

---

## Runtime evaluation (eval harness)

A minimal eval skeleton exists (script name `eval:agent` is legacy):

```bash
npm run eval:agent
```

It currently defines the metric names and baseline case categories. It is not yet a full scoring runner.

Target metrics:

- task_success_rate
- tool_call_rate
- first_tool_latency
- no_tool_final_rate
- verification_rate
- repeat_failure_rate
- memory_interference_rate
- tokens_per_successful_task
- compaction_saved_tokens

See `nextWork.md` for the next implementation steps.

---

## Web app, API, and ports

- **HTTP server** (`src/index.ts`, `src/web/server.ts`): default port **`1024`** (`PORT` env). Serves the built SPA static assets in production; in development it still hosts API routes while the Vite dev server serves the UI.
- **Vite dev UI** (`vite.config.ts`): default **`1025`**, proxies `/api` and WebSocket upgrade to `http://localhost:1024`.
- **WebSocket chat**: attached to the HTTP server (`src/web/chat-ws.ts`); mobile/remote clients can use `/api/remote` and related routes.
- **Notable API mounts**: `/api/config`, `/api/tools`, `/api/remote`, `/api/sessions`, `/api/chat/upload`, `/api/memory/*` (telemetry, files, export).
- **Frontend** lives under `src/public/` (e.g. chat UI scripts, session pet indicator). Production build output: `dist/public/`.

LLM provider settings are read from **`data/config.json`** by default (see `data/config.example.json`). The server can **watch** that file and reload providers without a full restart (`src/index.ts`).

### Session pet (Web UI indicator)

The **chat page** embeds an optional **session pet**: a small canvas-based character that reflects runtime activity **without** changing Harness or backend logic.

| | |
|---|---|
| **Rendering** | ~120×120 logical px, dark body, capsule eyes; eye color is picked once per load from `session-pet-palette.js` (decorative, not tied to token %). |
| **Token ring** | Outer arc from top, clockwise — approximate **context / token usage** ratio (green → yellow → red). |
| **Expressions** | Many (~20) named visual states (e.g. thinking, idle, tool/memory hints) driven by **`ChatPetBridge`** from WebSocket `HarnessStepEvent`-style updates in `chat-page.js`. |
| **Interaction** | Drag to reposition (saved under `localStorage` key `ice-session-pet-position`); double-click resets placement. Canvas `aria-label` is built via `buildSessionPetCanvasAriaLabel`. |
| **Key files** | `src/public/js/session-pet.js`, `session-pet-palette.js`, `chat-pet-bridge.js`; styles under `src/public/css/style.css`; wired in `chat-page.js` / `main.js`. |
| **Demo** | `src/public/pet-expressions-demo.html` + `pet-expressions-demo.js` for manual expression checks. |
| **Tests** | `test/public/session-pet-palette.test.ts`, `session-pet-expression-cycle.test.ts`. |

CLI-only workflows do **not** include the pet; it is a **browser UX** affordance for the SPA chat.

---

## MCP (Model Context Protocol)

`src/mcp/mcp-manager.ts` reads **`mcpServers`** from **`.iceCoder/mcp.json`** under the current working directory (override with **`ICE_MCP_CONFIG_PATH`**). Shape matches common MCP configs: top-level `mcpServers` object. When a server starts successfully, its tools are **registered into the main `ToolRegistry`** alongside builtins (prefixed `mcp_{serverName}_{toolName}`). Failures are logged but do not block core startup. See **`.iceCoder/mcp.example.json`** for a template. CLI: `iceCoder mcp` for status.

**Note:** LLM provider settings stay in `data/config.json` (or `ICE_CONFIG_PATH`); MCP is intentionally separate.

---

## Configuration and environment variables

| Variable | Role |
|----------|------|
| `ICE_CONFIG_PATH` | Path to provider + MCP config JSON (default `data/config.json`) |
| `ICE_OUTPUT_DIR` | General output directory (default `output`) |
| `ICE_SESSIONS_DIR` | Session data directory (default `data/sessions`) |
| `PORT` | HTTP/API port (default `1024`) |
| `NODE_ENV` | `production` enables production static-SPA behavior in `createServer` |
| `ICE_CONTEXT_WINDOW` | Override context window size (see compaction section) |
| `ICE_MCP_CONFIG_PATH` | Optional absolute path to MCP JSON (default: `<cwd>/.iceCoder/mcp.json`) |
| `ICE_MCP_INIT_TIMEOUT_MS` | MCP `initialize` timeout in ms (default `120000`; increase if Puppeteer or `npx` cold install exceeds it) |

---

## Repository layout (concise)

```text
src/
  cli/              # CLI entry, bootstrap, commands (web, run, config, mcp, …)
  core/             # Orchestrator (shared file parser + LLM adapter)
  harness/          # Harness loop, compaction, task/repo state, sub-agent, tool planner
  llm/              # OpenAI / Anthropic adapters
  memory/file-memory/  # File-based memory, session notes, dream, eviction
  parser/           # FileParser strategies (HTML, Office, XMind)
  prompts/          # Prompt assembly
  tools/            # Builtin tools, registry, executor
  mcp/              # MCP client manager
  web/              # Express server, routes, WebSocket chat
  public/           # Vite root: chat UI, session pet (canvas + bridge), static assets
  types/            # Shared types (e.g. runtime snapshot schema)
test/               # Vitest suites mirroring src areas
data/               # config, sessions, optional MCP memory file
```

---

## Development

```bash
npm install
npm test
npx tsc --noEmit
npm run eval:agent
```

Common commands:

```bash
npm run dev          # API + Vite (project script may include tunnel; see package.json)
npm run dev:api      # API only (tsx src/index.ts)
npm run dev:web      # Vite only (port 1025)
npx tsx src/cli/index.ts web --port 1024
npx tsx src/cli/index.ts run "fix failing tests"
```

Global CLI after `npm link` / global install: `iceCoder` → `dist/cli/index.js` (see `package.json` `bin`).

---

## Roadmap

The remaining work is tracked in `nextWork.md`. The next high-impact items are:

1. Memory v2 structured levels and conflict arbitration
2. Deeper compaction/session-notes integration (token accounting, tighter recovery budget units) — structured `icecoder-runtime` snapshots already exist; see `nextWork.md`
3. real eval runner with pass/fail scoring
4. telemetry persistence for runtime metrics
5. Richer model-aware planning and failure recovery strategies (beyond the current intent-based tool planner)
