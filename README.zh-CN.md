# iceCoder

**自主编码 Agent 在长任务里容易失控。** 偏离目标、反复调用同一工具、看似收尾实则没交付——在 **20～200+ 轮**工具调用后尤其常见。

**iceCoder 是自托管的工具化 LLM 运行时治理层** — 含 Harness 主循环、漂移检测、自适应/强制双模、Checkpoint 恢复、TaskGraph、文件化长期记忆、**27** 个内置工具、MCP 扩展，以及 CLI / Web / WebSocket 全栈入口。

[English README](./README.md) · [项目介绍](./docs/项目介绍.md) · [Project guide](./docs/PROJECT-GUIDE.md)

---

## 一眼看数字

| | |
|---|---|
| **测试** | **1,340** 条用例 · **117** 个测试文件 · **100%** 通过（`npm test`，2026-05-26） |
| **覆盖率** | 行 **75.6%** · 语句 **73.7%** · 函数 **76.9%** · 分支 **65.1%**（`npm run test:coverage`） |
| **Harness 覆盖率** | 行 **82.1%** · 语句 **79.8%** · 专用测试文件 **67** 个 |
| **代码规模** | `src/` 下 **~230** 个 TS/JS 模块 · **~4.7 万**行 · Harness **95** 个模块 · Supervisor **24** 个模块 |
| **Agent 工具** | **27** 个注册工具（26 内置 + `delegate_to_subagent`）· 运行时还可挂载 **MCP** 工具 |
| **运行时能力** | TaskGraph · CheckpointEngine v2 · BranchBudget · Step Review · 双模 Supervisor（L1/L2）· 文件记忆 **26** 模块 |
| **入口** | CLI 7 子命令 · HTTP API **:1024** · Vite 开发 UI **:1025** · WebSocket 聊天 |
| **模型** | OpenAI 兼容 + Anthropic 适配 · 多提供者配置 |
| **Benchmark** | 与 Claude Code **同模型**盲评 — 综合分 **86 vs 83**、**88 vs 85**（两项修复任务） |

---

## 项目是什么

不是 IDE 替代品，而是跑在你本地仓库上的 **有治理的执行运行时**：

```text
CLI / Web / WebSocket
  → 提示词拼装 + 长期记忆召回
  → Harness.run()（工具循环、验收门禁、上下文压缩）
  → TaskGraph（结构化计划注入）
  → Supervisor（free ↔ forced、漂移信号、工具门禁）
  → CheckpointEngine v2 + BranchBudget（长会话弹性）
  → ToolExecutor（27 工具 + MCP）
```

| 子系统 | 职责 |
|--------|------|
| **Harness** | Agent 主循环：LLM ↔ 工具、权限、验收、停止钩子、遥测 |
| **Supervisor** | `off` / `adaptive` / `strict` — 漂移/失败/恢复时升级到 **forced** |
| **TaskGraph** | 唯一结构化执行上下文来源；问答/只读类任务可保持 free |
| **Checkpoint v2** | 任务状态、分支预算、监管快照持久化 — 压缩/重启可续跑 |
| **BranchBudget** | 同文件编辑 & 失败命令重试硬上限 — 防止无限循环 |
| **文件记忆** | 长期事实 + 会话笔记 + Dream/淘汰；LLM 前关键词召回 |
| **工具 & MCP** | 文件/Shell/Git/Patch/搜索/文档解析/网页/子 Agent 委托等 |

---

## 为什么重要

多数 Agent 产品优化的是*模型调用*。真实工程任务需要的是能撑过 **20～200+ 轮**工具的*运行时*：识别卡住、约束鲁莽行为、在压缩或崩溃后恢复——而不是把任务直接丢掉。

同样的工具、同样的模型 — **有治理的执行**。

---

## 工作原理

### 1. 漂移检测

每一轮工具调用对照任务目标打分：

- **停滞** — 多轮无文件变更、无验证进展
- **工具循环** — 同一失败调用反复重试，或同一文件被反复修改
- **目标漂移** — 工具与输出不再匹配任务意图

信号触发纠正或模式升级，而不是烧完整轮次预算。

### 2. 自适应 vs 强制执行

| 模式 | 行为 |
|------|------|
| **Free** | 自由探索 — 问答、只读排查、低风险小改 |
| **Forced** | 更严工具门禁、BranchBudget 启用、完成前须验证 |

策略：`off` · `adaptive`（默认） · `strict`。漂移/失败/checkpoint 恢复时升级；稳定后降回。

### 3. Checkpoint 恢复

任务状态、触达文件、已跑命令、验收结果及 `runtimeV2`（分支预算、监管态）持续落盘。压缩、刷新或进程重启后**从快照恢复** — 不只靠聊天记录。

---

## 与 Agent 产品对比

| | Cursor / Claude Code / Codex 类 | iceCoder |
|---|--------------------------------|----------|
| **漂移处理** | 多为隐式 | 显式信号 → 纠正或 forced 升级 |
| **循环控制** | 软提示为主；社区有大量 loop issue | **BranchBudget** 硬拦截同文件/同命令模式 |
| **恢复** | 依赖会话/聊天 | 结构化 checkpoint + 运行时快照 |
| **控制力** | 产品固定行为 | 可配 Supervisor + 工具门禁 |
| **部署** | 托管或 IDE 绑定 | 自托管：CLI、Web、WebSocket、MCP |

---

## Benchmark

同模型（`minimax-m2.5`）、同任务、盲评裁判（Cursor Composer 2.5）。报告目录：[`benchMark/reports/`](./benchMark/reports/)。

| 任务 | 客观验收 | 综合分（iceCoder vs CC） | 等级 |
|------|----------|--------------------------|------|
| [多文件订单流水线](./benchMark/reports/multi-file-order-pipeline.md) | **9/9** 通过 | **86 vs 83** | A |
| [Saga 仓库对账](./benchMark/reports/saga-warehouse-reconciliation-basic.md) | **15/15** 通过 | **88 vs 85** | A |
| [Spell Brigade 幸存者](./benchMark/reports/implement-spellbrigade-survivor.md) | 长周期游戏实现 | 评测中 | — |

两项已完成 run 均通过自动化回归门禁；`adaptive` 策略下高风险任务**自动进入 forced**，无需人工切换。

---

## 质量与测试

```bash
npm test                 # 1,340 条用例，约 36 秒
npm run test:coverage    # V8 覆盖率 → coverage/
npx tsc --noEmit         # 类型检查
```

| 领域 | 测试文件数 | 说明 |
|------|------------|------|
| Harness + Supervisor | **67** | 主循环、checkpoint、分支预算、双模、恢复 |
| 文件记忆 | **20** | 召回、Dream、淘汰、安全、并发 |
| TaskGraph | **7** | 执行器、持久化、指标、契约审查 |
| Web / LLM / 工具 / 解析 | **23** | API、适配器、规范化、文档策略 |

覆盖率快照 **2026-05-26**：共插桩 **11,070** 条语句；Harness 核心行覆盖 **82.1%**。

---

## 快速开始

**环境要求：** Node.js 18+

```bash
git clone <repo-url> && cd iceCoder
npm install
cp data/config.example.json data/config.json   # 填入 LLM 提供者
npm run dev                                     # API :1024 · UI :1025 · 可选 tunnel
```

```bash
npm test
npx tsx src/cli/index.ts run "修复失败测试" --max-rounds 100
npx tsx src/cli/index.ts web --port 3784      # 独立 Web（CLI 默认端口）
npx tsx src/cli/index.ts tools                  # 列出 27 个工具
```

Supervisor 模板：`data/supervisor-config.example.json` · 环境变量：[`docs/环境变量.md`](./docs/环境变量.md)

---

## 文档

| 文档 | 内容 |
|------|------|
| [项目介绍](./docs/项目介绍.md) | 完整中文架构、模块、流程、验收 |
| [Project guide](./docs/PROJECT-GUIDE.md) | English architecture reference |
| [环境变量](./docs/环境变量.md) | 配置参考（[English](./docs/environment-variables.md)） |
| [Benchmark 评分体系](./benchMark/md/三平台同模对比评测与裁判评分体系.md) | 跨平台评测方法 |
| [后续优化计划](./docs/nextWork.md) | 路线图 |

**技术栈：** TypeScript 6 · Node.js 18+ · Express 5 · Vite 8 · Vitest 4 · WebSocket

---

## 许可证

ISC
