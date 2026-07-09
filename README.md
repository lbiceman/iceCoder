# iceCoder

**Self-hosted runtime governance for tool-using LLM agents** — keeps long coding sessions on goal through **L1/L2 dual-mode supervision**, checkpoints, file memory, and a governed tool loop (**217+ rounds verified**).

[中文简介](./README.zh-CN.md) · [**Usage & commands**](./docs/使用文档.md) · [Full guide](./docs/PROJECT-GUIDE.md) · [项目介绍](./docs/项目介绍.md)

## Preview

### Desktop

**Work / chat** — multi-session sidebar, tool execution trail, Ice Bean indicator, `#` / `@` composer:

![Desktop — work chat: Unity session, tool calls, and Ice Bean](./docs/assets/desktop-work-chat.png)

**Memory map** — tag filters + force-directed graph; click nodes for details:

![Desktop — memory graph: tag filters and node relationships](./docs/assets/desktop-memory-graph.png)

**Skills** — list + Markdown preview; type `#` in chat to attach:

![Desktop — skills library: list, preview, and “Use skill”](./docs/assets/desktop-skills.png)

**Settings · MCP** — manage MCP servers, start/stop, tool list, JSON config:

![Desktop — MCP settings: server list and browsermcp detail](./docs/assets/desktop-config-mcp.png)

**Remote via QR (`~scan`)** — phone and PC share the **same session id** (same LAN):

![Desktop — ~scan remote control: QR code and session URL](./docs/assets/desktop-remote-scan.png)

Welcome dashboard (mode / Memory / Harness / L2·Gate):

![Desktop — welcome dashboard and sidebar status panel](./docs/assets/web-ui.png)

### Mobile H5

Same bundle as desktop; routes `#/m/*`; bottom tabs: Work / Memory / Skills / Settings.

**Work** — chat detail, model picker, token stats:

![Mobile — work chat](./docs/assets/mobile-work-chat.png)

**Skills** — card list with delete and “Use skill”:

![Mobile — skills page](./docs/assets/mobile-skills.png)

**Settings · MCP** — same MCP management as desktop:

![Mobile — MCP settings](./docs/assets/mobile-config-mcp.png)

---

## Getting started

### Windows desktop (recommended)

No Node.js required — download the installer (bundled server + Electron shell + floating Ice Bean):

**[Download iceCoder — Windows x64](./releases/windows/iceCoder-windows.exe)**

Configure your API key on first launch. Data directory: `~/.iceCoder/`. Build from source: `npm run build:desktop` or see [`docs/使用文档.md`](./docs/使用文档.md).

### Source / Web / CLI

Install, configure API keys, start dev/Web/CLI, run one-shot tasks, tests, and coverage — **all commands are in** [`docs/使用文档.md`](./docs/使用文档.md) (not duplicated here).

Node.js **22+** (required, matches `engines.node >=22`) · Dev data: `./data/` · Prod: `~/.iceCoder/` — env vars: [`docs/环境变量.md`](./docs/环境变量.md).

---

## Core features

### Dual-mode runtime (L0 / L1 / L2)

Three layers: **L0** is the supervision tier you pick in the sidebar footer (`off` / `adaptive` / `strict`); **L1** is Harness `free` ↔ `forced` with `ToolGate`, branch budget, and TaskGraph constraints when risk rises; **L2** watches `no_progress`, `file_loop`, `tool_repeat_fail`, `goal_drift`, etc., and can **takeover → correct → handoff** back to the main loop (events in `supervisor-events.jsonl`).

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

- **L0 eye color** reflects `off` / `adaptive` / `strict` (toggle in the sidebar footer); the welcome dashboard shows Harness and L2·Gate status at a glance.
- **L1 chip** shows `forced · …` aligned with `execution_mode_enter` reasons.
- **~20 expressions** plus a token ring; step summary and “round N” sync over WebSocket.

### File memory (Memory v2)

Long-term facts live as **Markdown** under `data/memory-files/` (no external vector DB).

- **Structured levels**: `hard_rule` / `project_fact` / `preference` / `observation` / `session_state`, plus `evidenceStrength` for ranking and eviction.
- **Intent-aware recall**: execute / inspect / question filters; conflicting same-topic memories inject **one side only** (tag-based + code-edit preference heuristic).
- **Coarse recall (pre-LLM)**: keyword pull, up to 3 snippets — cheap and auditable.
- **Extract & maintenance (post-tool)**: writes/updates after tools; **Dream** and eviction control size and conflicts.
- **Session notes** with `icecoder-runtime` blocks cooperate with Harness memory integration.
- **Eval**: `npm run eval:agent -- --case memory-conflict` guards against old preferences blocking current edit instructions.

### Agent Skills

Reusable **Markdown skill files** live under `data/skills/` (`ICE_SKILLS_DIR`, same level as user-memory).

- **Skills page**: sidebar tab **`#/skills`** (desktop) / **`#/m/skills`** (mobile) — list, preview, delete.
- **Chat `#` picker**: type `#` in the composer to attach skills as chips; bodies are injected into the prompt at send time.
- **Layouts**: flat `name.md` or `folder/skill.md` with optional scripts; bundled guide [`data/skills/创建技能.md`](./data/skills/创建技能.md).
- **API**: `GET/DELETE /api/skills` — agent-created skills must stay under `ICE_SKILLS_DIR` only.

### Multi-session, mobile H5 & cross-device sync

Sidebar **CRUD** per session — isolated history, `session-notes`, checkpoints, and per-session **workspace roots**.

- **Mobile H5 Shell**: same bundle as desktop; routes **`#/m/work`**, **`#/m/work/:sessionId`**, **`#/m/memory`**, **`#/m/skills`**, **`#/m/config`** — bottom tabs, session drawer, keep-alive aligned with desktop.
- **`~scan`**: QR pairs phone and PC on the **same session id** (shared context, not a read-only mirror).
- Keep-alive + **runningTurn** restores streaming UI after refresh or reconnect.

### File references & system browser

- **`@` workspace refs**: cascade picker over the session workspace (`/api/workspace/browse`); selected paths become composer chips.
- **System filesystem tools**: `list_drives`, `browse_directory`, `open_file` — browse/read paths outside the repo (remote/mobile use case).
- **`~open`**: server-side deterministic directory listing before the model answers (avoids fabricated drive lists).

### Checkpoint, compaction & resume

Disk checkpoints bundle **task state, TaskGraph/runtimeV2, BranchBudget, supervisor snapshot**; writes are serialized via Harness tail to avoid torn files.

- After **hard compaction**, TaskState + RepoContext are re-injected (goal, changed files, pending verification).
- **F5 / WS reconnect** uses `runningTurn` + checkpoint replay so half-finished streams are not lost.
- Legacy checkpoints without `runtimeV2` remain readable.

### Tools (27 built-in + MCP)

File/Git/Shell, search, URL fetch, Office/XMind parse, **system filesystem browser**, vision `image_read`, etc.; Harness also exposes **`delegate_to_subagent`**. **MCP** registers external server tools into the same `ToolRegistry`.

- **Shell dual-track**: long `run_command` jobs go background, short ones foreground; soft timeout can escalate.
- **Diff viewer** embeds Git-style diffs for edit tools in chat.
- **confirm** without a UI callback defaults to **deny** for unattended safety.
- **MCP settings UI**: start/stop servers, browse tools, edit JSON config (desktop `#/config` / mobile `#/m/config`).

### Telemetry & observability

Harness rounds, memory ops, L1 mode changes, L2 timeline → `data/*/telemetry.jsonl` and `supervisor-events.jsonl`.

- Web: **`~telemetry`**, **`~supervisor`** (`days=` / `event=` / `limit=`), **`~memory`**, etc.; type `~` for the command palette.
- HTTP: `GET /api/supervisor/events` mirrors chat reports — useful for long-run debugging and shadow comparisons.
- Commands and paths: [`docs/使用文档.md`](./docs/使用文档.md).

### Tests & quality baseline

**~2,000** Vitest cases across **~225** files (**~78%** line coverage on `src/`; Harness **~84%**, Supervisor **~95%**, memory **~71%** — run `npm run test:coverage` locally).

- Covers gates, TaskGraph, dual-mode, memory lifecycle, Web routes, and long-session scenarios.
- **`npm run eval:agent`**: Agent behavior regression — 7 fixed cases in isolated temp workspaces, real Harness + tools, pass/fail + metrics; `--mode=mock` for no-API smoke. See [`docs/使用文档.md`](./docs/使用文档.md).
- **`npm run telemetry:runtime`**: summarize runtime telemetry JSONL for long-run debugging.
- How to run: [`docs/使用文档.md`](./docs/使用文档.md).

### Local benchmarks

Blind **same-model** runs vs **Claude Code**; **SR** (acceptance pass) + **Composite (Gate 40 + Judge 60)**, not turn count alone.

- Layers **L1–L8** (billing L4+: 97 files / 19 bugs; fusion L7: 33 probes; **L8 SaaS fusion**: multi-tenant order × supply × approval × billing).
- How to run: [`docs/使用文档.md` §本地 Benchmark](./docs/使用文档.md#本地-benchmark) · rubric [`benchMark/md/三平台同模对比评测与裁判评分体系.md`](./benchMark/md/三平台同模对比评测与裁判评分体系.md).

**Read more:** dual-mode → [`docs/双模机制详解.md`](./docs/双模机制详解.md) · L2 → [`docs/L2监管层详解.md`](./docs/L2监管层详解.md) · memory → [`docs/记忆系统详解.md`](./docs/记忆系统详解.md) · compaction → [`docs/压缩机制详解.md`](./docs/压缩机制详解.md) · overview → [`docs/项目介绍.md`](./docs/项目介绍.md) · mobile H5 → [`docs/requirement/移动端H5-Shell方案.md`](./docs/requirement/移动端H5-Shell方案.md)

---

## Local benchmark scores

Judge: **Cursor Composer 2.5** · Rubric: [`benchMark/md/三平台同模对比评测与裁判评分体系.md`](./benchMark/md/三平台同模对比评测与裁判评分体系.md)  
Reports: [`benchMark/reports/`](./benchMark/reports/) · Tasks: [`benchMark/tasks/`](./benchMark/tasks/) · **How to run:** [`docs/使用文档.md` §本地 Benchmark](./docs/使用文档.md#本地-benchmark)

> **Do not mix model batches** when comparing platforms (`m2.7` vs `m2.5-pro` vs `MiniMax-M3`).

| Task | Platform | Model | SR | Composite | vs CC | Duration |
|------|----------|-------|-----|-----------|-------|----------|
| [Order pipeline](./benchMark/reports/multi-file-order-pipeline.md) | iceCoder | m2.7 | ✅ | **86** | +3 | — |
| [Saga warehouse](./benchMark/reports/saga-warehouse-reconciliation-basic.md) | iceCoder | m2.7 | ✅ | **88** | +3 | — |
| [Spell Brigade](./benchMark/reports/implement-spellbrigade-survivor.md) | iceCoder / CC | m2.5-pro | 1 / 1 | **81** / **80** | +1 | ~120m / 87m |
| [Billing 19 bugs](./benchMark/reports/debug-billing-settlement.md) **01** | iceCoder | **MiniMax-M3** | ✅ 19/19 | **93** | +1 vs 02 | **≈3.6 min** · 23 turns |
| [Billing 19 bugs](./benchMark/reports/debug-billing-settlement.md) **02** | CC | **MiniMax-M3** | ✅ 19/19 | **92** | — | **5m 45s** |
| [Fusion L7 33 probes](./benchMark/reports/debug-fusion-supply-fintech.md) **01** | iceCoder | **MiniMax-M3** | ✅ 33/33 | **91** | — | **≈5.3 min** |
| [Fusion L7 33 probes](./benchMark/reports/debug-fusion-supply-fintech.md) **02** | CC | **MiniMax-M3** | ✅ 33/33 | **92** | +1 | **6m 17s** |
| [SaaS L8 fusion](./benchMark/reports/debug-saas-order-supply-approval-fusion-05.md) **01** | iceCoder | GPT-5.5 judge | ✅ 7/7 Gate | **71** | +2 vs 02 | **≈16m** · 122 turns |
| [SaaS L8 fusion](./benchMark/reports/debug-saas-order-supply-approval-fusion-05.md) **02** | CC | GPT-5.5 judge | ✅ 7/7 Gate | **69** | — | **≈5m** |

**Takeaway:** Same model + same repo — iceCoder leads on **governed delivery** (acceptance pass, composite, or wall-clock on L4+ billing); CC can win on isolated code style or raw speed. L8 both pass public Gate **38/40** with thin implementations vs the 160–220-file design target; iceCoder **+2** Composite (71 vs 69) mainly from shipping over-ship fix.

---

## Architecture (compact)

```text
CLI / Web / WS / Mobile H5 → memory + skills recall → Harness (tools, verify, compact)
  → TaskGraph → Supervisor L1/L2 → Checkpoint + BranchBudget → 27 tools + MCP
```

| Piece | Role |
|-------|------|
| **Harness** | Main agent loop, verification gate, compaction, telemetry |
| **Supervisor** | L1 execution mode + L2 runtime takeover/handoff |
| **TaskGraph** | Structured plan injection |
| **File memory** | Memory v2: levels / evidence / conflict arbitration + session notes |
| **Skills** | Markdown playbooks in `ICE_SKILLS_DIR`; `#` injection + Skills page |
| **Web / Mobile** | Pet, multi-session, H5 shell, `@`/`#` composer, diff viewer, `~` commands |

---

## Docs

| Doc | Content |
|-----|---------|
| [**使用文档**](./docs/使用文档.md) | **Commands** — install, dev, CLI, tests, benchmark, `~` commands |
| [PROJECT-GUIDE](./docs/PROJECT-GUIDE.md) | Architecture & modules |
| [项目介绍](./docs/项目介绍.md) | Chinese full reference |
| [记忆系统详解](./docs/记忆系统详解.md) | Memory v2 design (no vector DB) |
| [压缩机制详解](./docs/压缩机制详解.md) | Layered compaction + structured recovery |
| [双模机制详解](./docs/双模机制详解.md) | L0 / L1 / L2 dual-mode overview |
| [L2监管层详解](./docs/L2监管层详解.md) | L2 takeover / handoff deep dive |
| [PACKAGE_USAGE](./PACKAGE_USAGE.md) | `npm pack` install |
| [Benchmark rubric](./benchMark/md/三平台同模对比评测与裁判评分体系.md) | Scoring methodology |
| [debug-billing-settlement](./benchMark/reports/debug-billing-settlement.md) | L4+ 19-bug run (M3, iceCoder vs CC) |
| [debug-saas-order-supply-approval-fusion-05](./benchMark/reports/debug-saas-order-supply-approval-fusion-05.md) | L8 SaaS fusion (iceCoder vs CC) |

---

## License

MIT — see [LICENSE](./LICENSE)
