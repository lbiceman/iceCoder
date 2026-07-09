# iceCoder — Project Guide

> Full project introduction. For a quick overview, see [README](../README.md).

iceCoder is a **tool-using LLM runtime** for local repositories: a Harness loop with tools, **TaskGraph** (sole structured execution context source — replaces the legacy Execution Transparency Layer), resilient **checkpoint** persistence (`CheckpointEngine` v2 on the same JSON file), optional **dual-mode Supervisor** (`off` / `adaptive` / `strict`), file-based long-term memory, **Agent Skills**, session memory for compaction recovery, prompt assembly, and **CLI / Web / WebSocket / Mobile H5** entrypoints (plus optional MCP tools).

**Stack:** Node.js 22+, TypeScript, Express (API + static SPA in production), Vite (dev UI on a separate port), WebSocket chat, Vitest.

The goal is not only to chat with a model, but to run a **software-engineering assistant** that can understand a task, inspect a repository, edit files, run verification, recover from failures, preserve useful memory, and continue long sessions without losing state.

**Removed (no longer in tree):** the legacy **multi-stage pipeline** and per-stage **Agent** classes (`BaseAgent`, `executePipeline`, stage reports, etc.). The `Orchestrator` is now a thin holder for `FileParser` + `LLMAdapter` shared by the WebSocket chat path.

[中文项目介绍](./项目介绍.md) | [环境变量](./环境变量.md) | [Next Work](./nextWork.md)

---

## Current Status

| Area | Status |
|------|--------|
| **Harness core** | Tool execution, permissions (`allow`/`confirm`/`deny`), Task State v1, RepoContext v1, verification gate, no-tool recovery, repeat-failure detection |
| **TaskGraph** | Sole structured context injection for critical intents; `TaskDomainGate` keeps `question`/`inspect` in free mode |
| **CheckpointEngine v2** | `runtimeV2` layered on the same `{sessionId}.checkpoint.json` |
| **Dual-mode Supervisor** | **L2 largely validated** — L1/L2 wired; 15 Web manual scenarios in **Testing & validation**; spec [`docs/双模方案2.md`](./双模方案2.md) |
| **Memory system** | File-based long-term memory + session notes + Dream/eviction; **20** test files **~391** cases — see **Memory System** |
| **Agent Skills** | Markdown skills in `ICE_SKILLS_DIR`; Web Skills page + chat `#` injection; `/api/skills` — see **Agent Skills** |
| **Workspace & file browser** | Per-session workspace lock; `@` refs + `/api/workspace/browse`; `list_drives` / `browse_directory` / `open_file`; `~open` direct listing |
| **Mobile H5 Shell** | `#/m/*` routes; bottom tabs + session drawer; shared JS Core with desktop — see **Web app** |
| **Ice Bean (pet UI)** | Web Canvas session indicator; L0 eye color + L1 forced chip + ~20 expressions — see **Web app** |
| **Diff Viewer** | Git-style inline diff for edit/patch tool output in Web chat |
| **Shell dual-track** | `run_command` runtime classifier: long jobs → background, short → foreground with soft-timeout escalate |
| **Setup gate** | Web serves config-only until valid API key; dev `./data/` vs prod `~/.iceCoder/` — see README |
| **Eval** | `npm run eval:agent` — Agent behavior regression (7 fixed cases, temp sandbox, Harness pass/fail); TaskGraph metrics via `scripts/eval-runner.ts` |

Verification:

```bash
npx tsc --noEmit
npm test
npm run eval:agent
```

Treat **`npm test`** as the source of truth. Baseline (2026-07-01): **~221** test files, **~2,000+** cases. Full breakdown in **Testing & validation** below.

---

## Runtime Architecture

```text
User / CLI / Web / Mobile H5 / Remote
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

### Dual-mode Supervisor (V1.3.7)

Spec: [`双模方案2.md`](./双模方案2.md) · Manual playbook: [`test.md`](./test.md) · Flow chart: [`双模 L2 流程图.md`](./双模%20L2%20流程图.md)

Dual-mode separates **user-selected supervision tier** from **runtime execution constraints**:

```text
L0 Policy tier (config.json · supervisorMode)
  off / adaptive / strict          ← Web nav · Ice Bean eye color
        ↓
L1 Execution mode (Harness · executionMode)
  free ↔ forced                    ← Ice Bean bottom forced · … chip
  ModeController · ToolGate · TaskGraph · branchBudget
        ↓
L2 Runtime supervision (SupervisorRuntimeBridge)
  PassiveObserver · GoalDriftDetector · RecoverySupervisor
  CorrectionPort · RecoveryBoundary · EventTimeline → supervisor-events.jsonl
```

| Layer | Key modules | Role |
|-------|-------------|------|
| **L0** | `mode-controller.ts` · `supervisor-config.ts` | Load tier + global policy; degrade to `off` on failure |
| **L1** | `execution-mode-constraints.ts` · `tool-gate.ts` · `mode-decision-engine.ts` | Enter/exit forced by signals; strict floor = forced |
| **L1** | `task-graph-executor.ts` · `task-domain.ts` | Structured context; `inferTaskDomain()` → `critical_*` for takeover |
| **L2** | `passive-observer.ts` · `goal-drift-detector.ts` | `no_progress` / `file_loop` / `tool_repeat_fail` / `goal_drift` |
| **L2** | `recovery-supervisor.ts` · `correction-port.ts` · `recovery-boundary.ts` | takeover / handoff / graph_hint; I4 correction budget |
| **L2** | `event-timeline.ts` · `supervisor-bridge.ts` | Timeline persistence; round-level evaluate + checkpoint |

**L0 tiers**

| Mode | `supervisorMode` | Summary |
|------|------------------|---------|
| **off** | `off` | No supervision chain; TaskGraph panel may still appear |
| **adaptive** | `adaptive` (default) | Risk-based free ↔ forced; first-round graph off by default (§I3) |
| **strict** | `strict` | Strong constraints; first-round graph + forced; **L2-6 file_loop requires this** |

**Config & entrypoints**

- **Tier**: `data/config.json` → `supervisorMode` (Web nav · `PATCH /api/config/supervisor-mode`)
- **Params**: `data/supervisor-config.json` (template [`supervisor-config.example.json`](../data/supervisor-config.example.json))
- **Loading**: `loadHarnessSupervisorRuntime()` from `chat` / `run` / `chat-ws` / `remote-ws`
- **Shadow**: `ICE_SUPERVISOR_SHADOW=1` — evaluate without mutating `supervisorPhase`
- **Env vars**: [`docs/环境变量.md`](./环境变量.md) §4

**Recent fixes (2026-05-22):** `inferTaskDomain()` · `node --check` verification · `preserveOnCompaction` for recovery injects

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

中文版设计文档：[`前缀缓存优化方案`](./harness/Prompt-Caching-优化方案.md)（双轨上下文 + 封存裁剪，待实施；含实施难度、用户体验、缓存命中率、费用节约估算）。

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

iceCoder uses **file-based** persistent memory (no external DB). Core code: `src/memory/file-memory/` (**26** source files), integrated via `HarnessMemoryIntegration` (`harness-memory.ts`).

### Module map

| Module | Files | Role |
|--------|-------|------|
| Storage | `file-memory-manager.ts` | Project + user memory directories |
| Scan / index | `memory-scanner.ts` · `memory-fact-index.ts` | Directory scan, FactIndex cache |
| Recall | `memory-recall.ts` | Coarse + standard recall (keyword / LLM branches) |
| Extraction | `memory-llm-extractor.ts` | Post-turn LLM memory extraction |
| Security | `memory-secret-scanner.ts` · `memory-security.ts` | Secret scan, write gates |
| Dream | `memory-dream.ts` | Periodic consolidation / dedup / prune |
| Eviction | `memory-eviction.ts` | Weighted scoring eviction (not pure LRU) |
| Session notes | `session-memory.ts` | Structured `session-notes.md` |
| Telemetry | `memory-telemetry.ts` | `data/memory/telemetry.jsonl` + HTTP report |

### Memory types

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

### Memory tests

| Type | Files | Cases (~) | Coverage |
|------|-------|-----------|----------|
| Unit / integration | **20** | **~391** | recall, extract, Dream, eviction, security, concurrency |
| E2E | included | **9** in `memory-e2e.test.ts` | extract → write → recall |

Command: `npm test -- test/memory/` · Design: [`docs/requirement/记忆系统调整-finish.md`](./requirement/记忆系统调整-finish.md)

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

---

## Testing & validation

> Manual steps + copy-paste prompts: [`docs/test.md`](./test.md) · Dual-mode e2e: `test/e2e/dual-mode-scenarios.test.ts`

### Automated tests (Vitest)

**Baseline (2026-07-01):** **~221** test files · **~2,000+** cases · `npx tsc --noEmit` 0 errors

| Directory | Files | Notes |
|-----------|-------|-------|
| `test/harness/` | **90** | Harness loop, compaction, checkpoint, **full supervisor stack**, Shell dual-track |
| `test/memory/` | **20** | File memory recall / extract / Dream / eviction |
| `test/web/` | **19** | API, sessions, setup gate, supervisor-events, chat-ws |
| `test/tools/` | **14** | Shell classifier, background tasks, git, patch, parsers |
| `test/llm/` | **7** | Adapters, token counting |
| `test/public/` | **4** | Ice Bean palette, diff viewer |
| `test/e2e/` | **1** | **7** dual-mode scenarios A–F |
| Other | **~18** | parser, cli, core, prompts, config |

```bash
npx tsc --noEmit
npm test
npm test -- test/harness/supervisor-bridge.test.ts    # 53 cases
npm test -- test/harness/recovery-boundary.test.ts    # 13 cases
npm test -- test/e2e/dual-mode-scenarios.test.ts      # 7 cases
npm test -- test/memory/
ICE_SUPERVISOR_MODE=off npm test -- test/harness/harness.test.ts
```

> If `data/config.json` has `supervisorMode: strict` left over from manual L2-6 runs, **2** cases in `mode-controller.test.ts` may fail until restored to `adaptive`.

### End-to-end (dual-mode · P2-2)

File: `test/e2e/dual-mode-scenarios.test.ts` — **7** cases:

| # | Scenario | Mode | Assertion |
|---|----------|------|-----------|
| A | Read-only | adaptive | Stays `free`, no enter |
| B | Small edit | adaptive | No first-round graph, may stay `free` |
| C | New module | strict | First-round graph → `forced` |
| D | Multi-file refactor | strict | `forced` + modeLock |
| E | Checkpoint resume | adaptive | `checkpoint_resumed` → `forced` |
| F | Graph build failure | adaptive | degraded forced |
| F′ | Graph build failure | strict | First-round init error path |

### Manual Web tests (2026-05-22)

Environment: Web chat · Windows · models z-ai/glm-5.1 / minimax-m2.5 · see [`docs/test.md`](./test.md) §10–§11

**L1 execution mode — scenarios A–H (8)**

| Scenario | Mode | Result |
|----------|------|--------|
| A read-only | adaptive | ✅ |
| B single-file edit | adaptive | ✅ |
| C multi-file create | adaptive | ✅ |
| D strict graph | strict | ✅ |
| E checkpoint | adaptive | ✅ |
| F tool failures | adaptive | ⚠️ L1 ✅; L2 logs `tool_repeat_fail` not `no_progress` |
| G off control | off | ✅ |
| H long session | adaptive | ✅ |

**L2 supervision signals — L2-1–L2-7 (7)**

| Scenario | Mode | Result |
|----------|------|--------|
| L2-1 no_progress | adaptive | ✅ |
| L2-2 goal_drift | adaptive | ✅ |
| L2-3 tool_repeat_fail | adaptive | ✅ |
| L2-4 lifecycle | adaptive | ⚠️ conditional (Timeline OK; chat bubble may be hidden) |
| L2-5 graph_hint | **strict** | ✅ best (30+ `recover · graph_hint`) |
| L2-6 file_loop | **strict** | ✅ strict ×2; adaptive R5 exit → not triggered |
| L2-7 takeover | adaptive + stacked signals | ✅ automation; **Web full chain pending** |

**Manual total:** **15** Web scenarios (8 + 7) · **13 passed** · **2 partial/pending** (F signal semantics, L2-4 / L2-7 Web)

### Release gate

1. `npx tsc --noEmit` — 0 errors  
2. `npm test` — all green (default config)  
3. `ICE_SUPERVISOR_MODE=off` — harness suites zero regression  
4. After `supervisor/` changes: rerun `dual-mode-scenarios` + `supervisor-bridge` + `recovery-boundary`

---

## Runtime evaluation (eval harness)

**Agent Eval Runner** (`npm run eval:agent`, `scripts/agent-eval.ts`):

```bash
npm run eval:agent                              # default real — configured LLM required
npm run eval:agent -- --mode=mock               # no-API smoke
npm run eval:agent -- --case=single-file-edit
npm run eval:agent -- --format=markdown --keep-workspaces
```

- Case definitions: `scripts/agent-eval-cases.ts` (7 fixed scenarios).
- Runner: `scripts/agent-eval-runner.ts` — `mkdtemp` sandbox, `initializeToolSystem`, `Harness.run`, rule-based scoring.
- History: `data/eval/agent-eval-history.jsonl`.
- Non-zero exit when any case fails or P0 metrics regress.

Metrics per case and aggregate:

- task_success_rate
- tool_call_rate
- first_tool_latency
- no_tool_final_rate
- verification_rate
- repeat_failure_rate
- memory_interference_rate
- tokens_per_successful_task
- compaction_saved_tokens

**TaskGraph eval** (separate): `npx tsx scripts/eval-runner.ts` — graph completion / node scores from benchmark fixtures.

Remaining eval work (CI gate, trend dashboards): [`docs/nextWork.md`](./nextWork.md) §3–§4.

---

## Web app, API, and ports

- **HTTP server** (`src/index.ts`, `src/web/server.ts`): default port **`1024`** when started via `tsx src/index.ts` / `npm run dev:api`. Serves the built SPA static assets in production; in development it still hosts API routes while the Vite dev server serves the UI.
- **CLI `web` / `start` / `chat`**: default port **`3784`** unless `PORT` or `--port` is set (`src/cli/commands/serve.ts`, `chat.ts`).
- **Vite dev UI** (`vite.config.ts`): default **`1025`**, proxies `/api` and WebSocket upgrade to `http://localhost:1024`.
- **WebSocket chat**: attached to the HTTP server (`src/web/chat-ws.ts`); mobile/remote clients use `/api/remote` and related routes.
- **Desktop routes**: `#/chat`, `#/memory`, `#/skills`, `#/config` — left sidebar shell.
- **Mobile H5 routes**: `#/m/work`, `#/m/work/:sessionId`, `#/m/memory`, `#/m/skills`, `#/m/config` — bottom tab shell (`src/public/js/shell/mobile-shell.js`).
- **Notable API mounts**: `/api/config`, `/api/tools`, `/api/remote`, `/api/sessions`, `/api/skills`, `/api/workspace/browse`, `/api/chat/upload`, `/api/memory/*` (telemetry report, file CRUD, recall test/export), `/api/supervisor/events` (Supervisor / Execution Mode events report — see **`~supervisor`** under Dual-mode Supervisor).
- **Frontend** lives under `src/public/` (chat UI, Skills/Memory pages, Ice Bean, mobile pages). Production build output: `dist/public/`.

LLM provider settings are read from **`data/config.json`** by default (see `data/config.example.json`). The server can **watch** that file and reload providers without a full restart (`src/index.ts`).

### UI screenshots

Full gallery: [README § Preview](../README.md#preview) · [README.zh-CN § 界面预览](../README.zh-CN.md#界面预览).

**Desktop**

![Work chat](./assets/desktop-work-chat.png)

![Memory graph](./assets/desktop-memory-graph.png)

![Skills library](./assets/desktop-skills.png)

![MCP settings](./assets/desktop-config-mcp.png)

![Remote QR (~scan)](./assets/desktop-remote-scan.png)

**Mobile H5**

![Mobile work chat](./assets/mobile-work-chat.png)

![Mobile skills](./assets/mobile-skills.png)

![Mobile MCP settings](./assets/mobile-config-mcp.png)

### Ice Bean (session pet / Web indicator)

The **chat page** embeds **Ice Bean** (display name **冰豆**, `SESSION_PET_DISPLAY_NAME`): a Canvas-based indicator mapping Harness runtime state to **expressions, bubbles, and a token ring** — decoupled from backend logic.

**Architecture**

```text
WebSocket HarnessStepEvent
  → chat-page.js
  → ChatPetBridge (chat-pet-bridge.js)
       ├─ SessionPet (session-pet.js)        Canvas render · expression FSM
       ├─ session-pet-palette.js             Eye / ring colors
       └─ ChatExecutionPlan                  forced · … chip · graph progress
```

| | |
|---|---|
| **Look** | ~120×120 px; **eye color = L0 tier** (off `#88EDC7` / adaptive `#86E0FF` / strict `#F1A8B2`) |
| **Token ring** | Context usage arc (green → yellow → red) via `eyeColorForTokenPct()` |
| **Foot label** | `forced · …` (L1) · graph step summary · turn count |
| **Expressions** | ~**20** states (thinking, tools, memory, MCP, tunnel, **L3 force_switch**, etc.) |
| **Dual-mode link** | Nav tier change → bubble「当前模式：…」; `graph_hint force_switch` → L3 pet bubble |
| **Interaction** | Drag (`localStorage` `ice-session-pet-position`) · double-click reset · `aria-label` |
| **Sources** | `session-pet.js` · `session-pet-palette.js` · `chat-pet-bridge.js` · `style.css` |
| **Demo** | `pet-expressions-demo.html` — manual expression QA |
| **Tests** | **2** files · **12** cases: `session-pet-palette.test.ts` · `session-pet-expression-cycle.test.ts` |

CLI-only workflows have **no Ice Bean**; it is a browser UX layer only.

### Agent Skills

Skills are **Markdown playbooks** stored only under **`ICE_SKILLS_DIR`** (default `{dataDir}/skills`, set in `src/cli/paths.ts`).

| Layer | Role |
|-------|------|
| **`src/skills/skill-loader.ts`** | Scan root `.md` + one-level `folder/skill.md`; parse frontmatter; `#` ref parsing |
| **`src/core/skill-registry.ts`** | Disk + builtin registry; `resolveMessage()` injects bodies; creation-guide when user asks to author skills |
| **`src/web/routes/skills.ts`** | `GET/DELETE /api/skills` |
| **`src/public/js/skills-page.js`** | Desktop Skills tab UI |
| **`src/public/js/chat-skills.js`** | Composer `#` dropdown + chip bar |

Chat send path (`chat-ws.ts`) resolves `#skill.md` references before Harness runs. Bundled template: `data/skills/创建技能.md` (copied on first install).

### Workspace references & system filesystem browser

| Feature | Implementation |
|---------|----------------|
| **Per-session workspace** | `{sessionId}.workspace.json` via `session-workspace-store.ts`; exposed on `/api/sessions` |
| **`@` file refs** | `chat-file-ref.js` + `GET /api/workspace/browse` (`workspace-browse.ts`) |
| **System browser tools** | `list_drives`, `browse_directory`, `open_file` in `filesystem-browser-tool.ts` — paths outside repo/workdir |
| **`~open` direct listing** | `file-browser-direct.ts` executes real `browse_directory` server-side before LLM answers |

Uploads and paste images remain in `chat-file.js` (`/api/chat/upload`).

### Mobile H5 Shell

Same `index.html` / `main.js` bundle as desktop. Route prefix **`#/m/`** selects `MobileShell` instead of the left sidebar.

| Route | Page |
|-------|------|
| `#/m/work` | Dashboard + composer + session drawer |
| `#/m/work/:sessionId` | Full-screen chat (对话 / 文件 / 技能 sub-tabs) |
| `#/m/memory` | Memory wrapper |
| `#/m/skills` | Skills wrapper |
| `#/m/config` | Config + setup gate |

Core modules (`chat-session-store.js`, `chat-websocket.js`, `chat-skills.js`, etc.) are shared; only shell DOM differs. Spec: [`requirement/移动端H5-Shell方案.md`](./requirement/移动端H5-Shell方案.md).

---

## MCP (Model Context Protocol)

`src/mcp/mcp-manager.ts` reads **`mcpServers`** from **`.iceCoder/mcp.json`** under the current working directory (override with **`ICE_MCP_CONFIG_PATH`**). Shape matches common MCP configs: top-level `mcpServers` object. When a server starts successfully, its tools are **registered into the main `ToolRegistry`** alongside builtins (prefixed `mcp_{serverName}_{toolName}`). Failures are logged but do not block core startup. See **`.iceCoder/mcp.example.json`** for a template. CLI: `iceCoder mcp` for status.

**Note:** LLM provider settings stay in `data/config.json` (or `ICE_CONFIG_PATH`); MCP is intentionally separate.

---

## Configuration and environment variables

Full documentation for **every** process environment variable and the browser `localStorage` key (purpose, valid values, defaults, code locations, `.env` template):

**[`docs/环境变量.md`](./环境变量.md)** — full reference (Chinese)

Quick reference:

| Variable | Role | Default | Valid values |
|----------|------|---------|--------------|
| `ICE_DATA_DIR` | CLI data root | `./data` or `~/.iceCoder` | directory path |
| `ICE_CONFIG_PATH` | LLM provider config | `{dataDir}/config.json` | file path |
| `ICE_SKILLS_DIR` | Agent skill Markdown files | `{dataDir}/skills` | directory path |
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
  harness/          # Harness, compaction, task/repo state, TaskGraph, task-domain, sub-agent, tool planner,
                    # checkpoint + CheckpointEngine v2, branch budget, supervisor/*
  llm/              # OpenAI-compatible adapters
  memory/file-memory/  # File-based memory (26 modules), session notes, dream, eviction
  skills/             # skill-loader, SkillRegistry helpers
  parser/           # FileParser strategies (HTML, Office, XMind)
  prompts/          # Prompt assembly
  tools/            # Builtin tools (incl. filesystem browser), registry, executor
  mcp/              # MCP client manager
  web/              # Express server, routes, WebSocket chat, workspace browse
  public/           # Vite root: chat UI, Skills/Memory pages, mobile shell, Ice Bean
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

- [`docs/环境变量.md`](./环境变量.md) — **full environment variable reference** (purpose, valid values, defaults)
- [`docs/环境变量.md`](./环境变量.md) — 环境变量（中文详版）
- [`docs/nextWork.md`](./nextWork.md) — active roadmap and eval gaps
- [`docs/requirement/任务图规划-finish.md`](./requirement/任务图规划-finish.md) — TaskGraph / StepGraph design (implemented core)
- [`docs/requirement/执行透明-finish.md`](./requirement/执行透明-finish.md) — legacy Execution Transparency Layer (superseded by TaskGraph)
- [`docs/requirement/长时间连续工作-finish.md`](./requirement/长时间连续工作-finish.md) — long sessions & checkpoint triggers
- [`docs/requirement/记忆系统调整-finish.md`](./requirement/记忆系统调整-finish.md) — memory system adjustments
- [`docs/test.md`](./test.md) — **dual-mode test playbook** (~2,000+ automated + 15 manual Web scenarios)
- [`docs/双模方案2.md`](./双模方案2.md) — dual-mode supervisor spec **V1.3.7**
- [`docs/运行时后续优化.md`](./运行时后续优化.md) — Phase **5E** follow-up (benchmark / Learning; deferred)
- [`docs/locomo/memory-optimization-roadmap.md`](./locomo/memory-optimization-roadmap.md) — memory benchmark & recall tuning notes

---

## Roadmap

The remaining work is tracked in [`docs/nextWork.md`](./nextWork.md). Representative next items:

1. Memory v2 structured levels and conflict arbitration
2. Deeper compaction / session-notes integration (token accounting, tighter recovery budgets) — `icecoder-runtime` snapshots already exist
3. Eval CI gate + telemetry trend integration (`npm run eval:agent` Agent runner done; `scripts/eval-runner.ts` for TaskGraph)
4. Telemetry persistence for runtime metrics
5. **Dual-mode supervisor** — core path wired; continue spec completion, telemetry, and edge cases per [`docs/双模方案2.md`](./双模方案2.md)
6. Stronger adaptive planning beyond the intent-based tool planner (see TaskGraph requirement docs)
