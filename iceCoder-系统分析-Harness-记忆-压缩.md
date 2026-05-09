# iceCoder 系统分析：Harness · 记忆系统 · 压缩系统

> **分析日期**: 2026-05-09  
> **项目**: iceCoder v1.0.0  
> **类型**: 基于 TypeScript 的 AI 编码辅助工具（PC/Mobile）

---

## 一、已读取的文件清单

### Harness 模块 (`src/harness/`)

| # | 文件 | 行数 | 核心职责 |
|---|------|------|----------|
| 1 | `harness.ts` | 1609 | 核心循环引擎（状态机模式） |
| 2 | `types.ts` | ~140 | Harness 层所有类型定义 |
| 3 | `index.ts` | ~50 | 模块统一导出 |
| 4 | `context-assembler.ts` | ~260 | 上下文组装器（提示词拼接） |
| 5 | `context-compactor.ts` | 923 | 上下文压缩器（五层递进压缩） |
| 6 | `loop-controller.ts` | ~120 | 循环生命周期控制 |
| 7 | `harness-memory.ts` | ~800 | 记忆集成层（v5 CoN + JSON） |
| 8 | `logger.ts` | ~100 | 结构化日志器 |
| 9 | `permission.ts` | ~110 | 工具权限管理器 |
| 10 | `stop-hooks.ts` | ~75 | 停止钩子（循环结束前检查） |
| 11 | `task-state.ts` | ~120 | 任务状态追踪（阶段/验证） |
| 12 | `repo-context.ts` | ~65 | 仓库上下文追踪 |
| 13 | `checkpoint.ts` | ~150 | 任务检查点持久化 |
| 14 | `tool-planner.ts` | ~75 | 工具使用规划推荐 |
| 15 | `streaming-tool-executor.ts` | 164 | 流式并行工具执行 |
| 16 | `runtime-telemetry.ts` | 94 | 运行时遥测事件记录 |
| 17 | `token-budget.ts` | 91 | Token 预算追踪器 |
| 18 | `token-budget-config.ts` | ~35 | Token 预算环境变量配置 |

### 记忆系统 (`src/memory/file-memory/`)

| # | 文件 | 行数 | 核心职责 |
|---|------|------|----------|
| 1 | `index.ts` | ~100 | 统一导出入口 |
| 2 | `types.ts` | ~120 | 记忆类型定义（4 种类型 + frontmatter） |
| 3 | `memory-config.ts` | ~250 | 统一配置中心（SSOT） |
| 4 | `file-memory-manager.ts` | ~230 | 文件记忆管理器（集成入口） |
| 5 | `memory-prompt.ts` | ~140 | 记忆提示词构建器 |
| 6 | `memory-scanner.ts` | ~170 | 记忆目录扫描器 |
| 7 | `memory-recall.ts` | ~800 | LLM 驱动的相关性召回（v5） |
| 8 | `memory-llm-extractor.ts` | 540 | LLM 驱动的记忆自动提取 |
| 9 | `memory-dream.ts` | 786 | autoDream 记忆整合（Orient/Gather/Consolidate/Prune） |
| 10 | `multi-level-memory.ts` | ~160 | 三级别加载（user → project → directory） |
| 11 | `session-memory.ts` | 394 | 会话记忆（10-section 结构化笔记） |
| 12 | `memory-eviction.ts` | 291 | LRU 加权淘汰机制 |
| 13 | `memory-age.ts` | ~100 | 记忆新鲜度追踪 |
| 14 | `memory-concurrency.ts` | ~100 | 并发控制与锁机制 |
| 15 | `memory-security.ts` | ~100 | 路径安全验证 |
| 16 | `memory-fact-index.ts` | ~80 | Fact 索引 |
| 17 | `memory-telemetry.ts` | ~100 | 记忆系统遥测 |
| 18 | `memory-tokenizer.ts` | ~80 | 记忆 token 化 |
| 19 | `memory-parser.ts` | ~50 | Markdown 正文提取 |
| 20 | `memory-secret-scanner.ts` | ~80 | 敏感信息扫描 |
| 21 | `memory-scanner-cache.ts` | ~80 | 扫描缓存 |
| 22 | `memory-remote-config.ts` | ~100 | 远程动态配置 |
| 23 | `async-prefetch.ts` | ~100 | 异步预取 |
| 24 | `json-parser.ts` | ~50 | LLM JSON 解析 |

### 压缩系统（核心在 `context-compactor.ts`）

同上 `context-compactor.ts`（923 行，完整读取）。

### 数据层

| # | 文件 | 核心内容 |
|---|------|----------|
| 1 | `data/memory-files/MEMORY.md` | 持久化记忆索引（14 条条目） |
| 2 | `data/system-prompt.md` | 系统提示词（iceCoder 角色定义） |

---

## 二、当前任务目标

**全面分析 iceCoder 的三大核心子系统：**

1. **Harness（机模交互循环）** — 理解软件 ←→ 模型之间的核心循环引擎如何工作
2. **记忆系统（持久化 + 会话级）** — 理解跨会话记忆如何存储、召回、整合、淘汰
3. **压缩系统（上下文窗口管理）** — 理解如何防止 token 溢出并在压缩后恢复任务连续性

---

## 三、三大子系统的详细分析

---

### 3.1 Harness — 核心循环引擎

#### 架构定位

Harness 是 iceCoder 的"心脏"——一个 `while(true)` 迭代状态机。它串联 LLM 调用、工具执行、上下文管理、权限控制，形成完整的 Agent 循环。

```
[用户输入]
    ↓
┌─────────────────────────────────────┐
│  Harness 核心循环                    │
│  ┌─────────────┐    ┌────────────┐  │
│  │ 消息预处理   │ →  │ LLM 调用   │  │
│  │ (压缩/预算)  │    │            │  │
│  └─────────────┘    └──────┬─────┘  │
│                            ↓        │
│  ┌─────────────┐    ┌────────────┐  │
│  │ 响应处理     │ ←  │ 工具执行   │  │
│  │ (停止钩子)   │    │ (流式并行) │  │
│  └─────────────┘    └────────────┘  │
│         ↓ continue or stop          │
└─────────────────────────────────────┘
    ↓
[完成 / 停止]
```

#### 核心状态 (`harness.ts:370-378`)

```typescript
state = {
  messages,            // 对话消息历史
  tools,               // 可用工具定义
  transition,          // 当前 transition 原因
  taskState,           // 任务状态（阶段/验证）
  repoContext,         // 仓库操作上下文
  taskSwitchInjected,  // 任务切换标记
  emptyResponseRetryCount,  // 空响应重试计数
  stopHookContinuationCount, // 停止钩子连续干预计数
  noToolExecutionRecoveryCount, // 无工具执行恢复计数
  failedToolCallSignatures,    // 失败工具签名（去重）
  ...
}
```

#### 消息预处理管线 (每轮迭代)

在 `harness.ts` 每轮迭代中（`while(true)` 内），预处理管线按顺序执行：

1. **`maybeCompact()`** — 检查是否需要压缩，需要则执行压缩 + 恢复注入
2. **`normalizeMessages()`** — 合并连续 user 消息、去重 tool_use ID、清理空消息
3. **`applyToolResultBudget()`** — 对工具结果做预算裁剪（保留最近 6 轮的完整结果）
4. **任务切换检测** — bigram Jaccard 相似度分析（阈值 0.15）
5. **中断检查** — `AbortSignal` 检测

#### 停止原因定义 (`types.ts`)

12 种停止原因构成完整的循环终止策略：

| 停止原因 | 触发条件 |
|----------|----------|
| `model_done` | 模型无工具调用，无停止钩子要求继续 |
| `max_rounds` | 达到最大轮次（默认 5000） |
| `token_budget` | Token 预算耗尽（`ICE_HARNESS_TOKEN_BUDGET`） |
| `task_recovery` | 压缩后失忆恢复 |
| `timeout` | 超时（默认 5 小时） |
| `user_abort` | 用户主动中断 |
| `max_output_tokens` | 输出达到上限（finishReason === 'length'） |
| `stop_hook` | 停止钩子连续干预超限（3 次后强制停） |
| `circuit_breaker` | 连续工具失败熔断（10 次） |
| `error` | 不可恢复的 LLM 调用错误 |

#### 流式工具执行

`StreamingToolExecutor` 实现工具级别的流式并行执行——模型还在输出时，已完成的工具调用可立即开始执行。标记为 `isConcurrencySafe` 的工具可以并行运行。

#### 权限系统

`PermissionManager` 三层检查：
1. 用户配置的规则（`allow / confirm / deny`，通配符匹配）
2. 默认危险操作（`execute_shell_command` / `write_file` 需要确认）
3. 默认放行

#### 任务状态机

`TaskState` 追踪五个阶段：`intent → context → editing → verification → final`。自动检测文件读取/写入操作，写入后自动要求验证。

#### 检查点系统

`TaskCheckpointManager` 将当前任务状态持久化为 JSON（包含用户目标、轮次、token 使用、已改文件等），支持会话恢复。

---

### 3.2 记忆系统

#### 整体架构

记忆系统分两大块：

```
持久化记忆（跨会话）             会话记忆（单会话）
┌──────────────────────┐        ┌──────────────────┐
│ data/memory-files/   │        │ data/sessions/    │
│  ├── MEMORY.md (索引) │        │ session-notes.md  │
│  ├── user/ (4 种类型) │        │ (10-section 模板) │
│  ├── feedback/       │        └──────────────────┘
│  ├── project/        │
│  └── reference/      │
│                      │
│ 多级加载:             │
│  user → project → dir│
│ (优先级递增)           │
└──────────────────────┘
```

#### 三种记忆类型

| 类型 | 用途 | 示例 |
|------|------|------|
| `user` | 用户画像 | 角色、目标、偏好、编程语言 |
| `feedback` | 行为反馈 | 用户纠正"不要这样做"、确认"是的" |
| `project` | 项目上下文 | 进行中的工作、截止日期 |
| `reference` | 外部引用 | 文档链接、工具 API |

每条记忆是一个独立的 Markdown 文件，带 YAML frontmatter：

```markdown
---
name: 视觉偏好
description: 偏好醒目混乱多彩视觉风格
type: user
level: preference
evidenceStrength: repeated
confidence: 0.85
tags: [visual, style, frontend]
---
```

#### 记忆生命周期

```
写入（LLM/用户） → 扫描 & 索引 → 召回（LLM sideQuery）
    ↓                                     ↓
淘汰（LRU 加权） ← 整合（Dream） ← 提取（LLM extractor）
```

**具体流程**：

1. **LLM 直接写入** — 主代理在对话中通过 `write_file` 直接写入记忆文件，同时在 MEMORY.md 添加索引行
2. **后台 LLM 提取** (`LLMMemoryExtractor`) — 对话间隙分析消息，符合证据阈值的内容自动提取为记忆
3. **记忆整合** (`MemoryDream`) — 定期"做梦"：Orient → Gather → Consolidate → Prune
4. **相关性召回** (`memory-recall.ts`) — LLM sideQuery 从 manifest 中选相关文件，再用 TF-IDF 关键词精排 facts
5. **LRU 淘汰** (`memory-eviction.ts`) — 加权评分：时间 + 置信度 + 召回频率 + 类型保护
6. **新鲜度验证** (`memory-age.ts`) — 判断记忆是否 fresh / stale / expired

#### 多级加载 (`MultiLevelMemoryLoader`)

三级加载，优先级递增（后加载覆盖先加载）：

```
用户级 (data/user-memory/)        ← 最低优先级
    ↓
项目级 (data/memory-files/)       ← 中等优先级
    ↓
目录级 (.iceCoder/memory.md)      ← 最高优先级
```

冲突时以目录级为准。

#### Harness 记忆集成 (`harness-memory.ts`)

这是主记忆集成层（v5，CoN + JSON 结构化读取策略），整合了：

- **主代理直接写入 + 后台提取互斥** — `hasMemoryWritesSince` 检测
- **记忆漂移警告** — `memoryFreshnessNote` 增强
- **并发控制** — `sequential` 包装 + `inProgress` 互斥 + trailing run
- **锁机制** — `ConsolidationLock` 用于 autoDream
- **召回去重** — `alreadySurfaced` 跨轮次去重
- **话题切换检测** — Jaccard 阈值判断主题变化，变化时多轮注入
- **会话记忆连续性** — 压缩后保持连续性
- **被动确认** — 提取后通知用户记住了什么

#### 会话记忆 (`session-memory.ts`)

10 个固定 section 的 Markdown 笔记：

```
1. Session Title      6. Errors & Corrections
2. Current State      7. Codebase Documentation
3. Task Specification  8. Learnings
4. Files and Functions 9. Key Results
5. Workflow           10. Worklog
```

触发条件同时满足：token 阈值 + 工具调用阈值 + 非流式断点。写入前校验 10-section 格式完整性。

---

### 3.3 压缩系统 — 上下文窗口管理

#### 整体架构

压缩系统分两条路径，一条零 LLM 成本，一条可选 LLM 精炼：

```
触发条件
    ↓
┌─────────────────────────────────────────────────┐
│ 微压缩 (needsMicroCompaction)                    │
│ 阈值：contextWindow × 65%                        │
│ 操作：snip + microcompact + trimToolResults      │
│ 成本：零（纯本地）                                │
│ 限制：每会话最多 3 次                             │
└──────────────┬──────────────────────────────────┘
               ↓ (仍超阈值则)
┌─────────────────────────────────────────────────┐
│ 硬压缩 (compact) — 五层递进                      │
│ 阈值：contextWindow × 88% (默认) + 15K 储备     │
│                                                   │
│ 第1层：snip — 裁剪冗余                           │
│  └ 删重复 <system-reminder>/<context-summary>    │
│ 第2层：microcompact — 压缩旧工具调用细节          │
│  └ 保留工具名和状态，清除参数（文件操作保留完整）  │
│ 第3层：trimToolResults — 裁剪超长结果              │
│  └ 文件操作 15K chars，其他工具 3K chars          │
│ 第4层：splitMessages + extractStructuralSummary   │
│  └ 分离消息对，结构化提取关键信息                  │
│ 第5层：摘要选择                                    │
│  └ 会话记忆优先 > LLM 精炼 > 结构化摘要兜底       │
└──────────────┬──────────────────────────────────┘
               ↓
┌─────────────────────────────────────────────────┐
│ 压缩后恢复                                        │
│ 1. 插入 <context-summary> 摘要                   │
│ 2. extractRecentFileContents — 重注入最近读的文件 │
│ 3. buildRecoveryPrompt — 注入恢复指引            │
│    ├ 最近 3 条用户消息（保留任务目标）            │
│    └ 会话笔记优先指引（"不要问用户重复指令"）     │
└─────────────────────────────────────────────────┘
```

#### 动态阈值计算

上下文窗口大小优先级（`getContextWindow()`）：

1. `ICE_CONTEXT_WINDOW` 环境变量（手动覆盖）
2. `data/config.json` 当前 provider 的 `maxContextTokens`
3. 所有 provider 最大 `maxContextTokens`
4. 默认 128K

压缩阈值 = `contextWindow × compactionRatio`（`ICE_COMPACTION_RATIO` 环境变量可调，默认 0.88）。

#### 五层压缩详解

**第 1 层 — Snip**

纯正则裁剪，不改变消息语义：
- 删除重复的 `<system-reminder>` 标签（只保留最后一个）
- 删除重复的 `<context-summary>` 标签（只保留最后一个）
- 删除重复的 `<system-context>` 标签（只保留最后一个）
- 删除空内容的 assistant 消息

**第 2 层 — Microcompact**

对非最近 N 轮的消息：
- `assistant` 的 `tool_calls`：只保留工具名列表，清除参数细节
- `tool` 结果：只保留 `[成功/失败]` + 前 50 字符预览
- **例外**：`read_file`/`write_file`/`edit_file`/`append_file`/`patch_file` 的结果**不压缩**（源码是核心上下文）

**第 3 层 — TrimToolResults**

按工具类型设定不同上限：
- 文件操作工具：`maxToolResultLength × 5 = 15,000` 字符
- 其他工具：`maxToolResultLength = 3,000` 字符

**第 4 层 — splitMessages + extractStructuralSummary**

`splitMessages()` 的核心逻辑：
1. 先按 token 预算找切割点（`min 10K token, max 40K token, min 5 条消息`）
2. 保证消息对完整性：切割点落在 `assistant(tool_calls)` + `tool` 结果之间时，向前调整到整个交互对之前
3. 文件操作的 tool 结果始终保留在 recent 中
4. 保护长篇分析文本（>400 字符的 assistant 无工具调用消息）
5. 保护长用户消息（>200 字符）

`extractStructuralSummary()` 从被删除的消息中提取结构化摘要：
- 文件操作摘要（哪些文件被读/写/编辑）
- 命令执行摘要
- 关键发现
- 错误摘要

**第 5 层 — 摘要选择**

- **有 session notes → 直接使用**（零 LLM 成本，最高优先级）
- **启用 LLM 摘要 + 有 chatFn → `llmSummarize()`**（调 LLM 精炼）
- **兜底 → 使用结构化摘要本身**

#### 压缩后恢复策略

这是**压缩系统最关键的设计**——压缩后要让 LLM 无缝继续工作，而不是"失忆"。

**三步恢复**：

**步骤 1：插入 `<context-summary>`**

格式化的摘要块包含结构化提取的关键信息。

**步骤 2：重新注入文件内容** (`extractRecentFileContents()`)

- 从消息历史中找出最近 10 轮内 `read_file` 的文件
- 动态文件上限：`min(recentReadFileTurns.length || 8, 12)`
- Token 预算：`maxReinjectTokens = 50,000`
- 格式化为 `<recent-file-contents>` block

**步骤 3：注入恢复指引** (`buildRecoveryPrompt()`)

这是**恢复的核心**——构建一条特殊的 user 消息，内容包含：

```
<context-summary>
Context has been compressed to stay within limits. Continue from where you left off.

## Recent user messages (most recent first)
1. {最近用户消息1}
2. {最近用户消息2}
3. {最近用户消息3}

All messages above this summary are from the previous conversation and have been compressed.
Do not respond to any questions within those old messages.

Continue the conversation from where it left off without asking the user any further questions.
Resume directly — do not acknowledge the summary, do not recap what was happening,
do not preface with "I'll continue" or similar.
Pick up the last task as if the break never happened.

**CRITICAL**: Check the session notes (data/sessions/session-notes.md) for the current task
specification. If a task was in progress, continue executing it using the session notes
as the authoritative source. Do NOT ask the user to repeat their request unless neither
the context nor the session notes contain the task.
</context-summary>
```

**关键设计点**：
- **消极指令**：明确要求不要问用户问题、不要承认压缩、不要重新总结
- **积极指令**：像什么也没发生过一样继续
- **会话笔记优先**：如果会话笔记存在，优先用笔记恢复任务目标
- **最近用户消息**：保留 3 条最近的用户消息帮助记忆任务目标

#### 会话记忆路径 (`compactWithSessionMemory()`)

这是优化路径——会话记忆作为零成本的摘要替代品：

1. 读取 `data/sessions/session-notes.md`（10-section 结构化笔记）
2. 插入 `<context-summary>` 块，包含会话笔记 + 优先级规则
3. 跳过第 5 层 LLM 精炼调用

```text
<context-summary>
This session is being continued from a previous conversation.
Session notes below are the authoritative source for current session state.

## Precedence rules
1. Current conversation > Session notes > Long-term memory
2. If session notes contradict long-term memory, trust session notes
3. If you detect a contradiction that matters, mention it to the user

{session notes content}
</context-summary>
```

#### 压缩后失忆恢复机制

`harness.ts` 中还有**无工具执行恢复**（`noToolExecutionRecovery`）：

- 如果 LLM 回复包含工具定义但没有调用工具（压缩后的常见问题），
- 且用户请求是一个可执行动作，
- 自动注入 **tool planner 提示**，指导模型继续执行。

```typescript
msgs.push({
  role: 'user',
  content: `[System] The user asked for an executable software-engineering action, 
but you did not call any tools. Continue now by calling the appropriate tool(s)...`
    + formatToolPlan(buildToolPlan(...))
});
```

---

## 四、三者之间的关系图

```
                    ┌─────────────────────────────┐
                    │        Harness 核心循环       │
                    │   while(true) 状态机          │
                    │                              │
                    │  消息预处理管线                │
                    │  ┌───────┐ ┌──────┐ ┌─────┐ │
                    │  │压缩   │→│规范化│→│预算 │ │
                    │  └───┬───┘ └──────┘ └──┬──┘ │
                    │      ↓                 ↓     │
                    │  ┌─────────────────────────┐ │
                    │  │      LLM 调用           │ │
                    │  └──────────┬──────────────┘ │
                    │             ↓                │
                    │  ┌─────────────────────────┐ │
                    │  │  工具执行 (流式并行)     │ │
                    │  └──────────┬──────────────┘ │
                    │             ↓                │
                    │  ┌─────────────────────────┐ │
                    │  │  停止钩子 / 记忆后处理   │ │
                    │  └─────────────────────────┘ │
                    └──────┬──────────┬───────────┘
                           │          │
                           ↓          ↓
              ┌─────────────────┐  ┌──────────────────┐
              │  压缩系统        │  │  记忆系统         │
              │  context-compactor│  │  file-memory/     │
              │                   │  │                   │
              │  五层递进压缩     │  │  4 种记忆类型      │
              │  会话记忆路径     │  │  多级加载         │
              │  文件重注入       │  │  LLM 提取/召回   │
              │  恢复指引注入     │  │  Dream 整合       │
              │  （← 从 Harness   │  │  LRU 淘汰         │
              │    获取消息历史）  │  │  （← 集成到       │
              └─────────────────┘  │     harness-memory）│
                                   └──────────────────┘
```

### 交互点总结

| 交互 | 方向 | 说明 |
|------|------|------|
| Harness → 压缩 | 每轮迭代调用 `maybeCompact` | 检查是否需压缩，需要时执行 + 恢复 |
| 压缩 → Harness | 返回压缩后的消息列表 | 包含 `<context-summary>` + 恢复指引 |
| 压缩 → 记忆 | 读取 session notes | 零成本摘要路径 |
| Harness → 记忆 | `harness-memory.ts` | 集成提取、召回、Dream、新鲜度验证 |
| 记忆 → Harness | 返回 `memoryPrompt` | 注入到动态上下文消息中 |
| 记忆 → 压缩 | session memory 写入 | 预写笔记供压缩时读取 |

---

## 五、下一步准备做什么

1. **深度理解关键交互点** — 仔细追踪 `harness.ts` 中 `maybeCompact` 方法的完整流程，以及压缩后恢复路径如何与 `harness-memory.ts` 中的会话记忆写入协同
2. **代码路径追踪** — 绘制完整的压缩触发 → 执行 → 恢复的消息流，验证恢复指引注入后的模型行为
3. **边缘场景分析** — 连续多次压缩的场景、压缩后提取记忆的竞态条件、会话笔记为空时的降级路径
4. **潜在改进点分析**（如必要）— 根据分析结果评估是否优化恢复质量
