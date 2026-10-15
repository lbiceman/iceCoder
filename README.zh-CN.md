# iceCoder

**自托管 AI 编程助手，桌面端 + 移动端。** 单轴监管（L0/L1/L3）、可派子 Agent、定时任务、文件记忆与 MCP。Windows 安装包开箱即用，也可以用 Node.js 22+ 从源码或 CLI 运行。

[English README](./README.md) · [**使用说明与命令**](./docs/使用文档.md) · [项目介绍](./docs/项目介绍.md) · [Project guide](./docs/PROJECT-GUIDE.md)

## 界面预览

### 桌面端

左侧导航是 **工作 / 任务 / 知识库 / 统计**，底栏是 **设置** 和监管档位（关 / 自适应 / 严格）。工作页下列表分成 **普通会话** 和 **任务会话**。

**工作 / 聊天** — 中间是聊天区，右侧是 **iceCoder 工作台**，底部是 `#` / `@` 输入区，可切换模型和推理强度。工作台无 Tab：上半「检查点」按用户句切章（旧上新下；点章看下边执行流；标题右侧 ↩ 回滚），下半「执行流」是该章的 Harness 轮次与工具短预览。底栏：上下文、工具、文件。

![桌面端 — 工作聊天页：检查点目录与选中章执行流](./docs/assets/desktop-work-chat.png)

![桌面端 — 工作聊天页（浅色主题）](./docs/assets/desktop-work-chat-light.png)

**任务** — `#/tasks`。定时任务把提示词连同引用的技能、图片和文件发到各自的专属会话。支持按间隔、每天、每周、每月，以及只执行一次；可立即执行、启停、编辑、打开会话。

**知识库** — `#/skills`、`#/memory`、`#/rules` 三个页签：技能（新建、查看、编辑、删除）、记忆图谱、全局用户规则。

**统计** — Token 消耗按每次 LLM 调用记入独立账本（会话 / 记忆分开），另有记忆读写与监管进出；日 / 当周 / 当月是滚动的 24 小时 / 7 天 / 30 天：

![桌面端 — 统计：Token、记忆与监管趋势（深色）](./docs/assets/desktop-stats.png)

![桌面端 — 统计（浅色主题）](./docs/assets/desktop-stats-light.png)

**设置** — `#/settings`（`#/config` 同页）。四个页签：通用、模型配置、MCP 配置、监管模式配置。通用里有四套主题（深色 / 浅色 / 现代蓝 / 暖阳）、数据目录、子 Agent 开关、执行透明层、桌面宠物、任务完成通知，以及 Shell 强制确认规则。

### 移动端 H5

与桌面共用同一 bundle，路由 `#/m/*`。底栏四个 Tab：工作 / 任务 / 知识库 / 设置。窄屏打开 `/` 会进移动壳；桌面和移动的主题分开保存。

**工作** — 聊天详情、底部模型与推理强度、冰豆：

![移动端 — 工作聊天页（深色主题）](./docs/assets/mobile-work-chat.png)

**工作（浅色主题）** — 相同聊天布局下的浅色外观：

![移动端 — 工作聊天页（浅色主题）](./docs/assets/mobile-work-chat-light.png)

**知识库 · 技能** — 技能卡片，支持新建、编辑、删除与「使用技能」：

![移动端 — 知识库 · 技能](./docs/assets/mobile-skills.png)

**设置** — 主题、数据目录与执行选项：

![移动端 — 设置页（深色主题）](./docs/assets/mobile-config-general.png)

**设置（浅色主题）** — 相同设置页的浅色外观：

![移动端 — 设置页（浅色主题）](./docs/assets/mobile-config-light.png)

---

## 快速上手

二选一：Windows 安装包（无需 Node.js），或 CLI tgz（需 Node.js 22+）。

| 下载 | 环境 | 用法 |
|------|------|------|
| **[Windows x64 安装包](./releases/windows/iceCoder-windows.exe)** | — | 安装后启动 iceCoder |
| **[CLI tgz](./releases/npm/ice-coder.tgz)** | Node.js 22+ | `npm install -g ./ice-coder.tgz`，然后 `iceCoder start` |

当前版本见 `package.json`（**1.0.8**）。

### Windows 桌面版

安装包内置服务端 + Electron 壳 + 悬浮冰豆。首次启动请在「设置」页填写 API Key；数据目录默认 `~/.iceCoder/`，可在设置里改到其他磁盘（重启后生效，需自行搬迁旧目录）。

**从源码打包桌面版（开发者）**：执行 `npm run build:desktop`。Windows 上 `/shell` 依赖 `node-pty` 原生重编译，需 **VS 2022「使用 C++ 的桌面开发」+ Windows SDK**；Spectre 库由打包脚本**默认绕过**。无 C++ 工具链时会跳过 rebuild、打包仍可成功，但桌面包内 `/shell` 不可用。详见 [`docs/使用文档.md` §桌面打包（Electron）](./docs/使用文档.md#桌面打包electron)。

### 源码 / Web / CLI

安装、配置 API Key、启动开发/Web/CLI、一次性任务、测试与覆盖率 — **全部命令见** [`docs/使用文档.md`](./docs/使用文档.md)（README 不重复罗列）。

Node.js **22+**（必需，与 `engines.node >=22` 一致）。仓库 `data/` 只放模板；运行时数据不在这里。`npm run dev` 用 `ICE_CACHE_ROOT`（未设置时代码默认 `E:/my/iceCoderCache`）。安装包、`npm start` 和 Electron 用 `~/.iceCoder/`，设置页可改，并与 `%APPDATA%/iceCoder/data-directory.json` 共用。环境变量见 [`docs/环境变量.md`](./docs/环境变量.md)。

`npm run dev` 同时起 API **1024** 和 Vite **1025**（浏览器开 1025）。未设置 `PORT` 时，源码 CLI 默认 API **3784**；安装包 / `npm start` / Electron 默认 **1024**。`VITE_PORT` 可改前端端口。

---

## 核心能力

### 单轴运行时监管（L0 / L1 / L3）

三层分工：**L0** 是侧栏底栏的监管档位（`off` / `adaptive` / `strict`），决定整体松紧；**L1** 是 Harness 内的 `free` ↔ `forced` 执行模式，在风险升高时收紧工具门禁（`ToolGate`、分支预算、TaskGraph 约束）；**L3** 是 TaskGraph 合约的确定性硬拦截（`block` / `force_switch`，无 fallback 时 `user_checkpoint`）。

> 原 **L2**（takeover / PassiveObserver / CorrectionPort / EventTimeline）已于 2026-08-31 删除，见 [`docs/L2监管层详解.md`](./docs/L2监管层详解.md)。

- **adaptive**（默认）：按任务风险在自由与强约束间切换，适合日常编码；**strict** 全程偏 forced，关键工程任务首轮即建图。
- 与 **TaskGraph**、**D′ 停时验收** 联动：工程改动可由 `run_command` 跑一次有界验收计划；监管不裁决是否完成。
- 配置：`data/config.json` 的 `supervisorMode` + `data/supervisor-config.json`（仅 `mode` + `executionMode`）。设置页「监管模式配置」可改。
- 子 Agent 自己的监管档位是 `off`：不建图、不进 forced。最终验收仍由主 Agent 的 Verification Gate 决定。

### Harness 主循环与 TaskGraph

**Harness** 把「模型想做什么」落成「实际执行了什么」：权限裁决（allow/confirm/deny）、无工具早停兜底、重复失败检测、上下文微/硬压缩与恢复重注入。**TaskGraph** 是唯一的结构化执行上下文来源（已替代旧 Execution Plan）：对 `edit` / `debug` / `test` / `refactor` 注入节点与分支上下文；`question` / `inspect` 等保持自由模式不建图，并走更轻的日常对话路径。

- **TaskState + RepoContext**：跟踪 intent、阶段、改动文件、验证状态与读过的仓库面。
- **CheckpointEngine v2**：在同一份 `{sessionId}.checkpoint.json` 上叠加 `runtimeV2`（工具轨迹、失败、分支预算、监管快照），长会话可续跑。
- **意图检查点**：每条用户消息发送前快照工作区；回滚到该句会还原文件，并删掉这条及之后的子 Agent 记录。

### 子 Agent

默认模式下，主 Agent 用 **`task`** 派出完整的子 Harness（压缩、恢复、权限、停时验收都在），同一条回复里的多个 `task` 并行。设置页可关闭；关闭后不再下发工具和说明。规划模式和 Shell 协作不暴露 `task`。

| 类型 | 能做什么 |
|------|----------|
| `general` | 读、改、跑命令、自己验证一块边界清楚的实现或修复 |
| `explore` | 只读搜索和梳理，不改文件、不跑会改工作区的命令 |

- **`run_in_background: true`**：立刻返回 agentId，主 Agent 继续干活；用 **`check_agent`** 查询，或等结束后自动注入报告。
- **写租约**：并行的子 Agent 不能写同一个文件。子 Agent 不能再派子 Agent，也不能 `git commit` / `push` / `reset` / `checkout` 等改历史的命令。
- **委派卡片**：和本轮的工具列表分开。收起时是标题、状态和当前一句；展开后才是过程、报告和改动。可打开只读子会话。确认弹窗会标明是哪个子 Agent 发起的。
- 子 Agent 的完整对话不进入主上下文，主 Agent 只看到 `[Agent Result]`。

### 三种会话模式

| 模式 | 怎么进 | 行为 |
|------|--------|------|
| **默认** | 普通发消息 | 读写代码、派子 Agent、创建定时任务 |
| **规划** | `/plan` | 只完善计划文档，不能改代码；不暴露 `task` |
| **Shell 协作** | `/shell` | 整段会话绑定一块持久 PTY；AI 读终端，你在聊天里决策。无内嵌黑窗口。详见 [Shell 协作模式](./docs/shell协作模式.md) |

一次 `/plan` 或 `/shell` 固定当前会话，直到退出。Shell 协作优先于规划模式。

输入 `/` 还有：`/also`（运行中追加备注）、`/next`（静默排下一条）、`/open`（确定性列出磁盘和目录，也接受 `~open`）。`+` 打开 `~` 面板：`~scan`、`~tokens`、`~telemetry`、`~supervisor`。

### 定时任务

**任务**页和 **`scheduled_task`** 工具都能创建。调度可以是间隔、每天、每周、每月，或只跑一次。每个任务有专属会话，出现在侧栏「任务会话」里。

无人值守时，工具确认（含删除文件和高危命令）会自动通过，任务页有明示。不进确认框的灾难性拦截和宿主进程保护仍然生效。上一次还在跑时，本次定时触发会跳过。

### 冰豆（Web 会话指示器）

仅 **Web 聊天页** 的 Canvas 宠物「冰豆」，把后端 Harness / Supervisor / TaskGraph 事件映射成可见反馈，**不参与**运行时决策。

- **L0 眼色**：侧栏底栏 `off` / `adaptive` / `strict` 三档对应不同瞳孔/高光。
- **L1 角标**：底部 `forced · …` chip，与 `execution_mode_enter` 原因对齐。
- **表情与 token 环**：约 20 种表情（运行中、等待工具、成功、失败、压缩等）+ 外圈 token 用量。
- 桌面端最小化主窗口时，可在桌面显示同一只宠物；任务结束可发系统通知。两者都在设置里开关。

### 文件记忆（Memory v2）

长期事实以 **Markdown 文件** 落在 `data/memory-files/`（及用户记忆目录），无需外置向量库。知识库「记忆」页用图谱浏览。

- **结构化分级**：`hard_rule` / `project_fact` / `preference` / `observation` / `session_state`，配合 `evidenceStrength` 参与排序与淘汰。
- **意图感知召回**：按 execute / inspect / question 过滤；同主题冲突记忆**同轮只注入一侧**。
- **粗召回（pre-LLM）**：按关键词从文件记忆拉最多 3 条注入提示。
- **提取与维护（post-tool）**：工具执行后写入/更新片段；**Dream** 与淘汰策略控制体积与冲突。
- **会话笔记**：`session-notes` 与 `icecoder-runtime` 块保存压缩前快照。
- 可导出 ZIP。导入需要自行把 Markdown 放回记忆目录。

### Agent Skills 与用户规则

可复用的 **Markdown 技能** 在 `data/skills/`（`ICE_SKILLS_DIR`）。

- **技能页**：列表、预览、新建简单技能、编辑、删除。带脚本的技能在聊天里用「创建技能」来写。
- **聊天 `#` 选择器**：输入 `#` 挂上技能 chip，发送时把正文注入提示词。
- **用户规则**（`#/rules`）：对所有工作区生效的全局提示，每次对话都会带上，有总字数上限。
- **API**：`GET/POST/PUT/DELETE /api/skills`。Agent 创建或修改技能只能写在 `ICE_SKILLS_DIR`。

### 多模型、推理强度与图片

同一 Provider 可在 **`modelName`** 里写多个模型（英文逗号分隔）。聊天页底部切换，选中值写入 `activeModelName`。

- **推理强度**：`reasoningEffort` 同样用逗号列出档位（如 `low,high,max`），输入区旁边切换。OpenAI 兼容发 `reasoning_effort`，Anthropic 发 `thinking`。留空则不发。
- **接口**：OpenAI 兼容，默认 `/v1/chat/completions`，也可选 `/v1/responses`。
- **`supportsVision`**（默认 `true`）：先发多模态；API 拒绝图片时去图重试一次，并说明当前模型不支持识图。
- **`supportsVision: false`**：图片落到 `imagesCache`，提示模型用 **`image_read`** 读绝对路径。`image_read` 本身不会走这次去图重试。

字段说明见 [`docs/使用文档.md` §配置](./docs/使用文档.md#配置)。

### 多会话、移动端 H5 与跨端同步

侧栏对会话增删改查。每条会话有自己的历史、`session-notes`、checkpoint 和 **工作区根目录**。

- **移动端 H5**：`#/m/work`、`#/m/work/:sessionId`、`#/m/tasks`、`#/m/skills`、`#/m/memory`、`#/m/rules`、`#/m/config`。
- **`~scan`**：二维码把手机和电脑绑到 **同一个会话 id**。
- 刷新或断线后，**runningTurn** 会把进行中的流式输出和子 Agent 卡片接回来。

### 文件引用与系统浏览

- **`@` 工作区引用**：级联选择器浏览会话工作区（`/api/workspace/browse`），选中路径以 chip 留在输入框上方。
- **系统文件工具**：`list_drives`、`browse_directory`、`open_file`。
- **`/open`**：服务端直接列目录，避免模型编造磁盘列表。

### Checkpoint、压缩与断点恢复

磁盘 checkpoint 带上任务态、TaskGraph/`runtimeV2`、BranchBudget、Supervisor 快照。写盘在 Harness 里串行，避免文件写坏。

- **硬压缩后**重新注入 TaskState + RepoContext。
- **F5 / WebSocket 重连**靠 `runningTurn` 和 checkpoint 重放。
- 没有 `runtimeV2` 的旧 checkpoint 仍能读。

### 工具（内置 + MCP）

默认模式大约 **30** 个内置工具：文件读写与补丁、`glob` / `grep`、Git、`run_command`、搜索与 URL、Office / XMind / notebook 解析、系统文件浏览、`image_read`、`undo_edit`、`env_info`，以及 `task`、`check_agent`、`scheduled_task`。

Shell 协作会话另外使用 `interactive_shell`、`shell_exec`、`shell_wait`、`shell_send_keys`。**MCP** 把外部 Server 的工具注册进同一个 `ToolRegistry`。需要多轮 `input_required` 的 MCP 工具目前会直接返回不支持。

- **Shell 双轨**：长命令进后台，短命令在前台；软超时后可以升级为后台，避免 `npm test` 堵住聊天。
- **Diff**：编辑类工具在聊天里嵌 Git 风格 diff。
- **权限**：需要确认但没有 UI 回调时默认拒绝。设置里可以跳过普通确认；命中 Shell 强制确认规则的命令仍然要人点通过。灾难性命令和宿主进程保护始终生效。
- **文档工具按需携带**：解析类工具不必每次都塞进提示词。

### 遥测与可观测性

Harness 轮次、记忆操作、L1 模式切换写入 `data/*/telemetry.jsonl`（`execution_mode_enter` / `exit`）。Token 用量是独立 JSONL。统计页按当前时间范围拆成会话、子 Agent 和记忆。

- Web：`~tokens`、`~telemetry`、`~supervisor`。
- HTTP：`GET /api/supervisor/events` 返回 Execution Mode 进入/退出。
- 命令与路径详见 [`docs/使用文档.md`](./docs/使用文档.md)。

### 测试与质量基线

`test/**/*.test.ts` 现有 **410** 个文件，覆盖 Harness 门禁、TaskGraph、子 Agent、定时任务、记忆、Web 路由和部分前端页面。用例数和覆盖率以本地命令为准，不再沿用旧的「约 2000 条 / 78%」口径。

- `npm test` · `npm run test:coverage` · `npm run lint`
- **`npm run eval:agent`**：Agent 行为回归。`--mode=local` 跑带 `scriptedTurns` 的本地改文件用例；`--mode=mock` 不给这些用例发假通过分。详见 [`docs/harness/收尾策略-模型停手与验收门控-finish.md`](./docs/harness/收尾策略-模型停手与验收门控-finish.md)。
- **`npm run telemetry:runtime`**：汇总 runtime 遥测 JSONL。

### 本地 Benchmark

与 **Claude Code** 等同模型、同 prompt、同沙箱的历史对比；看 **验收通过率（SR）** 和 **Composite（Gate 40 + Judge 60）**。下面的表是已归档跑分，不是当前 `HEAD` 的自动结果。

- 任务分层 **L1–L8**（billing L4+：97 文件 19 BUG；L7 融合 33 探针；**L8 SaaS 融合**：多租户订单 × 供应链 × 审批 × 计费）。
- 跑法：[`docs/使用文档.md` §本地 Benchmark](./docs/使用文档.md#本地-benchmark) · 体系 [`benchMark/md/三平台同模对比评测与裁判评分体系.md`](./benchMark/md/三平台同模对比评测与裁判评分体系.md)。

**深入阅读：** 监管 → [`docs/双模机制详解.md`](./docs/双模机制详解.md) · 记忆 → [`docs/记忆系统详解.md`](./docs/记忆系统详解.md) · 压缩 → [`docs/压缩机制详解.md`](./docs/压缩机制详解.md) · 全貌 → [`docs/项目介绍.md`](./docs/项目介绍.md) · 移动端 → [`docs/requirement/移动端H5-Shell方案-finish.md`](./docs/requirement/移动端H5-Shell方案-finish.md) · 子 Agent 设计 → [`docs/requirement/多agent协同.md`](./docs/requirement/多agent协同.md)

---

## 本地 Benchmark 跑分

裁判：**Cursor Composer 2.5** · 体系：[`benchMark/md/三平台同模对比评测与裁判评分体系.md`](./benchMark/md/三平台同模对比评测与裁判评分体系.md)  
报告：[`benchMark/reports/`](./benchMark/reports/) · 任务：[`benchMark/tasks/`](./benchMark/tasks/) · **如何跑：** [`docs/使用文档.md` §本地 Benchmark](./docs/使用文档.md#本地-benchmark)

> 跨平台对比须 **同模型批次**（`m2.7` / `m2.5-pro` / `MiniMax-M3` 勿混比）。

| 任务 | 平台 | 模型 | SR | Composite | 相对 CC | 耗时 |
|------|------|------|-----|-----------|---------|------|
| [订单流水线](./benchMark/reports/multi-file-order-pipeline.md) | iceCoder | m2.7 | ✅ | **86** | +3 | — |
| [Saga 对账](./benchMark/reports/saga-warehouse-reconciliation-basic.md) | iceCoder | m2.7 | ✅ | **88** | +3 | — |
| [Spell Brigade](./benchMark/reports/implement-spellbrigade-survivor.md) | iceCoder / CC | m2.5-pro | 1 / 1 | **81** / **80** | +1 | ~120分 / 87分 |
| [计费 19 BUG](./benchMark/reports/debug-billing-settlement.md) **01** | iceCoder | **MiniMax-M3** | ✅ 19/19 | **93** | 比 02 +1 | **≈3.6 分** · 23 轮 |
| [计费 19 BUG](./benchMark/reports/debug-billing-settlement.md) **02** | CC | **MiniMax-M3** | ✅ 19/19 | **92** | — | **5 分 45 秒** |
| [融合 L7 33 探针](./benchMark/reports/debug-fusion-supply-fintech.md) **01** | iceCoder | **MiniMax-M3** | ✅ 33/33 | **91** | — | **≈5.3 分** |
| [融合 L7 33 探针](./benchMark/reports/debug-fusion-supply-fintech.md) **02** | CC | **MiniMax-M3** | ✅ 33/33 | **92** | +1 | **6m 17s** |
| [SaaS L8 融合](./benchMark/reports/debug-saas-order-supply-approval-fusion-05.md) **01** | iceCoder | GPT-5.5 裁判 | ✅ 7/7 Gate | **71** | 比 02 +2 | **≈16 分** · 122 轮 |
| [SaaS L8 融合](./benchMark/reports/debug-saas-order-supply-approval-fusion-05.md) **02** | CC | GPT-5.5 裁判 | ✅ 7/7 Gate | **69** | — | **≈5 分** |

**结论：** 同模同仓 — iceCoder 在验收通过、综合分或 L4+ 墙钟上更稳；CC 在个别模块实现或纯速度上可更优。L8 双方公开 Gate 均为 **38/40**，实现相对 160–220 文件设计口径偏薄；iceCoder **+2** Composite（71 vs 69）主要来自发货超量修复。

---

## 架构（简图）

```text
CLI / Web / WS / 移动端 H5
  → 记忆 + 技能 + 用户规则
  → Harness（工具、停时验收、压缩）
       → 子 Harness（task：general / explore，可后台）
  → TaskGraph → Supervisor L0/L1/L3
  → Checkpoint + 写租约
  → 内置工具 + MCP
```

| 模块 | 作用 |
|------|------|
| **Harness** | 主循环、D′ 停时验收、压缩、遥测 |
| **子 Agent** | `task` / `check_agent`；子 Harness 写同一工作区，文件租约防冲突 |
| **Supervisor** | L0 档位 + L1 free/forced + L3 图硬约束 |
| **TaskGraph** | 结构化计划注入；不调度 Agent |
| **文件记忆** | Memory v2：分级 / 证据强度 / 冲突裁决 + 会话笔记 |
| **Skills / 规则** | 技能 Markdown 与全局用户规则 |
| **定时任务** | 间隔或日历调度，专属会话 |
| **Web / 移动端** | 冰豆、多会话、H5、`@`/`#`、Diff、`/` 与 `~` 命令 |

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [**使用文档**](./docs/使用文档.md) | **命令大全** — 安装、dev、CLI、测试、Benchmark、命令 |
| [**Shell 协作（/shell）**](./docs/shell协作模式.md) | SSH / 交互终端：进入方式、安全、与 `run_command` 的区别 |
| [**使用文档 · 桌面打包**](./docs/使用文档.md#桌面打包electron) | Electron 打包、`node-pty`、VS 2022 / Windows SDK |
| [**多 Agent 协同**](./docs/requirement/多agent协同.md) | `task` 子 Harness 的设计（含尚未落地的自定义类型与 worktree） |
| [PROJECT-GUIDE](./docs/PROJECT-GUIDE.md) | 架构与模块（部分段落仍写旧的 `request_analysis`） |
| [项目介绍](./docs/项目介绍.md) | 中文架构说明（同上，以本 README 和源码为准） |
| [记忆系统详解](./docs/记忆系统详解.md) | Memory v2 |
| [压缩机制详解](./docs/压缩机制详解.md) | 分层压缩 + 结构化恢复 |
| [双模机制详解](./docs/双模机制详解.md) | L0 / L1 / L3 |
| [L2监管层详解](./docs/L2监管层详解.md) | L2 退役说明 |
| [PACKAGE_USAGE](./PACKAGE_USAGE.md) | 打包安装 |
| [Benchmark 体系](./benchMark/md/三平台同模对比评测与裁判评分体系.md) | 评分方法 |

---

## 许可证

MIT — 见 [LICENSE](./LICENSE)
