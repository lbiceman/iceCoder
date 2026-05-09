# iceCoder

iceCoder is an AI coding agent runtime for local repositories. It combines a tool-using Harness loop, file-based long-term memory, session memory for compaction recovery, prompt assembly, and CLI/Web/Remote interfaces.

The project goal is not only to chat with an LLM. The goal is to run a software-engineering agent that can understand a task, inspect a repository, edit files, run verification, recover from failures, preserve useful memory, and continue long sessions without losing state.

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
- A minimal `npm run eval:agent` skeleton defines future Agent Runtime metrics.

Verification:

```bash
npx tsc --noEmit
npm test
npm run eval:agent
```

Current verified baseline:

- 33 test files passed
- 560 tests passed
- No new npm dependencies were added for the runtime improvements

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

Key runtime protections:

- No-tool recovery for executable tasks
- Verification gate after file-changing tools
- Permission rules before tool execution
- Confirmation-required tools are denied if no confirmation callback exists
- Repeated failed tool signature detection
- Consecutive failure circuit breaker
- Context compaction and post-compaction Runtime Recovery Context

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

---

## Task State and Repo Context

Task State v1 and RepoContext v1 are the current bridge toward a stronger Agent Runtime.

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

## Agent Evaluation

A minimal eval skeleton exists:

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

## Development

```bash
npm install
npm test
npx tsc --noEmit
npm run eval:agent
```

Common commands:

```bash
npm run dev
npm run dev:api
npm run dev:web
npx tsx src/cli/index.ts run "fix failing tests"
```

---

## Roadmap

The remaining work is tracked in `nextWork.md`. The next high-impact items are:

1. Memory v2 structured levels and conflict arbitration
2. persisted Runtime Recovery Context in session notes
3. real Agent Eval runner with pass/fail scoring
4. telemetry persistence for runtime metrics
5. model-aware tool planning and recovery strategies
