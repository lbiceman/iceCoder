# iceCoder

**Autonomous coding agents break on long tasks.** They wander off-goal, loop the same tools, and finish without anyone noticing the work never landed.

**iceCoder is a self-hosted runtime governance layer for tool-using coding agents** — Harness loop, drift detection, adaptive/forced execution, checkpoint recovery, TaskGraph, file memory, 27 built-in tools, MCP, CLI, and Web UI.

[中文简介](./README.zh-CN.md) · [Full project guide](./docs/PROJECT-GUIDE.md) · [项目介绍](./docs/项目介绍.md)

---

## At a glance

| | |
|---|---|
| **Tests** | **1,340** cases · **117** files · **100%** pass (`npm test`, 2026-05-26) |
| **Coverage** | **75.6%** lines · **73.7%** statements · **76.9%** functions · **65.1%** branches (`npm run test:coverage`) |
| **Harness coverage** | **82.1%** lines · **79.8%** statements · **67** dedicated test files |
| **Source scale** | **~230** TypeScript/JS modules · **~47K** lines under `src/` · **95** Harness modules · **24** Supervisor modules |
| **Agent tools** | **27** registered tools (26 builtins + `delegate_to_subagent`) · **+ MCP** server tools at runtime |
| **Runtime stack** | TaskGraph · CheckpointEngine v2 · BranchBudget · Step Review · dual-mode Supervisor (L1/L2) · file memory (26 modules) |
| **Surfaces** | CLI (`start` / `cli` / `web` / `run` / `tools` / `mcp` / `config`) · HTTP **:1024** · Vite dev UI **:1025** · WebSocket chat |
| **LLM** | OpenAI-compatible + Anthropic adapters · multi-provider config |
| **Benchmarks** | Blind-judged vs Claude Code on **same model** — composite **86 vs 83** and **88 vs 85** on two repair tasks |

---

## What you get

Not a replacement IDE — a **governed execution runtime** you run on your repo:

```text
CLI / Web / WebSocket
  → Prompt assembly + file memory recall
  → Harness.run()  (tool loop, verification gate, compaction)
  → TaskGraph (structured plan injection)
  → Supervisor (free ↔ forced, drift signals, tool gates)
  → CheckpointEngine v2 + BranchBudget (long-session resilience)
  → ToolExecutor (27 tools + MCP)
```

| Subsystem | Role |
|-----------|------|
| **Harness** | Main agent loop: LLM ↔ tools, permissions, verification, stop hooks, telemetry |
| **Supervisor** | `off` / `adaptive` / `strict` — escalates to **forced** mode on drift, failures, or resume |
| **TaskGraph** | Single structured execution context source; domain gate for low-risk Q&A |
| **Checkpoint v2** | Persists task state, branch budget, supervisor snapshot — survives compact/restart |
| **BranchBudget** | Hard caps on same-file edits & failed command retries — stops infinite loops |
| **File memory** | Long-term facts + session notes + Dream/eviction; keyword recall pre-LLM |
| **Tools & MCP** | Files, shell, git, patch, search, docs (Office/PPTX/XMind), web, sub-agent delegate |

---

## Why this matters

Most agent products optimize the *model call*. Real engineering work needs a *runtime* that survives **20–200+ tool rounds**: detect when the agent is stuck, constrain reckless behavior, and recover after compaction or crash — without throwing away the task.

Same tools, same models — **governed execution**.

---

## How it works

### 1. Drift detection

Every tool round is scored against the stated goal:

- **Stall** — many rounds with no file changes or verification progress
- **Tool loops** — same failing call repeated, or the same file edited over and over
- **Goal drift** — tools and outputs no longer match task intent

Signals trigger correction or mode escalation instead of burning the full round budget.

### 2. Adaptive vs forced execution

| Mode | Behavior |
|------|----------|
| **Free** | Agent explores — Q&A, inspection, low-risk edits |
| **Forced** | Stricter tool gates, BranchBudget enabled, verification before done |

Policy: `off` · `adaptive` (default) · `strict`. Escalate on drift/failures/checkpoint resume; de-escalate when stable.

### 3. Checkpoint recovery

Task state, files touched, commands run, verification status, and `runtimeV2` (branch budget, supervisor) persist to disk. After compaction, browser reload, or process restart, the runtime **restores the snapshot** — not chat history alone.

---

## vs. agent products

| | Cursor / Claude Code / Codex-style | iceCoder |
|---|-----------------------------------|----------|
| **Drift handling** | Mostly implicit | Explicit signals → correction or forced mode |
| **Loop control** | Soft hints; loops reported in community issues | **BranchBudget** hard-blocks repeated file/command patterns |
| **Recovery** | Session/chat dependent | Structured checkpoint + runtime snapshot restore |
| **Control** | Fixed product behavior | Configurable supervisor + tool gates |
| **Deploy** | Hosted or IDE-bound | Self-hosted: CLI, Web, WebSocket, MCP |

---

## Benchmarks

Same model (`minimax-m2.5`), same tasks, blind judge (Cursor Composer 2.5). Reports: [`benchMark/reports/`](./benchMark/reports/).

| Task | Objective tests | Composite (iceCoder vs CC) | Grade |
|------|-----------------|---------------------------|-------|
| [Multi-file order pipeline](./benchMark/reports/multi-file-order-pipeline.md) | **9/9** pass | **86 vs 83** | A |
| [Saga + warehouse reconciliation](./benchMark/reports/saga-warehouse-reconciliation-basic.md) | **15/15** pass | **88 vs 85** | A |
| [Spell Brigade survivor](./benchMark/reports/implement-spellbrigade-survivor.md) | long-horizon game build | in progress | — |

Both completed runs passed automated regression gates. In `adaptive` policy, high-risk tasks entered **forced** mode without manual intervention.

---

## Quality & testing

```bash
npm test                 # 1,340 tests, ~36s
npm run test:coverage    # V8 coverage report → coverage/
npx tsc --noEmit         # typecheck
```

| Area | Test files | Notes |
|------|------------|-------|
| Harness + Supervisor | **67** | loop, checkpoint, branch budget, dual-mode, recovery |
| File memory | **20** | recall, dream, eviction, security, concurrency |
| TaskGraph | **7** | executor, persistence, metrics, review |
| Web / LLM / tools / parser | **23** | API routes, adapters, normalizers, strategies |

Coverage snapshot **2026-05-26**: all **11,070** instrumented statements; Harness core **82.1%** line coverage.

---

## Quick start

**Requirements:** Node.js 18+

```bash
git clone <repo-url> && cd iceCoder
npm install
cp data/config.example.json data/config.json   # add your LLM provider(s)
npm run dev                                     # API :1024 · UI :1025 · optional tunnel
```

```bash
npm test
npx tsx src/cli/index.ts run "fix failing tests" --max-rounds 100
npx tsx src/cli/index.ts web --port 3784      # standalone web (CLI default port)
npx tsx src/cli/index.ts tools                  # list 27 tools
```

Supervisor template: `data/supervisor-config.example.json` · Env reference: [`docs/environment-variables.md`](./docs/environment-variables.md)

---

## Documentation

| Doc | What you'll find |
|-----|------------------|
| [Project guide](./docs/PROJECT-GUIDE.md) | Architecture, memory, tools, testing |
| [项目介绍](./docs/项目介绍.md) | Full Chinese reference (modules, flows, acceptance) |
| [Environment variables](./docs/environment-variables.md) | Configuration reference |
| [Benchmark rubric](./benchMark/md/三平台同模对比评测与裁判评分体系.md) | Cross-platform evaluation methodology |
| [Next work](./docs/nextWork.md) | Roadmap |

**Stack:** TypeScript 6 · Node.js 18+ · Express 5 · Vite 8 · Vitest 4 · WebSocket

---

## License

ISC
