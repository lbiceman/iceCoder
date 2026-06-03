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
npm test                                        # 1,844 tests · ~39s · 100% pass
```

**Requirements:** Node.js 18+ (**22+** recommended; some deps warn on Node 20)

### Configuration & data paths

| | Development (`npm run dev`) | Production (`npm start` / `iceCoder start`) |
|---|---|---|
| **Data root** | `./data/` in the project | `~/.iceCoder/` |
| **Config file** | `data/config.json` | `~/.iceCoder/config.json` |
| **First launch** | Web shows **config page only** until a valid API key is saved; hot-reloads after save | Same |

Override paths with `ICE_DATA_DIR` and related env vars — see [`docs/environment-variables.md`](./docs/environment-variables.md).

**Distribution:** `npm run build` produces `ice-coder-1.0.0.tgz` — see [`PACKAGE_USAGE.md`](./PACKAGE_USAGE.md).

---

## By the numbers

> Verified **2026-06-01** — run `npm test` and `npm run test:coverage` locally to reproduce.

| | |
|---|---|
| **Long-session run** | **217** tool rounds completed stably in production · higher limits not yet tested |
| **Tests** | **1,844** cases · **173** files · **100%** pass · **~39s** |
| **Coverage (all `src/`)** | Lines **78.5%** · Statements **76.1%** · Functions **80.2%** · Branches **67.3%** |
| **Core runtime coverage** | **Harness 84.3%** lines · **Supervisor 95.4%** lines · **File memory 70.5%** lines |
| **Agent tools** | **27** at runtime (**26** built-in + Harness `delegate_to_subagent`; `image_read` needs vision model) · **+ MCP** |
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
| **Tools & MCP** | Files, shell, git, patch, search, docs, web, sub-agent delegate; **Shell dual-track** auto-routes long/short commands |
| **Diff Viewer** | Git-style diff for edit tool output, inline expand/collapse in chat |

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
| **Command palette** | `~` autocomplete (`open` / `scan` / `telemetry` / `supervisor`) · **+** button menu |
| **Diff panel** | Expand `edit_file` / `patch_file` output as Git-style diff (line numbers, red/green) |

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
| **Web graph UI** | Top nav **Memory** page `#/memory` · graph browse/delete · CLI still supports `/memory` |
| **Telemetry** | `GET /api/memory/telemetry` · chat `~telemetry` · log `data/memory/telemetry.jsonl` |

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

### Shell dual-track execution

`run_command` includes a runtime classifier that routes long vs short commands:

- **Long jobs** (`npm test/build`, vitest, tsc -w, docker build, …) → background, immediate `task_id`, 24h hard timeout
- **Short commands** (`git status`, `ls`, tsc --noEmit, …) → foreground, 10s cap; 8s soft timeout can escalate to background
- Poll/manage with `action:"check"` / `"list"` / `"stop"`

See [`docs/requirement/shell-双轨执行-finish.md`](./docs/requirement/shell-双轨执行-finish.md).

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
npm test                 # 1,844 cases · 173 files · ~39s
npm run test:coverage    # V8 report → coverage/ (HTML + JSON)
npx tsc --noEmit         # typecheck
npm run eval:agent       # Agent eval skeleton (mock/real)
```

**Framework:** Vitest 4 · `@vitest/coverage-v8` · Node environment

### Coverage snapshot (2026-06-01)

| Scope | Lines | Statements | Functions | Branches |
|-------|-------|------------|-----------|----------|
| **All `src/`** | **78.5%** (9,934 / 12,650) | **76.1%** (10,908 / 14,331) | **80.2%** (1,804 / 2,250) | **67.3%** (7,177 / 10,661) |
| **`src/harness/`** | **84.3%** | **81.5%** | **85.4%** | **72.3%** |
| **`src/harness/supervisor/`** | **95.4%** | **93.6%** | **93.5%** | **88.1%** |
| **`src/memory/file-memory/`** | **70.5%** | **68.9%** | **67.1%** | **60.1%** |

### Test layout (173 files · 1,844 cases)

| Area | Files (approx.) | What is covered |
|------|-----------------|-----------------|
| **Harness + Supervisor** | **90** | Main loop, checkpoint, branch budget, dual-mode L1/L2, recovery, tool gates, Shell dual-track |
| **File memory** | **20** | Recall, Dream, eviction, security, concurrency |
| **Web / sessions / WS** | **19** | sessions API, setup gate, isolation, structured-io, supervisor-events, chat-ws broadcast |
| **Tools** | **14** | Shell classifier, background tasks, git, patch, doc parsers |
| **TaskGraph** | (in harness) | Builder, executor, persistence, metrics, review |
| **E2E dual-mode** | **1** | Seven scenario prompts: free/forced/degraded/checkpoint resume |
| **Session Pet / public UI / Diff** | **4** | Palette, expression cycle, diff viewer |
| **LLM / parser / core / CLI** | **~15** | Adapters, normalizers, doc strategies, CLI paths |

Supervisor, checkpoint, and Web resume paths are the most heavily tested — the governance layer long tasks rely on.

---

## CLI & development

| Command | Purpose |
|---------|---------|
| `npm run dev` | API :1024 + Vite UI :1025 + optional Cloudflare tunnel (tunnel path is machine-specific; use `dev:api` + `dev:web` instead) |
| `npm run dev:api` / `dev:web` | API or frontend only |
| `npm run build` | tsc + Vite + `npm pack` → tgz |
| `npm start` | Production (`NODE_ENV=production`, data under `~/.iceCoder/`) |
| `npm run iceCoder` | CLI full stack (`start`) |
| `npm run iceCoder:cli` | Terminal-only chat |
| `npm run iceCoder:web` | Web server only |
| `npm run iceCoder:run` | One-shot task (`--max-rounds`, `--json`) |
| `npm run iceCoder:tools` | List registered tools |
| `npm run iceCoder:mcp` | MCP server status |
| `npm run iceCoder:config` | View/switch LLM provider |
| `npx tsx src/cli/index.ts run "…"` | One-shot task shortcut |

Supervisor config: `data/supervisor-config.json` (tracked in repo) · Env reference: [`docs/environment-variables.md`](./docs/environment-variables.md)

---

## Documentation

| Doc | What you'll find |
|-----|------------------|
| [Project guide](./docs/PROJECT-GUIDE.md) | Architecture, memory, tools, testing |
| [项目介绍](./docs/项目介绍.md) | Full Chinese reference |
| [PACKAGE_USAGE.md](./PACKAGE_USAGE.md) | tgz install & command cheat sheet |
| [Chat keep-alive & resume](./docs/requirement/聊天页状态保活与断点恢复-finish.md) | keep-alive · runningTurn · multi-device |
| [Multi-session sidebar](./docs/requirement/多会话-web侧栏-finish.md) | Session CRUD · isolation · WS switch |
| [Shell dual-track](./docs/requirement/shell-双轨执行-finish.md) | Long/short command routing |
| [L2 test playbook](./docs/requirement/L2测试过程.md) | Dual-mode manual & automated acceptance |
| [Memory system](./docs/requirement/记忆系统调整-finish.md) | Recall / extract / Dream / eviction |
| [Environment variables](./docs/environment-variables.md) | Configuration reference |
| [Benchmark rubric](./benchMark/md/三平台同模对比评测与裁判评分体系.md) | Cross-platform evaluation methodology |
| [Next work](./docs/nextWork.md) | Roadmap |

**Stack:** TypeScript 6 · Node.js 18+ (22+ recommended) · Express 5 · Vite 8 · Vitest 4 · WebSocket

---

## License

MIT — see [LICENSE](./LICENSE)
