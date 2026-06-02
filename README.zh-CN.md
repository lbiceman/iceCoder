# iceCoder

**自主编码 Agent 在长任务里容易失控。** 偏离目标、反复调用同一工具、看似收尾实则没交付——在 **20～300+ 轮**工具调用后尤其常见。

**iceCoder 是自托管的工具化 LLM 运行时治理层**：真实任务中 Harness 已**稳定跑通 217 轮**工具调用（更高轮次尚未压测）；配合 **L1/L2 双模监管**、Checkpoint 恢复、TaskGraph 计划注入、文件化长期记忆、Web **冰豆**指示器与 **PC/手机多端同步**、**27** 个内置工具、MCP 扩展，以及 CLI / Web / WebSocket 全栈入口。

[English README](./README.md) · [项目介绍](./docs/项目介绍.md) · [Project guide](./docs/PROJECT-GUIDE.md)

---

## 30 秒跑起来

```bash
git clone <repo-url> && cd iceCoder
npm install
cp data/config.example.json data/config.json   # 填入 LLM API Key
npm run dev                                     # API :1024 · UI :1025
```

```bash
npx tsx src/cli/index.ts run "修复失败测试" --max-rounds 100
npm test                                        # 1,844 条用例 · ~39 秒 · 100% 通过
```

**环境要求：** Node.js 18+（推荐 **22+**；部分依赖在 Node 20 下会有 engine 警告）

### 配置与数据路径

| | 开发（`npm run dev`） | 生产（`npm start` / `iceCoder start`） |
|---|---|---|
| **数据根目录** | 项目内 `./data/` | 用户目录 `~/.iceCoder/` |
| **配置文件** | `data/config.json` | `~/.iceCoder/config.json` |
| **首次启动** | 未填有效 API Key 时 Web **仅开放配置页**，保存后热加载 | 同上 |

可用 `ICE_DATA_DIR` 等环境变量覆盖路径，详见 [`docs/环境变量.md`](./docs/环境变量.md)。

**分发安装：** `npm run build` 生成 `ice-coder-1.0.0.tgz`，见 [`PACKAGE_USAGE.md`](./PACKAGE_USAGE.md)。

---

## 一眼看数字

> 实测日期 **2026-06-01** — 本地执行 `npm test` 与 `npm run test:coverage` 可复现。

| | |
|---|---|
| **长会话实测** | 生产任务中 Harness **稳定完成 217 轮**工具调用 · 更高轮次尚未压测 |
| **测试** | **1,844** 条用例 · **173** 个测试文件 · **100%** 通过 · **~39 秒** |
| **覆盖率（全 `src/`）** | 行 **78.5%** · 语句 **76.1%** · 函数 **80.2%** · 分支 **67.3%** |
| **核心运行时覆盖率** | **Harness 84.3%** 行 · **Supervisor 95.4%** 行 · **文件记忆 70.5%** 行 |
| **Agent 工具** | **27** 个运行时工具（**26** 内置 + Harness `delegate_to_subagent`；`image_read` 需视觉模型）· 还可挂载 **MCP** |
| **入口** | CLI 7 子命令 · HTTP **:1024** · Vite 开发 UI **:1025** · WebSocket · 可选 Cloudflare 隧道 |
| **Benchmark（盲评 vs CC）** | 修复类 **86/88 vs 83/85** · 长周期 m2.7 **72 vs 59** · 长周期 m2.5-pro **81 vs 80**（均 SR=1） |

同样的工具、同样的模型 — **有治理的执行**。

---

## 为什么选 iceCoder？

| 痛点 | iceCoder 的解法 |
|------|----------------|
| 同一文件或失败命令反复循环 | **BranchBudget** 硬拦截重复模式 |
| 50+ 轮工具调用后开始跑偏 | **L2 漂移检测** → 纠正或 **L1 forced** 升级 · 实测 **217 轮**稳定 |
| 上下文压缩后任务状态丢失 | **CheckpointEngine v2** + `runningTurn` 快照 · 不只靠聊天 |
| 切页 / F5 / 手机扫码后 UI 全丢 | **SPA keep-alive** + **按 session 广播** + 断点恢复 |
| 未经验证就宣告完成 | 验收门禁 + TaskGraph 完成条件 |
| 绑定托管 IDE、无法自部署 | **自托管** CLI / Web / WebSocket / MCP，跑在你自己的仓库上 |

---

## 项目是什么

不是 IDE 替代品，而是跑在你本地仓库上的 **有治理的执行运行时**：

```text
CLI / Web / WebSocket（PC + 手机扫码）
  → 提示词拼装 + 长期记忆召回
  → Harness.run()（工具循环、验收门禁、上下文压缩）
  → TaskGraph（结构化计划注入）
  → Supervisor L1/L2（free ↔ forced · 漂移 · takeover · handoff）
  → CheckpointEngine v2 + BranchBudget（长会话弹性）
  → ToolExecutor（27 工具 + MCP）
  → Web 冰豆 / 执行计划面板 / 多会话侧栏
```

| 子系统 | 职责 |
|--------|------|
| **Harness** | Agent 主循环：LLM ↔ 工具、权限、验收、停止钩子、遥测 |
| **Supervisor L1** | Execution Mode：`off` / `adaptive` / `strict` — 漂移/失败/checkpoint 恢复时 **forced** |
| **Supervisor L2** | Runtime Supervisor：观察 → **takeover** → 纠偏 → **handoff** → cooldown |
| **TaskGraph** | 唯一结构化执行上下文来源；问答/只读类任务可保持 free |
| **Checkpoint v2** | 任务状态、分支预算、监管快照持久化 — 压缩/重启可续跑 |
| **BranchBudget** | 同文件编辑 & 失败命令重试硬上限 — 防止无限循环 |
| **文件记忆** | 长期事实 + 会话笔记 + Dream/淘汰；LLM 前关键词召回 |
| **Web 体验** | 冰豆指示器、多会话侧栏、切页保活、F5/多端 `runningTurn` 恢复 |
| **工具 & MCP** | 文件/Shell/Git/Patch/搜索/文档解析/网页/子 Agent 委托等；**Shell 双轨**自动分流长/短命令 |
| **Diff Viewer** | 编辑类工具输出 Git 风格 diff 可视化，聊天内嵌展开/折叠 |

---

## 双模运行时（L1 + L2）

| 层级 | 做什么 | Web 上怎么看 |
|------|--------|--------------|
| **L1 · Execution Mode** | `free` ↔ `forced`：工具门禁、BranchBudget、checkpoint 恢复必进 forced | 冰豆底部 `forced · …` chip · 顶栏 off/adaptive/strict |
| **L2 · Runtime Supervisor** | 停滞 / 漂移 / 重复失败 → takeover 纠偏 → 稳定后 handoff | `~supervisor` 报告 · Timeline（`supervisor-events.jsonl`） |

- **策略档**：`off`（纯 Harness）· `adaptive`（默认）· `strict`（首轮建图 + 更严门禁）
- **checkpoint 恢复**：自动 submit `checkpoint_resumed` → 必须 forced（设计约束，非故障）
- **遥测**：`GET /api/supervisor/events` · 聊天命令 `~supervisor` / `~supervisor event=recover days=3`

---

## Web 体验与多端同步

| 能力 | 说明 |
|------|------|
| **冰豆（Session Pet）** | Canvas 会话指示器：~20 种表情 · token 圆环 · L1 forced chip · 眼色随 Supervisor 档位变化 |
| **多会话侧栏** | 新建/切换/重命名/删除会话 · 按 session 隔离历史与 `session-notes` |
| **切页 keep-alive** | 聊天 ↔ 配置 ↔ 记忆图谱切换不销毁 DOM · 流式/Stop/冰豆状态保留 |
| **F5 / 断线恢复** | 服务端 `runningTurn` 快照 · 重连后还原流式文本、工具时间线、轮次、冰豆态 |
| **PC + 手机** | `~scan` 扫码连同一 session · harness 事件 **按 session 广播** · 双端进度同步 |
| **多端 confirm** | 危险操作 confirm 广播到所有订阅端 · **first-win** · 60s 超时 deny |
| **命令快捷入口** | 输入框 `~` 补全（`open` / `scan` / `telemetry` / `supervisor`）· 发送钮旁 **+** 菜单 |
| **Diff 面板** | `edit_file` / `patch_file` 等工具输出可展开 Git 风格 diff（行号 + 红删绿增） |

长任务进行中：切配置页回来、刷新浏览器、手机中途扫码，均可续看进度并继续 Stop/confirm — 详见 [`docs/requirement/聊天页状态保活与断点恢复-finish.md`](./docs/requirement/聊天页状态保活与断点恢复-finish.md)。

---

## 文件化记忆系统

**不依赖外部数据库** — 记忆以 Markdown 文件落在 `data/user-memory/`（用户级）与项目工作区，经 `HarnessMemoryIntegration` 接入每轮 Harness 循环。核心实现：`src/memory/file-memory/`（**26** 模块 · 测试覆盖率 **70.3%** 行）。

| 能力 | 说明 |
|------|------|
| **双阶段召回** | **粗召回**（每轮 LLM 前 · 关键词 Top 3 · 不调 LLM）+ **标准召回**（工具轮后 · 关键词或 LLM 精排 · 冷却 5min） |
| **LLM 提取** | 对话后自动提取候选记忆 → 密钥扫描 → 去重/冲突检测 → 写入文件 |
| **类型分级** | `user` / `feedback` / `project` / `reference` — 按任务意图（execute/inspect/question）过滤注入 |
| **Dream 整合** | 周期性「做梦」去重、修剪、索引修复（参考 Claude Code 思路） |
| **加权淘汰** | 非纯 LRU；结合引用频率、时效、相关性评分淘汰低价值记忆 |
| **会话笔记** | 每 session 独立 `{id}.session-notes.md` · 含 `icecoder-runtime` 结构化快照（TaskState + RepoContext） |
| **Web 图谱** | 顶栏 **记忆** 页 `#/memory` · 结点图谱浏览/删除 · CLI 仍支持 `/memory` |
| **遥测** | `GET /api/memory/telemetry` · 聊天 `~telemetry` · 日志 `data/memory/telemetry.jsonl` |

```text
对话 → LLM 提取 → 安全扫描 → 写入 memory-files
     → 粗召回(pre-LLM) / 标准召回(工具轮后) → 门控 + CoN 注入
     → Dream 整合 → 衰减 / 淘汰
```

策略原则：**证据优先、严格相关** — 编码任务优先项目事实；弱信号不进长期记忆，留给会话笔记。详见 [`docs/项目介绍.md` §7](./docs/项目介绍.md) · [`docs/requirement/记忆系统调整-finish.md`](./docs/requirement/记忆系统调整-finish.md)。

---

## 工作原理

### 漂移检测（L2）

每一轮工具调用对照任务目标打分：

- **停滞（no_progress）** — 多轮无文件变更、无验证进展
- **工具循环** — 同一失败调用反复重试，或同一文件被反复修改
- **目标漂移（goal_drift）** — 工具与输出不再匹配任务意图

信号写入 Timeline，必要时 L2 takeover 纠偏或 L1 升级到 forced。

### Shell 双轨执行

`run_command` 内置运行时分类器，自动区分长/短命令：

- **长命令**（`npm test/build`、vitest、tsc -w、docker build 等）→ 后台执行，立即返回 `task_id`，24h 硬超时
- **短命令**（`git status`、`ls`、tsc --noEmit 等）→ 前台执行，10s 硬上限；8s 软超时后可 escalate 到后台
- 可用 `action:"check"` / `"list"` / `"stop"` 管理后台任务

详见 [`docs/requirement/shell-双轨执行-finish.md`](./docs/requirement/shell-双轨执行-finish.md)。

### Checkpoint 恢复

任务状态、触达文件、已跑命令、验收结果及 `runtimeV2`（分支预算、Supervisor 快照）持续落盘。压缩、刷新或进程重启后**从快照恢复** — 不只靠聊天记录；Web 端另有内存 `runningTurn` 供多端/F5 即时还原 UI。

### 长会话耐久

真实生产任务中，Harness 已连续完成 **217 轮**工具调用且全程稳定 — Supervisor 模式切换、Checkpoint 压缩、BranchBudget 拦截均正常工作。217 轮以上尚未压测；运行时面向 **20～200+ 轮**工程任务设计。Benchmark 长周期任务 iceCoder 曾跑至 **347 轮**（m2.7 / second，受控中断后仍可交付可玩产物）；**m2.5-pro / third** 约 **120 min** 内 **四条验收全过（SR=1）** 且无受控中断。

---

## 与 Agent 产品对比

| | Cursor / Claude Code / Codex 类 | iceCoder |
|---|--------------------------------|----------|
| **漂移处理** | 多为隐式 | 显式 L2 信号 + L1 forced 升级 |
| **循环控制** | 软提示为主 | **BranchBudget** 硬拦截 |
| **恢复** | 依赖会话/聊天 | checkpoint + `runningTurn` + 多端广播 |
| **长任务 UI** | 单端会话为主 | keep-alive + F5/扫码续进度 + 冰豆状态 |
| **控制力** | 产品固定行为 | 可配 Supervisor + 工具门禁 |
| **部署** | 托管或 IDE 绑定 | 自托管：CLI、Web、WebSocket、MCP |

---

## Benchmark（盲评 vs Claude Code）

统一裁判：**Cursor Composer 2.5** · 评分体系：[`benchMark/md/三平台同模对比评测与裁判评分体系.md`](./benchMark/md/三平台同模对比评测与裁判评分体系.md)

> 参测模型因批次而异：**`minimax-m2.7`**（first/second）· **`mimo2.5-pro`**（third/forth）。跨批次对比须标注模型，不可混为一谈。

### 修复类（同模 m2.7）

| 任务 | 客观验收 (SR) | Composite | Gate | Judge | 等级 | iceCoder vs CC |
|------|---------------|-----------|------|-------|------|----------------|
| [多文件订单流水线](./benchMark/reports/multi-file-order-pipeline.md) | ✅ 9/9 | **86** vs 83 | 40 vs 38 | 46 vs 45 | A / A | **+3** · transient 重试更稳健 |
| [Saga 仓库对账](./benchMark/reports/saga-warehouse-reconciliation-basic.md) | ✅ 15/15 | **88** vs 85 | 40 vs 38 | 48 vs 47 | A / A | **+3** · 无 `.claude/` 越界 |

### 长周期从零实现（Spell Brigade 幸存者）

完整四 run 报告：[`implement-spellbrigade-survivor.md`](./benchMark/reports/implement-spellbrigade-survivor.md)

| 批次 | 平台 | 模型 | SR | Composite | 等级 | 工时 | 实机要点 |
|------|------|------|-----|-----------|------|------|----------|
| second / first | iceCoder vs **CC** | **m2.7** | 0 / 0 | **72** vs ≈59 | B / F | — / 82 min | iceCoder 战斗可玩、E2E 探针 5/5；CC 不可玩 · second **347 轮**受控中断 |
| **third / forth** | **iceCoder** vs **CC** | **m2.5-pro** | **1 / 1** | **81** vs **80** | A / A | ≈120 / **87 min** | iceCoder **更流畅**、商城 meta 更全；CC **PNG 进战斗**、更快但 **开局即卡顿** |

### iceCoder vs CC — 怎么读这些数

| 维度 | iceCoder | Claude Code（CC） |
|------|----------|-------------------|
| **同模 m2.7（second vs first）** | 战斗闭环、单测/E2E 逻辑正确 · **+13 Composite** | DOM 叠层 hack、战斗空壳 · 实机不可玩 |
| **同模 m2.5-pro（third vs forth）** | SR=1 · **流畅** · GameScene 拆分 · 商城 4/6 effect | SR=1 · **87 min 更快** · 角色/怪物 PNG · **开局即卡顿** |
| **长任务治理** | Harness + L2/L1 · 347 轮仍可交付可玩产物 | 易「假完成」（UI 有、玩法无）· 性能/单体文件风险 |
| **共同短板** | 视觉最后一公里（third 有 PNG 文件但未载入画布） | forth 贴图好但 **开局即卡顿**（1024×768 + 无对象池/刷怪 cap） |

**汇总**

- **修复类（2/2，m2.7）**：iceCoder 客观验收与综合分均 **领先 CC**；`adaptive` 下高风险任务自动进 forced。
- **长周期 m2.7**：双方 SR=0；iceCoder **可玩 + Judge/Gate 更高**，但 **347 轮上限** + E2E 命令未全过 + `human_assist=true`。
- **长周期 m2.5-pro**：双方 **SR=1**；iceCoder（third）**综合分 + 体验/工程略胜**；CC（forth）**工时与战斗贴图略胜**。

任务定义与探针：[`benchMark/tasks/`](./benchMark/tasks/) · 完整报告：[`benchMark/reports/`](./benchMark/reports/)

---

## 质量与测试

```bash
npm test                 # 1,844 条用例 · 173 文件 · ~39 秒
npm run test:coverage    # V8 覆盖率 → coverage/（HTML + JSON）
npx tsc --noEmit         # 类型检查
npm run eval:agent       # Agent 评测骨架（mock/real）
```

**框架：** Vitest 4 · `@vitest/coverage-v8` · Node 环境

### 覆盖率快照（2026-06-01）

| 范围 | 行 | 语句 | 函数 | 分支 |
|------|-----|------|------|------|
| **全 `src/`** | **78.5%**（9,934 / 12,650） | **76.1%**（10,908 / 14,331） | **80.2%**（1,804 / 2,250） | **67.3%**（7,177 / 10,661） |
| **`src/harness/`** | **84.3%** | **81.5%** | **85.4%** | **72.3%** |
| **`src/harness/supervisor/`** | **95.4%** | **93.6%** | **93.5%** | **88.1%** |
| **`src/memory/file-memory/`** | **70.5%** | **68.9%** | **67.1%** | **60.1%** |

### 测试分布（173 个文件 · 1,844 用例）

| 领域 | 文件数（约） | 覆盖内容 |
|------|-------------|----------|
| **Harness + Supervisor** | **90** | 主循环、checkpoint、分支预算、双模 L1/L2、恢复、工具门禁、Shell 双轨、RecoveryBoundary |
| **文件记忆** | **20** | 召回、Dream、淘汰、安全、并发、E2E 流程 |
| **Web / 会话 / WS** | **19** | sessions API、setup 门禁、隔离、structured-io、supervisor-events、chat-ws 广播 |
| **工具** | **14** | Shell 分类器、后台任务、Git、Patch、文档解析 |
| **TaskGraph** | （含 harness） | 构建器、执行器、持久化、指标、审查 |
| **E2E 双模场景** | **1** | 七类 prompt：free/forced/degraded/checkpoint 恢复 |
| **冰豆 / 公共 UI / Diff** | **4** | 色板、表情周期、diff viewer |
| **LLM / 解析 / core / CLI** | **~15** | 适配器、规范化、文档策略、CLI 路径 |

Supervisor、Checkpoint 与 Web 断点恢复路径测试最密集 — 对应长任务与多端场景所依赖的治理层。

---

## CLI 与开发

| 命令 | 用途 |
|------|------|
| `npm run dev` | API :1024 + Vite UI :1025 + 可选 Cloudflare 隧道（隧道路径因机器而异，可改用 `dev:api` + `dev:web`） |
| `npm run dev:api` / `dev:web` | 分别启动 API 或前端 |
| `npm run build` | tsc + Vite + `npm pack` 生成 tgz |
| `npm start` | 生产模式（`NODE_ENV=production`，数据写入 `~/.iceCoder/`） |
| `npm run iceCoder` | CLI 全栈启动（`start`） |
| `npm run iceCoder:cli` | 仅终端交互 |
| `npm run iceCoder:web` | 仅 Web 服务 |
| `npm run iceCoder:run` | 单次任务（`--max-rounds`、`--json`） |
| `npm run iceCoder:tools` | 列出注册工具 |
| `npm run iceCoder:mcp` | MCP Server 状态 |
| `npm run iceCoder:config` | 查看/切换 LLM 提供者 |
| `npx tsx src/cli/index.ts run "…"` | 单次任务快捷方式 |

Supervisor 配置：`data/supervisor-config.json`（模板已入库）· 环境变量：[`docs/环境变量.md`](./docs/环境变量.md)

---

## 文档

| 文档 | 内容 |
|------|------|
| [项目介绍](./docs/项目介绍.md) | 完整中文架构、模块、流程、验收 |
| [前缀缓存优化方案](./docs/harness/Prompt-Caching-优化方案.md) | 双轨上下文 + 封存裁剪（待实施）· 命中率与费用估算 |
| [Project guide](./docs/PROJECT-GUIDE.md) | English architecture reference |
| [PACKAGE_USAGE.md](./PACKAGE_USAGE.md) | tgz 分发安装与命令速查 |
| [聊天页保活与断点恢复](./docs/requirement/聊天页状态保活与断点恢复-finish.md) | keep-alive · runningTurn · 多端同步 |
| [多会话 Web 侧栏](./docs/requirement/多会话-web侧栏-finish.md) | 会话 CRUD · 隔离 · WS 切换 |
| [Shell 双轨执行](./docs/requirement/shell-双轨执行-finish.md) | 长/短命令自动分流 |
| [L2 测试过程](./docs/requirement/L2测试过程.md) | 双模手工 / 自动化验收场景 |
| [记忆系统调整](./docs/requirement/记忆系统调整-finish.md) | 召回/提取/Dream/淘汰策略 |
| [环境变量](./docs/环境变量.md) | 配置参考（[English](./docs/environment-variables.md)） |
| [Benchmark 评分体系](./benchMark/md/三平台同模对比评测与裁判评分体系.md) | 跨平台评测方法 |
| [后续优化计划](./docs/nextWork.md) | 路线图 |

**技术栈：** TypeScript 6 · Node.js 18+（推荐 22+）· Express 5 · Vite 8 · Vitest 4 · WebSocket

---

## 许可证

MIT — 见 [LICENSE](./LICENSE)
