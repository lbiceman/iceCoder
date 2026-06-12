# iceCoder

**Self-hosted runtime governance for tool-using LLM agents** — keeps long coding sessions on goal through **L1/L2 dual-mode supervision**, checkpoints, file memory, and a governed tool loop (**217+ rounds verified**).

[中文简介](./README.zh-CN.md) · [**Usage & commands**](./docs/使用文档.md) · [Full guide](./docs/PROJECT-GUIDE.md) · [项目介绍](./docs/项目介绍.md)

---

## Getting started

### Windows desktop (recommended)

No Node.js required — download the installer (bundled server + Electron shell + floating Ice Bean):

**[Download iceCoder Setup 1.0.1 — Windows x64](./releases/windows/iceCoder-Setup-1.0.1-win-x64.exe)**

Configure your API key on first launch. Data directory: `~/.iceCoder/`. Build from source: `npm run build:desktop` or see [`docs/使用文档.md`](./docs/使用文档.md).

### Source / Web / CLI

Install, configure API keys, start dev/Web/CLI, run one-shot tasks, tests, and coverage — **all commands are in** [`docs/使用文档.md`](./docs/使用文档.md) (not duplicated here).

Node.js **18+** (22+ recommended) · Dev data: `./data/` · Prod: `~/.iceCoder/` — env vars: [`docs/environment-variables.md`](./docs/environment-variables.md).

---

## Core features

### Dual-mode runtime (L0 / L1 / L2)

Three layers: **L0** is the Web tier you pick (`off` / `adaptive` / `strict`); **L1** is Harness `free` ↔ `forced` with `ToolGate`, branch budget, and TaskGraph constraints when risk rises; **L2** watches `no_progress`, `file_loop`, `tool_repeat_fail`, `goal_drift`, etc., and can **takeover → correct → handoff** back to the main loop (events in `supervisor-events.jsonl`).

- **adaptive** (default) balances freedom and enforcement; **strict** stays near forced, builds the graph on round 1, and is required for some L2 cases (e.g. file_loop).
- Tied to **TaskGraph** and **Verification Gate** — code changes without verification cannot “finish by chat alone”; `critical_*` domains affect L2 takeover.
- Config: `supervisorMode` in `data/config.json` + `data/supervisor-config.json`; optional `ICE_SUPERVISOR_SHADOW=1` shadow run.

### Harness loop & TaskGraph

**Harness** turns model intent into executed tools: permission rules (allow/confirm/deny), no-tool recovery, repeat-failure detection, micro/hard compaction with runtime re-injection. **TaskGraph** is the **only** structured execution context (replaces the old Execution Plan): enabled for `edit` / `debug` / `test` / `refactor`; `question` / `inspect` stay in free mode without a graph.

- **TaskState + RepoContext** track intent, phase, touched files, and verification status.
- **CheckpointEngine v2** adds `runtimeV2` on the same `{sessionId}.checkpoint.json` (tool trail, failures, branch budget, supervisor snapshot).
- **Sub-agents**: `delegate_to_subagent` explores with a read-only tool whitelist; the main thread only gets a short summary (~60–80% less context bloat from search/read).

### Ice Bean (Web session indicator)

Web-only Canvas pet — visual feedback from Harness / Supervisor / TaskGraph events; **does not** drive runtime decisions.

- **L0 eye color** reflects `off` / `adaptive` / `strict`.
- **L1 chip** shows `forced · …` aligned with `execution_mode_enter` reasons.
- **~20 expressions** plus a token ring; step summary and “round N” sync over WebSocket.

### File memory

Long-term facts live as **Markdown** under `data/memory-files/` (no external vector DB).

- **Coarse recall (pre-LLM)**: keyword pull, up to 3 snippets — cheap and auditable.
- **Extract & maintenance (post-tool)**: writes/updates after tools; **Dream** and eviction control size and conflicts.
- **Session notes** with `icecoder-runtime` blocks cooperate with Harness memory integration.

### Multi-session & cross-device sync

Sidebar **CRUD** per session — isolated history, `session-notes`, and checkpoints.

- **`~scan`**: QR pairs phone and PC on the **same session id** (shared context, not a read-only mirror).
- Keep-alive + **runningTurn** restores streaming UI after refresh or reconnect.

### Checkpoint, compaction & resume

Disk checkpoints bundle **task state, TaskGraph/runtimeV2, BranchBudget, supervisor snapshot**; writes are serialized via Harness tail to avoid torn files.

- After **hard compaction**, TaskState + RepoContext are re-injected (goal, changed files, pending verification).
- **F5 / WS reconnect** uses `runningTurn` + checkpoint replay so half-finished streams are not lost.
- Legacy checkpoints without `runtimeV2` remain readable.

### Tools (27 built-in + MCP)

File/Git/Shell, search, sub-agent delegation, URL fetch, Office parse, etc.; **MCP** registers external server tools into the same `ToolRegistry`.

- **Shell dual-track**: long `run_command` jobs go background, short ones foreground; soft timeout can escalate.
- **Diff viewer** embeds Git-style diffs for edit tools in chat.
- **confirm** without a UI callback defaults to **deny** for unattended safety.

### Telemetry & observability

Harness rounds, memory ops, L1 mode changes, L2 timeline → `data/*/telemetry.jsonl` and `supervisor-events.jsonl`.

- Web: **`~telemetry`**, **`~supervisor`** (`days=` / `event=` / `limit=`), **`~memory`**, etc.; type `~` for the command palette.
- HTTP: `GET /api/supervisor/events` mirrors chat reports — useful for long-run debugging and shadow comparisons.
- Commands and paths: [`docs/使用文档.md`](./docs/使用文档.md).

### Tests & quality baseline

**~1,867** Vitest cases (**~78%** line coverage on `src/`; Harness **~84%**, Supervisor **~95%**, memory **~71%** — run `npm run test:coverage` locally).

- Covers gates, TaskGraph, dual-mode, memory lifecycle, Web routes, and long-session scenarios.
- **`npm run eval:agent`**: agent metric skeleton (success rate, tool rate, verification rate) for regression watch.
- How to run: [`docs/使用文档.md`](./docs/使用文档.md).

### Local benchmarks

Blind **same-model** runs vs **Claude Code** (judge: Cursor Composer 2.5); **SR** (acceptance pass) + **Composite (Gate 40 + Judge 60)**, not turn count alone.

- Layers L1–L6 plus **L4+** (e.g. billing: 97 files, 19 cross-module logic bugs); repair tasks often **+3** Composite for iceCoder — see table below.
- How to run: [`docs/使用文档.md` §本地 Benchmark](./docs/使用文档.md) · rubric [`benchMark/md/三平台同模对比评测与裁判评分体系.md`](./benchMark/md/三平台同模对比评测与裁判评分体系.md).

**Read more:** dual-mode → [`docs/requirement/L2测试过程.md`](./docs/requirement/L2测试过程.md) · overview → [`docs/项目介绍.md`](./docs/项目介绍.md) · memory → [`docs/requirement/记忆系统调整-finish.md`](./docs/requirement/记忆系统调整-finish.md) · multi-session → [`docs/requirement/多会话-web侧栏-finish.md`](./docs/requirement/多会话-web侧栏-finish.md)

---

## Local benchmark scores

Judge: **Cursor Composer 2.5** · Rubric: [`benchMark/md/三平台同模对比评测与裁判评分体系.md`](./benchMark/md/三平台同模对比评测与裁判评分体系.md)  
Reports: [`benchMark/reports/`](./benchMark/reports/) · Tasks: [`benchMark/tasks/`](./benchMark/tasks/) · **How to run:** [`docs/使用文档.md` §本地 Benchmark](./docs/使用文档.md)

> **Do not mix model batches** when comparing platforms (`m2.7` vs `m2.5-pro` vs `MiniMax-M3`).

| Task | Platform | Model | SR | Composite | vs CC | Duration |
|------|----------|-------|-----|-----------|-------|----------|
| [Order pipeline](./benchMark/reports/multi-file-order-pipeline.md) | iceCoder | m2.7 | ✅ | **86** | +3 | — |
| [Saga warehouse](./benchMark/reports/saga-warehouse-reconciliation-basic.md) | iceCoder | m2.7 | ✅ | **88** | +3 | — |
| [Spell Brigade](./benchMark/reports/implement-spellbrigade-survivor.md) | iceCoder / CC | m2.5-pro | 1 / 1 | **81** / **80** | +1 | ~120m / 87m |
| [Billing 19 bugs](./benchMark/reports/debug-billing-settlement.md) **01** | iceCoder | **MiniMax-M3** | ✅ 19/19 | **93** | +1 vs 02 | **≈3.6 min** · 23 turns |
| [Billing 19 bugs](./benchMark/reports/debug-billing-settlement.md) **02** | CC | **MiniMax-M3** | ✅ 19/19 | **92** | — | **5m 45s** |

**Takeaway:** Same model + same repo — iceCoder leads on **governed delivery** (acceptance pass, composite, or wall-clock on L4+ billing); CC can win on isolated code style (e.g. `tax-line-builder`). The **+1** on billing (93 vs 92) is **D6 delivery notes only** — see report §「分差解读」.

---

## Architecture (compact)

```text
CLI / Web / WS → memory recall → Harness (tools, verify, compact)
  → TaskGraph → Supervisor L1/L2 → Checkpoint + BranchBudget → 27 tools + MCP
```

| Piece | Role |
|-------|------|
| **Harness** | Main agent loop, verification gate, compaction, telemetry |
| **Supervisor** | L1 execution mode + L2 runtime takeover/handoff |
| **TaskGraph** | Structured plan injection |
| **File memory** | Long-term Markdown facts + session notes |
| **Web** | Pet, multi-session, keep-alive, diff viewer, `~` commands |

---

## Docs

| Doc | Content |
|-----|---------|
| [**使用文档**](./docs/使用文档.md) | **Commands** — install, dev, CLI, tests, benchmark, `~` commands |
| [PROJECT-GUIDE](./docs/PROJECT-GUIDE.md) | Architecture & modules |
| [项目介绍](./docs/项目介绍.md) | Chinese full reference |
| [PACKAGE_USAGE](./PACKAGE_USAGE.md) | `npm pack` install |
| [Benchmark rubric](./benchMark/md/三平台同模对比评测与裁判评分体系.md) | Scoring methodology |
| [debug-billing-settlement](./benchMark/reports/debug-billing-settlement.md) | L4+ 19-bug run (M3, iceCoder vs CC) |

---

## License

MIT — see [LICENSE](./LICENSE)
