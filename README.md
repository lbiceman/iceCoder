# iceCoder

**Long coding tasks break most agents** — they drift off-goal, loop the same tools, and declare victory without delivering.

**iceCoder is a self-hosted runtime governance layer** that keeps tool-using LLM agents on track through long sessions — **217 tool rounds verified stable** in real runs (higher limits not yet tested): **L1/L2 dual-mode supervision**, checkpoint recovery, TaskGraph planning, file memory, Web **Session Pet** indicator, **PC/mobile multi-device sync**, **27 built-in tools**, MCP, CLI, and Web UI.

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
npm test                                        # 1,623 tests · ~38s · 100% pass
```

**Requirements:** Node.js 18+

---

## By the numbers

> Verified **2026-05-27** — run `npm test` and `npm run test:coverage` locally to reproduce.

| | |
|---|---|
| **Long-session run** | **217** tool rounds completed stably in production · higher limits not yet tested |
| **Tests** | **1,623** cases · **141** files · **100%** pass · **~38s** |
| **Coverage (all `src/`)** | Lines **75.7%** · Statements **73.6%** · Functions **77.7%** · Branches **65.0%** |
| **Core runtime coverage** | **Harness 82.4%** lines · **Supervisor 95.1%** lines · **Checkpoint ~93%** lines |
| **Agent tools** | **27** registered (26 builtins + `delegate_to_subagent`) · **+ MCP** at runtime |
| **Surfaces** | CLI 7 subcommands · HTTP **:1024** · Vite dev UI **:1025** · WebSocket · optional Cloudflare tunnel |
| **Benchmark (blind judge vs CC)** | Repair **86/88 vs 83/85** · long-horizon m2.7 **72 vs 59** · m2.5-pro **81 vs 80** (both SR=1) |

Same tools, same models — **governed execution**.

---

## Why iceCoder?

| Problem | iceCoder answer |
|---------|-----------------|
| Agent loops on the same file or failing command | **BranchBudget** hard-blocks repeated patterns |
| Agent wanders after 50+ tool rounds | **L2 drift detection** → correction or **L1 forced** escalation · **217 rounds** verified |
| Context compaction loses task state | **CheckpointEngine v2** + `runningTurn` snapshot — not chat alone |
| Page switch / F5 / mobile join loses UI | **SPA keep-alive** + **per-session broadcast** + breakpoint restore |
| "Done" without verification | Verification gate + TaskGraph acceptance |
| Locked into a hosted IDE | **Self-hosted** CLI / Web / WebSocket / MCP on your repo |

---

## What you get

Not an IDE replacement — a **governed execution runtime** on your local repo:

```text
CLI / Web / WebSocket (PC + mobile via ~scan)
  → Prompt assembly + file memory recall
  → Harness.run()  (tool loop, verification gate, compaction)
  → TaskGraph (structured plan injection)
  → Supervisor L1/L2 (free ↔ forced · drift · takeover · handoff)
  → CheckpointEngine v2 + BranchBudget (long-session resilience)
  → ToolExecutor (27 tools + MCP)
  → Web Session Pet / execution plan panel / multi-session sidebar
```

| Subsystem | Role |
|-----------|------|
| **Harness** | Main agent loop: LLM ↔ tools, permissions, verification, stop hooks, telemetry |
| **Supervisor L1** | Execution Mode: `off` / `adaptive` / `strict` — **forced** on drift, failures, resume |
| **Supervisor L2** | Runtime Supervisor: observe → **takeover** → correct → **handoff** → cooldown |
| **TaskGraph** | Single structured execution context; domain gate for low-risk Q&A |
| **Checkpoint v2** | Persists task state, branch budget, supervisor snapshot — survives compact/restart |
| **BranchBudget** | Hard caps on same-file edits & failed command retries |
| **File memory** | Long-term facts + session notes + Dream/eviction; keyword recall pre-LLM |
| **Web UX** | Session Pet, multi-session sidebar, keep-alive, F5/multi-device `runningTurn` restore |
| **Tools & MCP** | Files, shell, git, patch, search, docs, web, sub-agent delegate |

---

## Dual-mode runtime (L1 + L2)

| Layer | What it does | On the Web UI |
|-------|--------------|---------------|
| **L1 · Execution Mode** | `free` ↔ `forced`: tool gates, BranchBudget, checkpoint resume → forced | Pet footer `forced · …` chip · top bar off/adaptive/strict |
| **L2 · Runtime Supervisor** | stall / drift / repeat failure → takeover → handoff | `~supervisor` report · Timeline (`supervisor-events.jsonl`) |

- **Policy:** `off` · `adaptive` (default) · `strict`
- **Checkpoint resume:** auto `checkpoint_resumed` signal → must enter forced (by design)
- **Telemetry:** `GET /api/supervisor/events` · chat command `~supervisor`

---

## Web UX & multi-device sync

| Feature | Description |
|---------|-------------|
| **Session Pet (Ice Bean)** | Canvas indicator: ~20 expressions · token ring · L1 forced chip · eye color by supervisor mode |
| **Multi-session sidebar** | Create/switch/rename/delete sessions · isolated history & session-notes |
| **Page keep-alive** | Chat ↔ config ↔ memory graph without destroying DOM · streaming/Stop/Pet state preserved |
| **F5 / reconnect restore** | Server `runningTurn` snapshot · restore streaming text, tool timeline, round, Pet state |
| **PC + mobile** | `~scan` QR join same session · harness events **broadcast per session** · synced progress |
| **Multi-device confirm** | Dangerous ops broadcast to all subscribers · **first-win** · 60s timeout deny |
| **Command palette** | `~` autocomplete in input · **+** button lists local commands and runs them immediately |

Details: [`docs/requirement/聊天页状态保活与断点恢复-finish.md`](./docs/requirement/聊天页状态保活与断点恢复-finish.md)

---

## File-based memory system

**No external database** — memories live as Markdown under `data/user-memory/` (user-level) and the project workspace, wired into every Harness round via `HarnessMemoryIntegration`. Core: `src/memory/file-memory/` (**26** modules · **70.3%** line coverage).

| Capability | Description |
|------------|-------------|
| **Two-phase recall** | **Coarse** (pre-LLM · keyword Top 3 · no LLM) + **standard** (post-tool · keyword or LLM rerank · 5min cooldown) |
| **LLM extraction** | Post-turn candidate extraction → secret scan → dedupe/conflict check → write files |
| **Typed tiers** | `user` / `feedback` / `project` / `reference` — filtered by task intent (execute/inspect/question) |
| **Dream consolidation** | Periodic dedupe, prune, index repair (inspired by Claude Code) |
| **Weighted eviction** | Not pure LRU; scores by usage, recency, relevance |
| **Session notes** | Per-session `{id}.session-notes.md` · includes `icecoder-runtime` snapshot (TaskState + RepoContext) |
| **Web graph UI** | `#/memory` graph page · `~memory` / `~memory view` / `~memory delete` |
| **Telemetry** | `GET /api/memory/telemetry` · `~telemetry` · log `data/memory/telemetry.jsonl` |

```text
Chat → LLM extract → security scan → write memory-files
     → coarse recall (pre-LLM) / standard recall (post-tool) → gate + CoN inject
     → Dream consolidate → decay / evict
```

Principles: **evidence-first, strict relevance** — project facts for coding tasks; weak signals stay in session notes. See [`docs/项目介绍.md` §7](./docs/项目介绍.md) · [`docs/requirement/记忆系统调整-finish.md`](./docs/requirement/记忆系统调整-finish.md).

---

## How it works

### Drift detection (L2)

Every tool round is scored against the stated goal:

- **Stall (no_progress)** — many rounds with no file changes or verification progress
- **Tool loops** — same failing call repeated, or the same file edited over and over
- **Goal drift** — tools and outputs no longer match task intent

Signals land in the Timeline; L2 may takeover or L1 may escalate to forced.

### Checkpoint recovery

Task state, files touched, commands run, verification status, and `runtimeV2` (branch budget, supervisor) persist to disk. After compaction, browser reload, or process restart, the runtime **restores the snapshot**. The Web layer also keeps an in-memory `runningTurn` for instant F5/multi-device UI restore.

### Long-session endurance

Production runs have completed **217 consecutive tool rounds** without crash or context collapse. The m2.7 long-horizon benchmark reached **347 rounds** (controlled stop; still delivered a playable build). The **m2.5-pro / third** iceCoder run passed **all four acceptance commands (SR=1)** in **~120 min** with no controlled interrupt.

---

## vs. agent products

| | Cursor / Claude Code / Codex-style | iceCoder |
|---|-----------------------------------|----------|
| **Drift handling** | Mostly implicit | Explicit L2 signals + L1 forced escalation |
| **Loop control** | Soft hints | **BranchBudget** hard-blocks |
| **Recovery** | Session/chat dependent | checkpoint + `runningTurn` + multi-device broadcast |
| **Long-task UI** | Single-session focused | keep-alive + F5/QR resume + Pet state |
| **Control** | Fixed product behavior | Configurable supervisor + tool gates |
| **Deploy** | Hosted or IDE-bound | Self-hosted: CLI, Web, WebSocket, MCP |

---

## Benchmarks (blind judge vs Claude Code)

Judge: **Cursor Composer 2.5** · Rubric: [`benchMark/md/三平台同模对比评测与裁判评分体系.md`](./benchMark/md/三平台同模对比评测与裁判评分体系.md)

> Models vary by batch: **`minimax-m2.7`** (first/second) · **`mimo2.5-pro`** (third/forth). Do not mix batches when comparing platforms.

### Repair tasks (same model m2.7)

| Task | Objective (SR) | Composite | Gate | Judge | Grade | iceCoder vs CC |
|------|------------------|-----------|------|-------|-------|----------------|
| [Multi-file order pipeline](./benchMark/reports/multi-file-order-pipeline.md) | ✅ 9/9 | **86** vs 83 | 40 vs 38 | 46 vs 45 | A / A | **+3** · robust transient retry |
| [Saga + warehouse reconciliation](./benchMark/reports/saga-warehouse-reconciliation-basic.md) | ✅ 15/15 | **88** vs 85 | 40 vs 38 | 48 vs 47 | A / A | **+3** · no `.claude/` spill |

### Long-horizon greenfield (Spell Brigade survivor)

Full four-run report: [`implement-spellbrigade-survivor.md`](./benchMark/reports/implement-spellbrigade-survivor.md)

| Batch | Platform | Model | SR | Composite | Grade | Duration | Field notes |
|-------|----------|-------|-----|-----------|-------|----------|-------------|
| second / first | iceCoder vs **CC** | **m2.7** | 0 / 0 | **72** vs ≈59 | B / F | — / 82 min | iceCoder playable combat, E2E probes 5/5; CC unplayable · second **347-round** cap |
| **third / forth** | **iceCoder** vs **CC** | **m2.5-pro** | **1 / 1** | **81** vs **80** | A / A | ≈120 / **87 min** | iceCoder **smoother**, richer shop meta; CC **PNG in combat**, faster but **lags from the start** |

### iceCoder vs CC — how to read this

| Dimension | iceCoder | Claude Code (CC) |
|-----------|----------|------------------|
| **Same model m2.7 (second vs first)** | Playable combat loop, correct tests/E2E · **+13 Composite** | DOM overlay hack, empty combat · unplayable |
| **Same model m2.5-pro (third vs forth)** | SR=1 · **smooth** · GameScene split · 4/6 shop effects | SR=1 · **87 min faster** · character/monster PNG · **lags from the first frame** |
| **Long-task governance** | Harness + L2/L1 · playable delivery even at 347 rounds | Risk of “fake done” (UI without gameplay) · perf / monolith risks |
| **Shared gaps** | Visual last mile (third has PNG files but not loaded in canvas) | forth has sprites but **lags from the first frame** (1024×768 + no pooling / spawn cap) |

**Summary**

- **Repair (2/2, m2.7):** iceCoder leads on objective pass rate and composite; `adaptive` enters forced on high-risk work.
- **Long-horizon m2.7:** both SR=0; iceCoder **playable + higher Judge/Gate**, but **347-round cap**, E2E command miss, `human_assist=true`.
- **Long-horizon m2.5-pro:** both **SR=1**; iceCoder (third) **edges on composite / smoothness / structure**; CC (forth) **edges on speed / combat sprites**.
- **Rule of thumb:** **complex long tasks with acceptance gates** → lean iceCoder; **time-boxed demos needing sprites fast** → CC (m2.5-pro) works, plan for perf/refactor cost.

Task specs: [`benchMark/tasks/`](./benchMark/tasks/) · Reports: [`benchMark/reports/`](./benchMark/reports/)

---

## Quality & testing

```bash
npm test                 # 1,623 cases · 141 files · ~38s
npm run test:coverage    # V8 report → coverage/ (HTML + JSON)
npx tsc --noEmit         # typecheck
```

**Framework:** Vitest 4 · `@vitest/coverage-v8` · Node environment

### Coverage snapshot (2026-05-27)

| Scope | Lines | Statements | Functions | Branches |
|-------|-------|------------|-----------|----------|
| **All `src/`** | **75.7%** (8,530 / 11,270) | **73.6%** (9,345 / 12,700) | **77.7%** (1,578 / 2,030) | **65.0%** (6,206 / 9,542) |
| **`src/harness/`** | **82.4%** | **80.1%** | **83.8%** | **71.3%** |
| **`src/harness/supervisor/`** | **95.1%** | **93.0%** | **93.1%** | **87.0%** |
| **`src/memory/file-memory/`** | **70.3%** | **68.7%** | **66.7%** | **59.8%** |

### Test layout (141 files · 1,623 cases)

| Area | Files (approx.) | What is covered |
|------|-----------------|-----------------|
| **Harness + Supervisor** | **73** | Main loop, checkpoint, branch budget, dual-mode L1/L2, recovery, tool gates |
| **File memory** | **20** | Recall, Dream, eviction, security, concurrency |
| **Web / sessions / WS** | **11** | sessions API, isolation, structured-io, supervisor-events, chat-ws broadcast |
| **TaskGraph** | **7** | Builder, executor, persistence, metrics, review |
| **E2E dual-mode** | **1** | Seven scenario prompts: free/forced/degraded/checkpoint resume |
| **Session Pet / public UI** | **2** | Palette, expression cycle |
| **LLM / tools / parser / core** | **27** | Adapters, normalizers, doc strategies, CLI |

Supervisor, checkpoint, and Web resume paths are the most heavily tested — the governance layer long tasks rely on.

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
| [项目介绍](./docs/项目介绍.md) | Full Chinese reference |
| [Chat keep-alive & resume](./docs/requirement/聊天页状态保活与断点恢复-finish.md) | keep-alive · runningTurn · multi-device |
| [Multi-session sidebar](./docs/requirement/多会话-web侧栏-finish.md) | Session CRUD · isolation · WS switch |
| [L2 test playbook](./docs/requirement/L2测试过程.md) | Dual-mode manual & automated acceptance |
| [Memory system](./docs/requirement/记忆系统调整-finish.md) | Recall / extract / Dream / eviction |
| [Environment variables](./docs/environment-variables.md) | Configuration reference |
| [Benchmark rubric](./benchMark/md/三平台同模对比评测与裁判评分体系.md) | Cross-platform evaluation methodology |
| [Next work](./docs/nextWork.md) | Roadmap |

**Stack:** TypeScript 6 · Node.js 18+ · Express 5 · Vite 8 · Vitest 4 · WebSocket

---

## License

ISC
