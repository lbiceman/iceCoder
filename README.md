# iceCoder

**Long coding tasks break most agents** — they drift off-goal, loop the same tools, and declare victory without delivering.

**iceCoder is a self-hosted runtime governance layer** that keeps tool-using LLM agents on track through long sessions — **217 tool rounds verified stable** in real runs (higher limits not yet tested): drift detection, adaptive/forced dual-mode execution, checkpoint recovery, TaskGraph planning, file memory, **27 built-in tools**, MCP, CLI, and Web UI.

[中文简介](./README.zh-CN.md) · [Full project guide](./docs/PROJECT-GUIDE.md) · [项目介绍](./docs/项目介绍.md)

---

## 30 seconds to running

```bash
git clone <repo-url> && cd iceCoder
npm install
cp data/config.example.json data/config.json   # add your LLM API key
npm run dev                                     # API :1024 · UI :1025
```

```bash
npx tsx src/cli/index.ts run "fix failing tests" --max-rounds 100
npm test                                        # 1,372 tests · ~38s · 100% pass
```

**Requirements:** Node.js 18+

---

## By the numbers

> Verified **2026-05-26** — run `npm test` and `npm run test:coverage` locally to reproduce.

| | |
|---|---|
| **Long-session run** | **217** tool rounds completed stably in production runs · higher limits not yet tested |
| **Tests** | **1,372** cases · **123** files · **100%** pass · **~38s** |
| **Coverage (all `src/`)** | Lines **74.9%** · Statements **72.9%** · Functions **77.1%** · Branches **64.6%** |
| **Core runtime coverage** | **Harness 82.5%** lines · **Supervisor 95.0%** lines · **Checkpoint 93%** lines |
| **Source scale** | **235** TS/JS modules · **47,390** lines under `src/` · **97** Harness · **24** Supervisor · **26** file-memory |
| **Agent tools** | **27** registered (26 builtins + `delegate_to_subagent`) · **+ MCP** tools at runtime |
| **Surfaces** | CLI 7 subcommands · HTTP **:1024** · Vite dev UI **:1025** · WebSocket · optional Cloudflare tunnel |
| **LLM** | OpenAI-compatible + Anthropic adapters · multi-provider config |
| **Benchmarks** | Same model blind-judged vs Claude Code — **86 vs 83** and **88 vs 85** on two repair tasks |

Same tools, same models — **governed execution**.

---

## Why iceCoder?

| Problem | iceCoder answer |
|---------|-----------------|
| Agent loops on the same file or failing command | **BranchBudget** hard-blocks repeated patterns |
| Agent wanders after 50+ tool rounds | **Drift detection** → correction or **forced** mode escalation · **217 rounds** verified stable |
| Context compaction loses task state | **CheckpointEngine v2** restores runtime snapshot, not chat alone |
| "Done" without verification | Verification gate + TaskGraph acceptance before completion |
| Locked into a hosted IDE | **Self-hosted** CLI / Web / WebSocket / MCP on your repo |

---

## What you get

Not an IDE replacement — a **governed execution runtime** on your local repo:

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
| **Supervisor** | `off` / `adaptive` / `strict` — escalates to **forced** on drift, failures, or resume |
| **TaskGraph** | Single structured execution context; domain gate for low-risk Q&A |
| **Checkpoint v2** | Persists task state, branch budget, supervisor snapshot — survives compact/restart |
| **BranchBudget** | Hard caps on same-file edits & failed command retries — stops infinite loops |
| **File memory** | Long-term facts + session notes + Dream/eviction; keyword recall pre-LLM |
| **Tools & MCP** | Files, shell, git, patch, search, docs (Office/PPTX/XMind), web, sub-agent delegate |

---

## How it works

### Drift detection

Every tool round is scored against the stated goal:

- **Stall** — many rounds with no file changes or verification progress
- **Tool loops** — same failing call repeated, or the same file edited over and over
- **Goal drift** — tools and outputs no longer match task intent

Signals trigger correction or mode escalation instead of burning the full round budget.

### Adaptive vs forced execution

| Mode | Behavior |
|------|----------|
| **Free** | Agent explores — Q&A, inspection, low-risk edits |
| **Forced** | Stricter tool gates, BranchBudget enabled, verification before done |

Policy: `off` · `adaptive` (default) · `strict`. Escalate on drift/failures/checkpoint resume; de-escalate when stable.

### Checkpoint recovery

Task state, files touched, commands run, verification status, and `runtimeV2` (branch budget, supervisor) persist to disk. After compaction, browser reload, or process restart, the runtime **restores the snapshot** — not chat history alone.

### Long-session endurance

Real production runs have completed **217 consecutive tool rounds** without crash, drift-induced abort, or context collapse — with Supervisor mode switches, checkpoint compaction, and BranchBudget enforcement active throughout. Limits beyond 217 rounds have not been stress-tested yet; the runtime is designed for **20–200+** round engineering tasks.

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
npm test                 # 1,372 cases · 123 files · ~38s
npm run test:coverage    # V8 report → coverage/ (HTML + JSON)
npx tsc --noEmit         # typecheck
```

**Framework:** Vitest 4 · `@vitest/coverage-v8` · Node environment

### Coverage snapshot (2026-05-26)

| Scope | Lines | Statements | Functions | Branches |
|-------|-------|------------|-----------|----------|
| **All `src/`** | **74.9%** (7,770 / 10,374) | **72.9%** (8,488 / 11,642) | **77.1%** (1,442 / 1,870) | **64.6%** (5,676 / 8,793) |
| **`src/harness/`** | **82.5%** | **80.1%** | **84.0%** | **71.0%** |
| **`src/harness/supervisor/`** | **95.0%** | **92.8%** | **93.0%** | **87.2%** |
| **`src/memory/file-memory/`** | **70.4%** | **68.8%** | **67.4%** | **59.9%** |

### Test layout (123 files)

| Area | Files | What is covered |
|------|-------|-----------------|
| **Harness + Supervisor** | **68** | Main loop, checkpoint, branch budget, dual-mode L1/L2, recovery, tool gates |
| **File memory** | **20** | Recall, Dream, eviction, security, concurrency, E2E flows |
| **TaskGraph** | **7** | Builder, executor, persistence, metrics, review, edge cases |
| **E2E dual-mode** | **1** | Six scenario prompts: free/forced/degraded/checkpoint resume |
| **Web / LLM / tools / parser / core** | **27** | API routes, adapters, normalizers, doc strategies, CLI |

Supervisor and checkpoint paths are the most heavily tested — the governance layer you rely on for long tasks.

---

## CLI & development

| Command | Purpose |
|---------|---------|
| `npm run dev` | API + Vite UI + optional Cloudflare tunnel |
| `npm run iceCoder` | CLI full stack (`start`) |
| `npx tsx src/cli/index.ts run "…"` | One-shot task (`--max-rounds`, `--json`) |
| `npx tsx src/cli/index.ts tools` | List 27 registered tools |
| `npx tsx src/cli/index.ts web --port 3784` | Standalone web server |

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
