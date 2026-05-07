# iceCoder

AI 编码助手，支持工具调用、多级记忆系统和多端部署（PC / Mobile）。

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（API + Web + 隧道）
npm run dev

# 仅 API
npm run dev:api

# 仅前端
npm run dev:web

# 构建
npm run build

# 测试
npm test
```

### 命令行

```bash
# 启动完整服务（API + Web）
npx iceCoder start

# 纯 CLI 模式
npx iceCoder cli

# Web 模式
npx iceCoder web

# 单次运行
npx iceCoder run "你的问题"

# MCP 模式
npx iceCoder mcp

# 配置管理
npx iceCoder config
```

## 项目结构

```
src/
├── agents/          # 子代理（需求分析、设计、编码、测试、任务生成、验证）
├── cli/             # CLI 入口、参数解析、终端 UI
├── core/            # 核心编排器（Orchestrator）、流水线状态、报告生成
├── harness/         # 运行时框架（harness、context-compactor、记忆集成）
├── llm/             # LLM 适配器（Anthropic、OpenAI）、token 估算
├── mcp/             # MCP 协议支持（客户端、管理器）
├── memory/          # 记忆系统（见下方详细文档）
├── parser/          # 文件解析器（HTML、XMind、Office）
├── prompts/         # 提示词组装
├── tools/           # 工具系统（注册、执行、校验）
│   └── builtin/     # 内置工具（shell、文件操作、搜索、git 等 20+ 工具）
├── types/           # 共享类型
└── web/             # Web 服务（Express + SSE）
```

---

## 记忆系统

iceCoder 内置完整的记忆系统，让 AI 助手能在多轮对话和跨会话中保持上下文连续性。

### 架构概览

记忆系统分为两大层次：

```
┌─────────────────────────────────────────────────────────┐
│                    Harness 集成层                         │
│  harness-memory.ts — 协调提取、召回、注入、反馈检测       │
└──────────┬──────────────────────────────────┬────────────┘
           │                                  │
    ┌──────▼──────┐                    ┌──────▼──────┐
    │  长期记忆    │                    │  会话记忆    │
    │  (文件持久化) │                    │  (session级)  │
    └──────┬──────┘                    └──────┬──────┘
           │                                  │
  ┌────────┼────────┐                ┌────────┼────────┐
  │        │        │                │        │        │
提取    召回    Dream整合          创建    更新    压缩注入
```

### 四种记忆类型

| 类型 | 用途 | 示例 |
|------|------|------|
| `user` | 用户画像（角色、目标、偏好） | "用户是数据科学家，偏好 Python" |
| `feedback` | 行为反馈（纠正或确认的工作方式） | "用户要求不要加 JSDoc 注释" |
| `project` | 项目上下文（进行中的工作、截止日期） | "正在做 v2.0 迁移，截止 3 月底" |
| `reference` | 外部引用（外部系统的指针） | "Pipeline bug 跟踪在 Linear INGEST 项目" |

### 记忆文件格式

每条记忆是一个独立的 Markdown 文件，带 YAML frontmatter：

```markdown
---
name: user-typescript-preference
description: 用户偏好 TypeScript + Vitest
type: user
confidence: 0.9
source: llm_extract
tags: ["lang:typescript", "tool:vitest"]
createdAt: "2026-05-07T10:00:00Z"
eventDate: "2026-05-07"
---

用户明确表示偏好 TypeScript 作为主要开发语言，测试框架选择 Vitest。
```

### 长期记忆生命周期

```
对话 → 提取 → 存储 → 召回 → 注入 → Dream整合 → 淘汰
```

#### 1. 提取（Extraction）

LLM 从对话中自动提取值得记住的信息。

- **触发条件**：对话轮次 >= `minTurns`（默认 3）且 token 数 >= `minTokens`（默认 5000）
- **信号词加速**：用户消息包含"记住"、"偏好"、"不要"、"总是"等关键词时提前触发
- **内容启发式**：检测编程语言、框架、工具链、工作流偏好的正则模式
- **去重**：基于 tags 的 Jaccard 相似度（阈值 0.6）避免重复记忆
- **矛盾检测**：新信息与旧记忆冲突时标记 `contradicts` 字段，旧记忆不被覆盖
- **密钥扫描**：自动检测并脱敏 API key、密码等敏感信息

提取结果写入 `data/memory-files/` 目录，同时更新 `MEMORY.md` 索引。

#### 2. 召回（Recall）

给定用户查询，从记忆库中找到最相关的内容注入上下文。

召回流程分三层：

**第一层：粗召回** — TF-IDF 加权关键词匹配
- 对用户消息分词，计算逆文档频率权重
- description/filename token 权重 ×2（比 contentPreview 更重要）
- 候选数 = `maxResults * 6`（粗筛）

**第二层：相关性门控** — 两层过滤
- 关键词重叠过滤：候选记忆的关键词与查询重叠数 >= `minKeywordOverlap`
- LLM Rescue：关键词过滤后候选不足时，用 LLM 从被过滤掉的记忆中抢救
  - Rescue 结果 LRU 缓存（默认 20 条），避免重复 LLM 调用
  - 短预览匹配：总 preview < 500 字符时用 Jaccard 匹配替代 LLM 调用

**第三层：精排** — Fact 级精排 + 多维评分
- Fact 级索引：从 `.md` 文件中规则提取独立事实（零 LLM 成本）
- TF-IDF 加权关键词匹配 fact 文本
- 评分维度：置信度加分、召回频率加分、时间衰减、实体匹配、内容匹配
- 置信度过滤：低于 0.3 的记忆不参与召回

**预算感知注入**：
- 注入预算 = `min(contextWindow * budgetTokenRatio, maxMemoryBudget)`
- 默认：`budgetTokenRatio = 0.05`，`maxMemoryBudget = 3000` token
- 按 `confidence * recencyScore` 排序，累计 token 直到预算耗尽
- 至少注入 `minBudgetResults`（默认 3）条记忆

**话题切换检测**：
- 计算相邻用户消息的 Jaccard 系数（< 0.2 = 话题切换）
- 切换时调整类型权重：`convention ×1.5`，`preference ×0.7`（常规偏好在话题切换时更重要）

**注入格式**（CoN + JSON，基于 LongMemEval ICLR 2025）：

```
<system-reminder>
以下是与当前对话相关的记忆。请先提取关键信息，再基于这些信息推理。

[相关记忆 - user, 置信度 0.9]
{"fact": "用户偏好 TypeScript + Vitest", "source": "user-typescript-preference.md", "confidence": 0.9}

[相关记忆 - feedback, 置信度 0.7]
{"fact": "用户要求不要加 JSDoc 注释", "source": "feedback-no-jsdoc.md", "confidence": 0.7}
</system-reminder>
```

**会话内去重**：同一记忆在同一会话中不会重复注入（`dedupInSession: true`）。

#### 3. Dream 整合（Consolidation）

定期运行的"做梦"过程，类似人类睡眠时的记忆整合。

**触发条件**（满足任一）：
- 会话数达到阈值（默认每 3 次会话）
- 新增记忆文件数超过阈值（默认 10 个）
- 过期记忆数超过阈值（默认 3 个）

**整合流程**：
1. **Orient** — 扫描现有记忆，了解全局
2. **Gather** — 收集新信号（新增文件、过期文件）
3. **Consolidate** — 合并更新（去重、修正过时信息）
4. **Prune** — 修剪索引（保持 MEMORY.md 在上限内）

**安全机制**：
- ConsolidationLock：基于文件的锁，带 PID 写入和死锁检测
- 自动备份：整合前备份到 `data/memory/dream-backups/`
- mtime 回滚：整合失败时恢复文件修改时间

#### 4. 淘汰（Eviction）

记忆文件数超过软限制时自动淘汰低价值记忆。

**评分公式**：
```
score = ageScore + confidenceScore + recallScore + typeBonus
```

- `ageScore`：基于文件年龄（上限 365 天）
- `confidenceScore`：`(1 - confidence) * 30`
- `recallScore`：基于召回频率（上限 20 次）
- `typeBonus`：user 类型 +15 分

**保护机制**：
- 高置信度记忆（= 1.0）不被淘汰
- 最近 3 天内创建的记忆受保护
- 淘汰文件移到 `data/memory/evicted/`，可恢复

#### 5. 记忆衰减

记忆随时间衰减，模拟人类遗忘曲线：

| 阈值 | 衰减因子 | 说明 |
|------|----------|------|
| < 90 天 | 1.0 | 新鲜 |
| 90-180 天 | 0.5 | 陈旧 |
| > 180 天 | 0.1 | 过期 |

高置信度记忆（>= 0.8）衰减速度减半。

### 会话记忆

独立于长期记忆的会话级笔记系统，在上下文压缩后保持会话连续性。

#### 10 个固定 Section

| # | Section | 用途 |
|---|---------|------|
| 1 | Session Title | 简短描述性标题 |
| 2 | Current State | 当前工作状态、待办任务 |
| 3 | Task Specification | 用户要求构建什么 |
| 4 | Files and Functions | 重要文件及其作用 |
| 5 | Workflow | 常用命令和顺序 |
| 6 | Errors & Corrections | 错误和修正记录 |
| 7 | Codebase Documentation | 系统组件说明 |
| 8 | Learnings | 经验教训 |
| 9 | Key Results | 关键输出 |
| 10 | Worklog | 逐步工作日志 |

#### 更新触发条件

同时满足以下条件时由后台子代理更新：
- token 增长超过 `minTokensBetweenUpdate`（默认 5000）
- 工具调用数 >= `toolCallsBetweenUpdates`（默认 3）
- 或：上一轮没有工具调用（自然对话断点）

#### 响应验证

LLM 生成的会话笔记在写入前验证：
- 内容不能为空或过短（< 50 字符）
- 必须包含至少 2/3 个核心 section（Session Title, Current State, Worklog）
- 至少包含 7/10 个 section 标题

验证失败时不写入，避免损坏会话记忆。

### 上下文压缩

当对话 token 数超过阈值（默认 60000）时触发压缩。

#### 两条压缩路径

**路径 A：会话记忆路径（零 LLM 成本）**

会话记忆已在后台持续更新，直接作为压缩摘要：

```
session-notes.md → 读取 → 空检查 → section 截断 → <context-summary> 包装
```

截断规则：单个 section 超过 8000 字符时截断，附加 `[... section 因长度截断 ...]` 标记。

注入格式：
```
<context-summary>
This session is being continued from a previous conversation.
Session notes below are the authoritative source for current session state.

## Precedence rules
1. Current conversation > Session notes > Long-term memory
2. If session notes contradict long-term memory, trust session notes
3. If you detect a contradiction that matters, mention it to the user

[会话记忆内容]
</context-summary>
```

**路径 B：五层递进压缩（含 LLM 精炼）**

无会话记忆时的回退路径：

| 层 | 名称 | 说明 |
|----|------|------|
| 1 | Snip | 删除重复的 system-reminder / context-summary，只保留最后一个 |
| 2 | Microcompact | 压缩旧工具调用细节（文件操作结果保留完整） |
| 3 | ToolResultTrim | 裁剪超长工具结果（文件操作上限 15K，其他 3K） |
| 4 | StructuralExtract | 从被删消息提取结构化摘要（不调 LLM） |
| 5 | LLMSummarize | 用 LLM 精炼摘要（可选） |

#### 压后恢复

- **文件内容重新注入**：最近读取的文件内容（最多 5 个，50K token 预算）重新注入
- **恢复指引**：注入 "Continue directly, don't recap" 指令
- **记忆消息恢复**：被压缩掉的 Recalled Memories 重新注入

### 用户反馈检测

检测用户对注入记忆的即时反馈，动态调整置信度。

**检测方式**：消息 < 50 字符时检查关键词
- 否定词：`不对`、`不是`、`错了`、`wrong`、`incorrect` 等 → 置信度减半（最低 0.1）
- 肯定词：`对`、`是的`、`很好`、`correct`、`right` 等 → 置信度 ×1.2（最高 1.0）

调整写入记忆文件的 frontmatter（`confidence` 字段），使用 `sequential()` 包装确保文件写入互斥。

### 并发控制

- **sequential()**：函数级互斥包装器，确保同一时刻只有一个执行
- **ConsolidationLock**：基于文件的锁，用于 Dream 整合
  - PID 写入检测进程存活
  - 死锁检测（holder 超过阈值自动释放）
  - mtime 回滚（整合失败时恢复）
- **ExtractionGuard**：每会话独立的提取状态，防止并发提取

### 安全机制

- **路径遍历防护**：`validatePath()` 阻止 `../` 逃逸记忆目录
- **符号链接解析**：`validatePathWithSymlink()` 解析符号链接后二次校验
- **密钥扫描**：`scanForSecrets()` 检测 API key、密码、token 等敏感信息
- **自动脱敏**：`redactSecrets()` 将敏感信息替换为 `[REDACTED]`

### 配置系统

三层配置，优先级从高到低：

1. **远程动态配置** — `data/memory/memory-config.json`，热加载（5 分钟缓存刷新）
2. **静态默认值** — `memory-config.ts` 中的常量
3. **硬编码常量** — 各模块内部的 `const`

可配置项：

| 分类 | 参数 | 默认值 |
|------|------|--------|
| extraction | minTurns | 3 |
| extraction | minTokens | 5000 |
| extraction | toolCallInterval | 3 |
| extraction | turnThrottle | 1 |
| dream | minHours | 6 |
| dream | minSessions | 3 |
| dream | enabled | true |
| recall | maxResults | 15 |
| recall | dedupInSession | true |
| recall | budgetTokenRatio | 0.05 |
| recall | maxMemoryBudget | 3000 |
| recall | minBudgetResults | 3 |
| relevanceGate | enabled | true |
| relevanceGate | rescueCacheSize | 20 |
| sessionMemory | enabled | true |
| sessionMemory | minTokensToInit | 10000 |
| sessionMemory | minTokensBetweenUpdate | 5000 |
| feedback | enabled | true |
| feedback | maxTurnsToFeedback | 3 |

### 遥测

记忆系统的每次操作（提取、召回、Dream 整合）记录到 `data/memory/telemetry.jsonl`，用于性能分析和调试。

---

## 工具系统

20+ 内置工具，覆盖文件操作、搜索、Git、Shell、文档解析等：

| 类别 | 工具 |
|------|------|
| 文件操作 | read_file, write_file, edit_file, append_file, patch_file, batch_edit, undo_edit |
| 搜索 | grep, glob, search_files |
| Git | git（状态、提交、分支等） |
| Shell | shell（执行系统命令） |
| 文档解析 | doc_extract, doc_parse, xmind_parse, pptx_parse, xlsx_parse |
| 其他 | url_fetch, web_search, image_read, notebook_read, env_info, diff, filesystem_browser |

## 子代理系统

6 个专用子代理，由 Orchestrator 编排：

| 代理 | 职责 |
|------|------|
| requirement-analysis | 需求分析 |
| design | 架构设计 |
| code-writing | 代码编写 |
| testing | 测试编写 |
| task-generation | 任务拆解 |
| requirement-verification | 需求验证 |

## LLM 适配

支持多个 LLM 提供商：

- **Anthropic** — Claude 系列（默认）
- **OpenAI** — GPT 系列

统一的 `LLMAdapterInterface` 抽象层，支持流式输出和 token 估算。

## MCP 协议

内置 MCP（Model Context Protocol）客户端，支持连接外部 MCP 服务器扩展工具能力。

## 数据目录

```
data/
├── memory-files/        # 长期记忆文件（.md）
│   └── MEMORY.md        # 记忆索引
├── memory/
│   ├── memory-config.json    # 远程动态配置
│   ├── dream-state.json      # Dream 整合状态
│   ├── dream-backups/        # Dream 整合前备份
│   ├── evicted/              # 已淘汰的记忆文件
│   └── telemetry.jsonl       # 遥测日志
├── sessions/            # 会话数据
│   └── session-notes.md      # 会话记忆笔记
├── user-memory/         # 用户级记忆目录
└── config.json          # 全局配置
```

## 技术栈

- **Runtime**: Node.js >= 18
- **Language**: TypeScript 6.x
- **Build**: tsc + Vite
- **Test**: Vitest
- **Web**: Express 5.x + SSE
- **LLM SDK**: @anthropic-ai/sdk, openai
- **文件解析**: cheerio, officeparser, word-extractor, xml2js

## License

ISC
