# iceCoder 架构与运行时说明

iceCoder 是面向本地代码仓库的 **工具化 LLM 运行时**：以 Harness 为核心，把提示词系统、工具执行、任务状态、仓库上下文、长期记忆、会话记忆、上下文压缩和评测骨架组合在一起，并提供 **CLI、HTTP API、WebSocket 聊天与静态 Web 前端**（可选接入 **MCP** 工具），目标是接近 Claude Code / Codex CLI 等工具在**可靠执行工程任务**上的表现。

**技术栈：** Node.js 18+、TypeScript、Express（生产环境托管 SPA）、Vite（开发态独立端口）、WebSocket、Vitest。

**已从代码库移除：** 早期的**多阶段流水线**及按阶段注册的 **Agent** 抽象（如 `BaseAgent`、`executePipeline`、阶段报告生成等）。当前 `Orchestrator` 仅聚合 `FileParser` 与 `LLMAdapter`，供 WebSocket 聊天等入口共享实例。

[English](./README.md) | [后续优化计划](./nextWork.md)

---

## 1. 当前状态

当前已经完成 Runtime P0/P1 的核心整改，重点解决“该干活时不干活”“改完不验证”“权限规则不生效”“压缩丢短指令”等问题。

验证命令：

```bash
npx tsc --noEmit
npm test
npm run eval:agent
```

**测试基线请以 `npm test` 终端输出为准。** 用例分布在 `test/**/*.test.ts`，规模约为 **30+ 个测试文件、550+ 条用例**（随提交增减会变化）。

---

## 2. 总体架构

```text
CLI / Web / Remote
  -> loadAssembledChatPrompt()
  -> HarnessConfig
      -> ContextAssembler
      -> LLMAdapter
      -> ToolExecutor
      -> HarnessMemoryIntegration
      -> ContextCompactor
  -> Harness.run()
```

核心模块：

| 模块 | 职责 |
|---|---|
| `src/prompts/*` | 提示词分段、静态 system、动态 overlay、评测/禁工具模式 |
| `src/harness/harness.ts` | 带工具调用的 LLM 主循环、执行、恢复、权限、验证门禁 |
| `src/harness/task-state.ts` | 当前任务状态账本 |
| `src/harness/repo-context.ts` | 仓库上下文账本 |
| `src/harness/context-assembler.ts` | 组装 system prompt 与动态上下文 |
| `src/harness/context-compactor.ts` | 微压缩、硬压缩、恢复提示、文件内容重注入 |
| `src/harness/harness-memory.ts` | 长期记忆召回/注入/提取与会话记忆协作 |
| `src/memory/file-memory/*` | 文件化长期记忆完整生命周期 |
| `src/tools/*` | 工具注册、执行、元数据、权限辅助 |
| `src/llm/*` | OpenAI / Anthropic 兼容适配器 |
| `src/mcp/*` | MCP 子进程客户端，将外部 Server 工具并入 `ToolRegistry` |
| `src/web/*` | Express、`/api/*` 路由、统一聊天 WebSocket |
| `src/public/*` | Vite 前端根目录（聊天页、配置 UI、**会话宠物** Canvas 与桥接脚本等） |
| `src/types/runtime-snapshot.ts` | 会话笔记中 `icecoder-runtime` 块的版本化 JSON 模型 |

---

## 3. Harness 运行流程

Harness 是运行时核心。它负责把“模型想做什么”变成“实际执行了什么”。

```text
初始化消息
初始化 TaskState
初始化 RepoContext
while running:
  maybeCompact()
  注入 Runtime State / Repo Context
  normalizeMessages()
  调用 LLM(messages, tools)

  if toolCalls:
    权限裁决 allow/confirm/deny
    执行工具
    更新 TaskState / RepoContext
    失败恢复与重复失败检测
    注入相关记忆
    continue

  else:
    no-tool recovery
    verification gate
    stop hooks
    final
```

### 3.1 已完成的运行时保障

| 能力 | 状态 |
|---|---|
| 无工具早停兜底 | 执行型任务没调用工具时会自动要求继续执行 |
| 工具调用判定放宽 | 只要 `toolCalls` 非空就执行，不强依赖 `finishReason` |
| 权限规则 | `allow / confirm / deny` 已进入工具执行前置裁决 |
| confirm 缺省安全 | 需要确认但没有 UI 回调时默认拒绝 |
| Task State v1 | 跟踪任务 intent、phase、改动文件、验证状态 |
| Verification Gate v1 | 改过代码但未验证时不能直接完成 |
| RepoContext v1 | 跟踪读过/改过文件、运行命令、测试命令、诊断 |
| 压缩恢复 Runtime Context | 硬压缩后重新注入 `TaskState + RepoContext`，保留目标、改动文件和验证命令 |
| 重复失败检测 | 同工具同参数重复失败时提示换策略 |
| 短指令保护 | 微压缩不会删除“跑测试”“继续”等短执行指令 |
| 会话记忆 force 更新 | 压缩前可强制备份当前会话状态 |

### 3.2 子代理（Sub-Agent Runner）

`src/harness/sub-agent-runner.ts` 提供**隔离的只读子代理**用于代码库探索。主模型调用 `delegate_to_subagent` 时，它会启动一个私有消息循环，使用白名单工具集（仅 `read_file`、`search_codebase`、`fs_operation list`）。子代理独立运行（60s 超时、上限 10 轮），读取文件、搜索代码后返回**结构化摘要**而非原始文件内容。

这解决了"上下文污染"问题：以前每次探索任务都会把大量搜索结果和文件内容直接丢进会话历史，加速压缩并浪费 token。有了子代理后，主上下文只收到短摘要（约几百 token），探索引起的上下文膨胀降低约 60-80%。

子代理还带有**进程级 LRU 缓存**（默认 100 条，按 task + filesRead + mtime 作为键），文件未变时跳过重复执行。

关键组件：
- `SubAgentRunner` — 带超时和轮次限制的隔离消息循环
- `delegate_to_subagent` — 暴露给模型委派探索任务的工具
- `formatSubAgentResult()` — 将结构化结果格式化为主会话可读的工具结果

### 3.3 工具规划提示（Tool Planner）

对首轮即判定为**可执行工程任务**的对话，Harness 可注入 **Tool Planner**：依据 `taskState.intent`（如 debug / edit / test）给出 **2～3 个优先建议工具名**（映射表见 `src/harness/tool-plan-intent-map.ts`，逻辑见 `src/harness/tool-planner.ts`），减少模型开场「只寒暄不调用工具」的情况。

---

## 4. 提示词系统

提示词系统采用静态层和动态层分离。

### 4.1 静态 System Prompt

由 `src/prompts/sections.ts` 定义，经 `PromptAssembler` 拼装。内容包括：

- 身份与工作方式
- action-first 行为
- 执行规则
- 修改规则
- 工具使用原则
- Shell/Git 规范
- 上下文管理提醒

静态层尽量稳定，便于 provider 侧 prompt cache 命中。

### 4.2 动态上下文

由 `ContextAssembler` 注入，包含：

- 工作目录、平台、日期
- 语言设置（仅显式配置时）
- 记忆提示词
- 项目说明
- Runtime State
- Repo Context
- 相关长期记忆

### 4.3 工具禁用模式

`ICE_EVAL_MODE=1` 或 `ICE_DISABLE_TOOLS=1` 时：

- 移除工具相关提示段
- runtime 传入 `tools: []`

这样评测/禁工具模式不会出现“提示词说不能用工具但 runtime 仍提供工具”的不一致。

---

## 5. 工具系统

工具系统位于 `src/tools/`。

核心组件：

| 组件 | 作用 |
|---|---|
| `ToolRegistry` | 注册和导出工具定义 |
| `ToolExecutor` | 执行工具、超时、重试、参数校验 |
| `StreamingToolExecutor` | 多工具执行与输出流转发 |
| `tool-metadata` | 只读、破坏性、并发安全、结果大小等元信息 |
| Harness permissions | 执行前权限裁决 |

主要工具类别：

- 文件读取、写入、编辑、patch
- shell 命令
- git
- 代码搜索
- 文档解析
- Web 搜索/抓取
- 环境信息、diff、撤销编辑

---

## 6. Task State 与 Repo Context

### 6.1 Task State

`TaskState` 是当前任务的结构化账本，记录：

```json
{
  "goal": "修复失败测试",
  "intent": "debug",
  "phase": "verification",
  "filesRead": ["src/a.ts"],
  "filesChanged": ["src/a.ts"],
  "commandsRun": ["npm test"],
  "verificationRequired": true,
  "verificationStatus": "passed"
}
```

作用：

- 判断是否需要验证
- 阻止“改完直接说完成”
- 为压缩恢复提供结构化状态

### 6.2 Repo Context

`RepoContext` 是仓库上下文账本，记录：

- 读过的文件
- 改过的文件
- 运行过的命令
- 测试命令
- 最近诊断/错误

一旦有有效状态，Harness 会在下一轮 LLM 前注入：

```text
[System Runtime State]
# Runtime State
...
# Repo Context
...
[/System Runtime State]
```

这样模型不必从长历史里重新推断当前任务状态。

---

## 7. 记忆系统

iceCoder 的长期记忆是文件化的，不依赖外部数据库。

### 7.1 记忆类型

| 类型 | 用途 |
|---|---|
| `user` | 用户角色、目标、明确偏好 |
| `feedback` | 用户纠正或行为反馈 |
| `project` | 项目事实、约定、目标 |
| `reference` | 外部系统、链接、文档引用 |

### 7.2 记忆生命周期

```text
对话
  -> 触发提取
  -> LLM 提取
  -> 密钥扫描
  -> 去重 / 冲突检测
  -> 写入 memory-files
  -> 后续召回
  -> 相关性门控
  -> CoN + JSON 注入
  -> Dream 整合
  -> 衰减 / 淘汰
```

### 7.3 召回流程

```text
用户查询
  -> 扫描记忆文件
  -> 置信度过滤
  -> FactIndex 构建/缓存
  -> 候选足够时 LLM recall
  -> 候选不足时 keyword fallback
  -> 关联扩展
  -> relevance gate
  -> 执行型任务门控
  -> token 预算过滤
  -> 注入结构化 JSON 记忆
```

### 7.4 已收紧的策略

- 召回从“宽泛相关”改为“严格相关”。
- 编码/调试/编辑任务优先注入项目事实和技术约束。
- 用户偏好只有强匹配当前动作时才注入。
- 记忆提取从“宁滥勿缺”改为“证据优先”。
- 单次弱信号不应进入长期记忆，交给会话记忆处理。


### 7.5 Dream 整合与记忆淘汰

- 这块参考了claudeCode的创意

`src/memory/file-memory/memory-dream.ts` 运行周期性"做梦"过程（类比人类睡眠记忆整合），对记忆文件进行审查、去重和修剪。触发条件：

- 会话数达到阈值（每 5 次会话）
- 记忆文件数超过阈值（默认 30 个）
- 上次 Dream 后有新文件 ≥ 10 个
- 检测到过期记忆 ≥ 3 个
- MEMORY.md 索引中存在死链接
- 记忆数超过 Dream 后上限

Dream 阶段：**定向** → **收集** → **整合** → **修剪**。整合后，如果配置了 `enforceMemoryCapAfterDream` / `enforceUserMemoryCapAfterDream`，会自动执行上限强制淘汰，分别作用于项目级和用户级记忆目录。

`src/memory/file-memory/memory-eviction.ts` 实现**加权评分淘汰**（非纯 LRU）。评分因素：

| 因素 | 范围 | 效果 |
|---|---|---|
| 新鲜度惩罚 | 0-100 | 越久不活跃分越高（更易淘汰） |
| 置信度保护 | 0-30 | 高置信度记忆受保护 |
| 召回频率保护 | 0-20 | 经常被召回的受保护 |
| 类型保护 | 0 或 15 | `user` 类型受保护 |
| 层级保护 | -18 到 35 | `hard_rule` > `preference` > `project_fact` > `observation` > `session_state` |
| 证据强度保护 | -16 到 28 | `explicit` > `repeated` > `inferred` > `weak` |
| 来源保护 | 0-30 | `user_explicit` > `manual` > `dream` > `llm_extract` |
| 类型淘汰偏置 | 可配置 | `feedback` / `reference` 类型偏向淘汰 |

安全保障：
- `confidence >= 1.0` 的记忆永不淘汰（用户明确声明）
- 保护期内的活跃记忆不淘汰
- `MEMORY.md` 索引文件本身永不淘汰
- 被淘汰文件移入 `evicted/` 目录（可通过 `restoreEvicted()` 恢复）
- 淘汰日志写入 `evicted/eviction-log.jsonl`
- 自动清理过旧归档文件

---

## 8. 会话记忆与压缩

### 8.1 会话记忆

会话记忆是当前会话的长期工作笔记，位于 `data/sessions/session-notes.md`。

包含 10 个 section：

1. Session Title
2. Current State
3. Task Specification
4. Files and Functions
5. Workflow
6. Errors & Corrections
7. Codebase Documentation
8. Learnings
9. Key Results
10. Worklog

当前实现：

- 支持压缩前 force 更新
- LLM 直接返回 Markdown
- 写入前校验结构
- 压缩后优先作为恢复上下文

### 8.2 上下文压缩

压缩器分层工作：

1. snip 重复 reminder / summary
2. microcompact 轻量压缩
3. trimToolResults 裁剪工具输出
4. structuralExtract 本地结构化摘要
5. 可选 LLM summary
6. 重注入最近文件内容与恢复提示

上下文窗口优先级：

```text
ICE_CONTEXT_WINDOW
  -> 默认 provider maxContextTokens
  -> 最大 provider maxContextTokens
  -> 128k 默认
```

---

## 9. Web 服务、MCP 与配置

| 组件 | 默认端口 | 说明 |
|------|----------|------|
| Express（`src/index.ts`） | **1024**（`PORT`） | REST API；生产环境同时托管 `dist/public` 静态 SPA |
| Vite 开发服务器（`vite.config.ts`） | **1025** | 开发态 UI；`/api` 与 WS 代理到 `localhost:1024` |

主要 API 前缀：`/api/config`、`/api/tools`、`/api/remote`、`/api/sessions`、`/api/chat/upload`、`/api/memory/*`。提供者配置默认读取 **`data/config.json`**（可参考 `data/config.example.json`）；`src/index.ts` 支持对配置文件 **watch 热重载** 提供者。

### 会话宠物（Web 聊天指示器）

**仅 Web 聊天页**：在 `src/public` 中用 Canvas 绘制的「会话状态宠物」，用于把 **轮次、思考、工具进度、记忆提示** 等映射成表情与气泡，**不修改** Harness 与后端协议逻辑。

| 方面 | 说明 |
|------|------|
| **外观** | 约 120×120 逻辑像素、黑底胶囊眼；**眼睛颜色**在页面加载时从 `session-pet-palette.js` 色板随机选取，与 token 百分比无关（纯装饰）。 |
| **外圈圆环** | 自顶端顺时针，表示**上下文 / token 占用**大致比例（绿→黄→红渐变）。 |
| **表情** | 对外约 **20** 种状态（含眨眼等），由 `chat-pet-bridge.js` 根据 WebSocket 推送的步骤事件（与 `HarnessStepEvent` 对应）在 `chat-page.js` 中更新。 |
| **交互** | 可拖动改位置，位置存 `localStorage`（键 `ice-session-pet-position`）；**双击**恢复默认摆放；Canvas 的无障碍文案由 `buildSessionPetCanvasAriaLabel` 生成。 |
| **相关文件** | `src/public/js/session-pet.js`、`session-pet-palette.js`、`chat-pet-bridge.js`；样式在 `src/public/css/style.css`；入口侧在 `chat-page.js`、`main.js`。 |
| **联调页** | `src/public/pet-expressions-demo.html` 与 `pet-expressions-demo.js`，用于手动切换表情验收。 |
| **测试** | `test/public/session-pet-palette.test.ts`、`session-pet-expression-cycle.test.ts`。 |

**CLI / 纯终端模式没有宠物**；它是 SPA 聊天的可选视觉反馈，与核心运行时解耦。

### MCP

`src/mcp/mcp-manager.ts` 从**项目工作目录**下的 **`.iceCoder/mcp.json`** 读取顶层 **`mcpServers`**（可用环境变量 **`ICE_MCP_CONFIG_PATH`** 指向其他文件）。为每个启用的 Server 拉起子进程并把其工具注册进主 **`ToolRegistry`**（工具名形如 `mcp_服务器名_工具名`）。初始化失败会打日志但不阻断核心服务。模板见 **`.iceCoder/mcp.example.json`**。命令行：`iceCoder mcp`。

**说明：** LLM 提供者仍在 `data/config.json`（或 `ICE_CONFIG_PATH`）；MCP 与主配置已拆分。

### 常用环境变量

| 变量 | 作用 |
|------|------|
| `ICE_CONFIG_PATH` | 配置 JSON 路径（默认 `data/config.json`） |
| `ICE_OUTPUT_DIR` | 通用输出目录（默认 `output`） |
| `ICE_SESSIONS_DIR` | 会话目录（默认 `data/sessions`） |
| `PORT` | HTTP 端口（默认 `1024`） |
| `NODE_ENV` | `production` 时静态资源与 SPA 回退行为按生产处理 |
| `ICE_CONTEXT_WINDOW` | 覆盖上下文窗口上限 |
| `ICE_MCP_CONFIG_PATH` | 可选：MCP 专用 JSON 的绝对路径（默认 `<运行目录>/.iceCoder/mcp.json`） |
| `ICE_MCP_INIT_TIMEOUT_MS` | MCP 握手 `initialize` 超时（毫秒，默认 `120000`；Puppeteer 首次 `npx` 拉包过慢时可加大） |

### 仓库目录（摘要）

```text
src/cli/          CLI 与 bootstrap
src/core/         Orchestrator
src/harness/      Harness、压缩、子代理、Tool Planner、任务/仓库状态
src/memory/       文件化记忆、会话笔记、Dream、淘汰
src/tools/        内置工具与执行器
src/mcp/          MCP 管理
src/web/          Express、路由、WebSocket
src/public/       前端（Vite root）：聊天页、会话宠物 Canvas/桥接、静态资源
src/types/        共享类型（含运行时快照 schema）
test/             Vitest
data/             配置与会话数据
```

---

## 10. 运行时评测（eval 骨架）

`npm run eval:agent` 为**历史脚本名**；当前提供的是最小 eval 骨架（指标名与 case 分类），尚未实现完整判分 Runner。

```bash
npm run eval:agent
```

输出内容包括：

- case 列表
- 指标名
- 基准任务类型

当前指标名：

- `task_success_rate`
- `tool_call_rate`
- `first_tool_latency`
- `no_tool_final_rate`
- `verification_rate`
- `repeat_failure_rate`
- `memory_interference_rate`
- `tokens_per_successful_task`
- `compaction_saved_tokens`

这还是骨架，后续需要升级为真正可判分的 eval runner。

---

## 11. 开发与验证

```bash
npm install
npx tsc --noEmit
npm test
npm run eval:agent
```

常用运行方式：

```bash
npm run dev
npm run dev:api
npm run dev:web
npx tsx src/cli/index.ts run "修复失败测试"
```

---

## 12. 会话压缩与恢复（Runtime 持久化）

每次会话笔记（`session-notes.md`）在 **Runtime Evidence (auto)** 一节中除人类可读摘要外，会写入 fenced 块 \`\`\`icecoder-runtime：内含 `TaskState` 与 `RepoContext` 的结构化 JSON（带体积上限）。**续聊且已有消息历史时**，Harness 会优先从该块 **`applySnapshot` 到内存**，从而在进程或页面重载后仍能恢复目标、阶段、已读/已改文件与验证状态，而不必仅靠自然语言猜测。

持久化 JSON 的 **schema**（`PersistedRuntimeV1`、`TaskStateSnapshot`、`RepoContextSnapshot` 等）统一定义在 **`src/types/runtime-snapshot.ts`**：`session-memory` 只依赖该公共模块，与 `task-state` / `repo-context` 实现类解耦，避免 memory 层反向引用 harness。

（首轮任务时的 **Tool Planner** 行为见上文 §3.3。）

---

## 13. 当前仍需优化

后续工作主要包括：

1. Memory v2 结构化分级：hard_rule / project_fact / preference / observation / session_state。
2. 压缩与会话笔记的进一步耦合（如压缩前后 token 统计、恢复上下文预算裁剪等）——**结构化 `icecoder-runtime` 快照已可写入 `session-notes.md`**，细节见 `nextWork.md`。
3. 正式 **Eval Runner**：真实执行、判分、输出趋势。
4. Runtime Telemetry 落盘：工具调用率、验证率、token 成本、记忆干扰率。
5. 在现有 **Tool Planner** 之上，加强按失败模式动态规划与恢复策略。

---

## 14. 项目目标

iceCoder 的目标不是“回答更像聊天机器人”，而是：

```text
用户给任务
  -> 系统稳定执行
  -> 修改可验证
  -> 上下文可恢复
  -> 成本可度量
  -> 回归可阻断
```