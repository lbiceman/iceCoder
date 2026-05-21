# iceCoder

iceCoder is a **tool-using LLM runtime** for local repositories: a Harness loop with tools, **TaskGraph** (sole structured execution context source — replaces the legacy Execution Transparency Layer), resilient **checkpoint** persistence (`CheckpointEngine` v2 on the same JSON file), optional **dual-mode Supervisor** (`off` / `adaptive` / `strict`), file-based long-term memory, session memory for compaction recovery, prompt assembly, and **CLI / Web / WebSocket** entrypoints (plus optional MCP tools).

**Stack:** Node.js 18+, TypeScript, Express (API + static SPA in production), Vite (dev UI on a separate port), WebSocket chat, Vitest.

The goal is not only to chat with a model, but to run a **software-engineering assistant** that can understand a task, inspect a repository, edit files, run verification, recover from failures, preserve useful memory, and continue long sessions without losing state.

**Removed (no longer in tree):** the legacy **multi-stage pipeline** and per-stage **Agent** classes (`BaseAgent`, `executePipeline`, stage reports, etc.). The `Orchestrator` is now a thin holder for `FileParser` + `LLMAdapter` shared by the WebSocket chat path.

[中文文档](./README.zh-CN.md) | [Environment variables](./docs/environment-variables.md) ([中文](./docs/环境变量.md)) | [Next Work](./docs/nextWork.md)

---

## Current Status

| Area | Status |
|------|--------|
| **Harness core** | Tool execution, permissions (`allow`/`confirm`/`deny`), Task State v1, RepoContext v1, verification gate, no-tool recovery, repeat-failure detection |
| **TaskGraph** | Sole structured context injection for critical intents; `TaskDomainGate` keeps `question`/`inspect` in free mode |
| **CheckpointEngine v2** | `runtimeV2` layered on the same `{sessionId}.checkpoint.json` |
| **Dual-mode Supervisor** | **Partially shipped**: `loadHarnessSupervisorRuntime` in `chat`/`run`/WebSocket paths; `ModeController`, `ModeDecisionEngine`, `ToolGate`, execution-mode constraints wired into Harness; full spec in [`docs/双模方案2.md`](./docs/双模方案2.md) |
| **Memory / compaction / sub-agent** | File-based memory, layered compaction, read-only sub-agent exploration |
| **Eval** | `npm run eval:agent` is still a metric skeleton (no full scoring runner yet) |

Verification:

```bash
npx tsc --noEmit
npm test
npm run eval:agent
```

Treat **`npm test`** as the source of truth for counts and pass/fail. The suite lives under `test/**/*.test.ts` (on the order of **60+** test files; case counts drift as tests are added).

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
      -> GraphExecutor (TaskGraph) + TaskCheckpointManager / CheckpointEngine
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
  coarse keyword memory recall (pre-LLM, up to 3 files)
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

### TaskGraph (replaces Execution Transparency Layer)

The Harness loop integrates **TaskGraph** as the **sole context injection source** for LLM prompts (Phase 11–13). TaskGraph replaces the legacy Execution Transparency Layer (ETL).

- **Generation**: `buildGraph()` (`task-graph-builder.ts`) constructs a multi-step task graph from intent snapshots; `GraphExecutor` (`task-graph-executor.ts`) manages graph lifecycle, node context injection, tool call validation, and round evaluation.
- **Context injection**: `GraphExecutor.getCurrentNodeContext()` returns the **only** structured context appended to LLM prompts — no other execution plan data enters the model. Non-critical intents (`question`, `inspect`, `explain`) skip graph initialization via **TaskDomainGate** (`shouldUseTaskGraph()` in `task-graph-config.ts`), preserving free-mode operation.
- **Events**: Graph lifecycle emits **`task_graph_init`** / **`task_graph_node`** / **`task_graph_branch`** / **`task_graph_done`** on the `HarnessStepEvent` channel. Legacy `execution_plan_*` event types are retained for frontend compatibility only.
- **Persistence**: Legacy checkpoint `plan` field and `ExecutionPlan` types have been removed (Phase 11). TaskGraph state persists through `checkpoint-engine.ts` `runtimeV2` field.

Key files:
- `src/types/task-graph.ts` — core graph data model
- `src/types/task-graph-view.ts` — UI view model types
- `src/harness/task-graph.ts` — graph state machine
- `src/harness/task-graph-builder.ts` — graph construction
- `src/harness/task-graph-executor.ts` — Harness integration bridge
- `src/harness/task-graph-review.ts` — contract validation, deviation detection, failure classification
- `src/harness/task-graph-config.ts` — TaskDomainGate (`shouldUseTaskGraph`)

### CheckpointEngine (Runtime Resilience v2)

`CheckpointEngine` (`src/harness/checkpoint-engine.ts`) wraps the existing **`TaskCheckpointManager`** writes for the **same** `{sessionId}.checkpoint.json` file:

- **`TaskCheckpoint`** (v1) fields remain authoritative for resumes and tooling; **`runtimeV2`** is an **additive** sibling object for richer telemetry-style history (recent tools, failures, recovery signals, **branch budget** snapshots via `branch-budget.ts`).
- Older files without `runtimeV2` still load cleanly; saves merge v1 + v2 without conflicting renames (`checkpointPersistTail` serializes writes in Harness).
- Triggers mirror the long-session design (step/tool/verification/compaction milestones — see `docs/requirement/长时间连续工作-finish.md`).

### Dual-mode Supervisor

Optional **Supervisor** regulation for engineering intents (`edit`, `debug`, `test`, `refactor`):

| Mode | `config.json` `supervisorMode` / `supervisor-config.json` `mode` | Summary |
|------|--------------------------------------|---------|
| **off** | `off` (Harness fallback when config not injected) | No supervision decision chain |
| **adaptive** | `adaptive` (default in `supervisor-config.example.json`) | Switches between free and takeover segments by risk signals |
| **strict** | `strict` | Strong constraints; `executionModeFloor` = `forced` |

- **Loading**: `loadHarnessSupervisorRuntime()` from `chat`, `run`, `chat-ws`, `remote-ws`; **mode** is stored in **`data/config.json`** field **`supervisorMode`** (Web nav tri-state toggle); advanced params stay in `supervisor-config.json`; failures **degrade to off**.
- **Env (Global layer only)**: `ICE_SUPERVISOR_SHADOW` overrides shadow; `ICE_SUPERVISOR_CONFIG_PATH` points at supervisor params file.
- **Web UI**: tri-state **Free / Adaptive / Strict** button left of the theme toggle (`PATCH /api/config/supervisor-mode`).
- **Shadow**: `ICE_SUPERVISOR_SHADOW=1` runs evaluation without mutating `supervisorPhase`.
- **Spec**: [`docs/双模方案2.md`](./docs/双模方案2.md) (V1.3.7); template: [`data/supervisor-config.example.json`](./data/supervisor-config.example.json).
- **Env vars**: `ICE_SUPERVISOR_SHADOW`, `ICE_SUPERVISOR_CONFIG_PATH` — see [`docs/environment-variables.md`](./docs/environment-variables.md) §4.
- **Implementation gaps**: [`docs/双模落地缺口.md`](./docs/双模落地缺口.md) — missing modules and features for the full dual-mode stack.

#### `~supervisor` chat command (Supervisor events report)

The Web chat input supports **`~supervisor`** (type `~` for the command palette). It aggregates **L2 Timeline** events and **Execution Mode** enter/exit records — same behavior as `GET /api/supervisor/events`.

| Argument | Description | Default |
|----------|-------------|---------|
| (none) | Markdown text report for the last 7 days | — |
| `days=N` | Include JSONL events from the last **N** days (**1–90**) | `7` |
| `event=<type>` | Filter Timeline events by type | none (all types) |
| `limit=N` | Show the **N** most recent Timeline rows at the end of the report (**1–50**) | `10` |

Arguments are space-separated `key=value` pairs after the command name and can be combined.

**Examples:**

```text
~supervisor
~supervisor days=3
~supervisor event=recover
~supervisor days=7 limit=20
~supervisor days=14 event=failure limit=15
```

**Valid `event=` values** (`SupervisorTimelineEventType`): `switch`, `recover`, `rollback`, `handoff`, `failure`, `drift`, `timeout`, `shadow_diagnostic`.

**HTTP equivalents:**

- Text report (JSON wrapper with `report` field): `GET /api/supervisor/events?days=7&limit=10`
- Structured JSON: `GET /api/supervisor/events?days=7&event=recover&format=json` (`format=json` is HTTP-only; the chat command always returns the text report)

**Data sources:**

- L2 Timeline: `data/runtime/supervisor-events.jsonl` (matches `persistPath` in `supervisor-config.json`)
- Execution Mode enter/exit: `execution_mode_enter` / `execution_mode_exit` in `data/runtime/telemetry.jsonl`

The report includes recent forced-mode entries (`primaryReasonHuman`, `enteredBy` signals), Timeline aggregates, and recent detail rows capped by `limit`.

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

### Recall Flow (dual-phase)

Memory injection runs in **two phases** inside `HarnessMemoryIntegration` (`src/harness/harness-memory.ts`):

| Phase | When | LLM? | `recallPhase` telemetry |
|-------|------|------|-------------------------|
| **Coarse pre-LLM** | Before every main LLM call (`harness.ts`) | **No** — `llmAdapter` is passed as `null` | `coarse_pre_llm` |
| **Standard** | After tool rounds, before the next LLM call | **Maybe** — see gates below | `standard` |

Coarse recall returns up to **3** files via keyword/TF-IDF only (fast, ~3s typical). It does **not** set `injectedForCurrentMessage`, so standard recall can still run after tools.

Standard recall pipeline (`src/memory/file-memory/memory-recall.ts`):

```text
query
  -> scan project + user memory dirs (scanner cache)
  -> exclude alreadySurfaced paths (cross-turn dedup)
  -> confidence filter (>= 0.3)
  -> intent / level filter (execute vs inspect vs question)
  -> dedupe conflicting memories
  -> FactIndex build/cache
  -> if llmAdapter AND filtered candidates >= 4 (LLM_RECALL_MIN_CANDIDATES):
        LLM select files + rank facts (30s timeout) -> usedLLM: true
     else OR empty LLM result OR timeout/error:
        keyword fallback (TF-IDF, negation expansion, time-range boost) -> usedLLM: false
  -> related-memory expansion (1-hop, max 3)
  -> Harness: optional LLM rerank if candidates > 2 * finalK
  -> relevance gate (keyword overlap; LLM rescue if pass rate low)
  -> execution-intent filter + token budget filter
  -> CoN + JSON prompt injection
```

**Why telemetry may show 0% LLM recall:** coarse events always count as keyword; with a **small memory library** (e.g. &lt; 15 files), `alreadySurfaced` often leaves **&lt; 4** candidates so the LLM branch is skipped; harness **rerank** uses LLM but does **not** set `usedLLM` on recall events. See `GET /api/memory/telemetry` and `data/memory/telemetry.jsonl`.

**Key constants:** `LLM_RECALL_MIN_CANDIDATES = 4`, `CONFIDENCE_FILTER_THRESHOLD = 0.3`, standard recall cooldown default **5 min** (`ICE_STANDARD_RECALL_COOLDOWN_SEC`, `0` disables). Remote overrides: `data/memory/memory-config.json` (hot-reloaded).

Recent changes tightened memory behavior:

- Recall prompt now uses strict relevance rather than broad inclusion.
- Coding/debugging tasks prefer project facts and technical constraints.
- Personal preferences are injected only when strongly relevant.
- Extraction prompt now prefers fewer high-confidence memories over noisy long-term memory.
- Weak one-off signals should remain session state, not persistent memory.

### Dream Consolidation & Eviction

`src/memory/file-memory/memory-dream.ts` runs a periodic "dream" process (analogous to human sleep consolidation) that reviews, deduplicates, and prunes memories. Triggers:

- Session threshold (local default every **5** sessions; remote `minSessions` default **3** in `data/memory/memory-config.json`)
- File count threshold (default **10** files, `DEFAULT_DREAM_CONFIG.fileCountThreshold`)
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

### Memory telemetry

- **Process + JSONL:** `src/memory/file-memory/memory-telemetry.ts` writes `memory_recall` / `memory_extract` / `memory_dream` events; default log path `data/memory/telemetry.jsonl`.
- **HTTP:** `GET /api/memory/telemetry` aggregates recent days (LLM vs keyword recall rate, extract cache hits, Dream stats, store file counts).
- **Recall metrics:** `usedLLM` reflects only `recallRelevantMemories()` — not harness rerank or relevance-gate rescue LLM calls.

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

See [`docs/nextWork.md`](./docs/nextWork.md) for the next implementation steps.

---

## Web app, API, and ports

- **HTTP server** (`src/index.ts`, `src/web/server.ts`): default port **`1024`** when started via `tsx src/index.ts` / `npm run dev:api`. Serves the built SPA static assets in production; in development it still hosts API routes while the Vite dev server serves the UI.
- **CLI `web` / `start` / `chat`**: default port **`3784`** unless `PORT` or `--port` is set (`src/cli/commands/serve.ts`, `chat.ts`).
- **Vite dev UI** (`vite.config.ts`): default **`1025`**, proxies `/api` and WebSocket upgrade to `http://localhost:1024`.
- **WebSocket chat**: attached to the HTTP server (`src/web/chat-ws.ts`); mobile/remote clients can use `/api/remote` and related routes.
- **Notable API mounts**: `/api/config`, `/api/tools`, `/api/remote`, `/api/sessions`, `/api/chat/upload`, `/api/memory/*` (telemetry report, file CRUD, recall test/export), `/api/supervisor/events` (Supervisor / Execution Mode events report — see **`~supervisor`** under Dual-mode Supervisor).
- **Frontend** lives under `src/public/` (e.g. chat UI scripts, Ice Bean indicator). Production build output: `dist/public/`.

LLM provider settings are read from **`data/config.json`** by default (see `data/config.example.json`). The server can **watch** that file and reload providers without a full restart (`src/index.ts`).

### Ice Bean (session indicator, Web UI)

The **chat page** embeds an optional **Ice Bean** (Chinese display name **冰豆**, `SESSION_PET_DISPLAY_NAME` in `session-pet-palette.js`): a small canvas-based indicator that reflects runtime activity **without** changing Harness or backend logic.

| | |
|---|---|
| **Rendering** | ~120×120 logical px, dark body, capsule eyes; eye color is picked once per load from `session-pet-palette.js` (decorative, not tied to token %). |
| **Token ring** | Outer arc from top, clockwise — approximate **context / token usage** ratio (green → yellow → red). |
| **Expressions** | Many (~20) named visual states (e.g. thinking, idle, tool/memory hints) driven by **`ChatPetBridge`** from WebSocket `HarnessStepEvent`-style updates in `chat-page.js`. |
| **Interaction** | Drag to reposition (saved under `localStorage` key `ice-session-pet-position`); double-click resets placement. Canvas `aria-label` is built via `buildSessionPetCanvasAriaLabel` (starts with 冰豆). |
| **Key files** | `src/public/js/session-pet.js`, `session-pet-palette.js`, `chat-pet-bridge.js`; styles under `src/public/css/style.css`; wired in `chat-page.js` / `main.js`. |
| **Demo** | `src/public/pet-expressions-demo.html` + `pet-expressions-demo.js` for manual expression checks. |
| **Tests** | `test/public/session-pet-palette.test.ts`, `session-pet-expression-cycle.test.ts`. |

CLI-only workflows do **not** include Ice Bean; it is a **browser UX** affordance for the SPA chat.

---

## MCP (Model Context Protocol)

`src/mcp/mcp-manager.ts` reads **`mcpServers`** from **`.iceCoder/mcp.json`** under the current working directory (override with **`ICE_MCP_CONFIG_PATH`**). Shape matches common MCP configs: top-level `mcpServers` object. When a server starts successfully, its tools are **registered into the main `ToolRegistry`** alongside builtins (prefixed `mcp_{serverName}_{toolName}`). Failures are logged but do not block core startup. See **`.iceCoder/mcp.example.json`** for a template. CLI: `iceCoder mcp` for status.

**Note:** LLM provider settings stay in `data/config.json` (or `ICE_CONFIG_PATH`); MCP is intentionally separate.

---

## Configuration and environment variables

Full documentation for **every** process environment variable and the browser `localStorage` key (purpose, valid values, defaults, code locations, `.env` template):

**[`docs/environment-variables.md`](./docs/environment-variables.md)** (detailed Chinese: [`docs/环境变量.md`](./docs/环境变量.md))

Quick reference:

| Variable | Role | Default | Valid values |
|----------|------|---------|--------------|
| `ICE_DATA_DIR` | CLI data root | `./data` or `~/.iceCoder` | directory path |
| `ICE_CONFIG_PATH` | LLM provider config | `{dataDir}/config.json` | file path |
| `PORT` | HTTP port | CLI **3784** / `index.ts` **1024** | port number |
| `config.json` → `supervisorMode` | Dual-mode supervisor | `adaptive` | `off` \| `adaptive` \| `strict` |
| `ICE_CONTEXT_WINDOW` | Context token cap | provider → **128000** | positive integer |
| `ICE_EVAL_MODE` | Eval mode (skip extraction, etc.) | off | `1` |
| `ICE_MCP_CONFIG_PATH` | MCP config | `<cwd>/.iceCoder/mcp.json` | file path |

**40+** process variables total. Removed vars (`ICE_HARNESS_TOKEN_BUDGET`, `ICE_HARNESS_TIMEOUT_*`, etc.) are listed in the doc. Browser `ICE_PLAN_PANEL=0` in `localStorage` hides the task-graph panel.

---

## Repository layout (concise)

```text
src/
  cli/              # CLI entry, bootstrap, commands (web, run, config, mcp, …)
  core/             # Orchestrator (shared file parser + LLM adapter)
  harness/          # Harness, compaction, task/repo state, TaskGraph, sub-agent, tool planner,
                    # checkpoint + CheckpointEngine v2, branch budget, supervisor/*
  llm/              # OpenAI / Anthropic adapters
  memory/file-memory/  # File-based memory, session notes, dream, eviction
  parser/           # FileParser strategies (HTML, Office, XMind)
  prompts/          # Prompt assembly
  tools/            # Builtin tools, registry, executor
  mcp/              # MCP client manager
  web/              # Express server, routes, WebSocket chat
  public/           # Vite root: chat UI, Ice Bean (canvas + bridge), static assets
  types/            # Shared types (runtime snapshot, task-graph, runtime-checkpoint schema)
docs/               # Requirements archives, memory benchmarks, dual-mode specs, nextWork
test/               # Vitest suites mirroring src areas
data/               # Provider config templates, sessions, optional MCP-side memory sample
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

## Design documentation

Higher-level prose (beyond this README):

- [`docs/environment-variables.md`](./docs/environment-variables.md) — **full environment variable reference** (purpose, valid values, defaults)
- [`docs/环境变量.md`](./docs/环境变量.md) — 环境变量（中文详版）
- [`docs/nextWork.md`](./docs/nextWork.md) — active roadmap and eval gaps
- [`docs/requirement/任务图规划-finish.md`](./docs/requirement/任务图规划-finish.md) — TaskGraph / StepGraph design (implemented core)
- [`docs/requirement/执行透明-finish.md`](./docs/requirement/执行透明-finish.md) — legacy Execution Transparency Layer (superseded by TaskGraph)
- [`docs/requirement/长时间连续工作-finish.md`](./docs/requirement/长时间连续工作-finish.md) — long sessions & checkpoint triggers
- [`docs/requirement/记忆系统调整-finish.md`](./docs/requirement/记忆系统调整-finish.md) — memory system adjustments
- [`docs/双模方案2.md`](./docs/双模方案2.md) — dual-mode supervisor spec **V1.3.7** (I10 forced min dwell, signal precedence, enteredBy telemetry)
- [`docs/运行时后续优化.md`](./docs/运行时后续优化.md) — Phase **5E** follow-up (benchmark / Learning; deferred)
- [`docs/locomo/memory-optimization-roadmap.md`](./docs/locomo/memory-optimization-roadmap.md) — memory benchmark & recall tuning notes

---

## Roadmap

The remaining work is tracked in [`docs/nextWork.md`](./docs/nextWork.md). Representative next items:

1. Memory v2 structured levels and conflict arbitration
2. Deeper compaction / session-notes integration (token accounting, tighter recovery budgets) — `icecoder-runtime` snapshots already exist
3. A real eval runner with pass/fail scoring (`scripts/eval-runner.ts` exists; `npm run eval:agent` is still a skeleton)
4. Telemetry persistence for runtime metrics
5. **Dual-mode supervisor** — core path wired; continue spec completion, telemetry, and edge cases per [`docs/双模方案2.md`](./docs/双模方案2.md)
6. Stronger adaptive planning beyond the intent-based tool planner (see TaskGraph requirement docs)
