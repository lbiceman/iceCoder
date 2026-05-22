# iceCoder

**Autonomous coding agents break on long tasks.** They wander off-goal, loop the same tools, and finish without anyone noticing the work never landed.

**iceCoder is a runtime governance layer for autonomous coding agents** — it watches agent behavior, tightens constraints when things go wrong, and restores state when sessions break.

[中文简介](./README.zh-CN.md) · [Full project guide](./docs/PROJECT-GUIDE.md) · [项目介绍](./docs/项目介绍.md)

---

## Why this matters

Most agent products optimize the *model call*. Real engineering work needs a *runtime* that survives 20+ tool rounds: detect when the agent is stuck, constrain reckless behavior, and recover after compaction or crash — without throwing away the task.

iceCoder runs locally on your repo. Same tools, same models — **governed execution**.

---

## How it works

Three mechanisms, end to end:

### 1. Drift detection

Every tool round is scored against the stated goal. The runtime flags:

- **Stall** — many rounds with no file changes or verification progress
- **Tool loops** — same failing call repeated, or the same file edited over and over
- **Goal drift** — tools and outputs no longer match task intent (e.g. read-only spirals on an edit task)

Signals trigger corrective action instead of letting the agent run until context runs out.

### 2. Adaptive vs forced execution

Two runtime modes, switched automatically:

| Mode | Behavior |
|------|----------|
| **Adaptive (free)** | Agent explores freely — good for Q&A, inspection, low-risk edits |
| **Forced** | Stricter tool gates, structured step context, verification required before done |

Start permissive. Escalate to forced when drift, failures, or checkpoint resume demand it. Dial back when the run stabilizes.

User-facing policy: `off` · `adaptive` (default) · `strict`.

### 3. Checkpoint recovery

Task state, files touched, commands run, and verification status are persisted to disk throughout the session. After compaction, browser reload, or process restart, the runtime **restores the snapshot** and continues — not from chat history alone.

---

## vs. agent products

| | Cursor / Claude Code / Codex-style | iceCoder |
|---|-----------------------------------|----------|
| **Drift handling** | Implicit; user often notices late | Explicit signals → correction or mode escalation |
| **Control** | Fixed product behavior | Configurable `off` / `adaptive` / `strict`; forced mode with tool gates |
| **Recovery** | Session/chat dependent | Structured checkpoint + runtime snapshot restore |
| **Scope** | Hosted or IDE-bound | Self-hosted runtime: CLI, Web, WebSocket, MCP |

iceCoder is not a replacement IDE. It is the **governance layer** you can run under or beside existing agent stacks.

---

## Benchmarks

Blind-judged against Claude Code on the same model (`minimax-m2.5`), same tasks, same rubric. Details: [`benchMark/reports/`](./benchMark/reports/).

- **Multi-file order pipeline** — 9/9 tests; composite **86 vs 83** (iceCoder vs CC)
- **Saga + warehouse reconciliation** — 15/15 tests; composite **88 vs 85**
- Both runs passed the project regression gate (automated + scope checks)
- Forced mode engaged on high-risk tasks without manual intervention in adaptive policy

---

## Quick start

**Requirements:** Node.js 18+

```bash
git clone <repo-url> && cd iceCoder
npm install
cp data/config.example.json data/config.json   # add your LLM provider
npm run dev                                     # API :1024 · UI :1025
```

```bash
npm test                                        # 1165 cases
npx tsx src/cli/index.ts run "fix failing tests"
npx tsx src/cli/index.ts web --port 3784
```

---

## Documentation

| Doc | What you'll find |
|-----|------------------|
| [Project guide](./docs/PROJECT-GUIDE.md) | Architecture, memory, tools, testing |
| [项目介绍](./docs/项目介绍.md) | 完整中文说明 |
| [Environment variables](./docs/environment-variables.md) | Configuration reference |
| [Next work](./docs/nextWork.md) | Roadmap |

**Stack:** TypeScript · Node.js · Express · Vite · Vitest

---

## License

ISC
